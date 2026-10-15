import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Service } from '../src/service.mjs';
import { Store } from '../src/store.mjs';
import { modelFingerprint } from '../src/domain.mjs';
import AdmZip from 'adm-zip';
import { collectMakerWorld } from '../src/adapters/makerworld.mjs';
import { ingestFile } from '../src/assets.mjs';

function setup(t) {
  const base = path.resolve('artifacts/test-runs'); fs.mkdirSync(base, { recursive: true });
  const directory = fs.mkdtempSync(path.join(base, 'library-'));
  t.after(() => { assert.equal(path.dirname(fs.realpathSync(directory)), fs.realpathSync(base)); fs.rmSync(directory, { recursive: true, force: true }); });
  const service = new Service(directory);
  const record = service.store.addModel('https://makerworld.com.cn/zh/models/7001-library-test');
  const model = service.store.updateModel(record.id, { title: '资料管理测试', status: 'collected', description: '说明', coverId: 'a',
    assets: [{ id: 'a', name: 'cover.png', role: 'unknown', sha256: 'hash-a' }, { id: 'b', name: 'diagram.png', role: 'diagram', sha256: 'hash-b' }] });
  return { service, model, directory };
}

test('模型删除和恢复原子保留资料及平台链接，先前单独删除的任务保持删除', t => {
  const { service, model, directory } = setup(t);
  service.store.mutate(state => state.tasks.push(
    { id: 'saved', modelId: model.id, status: 'saved', result: { url: 'https://www.nexprint.cn/model/test' } },
    { id: 'old-trash', modelId: model.id, status: 'cancelled', deletedAt: '2026-01-01' }));
  assert.ok(service.removeModel(model.id).deletedAt);
  assert.throws(() => service.store.model(model.id), /模型已删除/);
  assert.throws(() => service.edit(model.id, { title: '不可编辑' }), /模型已删除/);
  assert.ok(service.store.task('saved').deletedAt);
  assert.equal(service.store.task('saved').result.url, 'https://www.nexprint.cn/model/test');
  assert.throws(() => service.queue.restore('saved'), /模型已删除/);
  const restoredStore = new Store(directory);
  assert.ok(restoredStore.model(model.id, { includeDeleted: true }).deletedAt);
  const restored = restoredStore.restoreModel(model.id);
  assert.equal(restored.deletedAt, null); assert.equal(restored.assets.length, 2);
  assert.equal(restoredStore.task('saved').deletedAt, null);
  assert.equal(restoredStore.task('old-trash').deletedAt, '2026-01-01');
});

test('采集与未完成任务阻止模型删除，阻止发生时资料和任务不被部分修改', t => {
  const { service, model } = setup(t);
  service.collecting = true;
  assert.throws(() => service.removeModel(model.id), /正在读取/);
  service.collecting = false;
  for (const status of ['queued', 'running', 'cancelling', 'ready', 'submitting', 'deleting']) {
    service.store.mutate(state => { state.tasks = [{ id: 'busy', modelId: model.id, status }]; });
    assert.throws(() => service.removeModel(model.id), /未完成的同步任务/);
    assert.equal(service.store.model(model.id).deletedAt, undefined);
    assert.equal(service.store.task('busy').deletedAt, undefined);
  }
});

test('重新添加已删除模型恢复原记录，避免重复导入及丢失素材', t => {
  const { service, model } = setup(t);
  service.removeModel(model.id);
  const [restored] = service.add([model.source.url]);
  assert.equal(restored.id, model.id); assert.equal(restored.deletedAt, null);
  assert.equal(restored.assets.length, 2); assert.equal(service.store.snapshot().models.length, 1);
});

test('删除封面原子清除引用并记录排除哈希，可同时删除图片、改用途和选新封面', t => {
  const { service, model } = setup(t);
  const result = service.edit(model.id, { expectedRevision: model.revision, removedAssetIds: ['a'], confirmPermanent: true, assetRoles: { b: 'photo' }, coverId: 'b' });
  assert.deepEqual(result.assets.map(asset => asset.id), ['b']);
  assert.equal(result.assets[0].role, 'photo'); assert.equal(result.coverId, 'b');
  assert.deepEqual(result.excludedAssetHashes, ['hash-a']);
  assert.notEqual(modelFingerprint(model), modelFingerprint(result));
  assert.throws(() => service.edit(model.id, { removedAssetIds: ['foreign'] }), /图片不存在/);
  assert.throws(() => service.edit(model.id, { assetRoles: { foreign: 'photo' } }), /图片不存在/);
  assert.throws(() => service.edit(model.id, { expectedRevision: model.revision, removedAssetIds: ['b'] }), /资料已变化/);
  const empty = service.edit(model.id, { removedAssetIds: ['b'], confirmPermanent: true });
  assert.equal(empty.coverId, null); assert.equal(empty.assets.length, 0);
});

