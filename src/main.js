const { app, BrowserWindow, ipcMain, dialog, Menu, protocol, net, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const { pathToFileURL } = require('url');
const { spawn } = require('child_process');
const gamedata = require('./gamedata');
const pkg = require('../package.json');

app.setPath('userData', process.env.FFP_USER_DATA || path.join(app.getPath('appData'), 'Factorio Flow Planner'));
protocol.registerSchemesAsPrivileged([{ scheme: 'ffp', privileges: { standard: true, secure: true, supportFetchAPI: true } }]);

const dataDir = () => path.join(app.getPath('userData'), 'gamedata');
const settingsFile = () => path.join(app.getPath('userData'), 'settings.json');
const readSettings = () => { try { return JSON.parse(fs.readFileSync(settingsFile(), 'utf8')); } catch { return {}; } };
const writeSettings = (s) => { fs.mkdirSync(path.dirname(settingsFile()), { recursive: true }); fs.writeFileSync(settingsFile(), JSON.stringify(s, null, 2)); };

let win = null;
let currentFile = null;
let dirty = false;

function updateTitle() {
  if (!win) return;
  const name = currentFile ? path.basename(currentFile) : 'Untitled';
  win.setTitle(`${dirty ? '• ' : ''}${name} — Factorio Flow Planner`);
}

function createWindow() {
  // Keep saving to the file used last time (the session itself is restored from the autosave).
  const last = readSettings().lastFile;
  if (last && fs.existsSync(last)) currentFile = last;
  win = new BrowserWindow({
    width: 1500, height: 920, minWidth: 900, minHeight: 600,
    backgroundColor: '#1f1d1b', show: false,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true, offscreen: !!process.env.FFP_DEV_SCRIPT },
  });
  // Automated checks (FFP_DEV_SCRIPT) render without ever showing or focusing a window.
  if (!process.env.FFP_DEV_SCRIPT) win.once('ready-to-show', () => win.show());
  win.webContents.on('did-finish-load', () => setTimeout(() => checkForUpdates(false), 2500));
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  win.webContents.setWindowOpenHandler(({ url }) => { if (/^https:\/\//.test(url)) shell.openExternal(url); return { action: 'deny' }; });
  win.on('close', (e) => {
    if (!dirty) return;
    const choice = dialog.showMessageBoxSync(win, {
      type: 'question', buttons: ['Save', "Don't save", 'Cancel'], defaultId: 0, cancelId: 2,
      message: 'Save changes to this factory before closing?',
    });
    if (choice === 2) e.preventDefault();
    else if (choice === 0) { e.preventDefault(); send('save-then-close'); }
  });
  updateTitle();
}

const send = (cmd) => win && win.webContents.send('menu', cmd);

function buildMenu() {
  const template = [
    { label: 'File', submenu: [
      { label: 'New factory', accelerator: 'CmdOrCtrl+N', click: () => send('new') },
      { label: 'Open…', accelerator: 'CmdOrCtrl+O', click: () => send('open') },
      { type: 'separator' },
      { label: 'Save', accelerator: 'CmdOrCtrl+S', click: () => send('save') },
      { label: 'Save as…', accelerator: 'CmdOrCtrl+Shift+S', click: () => send('saveAs') },
      { label: 'Show saved file in folder', click: () => send('showFile') },
      { type: 'separator' },
      { role: 'quit' },
    ] },
    { label: 'Edit', submenu: [
      { label: 'Undo', accelerator: 'CmdOrCtrl+Z', click: () => send('undo') },
      { label: 'Redo', accelerator: 'CmdOrCtrl+Y', click: () => send('redo') },
      { type: 'separator' },
      { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' },
    ] },
    { label: 'Factory', submenu: [
      { label: 'Plan production…', accelerator: 'CmdOrCtrl+P', click: () => send('plan') },
      { label: 'Add node… (Space)', click: () => send('add') },
      { label: 'Balance all machines', accelerator: 'CmdOrCtrl+B', click: () => send('balance') },
      { label: 'Arrange', accelerator: 'CmdOrCtrl+L', click: () => send('arrange') },
      { label: 'Fit view', accelerator: 'CmdOrCtrl+0', click: () => send('fit') },
    ] },
    { label: 'Game data', submenu: [
      { label: 'Import from Factorio…', click: () => send('import') },
      { label: 'Unlocked buildings…', click: () => send('buildings') },
      { label: 'Settings…', accelerator: 'CmdOrCtrl+,', click: () => send('settings') },
      { label: 'Open data folder', click: () => shell.openPath(app.getPath('userData')) },
    ] },
    { label: 'Help', submenu: [
      { label: 'Check for updates', click: () => checkForUpdates(true) },
      { label: 'About', click: () => dialog.showMessageBox(win, { type: 'info', message: `Factorio Flow Planner ${app.getVersion()}`, detail: githubRepo() ? `Project page: https://github.com/${githubRepo()}` : '' }) },
      ...(githubRepo() ? [{ label: 'Project page on GitHub', click: () => shell.openExternal(`https://github.com/${githubRepo()}`) }] : []),
    ] },
    { label: 'View', submenu: [
      { role: 'reload' }, { role: 'toggleDevTools' }, { type: 'separator' },
      { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }, { type: 'separator' }, { role: 'togglefullscreen' },
    ] },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

/* ---------- Updates ---------- */
// New versions are built into the project's dist folder on this PC. The app looks there for a newer installer,
// and on request runs it silently (NSIS /S) and starts again afterwards (--force-run).
// Updates come from the project's GitHub releases; a local folder (settings.json "updateDir") is also checked,
// which is how new builds reach the developer's own PC before they are published.
const updateDir = () => process.env.FFP_UPDATE_DIR || readSettings().updateDir || pkg.updateDir;
const githubRepo = () => process.env.FFP_GITHUB_REPO || pkg.githubRepo;
const isNewer = (a, b) => {
  const x = a.split('.').map(Number), y = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0);
  return false;
};
let pendingUpdate = null;
function findUpdate() {
  const dir = updateDir();
  if (!dir || !fs.existsSync(dir)) return null;
  let best = null;
  for (const f of fs.readdirSync(dir)) {
    const m = f.match(/^Factorio Flow Planner Setup (\d+\.\d+\.\d+)\.exe$/);
    if (m && isNewer(m[1], app.getVersion()) && (!best || isNewer(m[1], best.version))) best = { version: m[1], path: path.join(dir, f) };
  }
  return best;
}
async function findGithubUpdate() {
  const repo = githubRepo();
  if (!repo) return null;
  const res = await net.fetch(`https://api.github.com/repos/${repo}/releases/latest`, { headers: { 'User-Agent': 'factorio-flow-planner', Accept: 'application/vnd.github+json' } });
  if (!res.ok) return null;
  const rel = await res.json();
  const v = String(rel.tag_name || '').replace(/^v/i, '');
  if (!/^\d+\.\d+\.\d+$/.test(v) || !isNewer(v, app.getVersion())) return null;
  const asset = (rel.assets || []).find((a) => /\.exe$/i.test(a.name));
  return asset ? { version: v, url: asset.browser_download_url, name: asset.name } : null;
}
let lastRemoteCheck = 0;
async function checkForUpdates(manual) {
  if (!win) return;
  if (!app.isPackaged && !process.env.FFP_UPDATE_DIR && !process.env.FFP_GITHUB_REPO) { if (manual) win.webContents.send('update', 'dev', app.getVersion()); return; }
  let u = null;
  try { u = findUpdate(); } catch {}
  // GitHub allows about 60 checks an hour without an account, so ask it at most every 30 minutes unless asked by hand.
  if (!u && (manual || Date.now() - lastRemoteCheck > 30 * 60 * 1000)) {
    lastRemoteCheck = Date.now();
    try { u = await findGithubUpdate(); } catch {}
  }
  if (u) { pendingUpdate = u; win.webContents.send('update', 'available', u.version); }
  else if (manual) win.webContents.send('update', 'none', app.getVersion());
}
setInterval(() => checkForUpdates(false), 5 * 60 * 1000);
ipcMain.handle('app:version', () => app.getVersion());
ipcMain.on('update:check', () => checkForUpdates(true));
ipcMain.on('update:install', async () => {
  if (!pendingUpdate) return;
  if (pendingUpdate.url && !pendingUpdate.path) {
    // Download the installer from GitHub first.
    try {
      win.webContents.send('update', 'downloading', pendingUpdate.version);
      const res = await net.fetch(pendingUpdate.url, { headers: { 'User-Agent': 'factorio-flow-planner' } });
      if (!res.ok) throw new Error(`download failed (${res.status})`);
      const dir = path.join(app.getPath('temp'), 'factorio-flow-planner-update');
      fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, pendingUpdate.name);
      fs.writeFileSync(file, Buffer.from(await res.arrayBuffer()));
      pendingUpdate.path = file;
    } catch (err) {
      win.webContents.send('update', 'failed', err.message);
      return;
    }
  }
  if (!pendingUpdate.path || !fs.existsSync(pendingUpdate.path)) return;
  const child = spawn(pendingUpdate.path, ['/S', '--force-run'], { detached: true, stdio: 'ignore' });
  child.on('error', (err) => win && win.webContents.send('update', 'failed', err.message));
  // Only close once the installer is actually running; it replaces the app and starts it again.
  child.on('spawn', () => { child.unref(); dirty = false; app.quit(); });
});

/* ---------- IPC ---------- */

ipcMain.handle('gamedata:load', () => gamedata.loadModel(dataDir()));

ipcMain.handle('factorio:detect', () => {
  const s = readSettings();
  return gamedata.detectFactorio(s.factorioExe);
});

ipcMain.handle('factorio:browse', async () => {
  const r = await dialog.showOpenDialog(win, { title: 'Find factorio.exe', properties: ['openFile'], filters: [{ name: 'Factorio', extensions: ['exe'] }] });
  if (r.canceled || !r.filePaths[0]) return null;
  writeSettings({ ...readSettings(), factorioExe: r.filePaths[0] });
  return r.filePaths[0];
});

ipcMain.handle('gamedata:import', async (_e, exe) => {
  const progress = (m) => win && win.webContents.send('import:progress', m);
  try {
    const model = await gamedata.importFromFactorio(exe, dataDir(), progress);
    writeSettings({ ...readSettings(), factorioExe: exe });
    return { ok: true, model };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('gamedata:importDump', async () => {
  const r = await dialog.showOpenDialog(win, { title: 'Choose data-raw-dump.json', properties: ['openFile'], filters: [{ name: 'Factorio data dump', extensions: ['json'] }] });
  if (r.canceled || !r.filePaths[0]) return { ok: false, canceled: true };
  const progress = (m) => win && win.webContents.send('import:progress', m);
  const exe = gamedata.detectFactorio(readSettings().factorioExe);
  try {
    const dirs = exe ? [path.join(gamedata.installDirOf(exe), 'data'), path.join(process.env.APPDATA || '', 'Factorio', 'mods')] : [];
    const model = await gamedata.importFromDump(r.filePaths[0], dirs, dataDir(), progress);
    return { ok: true, model };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

// Save never asks: the first save of a factory goes to Documents\Factorio Flow Planner\<name>.ffp.json.
// Only "Save as" opens the file window.
const savesDir = () => process.env.FFP_SAVES_DIR || path.join(app.getPath('documents'), 'Factorio Flow Planner');
function defaultSavePath(name) {
  const base = (String(name || 'Factory').replace(/[<>:"/\|?*\u0000-\u001f]/g, '').trim() || 'Factory').slice(0, 80);
  fs.mkdirSync(savesDir(), { recursive: true });
  let p = path.join(savesDir(), base + '.ffp.json');
  for (let i = 2; fs.existsSync(p); i++) p = path.join(savesDir(), `${base} (${i}).ffp.json`);
  return p;
}
function rememberFile(p) {
  currentFile = p;
  writeSettings({ ...readSettings(), lastFile: p || null });
}
ipcMain.handle('file:save', async (_e, json, saveAs, name) => {
  let target = currentFile && fs.existsSync(path.dirname(currentFile)) ? currentFile : null;
  let fresh = false;
  if (saveAs) {
    const r = await dialog.showSaveDialog(win, { title: 'Save factory as', defaultPath: target || path.join(savesDir(), (name || 'factory') + '.ffp.json'), filters: [{ name: 'Factory layout', extensions: ['ffp.json', 'json'] }] });
    if (r.canceled || !r.filePath) return null;
    target = r.filePath;
  } else if (!target) { target = defaultSavePath(name); fresh = true; }
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, json);
  rememberFile(target);
  dirty = false;
  updateTitle();
  return { path: target, fresh };
});

ipcMain.handle('file:open', async () => {
  const r = await dialog.showOpenDialog(win, { title: 'Open factory', properties: ['openFile'], filters: [{ name: 'Factory layout', extensions: ['json'] }] });
  if (r.canceled || !r.filePaths[0]) return null;
  const text = fs.readFileSync(r.filePaths[0], 'utf8');
  rememberFile(r.filePaths[0]);
  dirty = false;
  updateTitle();
  return { path: currentFile, text };
});

ipcMain.on('file:new', () => { rememberFile(null); dirty = false; updateTitle(); });
ipcMain.on('file:show', () => { if (currentFile && fs.existsSync(currentFile)) shell.showItemInFolder(currentFile); else shell.openPath(savesDir()); });
ipcMain.on('dirty', (_e, d) => { if (dirty !== !!d) { dirty = !!d; updateTitle(); } });
ipcMain.on('close-now', () => { dirty = false; win && win.close(); });

/* ---------- Startup ---------- */

app.whenReady().then(() => {
  protocol.handle('ffp', (req) => {
    const u = new URL(req.url);
    const base = path.join(dataDir(), 'icons');
    const p = path.normalize(path.join(base, decodeURIComponent(u.pathname)));
    if (!p.startsWith(base) || !fs.existsSync(p)) return new Response('', { status: 404 });
    return net.fetch(pathToFileURL(p).toString());
  });
  buildMenu();
  createWindow();
  if (process.env.FFP_DEV_SCRIPT) devRun(process.env.FFP_DEV_SCRIPT, process.env.FFP_DEV_SHOT);
});

// Developer hook: run a script in the page, save a screenshot, quit. Used for automated checks.
function devRun(scriptPath, shotPath) {
  win.webContents.once('did-finish-load', async () => {
    await new Promise((r) => setTimeout(r, 1500));
    try {
      const out = await win.webContents.executeJavaScript(fs.readFileSync(scriptPath, 'utf8'));
      console.log('DEV-RESULT ' + JSON.stringify(out));
    } catch (err) {
      console.log('DEV-ERROR ' + err.message);
    }
    await new Promise((r) => setTimeout(r, 1200));
    if (shotPath) fs.writeFileSync(shotPath, (await win.webContents.capturePage()).toPNG());
    dirty = false;
    app.quit();
  });
}

app.on('window-all-closed', () => app.quit());
