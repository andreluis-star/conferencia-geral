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
const SHEET_ID = '11ZwvJoxw94lJFZa_ZHyZPI3xmcW87_fYry576EoqHZM';

/** Retorna a data de hoje no formato DD/MM/AAAA (nome das abas) */
function getTodayTabName() {
  const d  = new Date();
  const dd = String(d.getDate()).padStart(2, '0');
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  return `${dd}/${mm}/${d.getFullYear()}`;
}

/** Busca os veículos de uma aba específica do Google Sheets.
 *  Tenta 3 formas de encoding do nome da aba para garantir compatibilidade. */
async function fetchSheetVehicles(tabName) {
  const candidateUrls = [
    `https://docs.google.com/spreadsheets/d/${SHEET_ID}/gviz/tq?tqx=out:json&sheet=${tabName}`,
    `https://docs.google.com/spreadsheets/d/${SHEET_ID}/gviz/tq?tqx=out:json&sheet=${encodeURIComponent(tabName)}`,
    `https://docs.google.com/spreadsheets/d/${SHEET_ID}/gviz/tq?tqx=out:json&sheet=${tabName.replace(/\//g, '%2F')}`,
  ];

  let json = null;
  for (const url of candidateUrls) {
    try {
      const resp = await fetch(url);
      const text = await resp.text();
      const start = text.indexOf('{');
      const end   = text.lastIndexOf('}');
      if (start === -1) continue;
      const parsed = JSON.parse(text.substring(start, end + 1));
      if (parsed.status === 'error') continue;
      if (parsed.table && parsed.table.rows && parsed.table.rows.length > 0) {
        json = parsed; break;
      }
    } catch(e) { continue; }
  }

  if (!json) return [];

  const cols = json.table.cols.map(c => (c.label || '').trim());
  const placaColIdx = cols.findIndex(c => c.toLowerCase() === 'placa');
  const vehicles = [];

  json.table.rows.forEach((row, rowIdx) => {
    if (!row.c) return;
    const obj = { _rowIdx: rowIdx };
    cols.forEach((col, i) => {
      const cell = row.c[i];
      obj[col] = cell && cell.v !== null && cell.v !== undefined ? String(cell.v).trim() : '';
    });
    // Localiza a placa de forma robusta
    const placaCell = placaColIdx >= 0 ? row.c[placaColIdx] : null;
    const placa = (placaCell && placaCell.v ? String(placaCell.v) : obj['Placa'] || '').trim();
    if (placa && placa.length >= 3) {
      obj['Placa'] = placa;
      obj._operationType = getOperationType(obj);
      vehicles.push(obj);
    }
  });

  return vehicles;
}

/**
 * Determina o tipo de operação baseado nas colunas da planilha.
 * COLETA   → ENTRADA
 * ENTREGA  → SAIDA
 * EMBARQUE → SAIDA
 */
function getOperationType(row) {
  const servico = (row['Serviço'] || row['Servico'] || '').toUpperCase().trim();
  if (servico === 'COLETA')   return 'ENTRADA';
  if (servico === 'ENTREGA')  return 'SAIDA';
  if (servico === 'EMBARQUE') return 'SAIDA';

  // fallback: analisa quais colunas de data têm valor
  const temColeta  = !!(row['Coleta']  && row['Coleta'].trim());
  const temEntrega = !!(row['Entrega'] && row['Entrega'].trim());
  if (temColeta && temEntrega) return 'ENTRADA_SAIDA';
  if (temEntrega) return 'SAIDA';
  return 'ENTRADA';
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
