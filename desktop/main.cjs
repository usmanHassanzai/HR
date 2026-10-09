/**
 * Electron laptop automatic attendance (Section H / R45–R53).
 * powerMonitor suspend/lock → device_sleep; resume/unlock → device_wake;
 * shutdown → device_shutdown; 60s heartbeat while awake.
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
const crypto = require('crypto');
const { net } = require('electron');

const APP_URL = process.env.SCORR_DESKTOP_URL || 'https://scorr.walfia.ai/?app=1';
const SUPABASE_URL = process.env.SCORR_SUPABASE_URL || 'https://yvnbxweitelowucdhwpg.supabase.co';
const SUPABASE_ANON =
  process.env.SCORR_SUPABASE_ANON ||
  process.env.VITE_SUPABASE_ANON_KEY ||
  '';

let autoUpdater = null;
try {
  ({ autoUpdater } = require('electron-updater'));
} catch {
  autoUpdater = null;
}

const LOGIN_SIZE = { width: 480, height: 780 };
const WORKSPACE_SIZE = { width: 1280, height: 840 };
const TOKEN_FILE = () => path.join(app.getPath('userData'), 'attendance-token.bin');
const DEVICE_ID_FILE = () => path.join(app.getPath('userData'), 'attendance-device-id.txt');
const SCHEDULE_FILE = () => path.join(app.getPath('userData'), 'attendance-schedule.json');
const LOGIN_CREDS_FILE = () => path.join(app.getPath('userData'), 'login-credentials.bin');
/** AES-GCM fallback when OS safeStorage (keyring) is unavailable — e.g. some Linux desktops. */
const LOGIN_CREDS_FALLBACK_FILE = () => path.join(app.getPath('userData'), 'login-credentials.aes');
const LOGIN_CREDS_KEY_FILE = () => path.join(app.getPath('userData'), 'login-credentials.key');
const TRUSTED_DEVICE_FILE = () => path.join(app.getPath('userData'), 'trusted-device.bin');

/** @type {BrowserWindow | null} */
let mainWindow = null;
let tray = null;
let workspaceExpanded = false;
let heartbeatTimer = null;
let scheduleSyncTimer = null;
let networkWatchTimer = null;
let lastNetworkFingerprint = '';
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

function loginFallbackKey() {
  try {
    if (fs.existsSync(LOGIN_CREDS_KEY_FILE())) {
      const raw = fs.readFileSync(LOGIN_CREDS_KEY_FILE());
      if (raw.length === 32) return raw;
    }
  } catch {
    /* recreate */
  }
  const key = crypto.randomBytes(32);
  fs.writeFileSync(LOGIN_CREDS_KEY_FILE(), key, { mode: 0o600 });
  return key;
}

