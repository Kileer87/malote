import { createClient } from "jsr:@supabase/supabase-js@2";
import webpush from "npm:web-push@3.6.7";

// Chamada apenas pelo pg_cron (via pg_net), uma vez por dia às 18h
// (America/Sao_Paulo) — protegida por um segredo compartilhado no header,
// mesmo padrão já usado em push-lembretes-diarios, já que não existe usuário
// logado aqui.
//
// Objetivo: avisar o síndico, um dia antes, dos eventos que ele mesmo
// cadastrou na agenda (Calendário) do condomínio. É síndico-only — o painel
// da empresa não tem agenda — mas nada aqui depende de tipo_operacao: só
// segue os eventos de eventos_agenda que tiverem inscrição de push (que só
// existe pra quem ativou o lembrete no painel do síndico).
function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

Deno.serve(async (req: Request) => {
  try {
    const cronSecret = Deno.env.get("CRON_SECRET");
    const recebido = req.headers.get("x-cron-secret");
    if (!cronSecret || recebido !== cronSecret) {
      return new Response("não autorizado", { status: 401 });
    }

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const vapidPublicKey = Deno.env.get("VAPID_PUBLIC_KEY");
    const vapidPrivateKey = Deno.env.get("VAPID_PRIVATE_KEY");
    const vapidSubject = Deno.env.get("VAPID_SUBJECT") || "mailto:contato@example.com";
    if (!vapidPublicKey || !vapidPrivateKey) {
      console.error("VAPID não configurado.");
      return jsonResponse({ error: "config ausente" }, 500);
    }
    webpush.setVapidDetails(vapidSubject, vapidPublicKey, vapidPrivateKey);

    const supabaseAdmin = createClient(supabaseUrl, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

    // "Amanhã" no fuso America/Sao_Paulo (fixo, sem horário de verão desde
    // 2019 — mesma convenção já usada em cliente_pico_horario() e no
    // assistente-sindico).
    const hojeSP = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Sao_Paulo" }).format(new Date());
    const amanha = new Date(hojeSP + "T00:00:00-03:00");
    amanha.setUTCDate(amanha.getUTCDate() + 1);
    const amanhaStr = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Sao_Paulo" }).format(amanha);

    const { data: eventos, error: evErr } = await supabaseAdmin
      .from("eventos_agenda")
      .select("id, condominio_id, titulo, hora, tipo")
      .eq("data", amanhaStr)
      .eq("concluido", false);

    if (evErr) {
      console.error("Erro ao buscar eventos de amanhã:", evErr);
      return jsonResponse({ error: "erro ao buscar eventos" }, 500);
    }

    const porCondominio: Record<string, { titulo: string; hora: string | null }[]> = {};
    for (const ev of eventos || []) {
      const lista = porCondominio[ev.condominio_id] || (porCondominio[ev.condominio_id] = []);
      lista.push({ titulo: ev.titulo, hora: ev.hora });
    }

    const condominioIds = Object.keys(porCondominio);
    let totalCondominiosAvisados = 0;
    let totalEnviados = 0;

    for (const condominioId of condominioIds) {
      const { data: assinaturas } = await supabaseAdmin
        .from("push_assinaturas_condominio")
        .select("id, endpoint, p256dh, auth")
        .eq("condominio_id", condominioId);

      if (!assinaturas || !assinaturas.length) continue;

      const eventosDoCondominio = porCondominio[condominioId]
        .sort((a, b) => (a.hora || "99:99").localeCompare(b.hora || "99:99"));

      const linhas = eventosDoCondominio.map((e) =>
        (e.hora ? e.hora.slice(0, 5) + "h — " : "") + e.titulo
      );
      const titulo = eventosDoCondominio.length === 1
        ? "Você tem um compromisso amanhã 🗓️"
        : "Você tem " + eventosDoCondominio.length + " compromissos amanhã 🗓️";
      const payload = JSON.stringify({
        title: titulo,
        body: linhas.join(" · "),
        url: "/sindico/painel.html",
      });

      let avisouEsseCondominio = false;
      for (const assinatura of assinaturas) {
        try {
          await webpush.sendNotification(
            { endpoint: assinatura.endpoint, keys: { p256dh: assinatura.p256dh, auth: assinatura.auth } },
            payload,
          );
          totalEnviados++;
          avisouEsseCondominio = true;
        } catch (err: any) {
          const statusCode = err?.statusCode;
          if (statusCode === 404 || statusCode === 410) {
            await supabaseAdmin.from("push_assinaturas_condominio").delete().eq("id", assinatura.id);
          } else {
            console.error("Erro ao enviar push (lembrete de agenda):", statusCode, err?.body || err);
          }
        }
      }
      if (avisouEsseCondominio) totalCondominiosAvisados++;
    }

    return jsonResponse({
      ok: true,
      data_alvo: amanhaStr,
      eventos_encontrados: (eventos || []).length,
      condominios_avisados: totalCondominiosAvisados,
      pushes_enviados: totalEnviados,
    });
  } catch (e) {
    console.error("Erro inesperado em lembrete-agenda:", e);
    return jsonResponse({ error: "erro interno" }, 500);
  }
});
