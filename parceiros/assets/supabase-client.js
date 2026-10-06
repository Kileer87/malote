// Malote — Programa de Parceiros: cliente Supabase compartilhado.
// A publishable key é pública por natureza (protegida pelas policies RLS
// no banco) — pode ficar no front sem problema.
window.MALOTE_SUPABASE_URL = 'https://nslcuaajnwqggdobryar.supabase.co';
window.MALOTE_SUPABASE_KEY = 'sb_publishable_mf_Bq6hatl7A6D37uVgnPw_7Qi-h0SB';

// Chave pública VAPID usada pra assinar as notificações push do portal do
// morador (a chave privada correspondente vive só como secret da Edge
// Function, nunca no front). Pública por natureza — não é sensível.
window.MALOTE_VAPID_PUBLIC_KEY = 'BC1xnJ19c9n5TCFaflN_vETToQ8kddT7C3VOylGG62byIFL1vR9whAFFOEM0yu0u-fbU1twTi3YIKTMvBMLgbag';

window.malote = window.supabase.createClient(window.MALOTE_SUPABASE_URL, window.MALOTE_SUPABASE_KEY);

// ---------- helpers compartilhados ----------
function malotToast(msg, tipo){
  var el = document.getElementById('toast');
  if (!el) return;
  el.textContent = msg;
  el.style.background = tipo === 'erro' ? 'var(--danger)' : (tipo === 'ok' ? 'var(--ok)' : 'var(--ink)');
  el.style.color = 'var(--canvas)';
  el.classList.add('show');
  clearTimeout(window.__malotToastTimer);
  window.__malotToastTimer = setTimeout(function(){ el.classList.remove('show'); }, 3400);
}

function malotErroMsg(err){
  if (!err) return 'Erro desconhecido.';
  var msg = err.message || String(err);
  if (/email not confirmed/i.test(msg)){
    return 'Sua conta ainda está aguardando liberação do administrador. Assim que ele confirmar, você já consegue entrar — não precisa checar o e-mail.';
  }
  if (/invalid login credentials/i.test(msg)){
    return 'E-mail ou senha incorretos.';
  }
  return msg;
}

async function malotSessao(){
  var r = await window.malote.auth.getSession();
  return r.data ? r.data.session : null;
}

// Redireciona pra login se não houver sessão. Use no topo de páginas protegidas.
async function malotExigirSessao(redirectTo){
  var sessao = await malotSessao();
  if (!sessao){
    location.href = redirectTo || 'login.html';
    return null;
  }
  return sessao;
}

function malotFormatarCentavos(centavos){
  var v = (centavos || 0) / 100;
  return v.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
}

// Regra de preço da assinatura condominial: faixas fixas por quantidade de
// apartamentos (substitui a fórmula linear de R$ 0,99/apto extra usada antes).
// Importante: a Edge Function mp-criar-pagamento tem a MESMA tabela
// reescrita em TypeScript (ela nunca confia num valor vindo do navegador) —
// se a regra de preço mudar, atualize os dois lugares.
var MALOTE_FAIXAS_CONDOMINIAL = [
  { ateApartamentos: 60, valor: 120.00 },
  { ateApartamentos: 150, valor: 270.00 },
  { ateApartamentos: 300, valor: 480.00 },
  { ateApartamentos: Infinity, valor: 700.00 }
];

function malotCalcularMensalidade(qtdApartamentos){
  var qtd = parseInt(qtdApartamentos, 10);
  if (isNaN(qtd) || qtd < 1) qtd = 1;
  for (var i = 0; i < MALOTE_FAIXAS_CONDOMINIAL.length; i++){
    if (qtd <= MALOTE_FAIXAS_CONDOMINIAL[i].ateApartamentos) return MALOTE_FAIXAS_CONDOMINIAL[i].valor;
  }
  return MALOTE_FAIXAS_CONDOMINIAL[MALOTE_FAIXAS_CONDOMINIAL.length - 1].valor;
}

