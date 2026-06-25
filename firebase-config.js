// ============================================================
//  CONFERÊNCIA GERAL — Configuração Firebase
//  Preencha as variáveis abaixo com os dados do seu projeto.
//  Veja LEIA-ME.html para instruções detalhadas.
// ============================================================

const FIREBASE_CONFIG = {
  apiKey:            "AIzaSyBp_ZfFiz1qWr4Gb4bc5h5mI1kHnjPwyCA",
  authDomain:        "conferenciaptx.firebaseapp.com",
  projectId:         "conferenciaptx",
  storageBucket:     "conferenciaptx.firebasestorage.app",
  messagingSenderId: "78686885828",
  appId:             "1:78686885828:web:0d70d13e2abaf35ee23691",
  measurementId:     "G-HY73Y30YLY"
};

// ============================================================
//  INICIALIZAÇÃO
// ============================================================
if (!firebase.apps.length) {
  firebase.initializeApp(FIREBASE_CONFIG);
}
const auth    = firebase.auth();
const db      = firebase.firestore();
// Storage não utilizado — fotos salvas comprimidas no Firestore

// ============================================================
//  GOOGLE SHEETS — configuração
// ============================================================

/** ID padrão (fallback) — usado se nenhum estiver salvo no Firestore */
const SHEET_ID_DEFAULT = '11ZwvJoxw94lJFZa_ZHyZPI3xmcW87_fYry576EoqHZM';

// Cache em memória — evita consultar o Firestore em cada chamada
let _sheetIdCache = null;

/**
 * Retorna o ID da planilha ativa.
 * Prioridade: Firestore (config/app → sheetId) → SHEET_ID_DEFAULT
 */
async function getSheetId() {
  if (_sheetIdCache) return _sheetIdCache;
  try {
    const doc = await db.collection('config').doc('app').get();
    if (doc.exists && doc.data().sheetId) {
      _sheetIdCache = doc.data().sheetId;
      return _sheetIdCache;
    }
  } catch(e) { /* silencioso — usa fallback */ }
  _sheetIdCache = SHEET_ID_DEFAULT;
  return _sheetIdCache;
}

/** Invalida o cache (chamar após salvar novo sheetId) */
function resetSheetIdCache() { _sheetIdCache = null; }

/** Extrai o ID de uma URL do Google Sheets ou retorna a string diretamente */
function parseSheetIdFromUrl(input) {
  const m = (input||'').match(/\/spreadsheets\/d\/([a-zA-Z0-9_-]+)/);
  return m ? m[1] : (input||'').trim();
}

/** Retorna a data de hoje no formato DD/MM/AAAA (nome das abas) */
function getTodayTabName() {
  const d  = new Date();
  const dd = String(d.getDate()).padStart(2, '0');
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  return `${dd}/${mm}/${d.getFullYear()}`;
}

/** Busca os veículos de uma aba específica do Google Sheets. */
async function fetchSheetVehicles(tabName) {
  const SHEET_ID = await getSheetId();
  // Usa CSV export — mais simples e confiável que gviz
  const csvUrl = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/gviz/tq?tqx=out:csv&sheet=${encodeURIComponent(tabName)}`;
  const jsonUrl = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/gviz/tq?tqx=out:json&sheet=${encodeURIComponent(tabName)}`;

  // --- tenta JSON primeiro ---
  try {
    const resp = await fetch(jsonUrl);
    const text = await resp.text();
    window._lastSheetRaw = text.substring(0, 300); // debug

    const start = text.indexOf('{');
    const end   = text.lastIndexOf('}');
    if (start !== -1) {
      const parsed = JSON.parse(text.substring(start, end + 1));
      if (parsed.table && parsed.table.rows) {
        const result = parseGvizTable(parsed.table);
        if (result.length > 0) return result;
      }
    }
  } catch(e) { console.warn('gviz JSON falhou:', e.message); }

  // --- fallback: CSV ---
  try {
    const resp = await fetch(csvUrl);
    const text = await resp.text();
    window._lastSheetRaw = text.substring(0, 300); // debug
    return parseCsv(text);
  } catch(e) { console.warn('gviz CSV falhou:', e.message); }

  return [];
}

// Letras de coluna para acesso por posição (A=0, B=1, ...)
const _COL_LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';

/** Retorna o valor de uma coluna pelo índice posicional (0=A, 1=B, ...) */
function colByIdx(obj, idx) {
  return (obj['_C' + (_COL_LETTERS[idx] || idx)] || '').trim();
}

