import { randomUUID } from 'node:crypto';
import { modelFingerprint, review, taskKey, UserActionRequired, SubmissionUncertain } from './domain.mjs';

export class TaskQueue {
  constructor(store, executor) {
    this.store = store; this.executor = executor; this.busy = false; this.stopped = false;
    this.activeTaskId = null; this.cancellations = new Map();
  }
  enqueue(modelIds, targets) {
    if (!Array.isArray(modelIds) || !modelIds.length || !Array.isArray(targets) || !targets.length) throw new Error('请选择模型与目标平台');
    const jobs = [];
    for (const modelId of [...new Set(modelIds)]) for (const target of [...new Set(targets)]) {
      const model = this.store.model(modelId), plan = review(model, target), key = taskKey(model, target);
      if (plan.blockers.length) throw new Error(`${model.title}：${plan.blockers.join('；')}`);
      let imageAssetIds;
      if (target === 'nexprint') {
        const eligible = model.assets.filter(asset => asset.id !== model.coverId && ['photo', 'render', 'diagram'].includes(asset.role));
        imageAssetIds = model.nexprintImageIds ?? [];
        if (!Array.isArray(imageAssetIds) || imageAssetIds.length > 9 || new Set(imageAssetIds).size !== imageAssetIds.length || imageAssetIds.some(assetId => !eligible.some(asset => asset.id === assetId)))
          throw new Error(`${model.title}：NexPrint 图片选择无效，请在模型资料中重新选择至多 9 张图片`);
      }
      const existing = this.store.state.tasks.find(t => t.key === key && !t.deletedAt && !['cancelled'].includes(t.status));
      if (existing) { jobs.push(existing); continue; }
      const at = new Date().toISOString();
      jobs.push({ id: randomUUID(), key, modelId, target, mode: plan.mode, status: 'queued',
        fingerprint: plan.fingerprint, step: 'waiting', message: '等待处理', createdAt: at, updatedAt: at,
        progress: 0, result: null, uncertain: false,
        ...(target === 'nexprint' ? { imageAssetIds: [...imageAssetIds] } : {}) });
    }
    this.store.mutate(s => { for (const job of jobs) if (!s.tasks.some(t => t.id === job.id)) s.tasks.push(job); });
    void this.run(); return structuredClone(jobs);
  }
  async run() {
    if (this.busy || this.stopped) return;
    this.busy = true;
    try {
      for (;;) {
        const task = this.store.state.tasks.find(t => t.status === 'queued');
        if (!task || this.stopped) break;
        const model = this.store.model(task.modelId);
        if (modelFingerprint(model) !== task.fingerprint) {
          this.store.updateTask(task.id, { status: 'attention', message: '资料已修改，请重新检查并重试', progress: 0 }); continue;
        }
        this.store.updateTask(task.id, { status: 'running', message: '准备上传', step: 'preparing', progress: 5 });
        this.store.log(`开始准备：${model.title} → ${task.target}`, { taskId: task.id });
        const cancellation = { requested: false, controller: new AbortController() };
        this.activeTaskId = task.id; this.cancellations.set(task.id, cancellation);
        try {
          const prepared = await this.executor.prepare(task, model, (message, progress) => {
            if (!cancellation.requested) this.store.updateTask(task.id, { message, ...(progress === undefined ? {} : { progress }) });
            this.store.log(message, { taskId: task.id });
          }, { signal: cancellation.controller.signal });
          if (cancellation.requested) {
            this.markCancelled(task.id);
            continue;
          }
          this.store.updateTask(task.id, { status: 'ready', step: 'review', progress: 90,
            message: '表单已准备，请核对后确认保存', declaration: prepared.declaration || '', pageUrl: prepared.pageUrl,
            screenshot: prepared.screenshot || null, account: prepared.account || null });
        } catch (error) {
          if (cancellation.requested) this.markCancelled(task.id);
          else this.failure(task.id, error);
        } finally {
          this.cancellations.delete(task.id);
          if (this.activeTaskId === task.id) this.activeTaskId = null;
        }
      }
    } finally { this.busy = false; }
  }
  failure(id, error) {
    this.store.updateTask(id, { status: error instanceof UserActionRequired || error instanceof SubmissionUncertain ? 'attention' : 'failed',
      message: error.message.split('\n')[0], uncertain: error instanceof SubmissionUncertain,
      ...(error.details || {}) });
    this.store.log(error.message.split('\n')[0], { taskId: id, level: 'error' });
  }
  markCancelled(id) {
    const task = this.store.task(id);
    if (task.status === 'cancelled') return task;
    const result = this.store.updateTask(id, { status: 'cancelled', step: 'cancelled', message: '同步已中断，未执行平台保存', progress: 0, uncertain: false,
      ...(task.deleteRequested ? { deletedAt: new Date().toISOString(), deleteRequested: false } : {}) });
    this.store.log(`同步已中断：${task.modelId} → ${task.target}`, { taskId: id });
    return result;
  }
  async cancel(id) {
    const task = this.store.task(id);
    if (task.status === 'queued') {
      const result = this.store.updateTask(id, { status: 'cancelled', step: 'cancelled', message: '已取消排队任务', progress: 0, uncertain: false });
      this.store.log(`已取消排队任务：${task.modelId} → ${task.target}`, { taskId: id });
      return result;
    }
    if (task.status !== 'running' || this.activeTaskId !== id) throw new Error('只有排队中或正在准备表单的任务可以中断；保存阶段请等待平台结果核验');
    const cancellation = this.cancellations.get(id);
    if (!cancellation) throw new Error('任务已进入结束阶段，请刷新状态');
    cancellation.requested = true;
    cancellation.controller.abort();
    this.store.updateTask(id, { status: 'cancelling', message: '正在中断同步…' });
    try { await this.executor.cancel?.(id); }
    catch (error) { this.store.log(`关闭任务页面时遇到问题：${error.message.split('\n')[0]}`, { taskId: id, level: 'error' }); }
    return this.store.task(id);
  }
  async remove(id, { mode = 'trash', confirmPermanent = false } = {}) {
    if (!['trash', 'permanent'].includes(mode)) throw new Error('删除方式无效');
    if (mode === 'permanent') {
      if (confirmPermanent !== true) throw new Error('请确认彻底删除任务记录，无法恢复');
      const original = this.store.task(id);
      if (original.status === 'submitting') throw new Error('任务正在保存并核验，请等待结果后再删除记录');
      if (original.status === 'deleting') throw new Error('任务正在删除，请稍后重试');
      if (['running', 'cancelling'].includes(original.status)) {
        if (original.status === 'running') await this.cancel(id);
        const deadline = Date.now() + 15000;
        while (this.cancellations.has(id)) {
          if (Date.now() >= deadline) throw new Error('中断尚未完成，文件未彻底删除；请稍后重试');
          await new Promise(resolve => setTimeout(resolve, 25));
        }
      }
      const task = this.store.task(id);
      this.store.updateTask(id, { status: 'deleting', deleteFromStatus: task.status, message: '正在彻底删除本地任务记录…' });
      try {
        if (!task.deletedAt && !['saved', 'queued', 'cancelled'].includes(task.status)) await this.executor.cancel?.(id);
        const result = this.store.purgeTask(id);
        this.executor.forget?.(id);
        this.store.log('已彻底删除同步任务记录与专用截图；模型库文件及平台作品保留', { taskId: id });
        return result;
      } catch (error) {
        if (this.store.state.tasks.some(task => task.id === id)) this.store.updateTask(id, { status: task.status, message: task.message, deleteFromStatus: null });
        throw error;
      }
    }
    const task = this.store.task(id);
    if (task.deletedAt) return task;
    if (task.status === 'submitting') throw new Error('任务正在保存并核验，请等待结果后再删除记录');
    if (task.status === 'deleting') return task;
    if (['running', 'cancelling'].includes(task.status)) {
      this.store.updateTask(id, { deleteRequested: true });
      if (task.status === 'running') await this.cancel(id);
      return this.store.task(id);
    }
    if (task.status === 'saved' || task.status === 'queued') {
      const removed = this.store.updateTask(id, { deletedAt: new Date().toISOString(),
        ...(task.status === 'queued' ? { status: 'cancelled', message: '已取消排队并删除任务记录', progress: 0 } : {}) });
      this.executor.forget?.(id);
      this.store.log('已删除同步任务记录，目标平台作品不受影响', { taskId: id });
      return removed;
    }
    // Lock out commit/retry while the unfinished task page is being closed.
    this.store.updateTask(id, { status: 'deleting', deleteFromStatus: task.status, message: '正在删除任务记录…' });
    try { await this.executor.cancel?.(id); }
    catch (error) { this.store.updateTask(id, { status: task.status, message: task.message, deleteFromStatus: null }); throw error; }
    const removed = this.store.updateTask(id, { deletedAt: new Date().toISOString(), deleteFromStatus: null,
      status: task.status === 'ready' ? 'cancelled' : task.status,
      message: task.status === 'ready' ? '已丢弃待保存表单' : task.message });
    this.store.log('已删除同步任务记录，目标平台作品不受影响', { taskId: id });
    return removed;
  }
  restore(id) {
    const task = this.store.task(id);
    if (!task.deletedAt) throw new Error('任务记录未删除');
    this.store.model(task.modelId);
    if (this.store.state.tasks.some(t => t.id !== id && t.key === task.key && !t.deletedAt && t.status !== 'cancelled'))
      throw new Error('该模型已创建新的同步任务，请先处理新任务');
    return this.store.updateTask(id, { deletedAt: null, deleteRequested: false });
  }
  async commit(id, consent) {
    const task = this.store.task(id), model = this.store.model(task.modelId);
    if (task.deletedAt) throw new Error('任务记录已删除，请重新创建同步任务');
    if (task.status !== 'ready') throw new Error('只有已准备好的表单可以保存');
    if (task.fingerprint !== modelFingerprint(model)) throw new Error('模型资料已修改，请重新准备表单');
    if (task.target === 'nexprint' && !Array.isArray(task.imageAssetIds)) {
      this.failure(id, new UserActionRequired('此任务由旧版工具准备，未记录你选择的图库图片。请打开模型资料选择图片，再重新准备表单'));
      return this.store.task(id);
    }
    if (!consent?.reviewed || (task.declaration && consent.declaration !== task.declaration)) throw new Error('请核对表单并接受本次实际声明');
    if (this.busy) throw new Error('其他任务正在操作浏览器，请稍后保存');
    this.busy = true;
    this.store.updateTask(id, { status: 'submitting', message: '正在保存并核验，请勿重复提交', consentAt: new Date().toISOString() });
    try {
      const result = await this.executor.commit(task, model);
      if (!result?.url || result.verified !== true) throw new SubmissionUncertain('没有取得明确保存证据，请在目标平台核对后记录已有作品');
      this.store.updateTask(id, { status: 'saved', step: 'complete', progress: 100, message: task.mode === 'draft' ? '已保存草稿' : '已保存为仅自己可见', result });
      this.store.log(`保存完成：${model.title} → ${task.target}`, { taskId: id }); return this.store.task(id);
    } catch (error) { this.failure(id, error instanceof SubmissionUncertain || error instanceof UserActionRequired ? error : new SubmissionUncertain(`保存结果待核对：${error.message.split('\n')[0]}`)); return this.store.task(id); }
    finally { this.busy = false; void this.run(); }
  }
  async verify(id) {
    const task = this.store.task(id), model = this.store.model(task.modelId);
    if (task.deletedAt || task.target !== 'nexprint' || task.status !== 'attention' || !task.uncertain)
      throw new Error('只有保存结果待核对的 NexPrint 任务可以检查草稿');
    if (this.busy) throw new Error('浏览器正在处理其他任务，请稍后检查');
    if (task.fingerprint !== modelFingerprint(model)) throw new Error('模型资料已变化，请在平台核对原草稿');
    this.busy = true;
    try {
      const result = await this.executor.verify(task, model);
      if (result?.verified !== true || result.mode !== 'draft' || !result.url) throw new SubmissionUncertain('尚未取得草稿保存证据');
      this.store.updateTask(id, { status: 'saved', step: 'complete', progress: 100, uncertain: false, message: '已核验草稿保存成功', result });
      this.executor.forget?.(id);
      this.store.log(`已核验草稿：${model.title}`, { taskId: id });
    } catch (error) { this.failure(id, error instanceof SubmissionUncertain ? error : new SubmissionUncertain(`检查草稿未完成：${error.message.split('\n')[0]}`)); }
    finally { this.busy = false; void this.run(); }
    return this.store.task(id);
  }
  retry(id, checked = false) {
    const task = this.store.task(id);
    if (task.deletedAt) throw new Error('任务记录已删除，请重新创建同步任务');
    if (!['attention', 'failed'].includes(task.status)) throw new Error('当前任务不可重试');
    if (task.uncertain && !checked) throw new Error('请先确认目标平台没有产生作品，再重试');
    const model = this.store.model(task.modelId), plan = review(model, task.target);
    if (plan.blockers.length) throw new Error(plan.blockers.join('；'));
    const retryPatch = { status: 'queued', uncertain: false, fingerprint: plan.fingerprint, message: '等待重试', progress: 0 };
    if (task.target === 'nexprint') {
      const eligible = model.assets.filter(asset => asset.id !== model.coverId && ['photo', 'render', 'diagram'].includes(asset.role));
      const imageAssetIds = model.nexprintImageIds ?? [];
      if (!Array.isArray(imageAssetIds) || imageAssetIds.length > 9 || new Set(imageAssetIds).size !== imageAssetIds.length || imageAssetIds.some(assetId => !eligible.some(asset => asset.id === assetId)))
        throw new Error('NexPrint 图片选择无效，请先在模型资料中选择至多 9 张图片');
      retryPatch.imageAssetIds = [...imageAssetIds];
    }
    this.store.updateTask(id, retryPatch);
    void this.run();
  }
  resolve(id, url) {
    const task = this.store.task(id), u = new URL(url);
    if (task.deletedAt) throw new Error('任务记录已删除，请先恢复记录');
    const valid = task.target === 'nexprint' ? /(^|\.)nexprint\.cn$/.test(u.hostname) : /(^|\.)crealitycloud\.cn$/.test(u.hostname);
    if (!valid || u.protocol !== 'https:') throw new Error('链接与任务目标平台不一致');
    if (!['attention', 'failed'].includes(task.status)) throw new Error('仅可核对未完成任务');
    this.store.updateTask(id, { status: 'saved', progress: 100, message: '由用户核对并记录已有作品', result: { url: u.href, verified: true, verifiedBy: 'user', mode: task.mode } });
  }
}
