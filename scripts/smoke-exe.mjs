import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { createRequire } from 'node:module';
import { chromium } from 'playwright';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const require = createRequire(import.meta.url);
const { listPackage } = require('@electron/asar');
const { version } = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const executable = path.join(root, 'dist', `ModelPort-${version}-win-x64.exe`);
const reportPath = path.join(root, 'dist', 'release-smoke.json');
const execute = promisify(execFile);
let child, browser, mainPid, work, report, childExit, closeRequested = false;

async function until(fn, label, timeout = 120000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const value = await fn();
    if (value) return value;
    if (childExit && !closeRequested) throw new Error(`EXE exited before ${label}: ${JSON.stringify(childExit)}`);
    await delay(300);
  }
  throw new Error(`Timed out: ${label}`);
}
function read(file) { try { return fs.readFileSync(file, 'utf8'); } catch (error) { if (error.code === 'ENOENT') return ''; throw error; } }
async function closeApp() {
  if (!mainPid) return;
  assert.ok(Number.isSafeInteger(mainPid) && mainPid > 0);
  closeRequested = true;
  // Only close the process that owns this fresh, isolated test workspace.
  await execute('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    `$ModelPortProcess = Get-Process -Id ${mainPid} -ErrorAction Stop; if (-not $ModelPortProcess.CloseMainWindow()) { exit 2 }`], { windowsHide: true });
  await until(() => !fs.existsSync(path.join(work, 'data', 'workspace.lock')), 'clean app shutdown', 30000);
  mainPid = null;
}

try {
  if (process.platform !== 'win32') throw new Error('The EXE smoke test requires Windows.');
  fs.rmSync(reportPath, { force: true });
  fs.rmSync(`${executable}.sha256`, { force: true });
  assert.ok(fs.existsSync(executable), 'Build the portable EXE before running this test.');
  const entries = listPackage(path.join(root, 'dist/win-unpacked/resources/app.asar')).map(name => name.replaceAll('\\', '/'));
  const forbidden = entries.filter(name => !/^\/(desktop|src|ui|node_modules)(\/|$)/.test(name) && name !== '/package.json');
  assert.deepEqual(forbidden, [], 'Release must contain only application code and production dependencies.');
  for (const item of ['/desktop/main.cjs', '/desktop/workspace.cjs', '/src/server.mjs', '/ui/app.js', '/node_modules/playwright/package.json', '/node_modules/adm-zip/package.json']) assert.ok(entries.includes(item), `Missing release dependency: ${item}`);
  assert.ok(!entries.some(name => /^\/node_modules\/(electron|electron-builder|app-builder-lib)(\/|$)/.test(name)), 'Build tools must not ship in the EXE.');

  const base = path.join(root, 'artifacts'); fs.mkdirSync(base, { recursive: true });
  work = fs.mkdtempSync(path.join(base, 'release-smoke-'));
  const standalone = path.join(work, '独立运行 含空格'); fs.mkdirSync(standalone);
  const copy = path.join(standalone, 'ModelPort.exe'); fs.copyFileSync(executable, copy);
  assert.deepEqual(fs.readdirSync(standalone), ['ModelPort.exe']);
  const env = { ...process.env, MODEL_SYNC_DATA: path.join(work, 'data'), MODEL_SYNC_SHELL_DIR: path.join(work, 'shell') };
  delete env.ELECTRON_RUN_AS_NODE;
  // Do not accidentally satisfy runtime dependencies with Node/npm on the build machine.
  const pathKey = Object.keys(env).find(key => key.toLowerCase() === 'path') || 'Path';
  env[pathKey] = [path.join(process.env.SystemRoot || 'C:\\Windows', 'System32'), process.env.SystemRoot || 'C:\\Windows'].join(path.delimiter);
  const output = fs.openSync(path.join(work, 'process.log'), 'a');
  child = spawn(copy, ['--remote-debugging-port=0'], { cwd: standalone, env, stdio: ['ignore', output, output], windowsHide: true });
  fs.closeSync(output);
  child.once('error', error => { childExit = { error: error.message }; });
  child.once('exit', (code, signal) => { childExit = { code, signal }; });
  const logFile = path.join(work, 'data', 'desktop-main.log');
  await until(() => {
    const lock = read(path.join(work, 'data', 'workspace.lock'));
    if (lock) mainPid = JSON.parse(lock).pid;
    const log = read(logFile);
    if (log.includes('startup failed:')) throw new Error(log);
    return log.includes('main window loaded');
  }, 'portable EXE startup');
  mainPid = JSON.parse(read(path.join(work, 'data', 'workspace.lock'))).pid;
  const portInfo = await until(() => {
    const lines = read(path.join(work, 'shell', 'DevToolsActivePort')).trim().split(/\r?\n/);
    return /^\d+$/.test(lines[0]) && lines[1]?.startsWith('/devtools/browser/') ? lines : null;
  }, 'test app debugging endpoint');
  // This endpoint belongs to the isolated Electron test process, not default Chrome.
  browser = await chromium.connectOverCDP(`ws://127.0.0.1:${portInfo[0]}${portInfo[1]}`, { timeout: 15000 });
  const page = browser.contexts()[0].pages().find(item => /^http:\/\/127\.0\.0\.1:\d+\/$/.test(item.url()));
  assert.ok(page, 'Packaged workbench page was not opened.');
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.locator('[data-action="import"]').first().waitFor({ state: 'visible', timeout: 15000 });
  const result = await page.evaluate(async () => {
    const token = document.querySelector('meta[name="model-sync-token"]').content;
    const state = await fetch('/api/state', { headers: { 'X-Model-Sync-Token': token } });
    return { title: document.title, bridge: typeof window.desktop?.chooseFiles === 'function', status: state.status,
      state: await state.json(), assets: await Promise.all(['/app.js', '/style.css', '/icon.svg'].map(async url => ({ url, status: (await fetch(url)).status }))) };
  });
  assert.match(result.title, /ModelPort/);
  assert.equal(result.bridge, true, 'Packaged preload bridge failed.');
  assert.equal(result.status, 200);
  assert.equal(path.resolve(result.state.directory), path.join(work, 'data'));
  assert.equal(result.state.models.length, 0, 'Real user models must not be bundled.');
  assert.equal(result.state.tasks.length, 0);
  assert.equal(result.state.browserConnected, false, 'Test must not connect to the user Chrome.');
  assert.deepEqual(result.state.capabilities.targets, ['nexprint', 'creality']);
  assert.ok(result.assets.every(asset => asset.status === 200));
  await page.locator('[data-view="tasks"]').click();
  await page.locator('#main').getByRole('heading', { name: '同步任务', exact: false }).first().waitFor();
  await page.locator('[data-view="accounts"]').click();
  await page.getByRole('button', { name: '连接默认 Chrome', exact: true }).waitFor();
  await page.locator('[data-view="library"]').click();
  await page.locator('[data-action="import"]').first().click();
  await page.locator('#modal[open]').waitFor();
  await page.locator('#modal').getByRole('button', { name: '关闭', exact: true }).last().click();
  await page.screenshot({ path: path.join(work, 'standalone.png') });
  assert.deepEqual(errors, [], 'Packaged UI produced JavaScript errors.');
  await closeApp();
  await until(() => childExit, 'portable launcher exit', 30000);
  assert.equal(childExit.code, 0, 'Portable launcher did not exit cleanly.');
  const sha256 = createHash('sha256').update(fs.readFileSync(executable)).digest('hex');
  report = { passed: true, testedAt: new Date().toISOString(), version, executable, bytes: fs.statSync(executable).size, sha256,
    checks: ['release file allowlist', 'production dependencies only', 'single EXE copied to isolated Chinese/space path',
      'actual EXE startup', 'ASAR server and static assets', 'isolated empty workspace', 'preload bridge', 'library/tasks/accounts UI', 'import dialog', 'clean shutdown'],
    limitations: ['No real platform login or upload was performed.', 'Not tested on another Windows device without Node.js installed.'],
    evidence: work };
  fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  fs.writeFileSync(`${executable}.sha256`, `${sha256}  ${path.basename(executable)}\n`);
  console.log(`Standalone EXE smoke test passed. Report: ${reportPath}`);
} catch (error) {
  console.error(`EXE smoke test failed: ${error.stack || error.message}`);
  if (work) console.error(`Diagnostic files kept in: ${work}`);
  process.exitCode = 1;
} finally {
  if (mainPid) await closeApp().catch(error => console.error(`Test app could not close: ${error.message}`));
  if (browser) await browser.close().catch(() => {});
}
