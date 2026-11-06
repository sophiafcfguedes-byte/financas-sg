// Finanças SG — servidor pessoal (sem dependências externas)
// Uso: FIN_PIN=1234 PORT=3001 node server.js
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = Number(process.env.PORT || 3001);
const PIN = String(process.env.FIN_PIN || '');
const DATA_DIR = process.env.FIN_DATA || path.join(__dirname, 'data');
const DATA_FILE = path.join(DATA_DIR, 'financas.json');
const PUBLIC = path.join(__dirname, 'public');

if (!PIN) { console.error('Defina FIN_PIN (ex.: FIN_PIN=123456 node server.js)'); process.exit(1); }
fs.mkdirSync(DATA_DIR, { recursive: true });

// Segredo para assinar a sessão (gerado uma vez e guardado junto dos dados)
const SECRET_FILE = path.join(DATA_DIR, '.secret');
if (!fs.existsSync(SECRET_FILE)) fs.writeFileSync(SECRET_FILE, crypto.randomBytes(32).toString('hex'), { mode: 0o600 });
const SECRET = fs.readFileSync(SECRET_FILE, 'utf8').trim();

const COLLECTIONS = ['entradas', 'fixas', 'gastos', 'parceladas', 'boletos', 'reserva'];
const EMPTY = {
  config: { renda: 0, pctEssenciais: 50, pctLivre: 25 },
  entradas: [], fixas: [], gastos: [], parceladas: [], boletos: [], reserva: [],
  pagos: {} // { "2026-11": ["idDaFixa", ...] }
};

function loadReal() {
  try { return Object.assign(structuredClone(EMPTY), JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'))); }
  catch { return structuredClone(EMPTY); }
}
function saveReal(db) {
  const tmp = DATA_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(db, null, 2));
  fs.renameSync(tmp, DATA_FILE);
  // cópia de segurança diária
  const bk = path.join(DATA_DIR, 'backup-' + new Date().toISOString().slice(0, 10) + '.json');
  if (!fs.existsSync(bk)) fs.copyFileSync(DATA_FILE, bk);
}

// ---- sessão ----
function sign(v) { return crypto.createHmac('sha256', SECRET).update(v).digest('hex'); }
// sessão: "me" = você; "demo-xxxx" = visitante vendo só a interface com dados de exemplo
function makeToken(quem = 'me') { const exp = Date.now() + 1000 * 60 * 60 * 24 * 60; return quem + '.' + exp + '.' + sign(quem + '.' + exp); }
function validToken(t) {
  if (!t) return null;
  let parts = t.split('.'); if (parts.length === 2) parts = ['', ...parts]; // sessões antigas
  const [quem, exp, sig] = parts;
  if (!exp || !sig || Number(exp) < Date.now()) return null;
  const good = sign(quem ? quem + '.' + exp : exp);
  if (!(sig.length === good.length && crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(good)))) return null;
  return quem || 'me';
}
const DEMO_PIN = String(process.env.FIN_DEMO_PIN || '0000');
const demos = new Map(); // sessão de visitante -> dados de exemplo (só na memória)
function dadosExemplo() {
  const m = new Date().toISOString().slice(0, 7), d = n => m + '-' + String(n).padStart(2, '0');
  const id = () => crypto.randomUUID().slice(0, 12);
  const db = structuredClone(EMPTY);
  db.entradas = [{ id: id(), desc: 'Salário', valor: 6500, data: d(5) }, { id: id(), desc: 'Freela', valor: 1800, data: d(15) }];
  db.fixas = [['Aluguel', 2200], ['Condomínio', 650], ['Internet', 120], ['Celular', 60], ['Academia', 140]].map(([nome, valor]) => ({ id: id(), nome, valor, dia: 1, categoria: 'Casa' }));
  db.gastos = [['Supermercado', 412.35, 'Mercado', 3], ['iFood', 58.9, 'Delivery', 4], ['Farmácia', 87.5, 'Saúde', 6], ['Netflix', 55.9, 'Assinaturas', 7], ['Bar com amigos', 132, 'Bares', 8], ['Posto', 220, 'Carro', 10], ['Loja de roupas', 289.9, 'Compras', 11], ['Passagem aérea', 780, 'Viagem', 12], ['Presente', 95, 'Compras', 13]]
    .map(([desc, valor, categoria, dia]) => ({ id: id(), desc, valor, data: d(dia), categoria, forma: 'Cartão' }));
  db.parceladas = [{ id: id(), desc: 'Notebook', valorParcela: 350, total: 10, primeiroMes: m, categoria: 'Compras' }];
  db.boletos = [{ id: id(), desc: 'Conta de luz', valor: 168.4, venc: d(12), codigo: '', pago: false }, { id: id(), desc: 'Água', valor: 74.2, venc: d(18), codigo: '', pago: false }];
  db.reserva = [{ id: id(), mes: m, valor: 1200, nota: 'CDB' }];
  return db;
}
function cookie(req, name) {
  const m = (req.headers.cookie || '').split(';').map(s => s.trim()).find(s => s.startsWith(name + '='));
  return m ? decodeURIComponent(m.slice(name.length + 1)) : null;
}

