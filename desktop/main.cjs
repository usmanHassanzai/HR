/**
 * Electron laptop automatic attendance — same check-in policy as Android:
 *   window [shift start − 1h, shift end]; Wi-Fi first then office radius;
 *   checked out → ~1s probes (wifi_connected / ping with GPS+Wi-Fi);
 *   checked in  → Windows 11 stays until shift end or Clock Out;
 *                 Windows 10 and Linux still check out on Wi-Fi drop or leaving the office;
 *   re-entry after mid-shift checkout (30s cooldown after manual Clock Out,
 *   matching Android AttendancePingService.INTERVAL_CHECKED_IN_MS).
 * Uses device token from safeStorage; no dashboard session required after enrollment.
 */
const {
  app,
  BrowserWindow,
  shell,
  session,
  screen,
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
const {
  normalizeSsid,
  normalizeBssid,
  decodeCommandOutput,
  parseWindowsWlanInterfaces,
  parseNmcliActiveWifi,
  parseLocationConsent,
  LOCATION_MESSAGE,
  ipMatchesSavedCidrs,
} = require('./wifiProbe.cjs');
const { deliverAttendanceNotice } = require('./desktopNotify.cjs');
const { isWindows11Build, readWindowsBuildNumber } = require('./windowsVariant.cjs');

const APP_URL = process.env.SCORR_DESKTOP_URL || 'https://scorr.walfia.ai/?app=1';

/** Packaged builds bake URL+anon into runtime-config.cjs (same public key Android uses). */
let runtimeConfig = {};
try {
  runtimeConfig = require('./runtime-config.cjs');
} catch {
  runtimeConfig = {};
}
const SUPABASE_URL =
  process.env.SCORR_SUPABASE_URL ||
  runtimeConfig.supabaseUrl ||
  'https://yvnbxweitelowucdhwpg.supabase.co';
const SUPABASE_ANON =
  process.env.SCORR_SUPABASE_ANON ||
  process.env.VITE_SUPABASE_ANON_KEY ||
  runtimeConfig.supabaseAnonKey ||
  '';

if (!SUPABASE_ANON) {
  console.error(
    '[scorr-att] Missing Supabase anon key — auto check-in cannot call the server. Rebuild with scripts/write-desktop-runtime-config.mjs',
  );
}

let autoUpdater = null;
try {
  ({ autoUpdater } = require('electron-updater'));
} catch {
  autoUpdater = null;
}

/** Preferred sizes — always clamped to the display work area (small laptops). */
const LOGIN_SIZE = { width: 480, height: 720 };
const WORKSPACE_SIZE = { width: 1280, height: 800 };
const LOGIN_MIN = { width: 360, height: 480 };
const WORKSPACE_MIN = { width: 720, height: 520 };
const TOKEN_FILE = () => path.join(app.getPath('userData'), 'attendance-token.bin');
/** AES-GCM fallback when OS safeStorage (keyring) is locked/unavailable — common on Linux. */
const TOKEN_FALLBACK_FILE = () => path.join(app.getPath('userData'), 'attendance-token.aes');
const TOKEN_KEY_FILE = () => path.join(app.getPath('userData'), 'attendance-token.key');
const DEVICE_ID_FILE = () => path.join(app.getPath('userData'), 'attendance-device-id.txt');
const SCHEDULE_FILE = () => path.join(app.getPath('userData'), 'attendance-schedule.json');
const CHECKED_IN_FILE = () => path.join(app.getPath('userData'), 'attendance-checked-in.json');
const LOGIN_CREDS_FILE = () => path.join(app.getPath('userData'), 'login-credentials.bin');
/** AES-GCM fallback when OS safeStorage (keyring) is unavailable — e.g. some Linux desktops. */
const LOGIN_CREDS_FALLBACK_FILE = () => path.join(app.getPath('userData'), 'login-credentials.aes');
const LOGIN_CREDS_KEY_FILE = () => path.join(app.getPath('userData'), 'login-credentials.key');
const TRUSTED_DEVICE_FILE = () => path.join(app.getPath('userData'), 'trusted-device.bin');
/** Prefer unpacked preload (asarUnpack) — loading preload from app.asar fails on some Linux/Windows installs. */
function resolvePreloadPath() {
  const packed = path.join(__dirname, 'preload.cjs');
  const candidates = [];
  // Electron may report __dirname with / or \ on Windows — try both.
  for (const sep of new Set([path.sep, '/', '\\'])) {
    const u = packed.replace(`${sep}app.asar${sep}`, `${sep}app.asar.unpacked${sep}`);
    if (u !== packed) candidates.push(u);
  }
  if (/app\.asar$/i.test(__dirname)) {
    candidates.push(path.join(__dirname.replace(/app\.asar$/i, 'app.asar.unpacked'), 'preload.cjs'));
  }
  for (const c of candidates) {
    try {
      if (c && fs.existsSync(c)) return c;
    } catch {
      /* ignore */
    }
  }
  return packed;
}
const PRELOAD_PATH = resolvePreloadPath();

/**
 * Autostart must pass an argv flag — `openAsHidden` is macOS-only and a no-op on
 * Windows 10/11 and Linux. Without `--hidden`, login launch always shows the UI;
 * closing it (or never opening it) left Linux/Win11 with no background ping.
 */
const HIDDEN_LAUNCH_ARGS = ['--hidden'];
const HIDDEN_ARGV_FLAGS = new Set(['--hidden', '--tray', '--start-hidden']);

function argvWantsHiddenStart() {
  try {
    return process.argv.some((a) => HIDDEN_ARGV_FLAGS.has(String(a)));
  } catch {
    return false;
  }
}

function linuxAutostartDesktopPath() {
  let home = process.env.HOME || process.env.USERPROFILE || '';
  if (!home) {
    try {
      home = app.getPath('home');
    } catch {
      home = '';
    }
  }
  if (!home) return '';
  return path.join(home, '.config', 'autostart', 'scorr-attendance.desktop');
}

/** Best-effort XDG autostart — Electron login items are unreliable/absent on Linux. */
function writeLinuxAutostart(enabled) {
  if (process.platform !== 'linux') return;
  const desk = linuxAutostartDesktopPath();
  if (!desk) return;
  try {
    if (!enabled) {
      if (fs.existsSync(desk)) fs.unlinkSync(desk);
      return;
    }
    const dir = path.dirname(desk);
    fs.mkdirSync(dir, { recursive: true });
    const execPath = String(process.execPath || '').replace(/"/g, '\\"');
    if (!execPath) return;
    const body = [
      '[Desktop Entry]',
      'Type=Application',
      'Version=1.0',
      'Name=Scorr Attendance',
      'Comment=Background office check-in (no window)',
      `Exec="${execPath}" --hidden`,
      'Terminal=false',
      'X-GNOME-Autostart-enabled=true',
      'StartupNotify=false',
      '',
    ].join('\n');
    fs.writeFileSync(desk, body, { encoding: 'utf8', mode: 0o644 });
  } catch (e) {
    console.warn('[scorr] linux autostart write failed', e);
  }
}

/**
 * Register (or clear) start-at-login so the process runs headless with `--hidden`.
 * Windows: Run key + StartupApproved `enabled` (Win11 Task Manager otherwise disables it).
 * Linux: XDG ~/.config/autostart .desktop (Electron setLoginItemSettings is not enough).
 */
function configureAutoLaunch(enabled) {
  const on = Boolean(enabled);
  try {
    if (process.platform === 'win32' && isWindows11()) {
      // Same login-item API as Windows 10, plus --hidden and StartupApproved.
      // openAsHidden is a no-op on Windows, and Windows 11 Task Manager
      // otherwise disables the startup entry.
      app.setLoginItemSettings({
        openAtLogin: on,
        enabled: on,
        args: on ? HIDDEN_LAUNCH_ARGS : [],
      });
    } else if (process.platform === 'win32') {
      app.setLoginItemSettings({
        openAtLogin: on,
        openAsHidden: true,
      });
    } else if (process.platform === 'darwin') {
      app.setLoginItemSettings({
        openAtLogin: on,
        openAsHidden: true,
        args: on ? HIDDEN_LAUNCH_ARGS : [],
      });
    } else {
      // Linux: try Electron helper if present, always write XDG file.
      try {
        app.setLoginItemSettings({
          openAtLogin: on,
          openAsHidden: true,
          args: on ? HIDDEN_LAUNCH_ARGS : [],
        });
      } catch {
        /* ignore */
      }
      writeLinuxAutostart(on);
    }
  } catch (e) {
    console.warn('[scorr] configureAutoLaunch failed', e);
    if (process.platform === 'linux') writeLinuxAutostart(on);
  }
  return on;
}

function readAutoLaunchEnabled() {
  try {
    if (process.platform === 'win32' && isWindows11()) {
      const s = app.getLoginItemSettings({ args: HIDDEN_LAUNCH_ARGS });
      return Boolean(s.openAtLogin || s.executableWillLaunchAtLogin);
    }
    if (process.platform === 'win32') {
      const s = app.getLoginItemSettings();
      return Boolean(s.openAtLogin);
    }
    if (process.platform === 'linux') {
      try {
        if (fs.existsSync(linuxAutostartDesktopPath())) return true;
      } catch {
        /* ignore */
      }
      try {
        const s = app.getLoginItemSettings({ args: HIDDEN_LAUNCH_ARGS });
        if (s.openAtLogin) return true;
      } catch {
        /* ignore */
      }
      return false;
    }
    const s = app.getLoginItemSettings();
    return Boolean(s.openAtLogin);
  } catch {
    return false;
  }
}

function registerSessionPreload(ses) {
  if (!ses || !fs.existsSync(PRELOAD_PATH)) {
    console.error('[scorr] preload missing at', PRELOAD_PATH);
    return;
  }
  try {
    if (typeof ses.registerPreloadScript === 'function') {
      ses.registerPreloadScript({ type: 'frame', filePath: PRELOAD_PATH });
    }
  } catch (e) {
    console.warn('[scorr] registerPreloadScript failed', e);
  }
  try {
    if (typeof ses.setPreloads === 'function') {
      const prev = typeof ses.getPreloads === 'function' ? ses.getPreloads() || [] : [];
      if (!prev.includes(PRELOAD_PATH)) ses.setPreloads([...prev, PRELOAD_PATH]);
    }
  } catch (e) {
    console.warn('[scorr] setPreloads failed', e);
  }
}

/** Mark the page as Electron even if preload fails — UI must not say “Browser”. */
function injectElectronShellMarker(wc) {
  if (!wc || wc.isDestroyed()) return;
  const ver = JSON.stringify(app.getVersion());
  void wc
    .executeJavaScript(
      `(() => {
        try {
          window.__SCORR_ELECTRON_SHELL__ = true;
          window.__SCORR_ELECTRON_VERSION__ = ${ver};
          document.documentElement.dataset.scorrDesktop = ${ver};
          document.title = 'Scorr Desktop ' + ${ver};
        } catch (e) {}
        return true;
      })()`,
    )
    .catch(() => {});
}

/** @type {BrowserWindow | null} */
let mainWindow = null;
let tray = null;
let workspaceExpanded = false;
let heartbeatTimer = null;
let scheduleSyncTimer = null;
let windowStartTimer = null;
let windowEndTimer = null;
/** @type {any} */
let cachedSchedule = null;
/** Attendance date string (YYYY-MM-DD) after successful auto check-in — suppress repeats. */
let checkedInAttendanceDate = null;
/** @type {{ attendance_date?: string } | null} */
let checkedInState = null;
/** Last heartbeat saw an assigned office Wi-Fi (for early leave checkout). */
let wasOnOfficeWifi = false;
/** Aggressive check-in while session closed (battery-heavy by design). */
const INTERVAL_CHECKIN_PROBE_MS = 1000;
/** Leave probe while open session (Android uses 30s). */
const INTERVAL_CHECKED_IN_MS = 30 * 1000;
/**
 * Session-verify while locally “checked in” — faster than leave probe so a
 * manual Clock Out (web UI) clears suppress quickly and re-entry can fire.
 * Android discovers this via FGS + schedule; desktop needs a shorter poll.
 */
const INTERVAL_SESSION_VERIFY_MS = 3 * 1000;
/**
 * After manual Clock Out, block auto check-in (wifi_connected / ping / enter /
 * power_on) for the same interval Android uses while checked-in before the next
 * leave/session-verify cycle (AttendancePingService.INTERVAL_CHECKED_IN_MS).
 * Heartbeat may still run. Android has no instant IPC kick — discovery waits
 * up to this long, then ~1s probes resume.
 */
const MANUAL_CHECKOUT_REENTRY_COOLDOWN_MS = INTERVAL_CHECKED_IN_MS;
let lastCheckedInWorkAt = 0;
let lastSessionVerifyAt = 0;
let heartbeatInflight = false;
let heartbeatInflightSince = 0;
let reentryKickInflight = false;
/** Epoch ms until which auto check-in events are blocked after manual Clock Out. */
let checkinCooldownUntilMs = 0;
/** Cached Wi-Fi probe so heartbeats never block on nmcli/netsh. */
let wifiCache = { ssid: null, bssid: null, at: 0 };
let lastWifiProbe = { ssid: null, bssid: null, ssidBlank: false, locationAllowed: null };
const WIFI_CACHE_TTL_MS = 20_000;
const HTTP_TIMEOUT_MS = 12_000;
const INFLIGHT_STUCK_MS = 15_000;
/** In-memory token — survives Linux keyring/disk glitches for the running process. */
let memoryAttendanceToken = null;

function platformName() {
  return process.platform === 'win32' ? 'windows' : 'linux';
}

let cachedWindowsBuild = null;

function windowsBuildNumber() {
  if (cachedWindowsBuild != null) return cachedWindowsBuild;
  cachedWindowsBuild = readWindowsBuildNumber();
  return cachedWindowsBuild;
}

function isWindows11() {
  return process.platform === 'win32' && isWindows11Build(windowsBuildNumber());
}

function clearHeartbeatInflightIfStuck() {
  if (heartbeatInflight && heartbeatInflightSince > 0 && Date.now() - heartbeatInflightSince > INFLIGHT_STUCK_MS) {
    console.warn('[scorr-att] clearing stuck heartbeatInflight');
    heartbeatInflight = false;
    heartbeatInflightSince = 0;
  }
}

function markHeartbeatInflight(on) {
  heartbeatInflight = Boolean(on);
  heartbeatInflightSince = on ? Date.now() : 0;
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

function attendanceTokenKey() {
  try {
    if (fs.existsSync(TOKEN_KEY_FILE())) {
      const raw = fs.readFileSync(TOKEN_KEY_FILE());
      if (raw.length === 32) return raw;
    }
  } catch {
    /* recreate */
  }
  const key = crypto.randomBytes(32);
  fs.writeFileSync(TOKEN_KEY_FILE(), key, { mode: 0o600 });
  return key;
}

function saveTokenAesFallback(plaintext) {
  const key = attendanceTokenKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  fs.writeFileSync(TOKEN_FALLBACK_FILE(), Buffer.concat([iv, tag, enc]), { mode: 0o600 });
}

function loadTokenAesFallback() {
  if (!fs.existsSync(TOKEN_FALLBACK_FILE()) || !fs.existsSync(TOKEN_KEY_FILE())) return null;
  const key = fs.readFileSync(TOKEN_KEY_FILE());
  if (key.length !== 32) return null;
  const buf = fs.readFileSync(TOKEN_FALLBACK_FILE());
  if (buf.length < 28) return null;
  const iv = buf.subarray(0, 12);
  const tag = buf.subarray(12, 28);
  const data = buf.subarray(28);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8').trim() || null;
}

function saveToken(plaintext) {
  if (!plaintext) return false;
  const value = String(plaintext);
  memoryAttendanceToken = value;
  // Always write AES + chmod-locked plaintext so Linux works when the keyring is locked.
  try {
    saveTokenAesFallback(value);
  } catch (e) {
    console.warn('[scorr-att] token AES fallback save failed', e);
  }
  try {
    fs.writeFileSync(TOKEN_FILE() + '.txt', value, { encoding: 'utf8', mode: 0o600 });
  } catch (e) {
    console.warn('[scorr-att] token txt save failed', e);
  }
  try {
    if (safeStorage.isEncryptionAvailable()) {
      const buf = safeStorage.encryptString(value);
      fs.writeFileSync(TOKEN_FILE(), buf);
    }
  } catch (e) {
    console.warn('[scorr-att] token keyring save failed', e);
  }
  return Boolean(loadToken());
}

function loadTokenFromDiskFallbacks() {
  try {
    const aes = loadTokenAesFallback();
    if (aes) return aes;
  } catch {
    /* ignore */
  }
  try {
    if (fs.existsSync(TOKEN_FILE() + '.txt')) {
      const t = fs.readFileSync(TOKEN_FILE() + '.txt', 'utf8').trim();
      if (t) return t;
    }
  } catch {
    /* ignore */
  }
  return null;
}

function loadToken() {
  if (memoryAttendanceToken) return memoryAttendanceToken;
  let found = null;
  // Linux: prefer AES/txt first — locked/unavailable keyring at headless
  // autostart can hang or fail decrypt, which blocked background ping until UI opened.
  if (process.platform === 'linux') {
    found = loadTokenFromDiskFallbacks();
  }
  if (!found) {
    try {
      if (fs.existsSync(TOKEN_FILE()) && safeStorage.isEncryptionAvailable()) {
        const t = safeStorage.decryptString(fs.readFileSync(TOKEN_FILE()));
        if (t) found = t;
      }
    } catch {
      /* keyring locked / decrypt failed — try fallbacks */
    }
  }
  if (!found) {
    found = loadTokenFromDiskFallbacks();
  }
  if (found) {
    memoryAttendanceToken = found;
    try {
      if (!fs.existsSync(TOKEN_FALLBACK_FILE())) saveTokenAesFallback(found);
    } catch {
      /* ignore */
    }
  }
  return found;
}

function clearToken() {
  memoryAttendanceToken = null;
  try {
    if (fs.existsSync(TOKEN_FILE())) fs.unlinkSync(TOKEN_FILE());
    if (fs.existsSync(TOKEN_FILE() + '.txt')) fs.unlinkSync(TOKEN_FILE() + '.txt');
    if (fs.existsSync(TOKEN_FALLBACK_FILE())) fs.unlinkSync(TOKEN_FALLBACK_FILE());
    if (fs.existsSync(TOKEN_KEY_FILE())) fs.unlinkSync(TOKEN_KEY_FILE());
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

let lastAttendanceStatus = null;
let lastServerResult = null;
let windowsLocationAllowed = null;
let cachedPublicIp = '';
let cachedWindowsVersion = '';

function wifiLogPath() {
  try {
    return path.join(app.getPath('userData'), 'wifi-diagnostics.log');
  } catch {
    return path.join(process.cwd(), 'wifi-diagnostics.log');
  }
}

function appendWifiLog(entry) {
  try {
    fs.appendFileSync(wifiLogPath(), `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`);
  } catch {
    /* ignore */
  }
}

function recordAttendanceStatus(status) {
  lastAttendanceStatus = status;
  appendWifiLog({ type: 'attendance', ...status });
}

function showSystemToast(title, body) {
  try {
    if (Notification.isSupported()) {
      new Notification({ title, body }).show();
    }
  } catch {
    /* ignore */
  }
}

function notify(title, body, kind = 'reminder') {
  // Windows 11 does not toast. Windows 10 and Linux still do.
  deliverAttendanceNotice(process.platform, kind, () => showSystemToast(title, body), {
    windows11: isWindows11(),
  });
  if (isWindows11()) {
    recordAttendanceStatus({ title, body, kind, at: new Date().toISOString() });
  }
}

function httpJson(url, { method = 'POST', headers = {}, body, timeoutMs = HTTP_TIMEOUT_MS } = {}) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    const timer = setTimeout(() => {
      try {
        request.abort();
      } catch {
        /* ignore */
      }
      finish({ ok: false, reason: 'http_timeout' });
    }, Math.max(1000, timeoutMs || HTTP_TIMEOUT_MS));
    let request;
    try {
      request = net.request({ method, url });
      Object.entries(headers).forEach(([k, v]) => request.setHeader(k, v));
      let data = '';
      request.on('response', (response) => {
        response.on('data', (chunk) => {
          data += chunk.toString();
        });
        response.on('end', () => {
          clearTimeout(timer);
          try {
            finish(JSON.parse(data || '{}'));
          } catch {
            finish({ ok: false, reason: 'bad_json', raw: data });
          }
        });
      });
      request.on('error', (err) => {
        clearTimeout(timer);
        finish({ ok: false, reason: String(err) });
      });
      if (body) request.write(typeof body === 'string' ? body : JSON.stringify(body));
      request.end();
    } catch (e) {
      clearTimeout(timer);
      finish({ ok: false, reason: String(e) });
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
    data._fetchedAtMs = Date.now();
    cachedSchedule = data;
    // Manual / other-device checkout: clear local suppress so re-entry can fire.
    if (Object.prototype.hasOwnProperty.call(data, 'session_open') && data.session_open === false) {
      const wasSuppressed = Boolean(checkedInAttendanceDate);
      clearLocalCheckinSuppress({ resetWifiEdge: true });
      if (wasSuppressed) {
        // Still at office → Android-parity 30s before auto check-in; else kick now.
        if (matchesScheduleOfficeWifi(readWifiIdentity())) {
          armManualCheckoutReentryCooldown();
        }
        void forceReentryCheckin('schedule_session_closed');
      }
    }
    try {
      fs.writeFileSync(SCHEDULE_FILE(), JSON.stringify(data), 'utf8');
    } catch {
      /* ignore */
    }
    armWindowWakeFromSchedule();
  } else if (data?.stop_tracking) {
    const reason = String(data?.reason || data?.action || '');
    if (isTerminalStopReason(reason)) {
      stopHeartbeat();
      clearToken();
    }
  }
  return data;
}

/** True when stop_tracking means permanently disable (not just past this window). */
function isTerminalStopReason(actionOrReason) {
  const r = String(actionOrReason || '').toLowerCase();
  return (
    r === 'invalid_token' ||
    r === 'revoked_token' ||
    r === 'missing_token' ||
    r === 'invalid_or_revoked_token' ||
    r === 'platform_disabled' ||
    r === 'work_mode_remote' ||
    r === 'user_gone' ||
    r === 'disabled'
  );
}

/**
 * Exact-ish wake for next window start/end so heartbeat resumes without waiting
 * for the hourly schedule sync (and without wiping enrollment on outside_window).
 */
function armWindowWakeFromSchedule() {
  if (windowStartTimer) {
    clearTimeout(windowStartTimer);
    windowStartTimer = null;
  }
  if (windowEndTimer) {
    clearTimeout(windowEndTimer);
    windowEndTimer = null;
  }
  const windows = cachedSchedule?.windows || [];
  if (!windows.length) return;
  const now = Date.now();
  let nextStart = null;
  let nextEnd = null;
  for (const w of windows) {
    const start = Date.parse(w.window_start_utc);
    const end = Date.parse(w.window_end_utc);
    if (Number.isNaN(start) || Number.isNaN(end)) continue;
    if (start > now && (nextStart == null || start < nextStart)) nextStart = start;
    if (end > now && (nextEnd == null || end < nextEnd)) nextEnd = end;
  }
  const maxDelay = 2147483647; // setTimeout 32-bit cap
  if (nextStart != null) {
    windowStartTimer = setTimeout(() => {
      void syncSchedule().then(() => startHeartbeatIfInWindow());
    }, Math.min(Math.max(nextStart - now + 750, 0), maxDelay));
  }
  if (nextEnd != null) {
    windowEndTimer = setTimeout(() => {
      // Match Android exitWindow: nudge server to close open session at shift end,
      // then pause probes until the next [start−1h, end] window.
      void (async () => {
        try {
          await sendEvent('power_off');
        } catch {
          /* ignore */
        }
        stopHeartbeat();
        checkedInAttendanceDate = null;
        checkedInState = null;
        wasOnOfficeWifi = false;
        armWindowWakeFromSchedule();
      })();
    }, Math.min(Math.max(nextEnd - now + 750, 0), maxDelay));
  }
}

function serverCorrectedNowMs(schedule) {
  if (!schedule?.server_now_utc) return Date.now();
  const serverMs = Date.parse(schedule.server_now_utc);
  if (Number.isNaN(serverMs)) return Date.now();
  const fetchedAt = Number(schedule._fetchedAtMs) || Date.now();
  return serverMs + Math.max(0, Date.now() - fetchedAt);
}

function activeWindow(schedule, nowMs) {
  const windows = schedule?.windows || [];
  const t = Number.isFinite(nowMs) ? nowMs : Date.now();
  for (const w of windows) {
    const start = Date.parse(w.window_start_utc);
    const end = Date.parse(w.window_end_utc);
    if (!Number.isNaN(start) && !Number.isNaN(end) && t >= start && t <= end) {
      return w;
    }
  }
  return null;
}

function loadCachedScheduleFromDisk() {
  try {
    if (!fs.existsSync(SCHEDULE_FILE())) return null;
    const data = JSON.parse(fs.readFileSync(SCHEDULE_FILE(), 'utf8'));
    if (data && data.ok !== false) return data;
  } catch {
    /* ignore */
  }
  return null;
}

function scheduleNowMs() {
  return serverCorrectedNowMs(cachedSchedule) || Date.now();
}

/** Hidden BrowserWindow for GPS when the main UI is closed to tray (Android FGS has native GPS). */
let geoProbeWindow = null;

async function ensureGeoProbeWindow() {
  // Hidden-to-tray still works — webContents can read geolocation without show().
  if (mainWindow && !mainWindow.isDestroyed()) return mainWindow;
  if (geoProbeWindow && !geoProbeWindow.isDestroyed()) return geoProbeWindow;
  geoProbeWindow = new BrowserWindow({
    show: false,
    width: 0,
    height: 0,
    skipTaskbar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  try {
    await geoProbeWindow.loadURL('data:text/html,<!doctype html><title>scorr-geo</title>');
  } catch {
    /* ignore */
  }
  return geoProbeWindow;
}

async function readFreshLocation(maxAccuracyM = 50) {
  let win = null;
  try {
    if (mainWindow && !mainWindow.isDestroyed()) win = mainWindow;
    else win = await ensureGeoProbeWindow();
  } catch {
    return { error: 'unavailable' };
  }
  if (!win || win.isDestroyed()) return { error: 'unavailable' };
  try {
    return await win.webContents.executeJavaScript(`
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

function logDesktopStaleDrop(event, occurred, ageMs, source) {
  console.info('[scorr-att] dropped stale event', { source, event, age_ms: ageMs, occurred_at_utc_ms: occurred });
}

/** PATH for OS probes. Never prepend Unix paths on Windows — that glues System32 into one invalid entry. */
function execProbeEnv() {
  if (process.platform === 'win32') {
    const root = process.env.SystemRoot || process.env.windir || 'C:\\Windows';
    const sys32 = path.join(root, 'System32');
    const prev = process.env.PATH || '';
    return { ...process.env, PATH: `${sys32};${root};${prev}` };
  }
  return {
    ...process.env,
    PATH: `/usr/sbin:/usr/bin:/sbin:/bin:${process.env.PATH || ''}`,
  };
}

function execText(cmd, timeoutMs = 800) {
  const { execSync } = require('child_process');
  try {
    return execSync(cmd, {
      encoding: 'utf8',
      timeout: timeoutMs,
      killSignal: 'SIGKILL',
      windowsHide: true,
      env: execProbeEnv(),
    });
  } catch {
    return '';
  }
}

/** Run an exe + args and keep the raw bytes (Win11 netsh is often UTF-16 on a pipe). */
function execFileBuffer(file, args, timeoutMs = 800) {
  const { execFileSync } = require('child_process');
  try {
    return execFileSync(file, args, {
      timeout: timeoutMs,
      killSignal: 'SIGKILL',
      windowsHide: true,
      env: execProbeEnv(),
      maxBuffer: 1024 * 1024,
    });
  } catch (err) {
    if (err && err.stdout && err.stdout.length) return err.stdout;
    return Buffer.alloc(0);
  }
}

function execFileText(file, args, timeoutMs = 800) {
  return decodeCommandOutput(execFileBuffer(file, args, timeoutMs));
}

function windowsSys32() {
  const root = process.env.SystemRoot || process.env.windir || 'C:\\Windows';
  return path.join(root, 'System32');
}

function windowsPowerShell() {
  const ps = path.join(windowsSys32(), 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  return fs.existsSync(ps) ? ps : 'powershell.exe';
}

/** WLAN API — structured SSID, BSSID, and profile. No localized netsh labels. */
function queryWindowsWlanApi() {
  const script = [
    "$ErrorActionPreference='Stop'",
    'Add-Type -TypeDefinition @"',
    'using System;',
    'using System.Runtime.InteropServices;',
    'using System.Text;',
    'public static class ScorrWlan {',
    '  [DllImport("wlanapi.dll")] public static extern uint WlanOpenHandle(uint v, IntPtr r, out uint n, out IntPtr h);',
    '  [DllImport("wlanapi.dll")] public static extern uint WlanCloseHandle(IntPtr h, IntPtr r);',
    '  [DllImport("wlanapi.dll")] public static extern uint WlanEnumInterfaces(IntPtr h, IntPtr r, out IntPtr list);',
    '  [DllImport("wlanapi.dll")] public static extern uint WlanQueryInterface(IntPtr h, ref Guid g, int op, IntPtr r, out uint sz, out IntPtr data, IntPtr t);',
    '  [DllImport("wlanapi.dll")] public static extern void WlanFreeMemory(IntPtr p);',
    '  public static string Query() {',
    '    uint ver; IntPtr handle;',
    '    if (WlanOpenHandle(2, IntPtr.Zero, out ver, out handle) != 0) return "";',
    '    try {',
    '      IntPtr list;',
    '      if (WlanEnumInterfaces(handle, IntPtr.Zero, out list) != 0) return "";',
    '      try {',
    '        int count = Marshal.ReadInt32(list);',
    '        for (int i = 0; i < count; i++) {',
    '          int baseOff = 8 + (i * 536);',
    '          byte[] gb = new byte[16]; Marshal.Copy(IntPtr.Add(list, baseOff), gb, 0, 16);',
    '          Guid g = new Guid(gb);',
    '          uint sz; IntPtr data;',
    '          if (WlanQueryInterface(handle, ref g, 7, IntPtr.Zero, out sz, out data, IntPtr.Zero) != 0 || data == IntPtr.Zero) continue;',
    '          try {',
    '            string profile = Marshal.PtrToStringUni(IntPtr.Add(data, 8), 256);',
    '            if (profile != null) { int z = profile.IndexOf((char)0); if (z >= 0) profile = profile.Substring(0, z); }',
    '            int ssidLen = Marshal.ReadInt32(data, 520);',
    '            if (ssidLen < 0 || ssidLen > 32) ssidLen = 0;',
    '            byte[] ssidb = new byte[ssidLen];',
    '            if (ssidLen > 0) Marshal.Copy(IntPtr.Add(data, 524), ssidb, 0, ssidLen);',
    '            string ssid = Encoding.UTF8.GetString(ssidb);',
    '            byte[] mac = new byte[6]; Marshal.Copy(IntPtr.Add(data, 564), mac, 0, 6);',
    '            string bssid = string.Format("{0:x2}:{1:x2}:{2:x2}:{3:x2}:{4:x2}:{5:x2}", mac[0], mac[1], mac[2], mac[3], mac[4], mac[5]);',
    '            return ssid + "\\t" + bssid + "\\t" + (profile ?? "");',
    '          } finally { WlanFreeMemory(data); }',
    '        }',
    '      } finally { WlanFreeMemory(list); }',
    '    } finally { WlanCloseHandle(handle, IntPtr.Zero); }',
    '    return "";',
    '  }',
    '}',
    '"@',
    '[ScorrWlan]::Query()',
  ].join('\n');
  const out = execFileText(windowsPowerShell(), ['-NoProfile', '-NonInteractive', '-Command', script], 5000);
  const line = out.split(/\r?\n/).map((s) => s.trim()).filter(Boolean).pop() || '';
  const parts = line.split('\t');
  if (parts.length < 2) return null;
  const ssid = normalizeSsid(parts[0]);
  const bssid = normalizeBssid(parts[1]);
  const profile = normalizeSsid(parts.slice(2).join('\t'));
  if (!ssid && !bssid && !profile) return null;
  return {
    ssid: ssid || profile || null,
    bssid,
    ssidBlank: !ssid,
    usedProfile: !ssid && Boolean(profile),
  };
}

function readWindowsLocationAllowed() {
  const queries = [
    'HKCU\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\CapabilityAccessManager\\ConsentStore\\location',
    'HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\CapabilityAccessManager\\ConsentStore\\location',
  ];
  let seen = null;
  for (const key of queries) {
    const text = execFileText(path.join(windowsSys32(), 'reg.exe'), ['query', key, '/v', 'Value'], 2000);
    const consent = parseLocationConsent(text);
    if (consent === false) {
      windowsLocationAllowed = false;
      return false;
    }
    if (consent === true) seen = true;
  }
  windowsLocationAllowed = seen;
  return seen;
}

function readWindowsVersionLabel() {
  if (cachedWindowsVersion) return cachedWindowsVersion;
  const out = execFileText(
    windowsPowerShell(),
    [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      "(Get-ItemProperty 'HKLM:\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion').ProductName + ' ' + (Get-ItemProperty 'HKLM:\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion').DisplayVersion",
    ],
    3000,
  );
  cachedWindowsVersion = out.split(/\r?\n/).map((s) => s.trim()).filter(Boolean).pop() || '';
  return cachedWindowsVersion;
}

/** Windows 10 path: English netsh labels, same as desktop 1.3.45. */
function readWindows10Netsh() {
  const { execFileSync } = require('child_process');
  try {
    const out = execFileSync('netsh', ['wlan', 'show', 'interfaces'], {
      encoding: 'utf8',
      timeout: 4000,
      windowsHide: true,
    });
    const ssid = (String(out).match(/^\s*SSID\s*:\s*(.+)$/im) || [])[1]?.trim() || null;
    const bssid = (String(out).match(/^\s*BSSID\s*:\s*(.+)$/im) || [])[1]?.trim()?.toLowerCase() || null;
    return { ssid: ssid && ssid !== '' ? ssid : null, bssid: bssid || null };
  } catch {
    return { ssid: null, bssid: null };
  }
}

/** Probe OS Wi-Fi once (short timeouts). Prefer readWifiIdentity() which uses a cache. */
function probeWifiIdentityNow() {
  try {
    if (process.platform === 'win32' && !isWindows11()) {
      return readWindows10Netsh();
    }
    if (process.platform === 'win32') {
      const sys32 = windowsSys32();
      let parsed = null;
      try {
        parsed = queryWindowsWlanApi();
      } catch {
        parsed = null;
      }
      if (!parsed || (!parsed.ssid && !parsed.bssid)) {
        const netshExe = path.join(sys32, 'netsh.exe');
        const attempts = [];
        if (fs.existsSync(netshExe)) {
          attempts.push(execFileBuffer(netshExe, ['wlan', 'show', 'interfaces'], 4000));
        }
        const cmdExe = path.join(sys32, 'cmd.exe');
        attempts.push(execFileBuffer(
          fs.existsSync(cmdExe) ? cmdExe : 'cmd.exe',
          ['/d', '/s', '/c', 'chcp 65001>nul & netsh wlan show interfaces'],
          4000,
        ));
        for (const buf of attempts) {
          const fromNetsh = parseWindowsWlanInterfaces(decodeCommandOutput(buf));
          if (fromNetsh.ssid || fromNetsh.bssid) {
            parsed = fromNetsh;
            break;
          }
        }
      }
      if (parsed && !parsed.ssid) {
        const profile = execFileText(
          windowsPowerShell(),
          [
            '-NoProfile',
            '-NonInteractive',
            '-Command',
            "Get-NetConnectionProfile | Where-Object { $_.Name -and $_.InterfaceAlias -notmatch 'Ethernet|Bluetooth|Local Area' } | Select-Object -First 1 -ExpandProperty Name",
          ],
          4000,
        );
        const name = normalizeSsid(profile.split(/\r?\n/).map((s) => s.trim()).find(Boolean));
        if (name && !/^ethernet$|^bluetooth$/i.test(name)) {
          parsed = { ...parsed, ssid: name, usedProfile: true, ssidBlank: true };
        }
      }
      const locationAllowed = readWindowsLocationAllowed();
      const result = {
        ssid: parsed?.ssid || null,
        bssid: parsed?.bssid || null,
        ssidBlank: Boolean(parsed?.ssidBlank),
        usedProfile: Boolean(parsed?.usedProfile),
        locationAllowed,
      };
      if (!result.ssid && !result.bssid) {
        appendWifiLog({ type: 'probe_empty', locationAllowed });
      }
      return result;
    }
    if (process.platform === 'linux') {
      // Fast path: iwgetid (usually instant) before nmcli (can hang on D-Bus).
      const iw = normalizeSsid(execText('iwgetid -r', 600));
      if (iw) {
        const bssid = normalizeBssid(execText('iwgetid -ra', 600));
        return { ssid: iw, bssid };
      }
      // Prefer ACTIVE,SSID,BSSID — that BSSID is the AP, not the client NIC MAC.
      const list = execText('nmcli -t -f ACTIVE,SSID,BSSID device wifi', 800);
      const activeWifi = parseNmcliActiveWifi(list);
      if (activeWifi.ssid || activeWifi.bssid) return activeWifi;
      const active = execText('nmcli -t -f NAME,TYPE,DEVICE connection show --active', 700);
      for (const line of active.split('\n')) {
        const [name, type] = line.split(':');
        if (!name || !/wifi|802-11-wireless/i.test(String(type || ''))) continue;
        const ssid =
          execText(
            `nmcli -g 802-11-wireless.ssid connection show "${name.replace(/"/g, '\\"')}"`,
            600,
          ).trim() || name;
        // Do not use GENERAL.HWADDR — that is the client interface MAC, not the AP BSSID.
        if (ssid) return { ssid: normalizeSsid(ssid), bssid: null };
      }
    }
  } catch {
    /* ignore — Wi-Fi probe is best-effort; GPS / office IP still work */
  }
  return { ssid: null, bssid: null };
}

/** Best-effort SSID/BSSID — cached so heartbeats never stall on nmcli. */
function readWifiIdentity() {
  const now = Date.now();
  if (now - wifiCache.at < WIFI_CACHE_TTL_MS && (wifiCache.ssid || wifiCache.bssid || wifiCache.at > 0)) {
    // Refresh in background when cache is half-stale, but return immediately.
    if (now - wifiCache.at > WIFI_CACHE_TTL_MS / 2) {
      setImmediate(() => {
        try {
          const w = probeWifiIdentityNow();
          wifiCache = { ssid: w.ssid, bssid: w.bssid, at: Date.now() };
        } catch {
          /* ignore */
        }
      });
    }
    return { ssid: wifiCache.ssid, bssid: wifiCache.bssid };
  }
  const w = probeWifiIdentityNow();
  lastWifiProbe = w;
  // Windows 11: a failed or blank read is not "left the office".
  if (
    isWindows11() &&
    !w.ssid &&
    !w.bssid &&
    (wifiCache.ssid || wifiCache.bssid) &&
    now - wifiCache.at < 120_000
  ) {
    return { ssid: wifiCache.ssid, bssid: wifiCache.bssid };
  }
  if (!w.ssid && !w.bssid) {
    wifiCache = { ssid: null, bssid: null, at: now - WIFI_CACHE_TTL_MS + 3000 };
    return { ssid: null, bssid: null };
  }
  wifiCache = { ssid: w.ssid, bssid: w.bssid, at: Date.now() };
  return { ssid: w.ssid, bssid: w.bssid };
}

function isCheckinEventName(event) {
  const e = String(event || '').toLowerCase();
  return e === 'enter' || e === 'ping' || e === 'wifi_connected' || e === 'heartbeat' || e === 'power_on';
}

/** Windows 10 / Linux: parent comparison (trim and quotes, no cross-format BSSID). */
function matchesScheduleOfficeWifiLegacy(wifi) {
  const zones = cachedSchedule?.zones || [];
  const ssid = String(wifi?.ssid || '').trim().replace(/^"+|"+$/g, '');
  const bssid = String(wifi?.bssid || '').trim().toLowerCase();
  if (!ssid && !bssid) return false;
  for (const z of zones) {
    const bssids = Array.isArray(z.wifi_bssids) ? z.wifi_bssids : [];
    if (bssid) {
      for (const want of bssids) {
        if (String(want || '').trim().toLowerCase() === bssid) return true;
      }
    }
    const ssids = Array.isArray(z.wifi_ssids) ? z.wifi_ssids : [];
    if (ssid) {
      for (const want of ssids) {
        const saved = String(want || '').trim().replace(/^"+|"+$/g, '');
        if (saved.toLowerCase() === ssid.toLowerCase()) return true;
      }
    }
  }
  return false;
}

/** True when current SSID or BSSID matches any saved network on an assigned zone. */
function matchesScheduleOfficeWifi(wifi) {
  if (!isWindows11()) return matchesScheduleOfficeWifiLegacy(wifi);
  const zones = cachedSchedule?.zones || [];
  const ssid = normalizeSsid(wifi?.ssid);
  const bssid = normalizeBssid(wifi?.bssid);
  if (!ssid && !bssid) return false;
  for (const z of zones) {
    const bssids = Array.isArray(z.wifi_bssids) ? z.wifi_bssids : [];
    if (bssid) {
      for (const want of bssids) {
        if (normalizeBssid(want) === bssid) return true;
      }
    }
    const ssids = Array.isArray(z.wifi_ssids) ? z.wifi_ssids : [];
    if (ssid) {
      for (const want of ssids) {
        if (normalizeSsid(want).toLowerCase() === ssid.toLowerCase()) return true;
      }
    }
    const cidrs = Array.isArray(z.public_ip_cidrs) ? z.public_ip_cidrs : [];
    if (cachedPublicIp && ipMatchesSavedCidrs(cachedPublicIp, cidrs)) return true;
  }
  return false;
}

function clearLocalCheckinSuppress({ resetWifiEdge = true } = {}) {
  checkedInAttendanceDate = null;
  checkedInState = null;
  if (resetWifiEdge) {
    // Android AttendancePingStore.markOfficeWifiEdgeReset — rising edge can fire again.
    wasOnOfficeWifi = false;
  }
}

/** Arm Android-parity cooldown after dashboard Clock Out (notifyManualCheckout). */
function armManualCheckoutReentryCooldown() {
  checkinCooldownUntilMs = Date.now() + MANUAL_CHECKOUT_REENTRY_COOLDOWN_MS;
  console.info('[scorr-att] manual checkout re-entry cooldown', {
    ms: MANUAL_CHECKOUT_REENTRY_COOLDOWN_MS,
    until: checkinCooldownUntilMs,
  });
}

function inManualCheckoutReentryCooldown() {
  if (!checkinCooldownUntilMs) return false;
  if (Date.now() >= checkinCooldownUntilMs) {
    checkinCooldownUntilMs = 0;
    return false;
  }
  return true;
}

function stillSuppressCheckin() {
  if (!checkedInAttendanceDate) return false;
  if (cachedSchedule && Object.prototype.hasOwnProperty.call(cachedSchedule, 'session_open')
      && cachedSchedule.session_open === false) {
    clearLocalCheckinSuppress({ resetWifiEdge: true });
    return false;
  }
  const win = activeWindow(cachedSchedule, Date.now());
  if (!win) return false;
  if (Object.prototype.hasOwnProperty.call(win, 'session_open') && win.session_open === false) {
    clearLocalCheckinSuppress({ resetWifiEdge: true });
    return false;
  }
  const date = win.attendance_date || win.attendanceDate;
  return !date || String(date) === String(checkedInAttendanceDate);
}

/**
 * After manual Clock Out cooldown (or server resume_checkin): try Wi-Fi then GPS
 * like Android’s next 1s ping — do not wait for another 30s leave timer.
 */
async function forceReentryCheckin(reason = 'reentry') {
  if (reentryKickInflight) return null;
  if (inManualCheckoutReentryCooldown()) {
    console.info('[scorr-att] force re-entry deferred (manual checkout cooldown)', { reason });
    return null;
  }
  if (!loadToken() || !SUPABASE_ANON) return null;
  if (!activeWindow(cachedSchedule, scheduleNowMs())) return null;
  reentryKickInflight = true;
  try {
    clearLocalCheckinSuppress({ resetWifiEdge: true });
    const wifi = readWifiIdentity();
    const onOffice = matchesScheduleOfficeWifi(wifi);
    console.info('[scorr-att] force re-entry', { reason, onOffice, ssid: wifi.ssid || null });
    if (onOffice || wifi.ssid || wifi.bssid) {
      return await sendEvent('wifi_connected');
    }
    return await sendEvent('ping');
  } finally {
    reentryKickInflight = false;
  }
}

function haversineMeters(lat1, lon1, lat2, lon2) {
  const toRad = (d) => (d * Math.PI) / 180;
  const R = 6371000;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

/** Windows 10 and Linux: GPS clearly outside every zone checks out. Windows 11 does not. */
async function probeLeaveWhileCheckedIn() {
  if (isWindows11()) return;
  if (!stillSuppressCheckin()) return;
  const zones = (cachedSchedule?.zones || []).filter((z) => {
    const mode = String(z?.detection_mode || 'gps_or_wifi').toLowerCase();
    return mode !== 'wifi_only';
  });
  if (!zones.length) return;
  const fix = await readFreshLocation(100);
  if (!fix || fix.latitude == null || fix.longitude == null) return;
  const outsideAll = zones.every((z) => {
    const lat = Number(z.latitude ?? z.lat);
    const lng = Number(z.longitude ?? z.lng);
    const radius = Math.max(Number(z.radius_meters ?? z.radius ?? 150), 1);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return true;
    const dist = haversineMeters(fix.latitude, fix.longitude, lat, lng);
    return dist == null || dist > radius;
  });
  if (outsideAll) {
    await sendEvent('exit', fix, true);
  }
}

/** Soft GPS read with timeout — mirrors Android soft-fail (Wi-Fi still sent). */
async function readGpsSoft(maxAccuracyM = 50, timeoutMs = 2500) {
  try {
    return await Promise.race([
      readFreshLocation(maxAccuracyM),
      new Promise((resolve) => setTimeout(() => resolve(null), timeoutMs)),
    ]);
  } catch {
    return null;
  }
}

async function sendEvent(event, coords, allowRetry = true, occurredAtUtcMs = null) {
  const token = loadToken();
  if (!token || !SUPABASE_ANON) return null;

  // Suppress spammy enter/wifi/power_on while locally checked in.
  // heartbeat + ping ALWAYS hit the server so a closed session (manual /
  // other-device checkout) can re-open while still in radius or on Wi-Fi.
  if (isCheckinEventName(event) && stillSuppressCheckin()) {
    const e = String(event || '').toLowerCase();
    if (e !== 'heartbeat' && e !== 'ping') {
      return { ok: true, action: 'already_in', reason: 'already_in', ignored: true, client_suppressed: true };
    }
  }

  // After manual Clock Out: block auto check-in until Android’s 30s cadence elapses.
  // Heartbeat still reaches the server (session / leave probes).
  if (isCheckinEventName(event) && inManualCheckoutReentryCooldown()) {
    const e = String(event || '').toLowerCase();
    if (e !== 'heartbeat') {
      return {
        ok: true,
        action: 'none',
        reason: 'manual_checkout_cooldown',
        ignored: true,
        client_suppressed: true,
      };
    }
  }

  const now = Date.now();
  const occurred = occurredAtUtcMs && occurredAtUtcMs > 0 ? occurredAtUtcMs : now;
  if (now - occurred > STALE_EVENT_MAX_AGE_MS) {
    logDesktopStaleDrop(event, occurred, now - occurred, 'desktop-pre-send');
    return { ok: false, reason: 'event_too_old', action: 'event_too_old', client_dropped: true };
  }

  // Android parity: Wi-Fi / office IP first, GPS best-effort. Server: wifi_then_radius.
  // Never block check-in on GPS — office IP matched historically with null lat/lng.
  const wifi = readWifiIdentity();
  let fix = coords && coords.latitude != null ? coords : null;
  const evLower = String(event || '').toLowerCase();
  const checkinLike = isCheckinEventName(event);
  if (!fix && checkinLike) {
    // Windows 11: skip GPS on the first pass. Chromium geolocation can hang the
    // permission UI and starve heartbeats; Wi-Fi still checks in, then radius retries.
    if (isWindows11()) {
      fix = null;
    } else {
      // Tiny GPS budget only — IP/SSID must win quickly (matches Android soft-fail).
      fix = await readGpsSoft(50, wifi.ssid || wifi.bssid ? 600 : 1200);
      if (fix && (fix.error || fix.latitude == null)) fix = null;
    }
  } else if (!fix && (evLower === 'exit' || evLower === 'wifi_disconnected')) {
    if (isWindows11()) {
      fix = null;
    } else if (process.platform === 'win32') {
      fix = await readGpsSoft(50, 800);
    } else {
      fix = await readGpsSoft(50, 2500);
    }
    if (fix && (fix.error || fix.latitude == null)) fix = null;
  }

  if (!SUPABASE_ANON) {
    console.warn('[scorr-att] skip event — no anon key', event);
    return { ok: false, reason: 'missing_anon', action: 'missing_anon' };
  }

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
        ...(isWindows11() ? { platform_variant: 'windows11' } : {}),
        app_version: app.getVersion(),
        latitude: fix?.latitude ?? null,
        longitude: fix?.longitude ?? null,
        accuracy_m: fix?.accuracy_m ?? null,
        ssid: wifi.ssid,
        bssid: wifi.bssid,
        is_mock: false,
      },
    });
  } catch (e) {
    notify('Scorr', 'No connection - will check when online', 'no_connection');
    return { ok: false, reason: 'no_connection', action: 'no_connection' };
  }

  // Retry GPS when server needs radius (same as Android soft GPS retry).
  // Windows: shorter budget so a stuck geolocation prompt cannot freeze Enable/heartbeats.
  if (
    allowRetry &&
    (res?.action === 'need_fresh_location' ||
      res?.action === 'gps_unusable' ||
      res?.action === 'outside_radius' ||
      res?.action === 'not_on_office_wifi' ||
      res?.action === 'not_on_office_network')
  ) {
    const pos = await readGpsSoft(50, isWindows11() ? 900 : 2000);
    if (pos && pos.latitude != null && pos.longitude != null) {
      return sendEvent(event, pos, false);
    }
  }

  if (
    res?.action === 'clock_out' ||
    res?.session_open === false ||
    res?.resume_checkin === true ||
    res?.reason === 'already_checked_out' ||
    res?.reason === 'not_checked_in'
  ) {
    // Capture before clear — only the open→closed transition arms the cooldown.
    const wasLocallyCheckedIn = Boolean(checkedInAttendanceDate);
    // Same as Android markOfficeWifiEdgeReset — allow wifi_connected while still on SSID.
    clearLocalCheckinSuppress({ resetWifiEdge: true });
    // Still on office Wi-Fi after a mid-shift close → same 30s re-entry wait as Android
    // (manual / other-device Clock Out). Do not re-arm on later heartbeats.
    if (
      wasLocallyCheckedIn &&
      matchesScheduleOfficeWifi(wifi) &&
      (res?.action === 'clock_out' ||
        res?.resume_checkin === true ||
        res?.session_open === false)
    ) {
      armManualCheckoutReentryCooldown();
    }
  } else if (
    res?.action !== 'clock_out' &&
    (res?.action === 'clock_in' ||
      res?.action === 'already_in' ||
      res?.suppress_checkin === true)
  ) {
    // Only true suppress — never treat suppress_checkin:false as “still checked in”.
    checkedInAttendanceDate =
      res?.attendance_date ||
      activeWindow(cachedSchedule, Date.now())?.attendance_date ||
      checkedInAttendanceDate ||
      new Date().toISOString().slice(0, 10);
  }

  const nextResult = {
    action: res?.action || null,
    reason: res?.reason || null,
    message: res?.message || null,
    local_time: res?.local_time || null,
    at: new Date().toISOString(),
  };
  if (!lastServerResult || lastServerResult.action !== nextResult.action || lastServerResult.reason !== nextResult.reason) {
    appendWifiLog({ type: 'event', event, ...nextResult, ssid: wifi.ssid, bssid: wifi.bssid });
  }
  lastServerResult = nextResult;

  if (res?.action === 'clock_in') {
    wasOnOfficeWifi = matchesScheduleOfficeWifi(wifi) || wasOnOfficeWifi;
    notify('Scorr', res?.reentry ? 'Checked in again' : 'Checked in', 'check_in');
  } else if (res?.action === 'clock_out') {
    const t = res?.local_time ? ` at ${res.local_time}` : '';
    notify('Scorr', `Checked out${t}`, 'check_out');
  } else if (res?.action === 'already_in') {
    /* quiet — open session; leave or shift-end closes */
  } else if (res?.action === 'not_on_office_wifi' || res?.action === 'not_on_office_network') {
    notify('Scorr', 'Connect to the office Wi-Fi or enter the office radius', 'reminder');
  } else if (res?.action === 'outside_radius') {
    notify('Scorr', 'Not on office Wi-Fi and outside the office radius', 'left_office');
  } else if (res?.action === 'need_fresh_location' || res?.action === 'gps_unusable') {
    /* keep trying on next heartbeat */
  } else if (res?.action === 'checkin_blocked_shift_ended' || res?.action === 'outside_window') {
    /* quiet outside window */
  } else if (
    res?.action === 'checkout_before_shift_start' ||
    res?.action === 'checkout_after_shift_end'
  ) {
    /* quiet — outside checkout window; shift-end closer handles end */
  } else if (res?.action === 'event_too_old') {
    /* ignore */
  }
  // Mid-shift clock_out keeps probing. outside_window pauses until next window wake.
  // Terminal reasons (revoked / platform off) clear enrollment.
  if (res?.stop_tracking && res?.action !== 'clock_out') {
    const stopReason = String(res?.reason || res?.action || '');
    stopHeartbeat();
    if (isTerminalStopReason(stopReason)) {
      clearToken();
    } else {
      armWindowWakeFromSchedule();
    }
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
  if (!loadToken()) return;
  if (!cachedSchedule) {
    cachedSchedule = loadCachedScheduleFromDisk();
  }
  const sched = cachedSchedule;
  if (!sched) {
    // Fetch once; armScheduleLoop will keep retrying.
    void syncSchedule().then(() => {
      if (cachedSchedule && activeWindow(cachedSchedule, scheduleNowMs())) {
        startHeartbeatIfInWindow();
      }
    });
    return;
  }
  const nowMs = scheduleNowMs();
  const win = activeWindow(sched, nowMs);
  if (!win) return;

  // Clear suppress when the active attendance day changes
  if (
    checkedInAttendanceDate &&
    win.attendance_date &&
    String(win.attendance_date) !== String(checkedInAttendanceDate)
  ) {
    checkedInAttendanceDate = null;
  }

  console.info('[scorr-att] heartbeat armed', {
    attendance_date: win.attendance_date,
    window_start_utc: win.window_start_utc,
    window_end_utc: win.window_end_utc,
    has_anon: Boolean(SUPABASE_ANON),
    platform: platformName(),
  });
  if (!SUPABASE_ANON) {
    notify('Scorr', 'Auto check-in is not configured — reinstall the latest desktop app.', 'not_configured');
    return;
  }

  // Immediate present signal (same events Android uses at window arm)
  void sendEvent('power_on');
  lastCheckedInWorkAt = 0;
  heartbeatTimer = setInterval(() => {
    clearHeartbeatInflightIfStuck();
    const w = activeWindow(cachedSchedule, scheduleNowMs());
    if (!w) {
      // Window just ended — same as Android FGS stop: ask server to close open punch.
      if (!heartbeatInflight) {
        markHeartbeatInflight(true);
        void (async () => {
          try {
            await sendEvent('power_off');
          } catch {
            /* ignore */
          } finally {
            markHeartbeatInflight(false);
            stopHeartbeat();
            checkedInAttendanceDate = null;
            checkedInState = null;
            wasOnOfficeWifi = false;
            armWindowWakeFromSchedule();
          }
        })();
      } else {
        stopHeartbeat();
        armWindowWakeFromSchedule();
      }
      return;
    }
    const wifi = readWifiIdentity();
    const onOffice = matchesScheduleOfficeWifi(wifi);

    // Windows 11 only: a blank or failed Wi-Fi read is not "left the office".
    if (isWindows11() && stillSuppressCheckin() && !wifi.ssid && !wifi.bssid) {
      const recent = lastAttendanceStatus && lastAttendanceStatus.kind === 'wifi_lost'
        ? Date.now() - Date.parse(lastAttendanceStatus.at || 0)
        : Infinity;
      if (recent > 60_000) {
        recordAttendanceStatus({
          kind: 'wifi_lost',
          title: 'Scorr',
          body: 'Wi-Fi name was blank. Staying checked in.',
          at: new Date().toISOString(),
        });
      }
    }

    // Windows 10 and Linux: dropping office Wi-Fi while checked in checks out.
    if (!isWindows11() && stillSuppressCheckin() && wasOnOfficeWifi && !onOffice) {
      wasOnOfficeWifi = false;
      if (heartbeatInflight) return;
      markHeartbeatInflight(true);
      void sendEvent('wifi_disconnected').finally(() => {
        markHeartbeatInflight(false);
      });
      return;
    }

    // Rising edge onto office Wi-Fi while checked out → wifi_connected (+ GPS in sendEvent).
    // During manual-checkout cooldown keep wasOnOfficeWifi false so the edge can fire after.
    if (!stillSuppressCheckin() && onOffice && !wasOnOfficeWifi) {
      if (inManualCheckoutReentryCooldown()) {
        if (heartbeatInflight) return;
        const now = Date.now();
        if (now - lastSessionVerifyAt < INTERVAL_SESSION_VERIFY_MS) return;
        lastSessionVerifyAt = now;
        markHeartbeatInflight(true);
        void sendEvent('heartbeat').finally(() => {
          markHeartbeatInflight(false);
        });
        return;
      }
      wasOnOfficeWifi = true;
      if (heartbeatInflight) return;
      markHeartbeatInflight(true);
      void sendEvent('wifi_connected').finally(() => {
        markHeartbeatInflight(false);
      });
      return;
    }
    wasOnOfficeWifi = onOffice || wasOnOfficeWifi;

    if (stillSuppressCheckin()) {
      const now = Date.now();
      if (heartbeatInflight) return;
      // Fast session-verify (3s): discover manual Clock Out while still on office Wi-Fi.
      const dueVerify = now - lastSessionVerifyAt >= INTERVAL_SESSION_VERIFY_MS;
      const dueLeave = now - lastCheckedInWorkAt >= INTERVAL_CHECKED_IN_MS;
      if (!dueVerify && !dueLeave) return;
      if (dueLeave) lastCheckedInWorkAt = now;
      if (dueVerify) lastSessionVerifyAt = now;
      markHeartbeatInflight(true);
      void (async () => {
        try {
          if (!isWindows11()) await probeLeaveWhileCheckedIn();
          const res = await sendEvent('heartbeat');
          // Suppress cleared (manual checkout / resume_checkin) → check in after cooldown.
          if (!stillSuppressCheckin()) {
            await forceReentryCheckin(
              res?.resume_checkin ? 'heartbeat_resume' : 'heartbeat_session_closed',
            );
          }
        } finally {
          markHeartbeatInflight(false);
        }
      })();
      return;
    }

    // Manual Clock Out cooldown: heartbeat only (Android stays on 30s probes until discovery).
    if (inManualCheckoutReentryCooldown()) {
      const now = Date.now();
      if (heartbeatInflight) return;
      if (now - lastSessionVerifyAt < INTERVAL_SESSION_VERIFY_MS) return;
      lastSessionVerifyAt = now;
      markHeartbeatInflight(true);
      void sendEvent('heartbeat').finally(() => {
        markHeartbeatInflight(false);
      });
      return;
    }

    // Checked out: Android sends ping (~1s); Wi-Fi/IP attached (GPS soft, non-blocking).
    lastCheckedInWorkAt = 0;
    if (heartbeatInflight) return;
    markHeartbeatInflight(true);
    void sendEvent('ping').finally(() => {
      markHeartbeatInflight(false);
    });
  }, INTERVAL_CHECKIN_PROBE_MS);
}

