// ============================================================
//  CONFERÊNCIA GERAL — Leitura da programação (planilha do dia)
//  Compartilhado por conferente.html, bipador.html e admin.html.
//  Depende de firebase-config.js (formatPlaca).
// ============================================================

// ═══════════════════════════════════════════════════════
//  FILTROS DE PLACA E LINHA
// ═══════════════════════════════════════════════════════
function isValidPlate(str) {
  const p = (str||'').replace(/[\s\-]/g,'').toUpperCase();
  // Formato antigo: ABC1234 | Mercosul: ABC1D23
  return /^[A-Z]{3}(\d{4}|\d[A-Z]\d{2})$/.test(p);
}

/** Retorna array com placas válidas extraídas de uma célula (suporta "ABC1234/DEF5678" ou "ABC1234 DEF5678") */
function extractPlates(raw) {
  return (raw||'').toString().split(/[\s\/]+/)
    .map(p => formatPlaca(p.trim()))
    .filter(p => p && isValidPlate(p));
}

/** true = linha deve ser descartada */
function shouldSkipRow(v) {
  const norm = s => (s||'').toString().toUpperCase()
    .normalize('NFD').replace(/[̀-ͯ]/g,'').trim();
  const colA    = norm(v['Coleta/Entrega/processo/cliente'] || v['_CA'] || '');
  const opType  = norm(v._operationType || '');
  const SKIP    = ['FECHAR','NAO CONTRATADO','N/CONTRATADO','N CONTRATADO','NAO CONTR'];
  return SKIP.some(w => colA.includes(w) || opType.includes(w));
}

/** true = grupo tem pelo menos uma linha com dados de NF */
function groupHasNfData(vehicles) {
  return vehicles.some(v => {
    const dest = (v['Destinatário']||v['Destinatario']||v['_CH']||'').toString().trim();
    const nf   = (v['NF']||v['Nº NF']||v['_CM']||'').toString().trim();
    const vol  = (v['Volume']||v['_CE']||'').toString().trim();
    const cid  = (v['Cidade Destino']||v['_CL']||'').toString().trim();
    return !!(dest || nf || vol || cid);
  });
}

/** true = grupo tem pelo menos uma linha com MOTORISTA (coluna B) preenchido */
function groupHasMotorista(vehicles) {
  return vehicles.some(v => (v['Motorista']||v['_CB']||'').toString().trim());
}

/**
 * true = grupo deve ser exibido para conferência.
 * Regra: tem dados de NF OU tem motorista na coluna B.
 * (Isso inclui veículos de terceiro — ex.: linhas de "DEMANDAS TERCEIROS"
 *  com placa + motorista mas sem NF preenchida, como a placa SDR8H31.)
 */
function groupIsRelevant(vehicles) {
  return groupHasNfData(vehicles) || groupHasMotorista(vehicles);
}

// ═══════════════════════════════════════════════════════
//  GRUPOS VIRTUAIS — "JEM" e "AGENTES"
//  Essas duas "placas" não vêm da coluna Placa: são montadas a
//  partir de um marcador de texto na coluna A (ex.: "EMBARQUE JEM").
//  Regra: a partir da linha do marcador, as linhas seguintes
//  (sempre com "EMBARQUE" ou "ENTREGA" na coluna A) pertencem ao
//  grupo até a primeira linha vazia (o corte).
// ═══════════════════════════════════════════════════════
function _normVirtual(s) {
  return (s||'').toString().toUpperCase()
    .normalize('NFD').replace(/[̀-ͯ]/g,'').trim();
}

function _colAVirtual(v) {
  return _normVirtual(v['Coleta/Entrega/processo/cliente'] || v['_CA'] || '');
}

/** true = linha totalmente em branco (nenhuma coluna da planilha tem conteúdo) — corte do bloco */
function _linhaVaziaVirtual(v) {
  return !Object.keys(v).some(k => k.startsWith('_C') && (v[k]||'').toString().trim());
}

/**
 * Cards "virtuais" montados por marcador de texto na coluna A (não pela coluna Placa).
 * Cada um vira UM card único no dia, juntando todas as ocorrências do marcador.
 * A ordem importa só para o nome do card; os termos de todos são usados como corte.
 */
const _GRUPOS_VIRTUAIS = [
  { nome: 'JEM',         termos: ['EMBARQUE JEM'] },
  { nome: 'GRITSCH',     termos: ['EMBARQUE GRITSCH'] },
  { nome: 'MF EXPRESSO', termos: ['EMBARQUE MF EXPRESSO', 'EMBARQUE MF EXPRESS', 'EMBARQUE M.F. EXPRESSO', 'EMBARQUE M F EXPRESSO'] },
  { nome: 'AGENTES',     termos: ['EMBARQUE SETE LAGOAS', 'EMBARQUE SETE LAGOS', 'EMBARQUE 7 LAGOAS', 'EMBARQUE 7 LAGOS'] },
];
const _TODOS_TERMOS_MARCADOR = _GRUPOS_VIRTUAIS.flatMap(g => g.termos).map(t => _normVirtual(t));