// trava simples contra tentativas de PIN
const fails = new Map();
function blocked(ip) { const f = fails.get(ip); return f && f.n >= 5 && Date.now() - f.t < 15 * 60 * 1000; }
function fail(ip) { const f = fails.get(ip) || { n: 0, t: 0 }; f.n++; f.t = Date.now(); fails.set(ip, f); }

// ---- utilidades ----
function send(res, code, obj, headers = {}) {
  res.writeHead(code, Object.assign({ 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }, headers));
  res.end(JSON.stringify(obj));
}
function body(req) {
  return new Promise((ok, bad) => {
    let s = '';
    req.on('data', c => { s += c; if (s.length > 1e6) { bad(new Error('grande demais')); req.destroy(); } });
    req.on('end', () => { try { ok(s ? JSON.parse(s) : {}); } catch (e) { bad(e); } });
  });
}
const num = v => { let t = String(v ?? '').trim(); if (t.includes(',')) t = t.replace(/\./g, '').replace(',', '.'); const n = Number(t); return Number.isFinite(n) ? Math.round(n * 100) / 100 : 0; };
const str = (v, max = 120) => String(v ?? '').slice(0, max);
const ym = v => /^\d{4}-\d{2}$/.test(v) ? v : new Date().toISOString().slice(0, 7);
const ymd = v => /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : new Date().toISOString().slice(0, 10);

// limpa e valida cada tipo de registro
const CLEAN = {
  entradas: b => ({ desc: str(b.desc, 60), valor: num(b.valor), data: ymd(b.data) }),
  fixas: b => ({ nome: str(b.nome), valor: num(b.valor), boleto: !!b.boleto, dia: Math.min(31, Math.max(1, parseInt(b.dia) || 1)), categoria: str(b.categoria || 'Casa', 40) }),
  gastos: b => ({ desc: str(b.desc), valor: num(b.valor), data: ymd(b.data), categoria: str(b.categoria || '', 40), forma: str(b.forma || 'Pix', 20), fonte: str(b.fonte, 10), chave: str(b.chave, 300), catManual: !!b.catManual, dividido: !!b.dividido, mes: /^\d{4}-\d{2}$/.test(b.mes) ? b.mes : undefined }),
  parceladas: b => ({ desc: str(b.desc), valorParcela: num(b.valorParcela), total: Math.max(1, parseInt(b.total) || 1), primeiroMes: ym(b.primeiroMes), categoria: str(b.categoria || 'Compras', 40), dividido: !!b.dividido }),
  boletos: b => ({ desc: str(b.desc), valor: num(b.valor), venc: ymd(b.venc), codigo: str(b.codigo, 80), pago: !!b.pago, fonte: str(b.fonte, 10), msgId: str(b.msgId, 200), aviso: '', ehFatura: !!b.ehFatura }),
  reserva: b => ({ mes: ym(b.mes), valor: num(b.valor), nota: str(b.nota, 80) })
};

