// Leitura de boletos do Gmail por IMAP (senha de app), sem dependências externas.
const tls = require('tls');
const zlib = require('zlib');

// ---------------- cliente IMAP mínimo ----------------
class Imap {
  constructor(host, port) { this.host = host; this.port = port; this.buf = Buffer.alloc(0); this.tag = 0; this.waiters = []; }
  connect() {
    return new Promise((ok, bad) => {
      this.s = tls.connect({ host: this.host, port: this.port, servername: this.host }, () => {});
      this.s.setTimeout(60000, () => this.s.destroy(new Error('IMAP: tempo esgotado')));
      this.s.on('error', e => { bad(e); this.waiters.splice(0).forEach(w => w.bad(e)); });
      this.s.on('close', () => this.waiters.splice(0).forEach(w => w.bad(new Error('IMAP: conexão fechada'))));
      this.s.on('data', d => { this.buf = Buffer.concat([this.buf, d]); this.pump(); });
      this.greet = { ok, bad };
    });
  }
  // lê linhas completas, respeitando literais {n}
  pump() {
    for (;;) {
      if (this.greet) {
        const i = this.buf.indexOf('\r\n'); if (i < 0) return;
        this.buf = this.buf.subarray(i + 2); const g = this.greet; this.greet = null; g.ok(); continue;
      }
      const w = this.waiters[0]; if (!w) return;
      // monta uma "linha lógica" (linha + literais)
      let pos = 0, parts = [];
      for (;;) {
        const i = this.buf.indexOf('\r\n', pos); if (i < 0) return;
        const line = this.buf.subarray(pos, i).toString('latin1');
        const m = /\{(\d+)\}$/.exec(line);
        if (!m) { parts.push({ text: line }); pos = i + 2; break; }
        const n = Number(m[1]);
        if (this.buf.length < i + 2 + n) return;
        parts.push({ text: line, literal: this.buf.subarray(i + 2, i + 2 + n) });
        pos = i + 2 + n;
      }
      this.buf = this.buf.subarray(pos);
      const first = parts[0].text;
      if (first.startsWith(w.tag + ' ')) {
        this.waiters.shift();
        if (/^\S+ OK/.test(first)) w.ok(w.untagged); else w.bad(new Error('IMAP: ' + first.slice(w.tag.length + 1)));
      } else w.untagged.push(parts);
    }
  }
  cmd(text) {
    const tag = 'A' + (++this.tag);
    return new Promise((ok, bad) => { this.waiters.push({ tag, ok, bad, untagged: [] }); this.s.write(tag + ' ' + text + '\r\n'); });
  }
  close() { try { this.s.write('Z LOGOUT\r\n'); this.s.end(); } catch {} }
}
const q = s => '"' + String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';

// ---------------- MIME ----------------
function splitHead(raw) {
  const i = raw.indexOf('\r\n\r\n'), j = raw.indexOf('\n\n');
  const k = i >= 0 && (j < 0 || i < j) ? i : j; const sep = k === i ? 4 : 2;
  if (k < 0) return { head: raw.toString('latin1'), body: Buffer.alloc(0) };
  return { head: raw.subarray(0, k).toString('latin1'), body: raw.subarray(k + sep) };
}
function headers(head) {
  const h = {}; head.replace(/\r?\n[ \t]+/g, ' ').split(/\r?\n/).forEach(l => { const i = l.indexOf(':'); if (i > 0) h[l.slice(0, i).trim().toLowerCase()] = l.slice(i + 1).trim(); });
  return h;
}
function param(v, name) { const m = new RegExp(name + '\\*?=\\s*"?([^";]+)"?', 'i').exec(v || ''); return m ? m[1] : ''; }
function decodeWords(s) {
  return String(s || '').replace(/=\?([^?]+)\?([bqBQ])\?([^?]*)\?=/g, (_, cs, enc, t) => {
    const b = enc.toUpperCase() === 'B' ? Buffer.from(t, 'base64') : qp(Buffer.from(t.replace(/_/g, ' '), 'latin1'));
    return toText(b, cs);
  }).replace(/\?=\s+=\?/g, '');
}
function qp(b) {
  const s = b.toString('latin1').replace(/=\r?\n/g, ''); const out = [];
  for (let i = 0; i < s.length; i++) { if (s[i] === '=' && /^[0-9A-F]{2}$/i.test(s.substr(i + 1, 2))) { out.push(parseInt(s.substr(i + 1, 2), 16)); i += 2; } else out.push(s.charCodeAt(i) & 255); }
  return Buffer.from(out);
}
function toText(b, cs) { cs = (cs || 'utf-8').toLowerCase(); try { return new TextDecoder(/8859|latin|1252|ascii/.test(cs) ? 'windows-1252' : cs).decode(b); } catch { return b.toString('utf8'); } }
function decodeBody(body, h) {
  const te = (h['content-transfer-encoding'] || '').toLowerCase();
  if (te === 'base64') return Buffer.from(body.toString('latin1').replace(/[^A-Za-z0-9+/=]/g, ''), 'base64');
  if (te === 'quoted-printable') return qp(body);
  return body;
}
// percorre as partes; devolve textos e PDFs
function walk(raw, out = { texts: [], pdfs: [] }, depth = 0) {
  if (depth > 8) return out;
  const { head, body } = splitHead(raw); const h = headers(head);
  const ct = (h['content-type'] || 'text/plain').toLowerCase();
  if (ct.startsWith('multipart/')) {
    const b = param(h['content-type'], 'boundary'); if (!b) return out;
    const s = body.toString('latin1').split('--' + b);
    for (const part of s.slice(1)) { if (part.startsWith('--')) break; walk(Buffer.from(part.replace(/^\r?\n/, ''), 'latin1'), out, depth + 1); }
  } else if (ct.startsWith('message/rfc822')) {
    walk(decodeBody(body, h), out, depth + 1);
  } else {
    const data = decodeBody(body, h);
    const name = param(h['content-disposition'], 'filename') || param(h['content-type'], 'name');
    if (ct.includes('pdf') || /\.pdf$/i.test(name)) out.pdfs.push(data);
    else if (ct.startsWith('text/')) {
      let t = toText(data, param(h['content-type'], 'charset'));
      if (ct.includes('html')) t = t.replace(/<style[\s\S]*?<\/style>|<script[\s\S]*?<\/script>/gi, ' ').replace(/<br\s*\/?>|<\/(p|div|tr|td|li)>/gi, '\n').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&#(\d+);/g, (_, n) => String.fromCharCode(n));
      out.texts.push(t);
    }
  }
  return out;
}

