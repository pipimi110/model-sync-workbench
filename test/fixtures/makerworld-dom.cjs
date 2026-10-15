const { app, BrowserWindow } = require('electron');
app.setPath('userData', process.env.MODELPORT_DOM_TEST_DATA);
app.whenReady().then(() => {
  const window = new BrowserWindow({ show: process.env.MODELPORT_DOM_TEST_VISIBLE === '1', width: 1420, height: 950,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
  window.loadURL('about:blank');
});
app.on('window-all-closed', () => app.quit());