function armScheduleLoop() {
  if (scheduleSyncTimer) clearInterval(scheduleSyncTimer);
  // 15s: pick up manual Clock Out from the dashboard quickly (desktop-only cadence).
  // Do NOT restart the 1s heartbeat every tick — that cancelled in-flight pings.
  scheduleSyncTimer = setInterval(async () => {
    await syncSchedule();
    clearHeartbeatInflightIfStuck();
    const inWin = Boolean(cachedSchedule && activeWindow(cachedSchedule, scheduleNowMs()));
    if (inWin && !heartbeatTimer) {
      startHeartbeatIfInWindow();
    } else if (!inWin && heartbeatTimer) {
      startHeartbeatIfInWindow(); // stops + arms wake for next window
    }
  }, 15 * 1000);
  // Immediate kick so Enable / Refresh does not wait a full minute.
  void syncSchedule().then(() => startHeartbeatIfInWindow());
}

/** Usable desktop area for the display that owns (or will own) the window. */
function workAreaFor(win) {
  try {
    if (win && !win.isDestroyed()) {
      const bounds = win.getBounds();
      const display = screen.getDisplayMatching(bounds);
      if (display?.workAreaSize) return display.workAreaSize;
    }
  } catch {
    /* fall through */
  }
  try {
    return screen.getPrimaryDisplay().workAreaSize;
  } catch {
    return { width: 1280, height: 720 };
  }
}

