const {contextBridge, ipcRenderer} = require('electron');
contextBridge.exposeInMainWorld('rugHost', {
  init: () => ipcRenderer.invoke('rug:init'),
  hit: v => ipcRenderer.send('rug:hit', Boolean(v)),
  dragging: v => ipcRenderer.send('rug:dragging', Boolean(v)),
  menu: () => ipcRenderer.send('rug:menu'),
  report: data => ipcRenderer.send('rug:report', data),
  onCursor: cb => { ipcRenderer.on('rug:cursor', (_, p) => cb(p)); },
  onCommand: cb => { ipcRenderer.on('rug:command', (_, c) => cb(c)); }
});
