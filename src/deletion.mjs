import fs from 'node:fs';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';

const safeId = value => typeof value === 'string' && /^[a-zA-Z0-9-]{1,100}$/.test(value);
const fileKey = file => process.platform === 'win32' ? file.toLowerCase() : file;
const inside = (root, file) => { const relative = path.relative(root, file); return relative && relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative); };
function noLinks(root, target) {
  let current = root;
  for (const part of ['', ...path.relative(root, target).split(path.sep).filter(Boolean)]) {
    if (part) current = path.join(current, part);
    try { if (fs.lstatSync(current).isSymbolicLink()) throw new Error('删除路径包含符号链接或目录联接，已停止'); }
    catch (error) { if (error.code === 'ENOENT') return; throw error; }
  }
}
function managed(store, filename) {
  if (typeof filename !== 'string' || !filename) return null;
  const root = path.resolve(store.directory), absolute = path.resolve(filename);
  if (!['library', 'downloads', 'evidence'].some(name => inside(path.join(root, name), absolute))) return null;
  noLinks(root, absolute);
  return absolute;
}
function stageDirectory(store, id) {
  if (!safeId(id)) throw new Error('删除事务标识无效');
  const root = path.resolve(store.directory), directory = path.join(root, '.purge', id);
  if (!inside(root, directory)) throw new Error('删除事务路径无效');
  noLinks(root, directory);
  return directory;
}
function walkFiles(store, directory) {
  const result = [];
  if (!fs.existsSync(directory)) return result;
  noLinks(path.resolve(store.directory), directory);
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (!managed(store, file)) throw new Error('文件不在模型库管理目录内');
    if (entry.isSymbolicLink()) throw new Error('删除目录包含符号链接，已停止');
    if (entry.isDirectory()) result.push(...walkFiles(store, file));
    else if (entry.isFile()) result.push(file);
    else throw new Error('删除目录包含不支持的文件类型');
  }
  return result;
}
function imageCache(store, model, asset) {
  if (!asset.sourceUrl || !/^image-\d+$/.test(asset.name || '')) return null;
  return path.join(store.directory, 'downloads', model.id, asset.name);
}
function references(store, excludedModels, excludedTasks, excludedAssets, excludedProfiles) {
  const files = new Set(), add = file => { const checked = managed(store, file); if (checked) files.add(fileKey(checked)); };
  for (const model of store.state.models) {
    if (excludedModels.has(model.id)) continue;
    for (const asset of [...model.assets, ...(model.trashedAssets || [])]) {
      if (excludedAssets.has(model.id + ':' + asset.id)) continue;
      add(asset.path); add(imageCache(store, model, asset));
    }
    for (const profile of model.profiles) if (!excludedProfiles.has(model.id + ':' + profile.id)) add(profile.file?.path);
  }
  for (const task of store.state.tasks) {
    if (excludedTasks.has(task.id) || excludedModels.has(task.modelId)) continue;
    for (const name of [task.screenshot, task.result?.screenshot])
      if (typeof name === 'string' && path.basename(name) === name) add(path.join(store.directory, 'evidence', name));
  }
  return files;
}
export function deletionPlan(store, { models = [], tasks = [], assets = [], profiles = [] } = {}) {
  const modelIds = new Set(models.map(model => model.id)), taskIds = new Set(tasks.map(task => task.id));
  const profileKeys = new Set(profiles.map(({ model, profile }) => model.id + ':' + profile.id));
  if ([...modelIds, ...taskIds, ...profiles.map(({ model, profile }) => model.id), ...profiles.map(({ profile }) => profile.id)].some(id => !safeId(id))) throw new Error('删除对象标识无效');
  const protectedFiles = references(store, modelIds, taskIds, new Set(assets.map(({ model, asset }) => model.id + ':' + asset.id)), profileKeys);
  const files = new Map(), directories = [];
  const add = filename => { const checked = managed(store, filename); if (checked && fs.existsSync(checked)) files.set(fileKey(checked), checked); };
  for (const model of models) {
    for (const root of ['library', 'downloads']) {
      const directory = path.resolve(store.directory, root, model.id);
      if (!inside(path.resolve(store.directory, root), directory)) throw new Error('模型目录超出管理范围');
      directories.push(directory); walkFiles(store, directory).forEach(add);
    }
    for (const asset of [...model.assets, ...(model.trashedAssets || [])]) add(asset.path);
    for (const profile of model.profiles) add(profile.file?.path);
  }
  for (const { model, asset } of assets) {
    add(asset.path);
    const cache = managed(store, imageCache(store, model, asset));
    if (cache && fs.existsSync(cache) && createHash('sha256').update(fs.readFileSync(cache)).digest('hex') === asset.sha256) add(cache);
  }
  for (const { profile } of profiles) add(profile.file?.path);
  const evidence = path.join(store.directory, 'evidence');
  if (fs.existsSync(evidence)) for (const file of walkFiles(store, evidence)) {
    const name = path.basename(file);
    if (tasks.some(task => name.endsWith('-' + task.id + '.png')) ||
        models.some(model => name.endsWith('-source-' + model.source.id + '.png'))) add(file);
  }
  for (const task of tasks) for (const name of [task.screenshot, task.result?.screenshot])
    if (typeof name === 'string' && path.basename(name) === name) add(path.join(evidence, name));
  return { files: [...files.values()].filter(file => !protectedFiles.has(fileKey(file))), retainedShared: [...files.keys()].filter(file => protectedFiles.has(file)).length, directories };
}
function readManifest(store, id) {
  const directory = stageDirectory(store, id), manifestFile = path.join(directory, 'manifest.json');
  noLinks(path.resolve(store.directory), manifestFile);
  const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
  if (manifest.version !== 1 || !Array.isArray(manifest.files)) throw new Error('删除事务清单无效');
  manifest.files.forEach((file, index) => {
    if (managed(store, file.source) !== file.source || file.staged !== path.join(directory, String(index))) throw new Error('删除事务清单路径无效');
    noLinks(directory, file.staged);
  });
  return { directory, manifestFile, files: manifest.files };
}
function finishFiles(store, id, committed) {
  const manifest = readManifest(store, id);
  for (const file of [...manifest.files].reverse()) {
    if (!fs.existsSync(file.staged)) continue;
    if (committed) fs.unlinkSync(file.staged);
    else {
      if (fs.existsSync(file.source)) throw new Error('恢复删除事务时原路径已有文件，已保留待处理文件');
      fs.mkdirSync(path.dirname(file.source), { recursive: true });
      fs.renameSync(file.staged, file.source);
    }
  }
  fs.unlinkSync(manifest.manifestFile); fs.rmdirSync(manifest.directory);
}
export function recoverFileDeletions(store) {
  store.fileCleanupErrors = [];
  const root = path.join(store.directory, '.purge');
  if (fs.existsSync(root)) {
    noLinks(path.resolve(store.directory), root);
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.isSymbolicLink() || !safeId(entry.name)) throw new Error('删除事务目录异常，已保留文件');
      try {
        const committed = (store.state.pendingPurges || []).includes(entry.name);
        const directory = stageDirectory(store, entry.name);
        if (!fs.existsSync(path.join(directory, 'manifest.json')) && !fs.readdirSync(directory).length) fs.rmdirSync(directory);
        else finishFiles(store, entry.name, committed);
      } catch (error) { store.fileCleanupErrors.push(error.message); }
    }
  }
  const pending = (store.state.pendingPurges || []).filter(id => fs.existsSync(stageDirectory(store, id)));
  if (pending.length !== (store.state.pendingPurges || []).length) store.mutate(state => { state.pendingPurges = pending; });
  return { pending: pending.length, errors: [...store.fileCleanupErrors] };
}
function removeEmptyDirectories(directory) {
  if (!fs.existsSync(directory)) return;
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) if (entry.isDirectory() && !entry.isSymbolicLink()) removeEmptyDirectories(path.join(directory, entry.name));
  try { fs.rmdirSync(directory); } catch (error) { if (!['ENOTEMPTY', 'ENOENT', 'EEXIST'].includes(error.code)) throw error; }
}
export function permanentlyDelete(store, plan, change) {
  const id = randomUUID(), directory = stageDirectory(store, id);
  const files = plan.files.map((source, index) => {
    if (managed(store, source) !== source || !fs.lstatSync(source).isFile()) throw new Error('删除文件路径无效');
    return { source, staged: path.join(directory, String(index)) };
  });
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, 'manifest.json'), JSON.stringify({ version: 1, files }), 'utf8');
  try {
    for (const file of files) fs.renameSync(file.source, file.staged);
    store.mutate(state => { change(state); state.pendingPurges = [...(state.pendingPurges || []), id]; });
  } catch (error) {
    try { finishFiles(store, id, false); } catch (recovery) { throw new Error(error.message + '；回滚待恢复：' + recovery.message); }
    throw error;
  }
  try {
    finishFiles(store, id, true);
    store.mutate(state => { state.pendingPurges = (state.pendingPurges || []).filter(value => value !== id); });
  } catch (error) { throw new Error('记录已彻底删除，但文件清理未完成；可在工作台重试文件清理：' + error.message); }
  // Empty folders contain no recoverable files. Leaving one behind is harmless
  // if Windows refuses to remove it after the actual files were deleted.
  for (const dir of plan.directories) { try { noLinks(path.resolve(store.directory), dir); removeEmptyDirectories(dir); } catch {} }
  return { permanentlyDeleted: true, deletedFiles: files.length, retainedSharedFiles: plan.retainedShared };
}
