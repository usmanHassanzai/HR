/**
 * Electron laptop automatic attendance (Section H / R45–R53).
 * powerMonitor suspend/resume/shutdown + windowed heartbeat:
 *   checked out → ~1s Wi-Fi/radius check-in probes;
 *   checked in  → slower leave + session-verify only.
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
const { execFileSync } = require('child_process');
const { net } = require('electron');

/**
 * SCORR_SIMULATE_WINDOWS_BUILD is a test-only override (for example 19045 or 22621).
 * When it is unset, it is ignored: Windows reads CurrentBuild from the registry,
 * and Linux, Android, iOS, and browsers stay on the 1.3.45 path.
 */
function windowsBuildNumber() {
  const forced = process.env.SCORR_SIMULATE_WINDOWS_BUILD;
  if (forced != null && String(forced).trim() !== '') {
    const n = Number.parseInt(String(forced).trim(), 10);
    if (Number.isFinite(n)) return n;
  }
  if (process.platform !== 'win32') return null;
  try {
    const out = execFileSync(
      'reg',
      ['query', 'HKLM\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion', '/v', 'CurrentBuild'],
      { encoding: 'utf8', windowsHide: true, timeout: 4000 },
    );
    const match = out.match(/CurrentBuild\s+REG_\w+\s+(\d+)/i);
    return match ? Number.parseInt(match[1], 10) : null;
  } catch {
    return null;
  }
}

function isWindows11() {
  const build = windowsBuildNumber();
  if (!(Number.isFinite(build) && build >= 22000)) return false;
  if (process.platform === 'win32') return true;
  return String(process.env.SCORR_SIMULATE_WINDOWS_BUILD || '').trim() !== '';
}

function attendancePlatformFields() {
  return isWindows11() ? { platform_variant: 'windows11' } : {};
}

function setStartupEntry(enabled) {
  const on = Boolean(enabled);
  if (isWindows11()) {
    app.setLoginItemSettings({
      openAtLogin: on,
      openAsHidden: true,
      args: on ? ['--hidden'] : [],
    });
    return;
  }
  app.setLoginItemSettings({ openAtLogin: on, openAsHidden: true });
}

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
const CHECKED_IN_FILE = () => path.join(app.getPath('userData'), 'attendance-checked-in.json');
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
/** Leave + session-verify while open session (no check-in spam). */
const INTERVAL_CHECKED_IN_MS = 30 * 1000;
let lastCheckedInWorkAt = 0;
let heartbeatInflight = false;

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
    cachedSchedule = data;
    // Manual / other-device checkout: clear local suppress so re-entry can fire.
    if (Object.prototype.hasOwnProperty.call(data, 'session_open') && data.session_open === false) {
      checkedInAttendanceDate = null;
      checkedInState = null;
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
      stopHeartbeat();
      checkedInAttendanceDate = null;
      armWindowWakeFromSchedule();
    }, Math.min(Math.max(nextEnd - now + 750, 0), maxDelay));
  }
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

function logDesktopStaleDrop(event, occurred, ageMs, source) {
  console.info('[scorr-att] dropped stale event', { source, event, age_ms: ageMs, occurred_at_utc_ms: occurred });
}

function isBlankOrHiddenSsid(ssid) {
  const s = String(ssid ?? '').trim();
  if (!s) return true;
  return /^(?:<hidden>|hidden)$/i.test(s);
}

/** Windows duplicate profiles are "Office" then "Office 2", "Office 3". */
function stripWindowsProfileSuffix(name) {
  return String(name || '').trim().replace(/[ \t]+\d{1,2}$/, '').trim();
}

let windowsProfileReads = 0;

/**
 * Profile name of the active Wi-Fi interface. No Location permission and no admin.
 * Never called on Windows 10 (build < 22000), Linux, Android, iOS, or browsers.
 */
