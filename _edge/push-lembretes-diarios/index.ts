import { createClient } from "jsr:@supabase/supabase-js@2";
import webpush from "npm:web-push@3.6.7";

// Chamada apenas pelo pg_cron (via pg_net), uma vez por dia — protegida por
// um segredo compartilhado no header, já que não existe usuário logado aqui.
//
// Cobre tanto morador (condomínio) quanto colaborador (empresa) — antes só
// avisava morador; agora qualquer encomenda parada dispara o mesmo lembrete
// pra quem for o dono dela, seja resident_id ou colaborador_id.
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
      return new Response("config ausente", { status: 500 });
    }
    webpush.setVapidDetails(vapidSubject, vapidPublicKey, vapidPrivateKey);

    const supabaseAdmin = createClient(supabaseUrl, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

    // Meia-noite UTC de hoje: encomendas cujo último lembrete foi antes disso
    // (ou nunca tiveram lembrete) ainda não foram avisadas "hoje". O aviso
    // imediato de quando a encomenda chega já marca ultimo_lembrete_em, então
    // isso não duplica notificação no mesmo dia da chegada.
    // app_entrega is null: entregas de comida (iFood/Rappi/etc) não entram
    // nessa rotina de lembrete diário — só recebem o aviso imediato, já que
    // não faz sentido lembrar de comida horas depois.
    const hojeInicio = new Date();
    hojeInicio.setUTCHours(0, 0, 0, 0);

    const { data: pendentes, error: pendErr } = await supabaseAdmin
      .from("encomendas")
      .select("id, resident_id, colaborador_id, codigo, remetente")
      .is("retirado_em", null)
      .is("app_entrega", null)
      .or("resident_id.not.is.null,colaborador_id.not.is.null")
      .or("ultimo_lembrete_em.is.null,ultimo_lembrete_em.lt." + hojeInicio.toISOString());

    if (pendErr) {
      console.error("Erro ao buscar encomendas pendentes:", pendErr);
      return new Response("erro ao buscar pendentes", { status: 500 });
    }

    let totalEnviados = 0;
    let totalComPush = 0;

    for (const encomenda of pendentes || []) {
      // Cada encomenda pertence a um morador OU a um colaborador, nunca aos
      // dois — a mesma convenção já usada em encomendas (resident_id pro
      // condomínio, colaborador_id pra empresa).
      const ehColaborador = !!encomenda.colaborador_id;
      const tabelaAssinaturas = ehColaborador ? "push_assinaturas_colaborador" : "push_assinaturas_morador";
      const colunaDono = ehColaborador ? "colaborador_id" : "morador_id";
      const idDono = ehColaborador ? encomenda.colaborador_id : encomenda.resident_id;
      const urlDestino = ehColaborador ? "/parceiros/portal-colaborador.html" : "/parceiros/portal-morador.html";

      const { data: assinaturas } = await supabaseAdmin
        .from(tabelaAssinaturas)
        .select("id, endpoint, p256dh, auth")
        .eq(colunaDono, idDono);

      if (assinaturas && assinaturas.length) {
        totalComPush++;
        const payload = JSON.stringify({
          title: "Você tem encomenda esperando 📦",
          body: encomenda.remetente
            ? "A encomenda de " + encomenda.remetente + " ainda está na portaria."
            : "Ainda tem uma encomenda esperando você na portaria.",
          url: urlDestino,
        });

        for (const assinatura of assinaturas) {
          try {
            await webpush.sendNotification(
              { endpoint: assinatura.endpoint, keys: { p256dh: assinatura.p256dh, auth: assinatura.auth } },
              payload,
            );
            totalEnviados++;
          } catch (err: any) {
            const statusCode = err?.statusCode;
            if (statusCode === 404 || statusCode === 410) {
              await supabaseAdmin.from(tabelaAssinaturas).delete().eq("id", assinatura.id);
            } else {
              console.error("Erro ao enviar push (lembrete diário):", statusCode, err?.body || err);
            }
          }
        }
      }

      // Marca como processada hoje mesmo sem assinatura ativa, pra não reprocessar à toa.
      await supabaseAdmin.from("encomendas").update({ ultimo_lembrete_em: new Date().toISOString() }).eq("id", encomenda.id);
    }

    return new Response(JSON.stringify({
      ok: true,
      encomendas_processadas: pendentes?.length || 0,
      encomendas_com_push: totalComPush,
      pushes_enviados: totalEnviados,
    }), { status: 200, headers: { "Content-Type": "application/json" } });
  } catch (e) {
    console.error("Erro inesperado em push-lembretes-diarios:", e);
    return new Response("erro interno", { status: 500 });
  }
});
