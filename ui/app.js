const $ = selector => document.querySelector(selector);
const token = $('meta[name="model-sync-token"]').content;
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const platformNames = { nexprint: 'NexPrint', creality: '创想云', makerworld: 'MakerWorld' };
const licenses = { unknown: '待确认', standard: 'Standard Digital File License', 'cc-by-nc': 'CC BY-NC 4.0', cc0: 'CC0', 'cc-by': 'CC BY 4.0', 'cc-by-sa': 'CC BY-SA 4.0', 'cc-by-nc-sa': 'CC BY-NC-SA 4.0' };
const authorships = { unconfirmed: '待确认', original: '原创模型', remix: '二次创作模型', shared: '分享模型' };
const modelStatuses = { pending: '待读取', collecting: '读取中', collected: '资料已收集', attention: '待补充' };
const taskStatuses = { queued: '排队中', running: '准备中', cancelling: '正在中断', cancelled: '已中断', deleting: '正在删除', ready: '待确认保存', submitting: '保存中', saved: '已保存', attention: '需要处理', failed: '失败' };
let state = { models: [], tasks: [], logs: [] }, view = 'library', selected = new Set(), filter = '', toastTimer, loading = false, showDeletedTasks = false, showDeletedModels = false, editSession = null;
const activeModels = () => state.models.filter(model => !model.deletedAt);
const modelDeleteBlocked = model => state.collecting || state.tasks.some(task => task.modelId === model.id && !task.deletedAt && ['queued', 'running', 'cancelling', 'ready', 'submitting', 'deleting'].includes(task.status));
const modal = $('#modal');
const supportsPermanentDelete = () => state.capabilities?.deletionModes?.includes('permanent');