function clampSize(wanted, min, work) {
  const maxW = Math.max(320, Number(work?.width) || 1280);
  const maxH = Math.max(400, Number(work?.height) || 720);
  // Leave a small margin so WMs / taskbars never clip the chrome.
  const fitW = Math.max(280, maxW - 24);
  const fitH = Math.max(360, maxH - 24);
  const minW = Math.min(Math.max(280, Number(min?.width) || 360), fitW);
  const minH = Math.min(Math.max(360, Number(min?.height) || 480), fitH);
  const width = Math.min(Math.max(minW, Number(wanted?.width) || minW), fitW);
  const height = Math.min(Math.max(minH, Number(wanted?.height) || minH), fitH);
  return { width: Math.round(width), height: Math.round(height), minWidth: Math.round(minW), minHeight: Math.round(minH) };
}

/**
 * Win11 / high-DPI: Chromium sometimes keeps a 0-size content view after
 * programmatic resize (login → workspace). Nudge bounds + fire resize so React
 * and 100dvh layouts repaint. No-op on Linux/macOS.
 */
function recoverWindowsContentView(win) {
  if (process.platform !== 'win32' || !win || win.isDestroyed()) return;
  const nudge = () => {
    if (!win || win.isDestroyed()) return;
    try {
      const b = win.getBounds();
      win.setBounds({ ...b, width: Math.max(320, b.width + 1) }, false);
      win.setBounds(b, false);
    } catch {
      /* ignore */
    }
    try {
      win.webContents.invalidate();
    } catch {
      /* ignore */
    }
    try {
      void win.webContents.executeJavaScript(
        `(function () {
          try {
            var h = Math.max(window.innerHeight || 0, document.documentElement.clientHeight || 0, 400);
            var w = Math.max(window.innerWidth || 0, document.documentElement.clientWidth || 0, 320);
            document.documentElement.style.height = h + 'px';
            document.documentElement.style.width = w + 'px';
            if (document.body) {
              document.body.style.height = h + 'px';
              document.body.style.minHeight = h + 'px';
            }
            var root = document.getElementById('root');
            if (root) {
              root.style.height = h + 'px';
              root.style.minHeight = h + 'px';
            }
            window.dispatchEvent(new Event('resize'));
          } catch (e) {}
        })();`,
        true,
      );
    } catch {
      /* ignore */
    }
  };
  // Two ticks: after DPI layout and after Chromium commits the new size.
  setTimeout(nudge, 16);
  setTimeout(nudge, 120);
  setTimeout(nudge, 400);
}

