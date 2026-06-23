const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  platform: process.platform,
  send:   (channel, data)         => ipcRenderer.send(channel, data),
  invoke: (channel, data)         => ipcRenderer.invoke(channel, data),
  on:     (channel, callback)     => ipcRenderer.on(channel, (_, data) => callback(data)),
  off:    (channel, callback)     => ipcRenderer.removeListener(channel, callback),
});