function saveLoginCredentialsFallback(payload) {
  const key = loginFallbackKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([cipher.update(payload, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  fs.writeFileSync(LOGIN_CREDS_FALLBACK_FILE(), Buffer.concat([iv, tag, enc]), { mode: 0o600 });
  return true;
}

function loadLoginCredentialsFallback() {
  if (!fs.existsSync(LOGIN_CREDS_FALLBACK_FILE()) || !fs.existsSync(LOGIN_CREDS_KEY_FILE())) return null;
  const key = fs.readFileSync(LOGIN_CREDS_KEY_FILE());
  if (key.length !== 32) return null;
  const buf = fs.readFileSync(LOGIN_CREDS_FALLBACK_FILE());
  if (buf.length < 28) return null;
  const iv = buf.subarray(0, 12);
  const tag = buf.subarray(12, 28);
  const data = buf.subarray(28);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  const raw = Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
  const parsed = JSON.parse(raw || '{}');
  if (parsed.email && parsed.password) return { email: parsed.email, password: parsed.password };
  return null;
}

function saveLoginCredentials(email, password) {
  if (!email || !password) return false;
  const payload = JSON.stringify({ email: String(email).trim(), password: String(password) });
  try {
    if (safeStorage.isEncryptionAvailable()) {
      fs.writeFileSync(LOGIN_CREDS_FILE(), safeStorage.encryptString(payload));
      // Prefer OS keyring; drop AES fallback copy if present.
      try {
        if (fs.existsSync(LOGIN_CREDS_FALLBACK_FILE())) fs.unlinkSync(LOGIN_CREDS_FALLBACK_FILE());
      } catch {
        /* ignore */
      }
      return true;
    }
  } catch {
    /* fall through to AES file */
  }
  try {
    return saveLoginCredentialsFallback(payload);
  } catch {
    return false;
  }
}

function loadLoginCredentials() {
  try {
    if (fs.existsSync(LOGIN_CREDS_FILE()) && safeStorage.isEncryptionAvailable()) {
      const raw = safeStorage.decryptString(fs.readFileSync(LOGIN_CREDS_FILE()));
      const parsed = JSON.parse(raw || '{}');
      if (parsed.email && parsed.password) return { email: parsed.email, password: parsed.password };
    }
  } catch {
    /* try fallback */
  }
  try {
    return loadLoginCredentialsFallback();
  } catch {
    return null;
  }
}

function clearLoginCredentials() {
  try {
    if (fs.existsSync(LOGIN_CREDS_FILE())) fs.unlinkSync(LOGIN_CREDS_FILE());
  } catch {
    /* ignore */
  }
  try {
    if (fs.existsSync(LOGIN_CREDS_FALLBACK_FILE())) fs.unlinkSync(LOGIN_CREDS_FALLBACK_FILE());
  } catch {
    /* ignore */
  }
  try {
    if (fs.existsSync(LOGIN_CREDS_KEY_FILE())) fs.unlinkSync(LOGIN_CREDS_KEY_FILE());
  } catch {
    /* ignore */
  }
  return true;
}

function saveTrustedDeviceToken(token) {
  if (!token) return false;
  try {
    if (safeStorage.isEncryptionAvailable()) {
      fs.writeFileSync(TRUSTED_DEVICE_FILE(), safeStorage.encryptString(String(token)));
      return true;
    }
  } catch {
    /* fall through */
  }
  return false;
}

function loadTrustedDeviceToken() {
  try {
    if (fs.existsSync(TRUSTED_DEVICE_FILE()) && safeStorage.isEncryptionAvailable()) {
      return safeStorage.decryptString(fs.readFileSync(TRUSTED_DEVICE_FILE()));
    }
  } catch {
    /* ignore */
  }
  return null;
}

function clearTrustedDeviceToken() {
  try {
    if (fs.existsSync(TRUSTED_DEVICE_FILE())) fs.unlinkSync(TRUSTED_DEVICE_FILE());
  } catch {
    /* ignore */
  }
  return true;
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
    const prevVer = Number(cachedSchedule?.office_version || 0);
    const nextVer = Number(data.office_version || 0);
    cachedSchedule = data;
    try {
      fs.writeFileSync(SCHEDULE_FILE(), JSON.stringify(data), 'utf8');
    } catch {
      /* ignore */
    }
    if (nextVer > 0 && nextVer !== prevVer) {
      console.info('[scorr-att] office_version changed', { prevVer, nextVer });
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

async function readFreshLocation(maxAccuracyM = 50) {
  if (!mainWindow || mainWindow.isDestroyed()) return null;
  try {
    return await mainWindow.webContents.executeJavaScript(`
      (async () => {
        if (!navigator.geolocation) return { error: 'unsupported' };
        const readOnce = () => new Promise((resolve) => {
          navigator.geolocation.getCurrentPosition(
            (p) => resolve({
              latitude: p.coords.latitude,
              longitude: p.coords.longitude,
              accuracy_m: p.coords.accuracy
            }),
            (err) => resolve({ error: err && err.message ? err.message : 'denied' }),
            { enableHighAccuracy: true, timeout: 5000, maximumAge: 0 }
          );
        });
        let best = null;
        for (let i = 0; i < 3; i++) {
          const fix = await readOnce();
          if (fix && fix.latitude != null) {
            if (!best || (fix.accuracy_m ?? 9999) < (best.accuracy_m ?? 9999)) best = fix;
            if ((fix.accuracy_m ?? 9999) <= ${Number(maxAccuracyM)}) return fix;
          } else if (!best) {
            best = fix;
          }
        }
        return best;
      })()
    `, true);
  } catch {
    return { error: 'unavailable' };
  }
}

const STALE_EVENT_MAX_AGE_MS = 10 * 60 * 1000;
/** Pending connection_lost (exact disconnect time) sent first on reconnect. */
let pendingConnectionLostMs = null;
/** Queued close-only laptop events (sleep/shutdown) when offline — sent first on reconnect. */
let pendingLaptopCloseQueue = [];
/** Local asleep-since for status card (ms epoch), null when awake. */
let laptopAsleepSinceMs = null;

const CLOSE_ONLY_EVENTS = new Set(['connection_lost', 'device_sleep', 'device_shutdown']);

function logDesktopStaleDrop(event, occurred, ageMs, source) {
  console.info('[scorr-att] dropped stale event', { source, event, age_ms: ageMs, occurred_at_utc_ms: occurred });
}

function saveConnectionLost() {
  pendingConnectionLostMs = Date.now();
  console.info('[scorr-att] queued connection_lost', pendingConnectionLostMs);
}

function queueLaptopCloseEvent(event, occurredAtUtcMs) {
  const occurred = occurredAtUtcMs && occurredAtUtcMs > 0 ? occurredAtUtcMs : Date.now();
  pendingLaptopCloseQueue.push({ event, occurredAtUtcMs: occurred });
  if (event === 'device_sleep' || event === 'device_shutdown') {
    laptopAsleepSinceMs = occurred;
  }
  console.info('[scorr-att] queued laptop close event', event, occurred);
}

async function flushConnectionLostThen(nextFn) {
  // Close-only events first (exact timestamps), then any follow-up.
  if (pendingConnectionLostMs != null) {
    const lostAt = pendingConnectionLostMs;
    pendingConnectionLostMs = null;
    await sendEvent('connection_lost', { error: 'offline' }, false, lostAt);
  }
  while (pendingLaptopCloseQueue.length > 0) {
    const item = pendingLaptopCloseQueue.shift();
    await sendEvent(item.event, null, false, item.occurredAtUtcMs);
  }
  if (typeof nextFn === 'function') return nextFn();
  return null;
}

async function sendEvent(event, coords, allowRetry = true, occurredAtUtcMs = null) {
  const token = loadToken();
  if (!token || !SUPABASE_ANON) return null;
  const now = Date.now();
  const occurred = occurredAtUtcMs && occurredAtUtcMs > 0 ? occurredAtUtcMs : now;
  const ev = String(event || '').toLowerCase();
  const isCloseOnly = CLOSE_ONLY_EVENTS.has(ev);
  if (!isCloseOnly && now - occurred > STALE_EVENT_MAX_AGE_MS) {
    logDesktopStaleDrop(event, occurred, now - occurred, 'desktop-pre-send');
    return { ok: false, reason: 'event_too_old', action: 'event_too_old', client_dropped: true };
  }
  let fix = coords;
  if (!isCloseOnly && (!fix || fix.latitude == null || fix.longitude == null)) {
    // Wait briefly for GPS; if unavailable, send Wi-Fi-only (server may check in).
    fix = await Promise.race([
      readFreshLocation(100),
      new Promise((resolve) => setTimeout(() => resolve({ error: 'timeout' }), 3000)),
    ]);
  }
  const gpsAvailable =
    !isCloseOnly && Boolean(fix && fix.latitude != null && fix.longitude != null && !fix.error);
  let res;
  try {
    res = await httpJson(`${SUPABASE_URL}/functions/v1/auto-attendance-event`, {
      method: 'POST',
      headers: {
        apikey: SUPABASE_ANON,
        'Content-Type': 'application/json',
        'x-device-token': token,
      },
      body: {
        device_token: token,
        event,
        occurred_at_utc_ms: occurred,
        device_now_utc_ms: now,
        device_timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        device_id: deviceId(),
        platform: platformName(),
        app_version: app.getVersion(),
        latitude: gpsAvailable ? fix.latitude : null,
        longitude: gpsAvailable ? fix.longitude : null,
        accuracy_m: gpsAvailable ? (fix.accuracy_m ?? null) : null,
        gps_available: gpsAvailable,
        is_mock: false,
      },
    });
  } catch (e) {
    if (ev === 'device_sleep' || ev === 'device_shutdown') {
      queueLaptopCloseEvent(ev, occurred);
    } else if (ev === 'connection_lost') {
      saveConnectionLost();
    }
    notify('Scorr', 'No connection - will check when online');
    return { ok: false, reason: 'no_connection', action: 'no_connection' };
  }

  if (ev === 'device_sleep') {
    laptopAsleepSinceMs = occurred;
  } else if (ev === 'device_wake' || ev === 'device_shutdown') {
    if (ev === 'device_wake') laptopAsleepSinceMs = null;
  }

  // Check-out still needs GPS; retry once if server asks.
  if (allowRetry && (res?.action === 'need_fresh_location' || res?.action === 'gps_unusable')) {
    const pos = await readFreshLocation(50);
    if (pos && pos.latitude != null && pos.longitude != null) {
      return sendEvent(event, pos, false);
    }
  }

  if (res?.notify_message) {
    notify('Scorr', String(res.notify_message));
  } else if (res?.action === 'clock_in') {
    const src = res?.attendance_source || res?.source || '';
    if (src === 'auto_wifi_no_gps' || !gpsAvailable) {
      notify('Scorr', 'Checked in on office Wi-Fi (location is off)');
    } else {
      const t = res?.local_time || new Date().toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
      notify('Scorr', `Checked in at ${t}`);
    }
  } else if (res?.action === 'clock_out') {
    // Prefer server notify_message (laptop L3–L6 reasons); never show raw SQL.
    if (!res?.notify_message) {
      const t = res?.local_time || null;
      notify('Scorr', t ? `Checked out - left the office radius at ${t}` : 'Checked out');
    }
    // Keep tray heartbeat alive; send immediately so a new visit can open on return.
    startHeartbeatIfInWindow();
    setTimeout(() => {
      void sendEvent('heartbeat');
    }, 1500);
  } else if (res?.action === 'not_on_office_wifi' || res?.action === 'not_on_office_network') {
    notify('Scorr', 'Connect to the office Wi-Fi');
    startHeartbeatIfInWindow();
    // Retry every 30s until office network matches (window still open).
    setTimeout(() => {
      void sendEvent('heartbeat');
    }, 30_000);
  } else if (res?.action === 'outside_radius') {
    notify('Scorr', 'You are outside the office radius');
  } else if (res?.action === 'need_fresh_location' || res?.action === 'gps_unusable') {
    notify('Scorr', 'Location unavailable, try again');
  } else if (res?.action === 'checkin_blocked_shift_ended') {
    notify('Scorr', 'The shift has ended. You cannot check in.');
  } else if (res?.action === 'event_too_old') {
    notify('Scorr', 'Reading was too old — get a fresh location');
  } else if (res?.ok === false && res?.reason && res.reason !== 'already_checked_in') {
    const r = String(res.reason);
    if (/v_chk|not assigned|PL\/pgSQL|SQLSTATE|\s/.test(r)) {
      console.warn('[scorr-att] server error', r);
      notify('Scorr', 'Clock out failed, please try again');
    } else {
      notify('Scorr', r.replace(/_/g, ' '));
    }
  } else if (res?.action === 'presence_left_pending' || res?.action === 'device_left_others_present') {
    // Off office network — keep heartbeats so sticky present clears for phone auto priority.
  }
  // Only stop enrollment for hard failures — never after check-out / outside_window.
  const hardStop = new Set([
    'missing_token', 'invalid_token', 'revoked_token',
    'user_gone', 'feature_off', 'work_mode_remote',
  ]);
  if (res?.stop_tracking && hardStop.has(String(res?.reason || ''))) {
    stopHeartbeat();
  } else if (res?.reason === 'outside_window') {
    stopHeartbeat(); // pause until schedule re-arms next window; keep token
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

  // Immediate present signal with a fresh GPS reading
  void sendEvent('power_on');
  heartbeatTimer = setInterval(() => {
    const w = activeWindow(cachedSchedule, Date.now());
    if (!w) {
      stopHeartbeat();
      return;
    }
    // Refresh schedule each minute so office radius/pin changes apply.
    void syncSchedule().then(() => sendEvent('heartbeat'));
  }, 60 * 1000);
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
          label: 'Quit Scorr',
          click: () => {
            // Keep device token — tracking stops only via Turn off auto attendance / admin revoke.
            // Send app_quit before exit so the server records the intentional stop.
            void sendEvent('app_quit').finally(() => app.exit(0));
          },
        },
      ]),
    );
  } catch (e) {
    console.warn('[scorr] tray unavailable', e);
  }
}

function networkFingerprint() {
  try {
    const os = require('os');
    const ifaces = os.networkInterfaces() || {};
    const parts = [];
    for (const [name, list] of Object.entries(ifaces)) {
      for (const info of list || []) {
        if (!info || info.internal) continue;
        parts.push(`${name}:${info.family}:${info.address}:${info.mac || ''}`);
      }
    }
    parts.sort();
    return parts.join('|');
  } catch {
    return '';
  }
}

function startNetworkWatch() {
  if (networkWatchTimer) clearInterval(networkWatchTimer);
  lastNetworkFingerprint = networkFingerprint();
  networkWatchTimer = setInterval(() => {
    if (!loadToken()) return;
    const fp = networkFingerprint();
    if (!fp && lastNetworkFingerprint) {
      // All interfaces gone — Wi-Fi and mobile/ethernet offline.
      lastNetworkFingerprint = '';
      saveConnectionLost();
      return;
    }
    if (fp && fp !== lastNetworkFingerprint) {
      const wasOffline = !lastNetworkFingerprint;
      lastNetworkFingerprint = fp;
      void syncSchedule().then(() => {
        startHeartbeatIfInWindow();
        if (wasOffline) {
          void flushConnectionLostThen(() => sendEvent('network_change'));
        } else {
          void sendEvent('network_change');
        }
      });
    }
  }, 15_000);
}

function wirePowerEvents() {
  powerMonitor.on('resume', () => {
    void syncSchedule().then(() => {
      // Close-only queue first, then wake, then heartbeats (may open a new visit).
      void flushConnectionLostThen(async () => {
        await sendEvent('device_wake');
        startHeartbeatIfInWindow();
      });
    });
  });
  powerMonitor.on('unlock-screen', () => {
    void syncSchedule().then(() => {
      void flushConnectionLostThen(async () => {
        await sendEvent('device_wake');
        startHeartbeatIfInWindow();
      });
    });
  });
  powerMonitor.on('suspend', () => {
    stopHeartbeat();
    void sendEvent('device_sleep');
  });
  try {
    powerMonitor.on('lock-screen', () => {
      stopHeartbeat();
      void sendEvent('device_sleep');
    });
  } catch {
    /* lock-screen not available on all platforms */
  }
  powerMonitor.on('shutdown', () => {
    stopHeartbeat();
    void sendEvent('device_shutdown');
  });
  startNetworkWatch();
}

app.setLoginItemSettings({ openAtLogin: true, openAsHidden: true });

const DAILY_UPDATE_HOUR = 5; // local 5:00 AM
const UPDATE_CHECK_STAMP = () => path.join(app.getPath('userData'), 'last-update-check.txt');

function readLastUpdateCheckAt() {
  try {
    if (!fs.existsSync(UPDATE_CHECK_STAMP())) return 0;
    const n = Number(fs.readFileSync(UPDATE_CHECK_STAMP(), 'utf8').trim());
    return Number.isFinite(n) ? n : 0;
  } catch {
    return 0;
  }
}

function markDesktopUpdateChecked() {
  try {
    fs.writeFileSync(UPDATE_CHECK_STAMP(), String(Date.now()), 'utf8');
  } catch {
    /* ignore */
  }
}

/** Start of current daily window (today 5:00 if past 5:00, else yesterday 5:00). */
function dailyUpdateBoundary(now = new Date()) {
  const boundary = new Date(now);
  boundary.setHours(DAILY_UPDATE_HOUR, 0, 0, 0);
  if (now.getTime() < boundary.getTime()) boundary.setDate(boundary.getDate() - 1);
  return boundary;
}

function shouldRunDesktopDailyCheck(now = new Date()) {
  const last = readLastUpdateCheckAt();
  if (!last) return true;
  return last < dailyUpdateBoundary(now).getTime();
}

function msUntilNextDailyUpdate(now = new Date()) {
  const next = new Date(now);
  next.setHours(DAILY_UPDATE_HOUR, 0, 0, 0);
  if (now.getTime() >= next.getTime()) next.setDate(next.getDate() + 1);
  return Math.max(5_000, next.getTime() - now.getTime());
}

function setupAutoUpdater() {
  if (!autoUpdater || !app.isPackaged) return;
  try {
    autoUpdater.autoDownload = true;
    autoUpdater.autoInstallOnAppQuit = true;
    autoUpdater.setFeedURL({
      provider: 'generic',
      url: 'https://scorr.walfia.ai/downloads/desktop/',
    });
    let installing = false;
    /** @type {NodeJS.Timeout | null} */
    let dailyTimer = null;

    autoUpdater.on('update-downloaded', (info) => {
      if (installing) return;
      installing = true;
      if (Notification.isSupported()) {
        new Notification({
          title: 'Scorr updating',
          body: `Version ${info.version || ''} downloaded. Installing…`,
        }).show();
      }
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('scorr:update-ready', {
          version: info.version,
          message: 'Updating…',
          autoInstall: true,
        });
      }
      // Brief pause so the renderer can show "Updating…", then silent install + relaunch.
      setTimeout(() => {
        try {
          autoUpdater.quitAndInstall(false, true);
        } catch (e) {
          console.warn('quitAndInstall failed; will install on next quit', e);
          installing = false;
        }
      }, 1200);
    });

    const check = (reason = 'scheduled') => {
      console.log(`[scorr] update check (${reason})`);
      markDesktopUpdateChecked();
      void autoUpdater.checkForUpdates().catch((e) => {
        console.warn('[scorr] checkForUpdates failed', e);
      });
    };

    const armDailyTimer = () => {
      if (dailyTimer) clearTimeout(dailyTimer);
      const wait = msUntilNextDailyUpdate();
      console.log(`[scorr] next update check in ${Math.round(wait / 60000)} min (~${DAILY_UPDATE_HOUR}:00 local)`);
      dailyTimer = setTimeout(() => {
        check('daily-5am');
        armDailyTimer();
      }, wait);
    };

    // Catch-up if the app was closed at 5 AM; otherwise wait for the next 5 AM.
    if (shouldRunDesktopDailyCheck()) {
      setTimeout(() => check('catch-up'), 15_000);
    }
    armDailyTimer();

    // Laptop wake / resume — install overnight updates without waiting for UI.
    powerMonitor.on('resume', () => {
      if (shouldRunDesktopDailyCheck()) check('power-resume');
    });
  } catch (e) {
    console.warn('autoUpdater setup failed', e);
  }
}

