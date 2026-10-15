import { createHash, randomUUID } from 'node:crypto';

export const PLATFORMS = {
  makerworld: { name: 'MakerWorld', url: 'https://makerworld.com.cn/zh', role: 'source' },
  nexprint: { name: 'NexPrint', url: 'https://www.nexprint.cn/zh/creator', mode: 'draft', role: 'target' },
  creality: { name: '创想云', url: 'https://www.crealitycloud.cn/create-model', mode: 'private', role: 'target' },
};
export class UserActionRequired extends Error {
  constructor(message, details = {}) { super(message); this.name = 'UserActionRequired'; this.details = details; }
}
export class SubmissionUncertain extends Error {
  constructor(message, details = {}) { super(message); this.name = 'SubmissionUncertain'; this.details = details; }
}
export function parseSource(input) {
  let u;
  try { u = new URL(String(input).trim()); } catch { throw new Error('请填写有效的 MakerWorld 模型链接'); }
  const match = u.pathname.match(/^\/zh\/models\/(\d+)(?:[-/]|$)/);
  if (u.protocol !== 'https:' || u.hostname !== 'makerworld.com.cn' || u.username || u.password || !match)
    throw new Error('第一版支持 makerworld.com.cn/zh/models/ 下的 HTTPS 模型链接');
  return { platform: 'makerworld', id: match[1], url: u.href, profileId: parseProfileId(u.href) };
}
export function parseProfileId(input) {
  let hash;
  try { hash = new URL(input, 'https://makerworld.com.cn').hash.slice(1); } catch { return null; }
  const queryId = new URLSearchParams(hash).get('profileId');
  if (/^\d+$/.test(queryId || '')) return queryId;
  return hash.match(/(?:^|[&#])profileId-(\d+)(?:$|[&#])/i)?.[1] || null;
}
export function profileLinksForModel(links, modelUrl) {
  let model;
  try { model = new URL(modelUrl); } catch { return []; }
  return [...new Set((Array.isArray(links) ? links : []).filter(link => {
    try { const candidate = new URL(link, model); return candidate.origin === model.origin && candidate.pathname === model.pathname && Boolean(parseProfileId(candidate.href)); }
    catch { return false; }
  }))];
}
export function normalizeLicense(raw = '') {
  if (/Standard Digital File License/i.test(raw)) return 'standard';
  if (/CC\s*BY[ -]NC[ -]SA/i.test(raw)) return 'cc-by-nc-sa';
  if (/CC\s*BY[ -]NC/i.test(raw)) return 'cc-by-nc';
  if (/CC0|Public Domain/i.test(raw)) return 'cc0';
  if (/CC\s*BY[ -]SA/i.test(raw)) return 'cc-by-sa';
  if (/CC\s*BY(?:\s|$)/i.test(raw)) return 'cc-by';
  return 'unknown';
}
export function newModel(url) {
  const source = parseSource(url);
  return { id: randomUUID(), source, title: `模型 ${source.id}`, description: '', author: '',
    license: 'unknown', licenseText: '', authorship: 'unconfirmed', category: '艺术与设计', tags: [],
    status: 'pending', profiles: [], assets: [], coverId: null, issues: [], revision: 0,
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
}
export function modelFingerprint(model) {
  return createHash('sha256').update(JSON.stringify({ title: model.title, description: model.description,
    license: model.license, authorship: model.authorship, category: model.category, tags: model.tags,
    coverId: model.coverId, nexprintImageIds: model.nexprintImageIds || null, profiles: model.profiles.map(p => [p.id, p.file?.sha256, p.name]),
    assets: model.assets.map(a => [a.id, a.sha256, a.role]) })).digest('hex');
}
export function taskKey(model, target) { return `${model.source.platform}:${model.source.id}:${target}`; }
export function review(model, target) {
  if (!PLATFORMS[target] || PLATFORMS[target].role !== 'target') throw new Error('不支持的目标平台');
  const blockers = [], warnings = [];
  if (!model.title.trim() || model.status === 'pending') blockers.push('尚未读取模型资料');
  if (!model.profiles.length || model.profiles.some(p => !p.file?.path)) blockers.push('打印配置文件未齐全');
  if (model.license === 'unknown') blockers.push('源站许可尚未确认');
  if (model.authorship === 'unconfirmed') blockers.push('请确认原创／二创／分享类型');
  if (!model.description.trim()) blockers.push('模型说明为空');
  const cover = model.assets.find(a => a.id === model.coverId);
  if (!cover?.path) blockers.push('请选择封面图');
  if (target === 'creality' && cover?.role !== 'photo') blockers.push('创想云封面需选择并确认实拍照片');
  if (target === 'creality' && model.profiles.length > 1) warnings.push(`将创建 1 个主打印配置，并附全部 ${model.profiles.length} 个原始文件`);
  if (target === 'creality') warnings.push('Bambu 配置由平台转换，打印前需核对参数');
  if (target === 'creality' && model.license === 'standard') warnings.push('采用禁止改编／商用／再分发的限制选项；请对照源许可条款');
  if (target === 'nexprint') warnings.push(`封面独立上传；实物图片使用模型资料中手动勾选的 ${model.nexprintImageIds?.length ?? 0} 张，最多 9 张`);
  if (model.assets.some(a => a.role === 'unknown')) blockers.push('请确认全部图片的用途，避免漏传或误作实拍');
  if (target === 'creality' && model.assets.filter(a => a.role === 'photo').length > 9) warnings.push('超过图库上限的实拍照片将作为说明附件保留');
  return { target, mode: PLATFORMS[target].mode, blockers, warnings,
    fingerprint: modelFingerprint(model), modelId: model.id, title: model.title,
    files: model.profiles.length, images: model.assets.length, license: model.license };
}
export function safeExternalUrl(value) {
  const u = new URL(value);
  const hosts = ['makerworld.com.cn', 'www.nexprint.cn', 'nexprint.cn', 'www.crealitycloud.cn', 'crealitycloud.cn'];
  if (u.protocol !== 'https:' || !hosts.includes(u.hostname) || u.username || u.password) throw new Error('该链接不是已支持的平台地址');
  return u.href;
}
