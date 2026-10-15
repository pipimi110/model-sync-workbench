import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { _electron } from 'playwright';
import { startServer } from '../src/server.mjs';
import { Service } from '../src/service.mjs';

test('真实桌面界面：模型删除恢复、图片删除撤销、实拍开关及保存持久化', { timeout: 60000 }, async t => {
  const base = path.resolve('artifacts/test-runs'); fs.mkdirSync(base, { recursive: true });
  const directory = fs.mkdtempSync(path.join(base, 'library-ui-'));
  const service = new Service(path.join(directory, 'data'), { browser: { close: async () => {} } });
  const record = service.store.addModel('https://makerworld.com.cn/zh/models/7001-ui-test');
  const roles = ['unknown', 'render', 'diagram'];
  const assets = roles.map((role, index) => {
    const filename = path.join(service.store.directory, 'library', record.id, `image-${index}.png`); fs.mkdirSync(path.dirname(filename), { recursive: true });
    const bytes = Buffer.concat([Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aO1sAAAAASUVORK5CYII=', 'base64'), Buffer.from([index])]);
    fs.writeFileSync(filename, bytes);
    return { id: `picture-${index}`, name: `图片${index + 1}.png`, path: filename, mime: 'image/png', role, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
  });
  const profilePath = path.join(service.store.directory, 'library', record.id, 'fixture.3mf');
  fs.mkdirSync(path.dirname(profilePath), { recursive: true }); fs.writeFileSync(profilePath, '3mf profile fixture');
  const model = service.store.updateModel(record.id, { title: '界面验收模型', description: '删除与批量确认的隔离测试资料', status: 'collected', assets, coverId: assets[0].id,
    profiles: [{ id: 'profile-ui', name: '测试打印配置', file: { name: 'fixture.3mf', path: profilePath, bytes: 20, sha256: 'profile-ui-hash', geometryCount: 1 } }] });
  service.store.addModel('https://makerworld.com.cn/zh/models/7002-other');
  service.store.mutate(state => state.tasks.push({ id: 'saved-ui', modelId: model.id, status: 'saved', target: 'nexprint', mode: 'draft', updatedAt: new Date().toISOString(), result: { url: 'https://www.nexprint.cn/model/test' } }));
  const server = await startServer({ directory: service.store.directory, service });
  const env = { ...process.env, MODELPORT_DOM_TEST_DATA: path.join(directory, 'shell'), MODELPORT_DOM_TEST_VISIBLE: '1' }; delete env.ELECTRON_RUN_AS_NODE;
  let app;
  t.after(async () => { await app?.close(); await server.close(); assert.equal(path.dirname(fs.realpathSync(directory)), fs.realpathSync(base)); fs.rmSync(directory, { recursive: true, force: true }); });
  app = await _electron.launch({ executablePath: createRequire(import.meta.url)('electron'), args: ['test/fixtures/makerworld-dom.cjs'], env, timeout: 20000 });
  const page = await app.firstWindow(); await page.setViewportSize({ width: 1420, height: 950 });
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto(server.url);
  const card = () => page.locator(`.model-card[data-model-id="${model.id}"]`);
  try { await card().waitFor({ timeout: 5000 }); } catch { throw new Error(`测试模型卡片未渲染；页面错误：${errors.join(' | ')}；页面内容：${(await page.locator('body').innerText()).slice(0, 500)}`); }
  const evidence = path.resolve('artifacts/library-ui'); fs.mkdirSync(evidence, { recursive: true });

  await t.test('平台与账号页展示 ModelPort 开发者版权声明', async () => {
    await page.getByRole('button', { name: /平台与账号/ }).click();
    await page.getByRole('heading', { name: '开发者声明', exact: true }).waitFor();
    assert.match(await page.locator('#main').innerText(), /ModelPort 作者：罗生门/);
    assert.match(await page.locator('#main').innerText(), /版权所有 © 2026 罗生门/);
    assert.match(await page.locator('footer').innerText(), /作者：罗生门.*版权所有 © 2026 罗生门/);
    await page.getByRole('button', { name: /模型库/ }).click();
    await card().waitFor();
  });

  await t.test('确认删除后从当前库移除，选择状态清除；回收列表可恢复模型及任务', async () => {
    await card().locator('.select-model').check();
    await card().getByRole('button', { name: '删除', exact: true }).click();
    await page.locator('#modal[open]').waitFor();
    await page.screenshot({ path: path.join(evidence, 'model-delete.png') });
    await page.getByRole('button', { name: '确认删除模型', exact: true }).click();
    await page.locator('#modal').waitFor({ state: 'hidden' });
    await card().waitFor({ state: 'detached' });
    assert.equal(await page.locator('.selected-bar').count(), 0);
    assert.ok(service.store.task('saved-ui').deletedAt);
    await page.getByRole('button', { name: '回收站（1）', exact: true }).click();
    await card().getByRole('button', { name: '恢复模型', exact: true }).click();
    await page.getByRole('heading', { name: '没有已删除的模型', exact: true }).waitFor();
    assert.equal(service.store.model(model.id).deletedAt, null);
    assert.equal(service.store.task('saved-ui').deletedAt, null);
    await page.getByRole('button', { name: '返回模型库', exact: true }).click();
    await card().getByRole('button', { name: '管理资料 ↗', exact: true }).click();
  });

  await t.test('3MF 配置彻底删除需要确认，取消编辑保留文件，保存后删除文件与记录', async () => {
    const profile = page.locator('.profile-row[data-profile-id="profile-ui"]');
    await profile.getByRole('button', { name: '彻底删除 3MF 配置 测试打印配置', exact: true }).click();
    assert.equal(await page.getByRole('button', { name: '保存资料', exact: true }).isDisabled(), true);
    assert.ok(fs.existsSync(profilePath));
    await page.locator('#modal').getByRole('button', { name: '关闭', exact: true }).last().click();
    assert.equal(service.store.model(model.id).profiles.length, 1); assert.ok(fs.existsSync(profilePath));
    await card().getByRole('button', { name: '管理资料 ↗', exact: true }).click();
    await page.locator('.profile-row[data-profile-id="profile-ui"] [data-action="delete-profile"]').click();
    await page.locator('#confirm-permanent-delete').check();
    await page.getByRole('button', { name: '保存资料', exact: true }).click();
    await page.locator('#modal').waitFor({ state: 'hidden' });
    assert.equal(service.store.model(model.id).profiles.length, 0); assert.equal(fs.existsSync(profilePath), false);
    await card().getByRole('button', { name: '管理资料 ↗', exact: true }).click();
  });

  await t.test('开关可批量设置与还原，单张手动修改后不继续强制覆盖', async () => {
    await page.locator('#edit-title').fill('保留未保存的名称');
    const toggle = page.getByRole('switch', { name: '全部设为实拍', exact: true });
    await toggle.check();
    assert.deepEqual(await page.locator('.asset-role').evaluateAll(elements => elements.map(element => element.value)), ['photo', 'photo', 'photo']);
    assert.deepEqual(service.store.model(model.id).assets.map(asset => asset.role), roles);
    await toggle.uncheck();
    assert.deepEqual(await page.locator('.asset-role').evaluateAll(elements => elements.map(element => element.value)), roles);
    await toggle.check();
    await page.locator('.asset-role').nth(1).selectOption('diagram');
    assert.equal(await toggle.isChecked(), false);
    assert.equal(await page.locator('.asset-role').nth(0).inputValue(), 'photo');
    await toggle.check();
    await page.locator(`.nexprint-image-choice[data-id="${assets[1].id}"]`).uncheck();
    await page.locator(`.nexprint-image-choice[data-id="${assets[2].id}"]`).uncheck();
    assert.equal(await page.locator('#nexprint-image-count').textContent(), '0/9');
    await page.locator(`.nexprint-image-choice[data-id="${assets[2].id}"]`).check();
    assert.equal(await page.locator('#nexprint-image-count').textContent(), '1/9');
  });

  await t.test('删除封面不丢失其他编辑，撤销恢复；保存后只保留剩余图片与新封面', async () => {
    const first = page.locator(`.image-edit[data-asset-id="${assets[0].id}"]`);
    await first.getByRole('button', { name: '删除图片 图片1.png', exact: true }).click();
    assert.equal(await first.isVisible(), false);
    assert.equal(await page.locator('#edit-title').inputValue(), '保留未保存的名称');
    assert.equal(await page.locator('input[name="edit-cover"]:checked').count(), 0);
    assert.equal(service.store.model(model.id).assets.length, 3);
    await page.getByRole('button', { name: '撤销删除', exact: true }).click();
    assert.equal(await first.isVisible(), true);
    assert.equal(await page.locator(`input[name="edit-cover"][value="${assets[0].id}"]`).isChecked(), true);
    await first.getByRole('button', { name: '删除图片 图片1.png', exact: true }).click();
    await page.locator(`input[name="edit-cover"][value="${assets[1].id}"]`).check();
    await page.locator('#confirm-permanent-delete').check();
    await page.locator('.image-tools').scrollIntoViewIfNeeded();
    await page.locator('.image-edit:not([hidden]) [data-action="delete-image"]').last().scrollIntoViewIfNeeded();
    await page.locator('#modal').evaluate(element => { element.scrollTop = element.scrollHeight; });
    await page.screenshot({ path: path.join(evidence, 'image-editor.png') });
    await page.getByRole('button', { name: '保存资料', exact: true }).click();
    await page.locator('#modal').waitFor({ state: 'hidden' });
    const saved = service.store.model(model.id);
    assert.equal(saved.title, '保留未保存的名称');
    assert.deepEqual(saved.assets.map(asset => asset.id), [assets[1].id, assets[2].id]);
    assert.ok(saved.assets.every(asset => asset.role === 'photo'));
    assert.equal(saved.coverId, assets[1].id);
    assert.deepEqual(saved.nexprintImageIds, [assets[2].id]);
    assert.deepEqual(saved.excludedAssetHashes, [assets[0].sha256]);
    assert.equal(fs.existsSync(assets[0].path), false);
  });

  await t.test('图片删除须确认；取消编辑保留文件', async () => {
    await card().getByRole('button', { name: '管理资料 ↗', exact: true }).click();
    await page.locator('.image-edit').first().getByRole('button', { name: /^删除图片/ }).click();
    await page.locator('#modal').getByRole('button', { name: '关闭', exact: true }).last().click();
    assert.equal(service.store.model(model.id).assets.length, 2);
    assert.ok(fs.existsSync(assets[1].path));
  });
  await t.test('采集期间打开编辑窗口，采集结束后自动恢复保存并保留未保存修改', async () => {
    service.collecting = true;
    await page.reload(); await card().waitFor();
    await card().getByRole('button', { name: '管理资料 ↗', exact: true }).click();
    const save = page.getByRole('button', { name: '保存资料', exact: true });
    assert.equal(await save.isDisabled(), true);
    await page.locator('#edit-title').fill('采集等待期间编辑的名称');
    service.store.updateModel(model.id, { status: 'collected', profiles: [{ id: 'profile-new', name: '刚下载完成的配置' }] });
    service.collecting = false;
    await page.waitForFunction(() => !document.querySelector('[data-action="save-edit"]').disabled, null, { timeout: 10000 });
    assert.equal(await page.locator('#edit-title').inputValue(), '采集等待期间编辑的名称');
    await save.click(); await page.locator('#modal').waitFor({ state: 'hidden' });
    assert.equal(service.store.model(model.id).title, '采集等待期间编辑的名称');
    assert.equal(service.store.model(model.id).profiles[0].id, 'profile-new');
  });

  await t.test('编辑窗口随新采集任务禁用保存；来源资料变化时保留草稿并明确提示重新载入', async () => {
    await card().getByRole('button', { name: '管理资料 ↗', exact: true }).click();
    await page.locator('#edit-title').fill('需要保留的未保存草稿');
    service.collecting = true;
    await page.waitForFunction(() => document.querySelector('[data-action="save-edit"]').disabled, null, { timeout: 10000 });
    service.store.updateModel(model.id, { title: '来源新名称' }); service.collecting = false;
    await page.locator('#edit-reload').waitFor({ state: 'visible', timeout: 10000 });
    assert.equal(await page.locator('#edit-title').inputValue(), '需要保留的未保存草稿');
    assert.equal(await page.getByRole('button', { name: '保存资料', exact: true }).isDisabled(), true);
    await page.getByRole('button', { name: '重新载入（放弃当前修改）', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('#edit-title').value === '来源新名称');
    assert.equal(await page.locator('#edit-title').inputValue(), '来源新名称');
    assert.equal(await page.getByRole('button', { name: '保存资料', exact: true }).isEnabled(), true);
    await page.locator('#modal').getByRole('button', { name: '关闭', exact: true }).last().click();
  });
  await t.test('图片删除始终彻底删除；保存前确认且取消编辑保留文件', async () => {
    await card().getByRole('button', { name: '管理资料 ↗', exact: true }).click();
    assert.equal(await page.locator('.image-trash-grid').count(), 0);
    let image = page.locator('.image-edit[data-asset-id="' + assets[1].id + '"]');
    await image.getByRole('button', { name: '删除图片 ' + assets[1].name, exact: true }).click();
    assert.equal(await page.getByRole('button', { name: '保存资料', exact: true }).isDisabled(), true);
    assert.ok(fs.existsSync(assets[1].path));
    await page.locator('#modal').getByRole('button', { name: '关闭', exact: true }).last().click();
    assert.equal(service.store.model(model.id).assets.length, 2); assert.ok(fs.existsSync(assets[1].path));
    await card().getByRole('button', { name: '管理资料 ↗', exact: true }).click();
    image = page.locator('.image-edit[data-asset-id="' + assets[1].id + '"]');
    await image.getByRole('button', { name: '删除图片 ' + assets[1].name, exact: true }).click();
    await page.locator('#confirm-permanent-delete').check();
    await page.locator('#permanent-delete-confirmation').scrollIntoViewIfNeeded();
    await page.screenshot({ path: path.join(evidence, 'image-permanent-confirmation.png') });
    await page.getByRole('button', { name: '保存资料', exact: true }).click();
    await page.locator('#modal').waitFor({ state: 'hidden' });
    assert.equal(fs.existsSync(assets[1].path), false);
    assert.equal(service.store.model(model.id).assets.length, 1);
  });
  await t.test('任务删除可选择回收站或彻底删除，永久删除保留模型文件', async () => {
    const evidenceFile = path.join(service.store.directory, 'evidence', '123-saved-saved-ui.png');
    fs.mkdirSync(path.dirname(evidenceFile), { recursive: true }); fs.writeFileSync(evidenceFile, 'disposable screenshot');
    await page.locator('[data-view="tasks"]').click();
    await page.getByRole('button', { name: '删除任务', exact: true }).click();
    await page.getByRole('button', { name: '确认删除任务', exact: true }).click();
    await page.locator('#modal').waitFor({ state: 'hidden' });
    assert.ok(service.store.task('saved-ui').deletedAt); assert.ok(fs.existsSync(evidenceFile));
    await page.getByRole('button', { name: '任务回收站（1）', exact: true }).click();
    await page.getByRole('button', { name: '恢复记录', exact: true }).click();
    await page.getByRole('button', { name: '返回同步任务', exact: true }).click();
    await page.getByRole('button', { name: '删除任务', exact: true }).click();
    await page.locator('input[name="delete-mode"][value="permanent"]').check();
    assert.equal(await page.getByRole('button', { name: '确认彻底删除', exact: true }).isDisabled(), true);
    await page.locator('#delete-permanent-check').check();
    await page.getByRole('button', { name: '确认彻底删除', exact: true }).click();
    await page.locator('#modal').waitFor({ state: 'hidden' });
    assert.throws(() => service.store.task('saved-ui'), /未找到/); assert.equal(fs.existsSync(evidenceFile), false);
    assert.equal(fs.existsSync(assets[1].path), false); assert.ok(fs.existsSync(assets[2].path));
    await page.locator('.nav[data-view="library"]').click();
  });
  await t.test('模型回收站可再次彻底删除，二次确认前不删文件，确认后不可恢复', async () => {
    await card().getByRole('button', { name: '删除', exact: true }).click();
    await page.getByRole('button', { name: '确认删除模型', exact: true }).click();
    await page.locator('#modal').waitFor({ state: 'hidden' });
    await page.getByRole('button', { name: '回收站（1）', exact: true }).click();
    await card().getByRole('button', { name: '彻底删除', exact: true }).click();
    const permanent = page.getByRole('button', { name: '确认彻底删除', exact: true });
    assert.equal(await permanent.isDisabled(), true); assert.ok(fs.existsSync(assets[2].path));
    await page.locator('#delete-permanent-check').check();
    await page.screenshot({ path: path.join(evidence, 'model-permanent-confirmation.png') });
    await permanent.click(); await page.locator('#modal').waitFor({ state: 'hidden' });
    await card().waitFor({ state: 'detached' });
    assert.throws(() => service.store.model(model.id, { includeDeleted: true }), /未找到/);
    assert.equal(fs.existsSync(assets[1].path), false); assert.equal(fs.existsSync(assets[2].path), false);
    assert.equal(service.store.state.models.length, 1);
  });
  assert.deepEqual(errors, []);
});