function applyWindowSize(win, wanted, min, { animate = false, center = false } = {}) {
  if (!win || win.isDestroyed()) return null;
  const sized = clampSize(wanted, min, workAreaFor(win));
  const isWin = process.platform === 'win32';
  try {
    // On Windows, lowering min first avoids stuck content views when growing
    // from the compact Sign In size to the workspace size.
    if (isWin) win.setMinimumSize(1, 1);
    else win.setMinimumSize(sized.minWidth, sized.minHeight);
  } catch {
    /* ignore */
  }
  try {
    if (isWin) {
      // Prefer setBounds (no animation) — setSize+center blanked the webview on Win11 Pro.
      const cur = win.getBounds();
      let x = cur.x;
      let y = cur.y;
      if (center) {
        try {
          const wa = screen.getDisplayMatching(cur).workArea;
          x = Math.round(wa.x + (wa.width - sized.width) / 2);
          y = Math.round(wa.y + (wa.height - sized.height) / 2);
        } catch {
          /* keep current origin */
        }
      }
      win.setBounds({ x, y, width: sized.width, height: sized.height }, false);
      try {
        win.setMinimumSize(sized.minWidth, sized.minHeight);
      } catch {
        /* ignore */
      }
      recoverWindowsContentView(win);
    } else {
      // animate=true can leave a 0-height content view on some Linux WMs / small screens.
      win.setSize(sized.width, sized.height, Boolean(animate));
      if (center) {
        try {
          win.center();
        } catch {
          /* ignore */
        }
      }
    }
  } catch {
    try {
      win.setBounds({ ...win.getBounds(), width: sized.width, height: sized.height });
    } catch {
      /* ignore */
    }
    if (isWin) recoverWindowsContentView(win);
  }
  return sized;
}

