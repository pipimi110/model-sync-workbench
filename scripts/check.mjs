import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
const roots = ['src', 'desktop', 'ui', 'test', 'scripts'];
const files = [];
function visit(dir) { for (const file of fs.readdirSync(dir, { withFileTypes: true })) { const p = path.join(dir, file.name); file.isDirectory() ? visit(p) : /\.(?:mjs|cjs|js)$/.test(p) && files.push(p); } }
for (const dir of roots) visit(dir);
let failed = false;
for (const file of files) { const result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' }); if (result.status) { console.error(result.stderr); failed = true; } }
console.log(`${files.length} JavaScript files checked`); process.exitCode = failed ? 1 : 0;
