const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('triageApi', {
  getInitialData: () => ipcRenderer.invoke('triage:get-initial-data'),
  openYamlDialog: () => ipcRenderer.invoke('triage:open-yaml-dialog'),
  parseYamlString: (rawYaml, sourceLabel) =>
    ipcRenderer.invoke('triage:parse-yaml-string', rawYaml, sourceLabel),
  fetchGithubDescription: (itemMeta) =>
    ipcRenderer.invoke('triage:fetch-github-description', itemMeta),
  generateScript: (items) => ipcRenderer.invoke('triage:generate-script', items),
  serializeYaml: (items) => ipcRenderer.invoke('triage:serialize-yaml', items),
  copyToClipboard: (text) => ipcRenderer.invoke('triage:copy-clipboard', text),
  saveScript: (scriptContent) => ipcRenderer.invoke('triage:save-script', scriptContent),
  saveYaml: (items) => ipcRenderer.invoke('triage:save-yaml', items),
  openExternal: (url) => ipcRenderer.invoke('triage:open-external', url),
});
