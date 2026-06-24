// ============================================================
//  CONFERÊNCIA GERAL — Configuração Firebase
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

if (!firebase.apps.length) { firebase.initializeApp(FIREBASE_CONFIG); }
const auth = firebase.auth();
const db   = firebase.firestore();

const SHEET_ID = '11ZwvJoxw94lJFZa_ZHyZPI3xmcW87_fYry576EoqHZM';

function getTodayTabName() {
  const d = new Date();
  return String(d.getDate()).padStart(2,'0')+'/'+String(d.getMonth()+1).padStart(2,'0')+'/'+d.getFullYear();
}

async function fetchSheetVehicles(tabName) {
  const jsonUrl = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/gviz/tq?tqx=out:json&sheet=${encodeURIComponent(tabName)}`;
  const csvUrl  = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/gviz/tq?tqx=out:csv&sheet=${encodeURIComponent(tabName)}`;

  try {
    const resp = await fetch(jsonUrl);
    const text = await resp.text();
    window._lastSheetRaw = text.substring(0, 500);
    const start = text.indexOf('{'), end = text.lastIndexOf('}');
    if (start !== -1) {
      const parsed = JSON.parse(text.substring(start, end + 1));
      if (parsed.table && parsed.table.rows) {
        const result = parseGvizTable(parsed.table);
        if (result.length > 0) return result;
      }
    }
  } catch(e) { console.warn('JSON falhou:', e.message); }

  try {
    const resp = await fetch(csvUrl);
    const text = await resp.text();
    window._lastSheetRaw = text.substring(0, 500);
    return parseCsv(text);
  } catch(e) { console.warn('CSV falhou:', e.message); }

  return [];
}

function parseGvizTable(table) {
  const cols = table.cols.map(c => (c.label || '').trim());
  const placaIdx = cols.findIndex(c => c.toLowerCase() === 'placa');
  const vehicles = [];
  (table.rows || []).forEach((row, i) => {
    if (!row.c) return;
    const obj = { _rowIdx: i };
    cols.forEach((col, j) => { const cell = row.c[j]; obj[col] = cell && cell.v != null ? String(cell.v).trim() : ''; });
    const placa = (placaIdx >= 0 && row.c[placaIdx]?.v ? String(row.c[placaIdx].v) : obj['Placa'] || '').trim();
    if (placa.length >= 3) { obj['Placa'] = placa; obj._operationType = getOperationType(obj); vehicles.push(obj); }
  });
  return vehicles;
}

function parseCsv(text) {
  const lines = text.trim().split('\n');
  if (lines.length < 2) return [];
  const headers = lines[0].split(',').map(h => h.replace(/^"|"$/g,'').trim());
  const placaIdx = headers.findIndex(h => h.toLowerCase() === 'placa');
  if (placaIdx < 0) return [];
  const vehicles = [];
  for (let i = 1; i < lines.length; i++) {
    const cells = lines[i].split(',').map(c => c.replace(/^"|"$/g,'').trim());
    const placa = cells[placaIdx] || '';
    if (placa.length < 3) continue;
    const obj = { _rowIdx: i };
    headers.forEach((h, idx) => { obj[h] = cells[idx] || ''; });
    obj['Placa'] = placa; obj._operationType = getOperationType(obj); vehicles.push(obj);
  }
  return vehicles;
}

function getOperationType(row) {
  const servico = (row['Serviço'] || row['Servico'] || '').toUpperCase().trim();
  if (servico === 'COLETA')   return 'ENTRADA';
  if (servico === 'ENTREGA')  return 'SAIDA';
  if (servico === 'EMBARQUE') return 'SAIDA';
  const temColeta  = !!(row['Coleta']  && row['Coleta'].trim());
  const temEntrega = !!(row['Entrega'] && row['Entrega'].trim());
  if (temColeta && temEntrega) return 'ENTRADA_SAIDA';
  if (temEntrega) return 'SAIDA';
  return 'ENTRADA';
}

