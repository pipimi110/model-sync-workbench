import { randomUUID } from 'node:crypto';
import { Store } from './store.mjs';
import { BrowserManager } from './browser.mjs';
import { TaskQueue } from './queue.mjs';
import { ReloadableTargetExecutor } from './adapters/reloadable-targets.mjs';
import { ReloadableMakerWorldCollector } from './adapters/reloadable-makerworld.mjs';
import { ingestFile } from './assets.mjs';
import { review, modelFingerprint, PLATFORMS } from './domain.mjs';

export class Service {
  constructor(directory, overrides = {}) {
    this.store = overrides.store || new Store(directory);
    this.browser = overrides.browser || new BrowserManager(directory, this.store);
    this.sourceCollector = overrides.sourceCollector || new ReloadableMakerWorldCollector(this.store, this.browser);
    this.queue = new TaskQueue(this.store, overrides.executor || new ReloadableTargetExecutor(this.browser, this.store));
    this.collecting = false;
  }
  state() {
    const state = this.store.snapshot();
    return { ...state, platforms: PLATFORMS, collecting: this.collecting, busy: this.queue.busy,
      directory: this.store.directory, liveAdapters: 'beta',
      browserConnected: Boolean(this.browser.context),
      fileCleanup: { pending: this.store.state.pendingPurges?.length || 0, errors: this.store.fileCleanupErrors || [] },
      capabilities: { publicPublishing: false, source: ['makerworld'], targets: ['nexprint', 'creality'], deletionModes: ['trash', 'permanent'] } };
  }
  add(urls) {
    if (!Array.isArray(urls) || urls.length < 1 || urls.length > 50) throw new Error('一次可导入 1–50 个模型链接');
    if (this.collecting || this.queue.busy) throw new Error('浏览器正在处理任务，请稍后添加模型链接');
    const models = urls.map(url => this.store.addModel(url));
    const pending = [...new Set(models.filter(model => model.status !== 'collected').map(model => model.id))];
    if (pending.length) {
      this.collecting = true;
      void (async () => {
        try {
          for (const id of pending) {
            const model = this.store.model(id);
            this.store.updateModel(id, { status: 'collecting', issues: [] });
            try {
              await this.sourceCollector.collect(model, message => this.store.log(message, { modelId: id }));
            } catch (error) {
              this.store.updateModel(id, { status: 'attention', issues: [error.message.split('\n')[0]] });
              this.store.log(error.message.split('\n')[0], { modelId: id, level: 'error' });
            }
          }
        } finally { this.collecting = false; }
      })();
    }
    return models;
  }
  collect(id) {
    if (this.collecting || this.queue.busy) throw new Error('浏览器正在处理任务，请稍后读取');
    const model = this.store.model(id); this.collecting = true;
    this.store.updateModel(id, { status: 'collecting', issues: [] });
    void this.sourceCollector.collect(model, message => this.store.log(message, { modelId: id }))
      .catch(error => {
        this.store.updateModel(id, { status: 'attention', issues: [error.message.split('\n')[0]] });
        this.store.log(error.message.split('\n')[0], { modelId: id, level: 'error' });
      }).finally(() => { this.collecting = false; });
    return { started: true };
  }
  edit(id, input) {
    const model = this.store.model(id);
    if (this.collecting) throw new Error('正在读取来源资料，请完成后再编辑');
    if (this.store.state.tasks.some(t => t.modelId === id && ['running', 'cancelling', 'submitting'].includes(t.status))) throw new Error('模型正在上传、中断或保存，暂不可编辑');
    if (input.expectedRevision !== undefined && input.expectedRevision !== model.revision) throw new Error('模型资料已变化，请关闭并重新打开后编辑');
    const changes = {};
    for (const key of ['title', 'description', 'category']) if (input[key] !== undefined) {
      if (typeof input[key] !== 'string' || input[key].length > (key === 'description' ? 50000 : 200)) throw new Error('文字字段类型或长度不正确');
      changes[key] = input[key];
    }
    if (input.authorship !== undefined) {
      if (!['original', 'remix', 'shared', 'unconfirmed'].includes(input.authorship)) throw new Error('创作类型无效');
      changes.authorship = input.authorship;
    }
    if (input.license !== undefined) {
      if (!['standard', 'cc-by-nc', 'cc0', 'cc-by', 'cc-by-sa', 'cc-by-nc-sa', 'unknown'].includes(input.license)) throw new Error('许可类型无效');
      changes.license = input.license;
    }
    if (input.tags !== undefined) {
      if (!Array.isArray(input.tags) || input.tags.some(t => typeof t !== 'string' || t.length > 30)) throw new Error('标签格式不正确');
      changes.tags = [...new Set(input.tags)].slice(0, 20);
    }
    const removed = input.removedAssetIds ?? [], permanent = input.permanentAssetIds ?? [];
    const removedProfileIds = input.removedProfileIds ?? [];
    const legacyTrash = model.trashedAssets || [];
    for (const ids of [removed, permanent]) if (!Array.isArray(ids) || new Set(ids).size !== ids.length || ids.some(id => typeof id !== 'string')) throw new Error('图片删除参数无效');
    if (!Array.isArray(removedProfileIds) || new Set(removedProfileIds).size !== removedProfileIds.length || removedProfileIds.some(id => typeof id !== 'string')) throw new Error('打印配置删除参数无效');
    if (removedProfileIds.some(id => !model.profiles.some(profile => profile.id === id))) throw new Error('要删除的 3MF 配置不存在，请重新打开模型资料');
    if (input.restoredAssetIds?.length) throw new Error('图片删除后无法从应用恢复');
    if (removed.some(id => !model.assets.some(asset => asset.id === id)) || permanent.some(id => ![...model.assets, ...legacyTrash].some(asset => asset.id === id))) throw new Error('要删除的图片不存在，请重新打开模型资料');
    const deleteIds = [...new Set([...removed, ...permanent, ...legacyTrash.map(asset => asset.id)])];
    if ((deleteIds.length || removedProfileIds.length) && input.confirmPermanent !== true) throw new Error('请确认彻底删除所选图片或 3MF，文件无法恢复');
    const removedProfiles = model.profiles.filter(profile => removedProfileIds.includes(profile.id));
    if (removedProfileIds.length) changes.profiles = model.profiles.filter(profile => !removedProfileIds.includes(profile.id));
    const remaining = model.assets.filter(asset => !deleteIds.includes(asset.id));
    const removedRecords = [...model.assets, ...legacyTrash].filter(asset => deleteIds.includes(asset.id));
    if (deleteIds.length || legacyTrash.length) {
      changes.assets = remaining;
      changes.trashedAssets = [];
      changes.excludedAssetHashes = [...new Set([...(model.excludedAssetHashes || []), ...removedRecords.map(asset => asset.sha256).filter(Boolean)])];
      if (!remaining.some(asset => asset.id === model.coverId)) changes.coverId = null;
      if (model.nexprintImageIds) changes.nexprintImageIds = model.nexprintImageIds.filter(id => remaining.some(asset => asset.id === id));
    }
    if (input.assetRoles) {
      if (typeof input.assetRoles !== 'object' || Array.isArray(input.assetRoles) || Object.keys(input.assetRoles).some(id => !remaining.some(asset => asset.id === id))) throw new Error('图片用途对应的图片不存在');
      changes.assets = remaining.map(a => {
        const role = input.assetRoles[a.id];
        if (role && !['photo', 'render', 'diagram', 'unknown'].includes(role)) throw new Error('图片用途无效');
        return { ...a, role: role || a.role };
      });
    }
    if (input.coverId !== undefined) {
      if (input.coverId !== null && !remaining.some(a => a.id === input.coverId)) throw new Error('封面不存在或已删除，请重新选择');
      changes.coverId = input.coverId;
    }
    if (input.nexprintImageIds !== undefined) {
      const coverId = input.coverId !== undefined ? input.coverId : model.coverId;
      const eligible = remaining.filter(asset => asset.id !== coverId && ['photo', 'render', 'diagram'].includes(input.assetRoles?.[asset.id] || asset.role));
      if (!Array.isArray(input.nexprintImageIds) || input.nexprintImageIds.length > 9 || new Set(input.nexprintImageIds).size !== input.nexprintImageIds.length ||
          input.nexprintImageIds.some(assetId => typeof assetId !== 'string' || !eligible.some(asset => asset.id === assetId)))
        throw new Error('NexPrint 图片选择无效：请选择至多 9 张非封面图片');
      changes.nexprintImageIds = [...input.nexprintImageIds];
    }
    if (model.profiles.length && (changes.description ?? model.description).trim() && model.status === 'pending') changes.status = 'collected';
    const saved = this.store.updateModel(id, changes, {
      purgeAssets: [...model.assets, ...legacyTrash].filter(asset => deleteIds.includes(asset.id)),
      purgeProfiles: removedProfiles,
    });
    this.invalidatePrepared(saved);
    return saved;
  }
  invalidatePrepared(saved) {
    // A prepared form is a snapshot of the old model metadata and selected
    // images. Invalidate it as soon as the user edits the model so it cannot
    // be saved with stale or over-limit gallery contents.
    for (const task of this.store.state.tasks.filter(task => task.modelId === saved.id && task.status === 'ready' && task.fingerprint !== modelFingerprint(saved))) {
      const patch = { status: 'attention', progress: 0, uncertain: false, message: '模型资料已更新，请重新准备表单' };
      if (task.target === 'nexprint') {
        patch.imageAssetIds = [...(saved.nexprintImageIds ?? [])];
      }
      this.store.updateTask(task.id, patch);
      void Promise.resolve(this.queue.executor.cancel?.(task.id)).catch(error =>
        this.store.log(`关闭旧的已准备表单失败：${error.message.split('\\n')[0]}`, { taskId: task.id, level: 'error' }));
    }
  }
  removeModel(id, { mode = 'trash', confirmPermanent = false } = {}) {
    if (!['trash', 'permanent'].includes(mode)) throw new Error('删除方式无效');
    if (mode === 'permanent' && confirmPermanent !== true) throw new Error('请确认彻底删除模型，本地文件无法恢复');
    const model = this.store.model(id, { includeDeleted: true });
    if (model.deletedAt && mode === 'trash') return model;
    if (this.collecting) throw new Error('正在读取来源资料，请完成后再删除模型');
    if (this.store.state.tasks.some(task => task.modelId === id && !task.deletedAt && ['queued', 'running', 'cancelling', 'ready', 'submitting', 'deleting'].includes(task.status)))
      throw new Error('模型有未完成的同步任务，请先完成或删除相关任务，再删除模型');
    const result = mode === 'permanent' ? this.store.purgeModel(id) : this.store.removeModel(id);
    this.store.log(mode === 'permanent' ? '已彻底删除本地模型、素材与关联任务记录' : `模型已放入回收站：${model.title}，可恢复`, { modelId: id });
    return result;
  }
  restoreModel(id) {
    const result = this.store.restoreModel(id);
    this.store.log(`已恢复模型：${result.title}`, { modelId: id });
    return result;
  }
  attach(id, files, kind) {
    const model = this.store.model(id);
    if (this.collecting || this.store.state.tasks.some(t => t.modelId === id && ['running', 'submitting'].includes(t.status))) throw new Error('模型正在处理，暂不可添加文件');
    if (!Array.isArray(files) || files.length < 1 || files.length > 50) throw new Error('文件数量不正确');
    if (!['model', 'image'].includes(kind)) throw new Error('文件类型不正确');
    const records = files.map(file => ingestFile(this.store.directory, id, file, kind));
    if (kind === 'image') return this.store.updateModel(id, {
      assets: [...model.assets, ...records.filter(a => !model.assets.some(b => b.sha256 === a.sha256))],
      excludedAssetHashes: (model.excludedAssetHashes || []).filter(hash => !records.some(asset => asset.sha256 === hash)),
    });
    const additions = records.filter(a => !model.profiles.some(p => p.file?.sha256 === a.sha256)).map(a => ({ id: randomUUID(), name: a.name.replace(/\.3mf$/i, ''), file: a, parameters: a.parameters }));
    return this.store.updateModel(id, { profiles: [...model.profiles, ...additions], status: model.description ? 'collected' : model.status });
  }
  async connectBrowser() {
    await this.browser.getContext();
    return { connected: true, message: '已连接设备默认 Chrome。ModelPort 仅在处理模型链接和上传任务时操作浏览器。' };
  }
  plans(ids, targets) {
    if (!Array.isArray(ids) || !Array.isArray(targets)) throw new Error('预览参数无效');
    return ids.flatMap(id => targets.map(target => {
      const model = this.store.model(id), plan = review(model, target);
      if (target === 'nexprint') plan.nexprintImages = model.nexprintImageIds?.length ?? 0;
      return plan;
    }));
  }
  enqueue(ids, targets) {
    if (this.collecting) throw new Error('正在读取来源资料，请稍后开始同步');
    return this.queue.enqueue(ids, targets);
  }
  asset(id) {
    for (const model of this.store.state.models) {
      const asset = model.assets.find(a => a.id === id);
      if (asset) return asset;
    }
    throw new Error('未找到图片');
  }
}