function showLoadErrorPage(win, detail) {
  if (!win || win.isDestroyed()) return;
  const safeDetail = String(detail || 'Unknown error')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
  const html = `<!DOCTYPE html><html><head><meta charset="utf-8"/><title>Scorr</title>
<style>
  html,body{height:100%;margin:0;font-family:system-ui,sans-serif;background:#f1f5f9;color:#0f172a}
  main{min-height:100%;display:flex;flex-direction:column;align-items:center;justify-content:center;padding:1.5rem;text-align:center;box-sizing:border-box}
  h1{font-size:1.25rem;margin:0 0 .5rem}
  p{color:#475569;max-width:28rem;line-height:1.45}
  button{margin-top:1rem;padding:.65rem 1.1rem;border:0;border-radius:10px;background:#0d9488;color:#fff;font-weight:600;cursor:pointer}
  code{font-size:.8rem;color:#64748b;word-break:break-all}
</style></head><body><main>
  <h1>Could not load Scorr</h1>
  <p>Check your internet connection, then try again. The desktop app needs to reach scorr.walfia.ai.</p>
  <p><code>${safeDetail}</code></p>
  <button type="button" onclick="location.href=${JSON.stringify(APP_URL)}">Retry</button>
</main></body></html>`;
  void win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
}

/**
 * Force correct MIME types for scorr.walfia.ai assets inside Electron.
 * Some Windows proxies / AV / broken Content-Type maps return text/plain for .css,
 * which Chromium refuses — blank screen after login. Never trust the network header alone.
 */
