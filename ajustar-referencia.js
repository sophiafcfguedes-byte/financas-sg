// Desfaz o "mover para outubro": agora o app entende sozinho que o que entra/sai em novembro é referência outubro.
// Volta para novembro (data real) gastos, boletos e recebimentos que estão com data de outubro. Parcelas e poupança não mudam.
// Uso: node ajustar-referencia.js
const fs = require('fs'), path = require('path');
const arq = process.argv[2] || path.join(process.env.FIN_DATA || path.join(process.env.HOME, 'financas-data'), 'financas.json');
const db = JSON.parse(fs.readFileSync(arq, 'utf8'));
fs.copyFileSync(arq, arq.replace(/\.json$/, `-antes-referencia-${Date.now()}.json`));
const de = '2026-10', para = '2026-11'; const n = { compras_fatura: 0, gastos: 0, boletos: 0, recebimentos: 0 };
const muda = d => para + d.slice(7);
for (const g of db.gastos || []) {
  if (g.mes) { if (g.mes === de) { g.mes = para; n.compras_fatura++; } }       // compra da fatura: só o mês da fatura
  else if ((g.data || '').startsWith(de)) { g.data = muda(g.data); n.gastos++; } // lançamento à mão: data
}
for (const b of db.boletos || []) if ((b.venc || '').startsWith(de)) { b.venc = muda(b.venc); n.boletos++; }
for (const e of db.entradas || []) if ((e.data || '').startsWith(de)) { e.data = muda(e.data); n.recebimentos++; }
if (db.rendas && db.rendas[de] != null) { db.rendas[para] = (db.rendas[para] || 0) + db.rendas[de]; delete db.rendas[de]; }
fs.writeFileSync(arq, JSON.stringify(db, null, 2));
console.log('Ajustado para novembro (referência outubro):', n);
