/**
 * Pure Wi-Fi identity parsing for the desktop shell.
 * Windows netsh labels are localized. SSID/BSSID tokens stay Latin;
 * when they do not, the second MAC in the connected block is the BSSID
 * and the value before it is the network name. Profile names are matched
 * across common translations, then used when the SSID field is blank.
 */

const PROFILE_KEYS = new Set([
  'profile',
  'profil',
  'perfil',
  'profilo',
  'profiel',
  'профиль',
  'προφίλ',
  'プロフィール',
  '프로필',
  '配置文件',
  'ملف التعريف',
  'پروفائل',
  'الملف',
]);

const CONNECTED_VALUES = new Set([
  'connected',
  'verbunden',
  'connecté',
  'connectee',
  'conectado',
  'connesso',
  'verbonden',
  'подключено',
  '接続済み',
  '已连接',
  'متصل',
  'منسلک',
  'bağlı',
  'bagli',
  'połączono',
  'polaczono',
]);

function normalizeSsid(s) {
  let t = String(s || '')
    .replace(/\u0000/g, '')
    .replace(/\u00a0/g, ' ')
    .trim()
    .replace(/^"+|"+$/g, '')
    .trim();
  t = t.replace(/\s+/g, ' ').trim();
  return t;
}

function normalizeBssid(s) {
  const t = String(s || '')
    .replace(/\u0000/g, '')
    .trim()
    .toLowerCase()
    .replace(/-/g, ':')
    .replace(/\\:/g, ':');
  if (!/^([0-9a-f]{2}:){5}[0-9a-f]{2}$/.test(t)) return null;
  return t;
}

/** Bytes 0x80–0x9F shared by OEM code pages 437 and 850 (Windows console). */
const OEM_80 = {
  0x80: 'Ç', 0x81: 'ü', 0x82: 'é', 0x83: 'â', 0x84: 'ä', 0x85: 'à', 0x86: 'å', 0x87: 'ç',
  0x88: 'ê', 0x89: 'ë', 0x8a: 'è', 0x8b: 'ï', 0x8c: 'î', 0x8d: 'ì', 0x8e: 'Ä', 0x8f: 'Å',
  0x90: 'É', 0x91: 'æ', 0x92: 'Æ', 0x93: 'ô', 0x94: 'ö', 0x95: 'ò', 0x96: 'û', 0x97: 'ù',
  0x98: 'ÿ', 0x99: 'Ö', 0x9a: 'Ü', 0x9b: 'ø', 0x9c: '£', 0x9d: 'Ø', 0x9e: '×', 0x9f: 'ƒ',
};

function decodeOem(buf) {
  let out = '';
  for (const byte of buf) {
    if (byte < 0x80) out += String.fromCharCode(byte);
    else out += OEM_80[byte] || new TextDecoder('windows-1252').decode(Buffer.from([byte]));
  }
  return out;
}

function isValidUtf8(buf) {
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(buf);
    return true;
  } catch {
    return false;
  }
}

function decodeCommandOutput(buf) {
  if (!buf) return '';
  const b = Buffer.isBuffer(buf) ? buf : Buffer.from(String(buf));
  if (!b.length) return '';
  if (b[0] === 0xff && b[1] === 0xfe) return b.slice(2).toString('utf16le');
  if (b[0] === 0xfe && b[1] === 0xff) return b.slice(2).toString('utf16be');
  let nulls = 0;
  const sample = Math.min(b.length, 240);
  for (let i = 0; i < sample; i += 1) if (b[i] === 0) nulls += 1;
  if (nulls > 8) return b.toString('utf16le');
  if (isValidUtf8(b)) return b.toString('utf8');
  return decodeOem(b);
}

function parseLabeledLines(block) {
  const rows = [];
  for (const line of String(block || '').split(/\r?\n/)) {
    const m = line.match(/^\s*(.+?)\s*:\s*(.*)$/);
    if (!m) continue;
    const key = m[1].trim();
    if (!key || key.length > 80) continue;
    rows.push({ key, value: m[2].trim() });
  }
  return rows;
}

function isSsidKey(key) {
  return key.normalize('NFKC').toLowerCase() === 'ssid';
}

function isBssidKey(key) {
  const k = key.normalize('NFKC').toLowerCase();
  if (k === 'ssid') return false;
  return k === 'bssid' || k.endsWith(' bssid');
}

function isProfileKey(key) {
  const k = key.normalize('NFKC').toLowerCase();
  if (PROFILE_KEYS.has(k) || PROFILE_KEYS.has(key.normalize('NFKC'))) return true;
  return /profil|perfil|profile|профиль|پروفائل|ملف التعريف|配置文件|プロファイル|프로필/.test(k);
}

function isConnectedValue(value) {
  const v = String(value || '').normalize('NFKC').trim().toLowerCase();
  return CONNECTED_VALUES.has(v);
}

/**
 * Parse `netsh wlan show interfaces` in any Windows language.
 * Returns the connected radio when one is present.
 */
