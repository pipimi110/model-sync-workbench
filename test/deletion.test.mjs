import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Service } from '../src/service.mjs';
import { Store } from '../src/store.mjs';
import { TaskQueue } from '../src/queue.mjs';
import { ingestFile } from '../src/assets.mjs';
import { startServer } from '../src/server.mjs';

function setup(t) {
  const base = path.resolve('artifacts/test-runs'); fs.mkdirSync(base, { recursive: true });
  const directory = fs.mkdtempSync(path.join(base, 'deletion-'));
  t.after(() => { assert.equal(path.dirname(fs.realpathSync(directory)), fs.realpathSync(base)); fs.rmSync(directory, { recursive: true, force: true }); });
  const service = new Service(directory, { browser: { close: async () => {} } });
  const record = service.store.addModel('https://makerworld.com.cn/zh/models/7003-delete-fixture');
  const original = path.join(directory, 'original.png');
  fs.writeFileSync(original, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aO1sAAAAASUVORK5CYII=', 'base64'));
  const asset = ingestFile(directory, record.id, original, 'image', 'photo');
  const profilePath = path.join(directory, 'library', record.id, 'model.3mf'); fs.writeFileSync(profilePath, 'owned-model-file');
  const model = service.store.updateModel(record.id, { title: '删除测试模型', status: 'collected', description: '说明', license: 'standard', authorship: 'original',
    assets: [asset], coverId: asset.id, nexprintImageIds: [], profiles: [{ id: 'profile', name: '测试配置', file: { path: profilePath, sha256: 'profile-hash' } }] });
  return { directory, service, store: service.store, model, asset, profilePath, original };
}
test('模型放入应用回收站后文件完整保留，重启后可恢复', t => {
  const { directory, service, model, asset, profilePath } = setup(t);
  assert.ok(service.removeModel(model.id, { mode: 'trash' }).deletedAt);
  assert.ok(fs.existsSync(asset.path)); assert.ok(fs.existsSync(profilePath));
  const restarted = new Store(directory);
  assert.ok(restarted.model(model.id, { includeDeleted: true }).deletedAt);
  assert.equal(restarted.restoreModel(model.id).assets[0].id, asset.id);
});
test('模型彻底删除清理模型文件、下载缓存和关联截图，保留导入原件及其他模型', t => {
  const { directory, service, store, model, asset, profilePath, original } = setup(t);
  const downloads = path.join(directory, 'downloads', model.id); fs.mkdirSync(downloads, { recursive: true });
  fs.writeFileSync(path.join(downloads, 'image-1'), 'cached');
  const evidence = path.join(directory, 'evidence'); fs.mkdirSync(evidence);
  fs.writeFileSync(path.join(evidence, '123-saved-task-one.png'), 'screen');
  fs.writeFileSync(path.join(evidence, '123-source-7003.png'), 'source-screen');
  fs.writeFileSync(path.join(evidence, '123-other.png'), 'other-screen');
  const other = store.addModel('https://makerworld.com.cn/zh/models/7004-other');
  store.mutate(state => state.tasks.push({ id: 'task-one', modelId: model.id, status: 'saved', screenshot: '123-saved-task-one.png' }));
  assert.throws(() => service.removeModel(model.id, { mode: 'permanent' }), /请确认/);
  assert.ok(fs.existsSync(asset.path));
  service.removeModel(model.id);
  const result = service.removeModel(model.id, { mode: 'permanent', confirmPermanent: true });
  assert.equal(result.permanentlyDeleted, true);
  assert.throws(() => store.model(model.id, { includeDeleted: true }), /未找到/);
  assert.throws(() => store.task('task-one'), /未找到/);
  for (const file of [asset.path, profilePath, path.join(downloads, 'image-1'), path.join(evidence, '123-saved-task-one.png'), path.join(evidence, '123-source-7003.png')]) assert.equal(fs.existsSync(file), false);
  assert.ok(fs.existsSync(original)); assert.ok(fs.existsSync(path.join(evidence, '123-other.png')));
  assert.equal(store.model(other.id).id, other.id);
  assert.throws(() => service.restoreModel(model.id), /未找到/);
});
test('彻底删除保留其他模型和回收站图片仍引用的共用文件', t => {
  const { service, store, model, asset } = setup(t);
  const other = store.addModel('https://makerworld.com.cn/zh/models/7004-shared');
  store.updateModel(other.id, { trashedAssets: [{ ...asset, path: process.platform === 'win32' ? asset.path.toUpperCase() : asset.path, id: 'shared-copy', deletedAt: new Date().toISOString() }] });
  const result = service.removeModel(model.id, { mode: 'permanent', confirmPermanent: true });
  assert.equal(result.retainedSharedFiles, 1); assert.ok(fs.existsSync(asset.path));
  assert.equal(store.model(other.id).trashedAssets.length, 1);
});
test('图片直接彻底删除，清理库文件和对应下载缓存，需要明确确认', t => {
  const { directory, service, store, model, asset, original, profilePath } = setup(t);
  const downloads = path.join(directory, 'downloads', model.id); fs.mkdirSync(downloads, { recursive: true });
  const cache = path.join(downloads, 'image-1'); fs.copyFileSync(original, cache);
  store.updateModel(model.id, { assets: [{ ...asset, name: 'image-1', sourceUrl: 'https://makerworld.bblmw.cn/model/cover.png' }] });
  assert.throws(() => service.edit(model.id, { permanentAssetIds: [asset.id] }), /请确认/);
  const result = service.edit(model.id, { permanentAssetIds: [asset.id], confirmPermanent: true });
  assert.equal(result.assets.length, 0); assert.equal(result.trashedAssets.length, 0); assert.equal(result.coverId, null);
  assert.equal(fs.existsSync(asset.path), false); assert.equal(fs.existsSync(cache), false);
  assert.ok(fs.existsSync(original)); assert.ok(fs.existsSync(profilePath));
  assert.throws(() => service.edit(model.id, { restoredAssetIds: [asset.id] }), /图片删除后无法从应用恢复/);
});
test('3MF 配置删除需要确认，配置记录与本地文件一起移除', t => {
  const { service, store, model, asset, profilePath, original } = setup(t);
  assert.throws(() => service.edit(model.id, { removedProfileIds: ['profile'] }), /请确认彻底删除/);
  assert.ok(fs.existsSync(profilePath));
  const result = service.edit(model.id, { removedProfileIds: ['profile'], confirmPermanent: true });
  assert.equal(result.profiles.length, 0);
  assert.equal(fs.existsSync(profilePath), false);
  assert.ok(fs.existsSync(asset.path));
  assert.ok(fs.existsSync(original));
});
test('其他模型引用同一 3MF 文件时保留该文件', t => {
  const { service, store, model, profilePath } = setup(t);
  const other = store.addModel('https://makerworld.com.cn/zh/models/7004-shared-profile');
  store.updateModel(other.id, { profiles: [{ ...model.profiles[0], id: 'other-profile' }] });
  service.edit(model.id, { removedProfileIds: ['profile'], confirmPermanent: true });
  assert.ok(fs.existsSync(profilePath));
  assert.equal(store.model(other.id).profiles[0].id, 'other-profile');
  service.edit(other.id, { removedProfileIds: ['other-profile'], confirmPermanent: true });
  assert.equal(fs.existsSync(profilePath), false);
});
test('任务彻底删除只清理任务和专用截图，模型素材保留', async t => {
  const { directory, service, store, model, asset, profilePath } = setup(t);
  const evidence = path.join(directory, 'evidence'); fs.mkdirSync(evidence);
  const image = path.join(evidence, '123-saved-old-task.png'); fs.writeFileSync(image, 'task-screen');
  store.mutate(state => state.tasks.push({ id: 'old-task', modelId: model.id, status: 'saved', screenshot: path.basename(image) }));
  assert.ok((await service.queue.remove('old-task')).deletedAt);
  const result = await service.queue.remove('old-task', { mode: 'permanent', confirmPermanent: true });
  assert.equal(result.permanentlyDeleted, true); assert.equal(fs.existsSync(image), false);
  assert.ok(fs.existsSync(asset.path)); assert.ok(fs.existsSync(profilePath));
  assert.throws(() => service.queue.restore('old-task'), /未找到/);
});
test('采集或平台保存期间拒绝彻底删除，文件与记录保持完整', async t => {
  const { service, store, model, asset } = setup(t);
  service.collecting = true;
  assert.throws(() => service.removeModel(model.id, { mode: 'permanent', confirmPermanent: true }), /正在读取/);
  service.collecting = false;
  store.mutate(state => state.tasks.push({ id: 'submitting-task', modelId: model.id, status: 'submitting' }));
  assert.throws(() => service.removeModel(model.id, { mode: 'permanent', confirmPermanent: true }), /未完成/);
  await assert.rejects(service.queue.remove('submitting-task', { mode: 'permanent', confirmPermanent: true }), /正在保存/);
  assert.ok(store.model(model.id)); assert.ok(store.task('submitting-task')); assert.ok(fs.existsSync(asset.path));
});
test('准备中的任务彻底删除等待中断收尾，异步结果不会写回已移除记录', async t => {
  const { store, model } = setup(t); let rejectPrepare;
  const queue = new TaskQueue(store, {
    prepare: async () => new Promise((_resolve, reject) => { rejectPrepare = reject; }),
    cancel: async () => { rejectPrepare(new Error('page closed')); },
  });
  const [task] = queue.enqueue([model.id], ['nexprint']);
  await new Promise(resolve => setImmediate(resolve));
  await queue.remove(task.id, { mode: 'permanent', confirmPermanent: true });
  await new Promise(resolve => setImmediate(resolve));
  assert.throws(() => store.task(task.id), /未找到/); assert.equal(queue.busy, false);
});
test('删除状态写入失败时回滚所有文件，保留原记录', t => {
  const { store, model, asset, profilePath } = setup(t);
  const mutate = store.mutate;
  store.mutate = () => { throw new Error('simulated disk write failure'); };
  try { assert.throws(() => store.purgeModel(model.id), /disk write failure/); }
  finally { store.mutate = mutate; }
  assert.ok(store.model(model.id)); assert.ok(fs.existsSync(asset.path)); assert.ok(fs.existsSync(profilePath));
  assert.deepEqual(fs.readdirSync(path.join(store.directory, '.purge')), []);
});
test('文件清理失败不伪报完成，重启后继续清理已提交的删除事务', t => {
  const { directory, store, model, asset } = setup(t);
  const unlink = fs.unlinkSync;
  fs.unlinkSync = file => {
    if (path.basename(String(file)) === '0') { const error = new Error('simulated file busy'); error.code = 'EBUSY'; throw error; }
    return unlink(file);
  };
  try { assert.throws(() => store.purgeModel(model.id), /文件清理未完成/); }
  finally { fs.unlinkSync = unlink; }
  assert.throws(() => store.model(model.id), /未找到/);
  assert.equal(store.state.pendingPurges.length, 1); assert.equal(fs.existsSync(asset.path), false);
  const restarted = new Store(directory);
  assert.deepEqual(restarted.state.pendingPurges, []); assert.deepEqual(restarted.fileCleanupErrors, []);
  assert.deepEqual(fs.readdirSync(path.join(directory, '.purge')), []);
});
test('重启恢复尚未提交的文件移动；拒绝目录联接和越界删除', t => {
  const { directory, store, model, asset } = setup(t);
  const stage = path.join(directory, '.purge', 'interrupted-delete'); fs.mkdirSync(stage, { recursive: true });
  const staged = path.join(stage, '0');
  fs.writeFileSync(path.join(stage, 'manifest.json'), JSON.stringify({ version: 1, files: [{ source: asset.path, staged }] }));
  fs.renameSync(asset.path, staged);
  const restarted = new Store(directory); assert.ok(fs.existsSync(asset.path)); assert.ok(restarted.model(model.id));
  const external = path.join(directory, 'outside-library'); fs.mkdirSync(external);
  const keep = path.join(external, 'keep.txt'); fs.writeFileSync(keep, 'do not delete');
  fs.symlinkSync(external, path.join(directory, 'library', model.id, 'linked'), 'junction');
  assert.throws(() => restarted.purgeModel(model.id), /符号链接|联接/);
  assert.ok(fs.existsSync(keep)); assert.ok(fs.existsSync(asset.path)); assert.ok(restarted.model(model.id));
  assert.ok(store.model(model.id));
});
test('清单写入前中断留下的空目录可自动清理，不伪报文件丢失', t => {
  const { directory, model, asset } = setup(t);
  fs.mkdirSync(path.join(directory, '.purge', 'empty-interrupted-delete'), { recursive: true });
  const restarted = new Store(directory);
  assert.ok(restarted.model(model.id)); assert.ok(fs.existsSync(asset.path));
  assert.deepEqual(restarted.fileCleanupErrors, []);
  assert.deepEqual(fs.readdirSync(path.join(directory, '.purge')), []);
});
test('彻底删除 HTTP 接口校验会话和确认参数，删除后无法恢复', async t => {
  const { service, store, model, asset, directory } = setup(t);
  const server = await startServer({ directory, service }); t.after(() => server.close());
  const html = await (await fetch(server.url)).text(), token = html.match(/name="model-sync-token" content="([a-f0-9]+)"/)[1];
  const body = JSON.stringify({ id: model.id, mode: 'permanent', confirmPermanent: true });
  assert.equal((await fetch(server.url + '/api/models/delete', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body })).status, 403);
  const headers = { 'Content-Type': 'application/json', 'X-Model-Sync-Token': token };
  assert.equal((await fetch(server.url + '/api/models/delete', { method: 'POST', headers, body: JSON.stringify({ id: model.id, mode: 'permanent' }) })).status, 400);
  assert.ok(store.model(model.id)); assert.ok(fs.existsSync(asset.path));
  const deleted = await fetch(server.url + '/api/models/delete', { method: 'POST', headers, body });
  assert.equal(deleted.status, 200); assert.equal((await deleted.json()).permanentlyDeleted, true);
  assert.equal(fs.existsSync(asset.path), false);
  assert.equal((await fetch(server.url + '/api/models/restore', { method: 'POST', headers, body: JSON.stringify({ id: model.id }) })).status, 400);
});
