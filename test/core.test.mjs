import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import AdmZip from 'adm-zip';
import { Store } from '../src/store.mjs';
import { TaskQueue } from '../src/queue.mjs';
import { Service } from '../src/service.mjs';
import { parseSource, normalizeLicense, profileLinksForModel, modelFingerprint, review, SubmissionUncertain, UserActionRequired } from '../src/domain.mjs';
import { inspect3mf, ingestFile, imageMime } from '../src/assets.mjs';
import { collectMakerWorld, parseMakerWorldText } from '../src/adapters/makerworld.mjs';
import { chooseNexprintFileInput, confirmNexprintCrop, fillText, selectInput, selectNexprintGalleryImages, selectRadioOption, setNexprintLicense, summarizeNexprintUpload, uploadNexprintProfiles, waitNexprintGallery, TargetExecutor } from '../src/adapters/targets.mjs';
import { ReloadableTargetExecutor } from '../src/adapters/reloadable-targets.mjs';
import { ReloadableMakerWorldCollector } from '../src/adapters/reloadable-makerworld.mjs';

const source = 'https://makerworld.com.cn/zh/models/3101479-example#profileId=3651936';
function temporary(t) {
  const base = path.resolve('artifacts/test-runs'); fs.mkdirSync(base, { recursive: true });
  const dir = fs.mkdtempSync(path.join(base, 'core-'));
  t.after(() => { assert.equal(path.dirname(fs.realpathSync(dir)), fs.realpathSync(base)); fs.rmSync(dir, { recursive: true, force: true }); });
  return dir;
}
function readyModel(store) {
  const model = store.addModel(source);
  return store.updateModel(model.id, { title: '风神像', description: '来源说明与底座署名。', license: 'standard', status: 'collected', authorship: 'remix',
    coverId: 'cover', assets: [{ id: 'cover', path: 'photo.jpg', sha256: 'photo', role: 'photo' }],
    profiles: [{ id: '3651936', name: '0.16mm 层高', file: { path: 'model.3mf', sha256: 'model' } }] });
}
const tick = async () => { for (let i = 0; i < 8; i++) await new Promise(resolve => setImmediate(resolve)); };