/** A linha é um cabeçalho/marcador (texto na coluna A, sem dados de nota)? */
function _linhaEhMarcador(v, termosNorm) {
  const colA = _colAVirtual(v);
  if (!termosNorm.some(t => colA.includes(t))) return false;
  const temNota = ['Destinatário','Destinatario','NF','Volume','Cidade Destino'].some(k => (v[k] || '').toString().trim())
    || ['_CH','_CM','_CE','_CL'].some(k => (v[k] || '').toString().trim());
  return !temNota;
}

/** Índices (na lista de linhas) que são marcadores com algum dos termos buscados */
function _acharMarcadores(rows, termos) {
  const termosNorm = termos.map(_normVirtual);
  const idxs = [];
  rows.forEach((v, i) => { if (_linhaEhMarcador(v, termosNorm)) idxs.push(i); });
  return idxs;
}

// Marcadores de SEÇÃO que encerram um bloco de agente — a partir daqui já é outra
// parte da planilha (terceiros, operações da filial, lembretes, etc.).
const _CORTE_SECAO = ['DEMANDAS TERCEIROS', 'OPERACOES FILIAL', 'LEMBRETES', 'CARGAS NA BASE'];

/** A partir de um índice de marcador, coleta as linhas seguintes até a primeira linha vazia (corte) */
function _coletarBloco(rows, idxMarcador) {
  const bloco = [];
  let rowIdxAnterior = rows[idxMarcador]?._rowIdx;
  for (let i = idxMarcador + 1; i < rows.length; i++) {
    const linha = rows[i];
    if (_linhaVaziaVirtual(linha)) break;                     // corte: linha totalmente vazia
    // Corte: "pulo" no índice real da planilha — indica linha(s) em branco que o
    // Google Sheets às vezes omite por completo da resposta (não aparecem em `rows`).
    if (rowIdxAnterior !== undefined && linha._rowIdx !== undefined && (linha._rowIdx - rowIdxAnterior) > 1) break;
    // Corte: chegou numa nova seção (ex.: "DEMANDAS TERCEIROS") — o bloco do agente acabou.
    const colA = _colAVirtual(linha);
    if (_CORTE_SECAO.some(t => colA.includes(t))) break;
    // Corte: começou o bloco de OUTRO agente (ex.: "EMBARQUE MF EXPRESSO" logo abaixo do GRITSCH)
    if (_linhaEhMarcador(linha, _TODOS_TERMOS_MARCADOR)) break;
    rowIdxAnterior = linha._rowIdx;
    // Linha com PLACA PRÓPRIA é veículo real (inclui terceiros) — não pertence ao
    // grupo de agente: fica de fora do bloco para virar card próprio no agrupamento normal.
    if (extractPlates(linha['Placa'] || linha['_CC'] || '').length) continue;
    // Linhas só de texto dentro do bloco (ex.: "17horas", "NAO EMBARCADO ONTEM JEM") não são notas
    if (!groupHasNfData([linha])) continue;
    bloco.push(linha);
  }
  return bloco;
}

function _montarGrupoVirtual(nomePlaca, vehicles) {
  const tipos = [...new Set(vehicles.map(v => v._operationType))];
  let tipo;
  if (tipos.length > 1 || tipos[0] === 'ENTRADA_SAIDA') tipo = 'ENTRADA_SAIDA';
  else tipo = tipos[0] || 'ENTRADA';
  return { placa: nomePlaca, tipo, vehicles };
}

/**
 * Monta os grupos virtuais "JEM" e "AGENTES" a partir dos marcadores de texto
 * na coluna A. "AGENTES" combina os blocos de GRITSCH e de SETE LAGOAS/7 LAGOAS
 * quando ambos existirem na planilha do dia.
 */
function extrairGruposVirtuais(rows) {
  const grupos = [];
  // JEM, GRITSCH, MF EXPRESSO e AGENTES (Sete Lagoas): cada um é um card único,
  // somando todas as vezes que o marcador aparece na planilha do dia.
  _GRUPOS_VIRTUAIS.forEach(g => {
    const veiculos = [];
    const jaUsadas = new Set();
    _acharMarcadores(rows, g.termos).forEach(idx => {
      _coletarBloco(rows, idx).forEach(v => {
        if (jaUsadas.has(v._rowIdx)) return;
        jaUsadas.add(v._rowIdx);
        veiculos.push(v);
      });
    });
    if (veiculos.length) grupos.push(_montarGrupoVirtual(g.nome, veiculos));
  });
  return grupos;
}

