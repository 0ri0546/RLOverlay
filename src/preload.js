const { contextBridge, ipcRenderer } = require('electron')
contextBridge.exposeInMainWorld('api', {
  setFormat: fmt => ipcRenderer.send('set-format', fmt),
  setModules: mods => ipcRenderer.send('set-modules', mods),
  updateDemos: data => ipcRenderer.send('update-demos', data),
  sendWinChance: chance => ipcRenderer.send('send-winchance', chance),
  setRLSKey: k => ipcRenderer.send('set-rls-key', k),
  close: () => ipcRenderer.send('close'),
  reconnect: () => ipcRenderer.send('reconnect'),
  on: (ch, cb) => ipcRenderer.on(ch, (_, d) => cb(d))
})