function installAssetMimeOverrides(ses) {
  if (!ses || ses.__scorrAssetMimeFixed) return;
  ses.__scorrAssetMimeFixed = true;
  try {
    ses.webRequest.onHeadersReceived((details, callback) => {
      try {
        const url = String(details.url || '');
        if (!/scorr\.walfia\.ai/i.test(url)) {
          callback({ responseHeaders: details.responseHeaders });
          return;
        }
        let pathname = '';
        try {
          pathname = new URL(url).pathname;
        } catch {
          pathname = url.split('?')[0] || '';
        }
        const lower = pathname.toLowerCase();
        let mime = null;
        if (lower.endsWith('.css')) mime = 'text/css; charset=utf-8';
        else if (lower.endsWith('.mjs') || lower.endsWith('.js')) mime = 'text/javascript; charset=utf-8';
        else if (lower.endsWith('.json')) mime = 'application/json';
        else if (lower.endsWith('.svg')) mime = 'image/svg+xml';
        else if (lower.endsWith('.woff2')) mime = 'font/woff2';
        if (!mime) {
          callback({ responseHeaders: details.responseHeaders });
          return;
        }
        const headers = { ...(details.responseHeaders || {}) };
        for (const key of Object.keys(headers)) {
          if (key.toLowerCase() === 'content-type') delete headers[key];
        }
        headers['Content-Type'] = [mime];
        callback({ responseHeaders: headers });
      } catch {
        callback({ responseHeaders: details.responseHeaders });
      }
    });
  } catch (e) {
    console.warn('[scorr] installAssetMimeOverrides failed', e);
  }
}

/** @type {boolean} */
let mainWindowStartHidden = false;

function showMainWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) {
    createWindow({ startHidden: false });
    return;
  }
  mainWindowStartHidden = false;
  try {
    mainWindow.setSkipTaskbar(false);
  } catch {
    /* ignore */
  }
  try {
    if (mainWindow.isMinimized()) mainWindow.restore();
  } catch {
    /* ignore */
  }
  mainWindow.show();
  mainWindow.focus();
}

/**
 * @param {{ startHidden?: boolean }} [opts]
 * Hidden start: keep BrowserWindow loaded (token rehydrate + GPS) but never show —
 * required for Linux/Win11 autostart background check-in without a visible UI.
 */