// ---------------- PDF: texto aproximado ----------------
function pdfText(buf) {
  const s = buf.toString('latin1'); let text = '';
  if (/\/Encrypt\b/.test(s)) return { text: '', encrypted: true };
  const re = /stream\r?\n/g; let m;
  while ((m = re.exec(s))) {
    const start = m.index + m[0].length, end = s.indexOf('endstream', start); if (end < 0) break;
    const dict = s.slice(Math.max(0, m.index - 300), m.index);
    let data = buf.subarray(start, end);
    if (/FlateDecode/.test(dict.slice(dict.lastIndexOf('<<')))) { try { data = zlib.inflateSync(data); } catch { try { data = zlib.inflateSync(data.subarray(0, data.length - 2)); } catch { continue; } } }
    const c = data.toString('latin1');
    // strings em (..) e <..> dos operadores Tj/TJ
    const strs = c.match(/\((?:\\.|[^\\)])*\)|<[0-9A-Fa-f\s]+>(?=\s*(?:Tj|\]|-?\d))/g) || [];
    for (const t of strs) {
      if (t[0] === '(') text += t.slice(1, -1).replace(/\\([nrtbf()\\]|\d{1,3})/g, (_, e) => /^\d/.test(e) ? String.fromCharCode(parseInt(e, 8)) : ({ n: '\n', r: '', t: ' ' }[e] ?? e));
      else { const hx = t.slice(1, -1).replace(/\s/g, ''); const b = Buffer.from(hx, 'hex'); text += b.length > 1 && b[0] === 0 && b.length % 2 === 0 ? Buffer.from(b).swap16().toString('utf16le') : b.toString('latin1'); }
    }
    text += '\n'; re.lastIndex = end;
  }
  return { text, encrypted: false };
}

