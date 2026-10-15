import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const require = createRequire(import.meta.url);
function run(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { cwd: root, stdio: 'inherit',
      env: { ...process.env, CSC_IDENTITY_AUTO_DISCOVERY: 'false' } });
    child.once('error', reject);
    child.once('exit', (code, signal) => code === 0 ? resolve() : reject(new Error(`Step failed (${signal || code}): ${args[0]}`)));
  });
}

try {
  if (process.platform !== 'win32' || process.arch !== 'x64') throw new Error('Build this Windows x64 release on Windows x64.');
  if (Number(process.versions.node.split('.')[0]) < 22) throw new Error('Node.js 22 or newer is required to build.');
  if (!fs.existsSync(path.join(root, 'node_modules/electron/dist/electron.exe'))) throw new Error('Electron runtime is missing. Run npm.cmd run setup-desktop first.');
  // A failed rerun must not leave an old "passed" report next to a new EXE.
  for (const filename of ['release-smoke.json']) fs.rmSync(path.join(root, 'dist', filename), { force: true });
  const { version } = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  fs.rmSync(path.join(root, 'dist', `ModelPort-${version}-win-x64.exe.sha256`), { force: true });
  console.log('[1/4] Check source syntax');
  await run(['scripts/check.mjs']);
  console.log('[2/4] Run automated tests (no real platform uploads)');
  const tests = fs.readdirSync(path.join(root, 'test')).filter(name => name.endsWith('.test.mjs')).map(name => `test/${name}`);
  await run(['--test', ...tests]);
  console.log('[3/4] Build portable Windows EXE');
  await run([require.resolve('electron-builder/cli.js'), '--win', 'portable', '--x64', '--publish', 'never']);
  console.log('[4/4] Test standalone release EXE');
  await run(['scripts/smoke-exe.mjs']);
  console.log(`Release ready: ${path.join(root, 'dist', `ModelPort-${version}-win-x64.exe`)}`);
} catch (error) {
  console.error(`Release failed: ${error.message}`);
  process.exitCode = 1;
}
