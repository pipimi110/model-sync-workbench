import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { BrowserManager } from '../src/browser.mjs';
import { UserActionRequired } from '../src/domain.mjs';

test('default Chrome endpoint reads only a valid DevToolsActivePort record', t => {
  const localAppData = fs.mkdtempSync(path.join(os.tmpdir(), 'modelport-chrome-'));
  t.after(() => fs.rmSync(localAppData, { recursive: true, force: true }));
  const profile = path.join(localAppData, 'Google', 'Chrome', 'User Data');
  fs.mkdirSync(profile, { recursive: true });
  const manager = new BrowserManager('', { state: { settings: { browser: 'default-chrome' } } }, { localAppData });

  assert.throws(() => manager.defaultChromeEndpoint(), UserActionRequired);
  fs.writeFileSync(path.join(profile, 'DevToolsActivePort'), '9222\n/devtools/browser/a1b2-c3\n');
  assert.equal(manager.defaultChromeEndpoint(), 'ws://127.0.0.1:9222/devtools/browser/a1b2-c3');
  fs.writeFileSync(path.join(profile, 'DevToolsActivePort'), '99999\n/devtools/browser/a1b2-c3\n');
  assert.throws(() => manager.defaultChromeEndpoint(), UserActionRequired);
  fs.writeFileSync(path.join(profile, 'DevToolsActivePort'), '9222\n/other/path\n');
  assert.throws(() => manager.defaultChromeEndpoint(), UserActionRequired);
});

test('default Chrome connection preserves the user context defaults and requires an existing context', async () => {
  let endpoint, settings;
  const manager = new BrowserManager('', { state: { settings: { browser: 'default-chrome' } } }, {
    localAppData: 'C:\\Users\\test\\AppData\\Local',
    connectOverCDP: async (value, options) => {
      endpoint = value; settings = options;
      return { contexts: () => [{ setDefaultTimeout() {}, on() {} }], on() {}, async close() {} };
    },
  });
  manager.defaultChromeEndpoint = () => 'ws://127.0.0.1:9222/devtools/browser/a1b2-c3';
  await manager.getContext();
  assert.equal(endpoint, 'ws://127.0.0.1:9222/devtools/browser/a1b2-c3');
  assert.equal(settings.noDefaults, true);
  assert.equal(settings.isLocal, true);
  assert.ok(fs.existsSync(settings.artifactsDir));
  await manager.close();
});

test('3MF 下载期间监听 CDP 文件事件并在完成后恢复 Chrome 默认策略', async t => {
  const artifactsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'modelport-downloads-'));
  t.after(() => fs.rmSync(artifactsDir, { recursive: true, force: true }));
  const commands = [], listeners = new Map();
  const session = {
    send: async (method, params) => commands.push({ method, params }),
    on: (event, listener) => listeners.set(event, listener),
    off: event => listeners.delete(event),
    detach: async () => commands.push({ detached: true }),
  };
  const manager = new BrowserManager('', {}, {});
  manager.cdpBrowser = { newBrowserCDPSession: async () => session };
  manager.downloadArtifactsDirectory = artifactsDir;

  const download = await manager.downloadFromPage(async () => {
    const filePath = path.join(artifactsDir, 'guid-1');
    fs.writeFileSync(filePath, 'test 3mf');
    listeners.get('Browser.downloadWillBegin')({ guid: 'guid-1', url: 'https://makerworld.bblmw.com/model.3mf', suggestedFilename: 'model.3mf' });
    listeners.get('Browser.downloadProgress')({ guid: 'guid-1', state: 'completed', filePath });
  });
  assert.equal(download.suggestedFilename, 'model.3mf');
  assert.equal(fs.readFileSync(download.path, 'utf8'), 'test 3mf');
  assert.deepEqual(commands[0], { method: 'Browser.setDownloadBehavior', params: {
    behavior: 'allowAndName', downloadPath: artifactsDir, eventsEnabled: true,
  } });
  assert.deepEqual(commands[1], { method: 'Browser.setDownloadBehavior', params: { behavior: 'default' } });
  assert.deepEqual(commands[2], { detached: true });
});
