const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('desktop', {
  chooseFiles: kind => ipcRenderer.invoke('choose-files', kind),
  openLink: url => ipcRenderer.invoke('open-platform-link', url),
});
