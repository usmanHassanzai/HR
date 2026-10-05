/**
 * Scorr Desktop — Electron shell.
 * Loads the same app Sign In UI as mobile (?app=1): no marketing site chrome.
 */
const { app, BrowserWindow, shell, session, ipcMain } = require('electron');
const path = require('path');

const APP_URL =
  process.env.SCORR_DESKTOP_URL || 'https://scorr.walfia.ai/?app=1';

const LOGIN_SIZE = { width: 480, height: 780 };
const WORKSPACE_SIZE = { width: 1280, height: 840 };

/** @type {BrowserWindow | null} */
let mainWindow = null;
let workspaceExpanded = false;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: LOGIN_SIZE.width,
    height: LOGIN_SIZE.height,
    minWidth: 400,
    minHeight: 640,
    title: 'Scorr',
    icon: path.join(__dirname, 'icon.png'),
    backgroundColor: '#f1f5f9',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
    show: false,
  });

  // Identify this client as the desktop app shell (mirrors Capacitor / ?app=1).
  const ses = mainWindow.webContents.session;
  ses.setUserAgent(`${ses.getUserAgent()} ScorrDesktop/1.0`);

  mainWindow.once('ready-to-show', () => {
    mainWindow?.show();
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: 'deny' };
  });

  void mainWindow.loadURL(APP_URL);

  mainWindow.on('closed', () => {
    mainWindow = null;
    workspaceExpanded = false;
  });
}

function expandToWorkspace() {
  if (!mainWindow || mainWindow.isDestroyed() || workspaceExpanded) return;
  workspaceExpanded = true;
  const { width, height } = WORKSPACE_SIZE;
  mainWindow.setMinimumSize(900, 640);
  mainWindow.setSize(width, height, true);
  mainWindow.center();
}

function shrinkToLogin() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  workspaceExpanded = false;
  mainWindow.setMinimumSize(400, 640);
  mainWindow.setSize(LOGIN_SIZE.width, LOGIN_SIZE.height, true);
  mainWindow.center();
}

app.whenReady().then(() => {
  session.defaultSession.setPermissionRequestHandler((_wc, permission, callback) => {
    const allow = permission === 'geolocation' || permission === 'notifications';
    callback(allow);
  });

  ipcMain.on('scorr:workspace', () => expandToWorkspace());
  ipcMain.on('scorr:login', () => shrinkToLogin());

  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
