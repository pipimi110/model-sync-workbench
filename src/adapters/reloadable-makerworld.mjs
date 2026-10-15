import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';

const defaultModulePath = fileURLToPath(new URL('./makerworld.mjs', import.meta.url));

// Refresh the source collector at each model-collection boundary so fixes to
// extraction and downloads become available without restarting ModelPort.
export class ReloadableMakerWorldCollector {
  constructor(store, browser, { modulePath = defaultModulePath, importer = url => import(url) } = {}) {
    this.store = store;
    this.browser = browser;
    this.modulePath = modulePath;
    this.importer = importer;
    this.collector = null;
    this.loadedHash = null;
  }
  async current() {
    const source = fs.readFileSync(this.modulePath);
    const hash = createHash('sha256').update(source).digest('hex');
    if (this.collector && hash === this.loadedHash) return this.collector;
    try {
      const url = new URL(pathToFileURL(this.modulePath).href);
      url.searchParams.set('hot', hash);
      const { collectMakerWorld } = await this.importer(url.href);
      if (typeof collectMakerWorld !== 'function') throw new Error('未导出 collectMakerWorld');
      this.collector = collectMakerWorld;
      this.loadedHash = hash;
      this.store.log?.('已加载最新 MakerWorld 采集逻辑');
      return this.collector;
    } catch (error) {
      if (this.collector) {
        this.store.log?.(`MakerWorld 采集逻辑热加载失败，继续使用当前版本：${error.message.split('\n')[0]}`, { level: 'error' });
        return this.collector;
      }
      throw error;
    }
  }
  async collect(model, log) {
    return (await this.current())(this.store, this.browser, model, log);
  }
}
