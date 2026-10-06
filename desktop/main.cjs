/**
 * Electron laptop automatic attendance (Section H / R45–R53).
 * powerMonitor suspend/resume/shutdown + 5-min heartbeat during W.
 * Uses device token from safeStorage; no dashboard session required after enrollment.
 */
const {
  app,
  BrowserWindow,
  shell,
  session,
  ipcMain,
  Tray,
  Menu,
  nativeImage,
  Notification,
  powerMonitor,
  safeStorage,
} = require('electron');
const path = require('path');
const fs = require('fs');
const { net } = require('electron');

const APP_URL = process.env.SCORR_DESKTOP_URL || 'https://scorr.walfia.ai/?app=1';
const SUPABASE_URL = process.env.SCORR_SUPABASE_URL || 'https://yvnbxweitelowucdhwpg.supabase.co';
const SUPABASE_ANON =
  process.env.SCORR_SUPABASE_ANON ||
  process.env.VITE_SUPABASE_ANON_KEY ||
  '';

const LOGIN_SIZE = { width: 480, height: 780 };
const WORKSPACE_SIZE = { width: 1280, height: 840 };
const TOKEN_FILE = () => path.join(app.getPath('userData'), 'attendance-token.bin');
const DEVICE_ID_FILE = () => path.join(app.getPath('userData'), 'attendance-device-id.txt');
const SCHEDULE_FILE = () => path.join(app.getPath('userData'), 'attendance-schedule.json');

/** @type {BrowserWindow | null} */
let mainWindow = null;
let tray = null;
let workspaceExpanded = false;
let heartbeatTimer = null;
let scheduleSyncTimer = null;
/** @type {any} */
let cachedSchedule = null;

function platformName() {
  return process.platform === 'win32' ? 'windows' : 'linux';
}

function deviceId() {
  try {
    if (fs.existsSync(DEVICE_ID_FILE())) return fs.readFileSync(DEVICE_ID_FILE(), 'utf8').trim();
  } catch {
    /* ignore */
  }
  const id = require('crypto').randomUUID();
  fs.writeFileSync(DEVICE_ID_FILE(), id, 'utf8');
  return id;
}

function saveToken(plaintext) {
  if (!plaintext) return;
  try {
    if (safeStorage.isEncryptionAvailable()) {
      const buf = safeStorage.encryptString(String(plaintext));
      fs.writeFileSync(TOKEN_FILE(), buf);
      return;
    }
  } catch {
    /* fall through */
  }
  fs.writeFileSync(TOKEN_FILE() + '.txt', String(plaintext), 'utf8');
}

function loadToken() {
  try {
    if (fs.existsSync(TOKEN_FILE()) && safeStorage.isEncryptionAvailable()) {
      return safeStorage.decryptString(fs.readFileSync(TOKEN_FILE()));
    }
    if (fs.existsSync(TOKEN_FILE() + '.txt')) {
      return fs.readFileSync(TOKEN_FILE() + '.txt', 'utf8').trim();
    }
  } catch {
    /* ignore */
  }
  return null;
}

function clearToken() {
  try {
    if (fs.existsSync(TOKEN_FILE())) fs.unlinkSync(TOKEN_FILE());
    if (fs.existsSync(TOKEN_FILE() + '.txt')) fs.unlinkSync(TOKEN_FILE() + '.txt');
  } catch {
    /* ignore */
  }
}

function notify(title, body) {
  try {
    if (Notification.isSupported()) {
      new Notification({ title, body }).show();
    }
  } catch {
    /* ignore */
  }
}

function httpJson(url, { method = 'POST', headers = {}, body } = {}) {
  return new Promise((resolve) => {
    try {
      const request = net.request({ method, url });
      Object.entries(headers).forEach(([k, v]) => request.setHeader(k, v));
      let data = '';
      request.on('response', (response) => {
        response.on('data', (chunk) => {
          data += chunk.toString();
        });
        response.on('end', () => {
          try {
            resolve(JSON.parse(data || '{}'));
          } catch {
            resolve({ ok: false, reason: 'bad_json', raw: data });
          }
        });
      });
      request.on('error', (err) => resolve({ ok: false, reason: String(err) }));
      if (body) request.write(typeof body === 'string' ? body : JSON.stringify(body));
      request.end();
    } catch (e) {
      resolve({ ok: false, reason: String(e) });
    }
  });
}

async function syncSchedule() {
  const token = loadToken();
  if (!token || !SUPABASE_ANON) return null;
  const data = await httpJson(`${SUPABASE_URL}/functions/v1/attendance-schedule`, {
    method: 'POST',
    headers: {
      apikey: SUPABASE_ANON,
      'Content-Type': 'application/json',
      'x-device-token': token,
    },
    body: { device_token: token },
  });
  if (data?.ok) {
    cachedSchedule = data;
    try {
      fs.writeFileSync(SCHEDULE_FILE(), JSON.stringify(data), 'utf8');
    } catch {
      /* ignore */
    }
  }
  return data;
}