function parseGvizTable(table) {
  const cols = table.cols.map(c => (c.label || '').trim());
  const placaIdx = cols.findIndex(c => c.toLowerCase() === 'placa');
  const vehicles = [];

  (table.rows || []).forEach((row, rowIdx) => {
    if (!row.c) return;
    const obj = { _rowIdx: rowIdx };
    cols.forEach((col, i) => {
      const cell = row.c[i];
      // Valor da célula — prefere formato legível (f) para datas/horas, senão usa v
      const rawV = cell ? cell.v : null;
      const rawF = cell ? cell.f : null;
      const val  = rawV !== null && rawV !== undefined
        ? (typeof rawV === 'number' && rawF ? rawF : String(rawV)).trim()
        : '';
      if (col) obj[col] = val;                          // por nome do cabeçalho
      obj['_C' + (_COL_LETTERS[i] || i)] = val;        // por letra de coluna (ex: _CA, _CB)
    });
    // Placa: tenta coluna rotulada "Placa", depois coluna C (índice 2)
    const placa = (placaIdx >= 0 && row.c[placaIdx]?.v
      ? String(row.c[placaIdx].v)
      : obj['Placa'] || obj['_CC'] || '').trim();
    if (placa.length >= 3) {
      obj['Placa'] = placa;
      const opInfo = getOperationInfo(obj);
      obj._operationType = opInfo.tipo;
      obj._cliente       = opInfo.cliente;
      vehicles.push(obj);
    }
  });
  return vehicles;
}

function parseCsv(text) {
  const lines = text.trim().split('\n');
  if (lines.length < 2) return [];
  // Parser CSV robusto — respeita campos entre aspas (ex: "R$ 10.300,53")
  function splitCsvLine(line) {
    const result = []; let cur = ''; let inQ = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === '"') { inQ = !inQ; }
      else if (ch === ',' && !inQ) { result.push(cur.trim()); cur = ''; }
      else { cur += ch; }
    }
    result.push(cur.trim());
    return result;
  }

  const headers  = splitCsvLine(lines[0]).map(h => h.replace(/^"|"$/g,'').trim());
  const placaIdx = headers.findIndex(h => h.toLowerCase() === 'placa');
  if (placaIdx < 0) return [];

  const vehicles = [];
  for (let i = 1; i < lines.length; i++) {
    const cells = splitCsvLine(lines[i]).map(c => c.replace(/^"|"$/g,'').trim());
    const placa  = (cells[placaIdx] || '').trim();
    if (placa.length < 3) continue;
    const obj = { _rowIdx: i };
    headers.forEach((h, idx) => {
      const val = cells[idx] || '';
      if (h) obj[h] = val;                              // por nome do cabeçalho
      obj['_C' + (_COL_LETTERS[idx] || idx)] = val;    // por letra de coluna
    });
    obj['Placa'] = placa;
    const opInfo = getOperationInfo(obj);
    obj._operationType = opInfo.tipo;
    obj._cliente       = opInfo.cliente;
    vehicles.push(obj);
  }
  return vehicles;
}

/**
 * Encontra o valor da coluna "Coleta/Entrega/processo/cliente" (ou similar).
 * Aceita qualquer nome de coluna que contenha 'coleta', 'entrega' ou 'processo'.
 */
function findOpColValue(row) {
  for (const key of Object.keys(row)) {
    if (key.startsWith('_')) continue;
    const kl = key.toLowerCase();
    if (kl.includes('coleta') || kl.includes('entrega') || kl.includes('processo')) {
      const val = (row[key] || '').trim();
      if (val) return val;
    }
  }
  // Fallback: coluna Serviço ou coluna A por posição (sempre é a col de operação)
  return (row['Serviço'] || row['Servico'] || row['_CA'] || '').trim();
}

/**
 * Analisa a célula da coluna de operação.
 * Ex: "Embarque ITACORDA(24/06) - BR 101 km 110 - Penha"
 *   → tipo: 'SAIDA', cliente: 'ITACORDA'
 *
 * EMBARQUE → SAÍDA
 * ENTREGA  → SAÍDA
 * COLETA   → ENTRADA
 */
