import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { startServer } from '../src/server.mjs';
import { Service } from '../src/service.mjs';
import { UserActionRequired } from '../src/domain.mjs';

test('本地 HTTP：校验会话、阻止跨站请求和路径遍历、真实持久化链接导入', async t => {
  const base = path.resolve('artifacts/test-runs'); fs.mkdirSync(base, { recursive: true });
  const directory = fs.mkdtempSync(path.join(base, 'http-'));
  const service = new Service(directory, { browser: { page: async () => { throw new UserActionRequired('测试环境不连接真实 Chrome'); }, close: async () => {} } });
  const app = await startServer({ directory, service });
  t.after(async () => { await app.close(); assert.equal(path.dirname(fs.realpathSync(directory)), fs.realpathSync(base)); fs.rmSync(directory, { recursive: true, force: true }); });
  const home = await fetch(app.url); const html = await home.text();
  assert.equal(home.status, 200); assert.match(home.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  const token = html.match(/name="model-sync-token" content="([a-f0-9]+)"/)[1];
  assert.equal((await fetch(`${app.url}/api/state`)).status, 403);
  const headers = { 'Content-Type': 'application/json', 'X-Model-Sync-Token': token };
  const body = JSON.stringify({ urls: ['https://makerworld.com.cn/zh/models/123-test'] });
  assert.equal((await fetch(`${app.url}/api/models/add`, { method: 'POST', headers: { ...headers, Origin: 'https://evil.example' }, body })).status, 403);
  assert.equal((await fetch(`${app.url}/api/models/add`, { method: 'POST', headers, body })).status, 200);
  const response = await fetch(`${app.url}/api/state`, { headers }); const state = await response.json();
  assert.equal(state.models.length, 1); assert.equal(state.models[0].source.id, '123');
  assert.ok(fs.existsSync(path.join(directory, 'state.json')));
  assert.notEqual((await fetch(`${app.url}/..%2fpackage.json`)).status, 200);
  assert.notEqual((await fetch(`${app.url}/evidence/..%2fstate.json`)).status, 200);
  assert.equal((await fetch(`${app.url}/api/models/add`, { method: 'POST', headers, body: JSON.stringify({ urls: ['https://wrong.example/'] }) })).status, 400);
});

test('本地 HTTP：任务中断接口要求会话令牌并返回中断状态', async t => {
  const base = path.resolve('artifacts/test-runs'); fs.mkdirSync(base, { recursive: true });
  const directory = fs.mkdtempSync(path.join(base, 'http-cancel-'));
  const app = await startServer({ directory });
  t.after(async () => { await app.close(); assert.equal(path.dirname(fs.realpathSync(directory)), fs.realpathSync(base)); fs.rmSync(directory, { recursive: true, force: true }); });
  const home = await fetch(app.url), html = await home.text();
  const token = html.match(/name="model-sync-token" content="([a-f0-9]+)"/)[1];
  const id = 'queued-cancel-test';
  app.service.store.mutate(s => s.tasks.push({ id, status: 'queued', modelId: 'test-model', target: 'nexprint' }));
  const url = `${app.url}/api/tasks/cancel`, body = JSON.stringify({ id });
  assert.equal((await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body })).status, 403);
  const response = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Model-Sync-Token': token }, body });
  assert.equal(response.status, 200); assert.equal((await response.json()).status, 'cancelled');
});

test('本地 HTTP：删除记录可恢复，且不删除模型资料', async t => {
  const base = path.resolve('artifacts/test-runs'); fs.mkdirSync(base, { recursive: true });
  const directory = fs.mkdtempSync(path.join(base, 'http-delete-'));
  const app = await startServer({ directory });
  t.after(async () => { await app.close(); assert.equal(path.dirname(fs.realpathSync(directory)), fs.realpathSync(base)); fs.rmSync(directory, { recursive: true, force: true }); });
  const html = await (await fetch(app.url)).text();
  const token = html.match(/name="model-sync-token" content="([a-f0-9]+)"/)[1];
  const model = app.service.store.addModel('https://makerworld.com.cn/zh/models/123-test');
  const id = 'saved-delete-test';
  app.service.store.mutate(s => s.tasks.push({ id, key: 'makerworld:123:nexprint', status: 'saved', modelId: model.id, target: 'nexprint' }));
  const headers = { 'Content-Type': 'application/json', 'X-Model-Sync-Token': token }, body = JSON.stringify({ id });
  assert.equal((await fetch(`${app.url}/api/tasks/delete`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body })).status, 403);
  const removed = await fetch(`${app.url}/api/tasks/delete`, { method: 'POST', headers, body });
  assert.equal(removed.status, 200); assert.ok((await removed.json()).deletedAt);
  assert.equal(app.service.store.model(model.id).source.id, '123');
  const restored = await fetch(`${app.url}/api/tasks/restore`, { method: 'POST', headers, body });
  assert.equal(restored.status, 200); assert.equal((await restored.json()).deletedAt, null);
});

test('本地 HTTP：模型删除和恢复均校验会话，图片删除同时清除封面', async t => {
  const base = path.resolve('artifacts/test-runs'); fs.mkdirSync(base, { recursive: true });
  const directory = fs.mkdtempSync(path.join(base, 'http-library-'));
  const app = await startServer({ directory });
  t.after(async () => { await app.close(); assert.equal(path.dirname(fs.realpathSync(directory)), fs.realpathSync(base)); fs.rmSync(directory, { recursive: true, force: true }); });
  const html = await (await fetch(app.url)).text();
  const token = html.match(/name="model-sync-token" content="([a-f0-9]+)"/)[1];
  const headers = { 'Content-Type': 'application/json', 'X-Model-Sync-Token': token };
  const model = app.service.store.addModel('https://makerworld.com.cn/zh/models/7002-test');
  app.service.store.updateModel(model.id, { assets: [{ id: 'pic', sha256: 'hash', role: 'photo' }], coverId: 'pic' });
  const body = JSON.stringify({ id: model.id });
  for (const action of ['delete', 'restore']) {
    const url = `${app.url}/api/models/${action}`;
    assert.equal((await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body })).status, 403);
    const response = await fetch(url, { method: 'POST', headers, body });
    assert.equal(response.status, 200);
    assert.equal(Boolean((await response.json()).deletedAt), action === 'delete');
  }
  const response = await fetch(`${app.url}/api/models/edit`, { method: 'POST', headers, body: JSON.stringify({ id: model.id, removedAssetIds: ['pic'], confirmPermanent: true }) });
  assert.equal(response.status, 200);
  const edited = await response.json(); assert.deepEqual(edited.assets, []); assert.equal(edited.coverId, null);
});