function serverCorrectedNowMs(schedule) {
  if (!schedule?.server_now_utc) return Date.now();
  const serverMs = Date.parse(schedule.server_now_utc);
  if (Number.isNaN(serverMs)) return Date.now();
  // Assume schedule fetched recently; use server_now as baseline + elapsed
  return serverMs;
}

function activeWindow(schedule, nowMs) {
  const windows = schedule?.windows || [];
  for (const w of windows) {
    const start = Date.parse(w.window_start_utc);
    const end = Date.parse(w.window_end_utc);
    if (!Number.isNaN(start) && !Number.isNaN(end) && nowMs >= start && nowMs <= end) {
      return w;
    }
  }
  return null;
}

async function sendEvent(event) {
  const token = loadToken();
  if (!token || !SUPABASE_ANON) return null;
  const now = Date.now();
  const res = await httpJson(`${SUPABASE_URL}/functions/v1/auto-attendance-event`, {
    method: 'POST',
    headers: {
      apikey: SUPABASE_ANON,
      'Content-Type': 'application/json',
      'x-device-token': token,
    },
    body: {
      device_token: token,
      event,
      occurred_at_utc_ms: now,
      device_now_utc_ms: now,
      device_timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      device_id: deviceId(),
      platform: platformName(),
      app_version: app.getVersion(),
    },
  });

  if (res?.action === 'clock_in') {
    notify('Scorr', 'Checked in (laptop)');
  } else if (res?.action === 'clock_out') {
    notify('Scorr', 'Checked out (laptop)');
  }
  if (res?.stop_tracking) {
    stopHeartbeat();
  }
  if (res?.reason === 'schedule_changed') {
    await syncSchedule();
  }
  return res;
}

function stopHeartbeat() {
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
}

function startHeartbeatIfInWindow() {
  stopHeartbeat();
  const sched = cachedSchedule;
  if (!sched) return;
  const nowMs = Date.now();
  const win = activeWindow(sched, nowMs);
  if (!win) return;

  // Immediate present signal
  void sendEvent('power_on');
  heartbeatTimer = setInterval(() => {
    const w = activeWindow(cachedSchedule, Date.now());
    if (!w) {
      stopHeartbeat();
      return;
    }
    void sendEvent('heartbeat');
  }, 5 * 60 * 1000);
}

function armScheduleLoop() {
  if (scheduleSyncTimer) clearInterval(scheduleSyncTimer);
  scheduleSyncTimer = setInterval(async () => {
    await syncSchedule();
    startHeartbeatIfInWindow();
  }, 60 * 60 * 1000);
}

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

  mainWindow.on('close', (e) => {
    // Minimize to tray when auto attendance is enrolled
    if (loadToken() && tray) {
      e.preventDefault();
      mainWindow?.hide();
    }
  });

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

function setupTray() {
  try {
    const icon = nativeImage.createFromPath(path.join(__dirname, 'icon.png'));
    tray = new Tray(icon.resize({ width: 16, height: 16 }));
    tray.setToolTip('Scorr attendance');
    tray.setContextMenu(
      Menu.buildFromTemplate([
        {
          label: 'Open Scorr',
          click: () => {
            if (!mainWindow) createWindow();
            else {
              mainWindow.show();
              mainWindow.focus();
            }
          },
        },
        {
          label: 'Sync schedule',
          click: () => void syncSchedule().then(() => startHeartbeatIfInWindow()),
        },
        { type: 'separator' },
        {
          label: 'Quit',
          click: () => {
            clearToken();
            app.exit(0);
          },
        },
      ]),
    );
  } catch (e) {
    console.warn('[scorr] tray unavailable', e);
  }
}

function wirePowerEvents() {
  powerMonitor.on('resume', () => {
    void syncSchedule().then(() => {
      startHeartbeatIfInWindow();
      void sendEvent('power_on');
    });
  });
  powerMonitor.on('suspend', () => {
    void sendEvent('power_off');
    stopHeartbeat();
  });
  powerMonitor.on('shutdown', () => {
    void sendEvent('power_off');
  });
  // Screen lock must NOT check out (R49) — ignore lock-screen if available
}

app.setLoginItemSettings({ openAtLogin: true, openAsHidden: true });

app.whenReady().then(async () => {
  session.defaultSession.setPermissionRequestHandler((_wc, permission, callback) => {
    const allow = permission === 'geolocation' || permission === 'notifications';
    callback(allow);
  });

  ipcMain.on('scorr:workspace', () => expandToWorkspace());
  ipcMain.on('scorr:login', () => shrinkToLogin());
  ipcMain.handle('scorr:saveAttendanceToken', (_e, token) => {
    saveToken(token);
    void syncSchedule().then(() => startHeartbeatIfInWindow());
    return true;
  });
  ipcMain.handle('scorr:clearAttendanceToken', () => {
    clearToken();
    stopHeartbeat();
    return true;
  });
  ipcMain.handle('scorr:hasAttendanceToken', () => Boolean(loadToken()));

  setupTray();
  wirePowerEvents();
  createWindow();

  if (loadToken()) {
    await syncSchedule();
    startHeartbeatIfInWindow();
    armScheduleLoop();
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('before-quit', () => {
  void sendEvent('power_off');
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin' && !loadToken()) app.quit();
});
