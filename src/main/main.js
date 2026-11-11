'use strict';

const { app, BrowserWindow, ipcMain, dialog, session, safeStorage, systemPreferences, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const phon = require('../lib/phonetics');
const claude = require('./claude');

// Lets tests (or a second profile) use a separate data folder.
if (process.env.POCKETWRITER_USER_DATA) app.setPath('userData', process.env.POCKETWRITER_USER_DATA);

const settingsFile = () => path.join(app.getPath('userData'), 'settings.json');

function readSettings() {
  try { return JSON.parse(fs.readFileSync(settingsFile(), 'utf8')); } catch { return {}; }
}
function writeSettings(s) {
  fs.mkdirSync(path.dirname(settingsFile()), { recursive: true });
  fs.writeFileSync(settingsFile(), JSON.stringify(s, null, 2));
}

function getApiKey() {
  const s = readSettings();
  if (s.apiKeyEnc && safeStorage.isEncryptionAvailable()) {
    try { return safeStorage.decryptString(Buffer.from(s.apiKeyEnc, 'base64')); } catch { /* fall through */ }
  }
  if (s.apiKeyPlain) return s.apiKeyPlain;
  return process.env.ANTHROPIC_API_KEY || null;
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1360,
    height: 880,
    minWidth: 900,
    minHeight: 600,
    title: 'Pocket Writer',
    backgroundColor: '#14121a',
    ...(process.platform === 'darwin' ? { titleBarStyle: 'hiddenInset' } : {}),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https:\/\//.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  return win;
}

app.whenReady().then(async () => {
  // Only the microphone is ever requested.
  session.defaultSession.setPermissionRequestHandler((_wc, permission, cb, details) => {
    cb(permission === 'media' && (!details.mediaTypes || details.mediaTypes.every((t) => t === 'audio')));
  });
  session.defaultSession.setPermissionCheckHandler((_wc, permission) => permission === 'media');
  if (process.platform === 'darwin') {
    try { await systemPreferences.askForMediaAccess('microphone'); } catch { /* user can grant later */ }
  }
  createWindow();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });

// ---------- IPC ----------
const handle = (name, fn) => ipcMain.handle(name, async (_e, ...args) => {
  try { return { ok: true, value: await fn(...args) }; } catch (err) {
    return { ok: false, error: err instanceof claude.LyricError ? err.message : String(err?.message || err) };
  }
});

handle('settings:get', () => ({ hasKey: !!getApiKey(), fromEnv: !readSettings().apiKeyEnc && !readSettings().apiKeyPlain && !!process.env.ANTHROPIC_API_KEY, model: claude.MODEL }));
handle('settings:setKey', (key) => {
  const s = readSettings();
  delete s.apiKeyEnc; delete s.apiKeyPlain;
  const k = String(key || '').trim();
  if (k) {
    if (safeStorage.isEncryptionAvailable()) s.apiKeyEnc = safeStorage.encryptString(k).toString('base64');
    else s.apiKeyPlain = k;
  }
  writeSettings(s);
  return { hasKey: !!getApiKey() };
});

handle('rhymes:find', (input, opts) => phon.findRhymes(input, opts || {}));
handle('phon:line', (text) => { const i = phon.lineInfo(text); return { syllables: i.syllables, pattern: i.pattern }; });
handle('phon:fit', (text, pattern) => phon.fitScore(text, pattern));
handle('phon:fitMany', (items) => items.map(([text, pattern]) => phon.fitScore(text, pattern)));
handle('phon:doRhyme', (a, b) => phon.doRhyme(a, b));

handle('ai:suggest', async (payload) => {
  const key = getApiKey();
  if (!key) throw new claude.LyricError('Add your Anthropic API key in Settings to get lyric suggestions.');
  return claude.suggest(key, payload);
});

const win = () => BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0];

handle('project:save', async (json, suggestedName) => {
  const { canceled, filePath } = await dialog.showSaveDialog(win(), {
    title: 'Save song',
    defaultPath: (suggestedName || 'Untitled') + '.pocketsong',
    filters: [{ name: 'Pocket Writer song', extensions: ['pocketsong'] }],
  });
  if (canceled || !filePath) return null;
  fs.writeFileSync(filePath, json);
  return filePath;
});

handle('project:open', async () => {
  const { canceled, filePaths } = await dialog.showOpenDialog(win(), {
    title: 'Open song',
    filters: [{ name: 'Pocket Writer song', extensions: ['pocketsong'] }],
    properties: ['openFile'],
  });
  if (canceled || !filePaths[0]) return null;
  return fs.readFileSync(filePaths[0], 'utf8');
});

handle('export:text', async (text, suggestedName) => {
  const { canceled, filePath } = await dialog.showSaveDialog(win(), {
    title: 'Export lyrics',
    defaultPath: (suggestedName || 'lyrics') + '.txt',
    filters: [{ name: 'Text', extensions: ['txt'] }],
  });
  if (canceled || !filePath) return null;
  fs.writeFileSync(filePath, text);
  return filePath;
});