const INSUMOS_PADRAO = [
  { nome: 'Palete (PBR)',             categoria: 'Palete',    unidade: 'un'   },
  { nome: 'Palete (Descartáveis)',    categoria: 'Palete',    unidade: 'un'   },
  { nome: 'Palete (Outros)',          categoria: 'Palete',    unidade: 'un'   },
  { nome: 'Fita Transparente',        categoria: 'Embalagem', unidade: 'rolo' },
  { nome: 'Fita Paletizadora',        categoria: 'Embalagem', unidade: 'rolo' },
  { nome: 'Stretch Transparente',     categoria: 'Embalagem', unidade: 'rolo' },
  { nome: 'Stretch Verde',            categoria: 'Embalagem', unidade: 'rolo' },
  { nome: 'Lona Preta',               categoria: 'Proteção',  unidade: 'm²'   },
  { nome: 'Etiquetas Brancas 750un',  categoria: 'Etiqueta',  unidade: 'cx'   },
  { nome: 'Etiquetas Brancas 1000un', categoria: 'Etiqueta',  unidade: 'cx'   },
  { nome: 'Etiquetas Laranja 750un',  categoria: 'Etiqueta',  unidade: 'cx'   },
  { nome: 'Etiquetas Laranja 1000un', categoria: 'Etiqueta',  unidade: 'cx'   },
];

async function initInsumosPadrao() {
  const snap = await db.collection('insumos').limit(1).get();
  if (!snap.empty) return;
  const batch = db.batch();
  INSUMOS_PADRAO.forEach(ins => { const ref = db.collection('insumos').doc(); batch.set(ref, { ...ins, saldo:0, saldoInicial:0, dataInicio:null, ativo:true, criadoEm:firebase.firestore.FieldValue.serverTimestamp() }); });
  await batch.commit();
}

async function getCurrentUserData() {
  const user = auth.currentUser;
  if (!user) return null;
  try { const doc = await db.collection('users').doc(user.uid).get(); return doc.exists ? { ...doc.data(), uid: user.uid, email: user.email } : null; } catch { return null; }
}

function redirectByRole(userData) {
  if (!userData) { window.location.href = 'index.html'; return; }
  const base = window.location.href.replace(/\/[^\/]*$/, '/');
  if (userData.role === 'admin')      window.location.href = base + 'admin.html';
  if (userData.role === 'conferente') window.location.href = base + 'conferente.html';
}

async function createConferente(nome, email, senha) {
  const secondaryApp = firebase.initializeApp(FIREBASE_CONFIG, 'secondary_' + Date.now());
  const secondaryAuth = secondaryApp.auth();
  try {
    const cred = await secondaryAuth.createUserWithEmailAndPassword(email, senha);
    await db.collection('users').doc(cred.user.uid).set({ nome, email, role:'conferente', ativo:true, criadoEm:firebase.firestore.FieldValue.serverTimestamp() });
    return { ok: true, uid: cred.user.uid };
  } catch(e) { return { ok: false, error: e.message }; }
  finally { await secondaryAuth.signOut(); await secondaryApp.delete(); }
}

function fmtDate(ts) { if (!ts) return '—'; const d = ts.toDate ? ts.toDate() : new Date(ts); return d.toLocaleDateString('pt-BR')+' '+d.toLocaleTimeString('pt-BR',{hour:'2-digit',minute:'2-digit'}); }
function fmtDateOnly(ts) { if (!ts) return '—'; const d = ts.toDate ? ts.toDate() : new Date(ts); return d.toLocaleDateString('pt-BR'); }
function showToast(msg, tipo='success') { const el=document.getElementById('toast-container'); if(!el)return; const t=document.createElement('div'); t.className=`toast-msg toast-${tipo}`; t.textContent=msg; el.appendChild(t); setTimeout(()=>t.classList.add('show'),10); setTimeout(()=>{t.classList.remove('show');setTimeout(()=>t.remove(),300);},3000); }
function loading(show) { const el=document.getElementById('global-loading'); if(el) el.style.display=show?'flex':'none'; }
function formatPlaca(p) { return (p||'').toUpperCase().replace(/[^A-Z0-9]/g,''); }
