import { UserActionRequired, SubmissionUncertain, PLATFORMS } from '../domain.mjs';

const LICENSE_NAMES = {
  standard: /Standard Digital File License/,
  'cc-by-nc': /CC\s*BY[ -]NC(?:\s|4|$)/i,
  'cc-by-nc-sa': /CC\s*BY[ -]NC[ -]SA/i,
  cc0: /CC0|Creative Commons Public Domain/i,
  'cc-by': /^CC\s*BY(?:\s*4|$)/i,
  'cc-by-sa': /CC\s*BY[ -]SA/i,
};
const NEXPRINT_MAX_IMAGES = 9;

export function selectNexprintGalleryImages(model, requested = model.nexprintImageIds) {
  const candidates = model.assets.filter(asset => asset.id !== model.coverId && ['photo', 'render', 'diagram'].includes(asset.role));
  const ids = requested === undefined ? [] : requested;
  if (!Array.isArray(ids) || ids.length > NEXPRINT_MAX_IMAGES || new Set(ids).size !== ids.length)
    throw new UserActionRequired(`NexPrint 图片选择无效，最多可选择 ${NEXPRINT_MAX_IMAGES} 张`);
  const gallery = ids.map(id => candidates.find(asset => asset.id === id));
  if (gallery.some(asset => !asset)) throw new UserActionRequired('NexPrint 图片选择包含不存在或用途不支持的图片，请在模型资料中重新选择');
  return { gallery, omitted: candidates.length - gallery.length };
}

