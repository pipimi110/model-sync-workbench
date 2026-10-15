import fs from 'node:fs';
import path from 'node:path';
import { normalizeLicense, parseProfileId, profileLinksForModel, UserActionRequired } from '../domain.mjs';
import { ingestFile } from '../assets.mjs';

export function parseMakerWorldText(text, source) {
  const profileCount = Number(text.match(/打印配置\s*[（(]\s*(\d+)\s*[）)]/)?.[1] || 0);
  const settings = text.match(/([\d.]+)\s*mm\s*层高\s*[,，]\s*(\d+)\s*层墙\s*[,，]\s*(\d+)\s*%\s*填充/);
  const params = settings ? { layer_height: settings[1], wall_loops: settings[2], sparse_infill_density: `${settings[3]}%` } : {};
  return { profileCount, license: normalizeLicense(text), params,
    profileId: source.profileId, name: settings?.[0] || '原始打印配置' };
}

// This function runs in the page. Keep it self-contained so the same extractor
// is exercised against real DOM fixtures instead of replacing it with mock data.
export function readMakerWorldDocument({ expectedModelId, readyOnly = false, imagesRequired = false } = {}) {
    const detail = Array.from(document.querySelectorAll('h3')).find(e => e.innerText.trim() === '模型详情');
    const modelId = location.pathname.match(/^\/zh\/models\/(\d+)(?:-|\/|$)/)?.[1];
    const beforeDetail = element => detail && Boolean(element.compareDocumentPosition(detail) & Node.DOCUMENT_POSITION_FOLLOWING);
    const visibleTitle = Array.from(document.querySelectorAll('.title-for-share, h1, h2'))
      .filter(element => element.getClientRects().length && beforeDetail(element))
      .sort((a, b) => Number(b.matches('.title-for-share')) - Number(a.matches('.title-for-share')))
      .map(element => element.innerText.trim()).find(Boolean);
    // Only use model-specific metadata after the actual detail section is present;
    // a login/challenge page or the generic site title must not become a model name.
    const stripSiteSuffix = value => {
      const suffix = /\s+-\s+免费\s*3D\s*打印模型\s+-\s+MakerWorld\s*$/i;
      return suffix.test(value || '') ? value.replace(suffix, '').trim() : '';
    };
    const title = visibleTitle || (detail && (stripSiteSuffix(document.querySelector('meta[property="og:title"]')?.content) || stripSiteSuffix(document.title))) || '';
    const sameModel = Boolean(modelId) && (!expectedModelId || modelId === expectedModelId);
    const end = Array.from(document.querySelectorAll('h3')).find(e => /评论与评分/.test(e.innerText));
    const range = document.createRange(); let description = '';
    if (detail && end) { range.setStartAfter(detail); range.setEndBefore(end); description = range.toString().trim().replace(title, '').trim(); }
    const authorLink = Array.from(document.querySelectorAll('a[href]')).find(a => /\/zh\/@[^/]+$/.test(a.getAttribute('href') || ''));
    const recommend = Array.from(document.querySelectorAll('h3')).find(e => /猜你喜欢/.test(e.innerText));
    const cutoff = recommend ? recommend.getBoundingClientRect().top : Infinity;
    // MakerWorld's detail DOM can contain the same design image at thumbnail
    // (400px) and full (1000px) widths. Keep only the largest variant for each
    // origin/path; never download the known small thumbnail variants.
    const images = new Map();
    for (const el of document.querySelectorAll('img, [style*="background"]')) {
      if (el.getBoundingClientRect().top >= cutoff) continue;
      const values = [el.currentSrc, el.getAttribute('src'), el.getAttribute('srcset'), el.srcset,
        getComputedStyle(el).backgroundImage].filter(Boolean);
      for (const value of values) for (const match of value.matchAll(/https:\/\/[^\s"'()]+/g)) {
        try {
          const u = new URL(match[0].replace(/,+$/, ''));
          if (!/\/(?:design|model)\//.test(u.pathname) || !/\.(?:png|jpe?g|webp)$/i.test(u.pathname)) continue;
          const transform = u.searchParams.get('x-oss-process') || '';
          const width = Number(transform.match(/(?:^|[/,])w_(\d+)/i)?.[1] || 0);
          if (width > 0 && width <= 400) continue;
          const key = `${u.origin}${u.pathname}`;
          const rank = width || Number.MAX_SAFE_INTEGER;
          if (!images.has(key) || rank > images.get(key).rank) images.set(key, { url: u.href, rank });
        } catch {}
      }
    }
    const result = { title, description, author: authorLink?.innerText.trim() || '', text: document.body.innerText,
      hasDetail: Boolean(detail), sameModel, pageUrl: location.href,
      currentProfileId: (() => {
        const hash = location.hash.slice(1), queryId = new URLSearchParams(hash).get('profileId');
        return /^\d+$/.test(queryId || '') ? queryId : hash.match(/(?:^|[&#])profileId-(\d+)(?:$|[&#])/i)?.[1] || null;
      })(),
      images: [...images.values()].map(image => image.url), profileLinks: [...document.querySelectorAll('a[href*="profileId"]')].map(a => a.href) };
    if (readyOnly && (!sameModel || !detail || !title || (imagesRequired && !result.images.length))) return false;
    return result;
}

export async function readMakerWorldPage(page, modelId, { timeout = 30000, waitForImages = false, imageTimeout = 12000 } = {}) {
  let handle, modelReady = false;
  try {
    // The section label can appear before the model title during hydration.
    handle = await page.waitForFunction(readMakerWorldDocument, { expectedModelId: modelId, readyOnly: true }, { timeout, polling: 250 });
    modelReady = true;
    let data = await handle.jsonValue();
    if (waitForImages && !data.images.length) {
      await handle.dispose(); handle = null;
      try {
        handle = await page.waitForFunction(readMakerWorldDocument,
          { expectedModelId: modelId, readyOnly: true, imagesRequired: true }, { timeout: imageTimeout, polling: 250 });
        data = await handle.jsonValue();
      } catch (error) {
        if (error.name !== 'TimeoutError') throw error;
        data = await page.evaluate(readMakerWorldDocument, { expectedModelId: modelId });
      }
    }
    return data;
  } catch (error) {
    if (error.name !== 'TimeoutError') throw error;
    const state = await page.evaluate(readMakerWorldDocument, { expectedModelId: modelId });
    if (modelReady) return state;
    let reason = state.hasDetail
      ? '模型详情已加载，但未找到可识别的模型标题，页面结构可能已变化'
      : '模型页面未加载完成，尚未显示模型详情';
    if (!state.sameModel) reason = '当前页面未显示请求的模型，可能发生了跳转，请检查浏览器页面';
    if (/安全服务防护恶意自动程序|人机验证|安全验证|验证码/.test(state.text.slice(0, 2500)) && !state.hasDetail)
      reason = 'MakerWorld 页面正在要求安全验证，请在浏览器按页面提示处理后重试';
    throw new UserActionRequired(reason, { pageUrl: state.pageUrl });
  } finally { await handle?.dispose(); }
}

export async function discoverMakerWorldProfiles(page, data, source, profileCount, log) {
  const links = profileLinksForModel(data.profileLinks, page.url());
  const profiles = new Map();
  const add = (id, url, name = '', cardIndex = null) => { if (id) profiles.set(id, { id, url, name, cardIndex }); };
  add(data.currentProfileId || source.profileId, page.url());
  for (const link of links) add(parseProfileId(link), link);
  if (profiles.size >= profileCount) return [...profiles.values()];
  // Current MakerWorld profile cards are div/span controls, not anchors. Resolve
  // their IDs by normal UI selection and the resulting URL; never infer IDs
  // from thumbnail paths or include recommendation-model profile links.
  if (profileCount > 100) throw new UserActionRequired('打印配置数量超过当前自动读取上限，请检查来源页面');
  await page.waitForFunction(expected => [...document.querySelectorAll('.config_title')]
    .filter(element => element.getClientRects().length).length === expected, profileCount, { timeout: 15000 });
  const cards = page.locator('.config_title:visible');
  for (let index = 0; index < profileCount; index++) {
    const before = parseProfileId(page.url());
    const name = (await cards.nth(index).innerText()).trim();
    await cards.nth(index).click();
    await page.waitForURL(url => profileLinksForModel([url.href], source.url).length &&
      (index === 0 || parseProfileId(url.href) !== before), { timeout: 10000 });
    const url = page.url(), id = parseProfileId(url);
    add(id, url, name, index);
    log(`已读取打印配置 ${index + 1}/${profileCount}：${name}（${id}）`);
  }
  return [...profiles.values()];
}

export async function selectMakerWorldProfile(page, profile, modelId) {
  if (Number.isInteger(profile.cardIndex)) {
    await page.locator('.config_title:visible').nth(profile.cardIndex).click();
    // Changing the URL fragment alone does not change MakerWorld's selected
    // download. Wait for the actual card's active state as well as its ID.
    await page.waitForFunction(({ index, id, modelId }) => {
      const cards = [...document.querySelectorAll('.config_title')].filter(element => element.getClientRects().length);
      const hash = location.hash.slice(1);
      const selected = new URLSearchParams(hash).get('profileId') || hash.match(/^profileId-(\d+)(?:$|[&#])/)?.[1];
      return location.pathname.match(/^\/zh\/models\/(\d+)(?:-|\/|$)/)?.[1] === modelId && selected === id && Boolean(cards[index]?.closest('.active'));
    }, { index: profile.cardIndex, id: profile.id, modelId }, { timeout: 10000 });
  } else if (parseProfileId(page.url()) !== profile.id) {
    await page.goto(profile.url, { waitUntil: 'domcontentloaded' });
    await readMakerWorldPage(page, modelId);
  }
}

export async function collectMakerWorld(store, browser, model, log) {
  const page = await browser.page(`source-${model.id}`);
  await page.goto(model.source.url, { waitUntil: 'domcontentloaded', timeout: 45000 });
  log('等待 MakerWorld 模型标题与详情加载');
  const data = await readMakerWorldPage(page, model.source.id, { waitForImages: true });
  const parsed = parseMakerWorldText(data.text, model.source);
  store.updateModel(model.id, { title: data.title, description: data.description, author: data.author,
    license: parsed.license, licenseText: parsed.license === 'standard' ? 'Standard Digital File License' : parsed.license,
    status: 'collected', issues: [] });
  log('已读取标题、说明与许可');
  const temp = path.join(store.directory, 'downloads', model.id); fs.mkdirSync(temp, { recursive: true });
  const assets = [...store.model(model.id).assets];
  let imageIssue = null, allowedImageUrlCount = 0, downloadedImageCount = 0;
  const context = await browser.getContext();
  for (const [i, url] of data.images.entries()) {
    if (i >= 30) break;
    const u = new URL(url);
    if (!(u.hostname.endsWith('.bblmw.cn') || u.hostname.endsWith('.bambulab.cn') || u.hostname === 'makerworld.com.cn')) continue;
    allowedImageUrlCount++;
    try {
      const response = await context.request.get(url, { timeout: 30000, maxRedirects: 0 });
      if (!response.ok()) { log(`图片 ${i + 1} 下载失败：HTTP ${response.status()}`); continue; }
      const bytes = await response.body();
      if (bytes.length > 20 * 1024 ** 2) { log(`图片 ${i + 1} 超过 20MB，已跳过`); continue; }
      const filename = path.join(temp, `image-${i + 1}`); fs.writeFileSync(filename, bytes);
      const asset = ingestFile(store.directory, model.id, filename, 'image'); asset.sourceUrl = url;
      downloadedImageCount++;
      if (!(store.model(model.id).excludedAssetHashes || []).includes(asset.sha256) && !assets.some(a => a.sha256 === asset.sha256)) assets.push(asset);
    } catch (error) { log(`图片 ${i + 1} 未取得：${error.message.split('\n')[0]}`); }
  }
  if (!data.images.length) imageIssue = '未找到可下载的原尺寸图片；缩略图已跳过，请检查来源页面是否已加载高清图';
  else if (!allowedImageUrlCount) imageIssue = `提取到 ${data.images.length} 个图片地址，但域名不在允许的图片 CDN 列表中`;
  else if (!downloadedImageCount) imageIssue = `识别到 ${allowedImageUrlCount} 个原尺寸图片地址，但下载均未成功，请查看运行记录`;
  log(imageIssue ? `图片素材未完整加载：${imageIssue}` : `图片素材：识别 ${data.images.length} 个原尺寸地址，下载 ${downloadedImageCount} 张`);
  store.updateModel(model.id, { assets });
  let discovered;
  try { discovered = await discoverMakerWorldProfiles(page, data, model.source, parsed.profileCount, log); }
  catch (error) {
    if (error.name !== 'TimeoutError') throw error;
    throw new UserActionRequired('模型资料与图片已读取，但打印配置列表尚未完整加载或切换未完成，请检查浏览器配置列表后重试', { pageUrl: page.url() });
  }
  const ids = discovered.map(profile => profile.id);
  const profiles = store.model(model.id).profiles.filter(profile => !/^\d+$/.test(profile.id) || ids.includes(profile.id));
  if (profiles.length !== store.model(model.id).profiles.length) store.updateModel(model.id, { profiles });
  if (parsed.profileCount > ids.length) {
    store.updateModel(model.id, { issues: [`页面显示 ${parsed.profileCount} 份配置，但当前只解析到 ${ids.length} 个配置 ID；请确认页面的配置列表已加载`] });
    throw new UserActionRequired('多配置链接未全部解析，已保留资料和图片。请在浏览器检查并通过本地文件补齐。', { pageUrl: page.url() });
  }
  if (!ids.length) throw new UserActionRequired('未找到打印配置 ID，已保留模型资料。可以手动补充 3MF。');
  const pendingIds = ids.filter(id => model.status === 'collected' || !profiles.some(p => p.id === id && p.file?.path));
  for (const id of pendingIds) {
        const selected = discovered.find(profile => profile.id === id);
        await selectMakerWorldProfile(page, selected, model.source.id);
        log(`自动下载打印配置 ${id}`);
        let filename, sourceFilename;
        try {
          const download = await browser.downloadFromPage(
            () => page.locator('span.primaryButton:visible').filter({ hasText: '下载 3MF' }).click(), 45000);
          sourceFilename = download.path;
          const suggested = path.basename(download.suggestedFilename || '').replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').slice(0, 120);
          filename = path.join(temp, suggested || `profile-${id}.3mf`);
          fs.copyFileSync(sourceFilename, filename);
          const file = ingestFile(store.directory, model.id, filename, 'model');
          const record = { id, name: selected.name || parsed.name, file, parameters: { ...parsed.params, ...file.parameters } };
          const previous = profiles.findIndex(profile => profile.id === id);
          if (previous < 0) profiles.push(record); else profiles[previous] = record;
          store.updateModel(model.id, { profiles });
        } finally {
          if (filename) { try { fs.rmSync(filename, { force: true }); } catch {} }
          if (sourceFilename) { try { fs.rmSync(sourceFilename, { force: true }); } catch {} }
        }
  }
  store.updateModel(model.id, { status: 'collected', issues: [...(imageIssue ? [imageIssue] : []), '请在编辑页确认图片用途、封面及原创性'] });
  await browser.evidence(page, `source-${model.source.id}`);
  return store.model(model.id);
}
