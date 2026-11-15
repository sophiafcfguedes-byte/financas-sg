// Move tudo que está em um mês para outro (ex.: novembro → outubro), com cópia de segurança.
// Uso: node mover-mes.js 2026-11 2026-10 [arquivo]
const fs = require('fs'), path = require('path');
// Só a poupança, todos os registros N meses: node mover-mes.js --poupanca -1
if (process.argv[2] === '--poupanca') {
  const n = parseInt(process.argv[3]); const arq = process.argv[4] || path.join(process.env.FIN_DATA || path.join(process.env.HOME, 'financas-data'), 'financas.json');
  if (!n) { console.log('Uso: node mover-mes.js --poupanca -1'); process.exit(1); }
  const db = JSON.parse(fs.readFileSync(arq, 'utf8')); fs.copyFileSync(arq, arq.replace(/\.json$/, `-antes-de-mover-${Date.now()}.json`));
  const addM = (m, k) => { let [y, mm] = m.split('-').map(Number); mm += k; y += Math.floor((mm - 1) / 12); mm = ((mm - 1) % 12 + 12) % 12 + 1; return y + '-' + String(mm).padStart(2, '0'); };
  for (const r of db.reserva || []) { const de = r.mes; r.mes = addM(r.mes, n); console.log(`  ${de} → ${r.mes}  R$ ${r.valor}`); }
  fs.writeFileSync(arq, JSON.stringify(db, null, 2)); console.log('Poupança movida (cópia de segurança guardada ao lado)'); process.exit(0);
}
const [de, para, arqArg] = process.argv.slice(2);
if (!/^\d{4}-\d{2}$/.test(de || '') || !/^\d{4}-\d{2}$/.test(para || '')) { console.log('Uso: node mover-mes.js 2026-11 2026-10'); process.exit(1); }
const arq = arqArg || path.join(process.env.FIN_DATA || path.join(process.env.HOME, 'financas-data'), 'financas.json');
const db = JSON.parse(fs.readFileSync(arq, 'utf8'));
fs.copyFileSync(arq, arq.replace(/\.json$/, `-antes-de-mover-${Date.now()}.json`));
const [ay, am] = de.split('-').map(Number), [by, bm] = para.split('-').map(Number), diff = (by - ay) * 12 + (bm - am);
const ultimoDia = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate();
const muda = d => { if (!d || !d.startsWith(de)) return d; const dia = Math.min(+d.slice(8, 10) || 1, ultimoDia(by, bm)); return `${para}-${String(dia).padStart(2, '0')}`; };
const addMes = (m, n) => { let [y, mm] = m.split('-').map(Number); mm += n; y += Math.floor((mm - 1) / 12); mm = ((mm - 1) % 12 + 12) % 12 + 1; return y + '-' + String(mm).padStart(2, '0'); };
let n = { gastos: 0, boletos: 0, entradas: 0, parceladas: 0 };
for (const g of db.gastos || []) { const m = g.mes || (g.data || '').slice(0, 7); if (m === de) { if (g.mes) g.mes = para; g.data = (g.data || '').startsWith(de) ? muda(g.data) : g.data; if (!g.mes && !g.data.startsWith(para)) g.mes = para; n.gastos++; } }
for (const b of db.boletos || []) if ((b.venc || '').startsWith(de)) { b.venc = muda(b.venc); n.boletos++; }
for (const e of db.entradas || []) if ((e.data || '').startsWith(de)) { e.data = muda(e.data); n.entradas++; }
if (db.rendas && db.rendas[de] != null) { db.rendas[para] = (db.rendas[para] || 0) + db.rendas[de]; delete db.rendas[de]; }
for (const p of db.parceladas || []) { p.primeiroMes = addMes(p.primeiroMes, diff); n.parceladas++; }
fs.writeFileSync(arq, JSON.stringify(db, null, 2));
console.log(`Movido de ${de} para ${para}:`, n, '(cópia de segurança guardada ao lado)');
