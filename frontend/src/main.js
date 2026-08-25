'use strict';

const { app, BrowserWindow, ipcMain, net, protocol, session } = require('electron');
const fs = require('node:fs/promises');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const APP_ORIGIN = 'app://viewer';
let recordingAuthorizationExpiresAt = 0;
const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data: blob:",
  "media-src 'self' blob:",
  "connect-src 'self' blob: ws://127.0.0.1:8765",
  "object-src 'none'",
  "base-uri 'none'",
  "frame-ancestors 'none'"
].join('; ');

function isTrustedAppUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'app:' && url.hostname === 'viewer';
  } catch {
    return false;
  }
}

protocol.registerSchemesAsPrivileged([
  {
    scheme: 'app',
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: true,
      stream: true
    }
  }
]);

async function registerAppProtocol() {
  const publicRoot = path.join(__dirname, 'renderer');

  protocol.handle('app', async (request) => {
    const url = new URL(request.url);
    if (url.host !== 'viewer') {
      return new Response('Not found', { status: 404 });
    }

    const pathname = decodeURIComponent(url.pathname);
    const routes = new Map([
      ['/', path.join(publicRoot, 'index.html')],
      ['/index.html', path.join(publicRoot, 'index.html')],
      ['/styles.css', path.join(publicRoot, 'styles.css')],
      ['/boot.js', path.join(__dirname, 'boot.js')],
      ['/renderer.bundle.js', path.join(__dirname, '..', 'generated', 'renderer.bundle.js')]
    ]);
    const filePath = routes.get(pathname);

    if (!filePath) {
      return new Response('Not found', { status: 404 });
    }

    return net.fetch(pathToFileURL(filePath).toString());
  });
}

function installPermissionGuards() {
  const isTrustedRequest = (webContents, ...candidateUrls) => {
    return candidateUrls.some((value) => value && isTrustedAppUrl(value))
      || Boolean(webContents && isTrustedAppUrl(webContents.getURL()));
  };

  session.defaultSession.setPermissionCheckHandler((webContents, permission, requestingOrigin, details) => {
    const localMedia = permission === 'media'
      && (details.mediaType === 'video' || details.mediaType === 'audio');
    const displayCapture = permission === 'display-capture';
    return (localMedia || displayCapture) && isTrustedRequest(
      webContents,
      requestingOrigin,
      details.securityOrigin,
      details.requestingUrl
    );
  });

  session.defaultSession.setPermissionRequestHandler((webContents, permission, callback, details) => {
    const requestedMedia = details.mediaTypes ?? [];
    const localMedia = permission === 'media'
      && requestedMedia.length > 0
      && requestedMedia.every((mediaType) => mediaType === 'video' || mediaType === 'audio');
    const displayCapture = permission === 'display-capture';
    callback((localMedia || displayCapture) && isTrustedRequest(webContents, details.securityOrigin));
  });

  session.defaultSession.setDisplayMediaRequestHandler((request, callback) => {
    const trustedSource = isTrustedAppUrl(request.securityOrigin)
      || isTrustedAppUrl(request.frame?.url);
    const trusted = Date.now() <= recordingAuthorizationExpiresAt
      && request.videoRequested
      && !request.audioRequested
      && request.frame
      && trustedSource;
    recordingAuthorizationExpiresAt = 0;
    callback(trusted ? { video: request.frame } : {});
  });
}

function installSecurityHeaders() {
  session.defaultSession.webRequest.onHeadersReceived(
    { urls: [`${APP_ORIGIN}/*`] },
    (details, callback) => {
      callback({
        responseHeaders: {
          ...details.responseHeaders,
          'Content-Security-Policy': [CSP],
          'X-Content-Type-Options': ['nosniff'],
          'Referrer-Policy': ['no-referrer'],
          'Permissions-Policy': ['camera=(self), microphone=(self)']
        }
      });
    }
  );
}

function createWindow() {
  const window = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true
    }
  });

  window.removeMenu();
  window.once('ready-to-show', () => window.show());
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', (event, targetUrl) => {
    if (!targetUrl.startsWith(`${APP_ORIGIN}/`)) event.preventDefault();
  });
  void window.loadURL(`${APP_ORIGIN}/index.html`);
}

app.whenReady().then(async () => {
  await registerAppProtocol();
  installSecurityHeaders();
  installPermissionGuards();

  ipcMain.handle('app:get-runtime-info', () => Object.freeze({
    platform: process.platform,
    backendUrl: 'ws://127.0.0.1:8765/ws'
  }));

  ipcMain.handle('recording:authorize', (event) => {
    const senderUrl = event.senderFrame?.url || event.sender.getURL();
    if (!isTrustedAppUrl(senderUrl)) throw new Error('Untrusted recording authorization');
    recordingAuthorizationExpiresAt = Date.now() + 5000;
    return true;
  });

  ipcMain.handle('recording:save', async (event, arrayBuffer) => {
    const senderUrl = event.senderFrame?.url || event.sender.getURL();
    if (!isTrustedAppUrl(senderUrl)) {
      throw new Error('Untrusted recording save request');
    }
    if (!(arrayBuffer instanceof ArrayBuffer)) throw new TypeError('Recording must be an ArrayBuffer');
    const bytes = Buffer.from(arrayBuffer);
    if (bytes.length === 0 || bytes.length > 500 * 1024 * 1024) {
      throw new RangeError('Recording size must be between 1 byte and 500 MB');
    }

    const outputDirectory = path.join(app.getPath('videos'), 'Gesture 3D Viewer');
    await fs.mkdir(outputDirectory, { recursive: true });
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const outputPath = path.join(outputDirectory, `gesture-3d-${timestamp}.webm`);
    await fs.writeFile(outputPath, bytes, { flag: 'wx' });
    return Object.freeze({ path: outputPath, bytes: bytes.length });
  });

  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
