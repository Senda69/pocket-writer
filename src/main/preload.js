'use strict';

const { contextBridge, ipcRenderer } = require('electron');

const call = async (channel, ...args) => {
  const res = await ipcRenderer.invoke(channel, ...args);
  if (!res.ok) throw new Error(res.error);
  return res.value;
};

contextBridge.exposeInMainWorld('mw', {
  platform: process.platform,
  getSettings: () => call('settings:get'),
  setApiKey: (key) => call('settings:setKey', key),
  findRhymes: (input, opts) => call('rhymes:find', input, opts),
  lineInfo: (text) => call('phon:line', text),
  fit: (text, pattern) => call('phon:fit', text, pattern),
  fitMany: (items) => call('phon:fitMany', items),
  doRhyme: (a, b) => call('phon:doRhyme', a, b),
  suggest: (payload) => call('ai:suggest', payload),
  saveProject: (json, name) => call('project:save', json, name),
  openProject: () => call('project:open'),
  exportText: (text, name) => call('export:text', text, name),
});
