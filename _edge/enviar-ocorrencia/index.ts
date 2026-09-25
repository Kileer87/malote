import { createClient } from "jsr:@supabase/supabase-js@2";
import webpush from "npm:web-push@3.6.7";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
  });
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
    const vapidPublicKey = Deno.env.get("VAPID_PUBLIC_KEY");
    const vapidPrivateKey = Deno.env.get("VAPID_PRIVATE_KEY");
    const vapidSubject = Deno.env.get("VAPID_SUBJECT") || "mailto:contato@example.com";

    if (!vapidPublicKey || !vapidPrivateKey) {
      console.error("VAPID_PUBLIC_KEY/VAPID_PRIVATE_KEY não configurados.");
      return jsonResponse({ error: "Notificações push ainda não configuradas." }, 500);
    }
    webpush.setVapidDetails(vapidSubject, vapidPublicKey, vapidPrivateKey);

    const supabase = createClient(supabaseUrl, supabaseAnonKey, {
      global: { headers: { Authorization: authHeader } },
    });

    const { data: userData, error: userErr } = await supabase.auth.getUser();
    if (userErr || !userData?.user) return jsonResponse({ error: "Sessão inválida." }, 401);

    // Só o dono da conta (síndico ou administrador da empresa) manda ocorrência —
    // mesma checagem por user_id que mp-criar-pagamento já usa.
    const { data: condominio, error: condErr } = await supabase
      .from("condominios")
      .select("id, nome, tipo_operacao, bloqueado")
      .eq("user_id", userData.user.id)
      .maybeSingle();

    if (condErr || !condominio) return jsonResponse({ error: "Condomínio não encontrado para esta conta." }, 404);
    if (condominio.bloqueado) return jsonResponse({ error: "Acesso bloqueado." }, 403);

    let corpo: { mensagem?: string } = {};
    try { corpo = await req.json(); } catch (_e) { /* corpo vazio */ }
    const mensagem = (corpo?.mensagem || "").trim();
    if (!mensagem) return jsonResponse({ error: "Escreva o aviso antes de enviar." }, 400);
    if (mensagem.length > 500) return jsonResponse({ error: "Aviso muito longo (máximo 500 caracteres)." }, 400);

    const supabaseAdmin = createClient(supabaseUrl, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

    const { data: ocorrencia, error: ocErr } = await supabaseAdmin
      .from("ocorrencias")
      .insert({ condominio_id: condominio.id, mensagem, criado_por: userData.user.id })
      .select("id")
      .single();
    if (ocErr || !ocorrencia) {
      console.error("Erro ao criar ocorrência:", ocErr);
      return jsonResponse({ error: "Não consegui registrar o aviso." }, 500);
    }

    const ehEmpresarial = condominio.tipo_operacao === "empresarial";
    const tabelaDestinatarios = ehEmpresarial ? "colaboradores" : "moradores";
    const tabelaAssinaturas = ehEmpresarial ? "push_assinaturas_colaborador" : "push_assinaturas_morador";
    const colunaDono = ehEmpresarial ? "colaborador_id" : "morador_id";
    const urlDestino = ehEmpresarial ? "/parceiros/portal-colaborador.html" : "/parceiros/portal-morador.html";

    const { data: destinatarios, error: destErr } = await supabaseAdmin
      .from(tabelaDestinatarios)
      .select("id")
      .eq("condominio_id", condominio.id);
    if (destErr) {
      console.error("Erro ao buscar destinatários:", destErr);
      return jsonResponse({ error: "Não consegui buscar quem deveria receber o aviso." }, 500);
    }

    const idsDestinatarios = (destinatarios || []).map((d: { id: string }) => d.id);
    let assinaturasPorDono: Record<string, { id: string; endpoint: string; p256dh: string; auth: string }[]> = {};
    if (idsDestinatarios.length) {
      const { data: assinaturas } = await supabaseAdmin
        .from(tabelaAssinaturas)
        .select("id, endpoint, p256dh, auth, " + colunaDono)
        .in(colunaDono, idsDestinatarios);
      for (const a of assinaturas || []) {
        const dono = (a as any)[colunaDono] as string;
        if (!assinaturasPorDono[dono]) assinaturasPorDono[dono] = [];
        assinaturasPorDono[dono].push(a as any);
      }
    }

    const payload = JSON.stringify({
      title: ehEmpresarial ? "Aviso da administração 📣" : "Aviso do síndico 📣",
      body: mensagem,
      url: urlDestino,
    });

    const envios: { ocorrencia_id: string; condominio_id: string; morador_id?: string; colaborador_id?: string; enviado_em: string | null }[] = [];
    let enviados = 0;

    for (const id of idsDestinatarios) {
      const subs = assinaturasPorDono[id] || [];
      let entregouPraAlgumDispositivo = false;

      for (const sub of subs) {
        try {
          await webpush.sendNotification(
            { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
            payload,
          );
          entregouPraAlgumDispositivo = true;
        } catch (err: any) {
          const statusCode = err?.statusCode;
          if (statusCode === 404 || statusCode === 410) {
            await supabaseAdmin.from(tabelaAssinaturas).delete().eq("id", sub.id);
          } else {
            console.error("Erro ao enviar push de ocorrência:", statusCode, err?.body || err);
          }
        }
      }

      if (entregouPraAlgumDispositivo) enviados++;
      envios.push({
        ocorrencia_id: ocorrencia.id,
        condominio_id: condominio.id,
        [colunaDono]: id,
        enviado_em: entregouPraAlgumDispositivo ? new Date().toISOString() : null,
      } as any);

      // Pausa curtinha entre moradores/colaboradores — só por educação com o
      // serviço de push, não porque exista risco de "número bloqueado" (isso
      // é coisa de WhatsApp automatizado, não de web push).
      if (subs.length) await sleep(80);
    }

    if (envios.length) {
      const { error: enviosErr } = await supabaseAdmin.from("ocorrencias_envios").insert(envios);
      if (enviosErr) console.error("Erro ao gravar histórico de envios:", enviosErr);
    }

    await supabaseAdmin
      .from("ocorrencias")
      .update({ destinatarios_total: idsDestinatarios.length, enviados_total: enviados })
      .eq("id", ocorrencia.id);

    return jsonResponse({ ok: true, destinatarios: idsDestinatarios.length, enviados });
  } catch (e) {
    console.error("Erro inesperado em enviar-ocorrencia:", e);
    return jsonResponse({ error: "Erro inesperado." }, 500);
  }
});
