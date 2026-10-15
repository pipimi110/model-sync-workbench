import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { _electron } from 'playwright';
import { discoverMakerWorldProfiles, readMakerWorldDocument, readMakerWorldPage, selectMakerWorldProfile } from '../src/adapters/makerworld.mjs';
import { selectInput } from '../src/adapters/targets.mjs';

test('MakerWorld 以真实 Chromium DOM 验证标题结构、延迟加载及错误诊断', { timeout: 60000 }, async t => {
  const base = path.resolve('artifacts/test-runs'); fs.mkdirSync(base, { recursive: true });
  const directory = fs.mkdtempSync(path.join(base, 'makerworld-dom-'));
  const env = { ...process.env, MODELPORT_DOM_TEST_DATA: directory }; delete env.ELECTRON_RUN_AS_NODE;
  const app = await _electron.launch({ executablePath: createRequire(import.meta.url)('electron'), args: ['test/fixtures/makerworld-dom.cjs'], env, timeout: 20000 });
  t.after(async () => { await app.close(); assert.equal(path.dirname(fs.realpathSync(directory)), fs.realpathSync(base)); fs.rmSync(directory, { recursive: true, force: true }); });
  const page = await app.firstWindow();
  const url = 'https://makerworld.com.cn/zh/models/3059262-example#profileId-3598122';
  // All requests are fulfilled locally; tests never contact MakerWorld or user Chrome.
  let html;
  await page.route('**/*', route => route.fulfill({ contentType: 'text/html', body: html || '<html></html>' }));
  await page.goto(url);
  const fixture = async content => { html = `<html><head><meta charset="utf-8"></head><body>${content}</body></html>`; await page.setContent(html); };
  const detail = '<h3>模型详情</h3><p>真实模型说明</p><h3>评论与评分 (2)</h3><h3>猜你喜欢</h3><h2>推荐模型标题</h2>';

  await t.test('分类级联菜单点击文字只展开；必须选中单选框，并在重绘后重新定位输入框', async () => {
    await fixture(`<div><span>类别</span><input readonly onclick="openCategory()"></div><script>
      function openCategory() {
        const panel=document.createElement('aside'); panel.innerHTML='<ul role="menu"><li role="menuitem"><label><input type="radio" onchange="selectCategory()"></label><span>艺术与设计</span></li></ul>';
        setTimeout(() => document.body.prepend(panel), 450);
        document.querySelector('div > input').outerHTML='<input id="category-opened" readonly>';
      }
      function selectCategory() { document.getElementById('category-opened').outerHTML='<input id="category-selected" value="艺术与设计" readonly>'; document.querySelector('aside').remove(); }
    </script>`);
    await selectInput(page, ['类别', '分类'], '艺术与设计');
    assert.equal(await page.locator('#category-selected').inputValue(), '艺术与设计');
    assert.equal(await page.locator('aside').count(), 0);
  });

  await t.test('当前 div 标题结构：两个用户失败模型都可读取，推荐模型不干扰', async () => {
    for (const title of ['《崩坏：星穹铁道》流萤半身像3D打印模型', '千夏 版画 HueForge 绝区零']) {
      await fixture(`<div class="title-for-share translated-text" aria-label="${title}">${title}</div>${detail}`);
      const data = await readMakerWorldPage(page, '3059262', { timeout: 1000 });
      assert.equal(data.title, title); assert.equal(data.description, '真实模型说明');
    }
  });
  await t.test('兼容原有 h2 结构，不将详情之后的推荐标题作为模型名', async () => {
    await fixture(`<h2>原有模型标题</h2>${detail}`);
    assert.equal((await readMakerWorldPage(page, '3059262', { timeout: 1000 })).title, '原有模型标题');
    await fixture(detail);
    assert.equal((await page.evaluate(readMakerWorldDocument)).title, '');
  });
  await t.test('详情先出现，标题异步加载：必须等待而不是立即报错', async () => {
    await fixture(`<div id="title" class="title-for-share"></div>${detail}<script>setTimeout(() => { document.getElementById('title').textContent = '异步加载的模型'; }, 450)</script>`);
    assert.equal((await readMakerWorldPage(page, '3059262', { timeout: 3000 })).title, '异步加载的模型');
  });
  await t.test('采集模式会等待标题之后异步加载的高清图片地址', async () => {
    await fixture(`<div class="title-for-share">图片延迟加载模型</div><div id="image-slot"></div>${detail}
      <script>setTimeout(() => { document.getElementById('image-slot').innerHTML = '<img src="https://makerworld.bblmw.cn/makerworld/model/test/design/full.webp?x-oss-process=image/resize,w_1000/format,webp">'; }, 400)</script>`);
    const data = await readMakerWorldPage(page, '3059262', { timeout: 1000, waitForImages: true, imageTimeout: 2000 });
    assert.equal(data.images.length, 1);
    assert.match(data.images[0], /w_1000/);
  });
  await t.test('只有模型专用元标题可作后备，移除固定站点后缀', async () => {
    await fixture(`<meta property="og:title" content="千夏 版画 HueForge 绝区零 - 免费 3D 打印模型 - MakerWorld">${detail}`);
    assert.equal((await readMakerWorldPage(page, '3059262', { timeout: 1000 })).title, '千夏 版画 HueForge 绝区零');
    await fixture(`<title>MakerWorld：免费下载 3D 模型</title>${detail}`);
    await assert.rejects(readMakerWorldPage(page, '3059262', { timeout: 300 }), /页面结构可能已变化/);
  });
  await t.test('登录与验证页不被当作模型，错误说明以实际页面为依据', async () => {
    await fixture('<h2>安全验证</h2><p>安全服务防护恶意自动程序</p>');
    await assert.rejects(readMakerWorldPage(page, '3059262', { timeout: 300 }), /页面正在要求安全验证/);
    await fixture('<h2>登录 MakerWorld</h2>');
    await assert.rejects(readMakerWorldPage(page, '3059262', { timeout: 300 }), /尚未显示模型详情/);
  });
  await t.test('跳转到其他模型时不采集错误作品', async () => {
    await fixture(`<div class="title-for-share">其他模型</div>${detail}`);
    await assert.rejects(readMakerWorldPage(page, '9999999', { timeout: 300 }), /未显示请求的模型/);
  });
  await t.test('同一图片只保留大尺寸版本，不采集 400px 缩略图', async () => {
    const root = 'https://makerworld.bblmw.cn/makerworld/model/test/design/image.png';
    await fixture(`<div class="title-for-share">图片尺寸测试</div>
      <img src="${root}?x-oss-process=image/resize,w_400/format,webp">
      <img src="https://makerworld.bblmw.cn/makerworld/model/test/design/responsive.png?x-oss-process=image/resize,w_400/format,webp"
        srcset="https://makerworld.bblmw.cn/makerworld/model/test/design/responsive.png?x-oss-process=image/resize,w_400/format,webp 400w, https://makerworld.bblmw.cn/makerworld/model/test/design/responsive.png?x-oss-process=image/resize,w_1000/format,webp 1000w">
      <img src="https://makerworld.bblmw.cn/makerworld/model/test/design/thumbnail-only.png?x-oss-process=image/resize,w_400/format,webp">
      ${detail}`);
    const data = await readMakerWorldPage(page, '3059262', { timeout: 1000 });
    assert.deepEqual(data.images, [
      'https://makerworld.bblmw.cn/makerworld/model/test/design/responsive.png?x-oss-process=image/resize,w_1000/format,webp',
    ]);
  });
  await t.test('无链接的配置卡片通过实际点击解析全部 ID，保留每份配置名称', async () => {
    await page.goto(url);
    await fixture(`<div class="title-for-share">多配置模型</div>${detail}
      <h4>打印配置 (2)</h4>
      <button onclick="for(const e of document.querySelectorAll('button')) e.classList.remove('active'); this.classList.add('active'); location.hash='profileId-3598122'"><span class="config_title">推荐配置-0.2mm 喷嘴</span></button>
      <button onclick="setTimeout(() => { for(const e of document.querySelectorAll('button')) e.classList.remove('active'); this.classList.add('active'); location.hash='profileId-3163936'; }, 100)"><span class="config_title">0.4mm 喷嘴</span></button>`);
    const data = await readMakerWorldPage(page, '3059262', { timeout: 1000 });
    const profiles = await discoverMakerWorldProfiles(page, data, { url, id: '3059262', profileId: '3598122' }, 2, () => {});
    assert.deepEqual(profiles.map(profile => profile.id), ['3598122', '3163936']);
    assert.deepEqual(profiles.map(profile => profile.name), ['推荐配置-0.2mm 喷嘴', '0.4mm 喷嘴']);
    assert.equal(new Set(profiles.map(profile => profile.url)).size, 2);
    // A hash navigation leaves the previous card active. Selection must perform
    // the real click before downloading, otherwise both IDs get the same file.
    await page.goto(profiles[0].url);
    assert.equal(await page.locator('.active .config_title').innerText(), '0.4mm 喷嘴');
    await selectMakerWorldProfile(page, profiles[0], '3059262');
    assert.equal(await page.locator('.active .config_title').innerText(), '推荐配置-0.2mm 喷嘴');
    await selectMakerWorldProfile(page, profiles[1], '3059262');
    assert.equal(await page.locator('.active .config_title').innerText(), '0.4mm 喷嘴');
  });
});
