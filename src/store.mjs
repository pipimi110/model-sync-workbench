import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { newModel } from './domain.mjs';
import { deletionPlan, permanentlyDelete, recoverFileDeletions } from './deletion.mjs';

export class Store {
  constructor(directory) {
    this.directory = directory;
    fs.mkdirSync(directory, { recursive: true });
    this.file = path.join(directory, 'state.json');
    this.state = fs.existsSync(this.file) ? JSON.parse(fs.readFileSync(this.file, 'utf8')) :
      { version: 1, models: [], tasks: [], logs: [], settings: {} };
    if (this.state.version !== 1 || !Array.isArray(this.state.models) || !Array.isArray(this.state.tasks)) throw new Error('不支持或损坏的资料库格式，请保留原文件');
    recoverFileDeletions(this);
    // Image deletions are permanent. Purge image records left in the legacy
    // recycle bin by earlier builds before exposing the updated workspace.
    for (const model of this.state.models) {
      const legacyTrash = model.trashedAssets || [];
      if (!legacyTrash.length) continue;
      this.updateModel(model.id, {
        trashedAssets: [],
        excludedAssetHashes: [...new Set([...(model.excludedAssetHashes || []), ...legacyTrash.map(asset => asset.sha256).filter(Boolean)])],
      }, { purgeAssets: legacyTrash });
    }
    this.mutate(s => {
      s.settings ||= {};
      delete s.settings.browser;
      delete s.settings.browserModeMigrated;
      for (const task of s.tasks) {
        if (task.status === 'deleting') {
          task.status = task.deleteFromStatus && task.deleteFromStatus !== 'ready' ? task.deleteFromStatus : 'cancelled';
          task.deletedAt = new Date().toISOString(); task.deleteFromStatus = null;
          task.message = '任务记录已删除；目标平台原有作品保留';
        } else if (task.deleteRequested) {
          task.status = 'cancelled'; task.step = 'cancelled'; task.progress = 0; task.uncertain = false;
          task.deletedAt = new Date().toISOString(); task.deleteRequested = false;
          task.message = '已中断准备流程并删除任务记录';
        } else if (task.status === 'cancelling') {
          task.status = 'cancelled'; task.step = 'cancelled'; task.progress = 0; task.uncertain = false;
          task.message = '应用关闭时中断了准备流程，未执行平台保存。';
        } else if (task.status === 'running' || task.status === 'submitting') {
          task.status = 'attention';
          task.message = '上次运行中断。请检查目标平台是否已保存，再选择重试或记录已有作品。';
          task.uncertain = true;
        } else if (task.status === 'ready') {
          task.status = 'attention'; task.message = '应用已重启，原浏览器表单需重新检查。'; task.uncertain = true;
        }
      }
    });
  }
  mutate(fn) {
    const next = structuredClone(this.state);
    const result = fn(next);
    const temporary = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify(next, null, 2), 'utf8');
    fs.renameSync(temporary, this.file);
    this.state = next;
    return result === undefined ? undefined : structuredClone(result);
  }
  snapshot() { return structuredClone(this.state); }
  model(id, { includeDeleted = false } = {}) {
    const value = this.state.models.find(m => m.id === id);
    if (!value) throw new Error('未找到模型');
    if (value.deletedAt && !includeDeleted) throw new Error('模型已删除，请先在模型库中恢复');
    return structuredClone(value);
  }
  task(id) {
    const value = this.state.tasks.find(t => t.id === id);
    if (!value) throw new Error('未找到任务');
    return structuredClone(value);
  }
  addModel(url) {
    const model = newModel(url);
    const exists = this.state.models.find(m => m.source.platform === model.source.platform && m.source.id === model.source.id);
    if (exists) return exists.deletedAt ? this.restoreModel(exists.id) : structuredClone(exists);
    return this.mutate(s => { s.models.push(model); return model; });
  }
  removeModel(id) {
    const model = this.model(id, { includeDeleted: true });
    if (model.deletedAt) return model;
    return this.mutate(s => {
      const at = new Date().toISOString(), record = s.models.find(model => model.id === id);
      Object.assign(record, { deletedAt: at, updatedAt: at, revision: record.revision + 1 });
      for (const task of s.tasks.filter(task => task.modelId === id && !task.deletedAt)) {
        Object.assign(task, { deletedAt: at, deletedByModel: id, updatedAt: at });
      }
      return record;
    });
  }
  restoreModel(id) {
    const model = this.model(id, { includeDeleted: true });
    if (!model.deletedAt) throw new Error('模型未删除');
    return this.mutate(s => {
      const at = new Date().toISOString(), record = s.models.find(model => model.id === id);
      Object.assign(record, { deletedAt: null, updatedAt: at, revision: record.revision + 1 });
      for (const task of s.tasks.filter(task => task.modelId === id && task.deletedByModel === id)) {
        Object.assign(task, { deletedAt: null, deletedByModel: null, updatedAt: at });
      }
      return record;
    });
  }
  purgeModel(id) {
    const model = this.model(id, { includeDeleted: true });
    const tasks = this.state.tasks.filter(task => task.modelId === id);
    const result = permanentlyDelete(this, deletionPlan(this, { models: [model], tasks }), state => {
      const ids = new Set(tasks.map(task => task.id));
      state.models = state.models.filter(model => model.id !== id);
      state.tasks = state.tasks.filter(task => task.modelId !== id);
      state.logs = state.logs.filter(log => log.modelId !== id && !ids.has(log.taskId));
    });
    return { id, ...result };
  }
  purgeTask(id) {
    const task = this.task(id);
    const result = permanentlyDelete(this, deletionPlan(this, { tasks: [task] }), state => {
      state.tasks = state.tasks.filter(task => task.id !== id);
      state.logs = state.logs.filter(log => log.taskId !== id);
    });
    return { id, ...result };
  }
  retryFileCleanup() { return recoverFileDeletions(this); }
  updateModel(id, changes, { purgeAssets = [], purgeProfiles = [] } = {}) {
    const update = s => {
      const model = s.models.find(m => m.id === id);
      if (!model) throw new Error('未找到模型');
      Object.assign(model, changes, { updatedAt: new Date().toISOString(), revision: model.revision + 1 });
      return model;
    };
    if (!purgeAssets.length && !purgeProfiles.length) return this.mutate(update);
    const model = this.model(id, { includeDeleted: true });
    permanentlyDelete(this, deletionPlan(this, {
      assets: purgeAssets.map(asset => ({ model, asset })),
      profiles: purgeProfiles.map(profile => ({ model, profile })),
    }), update);
    return this.model(id, { includeDeleted: true });
  }
  updateTask(id, changes) {
    return this.mutate(s => {
      const task = s.tasks.find(t => t.id === id);
      if (!task) throw new Error('未找到任务');
      Object.assign(task, changes, { updatedAt: new Date().toISOString() }); return task;
    });
  }
  log(message, details = {}) {
    this.mutate(s => {
      s.logs.unshift({ id: randomUUID(), at: new Date().toISOString(), message, ...details });
      s.logs = s.logs.slice(0, 500);
    });
  }
}