function readWindowsWifiProfileName() {
  if (!isWindows11()) return null;
  windowsProfileReads += 1;
  if (
    String(process.env.SCORR_SIMULATE_WINDOWS_BUILD || '').trim() !== '' &&
    process.env.SCORR_SIMULATE_WIFI_PROFILE != null
  ) {
    const simulated = String(process.env.SCORR_SIMULATE_WIFI_PROFILE);
    if (simulated === '' || simulated === '__NONE__') return null;
    return stripWindowsProfileSuffix(simulated) || null;
  }
  if (process.platform !== 'win32') return null;
  try {
    const command = [
      "$ErrorActionPreference='SilentlyContinue'",
      "$p = @(Get-NetConnectionProfile | Where-Object {",
      "$_.IPv4Connectivity -ne 'Disconnected' -and ($_.InterfaceAlias -match 'Wi-?Fi|WLAN|Wireless')",
      "} | Select-Object -First 1)",
      "if ($p.Count -gt 0 -and $p[0].Name) { $p[0].Name }",
    ].join('; ');
    const out = execFileSync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', command],
      { encoding: 'utf8', timeout: 4000, windowsHide: true },
    );
    const line = String(out || '').split(/\r?\n/).map((s) => s.trim()).find(Boolean) || '';
    return stripWindowsProfileSuffix(line) || null;
  } catch {
    return null;
  }
}

/** Best-effort SSID/BSSID. Windows 11 may fill a blank SSID from the profile name. */
function readWifiIdentity() {
  const wifi = readCurrentWifiIdentity();
  if (!isWindows11()) return wifi;
  if (!isBlankOrHiddenSsid(wifi.ssid)) return wifi;
  const profile = readWindowsWifiProfileName();
  if (!profile) return { ssid: null, bssid: wifi.bssid };
  return { ssid: profile, bssid: wifi.bssid, ssid_source: 'profile_name' };
}

function readCurrentWifiIdentity() {
  if (
    String(process.env.SCORR_SIMULATE_WINDOWS_BUILD || '').trim() !== '' &&
    process.env.SCORR_SIMULATE_NETSH_SSID != null
  ) {
    const raw = String(process.env.SCORR_SIMULATE_NETSH_SSID).trim();
    return { ssid: raw || null, bssid: null };
  }
  const { execSync } = require('child_process');
  try {
    if (process.platform === 'win32') {
      const out = execSync('netsh wlan show interfaces', { encoding: 'utf8', timeout: 4000 });
      const ssid = (out.match(/^\s*SSID\s*:\s*(.+)$/im) || [])[1]?.trim() || null;
      const bssid = (out.match(/^\s*BSSID\s*:\s*(.+)$/im) || [])[1]?.trim()?.toLowerCase() || null;
      return { ssid: ssid && ssid !== '' ? ssid : null, bssid };
    }
    if (process.platform === 'linux') {
      const out = execSync('nmcli -t -f ACTIVE,SSID,BSSID dev wifi', {
        encoding: 'utf8',
        timeout: 4000,
      });
      for (const line of out.split('\n')) {
        const parts = line.split(':');
        if (parts[0] === 'yes' || parts[0] === 'true') {
          return {
            ssid: parts[1] || null,
            bssid: (parts.slice(2).join(':') || '').toLowerCase() || null,
          };
        }
      }
    }
  } catch {
    /* ignore — Wi-Fi probe is best-effort; GPS radius still works */
  }
  return { ssid: null, bssid: null };
}

function attendanceWifiPayload(wifi) {
  const body = { ssid: wifi?.ssid ?? null, bssid: wifi?.bssid ?? null };
  if (wifi?.ssid_source === 'profile_name') body.ssid_source = 'profile_name';
  return body;
}

function isCheckinEventName(event) {
  const e = String(event || '').toLowerCase();
  return e === 'enter' || e === 'ping' || e === 'wifi_connected' || e === 'heartbeat' || e === 'power_on';
}

function normalizeSsid(s) {
  return String(s || '')
    .trim()
    .replace(/^"+|"+$/g, '');
}

/** True when current SSID/BSSID matches any assigned zone from schedule. */
function matchesScheduleOfficeWifi(wifi) {
  const zones = cachedSchedule?.zones || [];
  const ssid = normalizeSsid(wifi?.ssid);
  const bssid = String(wifi?.bssid || '')
    .trim()
    .toLowerCase();
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
        if (normalizeSsid(want).toLowerCase() === ssid.toLowerCase()) return true;
      }
    }
  }
  return false;
}

