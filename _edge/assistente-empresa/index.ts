import { createClient } from "jsr:@supabase/supabase-js@2";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const TIPOS_VALIDOS = [
  "contagem_periodo",
  "pendentes_contagem",
  "pendentes_lista",
  "tempo_medio_retirada",
  "pico_horario",
  "status_condominio",
  "relatorio_dia",
] as const;
type Tipo = (typeof TIPOS_VALIDOS)[number];

const MENSAGEM_NAO_ENTENDI =
  "Não entendi bem essa pergunta. Tenta perguntar de um jeito parecido com: " +
  "\"quantas encomendas chegaram essa semana\", \"quantas estão esperando retirada\", " +
  "\"quem ainda não retirou\", \"qual o horário de pico\", \"está tudo em dia com o pagamento\" " +
  "ou \"me dá um relatório de hoje\".";

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
  });
}

function periodoTexto(dias: number): string {
  if (dias <= 1) return "hoje";
  if (dias === 7) return "nos últimos 7 dias";
  return "nos últimos " + dias + " dias";
}

function formatarHoras(horas: number): string {
  if (horas < 1) return Math.round(horas * 60) + " minutos";
  if (horas < 24) return horas.toFixed(1).replace(".0", "") + " horas";
  var dias = Math.floor(horas / 24);
  var resto = Math.round(horas % 24);
  return dias + (dias === 1 ? " dia" : " dias") + (resto ? " e " + resto + "h" : "");
}