/** Lê coluna por nome(s) ou, se vazio, pela letra (mesma regra da tela de NFs). */
function _colConf(v, letter, ...names) {
  for (const c of names) {
    if (v[c] && v[c].toString().trim()) return v[c].toString().trim();
    const k = Object.keys(v).find(key => !key.startsWith('_') && key.trim().toLowerCase() === c.toLowerCase());
    if (k && v[k] && v[k].toString().trim()) return v[k].toString().trim();
  }
  return (v['_C' + letter.toUpperCase()] || '').toString().trim();
}

/** Dados de uma linha da planilha usados na lista de NFs e no resumo do bloco. */
function _dadosLinhaNf(v, idx) {
  const d = {
    nf:      _colConf(v, 'M', 'NF', 'Nº NF'),
    di:      _colConf(v, 'N', 'DI/Cotação / R$ / Prazo', 'DI/Cotação', 'DI'),
    oc:      _colConf(v, 'Q', 'OC'),
    md:      _colConf(v, 'R', 'MD'),
    dest:    _colConf(v, 'H', 'Destinatário', 'Destinatario'),
    cidade:  _colConf(v, 'L', 'Cidade Destino'),
    vol:     _colConf(v, 'E', 'Volume'),
    servico: _colConf(v, 'O', 'Serviço', 'Servico'),
  };
  d.relevante = !!(d.nf || d.di || d.oc || d.md || d.dest || d.cidade || d.vol);
  d.tituloOp = _colConf(v, 'A', 'Coleta/Entrega/processo/cliente') || (d.nf ? `NF ${d.nf}` : `Entrega ${idx+1}`);
  return d;
}

function _tipoLinha(v) { return (v._operationType === 'SAIDA') ? 'SAIDA' : 'ENTRADA'; }

/** Tipos presentes no grupo (ENTRADA primeiro). */
function _tiposDoGrupo(group) {
  const set = new Set((group.vehicles || []).map(_tipoLinha));
  if (!set.size) set.add(group.tipo === 'SAIDA' ? 'SAIDA' : 'ENTRADA');
  return ['ENTRADA', 'SAIDA'].filter(t => set.has(t));
}

function _numVolume(s) {
  const n = parseFloat(String(s || '').replace(/\./g, '').replace(',', '.').replace(/[^\d.]/g, ''));
  return isNaN(n) ? 0 : n;
}

/** Resumo do bloco: nº de NFs, volumes e clientes das linhas daquele tipo. */
function _resumoBloco(vehicles, tipo) {
  let nfs = 0, vol = 0;
  const clientes = new Set();
  vehicles.forEach((v, idx) => {
    if (_tipoLinha(v) !== tipo) return;
    const d = _dadosLinhaNf(v, idx);
    if (!d.relevante) return;
    nfs++;
    vol += _numVolume(d.vol);
    const c = (v._cliente || d.dest || '').trim().toUpperCase();
    if (c) clientes.add(c);
  });
  return { nfs, vol, clientes: [...clientes] };
}

/**
 * Agrupa as linhas da planilha do dia em veículos (placa ou grupo virtual).
 * Mesma regra que a tela de placas do conferente sempre usou.
 */
function agruparProgramacao(sheetVehicles) {
  // ── Grupos virtuais JEM / AGENTES (marcador de texto na coluna A) ──
  const gruposVirtuais = extrairGruposVirtuais(sheetVehicles)
    .filter(g => groupHasNfData(g.vehicles));
  const idxUsadosVirtual = new Set();
  gruposVirtuais.forEach(g => g.vehicles.forEach(v => {
    if (v._rowIdx !== undefined) idxUsadosVirtual.add(v._rowIdx);
  }));

  // ── Agrupa por placa (com filtros) ──
  const map = {};
  sheetVehicles.forEach(v => {
    if (idxUsadosVirtual.has(v._rowIdx)) return;      // já usada em JEM/AGENTES
    if (shouldSkipRow(v)) return;                    // FECHAR / NÃO CONTRATADO
    const plates = extractPlates(v['Placa']||'');   // suporta dupla placa
    if (!plates.length) return;                      // sem placa válida
    const key = plates.join('/');                    // ex.: "ABC1234/DEF5678" ou "ABC1234"
    if (!map[key]) map[key] = [];
    map[key].push(v);
  });

  const grupos = Object.entries(map)
    .map(([placa, vehicles]) => {
      const tipos = [...new Set(vehicles.map(v=>v._operationType))];
      let tipo;
      if (tipos.length > 1 || tipos[0]==='ENTRADA_SAIDA') tipo='ENTRADA_SAIDA';
      else tipo = tipos[0] || 'ENTRADA';
      return { placa, tipo, vehicles };
    })
    .filter(g => groupIsRelevant(g.vehicles));       // mantém grupos com NF OU com motorista (inclui terceiros)

  // Adiciona JEM / AGENTES junto com as placas normais
  grupos.push(...gruposVirtuais);
  return grupos;
}

