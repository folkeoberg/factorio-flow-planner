const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('ffp', {
  loadGameData: () => ipcRenderer.invoke('gamedata:load'),
  detectFactorio: () => ipcRenderer.invoke('factorio:detect'),
  browseFactorio: () => ipcRenderer.invoke('factorio:browse'),
  importGameData: (exe) => ipcRenderer.invoke('gamedata:import', exe),
  importDumpFile: () => ipcRenderer.invoke('gamedata:importDump'),
  onImportProgress: (cb) => ipcRenderer.on('import:progress', (_e, m) => cb(m)),
  saveFile: (json, saveAs, name) => ipcRenderer.invoke('file:save', json, saveAs, name),
  showFile: () => ipcRenderer.send('file:show'),
  openFile: () => ipcRenderer.invoke('file:open'),
  newFile: () => ipcRenderer.send('file:new'),
  setDirty: (d) => ipcRenderer.send('dirty', d),
  closeNow: () => ipcRenderer.send('close-now'),
  onMenu: (cb) => ipcRenderer.on('menu', (_e, cmd) => cb(cmd)),
  onUpdate: (cb) => ipcRenderer.on('update', (_e, kind, version) => cb(kind, version)),
  checkUpdates: () => ipcRenderer.send('update:check'),
  installUpdate: () => ipcRenderer.send('update:install'),
  getVersion: () => ipcRenderer.invoke('app:version'),
});