const load = loadReal, save = saveReal;
// compra parcelada cadastrada à mão com o mesmo nome de um lançamento: copia o valor do lançamento
const normTit = t => String(t || '').replace(/\s*\(\d+\/\d+\)\s*$/, '').toUpperCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^A-Z0-9]/g, '');
function lancamentoDe(db, p) {
  const n = normTit(p.desc); if (n.length < 3) return null;
  const cands = db.gastos.filter(g => { const t = normTit(g.desc); return t && (t === n || (n.length >= 4 && t.length >= 4 && (t.includes(n) || n.includes(t)))); });
  return cands.sort((a, b) => ((b.mes || b.data) > (a.mes || a.data) ? 1 : -1))[0] || null;
}
function sincronizarParcelas(db) {
  let mudou = false;
  for (const p of db.parceladas || []) { const g = lancamentoDe(db, p); if (g && g.valor !== p.valorParcela) { p.valorParcela = g.valor; mudou = true; } }
  return mudou;
}
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/manifest+json', '.webmanifest': 'application/manifest+json' };

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;
  const ip = req.headers['x-forwarded-for']?.split(',')[0].trim() || req.socket.remoteAddress;

  try {
    // ---- login ----
    if (p === '/api/login' && req.method === 'POST') {
      if (blocked(ip)) return send(res, 429, { erro: 'Muitas tentativas. Espere 15 minutos.' });
      const b = await body(req);
      const igual = (a, b) => a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
      const pin = String(b.pin || '');
      const quem = igual(pin, PIN) ? 'me' : (DEMO_PIN && DEMO_PIN !== PIN && igual(pin, DEMO_PIN)) ? 'demo-' + crypto.randomBytes(8).toString('hex') : null;
      if (!quem) { fail(ip); return send(res, 401, { erro: 'PIN incorreto' }); }
      fails.delete(ip);
      const secure = req.headers['x-forwarded-proto'] === 'https' ? '; Secure' : '';
      return send(res, 200, { ok: true }, { 'Set-Cookie': `fin=${makeToken(quem)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${60 * 60 * 24 * (quem === 'me' ? 60 : 1)}${secure}` });
    }
    if (p === '/api/logout') return send(res, 200, { ok: true }, { 'Set-Cookie': 'fin=; Path=/; Max-Age=0' });

    // ---- API protegida ----
    if (p.startsWith('/api/')) {
      const quem = validToken(cookie(req, 'fin'));
      if (!quem) return send(res, 401, { erro: 'login' });
      const demo = quem.startsWith('demo-');
      if (demo && !demos.has(quem)) { if (demos.size > 200) demos.clear(); demos.set(quem, dadosExemplo()); }
      const load = demo ? () => demos.get(quem) : loadReal, save = demo ? d => demos.set(quem, d) : d => { sincronizarParcelas(d); saveReal(d); };
      const comFlag = d => Object.assign(d, { gmailLigado: !demo && !!(GMAIL_USER && GMAIL_PASS), demo });
      const db = load();
      if (demo && req.method !== 'GET' && !p.startsWith('/api/gmail') && !p.startsWith('/api/icon')) return send(res, 403, { erro: 'Modo demonstração: só para visualização' });
      const parts = p.split('/').filter(Boolean); // ['api', coll, id?]
      const coll = parts[1], id = parts[2];

      if (coll === 'state' && req.method === 'GET') { if (sincronizarParcelas(db)) save(db); return send(res, 200, comFlag(db)); }
      if (coll === 'gmail' && req.method === 'POST') { if (!demo) await rodarGmail(); return send(res, 200, comFlag(load())); }
      if (coll === 'icon' && demo) return send(res, 200, { ok: true });

      if (coll === 'config' && req.method === 'PUT') {
        const b = await body(req);
        // renda varia: guardada por mês
        db.rendas = db.rendas || {};
        if (db.config.renda && !Object.keys(db.rendas).length) db.rendas[new Date().toISOString().slice(0, 7)] = db.config.renda;
        db.rendas[ym(b.mes)] = num(b.renda);
        save(db); return send(res, 200, comFlag(db));
      }

      if (coll === 'icon' && req.method === 'POST') { // ícone desenhado no navegador com a fonte da logo
        const b = await body(req);
        for (const sz of ['180', '512']) {
          const m = /^data:image\/png;base64,([A-Za-z0-9+/=]+)$/.exec(String(b['png' + sz] || ''));
          if (m) fs.writeFileSync(path.join(DATA_DIR, `icon-${sz}.png`), Buffer.from(m[1], 'base64'));
        }
        return send(res, 200, { ok: true });
      }

      if (coll === 'tricount' && req.method === 'PUT') { // parte da Victoria no cartão, abate dos gastos do mês
        const b = await body(req); db.tricount = db.tricount || {}; db.tricount[ym(b.mes)] = num(b.valor);
        save(db); return send(res, 200, comFlag(db));
      }
      if (coll === 'pago' && req.method === 'POST') { // marca/desmarca fixa como paga no mês
        const b = await body(req); const mes = ym(b.mes);
        const lista = new Set(db.pagos[mes] || []);
        b.pago ? lista.add(str(b.id, 40)) : lista.delete(str(b.id, 40));
        db.pagos[mes] = [...lista]; save(db); return send(res, 200, comFlag(db));
      }

      if (COLLECTIONS.includes(coll)) {
        if (req.method === 'POST' && !id) {
          const item = Object.assign({ id: crypto.randomUUID().slice(0, 12) }, CLEAN[coll](await body(req)));
          db[coll].push(item); save(db); return send(res, 200, comFlag(db));
        }
        const i = db[coll].findIndex(x => x.id === id);
        if (i < 0) return send(res, 404, { erro: 'não encontrado' });
        if (req.method === 'PUT') {
          const antes = db[coll][i];
          db[coll][i] = Object.assign({ id }, CLEAN[coll](Object.assign({}, antes, await body(req))));
          if (coll === 'gastos' && antes.categoria !== db[coll][i].categoria) {
            db[coll][i].catManual = true;
            db.aprendido = db.aprendido || {}; db.aprendido[require('./gmail.js').normDesc(db[coll][i].desc.replace(/ \(\d+\/\d+\)$/, ''))] = db[coll][i].categoria;
          }
          save(db); return send(res, 200, comFlag(db));
        }
        if (req.method === 'DELETE' && coll === 'gastos') { // apagou o lançamento: some também da parcelada com o mesmo nome
          const n = normTit(db.gastos[i].desc);
          if (n.length >= 3) db.parceladas = db.parceladas.filter(p => { const t = normTit(p.desc); return !(t === n || (n.length >= 4 && t.length >= 4 && (t.includes(n) || n.includes(t)))); });
        }
        if (req.method === 'DELETE') { if (db[coll][i].chave) { db.removidos = db.removidos || []; db.removidos.push(db[coll][i].chave); } db[coll].splice(i, 1); save(db); return send(res, 200, comFlag(db)); }
      }
      return send(res, 404, { erro: 'rota desconhecida' });
    }

    // ---- arquivos do app ----
    if ((p === '/icon-180.png' || p === '/icon-512.png') && fs.existsSync(path.join(DATA_DIR, p.slice(1)))) {
      res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'max-age=3600' });
      return fs.createReadStream(path.join(DATA_DIR, p.slice(1))).pipe(res);
    }
    let f = path.normalize(path.join(PUBLIC, p === '/' ? 'index.html' : p));
    if (!f.startsWith(PUBLIC) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) f = path.join(PUBLIC, 'index.html');
    res.writeHead(200, { 'Content-Type': MIME[path.extname(f)] || 'application/octet-stream', 'Cache-Control': f.endsWith('.html') ? 'no-cache' : 'max-age=3600' });
    fs.createReadStream(f).pipe(res);
  } catch (e) {
    console.error(e);
    send(res, 400, { erro: 'pedido inválido' });
  }
});

