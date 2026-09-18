// JS budget for the static bundle: warn above 400 KB, fail above 600 KB (viem is ~300 KB of it).
const fs = require('fs'), path = require('path');
const dir = path.resolve(__dirname, '..', 'dist', 'assets');
if (!fs.existsSync(dir)) { console.error('dist/assets missing — run `npm run build` first'); process.exit(1); }
let total = 0;
for (const f of fs.readdirSync(dir)) if (f.endsWith('.js')) { const s = fs.statSync(path.join(dir, f)).size; total += s; console.log(`${f}  ${(s / 1024).toFixed(1)} KB`); }
const kb = total / 1024;
console.log(`total JS ${kb.toFixed(1)} KB (warn > 400, fail > 600)`);
if (kb > 600) { console.error('::error::JS budget exceeded'); process.exit(1); }
if (kb > 400) console.warn('::warning::JS budget warning threshold exceeded');