function createWindow(opts = {}) {
  const startHidden = Boolean(opts.startHidden);
  mainWindowStartHidden = startHidden;
  const initial = clampSize(LOGIN_SIZE, LOGIN_MIN, workAreaFor(null));
  // MIME override + preload BEFORE creating the window (Windows blank-screen fix).
  installAssetMimeOverrides(session.defaultSession);
  registerSessionPreload(session.defaultSession);
  console.info(
    '[scorr] preload path',
    PRELOAD_PATH,
    'exists=',
    fs.existsSync(PRELOAD_PATH),
    'startHidden=',
    startHidden,
  );

  mainWindow = new BrowserWindow({
    width: initial.width,
    height: initial.height,
    minWidth: initial.minWidth,
    minHeight: initial.minHeight,
    title: `Scorr Desktop ${app.getVersion()}`,
    icon: path.join(__dirname, 'icon.png'),
    backgroundColor: '#f1f5f9',
    autoHideMenuBar: true,
    skipTaskbar: startHidden,
    webPreferences: {
      // Remote https://scorr.walfia.ai UI: contextIsolation:false + window.scorrDesktop
      // assign in preload is the reliable path on Linux. Isolation+contextBridge alone
      // left UA="ScorrDesktop" with window.scorrDesktop undefined → Enable blocked.
      preload: PRELOAD_PATH,
      contextIsolation: false,
      nodeIntegration: false,
      sandbox: false,
      webSecurity: true,
    },
    show: false,
  });

  const ses = mainWindow.webContents.session;
  installAssetMimeOverrides(ses);
  registerSessionPreload(ses);
  ses.setUserAgent(`${ses.getUserAgent()} ScorrDesktop/${app.getVersion()}`);
  try {
    mainWindow.setTitle(`Scorr Desktop ${app.getVersion()}`);
  } catch {
    /* ignore */
  }

  mainWindow.webContents.on('preload-error', (_event, preloadPath, error) => {
    console.error('[scorr] preload-error', preloadPath, error);
    try {
      if (Notification.isSupported()) {
        new Notification({
          title: 'Scorr',
          body: 'Desktop bridge failed to load. Quit Scorr (tray too) and reinstall from GitHub Releases.',
        }).show();
      }
    } catch {
      /* ignore */
    }
  });

  let shown = false;
  const reveal = () => {
    // Autostart / --hidden: stay in tray; do not pop the Sign In window.
    if (startHidden || mainWindowStartHidden) return;
    if (shown || !mainWindow || mainWindow.isDestroyed()) return;
    shown = true;
    // Re-clamp in case the display work area was smaller than the preferred login size.
    applyWindowSize(mainWindow, LOGIN_SIZE, LOGIN_MIN, { center: true });
    mainWindow.show();
    mainWindow.focus();
  };

  if (!startHidden) {
    mainWindow.once('ready-to-show', reveal);
    // Never stay invisible if ready-to-show is skipped (slow/failed paint).
    setTimeout(reveal, 4000);
  }

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: 'deny' };
  });

  mainWindow.webContents.on('did-fail-load', (_e, errorCode, errorDescription, validatedURL, isMainFrame) => {
    if (!isMainFrame) return;
    // -3 = aborted (navigation superseded); ignore.
    if (errorCode === -3) return;
    console.warn('[scorr] did-fail-load', errorCode, errorDescription, validatedURL);
    showLoadErrorPage(mainWindow, `${errorDescription || 'load failed'} (${errorCode})`);
    reveal();
  });

  // Mark Electron shell as early as possible (before React paints “Browser”).
  mainWindow.webContents.on('dom-ready', () => {
    injectElectronShellMarker(mainWindow.webContents);
  });

  // Verify bridge after every navigation — log loudly if still missing.
  // One-shot reload: some Linux boots attach preload after the first navigation.
  let bridgeReloadAttempted = false;
  mainWindow.webContents.on('did-finish-load', () => {
    injectElectronShellMarker(mainWindow.webContents);
    registerSessionPreload(mainWindow.webContents.session);
    void mainWindow.webContents
      .executeJavaScript(
        `Boolean(window.scorrDesktop && window.scorrDesktop.isDesktop && typeof window.scorrDesktop.saveAttendanceToken === 'function')`,
      )
      .then((ok) => {
        if (!ok) {
          console.error(
            '[scorr] window.scorrDesktop MISSING after load — auto check-in cannot arm. preload=',
            PRELOAD_PATH,
            'exists=',
            fs.existsSync(PRELOAD_PATH),
          );
          if (!bridgeReloadAttempted && fs.existsSync(PRELOAD_PATH)) {
            bridgeReloadAttempted = true;
            console.warn('[scorr] retrying loadURL once to re-attach preload');
            setTimeout(() => {
              if (mainWindow && !mainWindow.isDestroyed()) {
                void mainWindow.loadURL(APP_URL).catch(() => {});
              }
            }, 400);
          }
        } else {
          console.info('[scorr] window.scorrDesktop OK');
        }
      })
      .catch((e) => console.warn('[scorr] bridge probe failed', e));
  });

  // Drop PWA service workers that can confuse the remote UI inside Electron.
  void (async () => {
    try {
      await ses.clearStorageData({
        storages: ['serviceworkers', 'cachestorage'],
        origin: 'https://scorr.walfia.ai',
      });
    } catch {
      /* ignore */
    }
    try {
      await mainWindow.loadURL(APP_URL);
    } catch (err) {
      console.warn('[scorr] loadURL failed', err);
      showLoadErrorPage(mainWindow, err instanceof Error ? err.message : String(err));
      reveal();
    }
  })();

  mainWindow.on('close', (e) => {
    if (!loadToken()) return;
    if (isWindows11() || process.platform === 'linux') {
      // Windows 11 reuses the tray process. Linux keeps the current hide-to-tray
      // path so a missing AppIndicator does not quit the heartbeat.
      e.preventDefault();
      mainWindow?.hide();
      if (!tray) {
        try {
          setupTray();
        } catch {
          /* ignore */
        }
      }
      return;
    }
    // Windows 10 and macOS: hide only when the tray icon exists.
    if (tray) {
      e.preventDefault();
      mainWindow?.hide();
    }
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
    workspaceExpanded = false;
    mainWindowStartHidden = false;
  });
}

function expandToWorkspace() {
  if (!mainWindow || mainWindow.isDestroyed() || workspaceExpanded) return;
  workspaceExpanded = true;
  // Win11 Pro: compact → large setSize often leaves a blank webview. Maximize
  // (or setBounds + recover) so the dashboard paints after login.
  if (process.platform === 'win32') {
    try {
      if (mainWindow.isMinimized()) mainWindow.restore();
      applyWindowSize(mainWindow, WORKSPACE_SIZE, WORKSPACE_MIN, { center: true });
      try {
        if (!mainWindow.isMaximized()) mainWindow.maximize();
      } catch {
        /* ignore */
      }
      try {
        mainWindow.show();
        mainWindow.focus();
      } catch {
        /* ignore */
      }
      recoverWindowsContentView(mainWindow);
      return;
    } catch {
      /* fall through to generic resize */
    }
  }
  applyWindowSize(mainWindow, WORKSPACE_SIZE, WORKSPACE_MIN, { center: true });
}

function shrinkToLogin() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  workspaceExpanded = false;
  if (process.platform === 'win32') {
    try {
      if (mainWindow.isMaximized()) mainWindow.unmaximize();
    } catch {
      /* ignore */
    }
  }
  applyWindowSize(mainWindow, LOGIN_SIZE, LOGIN_MIN, { center: true });
}

function setupTray() {
  if (tray) return;
  try {
    const icon = nativeImage.createFromPath(path.join(__dirname, 'icon.png'));
    tray = new Tray(icon.resize({ width: 16, height: 16 }));
    tray.setToolTip('Scorr attendance');
    tray.setContextMenu(
      Menu.buildFromTemplate([
        {
          label: 'Open Scorr',
          click: () => showMainWindow(),
        },
        {
          label: 'Sync schedule',
          click: () => void syncSchedule().then(() => startHeartbeatIfInWindow()),
        },
        { type: 'separator' },
        {
          label: 'Quit',
          click: () => {
            // Keep enrollment token — auto-launch / next open still checks in.
            // Turn off only via Settings → Automatic check-in → Turn off.
            app.exit(0);
          },
        },
      ]),
    );
  } catch (e) {
    console.warn('[scorr] tray unavailable', e);
    tray = null;
  }
}

function wirePowerEvents() {
  powerMonitor.on('resume', () => {
    void syncSchedule().then(() => {
      startHeartbeatIfInWindow();
      // Fresh location on wake / reconnect path.
      void sendEvent('power_on');
    });
  });
  powerMonitor.on('unlock-screen', () => {
    void sendEvent('heartbeat');
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

// Prefer a single process so autostart (--hidden) + later Start Menu open share
// the same heartbeat instead of spawning a second UI-only instance.
const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    showMainWindow();
  });
  // Default: start at login headless when the OS supports it. Enable also re-applies.
  try {
    configureAutoLaunch(true);
  } catch {
    /* ignore */
  }
}

const DAILY_UPDATE_HOUR = 5; // local 5:00 AM
const UPDATE_CHECK_STAMP = () => path.join(app.getPath('userData'), 'last-update-check.txt');

function isNewerDesktopVersion(remote, local) {
  const parse = (v) =>
    String(v || '0')
      .replace(/^v/i, '')
      .split(/[.+-]/)
      .map((p) => Number.parseInt(p, 10) || 0);
  const a = parse(remote);
  const b = parse(local);
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i += 1) {
    const x = a[i] || 0;
    const y = b[i] || 0;
    if (x > y) return true;
    if (x < y) return false;
  }
  return false;
}

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

/**
 * NSIS + AppImage support silent electron-updater install.
 * .deb installs cannot silently replace themselves — fall back to opening the download.
 */
function desktopPackageKind() {
  if (process.platform === 'win32') return 'nsis';
  if (process.env.APPIMAGE) return 'appimage';
  try {
    const exe = String(process.execPath || '');
    if (/Scorr\.AppImage$/i.test(exe) || /\.AppImage$/i.test(exe)) return 'appimage';
    if (/\/opt\/Scorr\//i.test(exe) || /\/usr\/(bin|lib|share)\//i.test(exe)) return 'deb';
  } catch {
    /* ignore */
  }
  return process.platform === 'linux' ? 'deb' : 'unknown';
}

function desktopCanSilentInstall() {
  const kind = desktopPackageKind();
  return kind === 'nsis' || kind === 'appimage';
}

function sendUpdateStatus(payload) {
  try {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('scorr:update-status', payload);
    }
  } catch {
    /* ignore */
  }
}