function stillSuppressCheckin() {
  if (!checkedInAttendanceDate) return false;
  if (cachedSchedule && Object.prototype.hasOwnProperty.call(cachedSchedule, 'session_open')
      && cachedSchedule.session_open === false) {
    checkedInAttendanceDate = null;
    return false;
  }
  const win = activeWindow(cachedSchedule, Date.now());
  if (!win) return false;
  if (Object.prototype.hasOwnProperty.call(win, 'session_open') && win.session_open === false) {
    checkedInAttendanceDate = null;
    return false;
  }
  const date = win.attendance_date || win.attendanceDate;
  return !date || String(date) === String(checkedInAttendanceDate);
}

/** While open session: if GPS is clearly outside every GPS zone, fire exit. */
async function probeLeaveWhileCheckedIn() {
  // Windows 11 stays checked in until shift end or Clock Out.
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

  const now = Date.now();
  const occurred = occurredAtUtcMs && occurredAtUtcMs > 0 ? occurredAtUtcMs : now;
  if (now - occurred > STALE_EVENT_MAX_AGE_MS) {
    logDesktopStaleDrop(event, occurred, now - occurred, 'desktop-pre-send');
    return { ok: false, reason: 'event_too_old', action: 'event_too_old', client_dropped: true };
  }

  // Ordered signals for server: Wi-Fi identity first; GPS only needed if Wi-Fi may miss.
  const wifi = readWifiIdentity();
  let fix = coords;
  if (!wifi.ssid && (!fix || fix.latitude == null || fix.longitude == null)) {
    fix = await readFreshLocation(100);
  } else if (fix?.latitude == null && !wifi.ssid) {
    fix = await readFreshLocation(100);
  }
  // Still attach GPS when available so radius fallback can succeed in one round-trip.
  if (wifi.ssid && (!fix || fix.latitude == null)) {
    fix = (await readFreshLocation(100)) || fix;
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
        app_version: app.getVersion(),
        latitude: fix?.latitude ?? null,
        longitude: fix?.longitude ?? null,
        accuracy_m: fix?.accuracy_m ?? null,
        ...attendanceWifiPayload(wifi),
        is_mock: false,
        ...attendancePlatformFields(),
      },
    });
  } catch (e) {
    notify('Scorr', 'No connection - will check when online');
    return { ok: false, reason: 'no_connection', action: 'no_connection' };
  }

  // Retry GPS only when Wi-Fi did not check in and server needs radius
  if (
    allowRetry &&
    !wifi.ssid &&
    (res?.action === 'need_fresh_location' || res?.action === 'gps_unusable' || res?.action === 'outside_radius')
  ) {
    const pos = await readFreshLocation(100);
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
    checkedInAttendanceDate = null;
    checkedInState = null;
    wasOnOfficeWifi = false;
  } else if (
    res?.action !== 'clock_out' &&
    (res?.action === 'clock_in' ||
      res?.action === 'already_in' ||
      res?.suppress_checkin)
  ) {
    checkedInAttendanceDate =
      res?.attendance_date ||
      activeWindow(cachedSchedule, Date.now())?.attendance_date ||
      checkedInAttendanceDate ||
      new Date().toISOString().slice(0, 10);
  }

  if (res?.action === 'clock_in') {
    wasOnOfficeWifi = matchesScheduleOfficeWifi(wifi) || wasOnOfficeWifi;
    if (!isWindows11()) notify('Scorr', res?.reentry ? 'Checked in again' : 'Checked in');
  } else if (res?.action === 'clock_out') {
    const t = res?.local_time ? ` at ${res.local_time}` : '';
    notify('Scorr', `Checked out${t}`);
  } else if (res?.action === 'already_in') {
    /* quiet — open session; leave or shift-end closes */
  } else if (res?.action === 'not_on_office_wifi' || res?.action === 'not_on_office_network') {
    notify('Scorr', 'Connect to the office Wi-Fi or enter the office radius');
  } else if (res?.action === 'outside_radius') {
    notify('Scorr', 'Not on office Wi-Fi and outside the office radius');
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
  const sched = cachedSchedule;
  if (!sched) return;
  const nowMs = Date.now();
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

  // Immediate present signal (server: Wi-Fi first, else radius)
  void sendEvent('power_on');
  lastCheckedInWorkAt = 0;
  heartbeatTimer = setInterval(() => {
    const w = activeWindow(cachedSchedule, Date.now());
    if (!w) {
      stopHeartbeat();
      return;
    }
    const wifi = readWifiIdentity();
    const onOffice = matchesScheduleOfficeWifi(wifi);
    // Early leave: drop office Wi-Fi while checked in → checkout (server ignores location).
    // Run on every 1s tick so Wi-Fi leave is not delayed by the checked-in gate.
    if (!isWindows11() && stillSuppressCheckin() && wasOnOfficeWifi && !onOffice) {
      wasOnOfficeWifi = false;
      void sendEvent('wifi_disconnected');
      return;
    }
    wasOnOfficeWifi = onOffice || wasOnOfficeWifi;
    if (stillSuppressCheckin()) {
      const now = Date.now();
      if (now - lastCheckedInWorkAt < INTERVAL_CHECKED_IN_MS) return;
      if (heartbeatInflight) return;
      lastCheckedInWorkAt = now;
      heartbeatInflight = true;
      // Leave probe + session-verify (discovers closed session → clear suppress → 1s re-entry).
      void (async () => {
        try {
          await probeLeaveWhileCheckedIn();
          await sendEvent('heartbeat');
        } finally {
          heartbeatInflight = false;
        }
      })();
      return;
    }
    lastCheckedInWorkAt = 0;
    if (heartbeatInflight) return;
    heartbeatInflight = true;
    void sendEvent('heartbeat').finally(() => {
      heartbeatInflight = false;
    });
  }, INTERVAL_CHECKIN_PROBE_MS);
}