async function api(route, body) {
  const response = await fetch(`/api/${route}`, { method: body === undefined ? 'GET' : 'POST',
    headers: { 'X-Model-Sync-Token': token, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const value = await response.json(); if (!response.ok) throw new Error(value.error || '操作失败'); return value;
}
function toast(message, error = false) { const element = $('#toast'); element.textContent = message; element.className = error ? 'error' : ''; element.style.display = 'block'; clearTimeout(toastTimer); toastTimer = setTimeout(() => element.style.display = 'none', error ? 7000 : 4000); }
async function perform(fn) { try { return await fn(); } catch (error) { toast(error.message, true); } }
async function refresh() {
  if (loading) return; loading = true;
  try { state = await api('state'); render(); syncEditState(); } catch (error) { toast(error.message, true); } finally { loading = false; }
}
function editableFingerprint(model) {
  return JSON.stringify({ title: model.title, description: model.description, authorship: model.authorship,
    license: model.license, category: model.category, tags: model.tags, coverId: model.coverId ?? null,
    assets: model.assets.map(asset => ({ id: asset.id, role: asset.role })), nexprintImageIds: model.nexprintImageIds ?? [] });
}
function profileFingerprint(model) { return JSON.stringify(model.profiles.map(profile => ({ id: profile.id, name: profile.name, sha256: profile.file?.sha256 ?? null }))); }
function syncEditState() {
  const save = modal.open && $('#modal [data-action="save-edit"]');
  if (!save || !editSession) return;
  const model = state.models.find(model => model.id === editSession.id);
  const collect = $('#modal [data-action="collect"]');
  if (collect) collect.disabled = state.collecting || state.busy;
  // Downloads and progress can advance the record revision without changing
  // any editable fields. Rebase only those updates; preserve unsaved controls.
  if (model && !editSession.removedProfiles.size) editSession.baselineProfiles = profileFingerprint(model);
  const conflict = !model || editableFingerprint(model) !== editSession.baseline ||
    editSession.removedProfiles.size > 0 && profileFingerprint(model) !== editSession.baselineProfiles;
  if (model && !conflict) editSession.revision = model.revision;
  const uploading = state.tasks.some(task => task.modelId === editSession.id && ['running', 'cancelling', 'submitting'].includes(task.status));
  save.disabled = Boolean(state.collecting || uploading || conflict || editSession.saving || (editSession.removed.size || editSession.removedProfiles.size) && !$('#confirm-permanent-delete').checked);
  const status = $('#edit-status');
  status.hidden = !(state.collecting || uploading || conflict);
  $('#edit-status-message').textContent = state.collecting ? '正在读取来源资料，完成后会自动恢复保存；当前修改会保留。'
    : uploading ? '模型正在同步，结束后会自动恢复保存；当前修改会保留。'
    : conflict ? '模型资料已更新，当前修改仍保留在此窗口。请重新载入最新资料后编辑。' : '';
  $('#edit-reload').hidden = !conflict || Boolean(state.collecting);
}
function openModal(title, body, footer = '') {
  $('#modal-content').innerHTML = `<div class="dialog-head"><h2>${esc(title)}</h2><button class="close" data-action="close" aria-label="关闭">×</button></div><div class="dialog-body">${body}</div><div class="dialog-foot"><button class="btn" data-action="close">关闭</button>${footer}</div>`;
  if (!modal.open) modal.showModal();
}
function badge(status, text) { return `<span class="badge ${['saved', 'collected'].includes(status) ? 'green' : ['attention', 'ready'].includes(status) ? 'amber' : status === 'failed' ? 'red' : ''}">${esc(text || taskStatuses[status] || status)}</span>`; }
function top(title, subtitle, actions = '') { return `<div class="page-top"><div><div class="eyebrow">MODELPORT WORKSPACE</div><h1>${title}</h1><p class="subtitle">${subtitle}</p></div><div class="actions">${actions}</div></div>`; }
function stats() {
  const profiles = activeModels().reduce((n, m) => n + m.profiles.length, 0), saved = state.tasks.filter(t => !t.deletedAt && t.status === 'saved').length, waiting = state.tasks.filter(t => !t.deletedAt && ['attention', 'ready', 'failed'].includes(t.status)).length;
  return `<div class="stats">${[['▦', activeModels().length, '模型作品'], ['◈', profiles, '原始打印配置'], ['⇄', saved, '已保存到目标平台'], ['◷', waiting, '需要你处理']].map(([icon, n, label]) => `<div class="stat"><div class="stat-icon">${icon}</div><div><div class="stat-value">${n}</div><div class="stat-label">${label}</div></div></div>`).join('')}</div>`;
}
function render() {
  selected = new Set([...selected].filter(id => activeModels().some(model => model.id === id)));
  $('#nav-count').textContent = activeModels().length; $('#task-count').textContent = state.tasks.filter(t => !t.deletedAt && !['saved', 'cancelled'].includes(t.status)).length;
  $('#view-label').textContent = { library: '模型库', tasks: '同步任务', accounts: '平台与账号', logs: '运行记录' }[view];
  $('#workspace-info').textContent = state.directory || '本地工作空间';
  document.querySelectorAll('[data-view]').forEach(button => button.classList.toggle('active', button.dataset.view === view));
  if (view === 'library') renderLibrary();
  if (view === 'tasks') renderTasks();
  if (view === 'accounts') renderAccounts();
  if (view === 'logs') renderLogs();
  if (state.fileCleanup?.pending || state.fileCleanup?.errors?.length) $('#main').insertAdjacentHTML('afterbegin', '<div class="notice">有文件清理尚未完成。<button class="btn small" data-action="retry-file-cleanup">重试文件清理</button></div>');
}
function renderLibrary() {
  const visibleModels = state.models.filter(model => Boolean(model.deletedAt) === showDeletedModels);
  const models = visibleModels.filter(m => `${m.title} ${m.source.id}`.toLowerCase().includes(filter.toLowerCase()));
  const deletedCount = state.models.filter(model => model.deletedAt).length;
  $('#main').innerHTML = top('让创作，去往更多地方。', '一次整理模型资料，保留每一份配置，轻松同步到其他平台。',
    `<button class="btn primary" data-action="import"><span class="plus">＋</span>添加模型链接</button>`) + stats() +
    `<div class="banner"><span class="banner-icon">⇄</span><div><strong>准备好资料，再出发</strong><p>NexPrint 保存为草稿 · 创想云仅自己可见 · 每次保存前都可以复核</p></div><span class="badge">逐份保留打印配置</span></div>` +
    `<div class="toolbar"><h2>${showDeletedModels ? '已删除模型' : '我的模型'} <span class="count">${visibleModels.length}</span></h2><div class="actions"><button class="btn small" data-action="toggle-deleted-models">${showDeletedModels ? '返回模型库' : `回收站（${deletedCount}）`}</button>${showDeletedModels ? '' : `<button class="btn small" data-action="select-all">${selected.size === activeModels().length && selected.size ? '取消全选' : '全选'}</button>`}<input class="search" id="model-search" placeholder="搜索模型名称或 ID" aria-label="搜索模型" value="${esc(filter)}"></div></div>` +
    (models.length ? `<div class="model-grid">${models.map(modelCard).join('')}</div>` : `<div class="empty"><div class="empty-symbol">◇</div><h2>${filter ? '没有匹配的模型' : showDeletedModels ? '没有已删除的模型' : '从一个模型链接开始'}</h2><p>${filter ? '试试其他名称或模型 ID。' : showDeletedModels ? '删除的模型会保留在这里，可随时恢复。' : '粘贴 MakerWorld 链接后，ModelPort 会在已登录的默认 Chrome 中读取资料、图片和打印配置。'}</p>${showDeletedModels ? '' : '<button class="btn primary" data-action="import">＋ 添加模型链接</button>'}</div>`) +
    (selected.size && !showDeletedModels ? `<div class="selected-bar"><span>已选择 <strong>${selected.size}</strong> 个模型</span><button class="btn primary small" data-action="preview">预览同步 →</button></div>` : '');
}
function modelCard(model) {
  const cover = model.assets.find(a => a.id === model.coverId) || model.assets[0];
  const saved = state.tasks.filter(t => !t.deletedAt && t.modelId === model.id && t.status === 'saved').length;
  return `<article class="model-card ${selected.has(model.id) ? 'selected' : ''}" data-model-id="${esc(model.id)}"><div class="card-image">${cover ? `<img src="/asset/${esc(cover.id)}" alt="${esc(model.title)}" loading="lazy">` : '<div class="placeholder-image">◇</div>'}${model.deletedAt ? '' : `<input class="select-model" type="checkbox" data-model="${esc(model.id)}" aria-label="选择 ${esc(model.title)}" ${selected.has(model.id) ? 'checked' : ''}>`}<span class="source-chip">● MakerWorld</span><span class="card-badge">${model.deletedAt ? '已删除' : esc(modelStatuses[model.status] || model.status)}</span></div><div class="card-body"><h3 title="${esc(model.title)}">${esc(model.title)}</h3><div class="card-meta"><span>◈ ${model.profiles.length} 份配置</span><span>▧ ${model.assets.length} 张图片</span><span>${esc(model.source.id)}</span></div></div><div class="card-foot"><span>${model.deletedAt ? '资料与文件已保留' : saved ? `已同步到 ${saved} 个平台` : model.coverId ? esc(licenses[model.license]) : '待选择封面与确认资料'}</span><div class="card-actions">${model.deletedAt ? `<button data-action="restore-model" data-id="${esc(model.id)}">恢复模型</button>${supportsPermanentDelete() ? `<button class="model-delete" data-action="delete-model" data-id="${esc(model.id)}">彻底删除</button>` : ''}` : `<button data-action="edit" data-id="${esc(model.id)}">管理资料 ↗</button><button class="model-delete" data-action="delete-model" data-id="${esc(model.id)}" ${modelDeleteBlocked(model) ? 'disabled title="请先完成采集或处理未完成的同步任务"' : ''}>删除</button>`}</div></div></article>`;
}
function renderTasks() {
  const tasks = state.tasks.filter(task => Boolean(task.deletedAt) === showDeletedTasks);
  const deletedCount = state.tasks.filter(task => task.deletedAt).length;
  $('#main').innerHTML = top('每一次同步，都有迹可循。', '任务会保留进度。结果不明确时，先核对目标平台，避免重复创建。', '<button class="btn" data-action="refresh">刷新状态</button>') + stats() +
    `<div class="panel"><div class="actions" style="justify-content:space-between"><h2>${showDeletedTasks ? '已删除任务' : '同步任务'} <span class="count">${tasks.length}</span></h2><button class="btn small" data-action="toggle-deleted">${showDeletedTasks ? '返回同步任务' : `任务回收站（${deletedCount}）`}</button></div>${tasks.length ? [...tasks].reverse().map(task => {
      const model = state.models.find(m => m.id === task.modelId);
      return `<div class="task-row"><div><div class="task-title">${esc(model?.title || task.modelId)}</div><div class="task-route">MakerWorld <span>→</span> ${esc(platformNames[task.target])} · ${task.mode === 'draft' ? '保存草稿' : '仅自己可见'}</div><p class="task-message">${esc(task.message)}</p><div class="progress"><span style="width:${Math.max(0, Math.min(100, task.progress || 0))}%"></span></div></div><div>${badge(task.status, task.deletedAt ? '已删除记录' : undefined)}<p class="hint">${new Date(task.updatedAt).toLocaleString('zh-CN', { hour12: false })}</p></div><div class="task-actions">${taskActions(task)}</div></div>`;
    }).join('') : showDeletedTasks ? '<p class="hint">没有已删除的任务记录。</p>' : '<div class="empty"><div class="empty-symbol">⇄</div><h2>还没有同步任务</h2><p>在模型库中选择作品，然后点击“预览同步”。</p><button class="btn" data-view="library">前往模型库</button></div>'}</div>`;
}
function taskActions(task) {
  const button = (action, label, extra = '') => `<button class="btn small" data-action="${action}" data-id="${esc(task.id)}" ${extra}>${label}</button>`;
  if (task.deletedAt) return button('restore-task', '恢复记录') + (supportsPermanentDelete() ? button('delete-task', '彻底删除') : '');
  const actions = [];
  if (task.target === 'nexprint' && task.status === 'attention' && task.uncertain) actions.push(button('verify-task', '检查保存结果'));
  if (task.status === 'ready') actions.push(button('review-task', '核对并保存'));
  if (['queued', 'running'].includes(task.status)) actions.push(button('cancel-task', task.status === 'queued' ? '取消排队' : '中断同步'));
  if (['attention', 'failed'].includes(task.status)) actions.push(button('retry', '处理 / 重试'));
  if (task.result?.url) actions.push(`<button class="btn small" data-action="external" data-url="${esc(task.result.url)}">查看作品 ↗</button>`);
  if (task.screenshot || task.result?.screenshot) actions.push(button('evidence', '截图'));
  if (task.status === 'submitting') actions.push(button('delete-task', '保存中暂不可删除', 'disabled'));
  else if (task.status === 'deleting' || task.deleteRequested) actions.push(button('delete-task', '正在删除…', 'disabled'));
  else actions.push(button('delete-task', ['running', 'cancelling'].includes(task.status) ? '中断并删除' : '删除任务'));
  return actions.join('');
}
function renderAccounts() {
  $('#main').innerHTML = top('连接你的创作平台。', 'ModelPort 使用设备默认 Chrome 中已有的登录状态。') +
    `<div class="panel"><div class="actions" style="justify-content:space-between"><div><h2>设备默认 Chrome ${state.browserConnected ? '<span class="badge green">已连接</span>' : '<span class="badge">未连接</span>'}</h2><p class="hint">请在 Chrome 中启用远程调试。账号密码不会交给 ModelPort。</p></div><button class="btn primary" data-action="connect-browser" ${state.browserConnected ? 'disabled' : ''}>连接默认 Chrome</button></div></div><div class="account-grid">${Object.entries(state.platforms).map(([id, p]) => `<article class="account-card"><div class="platform-logo">${id === 'makerworld' ? 'M' : id === 'nexprint' ? 'N' : 'C'}</div><h2>${esc(p.name)}</h2><span class="badge">${p.role === 'source' ? '来源平台' : p.mode === 'draft' ? '目标 · 草稿' : '目标 · 私密作品'}</span><p>${id === 'makerworld' ? '读取标题、说明、许可、图片与打印配置。' : id === 'nexprint' ? '准备上传表单并保存草稿，由你最后发布。' : '准备上传表单，核对声明后保存为仅自己可见。'}</p><button class="btn" data-action="login" data-platform="${id}">在默认 Chrome 打开 ↗</button></article>`).join('')}</div><div class="panel" style="margin-top:24px"><div class="notice">目标平台页面可能变化。字段或声明无法确认时，工具会暂停并保留页面供你处理；不会将未完成任务标记为成功。</div><h2>开发者声明</h2><p><strong>ModelPort 作者：罗生门</strong></p><p>版权所有 © 2026 罗生门。此声明仅标示 ModelPort 软件的作者与版权归属，不涉及模型作品或第三方平台内容的权利归属。</p></div>`;
}
function renderLogs() {
  $('#main').innerHTML = top('看见每一步进展。', '本地保留最近 500 条运行记录，便于发现缺失文件和恢复中断任务。', '<button class="btn" data-action="refresh">刷新记录</button>') +
    `<div class="panel">${state.logs.length ? state.logs.map(log => `<div class="log-row ${log.level === 'error' ? 'error' : ''}"><time>${new Date(log.at).toLocaleString('zh-CN', { hour12: false })}</time><span>${esc(log.message)}</span></div>`).join('') : '<p class="hint">开始导入或同步模型后，运行记录会出现在这里。</p>'}</div>`;
}
function deletionModal(kind, id) {
  const isModel = kind === 'model', record = (isModel ? state.models : state.tasks).find(record => record.id === id);
  if (!record) return;
  const onlyPermanent = Boolean(record.deletedAt), supported = supportsPermanentDelete();
  if (onlyPermanent && !supported) return;
  const name = isModel ? record.title : state.models.find(model => model.id === record.modelId)?.title || '同步任务';
  const choices = '<div class="delete-options">' + (!onlyPermanent ? '<label><input type="radio" name="delete-mode" value="trash" checked> 放入回收站（可恢复）</label>' : '') +
    (supported ? '<label><input type="radio" name="delete-mode" value="permanent" ' + (onlyPermanent ? 'checked' : '') + '> 彻底删除（无法恢复）</label>' : '') + '</div>';
  const hint = isModel ? '回收站会保留模型资料、文件和关联任务。彻底删除会清理本地库中的模型文件、图片、下载缓存及关联任务；其他模型仍在引用的共用文件保留。' : '回收站会保留任务记录。彻底删除会清理任务记录和专用截图，模型库中的模型文件与图片保留。';
  openModal(isModel ? '删除模型' : '删除同步任务', '<p>删除「' + esc(name) + '」</p>' + choices + '<p class="hint">' + hint + ' 已保存到目标平台的作品保留。</p>' +
    '<label id="delete-permanent-confirm" class="consent" hidden><input type="checkbox" id="delete-permanent-check"> 我确认彻底删除，本地文件和记录无法通过回收站恢复。</label>',
    '<button class="btn danger" data-action="confirm-delete-' + kind + '" data-id="' + esc(id) + '">确认删除' + (isModel ? '模型' : '任务') + '</button>');
  updateDeletionDialog();
}
function updateDeletionDialog() {
  const permanent = $('input[name="delete-mode"]:checked')?.value === 'permanent';
  const confirm = $('#delete-permanent-confirm'); if (!confirm) return;
  confirm.hidden = !permanent;
  const button = $('#modal [data-action="confirm-delete-model"], #modal [data-action="confirm-delete-task"]');
  button.disabled = permanent && !$('#delete-permanent-check').checked;
  button.textContent = permanent ? '确认彻底删除' : button.dataset.action === 'confirm-delete-model' ? '确认删除模型' : '确认删除任务';
}
function imageEditorCard(asset, model) {
  const selectedCover = asset.id === model.coverId;
  const roles = Object.entries({unknown:'用途待确认',photo:'实拍照片',render:'渲染图',diagram:'说明 / 示意图'}).map(([key,value])=>'<option value="'+key+'" '+(asset.role===key?'selected':'')+'>'+value+'</option>').join('');
  return '<div class="image-edit" data-asset-id="'+esc(asset.id)+'"><img src="/asset/'+esc(asset.id)+'" alt="'+esc(asset.name)+'"><div><select class="asset-role" data-id="'+esc(asset.id)+'" aria-label="'+esc(asset.name)+' 的用途">'+roles+'</select><label><input type="radio" name="edit-cover" value="'+esc(asset.id)+'" '+(selectedCover?'checked':'')+'> 作为封面</label><label class="nexprint-image-choice-label"><input class="nexprint-image-choice" type="checkbox" data-id="'+esc(asset.id)+'" '+(editSession.nexprintImageIds.has(asset.id)?'checked':'')+' '+(selectedCover||!['photo','render','diagram'].includes(asset.role)?'disabled':'')+'> 上传至 NexPrint</label><button class="btn small danger" data-action="delete-image" data-id="'+esc(asset.id)+'" aria-label="删除图片 '+esc(asset.name)+'">删除图片</button></div></div>';
}
function importModal() {
  openModal('添加模型链接', `<p class="hint">粘贴 MakerWorld 模型链接，每行一个。ModelPort 会在默认 Chrome 中自动读取每个链接对应的模型资料和素材。</p><div class="field"><label for="import-urls">MakerWorld 模型链接</label><textarea id="import-urls" rows="5" placeholder="https://makerworld.com.cn/zh/models/…"></textarea></div><p class="hint">请先连接默认 Chrome。若页面要求验证，请按站点正常流程完成。</p>`, '<button class="btn primary" data-action="add-links">读取链接并添加</button>');
}
function editModal(id) {
  const model = state.models.find(m => m.id === id && !m.deletedAt); if (!model) return;
  const nexprintCandidates = model.assets.filter(a => a.id !== model.coverId && ['photo', 'render', 'diagram'].includes(a.role));
  const nexprintImageIds = (model.nexprintImageIds || []).filter(assetId => nexprintCandidates.some(a => a.id === assetId)).slice(0, 9);
  editSession = { id, revision: model.revision, baseline: editableFingerprint(model), baselineProfiles: profileFingerprint(model), removed: new Set(), removedProfiles: new Set(), removedCover: null, photoBefore: null, nexprintImageIds: new Set(nexprintImageIds) };
  openModal('模型资料', `
    <div id="edit-status" class="notice" role="status" hidden><span id="edit-status-message"></span> <button id="edit-reload" class="btn small" data-action="reload-edit" data-id="${id}" hidden>重新载入（放弃当前修改）</button></div>
    <div class="actions" style="margin-bottom:18px"><button class="btn small" data-action="collect" data-id="${id}" ${state.collecting || state.busy ? 'disabled' : ''}>重新读取来源资料</button><button class="btn small" data-action="external" data-url="${esc(model.source.url)}">来源页 ↗</button></div>
    ${model.issues.map(issue => `<div class="notice">${esc(issue)}</div>`).join('')}
    <div class="field"><label for="edit-title">模型名称</label><input id="edit-title" value="${esc(model.title)}"></div>
    <div class="two-col"><div class="field"><label for="edit-type">平台创作类型</label><select id="edit-type">${Object.entries(authorships).map(([k, v]) => `<option value="${k}" ${model.authorship === k ? 'selected' : ''}>${v}</option>`).join('')}</select></div><div class="field"><label for="edit-license">源站许可</label><select id="edit-license">${Object.entries(licenses).map(([k, v]) => `<option value="${k}" ${model.license === k ? 'selected' : ''}>${v}</option>`).join('')}</select></div></div>
    <div class="two-col"><div class="field"><label for="edit-category">目标分类</label><select id="edit-category">${['艺术与设计', '玩具与游戏', '日用家居', '时尚', '爱好与DIY', '微缩模型', '教育', '3D打印机', '医疗与健康'].map(v => `<option ${v === model.category ? 'selected' : ''}>${v}</option>`).join('')}</select></div><div class="field"><label for="edit-tags">标签，以逗号分隔</label><input id="edit-tags" value="${esc(model.tags.join('，'))}"></div></div>
    <div class="field"><label for="edit-description">模型说明</label><textarea rows="7" id="edit-description">${esc(model.description)}</textarea></div>
    <div class="section-title">打印配置 <span>${model.profiles.length} 份</span><button class="btn small" data-action="attach" data-id="${id}" data-kind="model">＋ 添加 3MF</button></div>
    ${model.profiles.map(p => `<div class="profile-row" data-profile-id="${esc(p.id)}"><div class="profile-row-head"><strong>${esc(p.name)}</strong><button class="btn small danger" data-action="delete-profile" data-id="${esc(p.id)}" aria-label="彻底删除 3MF 配置 ${esc(p.name)}">删除 3MF</button></div><span>${esc(p.file?.name)} · ${p.file ? (p.file.bytes / 1024 / 1024).toFixed(2) + ' MB' : '文件未下载'} · ${p.file?.geometryCount ?? '?'} 个几何文件</span><p class="hint">${esc(JSON.stringify(p.parameters || {}))}</p></div>`).join('') || '<p class="hint">还没有下载的打印配置文件。</p>'}
    <div class="section-title">图片与封面 <span id="edit-image-count">${model.assets.length} 张</span><button class="btn small" data-action="attach" data-id="${id}" data-kind="image">＋ 添加图片</button></div>
    <div class="image-tools"><label class="photo-switch"><input type="checkbox" role="switch" id="all-images-photo" ${model.assets.length ? '' : 'disabled'}><span class="switch-track" aria-hidden="true"></span><span>全部设为实拍</span></label><p class="hint">开启批量设置，关闭撤销本次批量设置。保存资料后生效。</p></div>
    <div class="nexprint-image-tools"><strong>NexPrint 实物图片 <span id="nexprint-image-count"></span></strong><p class="hint">封面单独上传。勾选要同步到 NexPrint 的图片，最多 9 张；未勾选的图片仍保留在模型库。</p></div>
    <p class="hint">请确认各图片的用途。创想云的封面需选实拍图；说明图会作为说明附件。删除封面后需重新选择。</p>
    <div id="permanent-delete-summary" class="image-delete-summary" hidden><span></span><button class="btn small" data-action="undo-deletes">撤销删除</button></div>
    <div id="permanent-delete-confirmation" class="notice" hidden><label><input type="checkbox" id="confirm-permanent-delete"> 我确认彻底删除待删除的 <span id="permanent-delete-count"></span>，本地文件无法恢复（保存资料后执行）。</label></div>
    <div class="image-editor">${model.assets.map(asset => imageEditorCard(asset, model)).join('')}</div>
  `, `<button class="btn primary" data-action="save-edit" data-id="${id}" ${state.collecting ? 'disabled' : ''}>保存资料</button>`);
  updateImageTools(); syncEditState();
}
function visibleImageRoles() { return [...document.querySelectorAll('.image-edit:not([hidden]) .asset-role')]; }
function updateImageTools() {
  const count = visibleImageRoles().length;
  $('#edit-image-count').textContent = `${count} 张`;
  $('#all-images-photo').disabled = !count;
  const imageCount = editSession.removed.size, profileCount = editSession.removedProfiles.size;
  const deleteCount = imageCount + profileCount;
  $('#permanent-delete-summary').hidden = !deleteCount;
  $('#permanent-delete-confirmation').hidden = !deleteCount;
  $('#permanent-delete-count').textContent = `${imageCount ? `${imageCount} 张图片` : ''}${imageCount && profileCount ? '及' : ''}${profileCount ? `${profileCount} 个 3MF 配置` : ''}`;
  $('#permanent-delete-summary span').textContent = `确认后点击“保存资料”，将彻底删除 ${imageCount} 张图片和 ${profileCount} 个 3MF 配置。`;
  const chosen = [...document.querySelectorAll('.image-edit:not([hidden]) .nexprint-image-choice:checked')];
  $('#nexprint-image-count').textContent = `${chosen.length}/9`;
  for (const checkbox of document.querySelectorAll('.nexprint-image-choice')) {
    const card = checkbox.closest('.image-edit'), role = card.querySelector('.asset-role').value;
    checkbox.disabled = card.hidden || checkbox.closest('.image-edit').querySelector('input[name="edit-cover"]').checked || !['photo', 'render', 'diagram'].includes(role) || (!checkbox.checked && chosen.length >= 9);
  }
}
function removeEditImage(id) {
  if (!editSession) return;
  const card = [...document.querySelectorAll('.image-edit')].find(card => card.dataset.assetId === id);
  if (!card) return;
  if (card.hidden) return;
  const cover = card.querySelector('input[name="edit-cover"]');
  if (cover.checked) { editSession.removedCover = id; cover.checked = false; }
  editSession.removed.add(id);
  card.hidden = true;
  $('#confirm-permanent-delete').checked = false;
  updateImageTools(); syncEditState();
}
function removeEditProfile(id) {
  if (!editSession) return;
  const row = [...document.querySelectorAll('.profile-row')].find(row => row.dataset.profileId === id);
  if (!row || row.hidden) return;
  editSession.removedProfiles.add(id); row.hidden = true;
  $('#confirm-permanent-delete').checked = false;
  updateImageTools(); syncEditState();
}
function undoEditDeletes() {
  if (!editSession) return;
  for (const card of document.querySelectorAll('.image-edit')) {
    card.hidden = false;
    const role = card.querySelector('.asset-role');
    if ($('#all-images-photo').checked) {
      if (!editSession.photoBefore?.has(role.dataset.id)) editSession.photoBefore?.set(role.dataset.id, role.value);
      role.value = 'photo';
    }
  }
  for (const row of document.querySelectorAll('.profile-row')) row.hidden = false;
  if (editSession.removedCover && !$('input[name="edit-cover"]:checked')) {
    const cover = [...document.querySelectorAll('input[name="edit-cover"]')].find(input => input.value === editSession.removedCover);
    if (cover && !cover.closest('.image-edit').hidden) cover.checked = true;
  }
  editSession.removed.clear(); editSession.removedProfiles.clear(); editSession.removedCover = null;
  $('#confirm-permanent-delete').checked = false;
  updateImageTools(); syncEditState();
}
async function previewModal(targets = ['nexprint', 'creality']) {
  const ids = [...selected];
  if (!ids.length) throw new Error('请选择至少一个模型');
  const plans = await api('preview', { modelIds: ids, targets });
  openModal('同步预览', `<p class="hint">所选 ${ids.length} 个模型将发送到以下平台。文件和图片会上传；公开发布仍由你在平台完成。</p><div class="target-choice"><label><input type="checkbox" id="target-nexprint" ${targets.includes('nexprint') ? 'checked' : ''}> NexPrint · 保存草稿</label><label><input type="checkbox" id="target-creality" ${targets.includes('creality') ? 'checked' : ''}> 创想云 · 仅自己可见</label></div>${plans.map(p => `<div class="preview-card"><h3>${esc(p.title)} <span class="badge">${platformNames[p.target]}</span></h3><p class="hint">${p.files} 份原始配置 · ${p.images} 张图片 · ${esc(licenses[p.license])}</p>${p.blockers.length ? `<ul class="error-list">${p.blockers.map(b => `<li>${esc(b)}</li>`).join('')}</ul>` : badge('collected', '资料可开始同步')}${p.warnings.length ? `<ul>${p.warnings.map(w => `<li>${esc(w)}</li>`).join('')}</ul>` : ''}</div>`).join('')}<p class="hint">开始后先准备平台表单。需要接受声明或保存时，会出现在“同步任务”中供你确认。</p>`, `<button class="btn primary" data-action="create-tasks" ${plans.some(p => p.blockers.length) || !targets.length ? 'disabled' : ''}>开始同步 →</button>`);
}
function taskReview(id) {
  const task = state.tasks.find(t => t.id === id), model = state.models.find(m => m.id === task.modelId);
  openModal('核对并保存', `<h3>${esc(model.title)}</h3><p class="hint">目标：${esc(platformNames[task.target])} · ${task.mode === 'draft' ? '草稿' : '仅自己可见'}</p>${task.declaration ? `<p class="hint">平台要求接受以下声明：</p><div class="declaration">${esc(task.declaration)}</div>` : '<p class="hint">请先查看平台浏览器中的文件、图片、说明与许可，再确认保存。</p>'}${task.screenshot ? `<img class="result-image" src="/evidence/${esc(task.screenshot)}" alt="待保存表单截图">` : ''}<label class="consent"><input type="checkbox" id="save-consent"> <span>${task.declaration ? '我已核对本次模型资料，同意上述平台声明，并确认仅自己可见地提交。' : '我已核对本次模型资料，确认保存到 NexPrint 草稿箱。'}</span></label>`, `<button class="btn primary" data-action="commit" data-id="${id}" disabled>确认保存</button>`);
}
async function attachFiles(id, kind) {
  let files;
  if (window.desktop) files = await window.desktop.chooseFiles(kind);
  else {
    openModal(kind === 'model' ? '添加本地 3MF' : '添加本地图片', `<p class="hint">桌面版支持文件选择器。浏览器预览中可填写本机绝对路径，每行一个。</p><div class="field"><label for="attach-paths">文件路径</label><textarea id="attach-paths" rows="4"></textarea></div>`, `<button class="btn primary" data-action="attach-paths" data-id="${id}" data-kind="${kind}">添加文件</button>`); return;
  }
  if (!files?.length) return;
  await api('models/attach', { id, kind, files }); await refresh(); editModal(id);
}
async function openExternal(url) {
  if (window.desktop) await window.desktop.openLink(url);
  else window.open(url, '_blank', 'noopener,noreferrer');
}

document.addEventListener('click', event => {
  const viewButton = event.target.closest('[data-view]');
  if (viewButton) { view = viewButton.dataset.view; render(); return; }
  const button = event.target.closest('[data-action]'); if (!button || button.disabled) return;
  const { action, id } = button.dataset;
  void perform(async () => {
    switch (action) {
      case 'close': modal.close(); break;
      case 'refresh': await refresh(); break;
      case 'import': importModal(); break;
      case 'add-links': {
        const urls = $('#import-urls').value.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
        await api('models/add', { urls }); modal.close(); await refresh(); toast(`已加入 ${urls.length} 个链接，正在自动读取模型资料`); break;
      }
      case 'select-all': selected = selected.size === activeModels().length ? new Set() : new Set(activeModels().map(m => m.id)); render(); break;
      case 'toggle-deleted-models': showDeletedModels = !showDeletedModels; renderLibrary(); break;
      case 'delete-model': deletionModal('model', id); break;
      case 'confirm-delete-model': {
        button.disabled = true;
        const mode = $('input[name="delete-mode"]:checked')?.value || 'trash';
        try { const result = await api('models/delete', { id, mode, confirmPermanent: $('#delete-permanent-check')?.checked || false }); selected.delete(id); modal.close(); await refresh(); toast(result.permanentlyDeleted ? '模型及本地文件已彻底删除，无法恢复' : '模型已放入回收站，可恢复'); }
        catch (error) { button.disabled = false; await refresh(); throw error; }
        break;
      }
      case 'restore-model': await api('models/restore', { id }); await refresh(); toast('模型及关联任务记录已恢复'); break;
      case 'edit': editModal(id); break;
      case 'reload-edit': await refresh(); editModal(id); break;
      case 'collect': await api('models/collect', { id }); await refresh(); toast('已在默认 Chrome 开始读取模型资料'); break;
      case 'save-edit': {
        const session = editSession;
        const assetRoles = {}; visibleImageRoles().forEach(e => assetRoles[e.dataset.id] = e.value);
        const nexprintImageIds = [...document.querySelectorAll('.image-edit:not([hidden]) .nexprint-image-choice:checked')].map(e => e.dataset.id);
        session.saving = true; syncEditState();
        try {
          await api('models/edit', { id, title: $('#edit-title').value, description: $('#edit-description').value,
          authorship: $('#edit-type').value, license: $('#edit-license').value, category: $('#edit-category').value,
          tags: $('#edit-tags').value.split(/[,，]/).map(s => s.trim()).filter(Boolean),
          coverId: $('input[name="edit-cover"]:checked')?.value ?? null, assetRoles,
          removedAssetIds: [...editSession.removed], removedProfileIds: [...editSession.removedProfiles], confirmPermanent: $('#confirm-permanent-delete').checked, nexprintImageIds, expectedRevision: editSession.revision });
          modal.close(); await refresh(); toast('模型资料已保存在本地');
        } finally { session.saving = false; syncEditState(); }
        break;
      }
      case 'delete-image': removeEditImage(id); break;
      case 'delete-profile': removeEditProfile(id); break;
      case 'undo-deletes': undoEditDeletes(); break;
      case 'attach': await attachFiles(id, button.dataset.kind); break;
      case 'attach-paths': await api('models/attach', { id, kind: button.dataset.kind, files: $('#attach-paths').value.split(/\r?\n/).map(s => s.trim()).filter(Boolean) }); await refresh(); editModal(id); break;
      case 'preview': await previewModal(); break;
      case 'create-tasks': {
        const targets = ['nexprint', 'creality'].filter(p => $(`#target-${p}`).checked);
        await api('tasks/create', { modelIds: [...selected], targets }); modal.close(); view = 'tasks'; await refresh(); toast('已加入同步队列，表单准备后可核对保存'); break;
      }
      case 'login': await api('platform/open', { platform: button.dataset.platform }); toast('已在默认 Chrome 打开平台页面；如未登录，请在 Chrome 中完成登录'); break;
      case 'connect-browser': await api('browser/connect', {}); await refresh(); toast('已连接设备默认 Chrome'); break;
      case 'external': await openExternal(button.dataset.url); break;
      case 'review-task': taskReview(id); break;
      case 'verify-task': {
        button.disabled = true;
        try { const task = await api('tasks/verify', { id }); await refresh(); toast(task.message, task.status !== 'saved'); }
        catch (error) { button.disabled = false; throw error; }
        break;
      }
      case 'commit': {
        const task = state.tasks.find(t => t.id === id); button.disabled = true;
        try { await api('tasks/commit', { id, consent: { reviewed: $('#save-consent').checked, declaration: task.declaration } }); modal.close(); await refresh(); }
        catch (error) { button.disabled = false; throw error; }
        break;
      }
      case 'cancel-task': await api('tasks/cancel', { id }); await refresh(); toast('已请求中断同步'); break;
      case 'toggle-deleted': showDeletedTasks = !showDeletedTasks; renderTasks(); break;
      case 'delete-task': deletionModal('task', id); break;
      case 'confirm-delete-task': {
        button.disabled = true;
        const mode = $('input[name="delete-mode"]:checked')?.value || 'trash';
        try {
          const task = await api('tasks/delete', { id, mode, confirmPermanent: $('#delete-permanent-check')?.checked || false }); modal.close(); await refresh();
          toast(task.permanentlyDeleted ? '任务记录与专用截图已彻底删除；模型库文件保留' : task.deletedAt ? '任务已放入回收站，可恢复' : '已请求中断并放入回收站');
        } catch (error) { button.disabled = false; await refresh(); throw error; }
        break;
      }
      case 'retry-file-cleanup': {
        const result = await api('trash/cleanup', {}); await refresh(); toast(result.pending || result.errors.length ? result.errors[0] || '仍有文件清理未完成' : '文件清理已完成', Boolean(result.pending || result.errors.length)); break;
      }
      case 'restore-task': await api('tasks/restore', { id }); await refresh(); toast('任务记录已恢复'); break;
      case 'evidence': { const task = state.tasks.find(t => t.id === id); openModal('任务截图', `<img class="result-image" src="/evidence/${esc(task.result?.screenshot || task.screenshot)}" alt="任务核对截图">`); break; }
      case 'retry': {
        const task = state.tasks.find(t => t.id === id);
        openModal('处理未完成的任务', `<div class="notice">${esc(task.message)}</div><p class="hint">先查看浏览器中的表单和目标作品列表。若已经保存，可填写作品链接；若确定没有创建作品，再重试。</p><div class="field"><label for="existing-url">已保存作品的链接（可选）</label><input id="existing-url" placeholder="https://…"></div><label class="consent"><input type="checkbox" id="retry-checked"><span>我已检查目标平台，确认没有产生作品，可以重新准备表单。</span></label>`, `<button class="btn" data-action="resolve-task" data-id="${id}">记录已有作品</button><button class="btn primary" data-action="retry-task" data-id="${id}">重新准备</button>`); break;
      }
      case 'retry-task': await api('tasks/retry', { id, checked: $('#retry-checked').checked }); modal.close(); await refresh(); break;
      case 'resolve-task': await api('tasks/resolve', { id, url: $('#existing-url').value }); modal.close(); await refresh(); break;
    }
  });
});
document.addEventListener('change', event => {
  if (event.target.matches('input[name="delete-mode"], #delete-permanent-check')) updateDeletionDialog();
  if (event.target.id === 'confirm-permanent-delete') syncEditState();
  if (event.target.id === 'all-images-photo' && editSession) {
    const roles = visibleImageRoles();
    if (event.target.checked) {
      editSession.photoBefore = new Map(roles.map(role => [role.dataset.id, role.value]));
      roles.forEach(role => { role.value = 'photo'; });
    } else {
      for (const role of document.querySelectorAll('.asset-role')) {
        if (editSession.photoBefore?.has(role.dataset.id)) role.value = editSession.photoBefore.get(role.dataset.id);
      }
      editSession.photoBefore = null;
    }
    updateImageTools();
  }
  if (event.target.matches('.asset-role') && editSession) {
    $('#all-images-photo').checked = false; editSession.photoBefore = null;
    if (event.target.value === 'unknown') {
      const choice = document.querySelector(`.nexprint-image-choice[data-id="${CSS.escape(event.target.dataset.id)}"]`);
      if (choice) choice.checked = false;
    }
    updateImageTools();
  }
  if (event.target.matches('input[name="edit-cover"]') && editSession) {
    const choice = document.querySelector(`.nexprint-image-choice[data-id="${CSS.escape(event.target.value)}"]`);
    if (choice) choice.checked = false;
    updateImageTools();
  }
  if (event.target.matches('.nexprint-image-choice') && editSession) {
    const chosenCount = document.querySelectorAll('.image-edit:not([hidden]) .nexprint-image-choice:checked').length;
    if (event.target.checked && chosenCount > 9) {
      event.target.checked = false;
      toast('NexPrint 实物图片最多选择 9 张', true);
    }
    updateImageTools();
  }
  if (event.target.matches('.select-model')) { event.target.checked ? selected.add(event.target.dataset.model) : selected.delete(event.target.dataset.model); renderLibrary(); }
  if (event.target.id === 'save-consent') $('[data-action="commit"]').disabled = !event.target.checked;
  if (event.target.matches('#target-nexprint,#target-creality')) void perform(() => previewModal(['nexprint', 'creality'].filter(p => $(`#target-${p}`).checked)));
});
document.addEventListener('input', event => {
  if (event.target.id === 'model-search') {
    const position = event.target.selectionStart; filter = event.target.value; renderLibrary(); $('#model-search').focus(); $('#model-search').setSelectionRange(position, position);
  }
});
void refresh();
setInterval(() => {
  if (document.visibilityState === 'visible' && (!modal.open || $('#modal [data-action="save-edit"]')) && !$('#model-search')?.matches(':focus')) void refresh();
}, 3000);
