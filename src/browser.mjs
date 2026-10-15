import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import { PLATFORMS, UserActionRequired } from './domain.mjs';

export class BrowserManager {
  constructor(directory, store, options = {}) {
    this.directory = directory; this.store = store; this.context = null; this.pages = new Map(); this.starting = null;
    this.cdpBrowser = null; this.connectOverCDP = options.connectOverCDP || ((endpoint, settings) => chromium.connectOverCDP(endpoint, settings));
    this.localAppData = options.localAppData ?? process.env.LOCALAPPDATA;
    this.downloadArtifactsDirectory = null;
  }
  defaultChromeEndpoint() {
    if (!this.localAppData) throw new UserActionRequired('没有找到 Windows 本地应用数据目录；请确认设备默认 Chrome 已安装。');
    const portFile = path.join(this.localAppData, 'Google', 'Chrome', 'User Data', 'DevToolsActivePort');
    let lines;
    try { lines = fs.readFileSync(portFile, 'utf8').split(/\r?\n/).map(line => line.trim()).filter(Boolean); }
    catch { throw new UserActionRequired('未找到默认 Chrome 的远程调试端点。请确认已为默认配置开启远程调试，并重新启动 Chrome。'); }
    const port = Number(lines[0]);
    const websocketPath = lines[1];
    if (!Number.isInteger(port) || port < 1 || port > 65535 || !/^\/devtools\/browser\/[A-Za-z0-9_-]+$/.test(websocketPath || ''))
      throw new UserActionRequired('默认 Chrome 的调试端点无效。请关闭并重新打开 Chrome 的远程调试后重试。');
    // Chrome's permission-gated endpoint intentionally returns 404 for /json/version;
    // use the browser WebSocket path from DevToolsActivePort directly.
    return `ws://127.0.0.1:${port}${websocketPath}`;
  }
  async attachDefaultChrome() {
    const endpoint = this.defaultChromeEndpoint();
    try {
      this.downloadArtifactsDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'modelport-downloads-'));
      this.cdpBrowser = await this.connectOverCDP(endpoint, { timeout: 120000, isLocal: true, noDefaults: true, artifactsDir: this.downloadArtifactsDirectory });
      this.cdpBrowser.on('disconnected', () => {
        this.context = null; this.cdpBrowser = null; this.pages.clear();
        this.cleanupDownloadArtifacts();
      });
      this.context = this.cdpBrowser.contexts()[0];
      if (!this.context) throw new Error('Chrome 没有可用的默认浏览器上下文');
    } catch (error) {
      const browser = this.cdpBrowser; this.cdpBrowser = null; this.context = null;
      try { await browser?.close(); } catch {}
      this.cleanupDownloadArtifacts();
      if (error instanceof UserActionRequired) throw error;
      throw new UserActionRequired(`连接默认 Chrome 失败：${error.message.split('\n')[0]}`);
    }
  }
  async downloadFromPage(trigger, timeout = 45000) {
    if (!this.cdpBrowser || !this.downloadArtifactsDirectory) throw new UserActionRequired('默认 Chrome 尚未连接，无法自动接收 3MF 下载');
    const session = await this.cdpBrowser.newBrowserCDPSession();
    let downloadInfo = null, timer;
    let onBegin, onProgress;
    const downloadPromise = new Promise((resolve, reject) => {
      timer = setTimeout(() => reject(new UserActionRequired('等待 MakerWorld 3MF 下载超时')), timeout);
      onBegin = event => {
        let urlPath = '';
        try { urlPath = new URL(event.url).pathname; } catch {}
        if (!/\.3mf$/i.test(event.suggestedFilename || '') && !/\.3mf$/i.test(urlPath)) return;
        downloadInfo = event;
      };
      onProgress = event => {
        if (!downloadInfo || event.guid !== downloadInfo.guid) return;
        if (event.state === 'completed') resolve({
          path: event.filePath || path.join(this.downloadArtifactsDirectory, event.guid),
          suggestedFilename: downloadInfo.suggestedFilename,
        });
        else if (event.state === 'canceled') reject(new UserActionRequired('Chrome 已取消 MakerWorld 3MF 下载'));
      };
      session.on('Browser.downloadWillBegin', onBegin);
      session.on('Browser.downloadProgress', onProgress);
    });
    try {
      await session.send('Browser.setDownloadBehavior', {
        behavior: 'allowAndName', downloadPath: this.downloadArtifactsDirectory, eventsEnabled: true,
      });
      const [, result] = await Promise.all([trigger(), downloadPromise]);
      if (!fs.existsSync(result.path)) throw new UserActionRequired('Chrome 已报告 3MF 下载完成，但未找到下载文件');
      return result;
    } catch (error) {
      if (error instanceof UserActionRequired) throw error;
      throw new UserActionRequired(`自动下载 3MF 失败：${error.message.split('\n')[0]}`);
    } finally {
      clearTimeout(timer);
      session.off('Browser.downloadWillBegin', onBegin);
      session.off('Browser.downloadProgress', onProgress);
      try { await session.send('Browser.setDownloadBehavior', { behavior: 'default' }); }
      finally { await session.detach().catch(() => {}); }
    }
  }
  cleanupDownloadArtifacts() {
    const directory = this.downloadArtifactsDirectory; this.downloadArtifactsDirectory = null;
    if (directory) { try { fs.rmSync(directory, { recursive: true, force: true }); } catch {} }
  }
  async getContext() {
    if (this.context) return this.context;
    if (this.starting) return this.starting;
    this.starting = (async () => {
      await this.attachDefaultChrome();
      this.context.on('close', () => { this.context = null; this.cdpBrowser = null; this.pages.clear(); });
      this.context.setDefaultTimeout(12000);
      return this.context;
    })();
    try { return await this.starting; } finally { this.starting = null; }
  }
  async page(key) {
    const context = await this.getContext();
    let page = this.pages.get(key);
    if (!page || page.isClosed()) { page = await context.newPage(); this.pages.set(key, page); }
    return page;
  }
  async closePage(key) {
    const page = this.pages.get(key);
    this.pages.delete(key);
    if (page && !page.isClosed()) await page.close();
  }
  async openPlatform(platform) {
    if (!PLATFORMS[platform]) throw new Error('不支持的平台');
    const page = await this.page(`account-${platform}`);
    await page.goto(PLATFORMS[platform].url, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await page.bringToFront();
    return { platform, opened: true, message: '请在已连接的浏览器中完成登录。此状态仅表示页面已打开。' };
  }
  async evidence(page, label) {
    const directory = path.join(this.directory, 'evidence'); fs.mkdirSync(directory, { recursive: true });
    const filename = `${Date.now()}-${label.replace(/[^a-zA-Z0-9-]/g, '')}.png`;
    await page.screenshot({ path: path.join(directory, filename), fullPage: false });
    return filename;
  }
  async close() {
    if (this.cdpBrowser) {
      const browser = this.cdpBrowser; this.cdpBrowser = null; this.context = null; this.pages.clear();
      try { await browser.close(); } finally { this.cleanupDownloadArtifacts(); }
      return;
    }
    await this.context?.close();
    this.cleanupDownloadArtifacts();
  }
}