app.whenReady().then(async () => {
  ipcMain.handle('scorr:setAutoLaunch', (_e, enabled) => {
    app.setLoginItemSettings({ openAtLogin: Boolean(enabled), openAsHidden: true });
    return { ok: true, enabled: Boolean(enabled) };
  });
  ipcMain.handle('scorr:getAutoLaunch', () => {
    const s = app.getLoginItemSettings();
    return { enabled: Boolean(s.openAtLogin) };
  });
  ipcMain.handle('scorr:checkForUpdates', async () => {
    if (!autoUpdater || !app.isPackaged) {
      return { ok: false, message: 'Updates run in the installed desktop app.' };
    }
    try {
      const result = await autoUpdater.checkForUpdates();
      return {
        ok: true,
        message: result?.updateInfo?.version
          ? `Update ${result.updateInfo.version} available — downloading in the background.`
          : 'Checked for updates.',
      };
    } catch (e) {
      return { ok: false, message: e instanceof Error ? e.message : String(e) };
    }
  });
  ipcMain.handle('scorr:quitAndInstall', () => {
    if (autoUpdater) autoUpdater.quitAndInstall(false, true);
    return { ok: true };
  });
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
  ipcMain.handle('scorr:getLaptopSleepStatus', () => ({
    asleep: laptopAsleepSinceMs != null,
    asleepSinceMs: laptopAsleepSinceMs,
  }));
  ipcMain.handle('scorr:saveLoginCredentials', (_e, email, password) => saveLoginCredentials(email, password));
  ipcMain.handle('scorr:loadLoginCredentials', () => loadLoginCredentials());
  ipcMain.handle('scorr:clearLoginCredentials', () => clearLoginCredentials());
  ipcMain.handle('scorr:saveTrustedDeviceToken', (_e, token) => saveTrustedDeviceToken(token));
  ipcMain.handle('scorr:loadTrustedDeviceToken', () => loadTrustedDeviceToken());
  ipcMain.handle('scorr:clearTrustedDeviceToken', () => clearTrustedDeviceToken());

  setupTray();
  wirePowerEvents();
  createWindow();
  setupAutoUpdater();

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
  // Tray "Quit" — process stops; server logs app_quit (not an office leave).
  void sendEvent('app_quit');
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin' && !loadToken()) app.quit();
});
