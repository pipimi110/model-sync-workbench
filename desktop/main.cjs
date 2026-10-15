const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const { pathToFileURL } = require('node:url');
let instance, window;
const workspaceDirectory = require('./workspace.cjs').workspaceDirectory({
  packaged: app.isPackaged, appData: app.getPath('appData'),
  project: path.join(__dirname, '..'), override: process.env.MODEL_SYNC_DATA,
});
const shellDirectory = path.resolve(process.env.MODEL_SYNC_SHELL_DIR || path.join(workspaceDirectory, 'desktop-shell'));
fs.mkdirSync(shellDirectory, { recursive: true });
const mainLog = path.join(workspaceDirectory, 'desktop-main.log');
function logMain(message) { try { fs.appendFileSync(mainLog, `${new Date().toISOString()} ${message}\n`, 'utf8'); } catch {} }
app.setPath('userData', shellDirectory);
app.setPath('sessionData', shellDirectory);
if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => { if (window) { if (window.isMinimized()) window.restore(); if (!window.isVisible()) window.show(); window.focus(); } });
  app.whenReady().then(async () => {
    const { startServer } = await import(pathToFileURL(path.join(__dirname, '../src/server.mjs')).href);
    instance = await startServer({ directory: workspaceDirectory });
    logMain(`local server ready: ${instance.url}`);
    console.log(`MODEL_SYNC_DESKTOP_URL=${instance.url}`);
    window = new BrowserWindow({ width: 1420, height: 950, minWidth: 1080, minHeight: 720,
      title: 'ModelPort · 模型同步工作台', backgroundColor: '#f4f6f8', show: true,
      webPreferences: { preload: path.join(__dirname, 'preload.cjs'), nodeIntegration: false, contextIsolation: true, sandbox: true } });
    window.webContents.on('did-fail-load', (_event, code, description, url) => logMain(`page load failed (${code}): ${description} ${url}`));
    window.webContents.on('render-process-gone', (_event, details) => logMain(`renderer exited: ${JSON.stringify(details)}`));
    const verify = event => { if (event.sender !== window.webContents || !event.senderFrame || new URL(event.senderFrame.url).origin !== instance.url) throw new Error('不受支持的调用来源'); };
    ipcMain.handle('choose-files', async (event, kind) => {
      verify(event);
      const image = kind === 'image';
      const result = await dialog.showOpenDialog(window, { properties: ['openFile', 'multiSelections'],
        filters: [{ name: image ? '图片' : '3MF 模型', extensions: image ? ['png', 'jpg', 'jpeg', 'webp', 'gif'] : ['3mf'] }] });
      return result.canceled ? [] : result.filePaths;
    });
    ipcMain.handle('open-platform-link', async (event, url) => { verify(event); const { safeExternalUrl } = await import(pathToFileURL(path.join(__dirname, '../src/domain.mjs')).href); await shell.openExternal(safeExternalUrl(url)); });
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    window.webContents.on('will-navigate', (event, url) => { if (new URL(url).origin !== instance.url) event.preventDefault(); });
    window.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    await window.loadURL(instance.url); window.show(); window.focus();
    logMain('main window loaded');
  }).catch(error => { logMain(`startup failed: ${error.stack || error.message}`); dialog.showErrorBox('启动失败', error.message); app.quit(); });
  app.on('window-all-closed', () => app.quit());
  let quitting = false;
  app.on('before-quit', event => { if (!quitting && instance) { event.preventDefault(); quitting = true; instance.close().finally(() => app.quit()); } });
}
