/**
 * Windows 11 Wi-Fi read. Called only when the OS build is 22000 or higher.
 * Windows 10 keeps the English netsh read in main.cjs. Linux is not used here.
 */
const fs = require('fs');
const path = require('path');
const {
  normalizeSsid,
  normalizeBssid,
  decodeCommandOutput,
  parseWindowsWlanInterfaces,
  parseLocationConsent,
} = require('./wifiProbe.cjs');

function windowsSys32() {
  const root = process.env.SystemRoot || process.env.windir || 'C:\\Windows';
  return path.join(root, 'System32');
}

function windowsPowerShell() {
  const ps = path.join(windowsSys32(), 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  return fs.existsSync(ps) ? ps : 'powershell.exe';
}

function execFileBuffer(file, args, timeoutMs) {
  const { execFileSync } = require('child_process');
  const root = process.env.SystemRoot || process.env.windir || 'C:\\Windows';
  const sys32 = path.join(root, 'System32');
  const prev = process.env.PATH || '';
  try {
    return execFileSync(file, args, {
      timeout: timeoutMs,
      killSignal: 'SIGKILL',
      windowsHide: true,
      env: { ...process.env, PATH: `${sys32};${root};${prev}` },
      maxBuffer: 1024 * 1024,
    });
  } catch (err) {
    if (err && err.stdout && err.stdout.length) return err.stdout;
    return Buffer.alloc(0);
  }
}

function execFileText(file, args, timeoutMs) {
  return decodeCommandOutput(execFileBuffer(file, args, timeoutMs));
}

/** WLAN API first. Structured SSID and BSSID, no localized netsh labels. */
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
    if (consent === false) return false;
    if (consent === true) seen = true;
  }
  return seen;
}

let cachedWindowsVersion = '';

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

/**
 * WLAN API, then netsh parsed without English labels, then the connected
 * profile name when the SSID is blank. A failed read returns blank fields.
 */
function probeWindows11Wifi() {
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
  return {
    ssid: parsed?.ssid || null,
    bssid: parsed?.bssid || null,
    ssidBlank: Boolean(parsed?.ssidBlank),
    usedProfile: Boolean(parsed?.usedProfile),
    locationAllowed: readWindowsLocationAllowed(),
  };
}

module.exports = {
  probeWindows11Wifi,
  readWindowsLocationAllowed,
  readWindowsVersionLabel,
};
