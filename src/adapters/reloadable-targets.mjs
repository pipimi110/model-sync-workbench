import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';

const defaultModulePath = fileURLToPath(new URL('./targets.mjs', import.meta.url));

// Reload the target adapter at each prepare/commit boundary. This keeps the
// Electron window, task queue, browser connection, and prepared pages alive
// while making edits to upload behavior available without restarting ModelPort.
export class ReloadableTargetExecutor {
  constructor(browser, store, { modulePath = defaultModulePath, importer = url => import(url) } = {}) {
    this.browser = browser;
    this.store = store;
    this.modulePath = modulePath;
    this.importer = importer;
    this.executor = null;
    this.loadedHash = null;
  }
  async current() {
    const source = fs.readFileSync(this.modulePath);
    const hash = createHash('sha256').update(source).digest('hex');
    if (this.executor && hash === this.loadedHash) return this.executor;
    try {
      const url = new URL(pathToFileURL(this.modulePath).href);
      url.searchParams.set('hot', hash);
      const { TargetExecutor } = await this.importer(url.href);
      const next = new TargetExecutor(this.browser, this.store);
      // A prepared form is tied to the live browser page, so keep it when only
      // the implementation module changes between prepare and commit.
      if (this.executor) next.prepared = this.executor.prepared;
      this.executor = next;
      this.loadedHash = hash;
      this.store.log?.('已加载最新平台上传逻辑');
      return next;
    } catch (error) {
      if (this.executor) {
        this.store.log?.(`平台上传逻辑热加载失败，继续使用当前版本：${error.message.split('\n')[0]}`, { level: 'error' });
        return this.executor;
      }
      throw error;
    }
  }
  async prepare(...args) { return (await this.current()).prepare(...args); }
  async commit(...args) { return (await this.current()).commit(...args); }
  async verify(...args) { return (await this.current()).verify(...args); }
  async cancel(...args) { return (await this.current()).cancel(...args); }
  forget(taskId) { this.executor?.forget(taskId); }
}