test('删除图片仍引用该图为封面时拒绝整个修改，采集中和上传中也不可改图', t => {
  const { service, model } = setup(t);
  assert.throws(() => service.edit(model.id, { removedAssetIds: ['a'], confirmPermanent: true, coverId: 'a' }), /封面不存在或已删除/);
  assert.equal(service.store.model(model.id).assets.length, 2);
  service.collecting = true;
  assert.throws(() => service.edit(model.id, { removedAssetIds: ['a'] }), /正在读取/);
  service.collecting = false;
  service.store.mutate(state => state.tasks.push({ id: 'upload', modelId: model.id, status: 'running' }));
  assert.throws(() => service.edit(model.id, { removedAssetIds: ['a'] }), /正在上传/);
  assert.equal(service.store.model(model.id).coverId, 'a');
});

test('NexPrint 图片选择保存在模型资料中并拒绝封面、重复项和超过九张', t => {
  const { service, model } = setup(t);
  const assets = [{ id: 'cover', name: 'cover.png', role: 'photo', sha256: 'cover' },
    ...Array.from({ length: 10 }, (_value, index) => ({ id: `gallery-${index}`, name: `gallery-${index}.png`, role: 'photo', sha256: `gallery-${index}` }))];
  service.store.updateModel(model.id, { assets, coverId: 'cover' });
  const selected = assets.slice(1, 10).map(asset => asset.id);
  assert.deepEqual(service.edit(model.id, { nexprintImageIds: selected }).nexprintImageIds, selected);
  assert.throws(() => service.edit(model.id, { nexprintImageIds: [...selected, 'gallery-9'] }), /至多 9 张/);
  assert.throws(() => service.edit(model.id, { nexprintImageIds: ['cover'] }), /至多 9 张非封面/);
  assert.throws(() => service.edit(model.id, { nexprintImageIds: ['gallery-1', 'gallery-1'] }), /至多 9 张非封面图片/);
});


test('修改 NexPrint 图片选择会废弃旧的待确认表单，重试采用新选择', async t => {
  const { service, model: base } = setup(t); let closed = 0;
  const model = service.store.updateModel(base.id, { status: 'collected', license: 'standard', authorship: 'original',
    assets: base.assets.map(asset => ({ ...asset, role: asset.id === 'a' ? 'photo' : asset.role, path: `/${asset.name}` })),
    profiles: [{ id: 'profile', name: '打印配置', file: { path: '/model.3mf', sha256: 'profile-hash' } }] });
  service.queue.executor.cancel = async () => { closed++; };
  const fingerprint = modelFingerprint(model);
  service.store.mutate(state => state.tasks.push({ id: 'prepared', modelId: model.id, target: 'nexprint', status: 'ready',
    fingerprint, imageAssetIds: ['b'], progress: 90, uncertain: false }));
  service.queue.stopped = true;
  service.edit(model.id, { nexprintImageIds: [] });
  assert.equal(service.store.task('prepared').status, 'attention');
  assert.deepEqual(service.store.task('prepared').imageAssetIds, []);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(closed, 1);
  service.queue.retry('prepared');
  assert.deepEqual(service.store.task('prepared').imageAssetIds, []);
});

test('重新采集不把已删除图片自动加回，用户主动添加同一文件可恢复图片', async t => {
  const { service, model, directory } = setup(t);
  const bytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aO1sAAAAASUVORK5CYII=', 'base64');
  const file = path.join(directory, 'source.png'); fs.writeFileSync(file, bytes);
  const asset = ingestFile(directory, model.id, file, 'image');
  service.store.updateModel(model.id, { assets: [asset], coverId: asset.id });
  const edited = service.edit(model.id, { removedAssetIds: [asset.id], confirmPermanent: true });
  const downloaded = path.join(directory, 'profile.3mf'), zip = new AdmZip();
  zip.addFile('3D/test.model', Buffer.from('<model><mesh>geometry</mesh></model>')); zip.writeZip(downloaded);
  const page = {
    goto: async () => {}, url: () => `${model.source.url}#profileId-123`,
    waitForFunction: async () => ({ dispose: async () => {}, jsonValue: async () => ({ title: '测试', description: '说明', author: '作者',
      text: '打印配置 (1)', currentProfileId: '123', profileLinks: [], images: ['https://makerworld.bblmw.cn/model/test.png'] }) }),
    locator: () => ({ filter: () => ({ click: async () => {} }) }),
  };
  const browser = { page: async () => page, getContext: async () => ({ request: { get: async () => ({ ok: () => true, body: async () => bytes }) } }),
    downloadFromPage: async trigger => { await trigger(); return { path: downloaded, suggestedFilename: 'profile.3mf' }; }, evidence: async () => 'test.png' };
  const result = await collectMakerWorld(service.store, browser, edited, () => {});
  assert.equal(result.assets.length, 0); assert.deepEqual(result.excludedAssetHashes, [asset.sha256]);
  const attached = service.attach(model.id, [file], 'image');
  assert.equal(attached.assets.length, 1); assert.deepEqual(attached.excludedAssetHashes, []);
});
