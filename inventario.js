// ============================================================
//  CONFERÊNCIA GERAL — Ligação com o INVENTÁRIO PORTOEX
//  (Realtime Database "portoex-inventario", nó "inventario").
//
//  Os itens do inventário podem ter foto de vários MB, então baixar o nó
//  inteiro é inviável no celular. Por isso existe um ÍNDICE LEVE no mesmo
//  banco, "inventario_idx/<chave>" = { ts, nf, end, cliente, operador, vol, obs },
//  mantido por estas funções: as chaves novas do inventário são lidas campo a
//  campo (sem a foto) e copiadas para o índice; as que saíram (baixa) saem dele.
//
//  Usado por: conferente.html (romaneio), bipador.html, admin.html.
// ============================================================

const INV_DB = 'https://portoex-inventario-default-rtdb.firebaseio.com';
const INV_CAMPOS = ['nf', 'end', 'cliente', 'operador', 'vol', 'obs'];
// Só valem as leituras do inventário dos últimos INV_DIAS dias (romaneio, bipador e admin).
const INV_DIAS = 5;
function invRecentes(itens) { const lim = Date.now() - INV_DIAS * 864e5; return (itens || []).filter(it => (it.ts || 0) >= lim); }

async function _invJson(caminho, opts, timeoutMs = 20000) {
  const c = new AbortController(); const t = setTimeout(() => c.abort(), timeoutMs);
  try {
    const r = await fetch(`${INV_DB}/${caminho}`, { ...(opts || {}), signal: c.signal });
    if (!r.ok) throw new Error(`inventário respondeu ${r.status}`);
    return await r.json();
  } finally { clearTimeout(t); }
}

/**
 * Sincroniza o índice com o inventário. Só lê as chaves novas.
 * limite: no máximo quantas chaves novas ler agora (null = todas).
 * onProgresso(feitos, total). Devolve { novas, lidas, removidas }.
 */
async function invSincronizar({ limite = null, onProgresso = null } = {}) {
  const [chaves, idx] = await Promise.all([
    _invJson('inventario.json?shallow=true'),
    _invJson('inventario_idx.json?shallow=true'),
  ]);
  const ks = Object.keys(chaves || {}), ki = idx || {};
  let novas = ks.filter(k => !ki[k]).sort().reverse();          // mais recentes primeiro
  const removidas = Object.keys(ki).filter(k => !(chaves || {})[k]);
  const total = novas.length;
  if (limite != null) novas = novas.slice(0, limite);
  let feitos = 0, pendente = {};
  const gravar = async () => {
    if (!Object.keys(pendente).length) return;
    const lote = pendente; pendente = {};
    await _invJson('inventario_idx.json', { method: 'PATCH', body: JSON.stringify(lote) });
  };
  let i = 0;
  const trabalhador = async () => {
    while (i < novas.length) {
      const k = novas[i++];
      const vals = await Promise.all(INV_CAMPOS.map(f => _invJson(`inventario/${encodeURIComponent(k)}/${f}.json`).catch(() => null)));
      const o = { ts: +String(k).split('_')[0] || 0 };
      INV_CAMPOS.forEach((f, x) => { if (vals[x] != null && vals[x] !== '') o[f] = typeof vals[x] === 'string' ? vals[x].slice(0, 200) : vals[x]; });
      pendente[k] = o; feitos++;
      if (onProgresso) onProgresso(feitos, novas.length);
      if (Object.keys(pendente).length >= 150) await gravar();
    }
  };
  await Promise.all(Array.from({ length: 10 }, trabalhador));
  removidas.forEach(k => { pendente[k] = null; });
  await gravar();
  _invCache = null;
  return { novas: total, lidas: feitos, removidas: removidas.length };
}

let _invCache = null, _invCacheTs = 0;
/** Lê o índice (leve) inteiro. Guarda 2 minutos na página. */
async function invItens() {
  if (_invCache && Date.now() - _invCacheTs < 120000) return _invCache;
  const j = await _invJson('inventario_idx.json');
  _invCache = Object.entries(j || {}).map(([k, v]) => ({ key: k, ...v })).filter(x => x && x.nf);
  _invCacheTs = Date.now();
  return _invCache;
}

/** Números de um campo de NF ("41857/28115" → ["41857","28115"]; zeros à esquerda saem). */
function invTokens(s) {
  return String(s || '').toUpperCase().split(/[\s\/;,|-]+/).map(t => t.trim()).filter(t => t && /\d/.test(t))
    .map(t => /^\d+$/.test(t) ? String(+t) : t);
}

/** Mapa número da NF → leitura mais recente do inventário { end, ts, operador, cliente, vol, nf, obs }. */
function invMapa(itens) {
  const m = new Map();
  itens.forEach(it => invTokens(it.nf).forEach(t => { const a = m.get(t); if (!a || (it.ts || 0) > (a.ts || 0)) m.set(t, it); }));
  return m;
}

/** Endereço atual de uma nota: recebe os números dela (docs) e devolve o item mais recente ou null. */
function invEnderecoDe(mapa, docs) {
  let best = null;
  (docs || []).forEach(d => { const it = mapa.get(_invNorm(d)); if (it && (!best || (it.ts || 0) > (best.ts || 0))) best = it; });
  return best;
}
function _invNorm(d) { return /^\d+$/.test(String(d)) ? String(+d) : String(d).toUpperCase(); }

/**
 * Mapa pronto para uso: sincroniza o que for rápido (até `limite` itens novos) e lê o índice.
 * Nunca lança: em falha devolve um mapa vazio e o erro.
 */
async function invMapaSeguro(limite = 80) {
  try { await invSincronizar({ limite }); } catch (e) { console.warn('inventário (sincronizar):', e.message); }
  try { return { mapa: invMapa(invRecentes(await invItens())) }; }
  catch (e) { console.warn('inventário (ler):', e.message); return { mapa: new Map(), erro: e.message }; }
}

/** Endereços usados no inventário, do mais usado para o menos usado. */
function invEnderecosUsados(itens) {
  const c = {};
  itens.forEach(it => { const e = String(it.end || '').trim(); if (e) c[e] = (c[e] || 0) + 1; });
  return Object.entries(c).sort((a, b) => b[1] - a[1]).map(([e]) => e);
}

/** Registra no inventário (e no índice) que a nota está num endereço. */
async function invRegistrar({ nf, cliente, vol, end, operador, obs }) {
  const ts = Date.now(), id = `${ts}_${Math.random().toString(36).slice(2, 7)}`;
  const item = { id, ts, nf: String(nf || ''), cliente: String(cliente || ''), vol: String(vol || ''), end: String(end || ''),
    operador: String(operador || ''), opColor: '#1A3A6E', obs: obs || 'BIPADOR' };
  await _invJson(`inventario/${id}.json`, { method: 'PUT', body: JSON.stringify(item) });
  const { id: _, opColor: __, ...leve } = item;
  await _invJson(`inventario_idx/${id}.json`, { method: 'PUT', body: JSON.stringify(leve) }).catch(() => {});
  if (_invCache) _invCache.push({ key: id, ...leve });
  return id;
}

function invQuando(ts) {
  if (!ts) return '';
  const d = new Date(ts), hoje = new Date();
  const hh = d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
  return d.toDateString() === hoje.toDateString() ? hh : `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')} ${hh}`;
}
