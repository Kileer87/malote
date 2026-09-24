// Malote — Programa de Parceiros: captura do código de indicação.
// Link do parceiro: https://APP/indicar/CODIGO (o _redirects na raiz do
// site reescreve /indicar/* pra esta pasta, mantendo a URL visível).
// Regra: o PRIMEIRO código capturado vence (first-wins) — nunca sobrescreve
// um código já salvo. Depois de capturar, limpa a URL (history.replaceState)
// pra não deixar o código visível na barra de endereço.
(function () {
  try {
    var m = location.pathname.match(/\/indicar\/([^\/?#]+)/i);
    if (m && m[1]) {
      var codigo = decodeURIComponent(m[1]).trim();
      if (codigo && !localStorage.getItem('malote_ref_codigo')) {
        localStorage.setItem('malote_ref_codigo', codigo);
      }
      if (window.history && history.replaceState) {
        history.replaceState(null, '', location.pathname.replace(/\/indicar\/[^\/?#]+\/?/i, '/parceiros/cadastro.html'));
      }
    }
  } catch (e) { /* localStorage indisponível — cliente vira venda direta */ }
})();

function malotCodigoIndicacaoSalvo(){
  try { return localStorage.getItem('malote_ref_codigo') || ''; }
  catch (e) { return ''; }
}
function malotLimparCodigoIndicacao(){
  try { localStorage.removeItem('malote_ref_codigo'); }
  catch (e) { /* noop */ }
}