async function field(page, labels, selector = 'input:not([type=file]):not([type=radio]):not([type=checkbox]), textarea, iframe, [contenteditable="true"]') {
  const candidates = await page.evaluate(({ labels, selector }) => {
    const norm = s => s.replace(/\*/g, '').replace(/[:：?？]/g, '').trim();
    const css = el => { if (el.id) return `#${CSS.escape(el.id)}`; const parts = []; while (el && el !== document.body) { const n = [...el.parentElement.children].filter(s => s.tagName === el.tagName).indexOf(el) + 1; parts.unshift(`${el.tagName.toLowerCase()}:nth-of-type(${n})`); el = el.parentElement; } return `body > ${parts.join(' > ')}`; };
    const hits = new Set();
    for (const el of document.querySelectorAll('label,p,span,div,h1,h2,h3,h4')) {
      if (!labels.includes(norm(el.innerText || '')) || !el.getBoundingClientRect().width) continue;
      const forId = el.getAttribute('for');
      if (forId && document.getElementById(forId)?.matches(selector)) { hits.add(css(document.getElementById(forId))); continue; }
      let parent = el;
      for (let depth = 0; parent && depth < 5; parent = parent.parentElement, depth++) {
        const controls = [...parent.querySelectorAll(selector)].filter(e => e.type === 'file' || e.tagName === 'IFRAME' || e.getBoundingClientRect().width);
        if (controls.length === 1) { hits.add(css(controls[0])); break; }
        if (controls.length > 1) break;
      }
    }
    return [...hits];
  }, { labels, selector });
  if (candidates.length !== 1) throw new UserActionRequired(`需要在平台页面检查“${labels[0]}”字段，自动定位未取得唯一结果`);
  return candidates[0];
}
function retryableLocatorError(error) {
  return /Timeout|not attached|detached|stale element/i.test(error?.message || '');
}
export async function fillText(page, labels, value) {
  let lastError;
  for (let attempt = 0; attempt < 3; attempt++) {
    const selector = await field(page, labels);
    const input = page.locator(selector);
    try {
      const tagName = await input.evaluate(el => el.tagName, undefined, { timeout: 18000 });
      if (tagName === 'IFRAME') await page.frameLocator(selector).locator('body').fill(value, { timeout: 18000 });
      else await input.fill(value, { timeout: 18000 });
      return;
    } catch (error) {
      lastError = error;
      if (!retryableLocatorError(error) || attempt === 2) break;
    await page.waitForTimeout(300);
    }
  }
  throw new UserActionRequired(`平台“${labels[0]}”字段在页面更新后仍无法定位或填写：${lastError?.message?.split('\n')[0] || '未知错误'}`);
}
async function choose(page, locator, files) {
  // Chrome can suppress native file chooser events for a background CDP tab.
  // Bring the target page forward before clicking any upload control.
  await page.bringToFront?.();
  const candidates = await locator.all();
  const visible = [];
  for (const candidate of candidates) if (await candidate.isVisible()) visible.push(candidate);
  const trigger = visible.at(-1) || locator;
  const pending = page.waitForEvent('filechooser', { timeout: 15000 }).then(chooser => ({ chooser }), error => ({ error }));
  await trigger.click();
  const result = await pending;
  if (result.error) throw new UserActionRequired('没有打开预期的文件选择器，请在浏览器检查上传入口');
  await result.chooser.setFiles(files);
}
export async function chooseNexprintFileInput(page, selector, files) {
  const input = page.locator(selector);
  const count = await input.count();
  if (count !== 1) throw new UserActionRequired(`NexPrint 上传控件${count ? '不唯一' : '未找到'}，请检查图片上传区域`);
  await choose(page, input.locator('xpath=../div[@class="el-upload-dragger"]'), files);
}
export async function confirmNexprintCrop(page) {
  const button = page.getByRole('button', { name: '好的', exact: true });
  // File selection resolves before the image is decoded and the cropper is
  // mounted. An immediate count() === 0 must not skip this required step.
  try { await button.waitFor({ state: 'visible', timeout: 15000 }); }
  catch { throw new UserActionRequired('NexPrint 选择封面后未出现裁剪确认弹窗，请检查图片加载提示'); }
  const count = await button.count();
  if (count !== 1 || !await button.isVisible()) throw new UserActionRequired(`NexPrint 封面裁剪弹窗确认按钮异常（匹配数 ${count}）`);
  let clickError;
  try {
    // The cropper is rendered above a page-wide Element Plus overlay. In CDP
    // sessions Playwright can report the button as visible yet never consider
    // it actionable, even though the same button is enabled in the page.
    await button.click({ timeout: 2500 });
  } catch (error) {
    clickError = error;
    // If the first click reached the app, NexPrint disables the button while
    // uploading the cropped image. Do not click twice in that state.
    if (await button.isVisible() && await button.isEnabled()) {
      try { await button.click({ force: true, timeout: 5000 }); }
      catch (forcedError) {
        throw new UserActionRequired(`NexPrint 封面裁剪“好的”按钮未能点击：${forcedError.message.split('\n')[0]}`);
      }
    }
  }
  // A successful click starts an asynchronous crop/upload and briefly disables
  // the button. The next uploader must wait for the cropper overlay to leave.
  try { await button.waitFor({ state: 'hidden', timeout: 45000 }); }
  catch {
    const state = `按钮${await button.isVisible() ? '仍可见' : '已关闭'}`;
    const cause = clickError ? `；普通点击未完成：${clickError.message.split('\n')[0]}` : '';
    throw new UserActionRequired(`NexPrint 封面裁剪已触发，但等待弹窗关闭超时（${state}${cause}）`);
  }
}
export async function uploadNexprintProfiles(page, filePaths, log = () => {}, { timeoutMs = 45000, retryMs = 1000 } = {}) {
  // The server-rendered file input exists before NexPrint attaches its change
  // handler. setInputFiles at DOMContentLoaded can populate FileList without
  // ever starting an upload. The live drop-zone opening a chooser proves that
  // its event handler is installed; do not select files until that happens.
  await page.bringToFront?.();
  const trigger = page.locator('.upload-file-uploader .el-upload-dragger');
  await trigger.waitFor({ state: 'visible', timeout: timeoutMs });
  if (await trigger.count() !== 1) throw new UserActionRequired('NexPrint 模型上传入口不唯一，请检查上传页面');
  let result;
  const pending = page.waitForEvent('filechooser', { timeout: timeoutMs }).then(
    chooser => { result = { chooser }; }, error => { result = { error }; });
  const started = Date.now(); let lastLog = -5;
  log('等待 NexPrint 上传控件完成初始化', 18);
  while (!result) {
    // Early clicks on server-rendered markup do nothing. A single listener
    // spans all attempts, and files are assigned exactly once after it fires.
    try { await trigger.click({ timeout: Math.min(1500, timeoutMs) }); } catch {}
    if (result) break;
    const seconds = Math.floor((Date.now() - started) / 1000);
    if (seconds - lastLog >= 5) { log(`等待 NexPrint 上传控件初始化（${seconds} 秒），尚未发送文件`, 18); lastLog = seconds; }
    await Promise.race([pending, new Promise(resolve => setTimeout(resolve, retryMs))]);
  }
  if (result.error) throw new UserActionRequired('NexPrint 上传控件未完成初始化，未发送模型文件。请检查页面加载或登录提示');
  await result.chooser.setFiles(filePaths);
  log('已通过 NexPrint 上传入口选择模型文件', 20);
}
async function uploadTriggerNearHeading(page, heading) {
  const result = await page.evaluate(heading => {
    const norm = value => String(value || '').replace(/\s+/g, ' ').trim();
    const visible = el => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el); return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none'; };
    const css = el => {
      if (el.id) return `#${CSS.escape(el.id)}`;
      const parts = [];
      while (el && el !== document.body) {
        const index = [...el.parentElement.children].filter(sibling => sibling.tagName === el.tagName).indexOf(el) + 1;
        parts.unshift(`${el.tagName.toLowerCase()}:nth-of-type(${index})`); el = el.parentElement;
      }
      return `body > ${parts.join(' > ')}`;
    };
    const labels = [...document.querySelectorAll('body *')].filter(el => el.children.length === 0 && norm(el.innerText || el.textContent).startsWith(heading) && visible(el));
    const label = labels[0];
    for (let parent = label, depth = 0; parent && parent !== document.body && depth < 8; parent = parent.parentElement, depth++) {
      const buttons = [...parent.querySelectorAll('button,[role="button"]')].filter(button => visible(button) && norm(button.innerText || button.textContent).includes('上传图片'));
      if (buttons.length === 1) return { selector: css(buttons[0]), debug: null };
    }
    const debug = labels.slice(0, 3).map(el => {
      const ancestors = [];
      for (let parent = el, depth = 0; parent && parent !== document.body && depth < 5; parent = parent.parentElement, depth++)
        ancestors.push({ tag: parent.tagName, cls: String(parent.className || '').slice(0, 100), text: norm(parent.innerText || parent.textContent).slice(0, 180), buttons: [...parent.querySelectorAll('button,[role="button"]')].map(button => norm(button.innerText || button.textContent).slice(0, 50)).slice(0, 8) });
      return { tag: el.tagName, text: norm(el.innerText || el.textContent), ancestors };
    });
    return { selector: null, debug: { labels: labels.length, candidates: debug } };
  }, heading);
  if (!result.selector) throw new UserActionRequired(`无法在“${heading}”区域唯一定位图片上传按钮；DOM：${JSON.stringify(result.debug)}`);
  return page.locator(result.selector);
}
export async function selectInput(page, labels, option) {
  let selector, input, tagName, opened = false, lastOpenError;
  for (let attempt = 0; attempt < 3; attempt++) {
    selector = await field(page, labels, 'input:not([type=file]), select, [role=combobox]');
    input = page.locator(selector);
    try {
      tagName = await input.evaluate(e => e.tagName, undefined, { timeout: 15000 });
      if (tagName === 'SELECT') break;
      const current = await input.evaluate(e => e.value || e.getAttribute('aria-valuetext') || e.getAttribute('data-value') || '', undefined, { timeout: 15000 });
      if (String(current).replace(/\s+/g, ' ').trim() === option) { opened = true; break; }
      try { await input.click({ timeout: 3000 }); opened = true; }
      catch (error) {
        lastOpenError = error;
        try { await input.click({ force: true, timeout: 2500 }); opened = true; }
        catch (forceError) { lastOpenError = forceError; }
      }
      if (opened) break;
    } catch (error) {
      lastOpenError = error;
      if (!retryableLocatorError(error)) break;
    }
    if (attempt < 2) await page.waitForTimeout(300);
  }
  if (!input || !opened && tagName !== 'SELECT') {
    throw new UserActionRequired(`创想云“${labels[0]}”控件在页面更新后仍无法打开；最近错误：${lastOpenError?.message?.split('\n')[0] || '控件未响应'}`);
  }
  const matchesOption = value => String(value || '').replace(/\s+/g, ' ').trim() === option;
  const resolveInput = async () => page.locator(await field(page, labels, 'input:not([type=file]), select, [role=combobox]'));
  const currentValue = async () => (await resolveInput()).evaluate(e => ({
    value: e.value || '', text: e.innerText || e.textContent || '',
    ariaValue: e.getAttribute('aria-valuetext') || '', dataValue: e.getAttribute('data-value') || '',
  }));
  const alreadySelected = async () => Object.values(await currentValue()).some(matchesOption);
  if (tagName === 'SELECT') {
    try { await input.selectOption({ label: option }); return; }
    catch { throw new UserActionRequired(`创想云“${labels[0]}”下拉框中没有可选项“${option}”`); }
  }
  if (await alreadySelected()) return;
  // Element Plus cascaders expand a branch when its text is clicked. Select
  // the branch's radio explicitly, then reacquire the field after rerendering.
  // Its teleported popup is mounted asynchronously after click() resolves.
  try {
    await page.getByRole('menuitem').filter({ hasText: option }).first().waitFor({ state: 'visible', timeout: 5000 });
  } catch {}
  const menuItems = await page.getByRole('menuitem').all();
  for (const item of menuItems) {
    if (!await item.isVisible() || !matchesOption(await item.innerText())) continue;
    const radios = item.getByRole('radio');
    if (await radios.count() !== 1) continue;
    // The popup may unmount on selection; check() would then wait for the
    // removed radio. Verify the durable field value after one normal click.
    await radios.click({ force: true, timeout: 2500 });
    if (await alreadySelected()) return;
  }
  // The control was already opened above; its React/Vue rerender may replace
  // the positional selector, so do not click it a second time here.
  const choices = page.getByRole('option').filter({ hasText: option });
  const clickVisibleCandidate = async locator => {
    const candidates = await locator.all();
    for (const candidate of candidates.reverse()) {
      if (!await candidate.isVisible()) continue;
      try { await candidate.click({ timeout: 2500 }); return true; } catch {}
      try { await candidate.click({ force: true, timeout: 2500 }); return true; } catch {}
      try {
        await candidate.evaluate(el => {
          const actionable = el.closest('button,[role=option],[role=menuitem],li,label,[tabindex]') || el.parentElement || el;
          actionable.click();
        });
        return true;
      } catch {}
    }
    return false;
  };
  // 创想云的类别控件也是一个可搜索输入框。过滤后再选能避开页面上
  // 同名提示文案，也能让较长的分类菜单稳定显示目标项。
  try {
    input = await resolveInput();
    await input.fill(option, { timeout: 2500 });
    await page.waitForTimeout(350);
    const filtered = page.getByText(option, { exact: true });
    if (await clickVisibleCandidate(filtered) && await alreadySelected()) return;
    try { await input.press('Enter', { timeout: 1500 }); } catch {}
    if (await alreadySelected()) return;
  } catch {}
  if (await clickVisibleCandidate(choices) && await alreadySelected()) return;
  if (await alreadySelected()) return;
  const exact = page.getByText(option, { exact: true });
  if (await clickVisibleCandidate(exact) && await alreadySelected()) return;
  if (await alreadySelected()) return;
  const visibleOptions = await page.evaluate(() => [...document.querySelectorAll('[role=option],option,li,button')]
    .filter(el => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== 'hidden' && getComputedStyle(el).display !== 'none'; })
    .map(el => (el.innerText || el.textContent || '').trim()).filter(Boolean).slice(0, 12));
  const value = await currentValue();
  const domInfo = await page.evaluate(option => {
    const visible = el => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el); return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none'; };
    const items = [...document.querySelectorAll('body *')].filter(el => visible(el) && el.children.length === 0 && (el.innerText || el.textContent || '').trim() === option).slice(0, 3).map(el => ({
      tag: el.tagName, role: el.getAttribute('role'), className: String(el.className || '').slice(0, 120),
      ariaSelected: el.getAttribute('aria-selected'), parent: el.parentElement?.outerHTML.slice(0, 700),
    }));
    return { items };
  }, option);
  throw new UserActionRequired(`创想云“${labels[0]}”列表中无法选择“${option}”（控件：${tagName}，当前值：${Object.values(value).filter(Boolean).join(' / ') || '空'}）；当前可见选项：${visibleOptions.join('、') || '未检测到'}；DOM：${JSON.stringify(domInfo)}`);
}
async function fillDescription(page, labels, description) {
  await fillText(page, labels, description);
}
export function summarizeNexprintUpload(state) {
  const input = state.inputs?.find(item => item.files?.length);
  const button = state.buttons?.find(item => item.text === '模型信息');
  const error = state.errors?.find(Boolean);
  const details = [
    input ? `浏览器已选文件：${input.files.join('、')}` : '浏览器文件选择已清空',
    state.queuedFiles?.length ? `网站上传队列：${state.queuedFiles.join('、')}` : '网站尚未显示上传文件',
    button ? `“模型信息”按钮${button.disabled ? '仍禁用' : '已启用'}` : state.processing ? '网站正在解析模型' : '页面未检测到“模型信息”按钮',
    state.progress?.length ? `处理状态：${state.progress.join('；')}` : '',
    Number.isInteger(state.galleryCount) ? `实物图片：${state.galleryCount}/9` : '',
    state.dialogs?.length ? `待处理提示：${state.dialogs.join('；')}` : '',
    state.visibility === 'hidden' ? '上传标签页处于后台' : '',
    error ? `页面提示：${error}` : '',
  ].filter(Boolean);
  return { ready: Boolean(button && !button.disabled), started: Boolean(state.queuedFiles?.length || state.progress?.length || state.processing), error: error || null, message: details.join('。') };
}
export async function setNexprintLicense(page, license) {
  // Standard Digital File License is representable as no derivatives, no
  // commercial use, and no redistribution. Other source licenses need their
  // own verified mapping before automation can safely select them.
  const answers = license === 'standard' ? ['否', '否', '否'] : null;
  if (!answers) throw new UserActionRequired(`NexPrint 尚无经过验证的“${license}”许可映射，请检查授权选项`);
  for (let i = 0; i < answers.length; i++) {
    const matches = await page.getByRole('radio', { name: answers[i], exact: true }).all();
    // The first matching “是/否” radio belongs to the separate materials
    // question; the next three groups are the license questionnaire in order.
    const radio = matches[i + 1];
    if (!radio) throw new UserActionRequired(`NexPrint 许可问题 ${i + 1} 未找到选项“${answers[i]}”`);
    await ensureRadioSelected(radio, answers[i], `NexPrint 许可问题 ${i + 1}`);
  }
  const text = await page.locator('body').innerText();
  if (!/Standard Digital File License/.test(text)) throw new UserActionRequired('NexPrint 许可结果与源站 Standard Digital File License 不一致，请检查授权问卷');
}
async function ensureRadioSelected(radio, name, platform) {
  if (await radio.isChecked()) return;
  try { await radio.check({ force: true, timeout: 4000 }); } catch {}
  if (await radio.isChecked()) return;
  try { await radio.click({ force: true, timeout: 3000 }); } catch {}
  if (await radio.isChecked()) return;
  throw new UserActionRequired(`${platform} 无法选择“${name}”单选项，请检查页面步骤或遮挡弹窗`);
}
export async function selectRadioOption(page, name, platform) {
  const radio = page.getByRole('radio', { name, exact: true });
  const count = await radio.count();
  if (count !== 1) throw new UserActionRequired(`${platform} 页面中“${name}”单选项${count ? '不唯一' : '未找到'}，请检查当前表单步骤`);
  if (await radio.isChecked()) return;
  try { await radio.check({ force: true, timeout: 4000 }); } catch {}
  if (await radio.isChecked()) return;
  const labels = page.getByText(name, { exact: true });
  if (await labels.count()) {
    const label = labels.last();
    if (await label.isVisible()) {
      try { await label.click({ timeout: 4000 }); } catch {}
    }
  }
  if (await radio.isChecked()) return;
  throw new UserActionRequired(`${platform} 无法选择“${name}”单选项；已尝试控件和可见标签，请检查页面是否仍在上传步骤或有弹窗遮挡`);
}
async function nexprintUploadState(page) {
  return page.evaluate(() => {
    const visible = el => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el); return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none'; };
    const inputs = [...document.querySelectorAll('input[type=file]')].map(el => ({
      accept: el.accept, files: [...(el.files || [])].map(file => `${file.name} (${file.size} bytes)`),
    }));
    const buttons = [...document.querySelectorAll('button,[role=button]')].filter(visible).map(el => ({
      text: (el.innerText || el.getAttribute('aria-label') || '').trim(),
      disabled: Boolean(el.disabled || el.getAttribute('aria-disabled') === 'true'),
    }));
    const uploader = document.querySelector('.upload-file-uploader');
    const queuedFiles = uploader ? [...uploader.querySelectorAll('[title]')].filter(visible)
      .map(el => el.getAttribute('title')).filter(text => /\.(?:3mf|stl|obj|step|stp)$/i.test(text || '')) : [];
    const dialogs = [...document.querySelectorAll('[role=dialog],.el-dialog,.el-message-box')].filter(visible)
      .map(el => (el.innerText || '').trim()).filter(Boolean).slice(0, 2);
    const errors = [...document.querySelectorAll('[role=alert], [class*=error i], [class*=message i]')]
      .filter(visible).map(el => (el.innerText || '').trim()).filter(text => text && /失败|错误|无效|不支持|超出|超过|上限|未完成/.test(text)).slice(0, 3);
    const galleryCount = Number((document.body.innerText.match(/实物图片\s*\(\s*(\d+)\s*\/\s*9\s*\)/) || [])[1]);
    const progress = [...document.querySelectorAll('[role=progressbar],progress,[aria-busy=true]')].filter(visible).map(el =>
      (el.innerText || el.getAttribute('aria-label') || el.getAttribute('aria-valuenow') || '正在处理').trim()).filter(Boolean).slice(0, 3);
    return { inputs, buttons, errors, progress, queuedFiles, dialogs, galleryCount: Number.isInteger(galleryCount) ? galleryCount : null, visibility: document.visibilityState,
      processing: buttons.some(button => /解析中|上传中|处理中/.test(button.text)) };
  });
}
export async function waitNexprintGallery(page, expectedCount, { timeoutMs = 45000, pollMs = 400 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let latest;
  while (Date.now() < deadline) {
    latest = await nexprintUploadState(page);
    if (latest.errors?.length) throw new UserActionRequired(`NexPrint 图片上传被平台拒绝：${latest.errors[0]}`);
    if (latest.galleryCount === expectedCount) return latest.galleryCount;
    await page.waitForTimeout(pollMs);
  }
  throw new UserActionRequired(`NexPrint 图片上传未确认：实物图片显示 ${Number.isInteger(latest?.galleryCount) ? latest.galleryCount : '未知'}/${NEXPRINT_MAX_IMAGES}，预期 ${expectedCount} 张。请检查图片区域后重试`);
}
async function fillTags(page, tags) {
  if (!tags.length) return;
  const selector = await field(page, ['标签', '模型标签']);
  for (const tag of tags.slice(0, 10)) { await page.locator(selector).fill(tag); await page.locator(selector).press('Enter'); }
}
async function accountIdentity(page, target) {
  return page.evaluate(target => {
    const pattern = target === 'nexprint' ? /\/U\d+\/home/ : /\/user\/\d+/;
    return [...document.querySelectorAll('header a[href],nav a[href],[role=menubar] a[href]')]
      .map(e => e.href).find(href => pattern.test(href)) || null;
  }, target);
}

export class TargetExecutor {
  constructor(browser, store) { this.browser = browser; this.store = store; this.prepared = new Map(); }
  async prepare(task, model, log, { signal } = {}) {
    const page = await this.browser.page(`target-${task.id}`);
    if (signal?.aborted) {
      await this.browser.closePage?.(`target-${task.id}`);
      throw new UserActionRequired('同步已中断');
    }
    const url = task.target === 'nexprint' ? 'https://www.nexprint.cn/zh/upload' : PLATFORMS.creality.url;
    // Creator pages sometimes delay DOMContentLoaded while loading analytics and
    // large client bundles. Wait for the response to commit, then let each
    // adapter wait for its actual upload control.
    try { await page.goto(url, { waitUntil: 'commit', timeout: 45000 }); }
    catch (error) {
      if (/Timeout/i.test(error?.message || '')) {
        throw new UserActionRequired(`目标平台上传页 45 秒内未完成连接（${task.target === 'creality' ? '创想云' : 'NexPrint'}）。请检查网络后重试；本次尚未提交。`);
      }
      throw error;
    }
    if (/account\.|login|sign-in/.test(new URL(page.url()).hostname + new URL(page.url()).pathname))
      throw new UserActionRequired('请在已连接的浏览器中登录后重试。模型资料已保留。', { pageUrl: page.url() });
    log('上传原始模型与打印配置', 20);
    try {
      if (task.target === 'creality') await this.creality(page, task, model, log);
      else await this.nexprint(page, task, model, log);
    } catch (error) {
      const details = { ...(error.details || {}) };
      try {
        details.pageUrl = page.url();
        details.screenshot = await this.browser.evidence(page, `failure-${task.id}`);
      } catch {}
      error.details = details;
      throw error;
    }
    const declaration = await this.readDeclaration(page, task.target);
    const account = await accountIdentity(page, task.target);
    const screenshot = await this.browser.evidence(page, task.id);
    this.prepared.set(task.id, { page, declaration, account });
    return { pageUrl: page.url(), declaration, screenshot, account };
  }
  async cancel(taskId) {
    this.prepared.delete(taskId);
    await this.browser.closePage?.(`target-${taskId}`);
  }
  forget(taskId) { this.prepared.delete(taskId); }
  async verify(task, model) {
    if (task.target !== 'nexprint') throw new UserActionRequired('当前仅支持核验 NexPrint 草稿');
    // A separate page preserves the upload form when saving was rejected or
    // the result is still unknown. Never click Save again during verification.
    const page = await this.browser.page(`verify-${task.id}`);
    await page.goto('https://www.nexprint.cn/zh/creator/model-management/drafts', { waitUntil: 'domcontentloaded', timeout: 45000 });
    const title = page.getByRole('heading', { name: model.title, exact: true });
    const deadline = Date.now() + 30000;
    for (;;) {
      try { await title.first().waitFor({ state: 'visible', timeout: 2500 }); break; }
      catch {
        if (Date.now() >= deadline) throw new SubmissionUncertain('草稿箱尚未核对到对应标题，原上传页面已保留；请稍后再检查保存结果');
        await page.reload({ waitUntil: 'domcontentloaded', timeout: 15000 });
      }
    }
    if (await title.count() !== 1) throw new SubmissionUncertain('草稿箱有多个同名模型，请核对具体草稿，避免错误关联');
    const screenshot = await this.browser.evidence(page, `saved-${task.id}`);
    return { url: page.url(), verified: true, verifiedBy: 'platform', mode: 'draft', screenshot };
  }
  async creality(page, task, model, log) {
    const filePaths = model.profiles.map(p => p.file.path);
    await page.getByRole('button', { name: '将3mf文件拖到此处', exact: false }).waitFor({ timeout: 30000 });
    await choose(page, page.getByRole('button', { name: '将3mf文件拖到此处', exact: false }), [filePaths[0]]);
    await choose(page, page.getByRole('button', { name: '将文件拖到此处 支持.stl', exact: false }), filePaths);
    await page.getByText('下一步', { exact: true }).click();
    log('选择模型原创性与可见性', 30);
    await selectRadioOption(page, { original: '原创模型', remix: '二次创作模型', shared: '分享模型' }[model.authorship], '创想云');
    await selectRadioOption(page, '只对自己', '创想云');
    await fillText(page, ['名称', '模型名称'], model.title);
    log('填写说明、许可与可见性', 45);
    log('选择创想云模型分类', 48);
    await selectInput(page, ['类别', '分类'], model.category || '艺术与设计');
    log('填写创想云模型标签', 52);
    await fillTags(page, model.tags);
    log('设置创想云许可问卷', 58);
    await this.crealityLicense(page, model.license);
    const cover = model.assets.find(a => a.id === model.coverId);
    for (let i = 0; i < 2; i++) {
      await choose(page, page.getByText('封面图', { exact: true }).first(), [cover.path]);
      await page.getByRole('button', { name: '确认', exact: true }).click({ timeout: 30000 });
      await page.getByRole('dialog', { name: '图片裁剪', exact: true }).waitFor({ state: 'hidden', timeout: 20000 });
    }
    const photos = model.assets.filter(a => a.role === 'photo' && a.id !== cover.id).slice(0, 8);
    if (photos.length) {
      await choose(page, await uploadTriggerNearHeading(page, '模型图片'), photos.map(a => a.path));
    }
    const config = model.profiles[0];
    await fillDescription(page, ['描述', '模型描述'], `${model.description}\n\n原始文件：\n${model.profiles.map(p => p.file.name).join('\n')}\n\n平台可能将原始 Bambu/Orca 配置转换为 Creality Print。打印前请核对喷嘴、层高、耗材和切片参数。`);
    await fillText(page, ['打印配置名', '打印配置名称'], config.name.slice(0, 60));
    await fillDescription(page, ['打印配置描述'], config.description || `${config.name}\n源站参数：${JSON.stringify(config.parameters || {})}\n平台转换后需核对切片参数。`);
    const diagrams = [...model.assets.filter(a => a.role === 'diagram'), ...model.assets.filter(a => a.role === 'photo' && a.id !== cover.id).slice(8)];
    if (diagrams.length) await choose(page, page.getByRole('button', { name: /支持\.pdf/ }), diagrams.map(a => a.path));
    log('已填入模型表单，等待用户复核', 85);
  }
  async crealityLicense(page, license) {
    const answers = {
      standard: ['否', '否', '否'], 'cc-by-nc': ['是', '否'], cc0: ['是', '是', '是'],
      'cc-by': ['是', '是', '否'], 'cc-by-nc-sa': ['是，但需要使用相同的方式共享', '否'],
      'cc-by-sa': ['是，但需要使用相同的方式共享', '是'],
    }[license];
    if (!answers) throw new UserActionRequired('创想云没有已验证的许可映射，请手动核对许可');
    // Creator Cloud's custom radio layout does not expose radiogroup roles.
    // Resolve each answer by its document-order occurrence; the question rows
    // appear in the same order as the license mapping above.
    for (let i = 0; i < answers.length; i++) {
      const matching = await page.getByRole('radio', { name: answers[i], exact: true }).all();
      const radio = matching[i];
      if (!radio) throw new UserActionRequired(`创想云许可问题 ${i + 1} 未找到选项“${answers[i]}”`);
      await ensureRadioSelected(radio, answers[i], `创想云许可问题 ${i + 1}`);
    }
    const expected = { standard: /禁止|不得|Standard|标准/, 'cc-by-nc': /CC BY-NC/, cc0: /CC0/, 'cc-by': /CC BY/, 'cc-by-sa': /CC BY-SA/, 'cc-by-nc-sa': /CC BY-NC-SA/ }[license];
    const text = await page.locator('body').innerText();
    if (!expected.test(text)) throw new UserActionRequired(`目标许可结果未验证：${license}，请在浏览器检查`);
  }
  async nexprint(page, task, model, log) {
    await uploadNexprintProfiles(page, model.profiles.map(p => p.file.path), log);
    const info = page.getByRole('button', { name: '模型信息', exact: true });
    const timeoutMs = 180000, pollMs = 1000, started = Date.now(); let lastLog = 0, lastSummary = '';
    while (Date.now() - started < timeoutMs) {
      const state = summarizeNexprintUpload(await nexprintUploadState(page));
      if (state.ready) break;
      if (state.error) throw new UserActionRequired(`NexPrint 文件处理失败。${state.message}`);
      const elapsed = Math.floor((Date.now() - started) / 1000);
      if (elapsed - lastLog >= 10 || !lastLog) {
        lastLog = elapsed;
        const message = `NexPrint ${state.started ? '正在上传或解析文件' : '等待网站接收文件'}（${elapsed} 秒）。${state.message}`;
        if (message !== lastSummary) { log(message, Math.min(38, 20 + Math.floor(elapsed / 15))); lastSummary = message; }
      }
      await new Promise(resolve => setTimeout(resolve, pollMs));
    }
    if (!await info.isEnabled()) {
      const state = summarizeNexprintUpload(await nexprintUploadState(page));
      throw new UserActionRequired(`NexPrint 文件处理超时（${Math.floor((Date.now() - started) / 1000)} 秒）。${state.message}。请检查浏览器中的上传提示后再重试`);
    }
    await info.click(); log('填写模型资料', 45);
    await fillText(page, ['模型名称', '名称', '标题'], model.title);
    await fillDescription(page, ['模型详情介绍', '模型描述', '模型说明', '描述', '介绍'], model.description);
    const type = { original: '原创模型', remix: '二次创作模型', shared: '分享模型' }[model.authorship];
    await selectRadioOption(page, type, 'NexPrint');
    await setNexprintLicense(page, model.license);
    const cover = model.assets.find(a => a.id === model.coverId);
    log('上传 NexPrint 封面图片', 60);
    await chooseNexprintFileInput(page, 'input[type="file"][accept*=".jpeg"]:not([multiple]):not([disabled])', [cover.path]);
    log('等待并确认 NexPrint 封面裁剪弹窗', 65);
    await confirmNexprintCrop(page);
    const { gallery, omitted } = selectNexprintGalleryImages(model, task.imageAssetIds);
    log(`NexPrint 实物图片：已选择 ${gallery.length}/${NEXPRINT_MAX_IMAGES} 张${omitted ? `，其余 ${omitted} 张仍保留在模型库` : ''}`, 72);
    if (gallery.length) {
      log('上传 NexPrint 模型图片', 75);
      await chooseNexprintFileInput(page, 'input[type="file"][multiple][accept*=".jpeg"]:not([disabled])', gallery.map(a => a.path));
      await waitNexprintGallery(page, gallery.length);
    }
    log('表单已准备，仅执行保存草稿', 85);
  }
  async readDeclaration(page, target) {
    if (target === 'creality') {
      const statement = page.getByText('《模型声明》', { exact: true });
      await statement.click();
      const text = await page.getByRole('dialog').last().innerText();
      await page.getByRole('button', { name: '关闭此对话框' }).last().click();
      return text.replace(/模型声明|确认/g, '').trim();
    }
    const boxes = await page.getByRole('checkbox').all();
    for (const box of boxes) {
      const label = await box.evaluate(e => e.closest('label')?.innerText || '');
      if (/声明|协议|同意/.test(label)) throw new UserActionRequired('NexPrint 出现需接受的声明，请在浏览器阅读并完成后检查表单');
    }
    return '';
  }
  async commit(task, model) {
    const prepared = this.prepared.get(task.id);
    if (!prepared || prepared.page.isClosed()) throw new UserActionRequired('准备页面已关闭，请检查目标平台后重新准备');
    const { page } = prepared;
    const identity = await accountIdentity(page, task.target);
    if (prepared.account && prepared.account !== identity) throw new UserActionRequired('目标账号发生变化，停止保存，请重新准备');
    if (task.target === 'creality') {
      const privacy = page.getByRole('radio', { name: '只对自己', exact: true });
      if (!await privacy.isChecked()) throw new UserActionRequired('可见性已改变，请重新准备私密表单');
      await page.getByText('《模型声明》', { exact: true }).click();
      const text = (await page.getByRole('dialog').last().innerText()).replace(/模型声明|确认/g, '').trim();
      if (text !== prepared.declaration) throw new UserActionRequired('模型声明内容已变化，请重新核对');
      await page.getByRole('button', { name: '确认', exact: true }).click();
      await page.getByText('提交', { exact: true }).click();
      try { await page.waitForURL('**/model-detail/**', { timeout: 60000 }); }
      catch { throw new SubmissionUncertain('未取得模型详情页，请检查创想云列表后再决定重试'); }
      await page.getByRole('heading', { name: model.title, exact: true }).waitFor({ timeout: 20000 });
      const screenshot = await this.browser.evidence(page, `saved-${task.id}`);
      return { url: page.url(), verified: true, mode: 'private', visibilityVerified: '提交前已核对只对自己', screenshot };
    }
    const { gallery } = selectNexprintGalleryImages(model, task.imageAssetIds);
    const imageState = await nexprintUploadState(page);
    if (imageState.errors?.length) throw new UserActionRequired(`NexPrint 图片上传被平台拒绝：${imageState.errors[0]}`);
    if (imageState.galleryCount !== gallery.length) throw new UserActionRequired(`NexPrint 实物图片尚未达到所选数量（当前 ${Number.isInteger(imageState.galleryCount) ? imageState.galleryCount : '未知'} 张，已选 ${gallery.length} 张），请重新准备后再保存`);
    await page.getByRole('button', { name: '保存为草稿', exact: true }).click();
    // NexPrint can save a draft without navigating or showing a success toast.
    // The persisted draft, rather than either transient signal, is the proof.
    return this.verify(task, model);
  }
}