// ═══════════════════════════════════════════════════════
//  NOTAS E VOLUMES (bipagem)
// ═══════════════════════════════════════════════════════

/** Números de um campo (NF "7686 / 2422" → ["7686","2422"]; zeros à esquerda saem). */
function tokensDoc(s) {
  return String(s || '').toUpperCase().split(/[\s\/;,|-]+/).map(t => t.trim()).filter(Boolean)
    .map(t => /^\d+$/.test(t) ? String(+t) : t);
}

/** Chave estável da nota (não muda se a planilha ganhar linhas novas). */
function chaveNf(d) {
  const base = [d.nf, d.md, d.oc, d.di, d.dest, d.tituloOp].join('|').toUpperCase();
  let h = 0; for (let i = 0; i < base.length; i++) h = (h * 31 + base.charCodeAt(i)) | 0;
  return 'k' + (h >>> 0).toString(36);
}

/** Notas de um veículo num tipo (ENTRADA/SAIDA): [{ idx, k, esp, docs, rot, dest, cidade, nf }] */
function notasParaBipagem(vehicles, tipo) {
  const out = [];
  vehicles.forEach((v, idx) => {
    if (_tipoLinha(v) !== tipo) return;
    const d = _dadosLinhaNf(v, idx);
    if (!d.relevante) return;
    out.push({
      idx, k: chaveNf(d), esp: Math.round(_numVolume(d.vol)) || 0,
      docs: [...new Set([d.nf, d.md, d.oc, d.di].flatMap(tokensDoc).filter(t => /\d/.test(t)))],
      rot: d.nf ? `NF ${d.nf}` : d.md ? `MD ${d.md}` : d.oc ? `OC ${d.oc}` : d.tituloOp,
      dest: d.dest || '', cidade: d.cidade || '', nf: d.nf || d.md || d.oc || d.di || ''
    });
  });
  return out;
}

/** Dígito verificador da chave de acesso da NF-e (44 dígitos). */
function chaveNfeValida(ch) {
  if (!/^\d{44}$/.test(ch)) return false;
  let p = 2, s = 0; for (let i = 42; i >= 0; i--) { s += +ch[i] * p; p = p === 9 ? 2 : p + 1; }
  const r = s % 11; return (r < 2 ? 0 : 11 - r) === +ch[43];
}

/**
 * Lê um código bipado:
 *  { tipo:'QR', num, vol, de }  etiqueta do sistema NF:x;VOL:i/n (de = n; null se a etiqueta é "1 por nota")
 *  { tipo:'CHAVE', num }        chave da DANFE
 *  { tipo:'NUMERO', num }       número puro (NF / MD / OC)
 *  { tipo:'OUTRO' }             etiqueta do cliente, EAN…
 */
function interpretarCodigo(raw) {
  const cod = String(raw || '').replace(/[\x00-\x1F]/g, '').trim().toUpperCase();
  // Etiqueta do sistema: NF:<doc>;VOL:<i>/<n>. Aceita também o texto que chega com o
  // leitor em outro layout de teclado (ex.: ":" vira "Ç", ";" vira "ç", "/" vira ";").
  const qr = cod.match(/^(NF|MD|OC|PROC|DI|NFE)[\s:Ç?]*(.+?)[\s;Ç]+VOL[\s:Ç?]*(\d*)(?:\s*[\/;\-Q]\s*(\d+))?\s*$/);
  if (qr) {
    const num = tokensDoc(qr[2]).find(t => /\d/.test(t)) || qr[2].trim();
    const vol = qr[3] || '', de = qr[4] || null;
    // código padronizado: a mesma etiqueta vira o mesmo texto em qualquer leitor
    return { cod: `${qr[1]}:${num};VOL:${vol}${de ? '/' + de : ''}`, bruto: cod, tipo: 'QR', num, vol, de };
  }
  const dig = cod.replace(/\D/g, '');
  if (dig.length === 44 && cod.replace(/[\s.]/g, '').length === 44 && chaveNfeValida(dig))
    return { cod, tipo: 'CHAVE', num: String(+dig.substr(25, 9)) };
  if (/^\d{3,9}$/.test(cod)) return { cod, tipo: 'NUMERO', num: String(+cod) };
  return { cod, tipo: 'OUTRO' };
}

/** Dia (AAAA-MM-DD) → nome da aba da planilha (DD/MM/AAAA). */
function abaDoDia(diaIso) { const [y, m, d] = diaIso.split('-'); return `${d}/${m}/${y}`; }

/** Hoje em AAAA-MM-DD no fuso do aparelho. */
function hojeIso() { const t = new Date(); return new Date(t.getTime() - t.getTimezoneOffset() * 60000).toISOString().slice(0, 10); }