// Pra encomenda empresarial, bloco/apto guardam o nome da unidade/setor
// (gravados no momento do recebimento pelo leitor de etiqueta) — mesma
// convenção já usada em empresa/painel.html (carregarDashboardEmpresa()).
function localTexto(bloco: string | null, apto: string | null): string {
  if (!bloco) return "";
  return bloco + (apto ? " / " + apto : "");
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: CORS_HEADERS });
  }

  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) return jsonResponse({ error: "Não autenticado." }, 401);

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseAnonKey = Deno.env.get("SUPABASE_ANON_KEY")!;
    const anthropicApiKey = Deno.env.get("ANTHROPIC_API_KEY");
    const anthropicModel = Deno.env.get("ANTHROPIC_MODEL") || "claude-haiku-4-5-20251001";

    if (!anthropicApiKey) {
      console.error("ANTHROPIC_API_KEY não configurada.");
      return jsonResponse({ error: "Assistente ainda não configurado." }, 500);
    }

    // client autenticado como a própria empresa — usado pra confirmar a conta
    // e pra chamar RPCs SECURITY DEFINER que dependem de auth.uid() (como
    // cliente_pico_horario, que o dashboard já usa do mesmo jeito — essa RPC
    // já é genérica, não depende de moradores nem colaboradores).
    const supabase = createClient(supabaseUrl, supabaseAnonKey, {
      global: { headers: { Authorization: authHeader } },
    });

    const { data: userData, error: userErr } = await supabase.auth.getUser();
    if (userErr || !userData?.user) return jsonResponse({ error: "Sessão inválida." }, 401);

    const { data: condominio, error: condErr } = await supabase
      .from("condominios")
      .select("id, bloqueado, bloqueado_motivo, em_teste, proximo_vencimento")
      .eq("user_id", userData.user.id)
      .maybeSingle();

    if (condErr || !condominio) return jsonResponse({ error: "Empresa não encontrada para esta conta." }, 404);
    if (condominio.bloqueado) return jsonResponse({ error: "Acesso bloqueado." }, 403);

    let corpo: { pergunta?: string } = {};
    try { corpo = await req.json(); } catch (_e) { /* corpo vazio */ }
    const pergunta = (corpo?.pergunta || "").trim();
    if (!pergunta) return jsonResponse({ error: "Escreva uma pergunta antes de enviar." }, 400);
    if (pergunta.length > 300) return jsonResponse({ error: "Pergunta muito longa (máximo 300 caracteres)." }, 400);

    // client de serviço — só roda as consultas fixas de cada "tipo" abaixo,
    // sempre filtradas manualmente por condominio.id (o service role não
    // passa pelas policies de RLS, então o filtro aqui É a proteção).
    const supabaseAdmin = createClient(supabaseUrl, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

    // --- Passo 1: a IA só CLASSIFICA a pergunta num tipo fixo + parâmetros
    // simples. Ela nunca vê o banco, nunca gera SQL, e a resposta dela nunca
    // é repassada pro responsável da empresa — só o "tipo" escolhido é usado
    // a seguir. ---
    const hojeStr = new Date().toISOString().slice(0, 10);
    const anthropicResp = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": anthropicApiKey,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: anthropicModel,
        max_tokens: 200,
        system:
          "Você ajuda a classificar a pergunta do responsável por uma empresa (recebimento de encomendas de " +
          "colaboradores) num tipo fixo de consulta. Hoje é " + hojeStr + ". Tipos disponíveis: " +
          "contagem_periodo (quantas encomendas chegaram num período — extraia 'dias': hoje=1, esta semana=7, este mês=30); " +
          "pendentes_contagem (quantas encomendas estão esperando retirada agora, sem período); " +
          "pendentes_lista (quais colaboradores ainda não retiraram — 'dias' opcional se a pergunta mencionar um período de chegada); " +
          "tempo_medio_retirada (tempo médio até a retirada — extraia 'dias', padrão 30); " +
          "pico_horario (horário do dia com mais chegadas de encomenda); " +
          "status_condominio (se o pagamento/vencimento da assinatura está em dia); " +
          "relatorio_dia (um relatório/resumo escrito completo do dia de hoje, juntando chegadas, retiradas, " +
          "pendências e horário de pico — usa esse tipo quando pedirem 'relatório', 'resumo do dia' " +
          "ou 'como foram as entregas hoje', sem parâmetro 'dias'). " +
          "Sempre chame a ferramenta responder_pergunta com o tipo mais adequado, mesmo que a pergunta seja parecida " +
          "mas não idêntica aos exemplos. Nunca responda em texto livre.",
        tools: [
          {
            name: "responder_pergunta",
            description: "Classifica a pergunta em um tipo fixo de consulta conhecida.",
            input_schema: {
              type: "object",
              properties: {
                tipo: { type: "string", enum: TIPOS_VALIDOS as unknown as string[] },
                dias: { type: "integer", description: "Período em dias mencionado na pergunta, se houver." },
              },
              required: ["tipo"],
            },
          },
        ],
        tool_choice: { type: "tool", name: "responder_pergunta" },
        messages: [{ role: "user", content: pergunta }],
      }),
    });

    if (!anthropicResp.ok) {
      console.error("Erro na API da Anthropic:", anthropicResp.status, await anthropicResp.text().catch(() => ""));
      return jsonResponse({ ok: true, resposta: MENSAGEM_NAO_ENTENDI });
    }

    const anthropicData = await anthropicResp.json();
    const toolUse = (anthropicData?.content || []).find((b: any) => b.type === "tool_use" && b.name === "responder_pergunta");
    const tipo: Tipo | undefined = toolUse?.input?.tipo;
    const diasParam: number | undefined = toolUse?.input?.dias;

    if (!tipo || !TIPOS_VALIDOS.includes(tipo)) {
      return jsonResponse({ ok: true, resposta: MENSAGEM_NAO_ENTENDI });
    }

    // --- Passo 2: roda a consulta FIXA correspondente ao tipo escolhido,
    // sempre escopada manualmente por condominio.id. Nenhum SQL vem da IA. ---
    let resposta = "";

    if (tipo === "contagem_periodo") {
      const dias = Number.isFinite(diasParam) && diasParam! > 0 ? Math.min(diasParam!, 365) : 7;
      const cutoffIso = new Date(Date.now() - dias * 24 * 60 * 60 * 1000).toISOString();
      const r = await supabaseAdmin
        .from("encomendas")
        .select("id", { count: "exact", head: true })
        .eq("condominio_id", condominio.id)
        .gte("criado_em", cutoffIso);
      const total = r.count || 0;
      resposta = total === 0
        ? "Não chegou nenhuma encomenda " + periodoTexto(dias) + "."
        : "Chegaram " + total + (total === 1 ? " encomenda " : " encomendas ") + periodoTexto(dias) + ".";
    } else if (tipo === "pendentes_contagem") {
      const r = await supabaseAdmin
        .from("encomendas")
        .select("id", { count: "exact", head: true })
        .eq("condominio_id", condominio.id)
        .is("retirado_em", null);
      const total = r.count || 0;
      resposta = total === 0
        ? "Nenhuma encomenda esperando retirada agora — tudo entregue!"
        : "Tem " + total + (total === 1 ? " encomenda esperando retirada agora." : " encomendas esperando retirada agora.");
    } else if (tipo === "pendentes_lista") {
      let q = supabaseAdmin
        .from("encomendas")
        .select("bloco, apto, nome_avulso, criado_em, colaboradores(nome)")
        .eq("condominio_id", condominio.id)
        .is("retirado_em", null)
        .order("criado_em", { ascending: true })
        .limit(30);
      if (Number.isFinite(diasParam) && diasParam! > 0) {
        const cutoffIso = new Date(Date.now() - Math.min(diasParam!, 365) * 24 * 60 * 60 * 1000).toISOString();
        q = q.gte("criado_em", cutoffIso);
      }
      const r = await q;
      const linhas = r.data || [];
      if (!linhas.length) {
        resposta = "Nenhum colaborador está com encomenda pendente" + (diasParam ? " " + periodoTexto(diasParam) : "") + " — tudo retirado!";
      } else {
        const nomes = linhas.slice(0, 10).map((e: any) => {
          const colaborador = e.colaboradores?.nome || e.nome_avulso || "sem nome cadastrado";
          const local = localTexto(e.bloco, e.apto);
          return colaborador + (local ? " (" + local + ")" : "");
        });
        resposta = "Tem " + linhas.length + " esperando retirada: " + nomes.join(", ") +
          (linhas.length > 10 ? " e mais " + (linhas.length - 10) + "." : ".");
      }
    } else if (tipo === "tempo_medio_retirada") {
      const dias = Number.isFinite(diasParam) && diasParam! > 0 ? Math.min(diasParam!, 365) : 30;
      const cutoffIso = new Date(Date.now() - dias * 24 * 60 * 60 * 1000).toISOString();
      const r = await supabaseAdmin
        .from("encomendas")
        .select("criado_em, retirado_em")
        .eq("condominio_id", condominio.id)
        .not("retirado_em", "is", null)
        .gte("retirado_em", cutoffIso);
      const linhas = r.data || [];
      if (!linhas.length) {
        resposta = "Não teve nenhuma retirada " + periodoTexto(dias) + " pra calcular uma média.";
      } else {
        const somaHoras = linhas.reduce((s: number, e: any) => {
          return s + (new Date(e.retirado_em).getTime() - new Date(e.criado_em).getTime()) / 3600000;
        }, 0);
        resposta = "Nos últimos " + dias + " dias, o tempo médio até a retirada foi de " +
          formatarHoras(somaHoras / linhas.length) + " (" + linhas.length + " retiradas consideradas).";
      }
    } else if (tipo === "pico_horario") {
      // SECURITY DEFINER baseado em auth.uid() — precisa do client autenticado
      // como a empresa, não do supabaseAdmin (service role não tem auth.uid()).
      // Genérica: já funciona igual pra condomínio e empresa.
      const r = await supabase.rpc("cliente_pico_horario");
      const dados = (r.data || []) as { hora: number; quantidade: number }[];
      const total = dados.reduce((s, d) => s + Number(d.quantidade), 0);
      if (!total) {
        resposta = "Ainda não tem encomendas suficientes pra calcular um horário de pico.";
      } else {
        const max = Math.max(...dados.map((d) => Number(d.quantidade)));
        const horasPico = dados.filter((d) => Number(d.quantidade) === max).map((d) => d.hora);
        const horasTexto = horasPico.map((h) => String(h).padStart(2, "0") + "h").join(" e ");
        resposta = "O horário com mais chegadas de encomenda é por volta das " + horasTexto + ".";
      }
    } else if (tipo === "status_condominio") {
      if (condominio.bloqueado) {
        resposta = "O acesso está bloqueado" + (condominio.bloqueado_motivo ? ": " + condominio.bloqueado_motivo : ".") +
          " Regularize o pagamento pra liberar de novo.";
      } else if (!condominio.proximo_vencimento) {
        resposta = "Não tem vencimento pendente cadastrado no momento.";
      } else {
        const hoje0h = new Date(); hoje0h.setHours(0, 0, 0, 0);
        const venc0h = new Date(condominio.proximo_vencimento + "T00:00:00");
        const diasParaVencer = Math.round((venc0h.getTime() - hoje0h.getTime()) / 86400000);
        const vencFormatado = venc0h.toLocaleDateString("pt-BR");
        if (condominio.em_teste) {
          resposta = diasParaVencer < 0
            ? "Seu período de teste grátis (até " + vencFormatado + ") já terminou."
            : diasParaVencer === 0
            ? "Seu período de teste grátis termina hoje (" + vencFormatado + ")."
            : "Está tudo em dia. Seu período de teste grátis termina em " + diasParaVencer + " dia(s), no dia " + vencFormatado + ".";
        } else if (diasParaVencer < 0) {
          resposta = "Seu vencimento (" + vencFormatado + ") já passou. Pague o quanto antes pra evitar o bloqueio automático.";
        } else if (diasParaVencer === 0) {
          resposta = "Seu vencimento é hoje (" + vencFormatado + ").";
        } else if (diasParaVencer <= 5) {
          resposta = "Está tudo em dia, mas seu vencimento é em " + diasParaVencer + " dia(s), no dia " + vencFormatado + ".";
        } else {
          resposta = "Está tudo em dia. Seu próximo vencimento é em " + vencFormatado + ".";
        }
      }
    } else if (tipo === "relatorio_dia") {
      // fuso fixo America/Sao_Paulo (sem horário de verão desde 2019) — mesmo
      // fuso já usado em cliente_pico_horario(). "hoje" = 00h à meia-noite
      // seguinte, nesse fuso, convertido pra instantes UTC pras consultas.
      const hojeSP = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Sao_Paulo" }).format(new Date());
      const inicioHoje = new Date(hojeSP + "T00:00:00-03:00");
      const fimHoje = new Date(inicioHoje.getTime() + 24 * 60 * 60 * 1000);
      const inicioHojeIso = inicioHoje.toISOString();
      const fimHojeIso = fimHoje.toISOString();

      const [rChegadas, rRetiradas, rPendentes, rHorasHoje] = await Promise.all([
        supabaseAdmin.from("encomendas").select("id", { count: "exact", head: true })
          .eq("condominio_id", condominio.id).gte("criado_em", inicioHojeIso).lt("criado_em", fimHojeIso),
        supabaseAdmin.from("encomendas").select("id", { count: "exact", head: true })
          .eq("condominio_id", condominio.id).gte("retirado_em", inicioHojeIso).lt("retirado_em", fimHojeIso),
        supabaseAdmin.from("encomendas").select("bloco, apto, nome_avulso, colaboradores(nome)")
          .eq("condominio_id", condominio.id).is("retirado_em", null)
          .order("criado_em", { ascending: true }).limit(30),
        supabaseAdmin.from("encomendas").select("criado_em")
          .eq("condominio_id", condominio.id).gte("criado_em", inicioHojeIso).lt("criado_em", fimHojeIso),
      ]);

      const totalChegadas = rChegadas.count || 0;
      const totalRetiradas = rRetiradas.count || 0;
      const pendentes = rPendentes.data || [];
      const linhasHoje = rHorasHoje.data || [];

      const linhaPendentes = (() => {
        if (!pendentes.length) return "Nenhum colaborador está com encomenda pendente — tudo retirado!";
        const nomes = pendentes.slice(0, 10).map((e: any) => {
          const colaborador = e.colaboradores?.nome || e.nome_avulso || "sem nome cadastrado";
          const local = localTexto(e.bloco, e.apto);
          return colaborador + (local ? " (" + local + ")" : "");
        });
        return "Ainda tem " + pendentes.length + " esperando retirada: " + nomes.join(", ") +
          (pendentes.length > 10 ? " e mais " + (pendentes.length - 10) + "." : ".");
      })();

      let linhaPico = "Ainda não teve chegada hoje pra calcular horário de pico.";
      if (linhasHoje.length) {
        const contagemPorHora: Record<number, number> = {};
        for (const linha of linhasHoje as { criado_em: string }[]) {
          const horaSp = (new Date(linha.criado_em).getUTCHours() - 3 + 24) % 24;
          contagemPorHora[horaSp] = (contagemPorHora[horaSp] || 0) + 1;
        }
        const maxQtd = Math.max(...Object.values(contagemPorHora));
        const horasPico = Object.keys(contagemPorHora)
          .filter((h) => contagemPorHora[Number(h)] === maxQtd)
          .map((h) => h.padStart(2, "0") + "h")
          .join(" e ");
        linhaPico = "Horário com mais chegadas hoje: por volta das " + horasPico + ".";
      }

      const linhas = [
        totalChegadas === 0
          ? "Não chegou nenhuma encomenda hoje."
          : "Chegaram " + totalChegadas + (totalChegadas === 1 ? " encomenda hoje." : " encomendas hoje."),
        totalRetiradas === 0
          ? "Nenhuma retirada registrada hoje ainda."
          : "Foram retiradas " + totalRetiradas + (totalRetiradas === 1 ? " encomenda hoje." : " encomendas hoje."),
        linhaPendentes,
        linhaPico,
      ];
      resposta = "Relatório de hoje:\n- " + linhas.join("\n- ");
    }

    return jsonResponse({ ok: true, resposta });
  } catch (e) {
    console.error("Erro inesperado em assistente-empresa:", e);
    return jsonResponse({ error: "Erro inesperado." }, 500);
  }
});