function setupAutoUpdater() {
  if (!autoUpdater || !app.isPackaged) return;
  try {
    autoUpdater.autoDownload = true;
    autoUpdater.autoInstallOnAppQuit = true;
    // Generic feed on scorr.walfia.ai (latest.yml points at GitHub Release binaries).
    // Must stay deployed — a 404 here means installed desktops never see new versions.
    autoUpdater.setFeedURL({
      provider: 'generic',
      url: 'https://scorr.walfia.ai/downloads/desktop/',
      useMultipleRangeRequest: false,
    });
    let installing = false;
    /** @type {NodeJS.Timeout | null} */
    let dailyTimer = null;

    autoUpdater.on('error', (err) => {
      const message = err?.message || String(err);
      console.warn('[scorr] autoUpdater error', message);
      sendUpdateStatus({ phase: 'error', message: `Update failed: ${message}` });
    });

    autoUpdater.on('checking-for-update', () => {
      sendUpdateStatus({ phase: 'checking', message: '' });
    });

    autoUpdater.on('update-available', (info) => {
      const version = info?.version || '';
      if (!desktopCanSilentInstall()) {
        sendUpdateStatus({
          phase: 'manual',
          version,
          packageKind: desktopPackageKind(),
          message:
            `Update ${version} is available. .deb cannot silent-install — opening the download. Prefer the AppImage for background updates.`,
        });
        return;
      }
      sendUpdateStatus({ phase: 'available', version, message: '' });
    });

    autoUpdater.on('update-not-available', () => {
      sendUpdateStatus({
        phase: 'none',
        version: app.getVersion(),
        message: 'You are on the latest version.',
      });
    });

    autoUpdater.on('download-progress', (progress) => {
      const pct = Math.max(0, Math.min(100, Math.round(Number(progress?.percent) || 0)));
      sendUpdateStatus({ phase: 'downloading', percent: pct, message: '' });
    });

    autoUpdater.on('update-downloaded', (info) => {
      if (installing) return;
      installing = true;
      const version = info?.version || '';
      // Silent background install — no OS toast / in-app “Updating…” banner.
      sendUpdateStatus({
        phase: 'installing',
        version,
        message: '',
        autoInstall: true,
      });
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('scorr:update-ready', {
          version,
          message: '',
          autoInstall: true,
        });
      }
      setTimeout(() => {
        try {
          sendUpdateStatus({ phase: 'restarting', version, message: '' });
          autoUpdater.quitAndInstall(false, true);
        } catch (e) {
          console.warn('quitAndInstall failed; will install on next quit', e);
          installing = false;
          sendUpdateStatus({
            phase: 'pending-quit',
            version,
            message: 'Update ready — will install when Scorr quits.',
          });
        }
      }, 600);
    });

    const check = (reason = 'scheduled') => {
      console.log(`[scorr] update check (${reason}) feed=https://scorr.walfia.ai/downloads/desktop/`);
      markDesktopUpdateChecked();
      autoUpdater.autoDownload = desktopCanSilentInstall();
      void autoUpdater.checkForUpdates().catch((e) => {
        console.warn('[scorr] checkForUpdates failed', e);
        sendUpdateStatus({
          phase: 'error',
          message: e instanceof Error ? e.message : String(e),
        });
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

    // Every launch + daily ~5 AM + resume when the daily window is due.
    setTimeout(() => check('launch'), 12_000);
    armDailyTimer();

    powerMonitor.on('resume', () => {
      if (shouldRunDesktopDailyCheck()) check('power-resume');
      else check('power-resume-soft');
    });
  } catch (e) {
    console.warn('autoUpdater setup failed', e);
  }
}

app.whenReady().then(async () => {
  if (!gotSingleInstanceLock) return;

  // MIME fix before any window loads remote UI (Windows Content-Type: text/plain bug).
  installAssetMimeOverrides(session.defaultSession);

  // Attach preload to every webContents (guards against session/partition edge cases on Linux).
  app.on('web-contents-created', (_event, contents) => {
    try {
      installAssetMimeOverrides(contents.session);
      registerSessionPreload(contents.session);
    } catch {
      /* ignore */
    }
    contents.on('dom-ready', () => injectElectronShellMarker(contents));
  });

  ipcMain.handle('scorr:setAutoLaunch', (_e, enabled) => {
    const on = configureAutoLaunch(Boolean(enabled));
    return { ok: true, enabled: on };
  });
  ipcMain.handle('scorr:getAutoLaunch', () => {
    return { enabled: readAutoLaunchEnabled() };
  });
  ipcMain.handle('scorr:checkForUpdates', async () => {
    if (!autoUpdater || !app.isPackaged) {
      return { ok: false, message: 'Updates run in the installed desktop app.' };
    }
    try {
      markDesktopUpdateChecked();
      const kind = desktopPackageKind();
      const silent = desktopCanSilentInstall();
      autoUpdater.autoDownload = silent;
      sendUpdateStatus({ phase: 'checking', message: 'Checking for updates…' });
      const result = await autoUpdater.checkForUpdates();
      const remote = String(result?.updateInfo?.version || '');
      const local = app.getVersion();
      if (remote && isNewerDesktopVersion(remote, local)) {
        if (!silent) {
          const fallbackUrl =
            process.platform === 'win32'
              ? 'https://scorr.walfia.ai/downloads/Scorr-Setup.exe'
              : 'https://scorr.walfia.ai/downloads/Scorr.AppImage';
          try {
            await shell.openExternal(fallbackUrl);
          } catch {
            /* ignore */
          }
          sendUpdateStatus({
            phase: 'manual',
            version: remote,
            packageKind: kind,
            message:
              `Update ${remote} opened in your browser. .deb cannot silent-install — install the AppImage (or new .deb) then reopen Scorr.`,
          });
          return {
            ok: true,
            updateAvailable: true,
            autoInstall: false,
            packageKind: kind,
            version: remote,
            downloadUrl: fallbackUrl,
            message:
              `Update ${remote} opened in your browser. .deb cannot silent-install — prefer the AppImage for background updates.`,
          };
        }
        // autoDownload=true → download starts; update-downloaded → quitAndInstall
        sendUpdateStatus({
          phase: 'downloading',
          version: remote,
          message: `Downloading update ${remote}…`,
        });
        return {
          ok: true,
          updateAvailable: true,
          autoInstall: true,
          packageKind: kind,
          version: remote,
          message: `Downloading update ${remote}… Installing automatically when ready.`,
        };
      }
      sendUpdateStatus({
        phase: 'none',
        version: local,
        message: `Desktop binary ${local} is up to date.`,
      });
      return {
        ok: true,
        updateAvailable: false,
        version: local,
        message: `Desktop binary ${local} is up to date.`,
      };
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      sendUpdateStatus({ phase: 'error', message });
      return { ok: false, message };
    }
  });
  ipcMain.handle('scorr:probeWifi', () => readWifiIdentity());
  ipcMain.handle('scorr:openLocationSettings', () => {
    if (process.platform !== 'win32') return { ok: false };
    void shell.openExternal('ms-settings:privacy-location');
    return { ok: true };
  });
  ipcMain.handle('scorr:wifiDiagnostics', async () => {
    const wifi = readWifiIdentity();
    if (process.platform === 'win32' && !cachedPublicIp) {
      try {
        await new Promise((resolve) => {
          const req = require('https').get('https://api.ipify.org', { timeout: 2500 }, (res) => {
            let body = '';
            res.on('data', (chunk) => { body += chunk; });
            res.on('end', () => {
              const ip = String(body || '').trim();
              if (/^\d{1,3}(\.\d{1,3}){3}$/.test(ip)) cachedPublicIp = ip;
              resolve();
            });
          });
          req.on('error', () => resolve());
          req.setTimeout(2500, () => {
            req.destroy();
            resolve();
          });
        });
      } catch {
        /* ignore */
      }
    }
    const locationAllowed = process.platform === 'win32' ? readWindowsLocationAllowed() : null;
    const ssidHidden = Boolean(lastWifiProbe?.ssidBlank) && locationAllowed === false;
    const matchesSaved = matchesScheduleOfficeWifi(wifi);
    let statusLine = 'Not checked in yet';
    if (lastServerResult?.action === 'clock_in' || lastServerResult?.action === 'already_in') {
      const via = wifi.ssid ? `office Wi-Fi (${wifi.ssid})` : 'the office network';
      const when = lastServerResult.local_time ? ` at ${lastServerResult.local_time}` : '';
      statusLine = `Checked in${when} via ${via}`;
    } else if (lastServerResult?.action === 'clock_out') {
      statusLine = lastServerResult.local_time
        ? `Checked out at ${lastServerResult.local_time}`
        : 'Checked out';
    } else if (lastServerResult?.message) {
      statusLine = String(lastServerResult.message);
    }
    const win11 = isWindows11();
    const trayRunning = Boolean(tray);
    if (!loadToken()) {
      statusLine = 'If Scorr is not running, nothing can check in.';
    } else if (win11 && !trayRunning) {
      statusLine = 'Scorr is open, but the tray process is not running. Closing the window quits check-in.';
    }
    const snap = {
      platform: process.platform,
      platformVariant: win11 ? 'windows11' : null,
      windowsVersion: process.platform === 'win32'
        ? `${readWindowsVersionLabel()} (build ${windowsBuildNumber() || 'unknown'})`
        : '',
      windowsBuild: process.platform === 'win32' ? windowsBuildNumber() : null,
      locationAllowed,
      locationMessage: win11 && ssidHidden ? LOCATION_MESSAGE : null,
      ssid: wifi.ssid,
      bssid: wifi.bssid,
      publicIp: cachedPublicIp || null,
      matchesSaved,
      lastResult: lastServerResult,
      autoLaunch: readAutoLaunchEnabled(),
      trayRunning,
      appRunning: true,
      statusLine,
      logPath: win11 ? wifiLogPath() : null,
    };
    appendWifiLog({ type: 'diagnostics', ...snap });
    return snap;
  });
  ipcMain.handle('scorr:prepareAutoAttendance', async () => {
    // Never throw — Enable must succeed once the token is saved.
    // Keep this fast: Windows netsh / GPS must not block arming.
    try {
      try {
        configureAutoLaunch(true);
      } catch {
        /* Linux may not support login items — XDG file still written inside */
      }
      try {
        setupTray();
      } catch {
        /* ignore */
      }
      if (loadToken()) armScheduleLoop();
      let notifications = 'unknown';
      try {
        // Windows 11 does not ask for notification permission. Windows 10 still can.
        if (isWindows11()) notifications = 'not_requested';
        else if (Notification.isSupported()) notifications = 'granted';
      } catch {
        notifications = 'unknown';
      }
      let location = 'unknown';
      try {
        if (isWindows11()) {
          location = 'unknown';
        } else {
          const fix = await Promise.race([
            readFreshLocation(100),
            new Promise((resolve) => setTimeout(() => resolve(null), 1200)),
          ]);
          location = fix && fix.latitude != null ? 'granted' : fix?.error === 'denied' ? 'denied' : 'unknown';
        }
      } catch {
        location = 'unknown';
      }
      let wifi = { ssid: null, bssid: null };
      try {
        // Off the IPC critical path if probe stalls (netsh / nmcli).
        wifi = await Promise.race([
          new Promise((resolve) => {
            setImmediate(() => {
              try {
                resolve(readWifiIdentity());
              } catch {
                resolve({ ssid: null, bssid: null });
              }
            });
          }),
          new Promise((resolve) => setTimeout(() => resolve({ ssid: null, bssid: null }), 900)),
        ]);
      } catch {
        /* ignore */
      }
      return {
        ok: Boolean(loadToken()),
        autoLaunch: true,
        notifications,
        location,
        wifiOk: Boolean(wifi.ssid || wifi.bssid),
        wifi,
        armed: Boolean(loadToken() && heartbeatTimer),
      };
    } catch (e) {
      console.warn('[scorr-att] prepareAutoAttendance failed', e);
      if (loadToken()) {
        try {
          armScheduleLoop();
        } catch {
          /* ignore */
        }
      }
      return { ok: Boolean(loadToken()), armed: Boolean(heartbeatTimer) };
    }
  });
  ipcMain.handle('scorr:quitAndInstall', () => {
    sendUpdateStatus({ phase: 'restarting', message: 'Restarting to finish install…' });
    if (autoUpdater) autoUpdater.quitAndInstall(false, true);
    return { ok: true };
  });
  session.defaultSession.setPermissionRequestHandler((_wc, permission, callback) => {
    const allow = permission === 'geolocation' || permission === 'notifications';
    callback(allow);
  });

  ipcMain.on('scorr:workspace', () => expandToWorkspace());
  ipcMain.on('scorr:login', () => shrinkToLogin());
  ipcMain.handle('scorr:getAppVersion', () => app.getVersion());
  ipcMain.handle('scorr:saveAttendanceToken', (_e, token) => {
    const raw = token == null ? '' : String(token).trim();
    if (!raw) {
      console.warn('[scorr-att] saveAttendanceToken called with empty token');
      return false;
    }
    // Memory + disk; never throw to renderer. Always keep memory copy so Windows
    // DPAPI / file races cannot make Enable return false after a successful write.
    memoryAttendanceToken = raw;
    let saved = false;
    try {
      saved = Boolean(saveToken(raw));
    } catch (e) {
      console.warn('[scorr-att] saveToken threw', e);
      memoryAttendanceToken = raw;
      saved = true;
    }
    if (!saved) {
      memoryAttendanceToken = raw;
      saved = true;
    }
    // Arm off the IPC return path so Windows Enable never waits on schedule/netsh.
    if (saved) {
      setImmediate(() => {
        try {
          armScheduleLoop();
        } catch (e) {
          console.warn('[scorr-att] armScheduleLoop after save failed', e);
        }
      });
    }
    // Return plain boolean — older web + newer web both treat `true` as armed.
    return Boolean(memoryAttendanceToken || loadToken());
  });
  ipcMain.handle('scorr:clearAttendanceToken', () => {
    clearToken();
    stopHeartbeat();
    return true;
  });
  ipcMain.handle('scorr:manualCheckout', async () => {
    // Dashboard Clock Out — match Android: clear local suppress, but wait
    // INTERVAL_CHECKED_IN_MS (30s) before auto wifi_connected/ping re-entry.
    armManualCheckoutReentryCooldown();
    clearLocalCheckinSuppress({ resetWifiEdge: true });
    await syncSchedule();
    startHeartbeatIfInWindow();
    return { ok: true, action: null, cooldown_ms: MANUAL_CHECKOUT_REENTRY_COOLDOWN_MS };
  });
  ipcMain.handle('scorr:hasAttendanceToken', () => Boolean(loadToken()));
  ipcMain.handle('scorr:saveLoginCredentials', (_e, email, password) => saveLoginCredentials(email, password));
  ipcMain.handle('scorr:loadLoginCredentials', () => loadLoginCredentials());
  ipcMain.handle('scorr:clearLoginCredentials', () => clearLoginCredentials());
  ipcMain.handle('scorr:saveTrustedDeviceToken', (_e, token) => saveTrustedDeviceToken(token));
  ipcMain.handle('scorr:loadTrustedDeviceToken', () => loadTrustedDeviceToken());
  ipcMain.handle('scorr:clearTrustedDeviceToken', () => clearTrustedDeviceToken());

  setupTray();
  wirePowerEvents();

  // Arm main-process heartbeat BEFORE (or without) a visible window — this is what
  // Android FGS / Win10 tray already do. Hidden autostart must not wait on Sign In.
  const startHidden = isWindows11() ? argvWantsHiddenStart() : process.platform === 'linux' && argvWantsHiddenStart();
  console.info('[scorr-att] boot', {
    startHidden,
    hasToken: Boolean(loadToken()),
    platform: platformName(),
    argv: process.argv.slice(1),
  });

  if (loadToken()) {
    try {
      configureAutoLaunch(true);
    } catch {
      /* ignore */
    }
    await syncSchedule();
    startHeartbeatIfInWindow();
    armScheduleLoop();
  }

  // Always create a BrowserWindow (show:false when --hidden) so GPS + localStorage
  // token rehydrate (SilentGeoAttendance on Sign In) work without a visible UI.
  createWindow({ startHidden });
  setupAutoUpdater();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow({ startHidden: false });
    else showMainWindow();
  });
});

app.on('before-quit', () => {
  void sendEvent('power_off');
});

app.on('window-all-closed', () => {
  // Keep the process alive for background attendance when enrolled (Linux/Win11).
  if (loadToken()) return;
  if (process.platform !== 'darwin') app.quit();
});