function parseOpCell(cellValue) {
  const text = (cellValue || '').trim();
  if (!text) return { tipo: 'ENTRADA', cliente: '' };

  const up = text.toUpperCase();
  let tipo  = 'ENTRADA';
  let kwLen = 0;

  if      (up.startsWith('EMBARQUE')) { tipo = 'SAIDA';   kwLen = 8; }
  else if (up.startsWith('ENTREGA'))  { tipo = 'SAIDA';   kwLen = 7; }
  else if (up.startsWith('COLETA'))   { tipo = 'ENTRADA'; kwLen = 6; }

  // Próxima palavra após o tipo = nome do cliente
  // Ex: "Embarque ITACORDA(24/06)..." → "ITACORDA"
  const rest    = text.substring(kwLen).trim();
  const cliente = rest.split(/[\s\-–(]/)[0].replace(/[^A-Za-zÀ-ú0-9]/g, '').trim();

  return { tipo, cliente };
}

/**
 * Retorna { tipo, cliente } para uma linha da planilha.
 */
function getOperationInfo(row) {
  const cellVal = findOpColValue(row);
  return parseOpCell(cellVal);
}

/**
 * Compatibilidade: retorna só o tipo de operação.
 */
function getOperationType(row) {
  return getOperationInfo(row).tipo;
}

// ============================================================
//  INSUMOS — lista padrão (inicializada na primeira execução)
// ============================================================
const INSUMOS_PADRAO = [
  { nome: 'Palete (PBR)',               categoria: 'Palete',    unidade: 'un' },
  { nome: 'Palete (Descartáveis)',       categoria: 'Palete',    unidade: 'un' },
  { nome: 'Palete (Outros)',            categoria: 'Palete',    unidade: 'un' },
  { nome: 'Fita Transparente',          categoria: 'Embalagem', unidade: 'rolo' },
  { nome: 'Fita Paletizadora',          categoria: 'Embalagem', unidade: 'rolo' },
  { nome: 'Stretch Transparente',       categoria: 'Embalagem', unidade: 'rolo' },
  { nome: 'Stretch Verde',              categoria: 'Embalagem', unidade: 'rolo' },
  { nome: 'Lona Preta',                 categoria: 'Proteção',  unidade: 'm²'  },
  { nome: 'Etiquetas Brancas 750un',    categoria: 'Etiqueta',  unidade: 'cx'  },
  { nome: 'Etiquetas Brancas 1000un',   categoria: 'Etiqueta',  unidade: 'cx'  },
  { nome: 'Etiquetas Laranja 750un',    categoria: 'Etiqueta',  unidade: 'cx'  },
  { nome: 'Etiquetas Laranja 1000un',   categoria: 'Etiqueta',  unidade: 'cx'  },
];

/** Cria os insumos padrão no Firestore se ainda não existirem */
async function initInsumosPadrao() {
  const snap = await db.collection('insumos').limit(1).get();
  if (!snap.empty) return;
  const batch = db.batch();
  INSUMOS_PADRAO.forEach(ins => {
    const ref = db.collection('insumos').doc();
    batch.set(ref, { ...ins, saldo: 0, saldoInicial: 0, dataInicio: null, ativo: true, criadoEm: firebase.firestore.FieldValue.serverTimestamp() });
  });
  await batch.commit();
}

// ============================================================
//  AUTENTICAÇÃO — helpers
// ============================================================

/** Retorna os dados do usuário atual do Firestore */
async function getCurrentUserData() {
  const user = auth.currentUser;
  if (!user) return null;
  try {
    const doc = await db.collection('users').doc(user.uid).get();
    return doc.exists ? { ...doc.data(), uid: user.uid, email: user.email } : null;
  } catch {
    return null;
  }
}

/** Redireciona para a página correta conforme o papel do usuário */
function redirectByRole(userData) {
  if (!userData) { window.location.href = 'index.html'; return; }
  const page = window.location.pathname.split('/').pop() || 'index.html';
  if (userData.role === 'admin'      && page !== 'admin.html')      window.location.href = 'admin.html';
  if (userData.role === 'conferente' && page !== 'conferente.html') window.location.href = 'conferente.html';
}

/**
 * Cria um novo usuário (conferente) sem deslogar o admin.
 * Usa uma instância secundária do Firebase App.
 */
async function createConferente(nome, email, senha) {
  const secondaryApp = firebase.initializeApp(FIREBASE_CONFIG, 'secondary_' + Date.now());
  const secondaryAuth = secondaryApp.auth();
  try {
    const cred = await secondaryAuth.createUserWithEmailAndPassword(email, senha);
    await db.collection('users').doc(cred.user.uid).set({
      nome, email, role: 'conferente', ativo: true, criadoEm: firebase.firestore.FieldValue.serverTimestamp()
    });
    return { ok: true, uid: cred.user.uid };
  } catch (e) {
    return { ok: false, error: e.message };
  } finally {
    await secondaryAuth.signOut();
    await secondaryApp.delete();
  }
}

// ============================================================
//  UTILITÁRIOS
// ============================================================

function fmtDate(ts) {
  if (!ts) return '—';
  const d = ts.toDate ? ts.toDate() : new Date(ts);
  return d.toLocaleDateString('pt-BR') + ' ' + d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
}

function fmtDateOnly(ts) {
  if (!ts) return '—';
  const d = ts.toDate ? ts.toDate() : new Date(ts);
  return d.toLocaleDateString('pt-BR');
}

function showToast(msg, tipo = 'success') {
  const el = document.getElementById('toast-container');
  if (!el) return;
  const toast = document.createElement('div');
  toast.className = `toast-msg toast-${tipo}`;
  toast.textContent = msg;
  el.appendChild(toast);
  setTimeout(() => toast.classList.add('show'), 10);
  setTimeout(() => { toast.classList.remove('show'); setTimeout(() => toast.remove(), 300); }, 3000);
}

function loading(show) {
  const el = document.getElementById('global-loading');
  if (el) el.style.display = show ? 'flex' : 'none';
}

/** Sanitiza string de placa para exibição */
function formatPlaca(p) {
  return (p || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}
