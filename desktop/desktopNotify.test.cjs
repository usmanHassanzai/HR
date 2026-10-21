const assert = require('assert');
const fs = require('fs');
const path = require('path');
const {
  SILENT_ON_WINDOWS11,
  attendanceNoticeUsesSystemNotification,
  deliverAttendanceNotice,
} = require('./desktopNotify.cjs');
const { isWindows11Build, platformVariantForBuild } = require('./windowsVariant.cjs');

const paths = ['check_in', 'check_out', 'wifi_lost', 'wifi_detected', 'reminder', 'left_office', 'no_connection', 'not_configured'];
for (const kind of paths) {
  let calls = 0;
  const silent = deliverAttendanceNotice('win32', kind, () => {
    calls += 1;
  }, { windows11: true });
  assert.strictEqual(silent.shown, false, kind);
  assert.strictEqual(calls, 0, `Windows 11 notification API must not run for ${kind}`);
  assert.strictEqual(attendanceNoticeUsesSystemNotification('win32', kind, { windows11: true }), false);

  let win10Calls = 0;
  const win10 = deliverAttendanceNotice('win32', kind, () => {
    win10Calls += 1;
  }, { windows11: false });
  assert.strictEqual(win10.shown, true, `Windows 10 must still notify for ${kind}`);
  assert.strictEqual(win10Calls, 1);
  assert.strictEqual(attendanceNoticeUsesSystemNotification('win32', kind), true);
}

let linuxCalls = 0;
const linux = deliverAttendanceNotice('linux', 'check_in', () => {
  linuxCalls += 1;
}, { windows11: false });
assert.strictEqual(linux.shown, true);
assert.strictEqual(linuxCalls, 1);

let androidCalls = 0;
deliverAttendanceNotice('android', 'check_out', () => {
  androidCalls += 1;
});
assert.strictEqual(androidCalls, 1);

assert.strictEqual(isWindows11Build(22621), true);
assert.strictEqual(isWindows11Build(22000), true);
assert.strictEqual(isWindows11Build(19045), false);
assert.strictEqual(isWindows11Build(19041), false);
assert.strictEqual(isWindows11Build(21999), false);
assert.strictEqual(platformVariantForBuild(22621), 'windows11');
assert.strictEqual(platformVariantForBuild(19045), undefined);
assert.strictEqual(platformVariantForBuild(0), undefined);

const main = fs.readFileSync(path.join(__dirname, 'main.cjs'), 'utf8');
assert.ok(main.includes('deliverAttendanceNotice(process.platform, kind'), 'notify() must go through the silent helper');
assert.ok(main.includes('windows11: isWindows11()'), 'silence is Windows 11 only');
assert.ok(main.includes("platform_variant: 'windows11'"), 'only Windows 11 sends platform_variant');
assert.ok(!/platform_variant: 'windows'/.test(main), 'Windows 10 must not send a variant');
for (const kind of ['check_in', 'check_out', 'left_office', 'reminder', 'wifi_lost', 'no_connection']) {
  assert.ok(main.includes(`'${kind}'`), `main.cjs missing notice kind ${kind}`);
}
assert.ok(!/function notify[\s\S]{0,500}new Notification/.test(main), 'notify() must not construct Notification directly');
assert.strictEqual(SILENT_ON_WINDOWS11.has('check_in'), true);

const setup = fs.readFileSync(path.join(__dirname, '../src/utils/autoAttendanceSetup.ts'), 'utf8');
assert.ok(!setup.includes("platform === 'win32'"), 'Windows 10 must not skip notification permission with every Windows build');
assert.ok(
  !setup.includes('skipNotificationPermission') || setup.includes("platformVariant === 'windows11'"),
  'notification permission may be skipped only for Windows 11',
);

console.log('desktopNotify tests ok');
