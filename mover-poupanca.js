// Desloca todos os saldos da poupança N meses (ex.: -1 = cada registro vai para o mês anterior). Faz cópia de segurança.
// Uso: node mover-poupanca.js -1
const fs = require('fs'), path = require('path');
const n = parseInt(process.argv[2], 10); if (!n) { console.log('Uso: node mover-poupanca.js -1'); process.exit(1); }
const arq = process.argv[3] || path.join(process.env.FIN_DATA || path.join(process.env.HOME, 'financas-data'), 'financas.json');
const db = JSON.parse(fs.readFileSync(arq, 'utf8'));
fs.copyFileSync(arq, arq.replace(/\.json$/, `-antes-poupanca-${Date.now()}.json`));
const addMes = (m, k) => { let [y, mm] = m.split('-').map(Number); mm += k; y += Math.floor((mm - 1) / 12); mm = ((mm - 1) % 12 + 12) % 12 + 1; return y + '-' + String(mm).padStart(2, '0'); };
for (const r of db.reserva || []) { const a = r.mes; r.mes = addMes(r.mes, n); console.log(`${a} → ${r.mes}: ${r.valor}`); }
fs.writeFileSync(arq, JSON.stringify(db, null, 2));