function malotFormatarReais(valor){
  return (valor || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
}

// Regra de preço do Plano Empresarial: R$ 300,00/mês cobrindo até 500
// colaboradores, + R$ 50,00 a cada bloco adicional de 100 colaboradores.
// Importante: a Edge Function mp-criar-pagamento tem a MESMA fórmula
// reescrita em TypeScript (ela nunca confia num valor vindo do navegador) —
// se a regra de preço mudar, atualize os dois lugares.
var MALOTE_PRECO_BASE_EMPRESARIAL = 300.00;
var MALOTE_COLABORADORES_INCLUSOS = 500;
var MALOTE_PRECO_POR_BLOCO_100_EXTRA = 50.00;

function malotCalcularMensalidadeEmpresarial(qtdColaboradores){
  var qtd = parseInt(qtdColaboradores, 10);
  if (isNaN(qtd) || qtd < 1) qtd = 1;
  if (qtd <= MALOTE_COLABORADORES_INCLUSOS) return MALOTE_PRECO_BASE_EMPRESARIAL;
  var blocosExtras = Math.ceil((qtd - MALOTE_COLABORADORES_INCLUSOS) / 100);
  var total = MALOTE_PRECO_BASE_EMPRESARIAL + blocosExtras * MALOTE_PRECO_POR_BLOCO_100_EXTRA;
  return Math.round(total * 100) / 100;
}

// Valor mensal "efetivo" de uma conta: usa o valor manual definido pelo admin
// (condominios.valor_mensal_manual_centavos) quando existir; senão cai pra
// faixa automática (condominial ou empresarial, conforme tipo_operacao).
// Recebe a linha de `condominios` inteira (ou um objeto com os mesmos campos).
function malotValorMensalEfetivo(condominio){
  if (!condominio) return 0;
  if (condominio.valor_mensal_manual_centavos !== null && condominio.valor_mensal_manual_centavos !== undefined){
    return Math.round(Number(condominio.valor_mensal_manual_centavos)) / 100;
  }
  return condominio.tipo_operacao === 'empresarial'
    ? malotCalcularMensalidadeEmpresarial(condominio.qtd_colaboradores_contratados)
    : malotCalcularMensalidade(condominio.qtd_apartamentos);
}

// Aplica um desconto percentual (0-100) sobre um valor em reais.
function malotAplicarDesconto(valor, percentual){
  if (!percentual || percentual <= 0) return valor;
  var p = Math.min(100, Math.max(0, Number(percentual)));
  return Math.round(valor * (1 - p / 100) * 100) / 100;
}

// Busca o cupom de desconto ativo (não revogado e ainda dentro do prazo) de
// um condomínio, se houver. Usa o cliente malote normal (RLS já deixa o
// próprio dono ou o admin enxergar) — não precisa de RPC pra só ler.
async function malotBuscarDescontoAtivo(condominioId){
  if (!condominioId) return null;
  var hoje = new Date().toISOString().slice(0, 10);
  var r = await window.malote.from('descontos_concedidos')
    .select('*')
    .eq('condominio_id', condominioId)
    .eq('revogado', false)
    .gte('valido_ate', hoje)
    .order('concedido_em', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (r.error || !r.data) return null;
  return r.data;
}

function malotFormatarData(iso){
  if (!iso) return '—';
  var d = new Date(iso);
  if (isNaN(d.getTime())) return '—';
  return d.toLocaleDateString('pt-BR');
}

// Pra colunas do tipo "date" puro (ex: proximo_vencimento, 'AAAA-MM-DD',
// sem horário). new Date('AAAA-MM-DD') interpreta como UTC meia-noite, o
// que em fusos negativos (Brasil) mostraria o dia anterior — por isso
// montamos a data em horário local em vez de deixar o JS fazer o parse.
function malotFormatarDataSimples(dataStr){
  if (!dataStr) return '—';
  var partes = String(dataStr).split('-');
  if (partes.length !== 3) return malotFormatarData(dataStr);
  var d = new Date(Number(partes[0]), Number(partes[1]) - 1, Number(partes[2]));
  if (isNaN(d.getTime())) return '—';
  return d.toLocaleDateString('pt-BR');
}

function malotFormatarCompetencia(dateStr){
  if (!dateStr) return '—';
  var partes = dateStr.split('-');
  if (partes.length < 2) return dateStr;
  var meses = ['jan','fev','mar','abr','mai','jun','jul','ago','set','out','nov','dez'];
  var mi = parseInt(partes[1], 10) - 1;
  return (meses[mi] || partes[1]) + '/' + partes[0];
}

async function malotSair(){
  await window.malote.auth.signOut();
  // Caminho absoluto: essa função é compartilhada por páginas em pastas
  // diferentes (parceiros/, sindico/), então um caminho relativo tipo
  // 'login.html' quebra (vira /sindico/login.html, que não existe) quando
  // chamado de fora de /parceiros/.
  location.href = '/parceiros/login.html';
}

// Botão "Voltar": usa o histórico do navegador quando existe (ex: veio de
// outra página do próprio Malote), senão cai num destino padrão — evita
// deixar a pessoa presa numa tela sem ter pra onde voltar quando é a
// primeira página aberta na aba/sessão.
//
// history.length > 1 não é garantia de que history.back() vai funcionar —
// em alguns navegadores (principalmente iPhone/Safari, PWA instalada, ou a
// página aberta a partir de um link externo/notificação) o back() não faz
// nada e a pessoa fica presa na tela sem perceber. Por isso, se depois de
// um instante a página não tiver mudado, força a navegação pro destino
// padrão como rede de segurança.
// "Olhinho" pra mostrar/ocultar senha: qualquer botão com
// data-toggle-senha="id-do-campo" já funciona, sem precisar registrar nada
// por página (o clique é pego por delegação, mais abaixo).
var ICON_OLHO_ABERTO = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7-11-7-11-7Z"/><circle cx="12" cy="12" r="3"/></svg>';
var ICON_OLHO_FECHADO = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17.94 17.94A10.94 10.94 0 0 1 12 20c-7 0-11-8-11-8a21.86 21.86 0 0 1 5.06-6.06M9.9 4.24A10.4 10.4 0 0 1 12 4c7 0 11 8 11 8a21.86 21.86 0 0 1-3.22 4.68M14.12 14.12a3 3 0 1 1-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/></svg>';
document.addEventListener('DOMContentLoaded', function(){
  document.querySelectorAll('[data-toggle-senha]').forEach(function(btn){
    if (!btn.innerHTML.trim()) btn.innerHTML = ICON_OLHO_ABERTO;
  });
});
document.addEventListener('click', function(e){
  var btn = e.target.closest('[data-toggle-senha]');
  if (!btn) return;
  var alvo = document.getElementById(btn.getAttribute('data-toggle-senha'));
  if (!alvo) return;
  var mostrando = alvo.type === 'text';
  alvo.type = mostrando ? 'password' : 'text';
  btn.innerHTML = mostrando ? ICON_OLHO_ABERTO : ICON_OLHO_FECHADO;
  btn.setAttribute('aria-label', mostrando ? 'Mostrar senha' : 'Ocultar senha');
});

// Gráfico de linhas com duas séries (mesma unidade/escala, um eixo só) —
// usado pelo dashboard de entregas/retiradas do síndico e do responsável de
// setor. Segue o mesmo padrão do graficoVendasMensais() do admin.html: SVG
// cru montado por concatenação de string, sem lib nenhuma, tooltip nativo
// via <title>, linha de base recessiva.
// pontos: [{ label: 'dd/mm', v1: 3, v2: 1 }, ...]
// opts: { nome1, nome2, ariaLabel, formatarValor }
function malotGraficoDuasSeries(pontos, opts){
  opts = opts || {};
  var nome1 = opts.nome1 || 'Série 1';
  var nome2 = opts.nome2 || 'Série 2';
  var cor1 = 'var(--accent)';
  var cor2 = 'var(--chart-2)';
  var ariaLabel = opts.ariaLabel || 'Gráfico de linhas';
  var formatarValor = opts.formatarValor || function(v){ return String(v); };

  if (!pontos || !pontos.length){
    return '<p class="empty">Sem dados suficientes ainda pra montar o gráfico.</p>';
  }

  var n = pontos.length;
  var maxVal = Math.max.apply(null, [].concat(
    pontos.map(function(p){ return p.v1 || 0; }),
    pontos.map(function(p){ return p.v2 || 0; }),
    [1]
  ));
  var w = 760, h = 220, padL = 8, padR = 8, padT = 14, padB = 28;
  var plotW = w - padL - padR, plotH = h - padT - padB;
  var slot = n > 1 ? plotW / (n - 1) : 0;

  function coordX(i){ return padL + (n > 1 ? i * slot : plotW / 2); }
  function coordY(v){ return padT + plotH - (maxVal > 0 ? ((v || 0) / maxVal) * plotH : 0); }

  function tracarLinha(chave, cor){
    var d = '';
    pontos.forEach(function(p, i){
      d += (i === 0 ? 'M' : 'L') + coordX(i).toFixed(1) + ',' + coordY(p[chave]).toFixed(1) + ' ';
    });
    return '<path d="' + d.trim() + '" fill="none" stroke="' + cor + '" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>';
  }

  function marcarPontos(chave, cor, nomeSerie){
    return pontos.map(function(p, i){
      var x = coordX(i), y = coordY(p[chave]);
      return '<circle cx="' + x.toFixed(1) + '" cy="' + y.toFixed(1) + '" r="3" fill="' + cor + '"><title>' +
        p.label + ' — ' + nomeSerie + ': ' + formatarValor(p[chave] || 0) + '</title></circle>';
    }).join('');
  }

  var svg = '<svg viewBox="0 0 ' + w + ' ' + h + '" style="width:100%;height:auto;" role="img" aria-label="' + ariaLabel + '">';
  svg += '<line x1="' + padL + '" y1="' + (padT + plotH) + '" x2="' + (padL + plotW) + '" y2="' + (padT + plotH) + '" stroke="var(--border)" stroke-width="1"/>';
  svg += tracarLinha('v1', cor1);
  svg += tracarLinha('v2', cor2);
  svg += marcarPontos('v1', cor1, nome1);
  svg += marcarPontos('v2', cor2, nome2);

  // rótulos do eixo x — some com alguns quando tem muito ponto, senão vira
  // uma faixa ilegível (mesma lógica do chart-mes do admin.html, só que
  // calculada em JS em vez de via classe CSS, porque aqui n varia).
  var passo = n > 10 ? Math.ceil(n / 8) : 1;
  var indicesLabel = [];
  for (var iL = 0; iL < n; iL += passo) indicesLabel.push(iL);
  if (indicesLabel[indicesLabel.length - 1] !== n - 1){
    // o último ponto (o mais recente) sempre aparece — mas se ele cair muito
    // colado no penúltimo rótulo já escolhido (menos de um "passo" de
    // distância), os dois textos se sobrepõem; nesse caso tira o penúltimo
    // em vez de espremer os dois.
    if (n - 1 - indicesLabel[indicesLabel.length - 1] < passo) indicesLabel.pop();
    indicesLabel.push(n - 1);
  }
  pontos.forEach(function(p, i){
    if (indicesLabel.indexOf(i) !== -1){
      // o primeiro e o último ponto ficam bem na borda do gráfico (não tem
      // "meia barra" de folga como no gráfico de barras) — se o texto ficar
      // centralizado nesses dois, metade dele vaza pra fora do SVG e corta.
      // Ancorar pelo início/fim em vez do centro resolve sem mudar a régua.
      var ancora = (i === 0) ? 'start' : (i === n - 1) ? 'end' : 'middle';
      svg += '<text x="' + coordX(i).toFixed(1) + '" y="' + (h - 8) + '" text-anchor="' + ancora + '" font-size="9.5" fill="var(--ink-muted)">' + p.label + '</text>';
    }
  });
  svg += '</svg>';

  var legenda = '<div class="legenda-grafico">' +
    '<span><i class="dot" style="background:' + cor1 + '"></i>' + nome1 + '</span>' +
    '<span><i class="dot" style="background:' + cor2 + '"></i>' + nome2 + '</span>' +
    '</div>';

  return legenda + svg;
}

// Formata um intervalo em milissegundos como "2h", "3d 4h" etc, pra mostrar
// há quanto tempo uma encomenda está esperando retirada.
function malotFormatarEspera(ms){
  if (!ms || ms < 0) ms = 0;
  var minutos = Math.floor(ms / 60000);
  if (minutos < 60) return minutos + ' min';
  var horas = Math.floor(minutos / 60);
  if (horas < 24) return horas + 'h';
  var dias = Math.floor(horas / 24);
  var horasRestantes = horas % 24;
  return dias + 'd' + (horasRestantes > 0 ? ' ' + horasRestantes + 'h' : '');
}

// Versão por extenso do tempo de espera, pra frases como "Aguardando há 2
// dias" (usado no lembrete de retirada do Malote Empresarial).
function malotFormatarEsperaDias(ms){
  if (!ms || ms < 0) ms = 0;
  var dias = Math.floor(ms / (24 * 60 * 60 * 1000));
  if (dias <= 0) return 'menos de 1 dia';
  return dias + (dias === 1 ? ' dia' : ' dias');
}

// "hoje às 10:35" / "ontem às 10:35" / "07/09 às 10:35" — usado pra mostrar
// quando um lembrete manual foi enviado.
function malotFormatarQuando(dataIsoOuDate){
  var d = (dataIsoOuDate instanceof Date) ? dataIsoOuDate : new Date(dataIsoOuDate);
  var agora = new Date();
  var hoje = new Date(agora.getFullYear(), agora.getMonth(), agora.getDate());
  var diaData = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  var diffDias = Math.round((hoje - diaData) / (24 * 60 * 60 * 1000));
  var hora = String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
  if (diffDias === 0) return 'hoje às ' + hora;
  if (diffDias === 1) return 'ontem às ' + hora;
  return String(d.getDate()).padStart(2, '0') + '/' + String(d.getMonth() + 1).padStart(2, '0') + ' às ' + hora;
}

// Só dígitos — pra normalizar telefone antes de montar o link do WhatsApp.
function malotDigits(s){ return String(s || '').replace(/\D/g, ''); }

// Monta o link "wa.me" com o telefone (adiciona DDI 55 se vier só com DDD)
// e a mensagem já preenchida.
function malotWaLink(phone, message){
  var d = malotDigits(phone);
  if (d.length > 0 && d.length <= 11) d = '55' + d;
  return 'https://wa.me/' + d + '?text=' + encodeURIComponent(message);
}

// ---------- foto de perfil da conta (condomínio ou empresa) ----------
// Cada conta pode cadastrar sua própria foto (logo) pra aparecer no topo do
// app, no lugar do ícone padrão do Malote. Quem não cadastra nenhuma foto
// vê as iniciais do nome da conta como retrato provisório — nunca fica sem
// nenhum "logo".

// Iniciais (até 2 letras) a partir do nome do condomínio/empresa: primeira
// letra da primeira e da última palavra "de verdade" do nome (ignora
// conectivos curtos tipo "de"/"da"/"do"/"e"). Com uma palavra só, usa as
// duas primeiras letras dela. Mesmo critério já usado pro logo do Cleiton
// em sobre.html ("CQ" a partir de "Cleiton Queiroz").
function malotIniciais(nome){
  if (!nome) return 'M';
  var conectivos = { de:1, da:1, do:1, das:1, dos:1, e:1 };
  var todas = String(nome).trim().split(/\s+/).filter(Boolean);
  var palavras = todas.filter(function(p){ return !conectivos[p.toLowerCase()]; });
  if (!palavras.length) palavras = todas;
  if (!palavras.length) return 'M';
  if (palavras.length === 1) return palavras[0].substring(0, 2).toUpperCase();
  return (palavras[0].charAt(0) + palavras[palavras.length - 1].charAt(0)).toUpperCase();
}

// Monta a URL pública da foto de perfil a partir do caminho salvo em
// condominios.foto_perfil_path. O bucket 'perfil-fotos' é público (é só um
// logo, não é dado sensível como foto de morador/encomenda), então não
// precisa de signed URL — só a URL pública mesmo, com cache no navegador.
function malotFotoPerfilUrl(fotoPath){
  if (!fotoPath) return null;
  var pub = window.malote.storage.from('perfil-fotos').getPublicUrl(fotoPath);
  return (pub && pub.data && pub.data.publicUrl) ? pub.data.publicUrl : null;
}

// Atualiza o "logo" da conta num elemento da página: troca pra foto
// cadastrada (se tiver) ou pras iniciais do nome (se não tiver). Recebe o
// id do próprio elemento (a <img> atual) e substitui pelo marcador certo —
// funciona tanto no topbar do leitor (index.html) quanto nos painéis
// (síndico/empresa), cada um passando as classes CSS que já tem prontas.
function malotAtualizarLogo(elId, nome, fotoPath, opts){
  var el = document.getElementById(elId);
  if (!el) return;
  opts = opts || {};
  var imgClass = opts.imgClass || '';
  var avatarClass = opts.avatarClass || imgClass;
  var alt = (opts.alt || 'Malote').replace(/"/g, '&quot;');
  var url = malotFotoPerfilUrl(fotoPath);
  var html = url
    ? '<img id="' + elId + '" class="' + imgClass + '" src="' + url + '" alt="' + alt + '">'
    : '<div id="' + elId + '" class="' + avatarClass + '" aria-hidden="true">' + malotIniciais(nome) + '</div>';
  el.outerHTML = html;
}

// Converte uma dataURL (canvas.toDataURL) num Blob pra subir no Storage —
// mesma implementação usada no leitor (index.html) pra fotos de morador e
// de encomenda, só compartilhada aqui pros painéis também poderem usar.
function malotDataUrlParaBlob(dataUrl){
  var partes = dataUrl.split(',');
  var mimeMatch = partes[0].match(/:(.*?);/);
  var mime = mimeMatch ? mimeMatch[1] : 'image/jpeg';
  var bin = atob(partes[1]);
  var arr = new Uint8Array(bin.length);
  for (var i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  return new Blob([arr], { type: mime });
}

function malotVoltar(destinoPadrao){
  // Antes isto tentava "voltar" pelo histórico do navegador primeiro, e só ia
  // pro destino combinado se a URL não mudasse. Só que window.history.length
  // conta TODO o histórico daquela aba, inclusive páginas de fora do Malote
  // (ex: a pessoa navegou por várias outras coisas antes de abrir o Malote
  // nessa mesma aba) — "voltar" caía em qualquer página anterior da aba, não
  // necessariamente no leitor/painel/login que cada botão promete. Cada
  // chamada já informa exatamente pra onde deve ir, então ir direto ali é
  // sempre previsível — não precisa adivinhar via histórico.
  location.href = destinoPadrao || 'login.html';
}
