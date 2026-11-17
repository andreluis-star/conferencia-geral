// ============================================================
//  CONFERÊNCIA GERAL — Bipagem de volumes (dados compartilhados)
//  Usado por bipador.html (lê as etiquetas), conferente.html
//  (contadores e OK automático) e admin.html (devolutivas).
//
//  Coleção "bipagens": um documento por leitura (aceita ou não).
//    dia 'AAAA-MM-DD', placa, tipo 'SAIDA'|'ENTRADA', k (chave da nota),
//    nf (rótulo), dest, cod, vol ('2/5' ou ''), resultado, motivo,
//    placaCerta, conferenteId, conferenteNome, ts, tms, origem, modo,
//    removida, removidaPor
//  resultado: OK | DUPLICADO | EXCEDENTE | CARGA_ERRADA | FORA_PROGRAMACAO | NAO_RECONHECIDO
//
//  Coleção "bipagem_vinculos": código de cliente (igual em todas as
//  caixas, ex.: Ref Ansell) ligado a uma nota naquele dia.
// ============================================================

const BIP_COL  = 'bipagens';
const VINC_COL = 'bipagem_vinculos';

const BIP_RESULTADOS = {
  OK:               { rot: 'OK',                   cor: '#1E9E4A' },
  DUPLICADO:        { rot: 'Volume duplicado',     cor: '#D32F2F' },
  EXCEDENTE:        { rot: 'Volume excedente',     cor: '#D32F2F' },
  CARGA_ERRADA:     { rot: 'Carga errada',         cor: '#D32F2F' },
  FORA_PROGRAMACAO: { rot: 'Fora da programação',  cor: '#B45309' },
  NAO_RECONHECIDO:  { rot: 'Código não reconhecido', cor: '#B45309' },
};

/** Ouve as leituras de um dia (todas as placas). Devolve a função que para de ouvir. */
function bipOuvirDia(dia, cb) {
  return db.collection(BIP_COL).where('dia', '==', dia).onSnapshot(snap => {
    const lista = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    lista.sort((a, b) => (a.tms || 0) - (b.tms || 0));
    cb(lista);
  }, e => console.warn('bipOuvirDia:', e.message));
}

/** Leituras de um período (para o admin). */
async function bipBuscarPeriodo(de, ate) {
  const snap = await db.collection(BIP_COL).where('dia', '>=', de).where('dia', '<=', ate).get();
  const lista = snap.docs.map(d => ({ id: d.id, ...d.data() }));
  lista.sort((a, b) => (a.tms || 0) - (b.tms || 0));
  return lista;
}

/** Ouve os vínculos de código de cliente → nota de um dia. */
function bipOuvirVinculos(dia, cb) {
  return db.collection(VINC_COL).where('dia', '==', dia).onSnapshot(snap => {
    const m = {};
    snap.docs.forEach(d => { const v = d.data(); if (v && v.cod) m[v.cod] = v; });
    cb(m);
  }, e => console.warn('bipOuvirVinculos:', e.message));
}

/** Leituras válidas (OK e não removidas). */
function bipValidas(lista) { return lista.filter(b => b.resultado === 'OK' && !b.removida); }

/** { chaveDaNota: [leituras válidas] } de uma placa + tipo. */
function bipPorNota(lista, placa, tipo) {
  const m = {};
  bipValidas(lista).forEach(b => {
    if (b.placa !== placa || b.tipo !== tipo) return;
    (m[b.k] = m[b.k] || []).push(b);
  });
  return m;
}

function _bipHash(s) { let h = 0; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0; return (h >>> 0).toString(36); }

/** Grava uma leitura. Devolve a promessa do Firestore. */
function bipRegistrar(evt, user) {
  const doc = {
    removida: false, origem: 'bipador', ...evt,
    conferenteId: (user && user.uid) || '', conferenteNome: (user && (user.nome || user.email)) || '',
    ts: firebase.firestore.FieldValue.serverTimestamp(), tms: Date.now(),
  };
  return db.collection(BIP_COL).add(doc);
}

/** Marca uma leitura como removida (fica no histórico). */
function bipRemover(id, user) {
  return db.collection(BIP_COL).doc(id).update({
    removida: true, removidaPor: (user && (user.nome || user.email)) || '', removidaEm: Date.now(),
  });
}

/** Liga um código de cliente a uma nota no dia. */
function bipVincular(dia, cod, nota, placa, tipo, user) {
  return db.collection(VINC_COL).doc(dia + '_' + _bipHash(cod)).set({
    dia, cod, placa, tipo, k: nota.k, nf: nota.rot,
    por: (user && (user.nome || user.email)) || '', tms: Date.now(),
  });
}

// ── Som e vibração ──
let _bipAudio = null;
function bipSom(tipo) {   // 'ok' | 'erro' | 'aviso' | 'completa'
  try {
    _bipAudio = _bipAudio || new (window.AudioContext || window.webkitAudioContext)();
    const tons = tipo === 'ok' ? [[1500, .07]]
      : tipo === 'completa' ? [[1200, .08], [1600, .12]]
      : tipo === 'aviso' ? [[700, .12], [700, .12]]
      : [[320, .17], [220, .17], [320, .24]];
    let t = _bipAudio.currentTime;
    tons.forEach(([f, d]) => {
      const o = _bipAudio.createOscillator(), g = _bipAudio.createGain();
      o.type = (tipo === 'erro') ? 'square' : 'sine'; o.frequency.value = f; g.gain.value = .25;
      o.connect(g); g.connect(_bipAudio.destination); o.start(t); o.stop(t + d); t += d + .04;
    });
  } catch (e) {}
  if (tipo === 'erro' && navigator.vibrate) navigator.vibrate([220, 80, 220]);
  if (tipo === 'aviso' && navigator.vibrate) navigator.vibrate(120);
}

/** Hora curta de uma leitura. */
function bipHora(b) { return b && b.tms ? new Date(b.tms).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : ''; }

/** Ouve as leituras de uma placa num dia (conferente). */
function bipOuvirPlaca(dia, placa, cb) {
  return db.collection(BIP_COL).where('dia', '==', dia).where('placa', '==', placa).onSnapshot(snap => {
    const lista = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    lista.sort((a, b) => (a.tms || 0) - (b.tms || 0));
    cb(lista);
  }, e => console.warn('bipOuvirPlaca:', e.message));
}

/**
 * Leituras válidas de uma nota da programação: as feitas para a placa + chave
 * da nota, e as feitas por NOTA (campo lote = número da NF), em qualquer placa.
 */
function bipLidasDaNota(lista, placa, tipo, nota) {
  return bipValidas(lista).filter(b => b.tipo === tipo &&
    ((b.placa === placa && b.k === nota.k) || (b.lote && nota.docs.includes(b.lote) && (!b.placa || b.placa === placa))));
}

/** Leituras válidas de um lote (número da NF), em qualquer placa. */
function bipLidasDoLote(lista, tipo, num) {
  return bipValidas(lista).filter(b => b.tipo === tipo && b.lote === num);
}