function armScheduleLoop() {
  if (scheduleSyncTimer) clearInterval(scheduleSyncTimer);
  // 60s so session_open clears after manual checkout without waiting 15m.
  scheduleSyncTimer = setInterval(async () => {
    await syncSchedule();
    startHeartbeatIfInWindow();
  }, 60 * 1000);
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
    if (isWindows11() && process.argv.includes('--hidden')) return;
    mainWindow?.show();
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: 'deny' };
  });

  void mainWindow.loadURL(APP_URL);

  mainWindow.on('close', (e) => {
    if (isWindows11() && tray) {
      e.preventDefault();
      mainWindow?.hide();
      return;
    }
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
            // Keep enrollment token — auto-launch / next open still checks in.
            // Turn off only via Settings → Automatic check-in → Turn off.
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

setStartupEntry(true);

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
    setStartupEntry(enabled);
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
  ipcMain.handle('scorr:probeWifi', () => readWifiIdentity());
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
  ipcMain.handle('scorr:saveLoginCredentials', (_e, email, password) => saveLoginCredentials(email, password));
  ipcMain.handle('scorr:loadLoginCredentials', () => loadLoginCredentials());
  ipcMain.handle('scorr:clearLoginCredentials', () => clearLoginCredentials());
  ipcMain.handle('scorr:saveTrustedDeviceToken', (_e, token) => saveTrustedDeviceToken(token));
  ipcMain.handle('scorr:loadTrustedDeviceToken', () => loadTrustedDeviceToken());
  ipcMain.handle('scorr:clearTrustedDeviceToken', () => clearTrustedDeviceToken());

  setupTray();
  wirePowerEvents();
  createWindow();
  if (String(process.env.SCORR_SIMULATE_WINDOWS_BUILD || '').trim()) {
    const win11 = isWindows11();
    const fields = attendancePlatformFields();
    console.log(
      `[scorr] launch path ${win11 ? 'windows11' : 'windows10'} build ${windowsBuildNumber()} platform_variant ${fields.platform_variant || 'none'} check_in_notification ${win11 ? 'off' : 'on'}`,
    );
    mainWindow?.webContents.once('did-finish-load', () => {
      mainWindow.webContents
        .executeJavaScript(
          '(() => { const api = window.scorrDesktop || null; return JSON.stringify({ exposed: !!(api && api.isDesktop === true && typeof api.saveAttendanceToken === "function"), hasGetAppVersion: !!(api && api.getAppVersion) }); })()',
          true,
        )
        .then((raw) => console.log(`[scorr] bridge ${raw}`))
        .catch((error) => console.log(`[scorr] bridge error ${error}`));
    });
  }
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
  void sendEvent('power_off');
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin' && !loadToken()) app.quit();
});

module.exports = {
  readWifiIdentity,
  isWindows11,
  attendanceWifiPayload,
  profileReadCount: () => windowsProfileReads,
};
