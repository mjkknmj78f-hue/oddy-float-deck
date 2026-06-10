const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('api', {
  getSpotify:        ()       => ipcRenderer.invoke('get-spotify'),
  getClaude:         ()       => ipcRenderer.invoke('get-claude'),
  getRateLimit:      ()       => ipcRenderer.invoke('get-rate-limit'),
  getSettings:       ()       => ipcRenderer.invoke('get-settings'),
  saveSettings:      (s)      => ipcRenderer.invoke('save-settings', s),
  pickImage:         ()       => ipcRenderer.invoke('pick-image'),
  clearImage:        ()       => ipcRenderer.invoke('clear-image'),
  spotifyControl:    (action) => ipcRenderer.invoke('spotify-control', action),
  toggleFullscreen:  ()       => ipcRenderer.invoke('toggle-fullscreen'),
  onFullscreenChange:(cb)     => ipcRenderer.on('fullscreen-changed', (_, v) => cb(v)),
  quit:              ()       => ipcRenderer.invoke('quit'),
  getSpotifyQueue:   ()       => ipcRenderer.invoke('get-spotify-queue'),
  spotifyConnect:    ()       => ipcRenderer.invoke('spotify-connect'),
  spotifyDisconnect: ()       => ipcRenderer.invoke('spotify-disconnect'),
})
