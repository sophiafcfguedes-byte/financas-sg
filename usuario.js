// Cria (ou reseta) o login de outra pessoa, com as finanças dela separadas.
// Uso: node usuario.js victoria SENHA_INICIAL "Victoria"
// No primeiro acesso, o app pede para ela criar uma senha nova.
const fs = require('fs'), path = require('path'), crypto = require('crypto');
const [id, senha, nome] = process.argv.slice(2);
if (!id || !senha || !/^[a-z0-9_-]{2,30}$/.test(id)) { console.log('Uso: node usuario.js victoria SENHA_INICIAL "Victoria"   (id só com letras minúsculas/números)'); process.exit(1); }
if (senha.length < 4) { console.log('A senha inicial precisa ter pelo menos 4 caracteres'); process.exit(1); }
const DATA_DIR = process.env.FIN_DATA || path.join(process.env.HOME || '.', 'financas-data');
fs.mkdirSync(DATA_DIR, { recursive: true });
const arq = path.join(DATA_DIR, 'usuarios.json');
let us = {}; try { us = JSON.parse(fs.readFileSync(arq, 'utf8')); } catch {}
const salt = crypto.randomBytes(16).toString('hex');
us[id] = { nome: nome || us[id]?.nome || id, salt, hash: crypto.scryptSync(senha, salt, 64).toString('hex'), trocar: true };
fs.writeFileSync(arq, JSON.stringify(us, null, 2), { mode: 0o600 });
console.log(`Login "${id}" pronto. No primeiro acesso o app vai pedir uma senha nova.`);
