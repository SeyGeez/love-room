'use strict';
const path = require('node:path');
const { app, BrowserWindow, Tray, Menu, nativeImage, screen, ipcMain, shell } = require('electron');
const { Store, CORNERS, isServerUrl } = require('./store');
const { RelayClient } = require('./net');
const { resolveGifUrl } = require('./resolve');
const { normalizeCode, formatCode, validateGif, MAX_FILE_BYTES } = require('./protocol');

const OVERLAY_SIZE = { width: 360, height: 300 };
const OVERLAY_MARGIN = 16;
const FADE_MS = 450;
const ICON = path.join(__dirname, '../assets/icon.png');
const TEST_SVG =
  'data:image/svg+xml;base64,' +
  Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><g transform="translate(50 50)"><g><animateTransform attributeName="transform" type="scale" values="1;1.15;1" dur="0.8s" repeatCount="indefinite"/><path transform="translate(-50 -50)" fill="#ff4d7d" d="M50 88C20 62 8 46 8 31 8 19 17 11 28 11c8 0 17 5 22 13 5-8 14-13 22-13 11 0 20 8 20 20 0 15-12 31-42 57z"/></g></g></svg>`,
  ).toString('base64');

let store;
let relay;
let panel = null;
let overlay = null;
let tray = null;
let quitting = false;
const live = { connection: 'offline', pair: 'unpaired', lastError: null };
const queue = [];
let showing = false;

// ---------- état partagé avec le panneau ----------
function snapshot() {
  const c = store.get();
  return {
    code: formatCode(c.code),
    partner: c.partner ? formatCode(c.partner) : null,
    serverUrl: c.serverUrl,
    corner: c.corner,
    durationSec: c.durationSec,
    dnd: c.dnd,
    openAtLogin: c.openAtLogin,
    canAutoStart: process.platform === 'win32' || process.platform === 'darwin',
    connection: live.connection,
    pair: live.pair,
    error: live.lastError,
  };
}

function pushState() {
  if (panel && !panel.isDestroyed()) panel.webContents.send('state', snapshot());
  rebuildTrayMenu();
}

// ---------- overlay ----------
function overlayBounds() {
  const { workArea } = screen.getPrimaryDisplay();
  const { corner } = store.get();
  const right = corner.endsWith('right');
  const bottom = corner.startsWith('bottom');
  return {
    ...OVERLAY_SIZE,
    x: right ? workArea.x + workArea.width - OVERLAY_SIZE.width - OVERLAY_MARGIN : workArea.x + OVERLAY_MARGIN,
    y: bottom ? workArea.y + workArea.height - OVERLAY_SIZE.height - OVERLAY_MARGIN : workArea.y + OVERLAY_MARGIN,
  };
}

function createOverlay() {
  overlay = new BrowserWindow({
    ...overlayBounds(),
    show: false,
    frame: false,
    transparent: true,
    resizable: false,
    movable: false,
    focusable: false,
    skipTaskbar: true,
    hasShadow: false,
    alwaysOnTop: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  });
  overlay.setIgnoreMouseEvents(true); // les clics traversent la fenêtre
  overlay.setAlwaysOnTop(true, 'screen-saver'); // au-dessus des applis plein écran / jeux
  overlay.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  overlay.loadFile(path.join(__dirname, '../renderer/overlay.html'));
  overlay.webContents.on('will-navigate', (e) => e.preventDefault());
  overlay.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
}

function enqueue(src) {
  if (store.get().dnd) return;
  queue.push(src);
  if (queue.length > 5) queue.shift(); // ne jamais accumuler un retard énorme
  pump();
}

function pump() {
  if (showing || queue.length === 0 || !overlay || overlay.isDestroyed()) return;
  showing = true;
  const src = queue.shift();
  overlay.setBounds(overlayBounds());
  overlay.showInactive();
  overlay.setAlwaysOnTop(true, 'screen-saver');
  overlay.webContents.send('overlay:show', { src });
  setTimeout(() => {
    if (overlay.isDestroyed()) return;
    overlay.webContents.send('overlay:hide');
    setTimeout(() => {
      if (overlay.isDestroyed()) return;
      overlay.hide();
      showing = false;
      pump();
    }, FADE_MS + 50);
  }, store.get().durationSec * 1000);
}

function gifToSrc(gif) {
  return gif.kind === 'url' ? gif.url : `data:${gif.mime};base64,${gif.data}`;
}

// ---------- panneau de contrôle ----------
function createPanel() {
  panel = new BrowserWindow({
    width: 460,
    height: 720,
    minWidth: 400,
    minHeight: 520,
    title: 'Love Room',
    icon: ICON,
    show: false,
    backgroundColor: '#1b1620',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  });
  panel.loadFile(path.join(__dirname, '../renderer/panel.html'));
  panel.once('ready-to-show', () => panel.show());
  panel.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https:\/\//.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  panel.webContents.on('will-navigate', (e) => e.preventDefault());
  panel.on('close', (e) => {
    // Win/macOS : l'appli reste active dans la zone de notification pour recevoir les GIF.
    if (!quitting && process.platform !== 'linux') {
      e.preventDefault();
      panel.hide();
    }
  });
}

function showPanel() {
  if (!panel || panel.isDestroyed()) createPanel();
  else panel.show();
  panel.focus();
}

// ---------- tray ----------
function rebuildTrayMenu() {
  if (!tray) return;
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: 'Ouvrir Love Room', click: showPanel },
      {
        label: 'Ne pas déranger',
        type: 'checkbox',
        checked: store.get().dnd,
        click: (item) => applySettings({ dnd: item.checked }),
      },
      { type: 'separator' },
      {
        label: 'Quitter',
        click: () => {
          quitting = true;
          app.quit();
        },
      },
    ]),
  );
}

function createTray() {
  const size = process.platform === 'darwin' ? 18 : 16;
  tray = new Tray(nativeImage.createFromPath(ICON).resize({ width: size, height: size }));
  tray.setToolTip('Love Room');
  tray.on('click', showPanel);
  rebuildTrayMenu();
}

// ---------- réseau ----------
function startRelay() {
  const c = store.get();
  relay.start({ url: c.serverUrl, code: c.code, secret: c.secret, partner: c.partner });
}

function setupRelay() {
  relay = new RelayClient();
  relay.on('connection', (state) => {
    live.connection = state;
    if (state === 'online') live.lastError = null;
    if (state !== 'online') live.pair = store.get().partner ? 'waiting' : 'unpaired';
    pushState();
  });
  relay.on('status', ({ state }) => {
    live.pair = state;
    pushState();
  });
  relay.on('server-error', (code) => {
    live.lastError = code;
    pushState();
  });
  relay.on('gif', (msg) => {
    const checked = validateGif(msg); // on ne fait jamais confiance au serveur
    if (checked.ok) enqueue(gifToSrc(checked.gif));
  });
}

function applySettings(patch) {
  const before = store.get();
  const next = {};
  if (typeof patch.serverUrl === 'string' && isServerUrl(patch.serverUrl.trim())) next.serverUrl = patch.serverUrl.trim();
  if (CORNERS.includes(patch.corner)) next.corner = patch.corner;
  if (typeof patch.durationSec === 'number') next.durationSec = patch.durationSec;
  if (typeof patch.dnd === 'boolean') next.dnd = patch.dnd;
  if (typeof patch.openAtLogin === 'boolean') next.openAtLogin = patch.openAtLogin;
  const after = store.update(next);

  if (after.openAtLogin !== before.openAtLogin && (process.platform === 'win32' || process.platform === 'darwin')) {
    app.setLoginItemSettings({ openAtLogin: after.openAtLogin });
  }
  if (after.serverUrl !== before.serverUrl) startRelay();
  pushState();
}

const ERROR_TEXT = {
  offline: "Pas de connexion au serveur.",
  timeout: "Le serveur n'a pas répondu.",
  not_paired: "L'autre personne ne t'a pas encore ajouté·e (ou elle est hors ligne).",
  rate_limited: 'Doucement ! Trop de GIF envoyés d\'un coup.',
  bad_url: 'Lien non pris en charge. Utilise un lien Giphy, Tenor ou Imgur.',
  bad_gif: "Ce fichier n'est pas une image valide.",
  too_big: `Fichier trop gros (max ${MAX_FILE_BYTES / 1024 / 1024} Mo).`,
};

async function sendGif(gif) {
  const checked = validateGif(gif);
  if (!checked.ok) return { ok: false, error: ERROR_TEXT[checked.reason] || ERROR_TEXT.bad_gif };
  try {
    await relay.sendGif(checked.gif);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: ERROR_TEXT[err.message] || 'Envoi impossible.' };
  }
}

// ---------- IPC ----------
function setupIpc() {
  ipcMain.handle('state:get', () => snapshot());

  ipcMain.handle('partner:set', (_e, raw) => {
    const code = normalizeCode(raw);
    if (!code) return { ok: false, error: 'Code invalide (10 caractères, ex. ABCDE-FGHJK).' };
    if (code === store.get().code) return { ok: false, error: "C'est ton propre code !" };
    store.update({ partner: code });
    relay.pair(code);
    live.pair = 'waiting';
    pushState();
    return { ok: true };
  });

  ipcMain.handle('partner:clear', () => {
    store.update({ partner: null });
    relay.unpair();
    live.pair = 'unpaired';
    pushState();
    return { ok: true };
  });

  ipcMain.handle('settings:set', (_e, patch) => {
    if (patch && typeof patch === 'object') applySettings(patch);
    return snapshot();
  });

  ipcMain.handle('gif:send-url', async (_e, input) => {
    const url = await resolveGifUrl(input);
    if (!url) return { ok: false, error: ERROR_TEXT.bad_url };
    return sendGif({ kind: 'url', url });
  });

  ipcMain.handle('gif:send-file', (_e, file) => {
    if (!file || typeof file.data !== 'string') return { ok: false, error: ERROR_TEXT.bad_gif };
    return sendGif({ kind: 'data', data: file.data });
  });

  ipcMain.handle('overlay:test', () => {
    const was = store.get().dnd;
    if (was) return { ok: false, error: 'Le mode « Ne pas déranger » est activé.' };
    enqueue(TEST_SVG);
    return { ok: true };
  });
}

// ---------- démarrage ----------
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', showPanel);
  app.setAppUserModelId('app.loveroom.desktop'); // nécessaire pour les notifications / icône Windows

  app.whenReady().then(() => {
    if (process.platform !== 'darwin') Menu.setApplicationMenu(null);
    store = new Store(app.getPath('userData'));
    setupRelay();
    setupIpc();
    createOverlay();
    createTray();
    createPanel();
    startRelay();
    screen.on('display-metrics-changed', () => overlay && !overlay.isDestroyed() && overlay.setBounds(overlayBounds()));
  });

  app.on('before-quit', () => (quitting = true));
  app.on('activate', showPanel);
  app.on('window-all-closed', () => {
    // Le tray garde l'appli en vie ; sur Linux la fermeture du panneau quitte.
    if (process.platform === 'linux') app.quit();
  });
}
