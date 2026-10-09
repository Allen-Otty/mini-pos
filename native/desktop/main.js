// Dogo POS desktop shell. Serves the bundled web app from a stable app:// origin,
// so localStorage / offline data persists between launches and works with no internet.
const { app, BrowserWindow, protocol, net, shell, session } = require('electron');
const path = require('path');
const fs = require('fs');
const { pathToFileURL } = require('url');

protocol.registerSchemesAsPrivileged([
  { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true } }
]);

const wwwRoot = app.isPackaged
  ? path.join(process.resourcesPath, 'www')
  : path.join(__dirname, '..', 'www');

function resolveFile(requestUrl) {
  let p = decodeURIComponent(new URL(requestUrl).pathname);
  if (p === '/' || p === '') p = '/index.html';
  if (p === '/admin' || p === '/admin/') p = '/admin/index.html';
  let file = path.normalize(path.join(wwwRoot, p));
  if (!file.startsWith(wwwRoot)) return null;
  if (fs.existsSync(file) && fs.statSync(file).isDirectory()) file = path.join(file, 'index.html');
  return file;
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    autoHideMenuBar: true,
    title: 'Dogo POS',
    icon: path.join(__dirname, 'build', 'icon.png'),
    webPreferences: { contextIsolation: true, nodeIntegration: false }
  });
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('app://') || url === 'about:blank') return { action: 'allow' };
    if (/^https?:/i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.loadURL('app://dogo/index.html');
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    const [w] = BrowserWindow.getAllWindows();
    if (w) { if (w.isMinimized()) w.restore(); w.focus(); }
  });
  app.whenReady().then(() => {
    protocol.handle('app', (req) => {
      const file = resolveFile(req.url);
      if (!file || !fs.existsSync(file)) return new Response('Not found', { status: 404 });
      return net.fetch(pathToFileURL(file).toString());
    });
    session.defaultSession.setPermissionRequestHandler((_wc, permission, cb) =>
      cb(['media', 'notifications', 'fullscreen', 'clipboard-sanitized-write'].includes(permission)));
    createWindow();
    app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
  });
  app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
}