function parseWindowsWlanInterfaces(text) {
  const raw = String(text || '').replace(/^\uFEFF/, '').replace(/\u0000/g, '');
  const blocks = raw.split(/\r?\n\s*\r?\n/).filter((b) => b.includes(':'));
  const rows = [];
  for (const block of blocks) {
    const fields = parseLabeledLines(block);
    if (!fields.length) continue;
    let ssidRaw = null;
    let sawSsidField = false;
    let bssid = null;
    let bssidIndex = -1;
    let profile = '';
    let connected = false;
    fields.forEach((f, i) => {
      if (isSsidKey(f.key)) {
        sawSsidField = true;
        ssidRaw = f.value;
      } else if (isBssidKey(f.key)) {
        const mac = normalizeBssid(f.value);
        if (mac) {
          bssid = mac;
          bssidIndex = i;
        }
      } else if (isProfileKey(f.key)) {
        profile = f.value;
      }
      if (isConnectedValue(f.value)) connected = true;
    });
    if (!bssid) {
      const macs = [];
      fields.forEach((f, i) => {
        const mac = normalizeBssid(f.value);
        if (mac) macs.push({ i, mac });
      });
      if (macs.length >= 2) {
        bssid = macs[1].mac;
        bssidIndex = macs[1].i;
        connected = true;
      }
    }
    if (sawSsidField === false && bssidIndex > 0 && !ssidRaw) {
      const prev = fields[bssidIndex - 1];
      if (prev && !normalizeBssid(prev.value) && !/^\{?[0-9a-f-]{36}\}?$/i.test(prev.value)) {
        ssidRaw = prev.value;
        sawSsidField = true;
      }
    }
    const ssidField = normalizeSsid(ssidRaw || '');
    const profileName = normalizeSsid(profile);
    const ssid = ssidField || profileName || null;
    const ssidBlank = sawSsidField && !ssidField;
    if (!ssid && !bssid) continue;
    rows.push({
      ssid,
      bssid,
      connected: connected || Boolean(bssid),
      ssidBlank,
      usedProfile: Boolean(!ssidField && profileName),
    });
  }
  const picked =
    rows.find((r) => r.connected && (r.ssid || r.bssid)) ||
    rows.find((r) => r.ssid || r.bssid) || {
      ssid: null,
      bssid: null,
      connected: false,
      ssidBlank: false,
      usedProfile: false,
    };
  return picked;
}

/** nmcli -t escapes ':' as '\:' inside SSID and BSSID. */
function parseNmcliActiveWifi(text) {
  for (const line of String(text || '').split(/\r?\n/)) {
    if (!line.startsWith('yes:') && !line.startsWith('true:')) continue;
    const rest = line.slice(line.indexOf(':') + 1);
    const unescaped = rest.replace(/\\:/g, '\u0001').replace(/\\\\/g, '\\');
    const parts = unescaped.split(':');
    if (parts.length >= 2) {
      const bssidRaw = parts.pop().replace(/\u0001/g, ':');
      const ssidRaw = parts.join(':').replace(/\u0001/g, ':');
      const bssid = normalizeBssid(bssidRaw);
      const ssid = normalizeSsid(ssidRaw) || null;
      if (ssid || bssid) return { ssid, bssid };
    }
    const ssidOnly = normalizeSsid(rest.replace(/\\:/g, ':'));
    if (ssidOnly) return { ssid: ssidOnly, bssid: null };
  }
  return { ssid: null, bssid: null };
}

function parseLocationConsent(regText) {
  const m = String(regText || '').match(/^\s*Value\s+REG_SZ\s+(\S+)\s*$/im);
  if (!m) return null;
  if (/^allow$/i.test(m[1])) return true;
  if (/^deny$/i.test(m[1])) return false;
  return null;
}

const LOCATION_MESSAGE =
  'Turn on Location for Windows (Settings > Privacy & security > Location) so Scorr can read the Wi-Fi name';

/** IPv4 in a saved office CIDR. Used only when the company stored a public IP. */
function ipv4InCidr(ip, cidr) {
  const raw = String(cidr || '').trim();
  const addr = String(ip || '').trim();
  if (!raw || !addr) return false;
  if (addr === raw || addr === raw.split('/')[0]) return true;
  const [base, bitsRaw] = raw.split('/');
  const bits = Number(bitsRaw);
  if (!base || !Number.isInteger(bits) || bits < 0 || bits > 32) return false;
  const toInt = (s) => {
    const p = String(s).split('.');
    if (p.length !== 4) return null;
    let n = 0;
    for (const part of p) {
      const o = Number(part);
      if (!Number.isInteger(o) || o < 0 || o > 255) return null;
      n = (n << 8) + o;
    }
    return n >>> 0;
  };
  const ipN = toInt(addr);
  const baseN = toInt(base);
  if (ipN == null || baseN == null) return false;
  if (bits === 0) return true;
  const mask = bits === 32 ? 0xffffffff : (~((1 << (32 - bits)) - 1)) >>> 0;
  return (ipN & mask) === (baseN & mask);
}

function ipMatchesSavedCidrs(ip, cidrs) {
  if (!ip || !Array.isArray(cidrs) || cidrs.length === 0) return false;
  return cidrs.some((c) => ipv4InCidr(ip, c));
}

module.exports = {
  normalizeSsid,
  normalizeBssid,
  decodeCommandOutput,
  parseWindowsWlanInterfaces,
  parseNmcliActiveWifi,
  parseLocationConsent,
  LOCATION_MESSAGE,
  ipv4InCidr,
  ipMatchesSavedCidrs,
};