// ---------------- boleto ----------------
const mod10 = s => { let sum = 0, w = 2; for (let i = s.length - 1; i >= 0; i--) { let p = +s[i] * w; sum += p > 9 ? p - 9 : p; w = w === 2 ? 1 : 2; } return (10 - sum % 10) % 10; };
const mod11b = s => { let sum = 0, w = 2; for (let i = s.length - 1; i >= 0; i--) { sum += +s[i] * w; w = w === 9 ? 2 : w + 1; } const r = 11 - sum % 11; return r === 0 || r > 9 ? 1 : r; };
const mod11c = s => { let sum = 0, w = 2; for (let i = s.length - 1; i >= 0; i--) { sum += +s[i] * w; w = w === 9 ? 2 : w + 1; } const r = sum % 11; return r === 0 || r === 1 ? 0 : 11 - r; };
const iso = d => d.toISOString().slice(0, 10);
function fatorData(f) {
  // fator 1000 = 22/02/2025 (novo ciclo); antes, base 07/10/1997
  const base = Date.UTC(2025, 1, 22); const d = new Date(base + (f - 1000) * 864e5);
  return d;
}
function lerLinha(d) {
  if (d.length === 47) {
    const bar = d.slice(0, 4) + d[32] + d.slice(33, 47) + d.slice(4, 9) + d.slice(10, 20) + d.slice(21, 31);
    if (mod11b(bar.slice(0, 4) + bar.slice(5)) !== +bar[4]) return null;
    if (mod10(d.slice(0, 9)) !== +d[9] || mod10(d.slice(10, 20)) !== +d[20] || mod10(d.slice(21, 31)) !== +d[31]) return null;
    const f = +d.slice(33, 37), valor = +d.slice(37, 47) / 100;
    return { tipo: 'banco', valor, venc: f ? iso(fatorData(f)) : null };
  }
  if (d.length === 48 && d[0] === '8') {
    const blocos = [0, 1, 2, 3].map(i => d.slice(i * 12, i * 12 + 11)), dvs = [0, 1, 2, 3].map(i => +d[i * 12 + 11]);
    const fn = d[2] === '6' || d[2] === '7' ? mod10 : mod11c;
    if (blocos.some((b, i) => fn(b) !== dvs[i])) return null;
    const bar = blocos.join('');
    return { tipo: 'conta', valor: d[2] === '6' || d[2] === '8' ? +bar.slice(4, 15) / 100 : 0, venc: null };
  }
  return null;
}
function acharBoletos(texto) {
  const achados = new Map();
  const re = /(?<!\d)(?:\d[\d .\-]{40,70}\d)(?!\d)/g; let m;
  while ((m = re.exec(texto))) {
    const d = m[0].replace(/\D/g, '');
    for (const len of [47, 48]) for (let i = 0; i + len <= d.length; i++) {
      const s = d.slice(i, i + len), r = lerLinha(s); if (r) achados.set(s, r);
    }
  }
  return [...achados].map(([codigo, r]) => ({ codigo, ...r }));
}
function acharVenc(texto) {
  const m = /venc[a-zçã]*\.?\s*(?:em|:)?\s*(\d{2})\/(\d{2})\/(\d{4})/i.exec(texto);
  return m ? `${m[3]}-${m[2]}-${m[1]}` : null;
}
function nomeRemetente(from, subject) {
  const n = decodeWords(from).replace(/<.*>/, '').replace(/"/g, '').trim();
  return (n && !/@/.test(n) ? n : decodeWords(subject)).slice(0, 60) || 'Boleto';
}

// ---------------- leitura ----------------
async function lerGmail({ user, pass, lastUid = 0, uidValidity = null, log = () => {} }) {
  const im = new Imap('imap.gmail.com', 993);
  await im.connect();
  try {
    log('Gmail: entrando…');
    await im.cmd('LOGIN ' + q(user) + ' ' + q(pass));
    // pasta "Todos os e-mails" (inclui o que não está na caixa de entrada)
    const lst = await im.cmd('LIST "" "*"');
    const todos = lst.map(p => /^\* LIST \(([^)]*)\) \S+ (.+)$/.exec(p[0].text)).find(m => m && /\\All\b/i.test(m[1]));
    const pasta = todos ? todos[2] : 'INBOX';
    log('Gmail: lendo a pasta ' + pasta);
    const sel = await im.cmd('SELECT ' + pasta);
    const uv = sel.map(p => /UIDVALIDITY (\d+)/.exec(p[0].text)).find(Boolean)?.[1] || null;
    if (uidValidity && uv !== uidValidity) lastUid = 0;
    log('Gmail: conectado, procurando boletos');
    const ini = new Date(); const desde = `${ini.getFullYear()}/${String(ini.getMonth() + 1).padStart(2, '0')}/01`;
    const busca = 'X-GM-RAW ' + q('after:' + desde + ' -in:spam -in:trash (boleto OR fatura OR vencimento OR vence OR pagamento OR "linha digitavel" OR "codigo de barras" OR cobranca OR has:attachment)');
    const r = await im.cmd('UID SEARCH ' + busca);
    const uids = (r.map(p => /^\* SEARCH(.*)/.exec(p[0].text)).find(Boolean)?.[1] || '').trim().split(/\s+/).filter(Boolean).map(Number).filter(u => u > lastUid).sort((a, b) => a - b);
    log(`Gmail: ${uids.length} e-mail(s) novo(s) para olhar`);
    const encontrados = [];
    let maxUid = lastUid;
    for (const uid of uids.slice(-150)) {
      const f = await im.cmd(`UID FETCH ${uid} (RFC822.SIZE BODY.PEEK[])`);
      maxUid = Math.max(maxUid, uid);
      const parts = f.find(p => p.some(x => x.literal)); if (!parts) continue;
      const raw = parts.find(x => x.literal).literal;
      if (raw.length > 15e6) continue;
      const { head } = splitHead(raw); const h = headers(head);
      const { texts, pdfs } = walk(raw);
      let texto = texts.join('\n'); let protegido = false;
      for (const p of pdfs) { const t = pdfText(p); if (t.encrypted) protegido = true; texto += '\n' + t.text; }
      const bs = acharBoletos(texto);
      const data = h.date ? new Date(h.date) : new Date();
      for (const b of bs) encontrados.push({ ...b, venc: b.venc || acharVenc(texto) || iso(data), desc: nomeRemetente(h.from, h.subject), assunto: decodeWords(h.subject).slice(0, 100), msgId: (h['message-id'] || '').slice(0, 200) });
      if (!bs.length && protegido) encontrados.push({ protegido: true, desc: nomeRemetente(h.from, h.subject), assunto: decodeWords(h.subject).slice(0, 100), msgId: (h['message-id'] || '').slice(0, 200), venc: acharVenc(texto) || iso(data) });
    }
    return { encontrados, lastUid: maxUid, uidValidity: uv };
  } finally { im.close(); }
}

module.exports = { lerGmail, acharBoletos, lerLinha, walk, pdfText };