test('来源 URL 校验拒绝伪域名、账号 URL 和非 HTTPS', () => {
  assert.equal(parseSource(source).id, '3101479'); assert.equal(parseSource(source).profileId, '3651936');
  assert.equal(parseSource(source.replace('profileId=3651936', 'profileId-3651936')).profileId, '3651936');
  for (const u of ['https://makerworld.com.cn.attacker.test/zh/models/1', 'http://makerworld.com.cn/zh/models/1', 'https://makerworld.com.cn/zh/@popko/upload', 'file:///C:/x']) assert.throws(() => parseSource(u));
});
test('配置链接只接受当前模型页面，排除推荐模型的 profileId', () => {
  const modelUrl = 'https://makerworld.com.cn/zh/models/3101479-fengshen#profileId-3651936';
  assert.deepEqual(profileLinksForModel([
    modelUrl,
    'https://makerworld.com.cn/zh/models/2251968-base#profileId-2689774',
  ], modelUrl), [modelUrl]);
});
test('许可匹配不把 CC BY-NC-SA 退化为 BY-NC', () => {
  assert.equal(normalizeLicense('CC BY-NC-SA 4.0'), 'cc-by-nc-sa'); assert.equal(normalizeLicense('CC BY-NC 4.0'), 'cc-by-nc');
  assert.equal(normalizeLicense('Standard Digital File License'), 'standard'); assert.equal(normalizeLicense('unknown'), 'unknown');
});
test('模型重复导入返回相同记录，资料在重启后保留', t => {
  const dir = temporary(t), store = new Store(dir); const a = store.addModel(source), b = store.addModel(source.replace('example', 'renamed'));
  assert.equal(a.id, b.id); store.updateModel(a.id, { title: '测试' }); assert.equal(new Store(dir).model(a.id).title, '测试');
});
test('旧工作空间清除专用浏览器选择并固定使用默认 Chrome', t => {
  const dir = temporary(t), filename = path.join(dir, 'state.json');
  fs.writeFileSync(filename, JSON.stringify({ version: 1, models: [], tasks: [], logs: [], settings: { browser: 'chrome', browserModeMigrated: true } }));
  const store = new Store(dir);
  assert.deepEqual(store.state.settings, {});
  assert.deepEqual(new Store(dir).state.settings, {});
});
test('添加 MakerWorld 链接会自动启动资料采集并记录需要用户处理的情况', async t => {
  const directory = temporary(t);
  const browser = { page: async () => { throw new UserActionRequired('默认 Chrome 的远程调试端点不可用'); } };
  const service = new Service(directory, { browser });
  const [model] = service.add([source]);
  assert.equal(model.source.id, '3101479');
  for (let i = 0; i < 20 && service.collecting; i++) await new Promise(resolve => setImmediate(resolve));
  assert.equal(service.collecting, false);
  assert.equal(service.store.model(model.id).status, 'attention');
  assert.match(service.store.model(model.id).issues[0], /远程调试端点不可用/);
});
test('多配置与图片用途在预览中有明确限制', t => {
  const store = new Store(temporary(t)), model = readyModel(store);
  model.profiles.push({ id: 'p2', file: { path: 'second.3mf', sha256: '2' } });
  assert.equal(review(model, 'creality').blockers.length, 0); assert.ok(review(model, 'creality').warnings.some(w => w.includes('2 个原始文件')));
  model.assets[0].role = 'diagram'; assert.ok(review(model, 'creality').blockers.some(b => b.includes('实拍')));
  model.license = 'unknown'; assert.ok(review(model, 'nexprint').blockers.some(b => b.includes('许可')));
});
test('3MF 校验拒绝 HTML 和空 ZIP，读取喷嘴与层高而不混淆', t => {
  const dir = temporary(t), filename = path.join(dir, 'test.3mf');
  fs.writeFileSync(filename, '<html>login</html>'); assert.throws(() => inspect3mf(filename));
  const zip = new AdmZip(); zip.writeZip(filename); assert.throws(() => inspect3mf(filename));
  zip.addFile('3D/Objects/object_1.model', Buffer.from('<model><mesh>geometry</mesh></model>'));
  zip.addFile('Metadata/project_settings.config', Buffer.from(JSON.stringify({ layer_height: '0.1', nozzle_diameter: ['0.2'] })));
  zip.addFile('Metadata/plate_1.png', Buffer.from('thumbnail')); zip.writeZip(filename);
  const info = inspect3mf(filename); assert.equal(info.geometryCount, 1); assert.equal(info.plateImages, 1);
  assert.equal(info.parameters.layer_height, '0.1'); assert.deepEqual(info.parameters.nozzle_diameter, ['0.2']);
  const file = ingestFile(dir, 'model-id', filename, 'model'); assert.ok(fs.existsSync(file.path)); assert.equal(file.sha256.length, 64);
});
test('WEBP 即使后缀错误也按文件内容识别', () => {
  assert.equal(imageMime(Buffer.from('RIFFabcdWEBPVP8 ')), 'image/webp'); assert.throws(() => imageMime(Buffer.from('<html>')));
});
test('解析源站参数保留 0.16mm 层高，识别配置数', () => {
  const info = parseMakerWorldText('打印配置 (1)\n0.16mm 层高, 2 层墙, 5% 填充\nStandard Digital File License', parseSource(source));
  assert.equal(info.profileCount, 1); assert.equal(info.params.layer_height, '0.16'); assert.equal(info.license, 'standard');
});
test('NexPrint 上传诊断区分处理中、已就绪和明确失败', () => {
  const pending = summarizeNexprintUpload({ inputs: [{ files: ['fengshen.3mf (9931118 bytes)'] }], buttons: [{ text: '模型信息', disabled: true }], progress: ['正在解析模型'] });
  assert.equal(pending.ready, false); assert.match(pending.message, /已选文件/); assert.match(pending.message, /正在解析模型/);
  const ready = summarizeNexprintUpload({ inputs: [{ files: ['fengshen.3mf (9931118 bytes)'] }], buttons: [{ text: '模型信息', disabled: false }] });
  assert.equal(ready.ready, true); assert.equal(ready.error, null);
  const failed = summarizeNexprintUpload({ inputs: [{ files: [] }], buttons: [], errors: ['文件格式不支持'] });
  assert.equal(failed.ready, false); assert.equal(failed.error, '文件格式不支持'); assert.match(failed.message, /格式不支持/);
});
test('NexPrint 等到真实上传入口完成初始化再选择文件，且只发送一次', async () => {
  const state = { selector: null, files: null, clicks: 0, assignments: 0, foreground: false }; let openChooser;
  const trigger = { waitFor: async () => {}, count: async () => 1, click: async () => {
    state.clicks++;
    assert.equal(state.files, null);
    if (state.clicks === 3) openChooser({ setFiles: async files => { state.files = files; state.assignments++; } });
  } };
  const page = {
    bringToFront: async () => { state.foreground = true; },
    locator: selector => { state.selector = selector; return trigger; },
    waitForEvent: name => { assert.equal(name, 'filechooser'); return new Promise(resolve => { openChooser = resolve; }); },
  };
  const paths = ['first.3mf', 'second.3mf'];
  await uploadNexprintProfiles(page, paths, () => {}, { retryMs: 0 });
  assert.equal(state.selector, '.upload-file-uploader .el-upload-dragger');
  assert.equal(state.foreground, true); assert.equal(state.clicks, 3); assert.equal(state.assignments, 1);
  assert.deepEqual(state.files, paths);
});
test('NexPrint 上传入口初始化失败时明确停止，不伪报模型正在解析', async () => {
  const page = { locator: () => ({ waitFor: async () => {}, count: async () => 1, click: async () => {} }),
    waitForEvent: async () => { throw new Error('timeout'); } };
  await assert.rejects(() => uploadNexprintProfiles(page, ['model.3mf'], () => {}, { retryMs: 0 }), /上传控件未完成初始化，未发送模型文件/);
  const selectedOnly = summarizeNexprintUpload({ inputs: [{ files: ['model.3mf'] }], buttons: [{ text: '模型信息', disabled: true }] });
  assert.equal(selectedOnly.started, false); assert.match(selectedOnly.message, /网站尚未显示上传文件/);
  const processing = summarizeNexprintUpload({ inputs: [], queuedFiles: ['model.3mf'], processing: true });
  assert.equal(processing.started, true); assert.match(processing.message, /正在解析模型/);
});
test('NexPrint 图片控件从唯一 file input 的可见上传父级打开选择器', async () => {
  const state = { clicked: false, selector: null, files: null };
  const trigger = { all: async () => [{ isVisible: async () => true, click: async () => { state.clicked = true; } }] };
  const input = { count: async () => 1, locator: (selector) => { assert.equal(selector, 'xpath=../div[@class="el-upload-dragger"]'); return trigger; } };
  const page = {
    locator: selector => { state.selector = selector; return input; },
    waitForEvent: async name => { assert.equal(name, 'filechooser'); return { setFiles: async files => { state.files = files; } }; },
  };
  await chooseNexprintFileInput(page, 'input[type="file"][accept*=".jpeg"]:not([multiple]):not([disabled])', ['cover.webp']);
  assert.equal(state.clicked, true);
  assert.deepEqual(state.files, ['cover.webp']);
});
test('NexPrint 裁剪弹窗延迟出现时必须等到出现、点击、关闭后才继续', async () => {
  const state = { appeared: false, clicked: false, waited: false };
  const button = {
    count: async () => state.appeared ? 1 : 0,
    isVisible: async () => state.appeared && !state.clicked,
    isEnabled: async () => !state.clicked,
    click: async () => { assert.equal(state.appeared, true); state.clicked = true; },
    waitFor: async options => {
      if (options.state === 'visible') { assert.equal(options.timeout, 15000); state.appeared = true; }
      else { assert.deepEqual(options, { state: 'hidden', timeout: 45000 }); state.waited = true; }
    },
  };
  const page = { getByRole: (role, options) => { assert.equal(role, 'button'); assert.deepEqual(options, { name: '好的', exact: true }); return button; } };
  await confirmNexprintCrop(page);
  assert.deepEqual(state, { appeared: true, clicked: true, waited: true });
});
test('NexPrint 裁剪确认在 CDP 可见但不可操作时强制点击并继续等待关闭', async () => {
  const state = { normalClicks: 0, forcedClicks: 0, waited: false };
  const button = {
    count: async () => 1,
    isVisible: async () => !state.forcedClicks,
    isEnabled: async () => !state.forcedClicks,
    click: async options => {
      if (options.force) { state.forcedClicks++; return; }
      state.normalClicks++;
      throw new Error('intercepts pointer events');
    },
    waitFor: async options => { if (options.state === 'hidden') { assert.equal(options.timeout, 45000); state.waited = true; } },
  };
  const page = { getByRole: () => button };
  await confirmNexprintCrop(page);
  assert.deepEqual(state, { normalClicks: 1, forcedClicks: 1, waited: true });
});
test('上传适配器在任务边界热加载，并保留仍打开的准备页面', async t => {
  const directory = temporary(t), modulePath = path.join(directory, 'target-module.mjs');
  const writeVersion = version => fs.writeFileSync(modulePath,
    `export class TargetExecutor { constructor() { this.prepared = new Map(); this.version = ${version}; } async prepare() { return this.version; } async commit() { return this.version * 10; } }`);
  const store = { messages: [], log(message) { this.messages.push(message); } };
  writeVersion(1);
  const executor = new ReloadableTargetExecutor({}, store, { modulePath });
  assert.equal(await executor.prepare(), 1);
  const prepared = executor.executor.prepared;
  prepared.set('task', { page: 'still-open' });
  writeVersion(2);
  assert.equal(await executor.commit(), 20);
  assert.equal(executor.executor.prepared, prepared);
  assert.deepEqual(executor.executor.prepared.get('task'), { page: 'still-open' });
  assert.equal(store.messages.length, 2);
});
test('MakerWorld 采集器在每次采集边界热加载最新源码', async t => {
  const directory = temporary(t), modulePath = path.join(directory, 'source-module.mjs');
  const writeVersion = version => fs.writeFileSync(modulePath,
    `export async function collectMakerWorld(store, browser, model) { return { version: ${version}, id: model.id }; }`);
  const store = { messages: [], log(message) { this.messages.push(message); } };
  const browser = {};
  writeVersion(1);
  const collector = new ReloadableMakerWorldCollector(store, browser, { modulePath });
  assert.deepEqual(await collector.collect({ id: 'model-1' }), { version: 1, id: 'model-1' });
  writeVersion(2);
  assert.deepEqual(await collector.collect({ id: 'model-2' }), { version: 2, id: 'model-2' });
  assert.equal(store.messages.length, 2);
});
test('NexPrint Standard Digital File License 映射三项否并验证最终许可', async () => {
  const selected = [false, false, false, false];
  const radios = selected.map((_value, index) => ({
    isChecked: async () => selected[index],
    check: async options => { assert.equal(options.force, true); selected[index] = true; },
    click: async () => { selected[index] = true; },
  }));
  const page = {
    getByRole: (role, options) => { assert.equal(role, 'radio'); assert.deepEqual(options, { name: '否', exact: true }); return { all: async () => radios }; },
    locator: selector => { assert.equal(selector, 'body'); return { innerText: async () => '本作品遵循以下许可协议: Standard Digital File License' }; },
  };
  await setNexprintLicense(page, 'standard');
  assert.deepEqual(selected, [false, true, true, true]);
  await assert.rejects(setNexprintLicense(page, 'cc-by-nc'), /尚无经过验证/);
});
test('平台单选项优先使用真实 radio，失败时点击可见文字并验证结果', async () => {
  let checked = false, clicked = false;
  const page = {
    getByRole: () => ({ count: async () => 1, isChecked: async () => checked,
      check: async options => { assert.equal(options.force, true); checked = true; } }),
    getByText: () => ({ count: async () => 1, last() { return this; }, isVisible: async () => true,
      click: async () => { clicked = true; checked = true; } }),
  };
  await selectRadioOption(page, '原创模型', '创想云'); assert.equal(checked, true); assert.equal(clicked, false);
  checked = false;
  const labelFallback = { ...page, getByRole: () => ({ count: async () => 1, isChecked: async () => checked, check: async () => {} }) };
  await selectRadioOption(labelFallback, '只对自己', '创想云'); assert.equal(clicked, true); assert.equal(checked, true);
});
test('创想云许可问卷所有许可答案都通过容错单选流程设置并核验', async () => {
  const selected = [false, false, false];
  const radios = selected.map((_value, index) => ({
    isChecked: async () => selected[index],
    check: async ({ force }) => { assert.equal(force, true); selected[index] = true; },
    click: async () => { selected[index] = true; },
  }));
  const page = {
    getByRole: (_role, options = {}) => ({ all: async () => options.name === '否' ? radios : [] }),
    locator: () => ({ innerText: async () => 'Standard Digital File License' }),
  };
  await new TargetExecutor(null, null).crealityLicense(page, 'standard');
  assert.deepEqual(selected, [true, true, true]);
});
test('创想云分类选择兼容原生 select 与点击受阻的自定义下拉框', async () => {
  let selected = null;
  const nativePage = {
    evaluate: async () => ['#category'],
    locator: () => ({ evaluate: async () => 'SELECT', selectOption: async ({ label }) => { selected = label; } }),
  };
  await selectInput(nativePage, ['类别', '分类'], '艺术与设计'); assert.equal(selected, '艺术与设计');
  let normalClicks = 0, forceClicks = 0, optionClicked = false;
  const customPage = {
    evaluate: async () => ['#category'],
    locator: () => ({ evaluate: async fn => fn({ tagName: 'INPUT', value: optionClicked ? '艺术与设计' : '', innerText: '', textContent: '', getAttribute: () => null }), click: async options => {
      if (options.force) forceClicks++; else normalClicks++;
      if (!options.force) throw new Error('overlay intercepted click');
    } }),
    getByRole: role => role === 'menuitem' ? { all: async () => [], filter: () => ({ first: () => ({ waitFor: async () => { throw new Error('no menu'); } }) }) } : ({ filter: () => ({ all: async () => [{ isVisible: async () => true,
      click: async () => { throw new Error('click intercepted'); },
      evaluate: async () => { optionClicked = true; } }] }) }),
  };
  await selectInput(customPage, ['类别', '分类'], '艺术与设计');
  assert.equal(normalClicks, 1); assert.equal(forceClicks, 1); assert.equal(optionClicked, true);
});
test('NexPrint 保存无提示也无跳转时，以草稿箱持久记录为准且只点击保存一次', async () => {
  let saves = 0, verificationPages = 0;
  const page = { isClosed: () => false, evaluate: async (_fn, arg) => arg === 'nexprint' ? null : { errors: [], galleryCount: 0 },
    getByRole: (role, options) => { assert.equal(role, 'button'); assert.equal(options.name, '保存为草稿'); return { click: async () => { saves++; } }; } };
  const title = { first: () => title, waitFor: async () => {}, count: async () => 1 };
  const verification = { goto: async () => {}, getByRole: () => title, url: () => 'https://www.nexprint.cn/zh/creator/model-management/drafts' };
  const executor = new TargetExecutor({ page: async () => { verificationPages++; return verification; }, evidence: async () => 'saved.png' }, {});
  executor.prepared.set('draft-task', { page, account: null });
  const result = await executor.commit({ id: 'draft-task', target: 'nexprint', imageAssetIds: [] }, { title: '阿米娅挂坠', assets: [] });
  assert.equal(result.verified, true); assert.equal(result.verifiedBy, 'platform');
  assert.equal(saves, 1); assert.equal(verificationPages, 1);
});
test('待核对草稿可只读核验并恢复任务成功，不重新准备或提交', async t => {
  const store = new Store(temporary(t)), model = readyModel(store); let verifies = 0;
  const queue = new TaskQueue(store, { prepare: async () => { throw new Error('核验不可重传'); }, commit: async () => { throw new Error('核验不可提交'); },
    verify: async () => { verifies++; return { url: 'https://www.nexprint.cn/zh/creator/model-management/drafts', verified: true, verifiedBy: 'platform', mode: 'draft' }; } });
  queue.stopped = true;
  const [task] = queue.enqueue([model.id], ['nexprint']);
  store.updateTask(task.id, { status: 'attention', uncertain: true });
  const result = await queue.verify(task.id);
  assert.equal(result.status, 'saved'); assert.equal(result.uncertain, false); assert.equal(verifies, 1);
  assert.equal(result.result.verifiedBy, 'platform');
});
test('表单字段在页面重绘后重新定位，不继续使用失效的结构路径', async () => {
  const resolved = []; let filled = null;
  const page = {
    evaluate: async () => [resolved.length ? '#current-field' : '#stale-field'],
    locator: selector => {
      resolved.push(selector);
      return {
        evaluate: async () => {
          if (selector === '#stale-field') {
            const error = new Error('Locator.evaluate: Timeout 12000ms exceeded.'); error.name = 'TimeoutError'; throw error;
          }
          return 'INPUT';
        },
        fill: async value => { filled = value; },
      };
    },
    waitForTimeout: async () => {},
  };
  await fillText(page, ['模型名称'], '重绘后标题');
  assert.deepEqual(resolved, ['#stale-field', '#current-field']);
  assert.equal(filled, '重绘后标题');
});
test('NexPrint 实物图片最多九张，封面单独排除且未选图片保留', () => {
  const assets = Array.from({ length: 20 }, (_value, index) => ({ id: `image-${index}`, role: 'photo', path: `image-${index}.webp` }));
  const model = { assets, coverId: 'image-1' };
  const empty = selectNexprintGalleryImages(model);
  assert.equal(empty.gallery.length, 0);
  assert.equal(empty.omitted, 19);
  const { gallery, omitted } = selectNexprintGalleryImages(model, assets.filter(a => a.id !== 'image-1').slice(0, 9).map(a => a.id));
  assert.equal(gallery.length, 9);
  assert.equal(omitted, 10);
  assert.ok(gallery.every(asset => asset.id !== 'image-1'));
  assert.equal(gallery.at(-1).id, 'image-9');
  assert.throws(() => selectNexprintGalleryImages({ assets, coverId: 'image-1' }, ['missing']), /图片选择包含不存在/);
  assert.throws(() => selectNexprintGalleryImages({ assets, coverId: 'image-1' }, assets.slice(0, 10).map(a => a.id)), /最多可选择 9 张/);
});
test('NexPrint 实物图片等待核对实际数量，并把平台超限提示当作失败', async () => {
  const states = [{ galleryCount: 0, errors: [] }, { galleryCount: 9, errors: [] }];
  const page = { evaluate: async () => states.shift(), waitForTimeout: async () => {} };
  assert.equal(await waitNexprintGallery(page, 9, { timeoutMs: 100, pollMs: 0 }), 9);
  await assert.rejects(waitNexprintGallery({ evaluate: async () => ({ galleryCount: 0, errors: ['上传文件数量超过上限（9）'] }), waitForTimeout: async () => {} }, 9), /图片上传被平台拒绝/);
});
test('MakerWorld 采集时自动接收并校验 3MF 文件', async t => {
  const directory = temporary(t), store = new Store(directory), model = store.addModel(source);
  const downloadedPath = path.join(directory, 'download.3mf');
  const archive = new AdmZip();
  archive.addFile('3D/Objects/object_1.model', Buffer.from('<model><mesh>geometry</mesh></model>'));
  archive.writeZip(downloadedPath);
  let downloadClicked = false, currentUrl = model.source.url;
  const page = {
    goto: async url => { currentUrl = url; }, url: () => currentUrl,
    getByText: text => ({ first: () => ({ waitFor: async () => {}, click: async () => { if (text === '下载 3MF') downloadClicked = true; } }) }),
    locator: () => ({ filter: ({ hasText }) => ({ click: async () => { if (hasText === '下载 3MF') downloadClicked = true; } }) }),
    waitForFunction: async () => ({ dispose: async () => {}, jsonValue: async () => ({ title: '风神像', description: '模型说明', author: 'popko',
      text: '风神像\n打印配置 (1)\n0.16mm 层高, 2 层墙, 5% 填充\nStandard Digital File License',
      currentProfileId: '3651936', images: [], profileLinks: [] }) }),
  };
  const browser = { page: async () => page, getContext: async () => ({}), evidence: async () => 'evidence.png',
    downloadFromPage: async trigger => { await trigger(); return { path: downloadedPath, suggestedFilename: 'Fengshen.3mf' }; } };
  const result = await collectMakerWorld(store, browser, model, () => {});
  assert.equal(downloadClicked, true);
  assert.equal(result.profiles.length, 1);
  assert.equal(result.profiles[0].id, '3651936');
  assert.ok(fs.existsSync(result.profiles[0].file.path));
  assert.equal(fs.existsSync(downloadedPath), false);
});
test('队列去重、不同目标拆分任务，确认声明前不会提交', async t => {
  const store = new Store(temporary(t)), model = readyModel(store); let commits = 0;
  const executor = { prepare: async () => ({ declaration: '本人确认本次声明', pageUrl: 'https://www.crealitycloud.cn/create-model' }),
    commit: async () => { commits++; return { url: 'https://www.crealitycloud.cn/model-detail/abc', verified: true }; } };
  const queue = new TaskQueue(store, executor), [job] = queue.enqueue([model.id], ['creality']);
  queue.enqueue([model.id], ['creality']); await tick(); assert.equal(store.state.tasks.length, 1); assert.equal(commits, 0); assert.equal(store.task(job.id).status, 'ready');
  await assert.rejects(() => queue.commit(job.id, { reviewed: true, declaration: '旧声明' }));
  await queue.commit(job.id, { reviewed: true, declaration: '本人确认本次声明' }); assert.equal(commits, 1); assert.equal(store.task(job.id).status, 'saved');
  queue.enqueue([model.id], ['nexprint']); await tick(); assert.equal(store.state.tasks.length, 2);
});
test('NexPrint 任务固化用户选中的最多九张图片', t => {
  const store = new Store(temporary(t)), base = readyModel(store);
  const gallery = Array.from({ length: 10 }, (_value, index) => ({ id: `gallery-${index}`, path: `gallery-${index}.png`, sha256: `gallery-${index}`, role: 'photo' }));
  const selected = gallery.slice(1).map(asset => asset.id);
  const model = store.updateModel(base.id, { assets: [...base.assets, ...gallery], nexprintImageIds: selected });
  const queue = new TaskQueue(store, { prepare: async () => ({}) }); queue.stopped = true;
  const [task] = queue.enqueue([model.id], ['nexprint']);
  assert.deepEqual(task.imageAssetIds, selected);
  const [crealityTask] = queue.enqueue([model.id], ['creality']);
  assert.equal('imageAssetIds' in crealityTask, false);
  store.updateModel(model.id, { nexprintImageIds: gallery.map(asset => asset.id) });
  assert.throws(() => queue.enqueue([model.id], ['nexprint']), /至多 9 张图片/);
});
test('旧版 NexPrint 待保存任务因未记录图库选择而被拦截', async t => {
  const store = new Store(temporary(t)), model = readyModel(store); let commits = 0;
  const queue = new TaskQueue(store, { commit: async () => { commits++; return { url: 'https://www.nexprint.cn/model/x', verified: true }; } });
  store.mutate(state => state.tasks.push({ id: 'legacy-ready', modelId: model.id, target: 'nexprint', status: 'ready',
    fingerprint: modelFingerprint(model), mode: 'draft', uncertain: false }));
  const result = await queue.commit('legacy-ready', { reviewed: true });
  assert.equal(result.status, 'attention');
  assert.match(result.message, /未记录你选择的图库图片/);
  assert.equal(commits, 0);
});
test('提交结果不明确时禁止无确认重试', async t => {
  const store = new Store(temporary(t)), model = readyModel(store);
  const queue = new TaskQueue(store, { prepare: async () => ({}), commit: async () => { throw new SubmissionUncertain('timeout'); } });
  const [job] = queue.enqueue([model.id], ['nexprint']); await tick();
  await queue.commit(job.id, { reviewed: true }); assert.equal(store.task(job.id).status, 'attention'); assert.equal(store.task(job.id).uncertain, true);
  assert.throws(() => queue.retry(job.id), /确认/);
  queue.resolve(job.id, 'https://www.nexprint.cn/models/existing'); assert.equal(store.task(job.id).result.verifiedBy, 'user');
});
test('排队中的同步任务可以取消且不会启动浏览器', async t => {
  const store = new Store(temporary(t)), model = readyModel(store); let prepared = false;
  const queue = new TaskQueue(store, { prepare: async () => { prepared = true; } }); queue.stopped = true;
  const [job] = queue.enqueue([model.id], ['nexprint']); await tick();
  const result = await queue.cancel(job.id);
  assert.equal(result.status, 'cancelled'); assert.equal(result.message, '已取消排队任务'); assert.equal(prepared, false);
});
test('准备中的同步任务会关闭专属页面并进入已中断状态', async t => {
  const store = new Store(temporary(t)), model = readyModel(store); let startedResolve, cancelCalls = 0;
  const started = new Promise(resolve => { startedResolve = resolve; });
  const executor = {
    prepare: async (_task, _model, _log, { signal }) => new Promise((_resolve, reject) => {
      startedResolve(); signal.addEventListener('abort', () => reject(new Error('page closed')), { once: true });
    }),
    cancel: async () => { cancelCalls++; },
  };
  const queue = new TaskQueue(store, executor), [job] = queue.enqueue([model.id], ['nexprint']);
  await started; const result = await queue.cancel(job.id); assert.equal(result.status, 'cancelling');
  for (let i = 0; i < 20 && store.task(job.id).status !== 'cancelled'; i++) await tick();
  assert.equal(store.task(job.id).status, 'cancelled'); assert.equal(store.task(job.id).uncertain, false); assert.equal(cancelCalls, 1);
});
test('保存阶段不允许中断，以免误报平台最终结果', async t => {
  const store = new Store(temporary(t)), model = readyModel(store), queue = new TaskQueue(store, {});
  store.mutate(s => s.tasks.push({ id: 'submitting', status: 'submitting', modelId: model.id, target: 'nexprint' }));
  await assert.rejects(() => queue.cancel('submitting'), /只有排队中或正在准备表单的任务可以中断/);
});
test('删除已保存任务保留模型素材，并允许同一模型重新创建任务', async t => {
  const store = new Store(temporary(t)), model = readyModel(store); let closed = 0;
  const queue = new TaskQueue(store, { prepare: async () => ({}), cancel: async () => { closed++; } });
  const [job] = queue.enqueue([model.id], ['nexprint']); await tick();
  store.updateTask(job.id, { status: 'saved', result: { url: 'https://www.nexprint.cn/models/existing', verified: true } });
  const removed = await queue.remove(job.id);
  assert.ok(removed.deletedAt); assert.equal(removed.status, 'saved'); assert.equal(closed, 0);
  assert.deepEqual(store.model(model.id), model);
  queue.stopped = true;
  const [replacement] = queue.enqueue([model.id], ['nexprint']); assert.notEqual(replacement.id, job.id);
  assert.throws(() => queue.restore(job.id), /新的同步任务/);
  await queue.remove(replacement.id); assert.equal(queue.restore(job.id).deletedAt, null);
});
test('删除准备中的任务先中断，异步收尾不会把已删除任务写回待保存', async t => {
  const store = new Store(temporary(t)), model = readyModel(store); let finishPreparation;
  const executor = { prepare: () => new Promise(resolve => { finishPreparation = resolve; }), cancel: async () => { finishPreparation({}); } };
  const queue = new TaskQueue(store, executor), [job] = queue.enqueue([model.id], ['nexprint']);
  await tick(); await queue.remove(job.id); await tick();
  const removed = store.task(job.id);
  assert.ok(removed.deletedAt); assert.equal(removed.status, 'cancelled'); assert.equal(queue.busy, false);
  assert.equal(queue.restore(job.id).status, 'cancelled');
});
test('删除待保存任务关闭表单，保存阶段禁止删除', async t => {
  const store = new Store(temporary(t)), model = readyModel(store); let closed = 0;
  const queue = new TaskQueue(store, { prepare: async () => ({}), cancel: async () => { closed++; } });
  const [job] = queue.enqueue([model.id], ['nexprint']); await tick();
  const removed = await queue.remove(job.id); assert.equal(closed, 1); assert.equal(removed.status, 'cancelled');
  await assert.rejects(() => queue.commit(job.id, { reviewed: true }), /已删除/);
  assert.throws(() => queue.retry(job.id), /已删除/);
  queue.restore(job.id); store.updateTask(job.id, { status: 'submitting' });
  await assert.rejects(() => queue.remove(job.id), /正在保存并核验/);
  assert.equal(store.task(job.id).deletedAt, null);
});
test('模型资料改变后不能使用旧的确认保存', async t => {
  const store = new Store(temporary(t)), model = readyModel(store), queue = new TaskQueue(store, { prepare: async () => ({}) });
  const [job] = queue.enqueue([model.id], ['nexprint']); await tick();
  store.updateModel(model.id, { title: '新标题' }); assert.notEqual(modelFingerprint(model), modelFingerprint(store.model(model.id)));
  await assert.rejects(() => queue.commit(job.id, { reviewed: true }), /资料已修改/);
});
test('运行中断和准备页丢失不会自动重传', t => {
  const dir = temporary(t), store = new Store(dir);
  store.mutate(s => s.tasks.push({ id: 'a', status: 'submitting' }, { id: 'b', status: 'ready' }, { id: 'c', status: 'saved' }, { id: 'd', status: 'cancelling' },
    { id: 'e', status: 'deleting', deleteFromStatus: 'attention', uncertain: true }));
  const restored = new Store(dir); assert.equal(restored.task('a').status, 'attention'); assert.equal(restored.task('a').uncertain, true);
  assert.equal(restored.task('b').status, 'attention'); assert.equal(restored.task('c').status, 'saved'); assert.equal(restored.task('d').status, 'cancelled');
  assert.ok(restored.task('e').deletedAt); assert.equal(restored.task('e').status, 'attention'); assert.equal(restored.task('e').uncertain, true);
});
test('Service 拒绝伪造封面和不存在的素材角色', t => {
  const service = new Service(temporary(t)), model = readyModel(service.store);
  assert.throws(() => service.edit(model.id, { coverId: 'missing' }), /封面/);
  assert.throws(() => service.edit(model.id, { assetRoles: { cover: 'fake' } }), /用途/);
  service.store.mutate(s => s.tasks.push({ id: 'cancelling', modelId: model.id, status: 'cancelling' }));
  assert.throws(() => service.edit(model.id, { title: '不应覆盖' }), /正在上传、中断或保存/);
});