// recategoriza compras da fatura que você não mudou à mão (quando as regras mudam)
function recategorizar() {
  const db = load(); const { categorizar } = require('./gmail.js'); let n = 0;
  for (const g of db.gastos) if (g.fonte === 'fatura' && !g.catManual) {
    const c = categorizar(g.desc.replace(/ \(\d+\/\d+\)$/, ''), db.aprendido || {}); if (c !== g.categoria) { g.categoria = c; n++; }
  }
  if (n) { save(db); console.log(`Categorias: ${n} compra(s) reclassificada(s)`); }
}
const CATS_OK = ['Compras', 'Mercado', 'Saúde', 'Assinaturas', 'Caio', 'Delivery', 'Viagem', 'Carro', 'Bares'];
const MAPA_CAT = { iFood: 'Delivery' };
function ajustarCategorias() {
  const db = load(); let n = 0;
  const fix = c => CATS_OK.includes(c) ? c : (MAPA_CAT[c] || '');
  for (const g of db.gastos) { const c = fix(g.categoria); if (c !== g.categoria) { g.categoria = c; n++; } }
  for (const p of db.parceladas) { const c = fix(p.categoria); if (c !== p.categoria) { p.categoria = c; n++; } }
  for (const k in db.aprendido || {}) db.aprendido[k] = fix(db.aprendido[k]);
  if (n) { save(db); console.log(`Categorias: ${n} ajustada(s) para a lista nova`); }
}
ajustarCategorias();
// compras da fatura contam no mês em que a fatura vence
(function mesDaFatura() {
  const db = load(); const venc = {}; let n = 0;
  for (const b of db.boletos) { if (b.msgId) venc[b.msgId] = b.venc; if (b.codigo) venc[b.codigo] = b.venc; }
  for (const g of db.gastos) if (g.fonte === 'fatura' && !g.mes) { const v = venc[(g.chave || '').split('|')[0]]; if (v) { g.mes = v.slice(0, 7); n++; } }
  if (n) { save(db); console.log(`Fatura: ${n} compra(s) movida(s) para o mês do vencimento`); }
})();
recategorizar();
// ---- leitura automática do Gmail ----
const GMAIL_USER = process.env.GMAIL_USER, GMAIL_PASS = (process.env.GMAIL_APP_PASS || '').replace(/\s/g, '');
let lendo = false;
async function rodarGmail() {
  if (!GMAIL_USER || !GMAIL_PASS || lendo) return;
  lendo = true;
  const db0 = load(); const g = db0.gmail || {};
  try {
    const r = await require('./gmail.js').lerGmail({ user: GMAIL_USER, pass: GMAIL_PASS, senhaPdf: process.env.FATURA_PDF_PASS || '', lastUid: g.versao === 2 ? (g.lastUid || 0) : 0, uidValidity: g.uidValidity, log: console.log });
    const db = load(); const conhecidos = new Set(db.boletos.map(b => b.codigo).filter(Boolean).concat(db.boletos.map(b => b.msgId).filter(Boolean)));
    let novos = 0;
    const gChaves = new Set(db.gastos.map(g => g.chave).filter(Boolean).concat(db.removidos || []));
    const { categorizar } = require('./gmail.js');
    let nCompras = 0;
    for (const e of r.encontrados) {
      if (e.compras) for (const c of e.compras) {
        const k = (e.msgId || e.codigo) + '|' + c.data + '|' + c.desc + '|' + c.valor + '|' + c.parcela;
        if (gChaves.has(k)) continue; gChaves.add(k); nCompras++;
        db.gastos.push({ id: crypto.randomUUID().slice(0, 12), desc: c.desc + (c.parcela ? ` (${c.parcela})` : ''), valor: c.valor, data: c.data, mes: String(e.venc).slice(0, 7), categoria: categorizar(c.desc, db.aprendido || {}), forma: 'Cartão', fonte: 'fatura', chave: k });
      }
      if (e.compras) for (const b of db.boletos) if ((e.msgId && b.msgId === e.msgId) || (e.codigo && b.codigo === e.codigo)) b.ehFatura = true;
      const chave = e.codigo || e.msgId; if (!chave || conhecidos.has(chave)) continue;
      conhecidos.add(chave); novos++;
      db.boletos.push({ id: crypto.randomUUID().slice(0, 12), desc: e.desc, valor: e.valor || 0, venc: e.venc, codigo: e.codigo || '', pago: false, fonte: 'gmail', msgId: e.msgId || '', aviso: e.protegido ? 'PDF com senha: confira valor e código no e-mail' : (!e.valor ? 'Confira o valor no e-mail' : ''), ehFatura: !!e.compras });
    }
    db.gmail = { versao: 2, lastUid: r.lastUid, uidValidity: r.uidValidity, ultima: new Date().toISOString(), erro: '' };
    save(db); console.log(`Gmail: ${novos} boleto(s) novo(s), ${nCompras} compra(s) de fatura nova(s)`);
  } catch (e) {
    const db = load(); db.gmail = Object.assign({}, g, { ultima: new Date().toISOString(), erro: String(e.message || e).slice(0, 200) }); save(db);
    console.error('Gmail erro:', e.message);
  } finally { lendo = false; }
}
if (GMAIL_USER && GMAIL_PASS) { setTimeout(rodarGmail, 5000); setInterval(rodarGmail, 30 * 60 * 1000); }

server.listen(PORT, () => console.log(`Finanças SG rodando na porta ${PORT}` + (GMAIL_USER && GMAIL_PASS ? ` · Gmail ligado (senha com ${GMAIL_PASS.length} letras)` : GMAIL_USER ? ' · Gmail SEM SENHA (confira GMAIL_APP_PASS)' : '')));
