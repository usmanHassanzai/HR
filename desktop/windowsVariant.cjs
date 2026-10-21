/**
 * Windows 11 is build 22000 or higher (any edition).
 * Windows 10 Pro is build 19045 or lower and must stay on the old path.
 */

function isWindows11Build(buildNumber) {
  const n = Number(buildNumber);
  return Number.isFinite(n) && n >= 22000;
}

function readWindowsBuildNumber() {
  if (process.platform !== 'win32') return 0;
  try {
    const { execFileSync } = require('child_process');
    const out = execFileSync(
      'reg',
      ['query', 'HKLM\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion', '/v', 'CurrentBuild'],
      { encoding: 'utf8', timeout: 2000, windowsHide: true },
    );
    const match = String(out).match(/CurrentBuild\s+REG_\w+\s+(\d+)/i);
    return match ? Number(match[1]) : 0;
  } catch {
    return 0;
  }
}

/** Field sent to the server. Omitted on every platform except Windows 11. */
function platformVariantForBuild(buildNumber) {
  return isWindows11Build(buildNumber) ? 'windows11' : undefined;
}

module.exports = {
  isWindows11Build,
  readWindowsBuildNumber,
  platformVariantForBuild,
};
