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

const COLLECTIONS = ['fixas', 'gastos', 'parceladas', 'boletos', 'reserva'];
const EMPTY = {
  config: { renda: 0, pctEssenciais: 50, pctLivre: 25 },
  fixas: [], gastos: [], parceladas: [], boletos: [], reserva: [],
  pagos: {} // { "2026-11": ["idDaFixa", ...] }
};

function load() {
  try { return Object.assign(structuredClone(EMPTY), JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'))); }
  catch { return structuredClone(EMPTY); }
}
function save(db) {
  const tmp = DATA_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(db, null, 2));
  fs.renameSync(tmp, DATA_FILE);
  // cópia de segurança diária
  const bk = path.join(DATA_DIR, 'backup-' + new Date().toISOString().slice(0, 10) + '.json');
  if (!fs.existsSync(bk)) fs.copyFileSync(DATA_FILE, bk);
}

// ---- sessão ----
function sign(v) { return crypto.createHmac('sha256', SECRET).update(v).digest('hex'); }
function makeToken() { const exp = Date.now() + 1000 * 60 * 60 * 24 * 60; return exp + '.' + sign(String(exp)); }
function validToken(t) {
  if (!t) return false;
  const [exp, sig] = t.split('.');
  if (!exp || !sig || Number(exp) < Date.now()) return false;
  const good = sign(exp);
  return sig.length === good.length && crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(good));
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
const num = v => { const n = Number(String(v).replace(',', '.')); return Number.isFinite(n) ? Math.round(n * 100) / 100 : 0; };
const str = (v, max = 120) => String(v ?? '').slice(0, max);
const ym = v => /^\d{4}-\d{2}$/.test(v) ? v : new Date().toISOString().slice(0, 7);
const ymd = v => /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : new Date().toISOString().slice(0, 10);

// limpa e valida cada tipo de registro
const CLEAN = {
  fixas: b => ({ nome: str(b.nome), valor: num(b.valor), dia: Math.min(31, Math.max(1, parseInt(b.dia) || 1)), categoria: str(b.categoria || 'Casa', 40) }),
  gastos: b => ({ desc: str(b.desc), valor: num(b.valor), data: ymd(b.data), categoria: str(b.categoria || 'Outros', 40), forma: str(b.forma || 'Pix', 20) }),
  parceladas: b => ({ desc: str(b.desc), valorParcela: num(b.valorParcela), total: Math.max(1, parseInt(b.total) || 1), primeiroMes: ym(b.primeiroMes), categoria: str(b.categoria || 'Compras', 40) }),
  boletos: b => ({ desc: str(b.desc), valor: num(b.valor), venc: ymd(b.venc), codigo: str(b.codigo, 80), pago: !!b.pago }),
  reserva: b => ({ mes: ym(b.mes), valor: num(b.valor), nota: str(b.nota, 80) })
};

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
      const ok = String(b.pin || '').length === PIN.length && crypto.timingSafeEqual(Buffer.from(String(b.pin)), Buffer.from(PIN));
      if (!ok) { fail(ip); return send(res, 401, { erro: 'PIN incorreto' }); }
      fails.delete(ip);
      const secure = req.headers['x-forwarded-proto'] === 'https' ? '; Secure' : '';
      return send(res, 200, { ok: true }, { 'Set-Cookie': `fin=${makeToken()}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${60 * 60 * 24 * 60}${secure}` });
    }
    if (p === '/api/logout') return send(res, 200, { ok: true }, { 'Set-Cookie': 'fin=; Path=/; Max-Age=0' });

    // ---- API protegida ----
    if (p.startsWith('/api/')) {
      if (!validToken(cookie(req, 'fin'))) return send(res, 401, { erro: 'login' });
      const db = load();
      const parts = p.split('/').filter(Boolean); // ['api', coll, id?]
      const coll = parts[1], id = parts[2];

      if (coll === 'state' && req.method === 'GET') return send(res, 200, db);

      if (coll === 'config' && req.method === 'PUT') {
        const b = await body(req);
        const essen = Math.min(75, Math.max(0, num(b.pctEssenciais ?? db.config.pctEssenciais)));
        db.config = { renda: num(b.renda ?? db.config.renda), pctEssenciais: essen, pctLivre: Math.round((75 - essen) * 100) / 100 };
        save(db); return send(res, 200, db);
      }

      if (coll === 'icon' && req.method === 'POST') { // ícone desenhado no navegador com a fonte da logo
        const b = await body(req);
        for (const sz of ['180', '512']) {
          const m = /^data:image\/png;base64,([A-Za-z0-9+/=]+)$/.exec(String(b['png' + sz] || ''));
          if (m) fs.writeFileSync(path.join(DATA_DIR, `icon-${sz}.png`), Buffer.from(m[1], 'base64'));
        }
        return send(res, 200, { ok: true });
      }

      if (coll === 'pago' && req.method === 'POST') { // marca/desmarca fixa como paga no mês
        const b = await body(req); const mes = ym(b.mes);
        const lista = new Set(db.pagos[mes] || []);
        b.pago ? lista.add(str(b.id, 40)) : lista.delete(str(b.id, 40));
        db.pagos[mes] = [...lista]; save(db); return send(res, 200, db);
      }

      if (COLLECTIONS.includes(coll)) {
        if (req.method === 'POST' && !id) {
          const item = Object.assign({ id: crypto.randomUUID().slice(0, 12) }, CLEAN[coll](await body(req)));
          db[coll].push(item); save(db); return send(res, 200, db);
        }
        const i = db[coll].findIndex(x => x.id === id);
        if (i < 0) return send(res, 404, { erro: 'não encontrado' });
        if (req.method === 'PUT') { db[coll][i] = Object.assign({ id }, CLEAN[coll](Object.assign({}, db[coll][i], await body(req)))); save(db); return send(res, 200, db); }
        if (req.method === 'DELETE') { db[coll].splice(i, 1); save(db); return send(res, 200, db); }
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

server.listen(PORT, () => console.log(`Finanças SG rodando na porta ${PORT}`));
