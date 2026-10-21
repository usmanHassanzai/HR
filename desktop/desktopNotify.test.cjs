const assert = require('assert');
const fs = require('fs');
const path = require('path');
const {
  SILENT_ON_WINDOWS,
  attendanceNoticeUsesSystemNotification,
  deliverAttendanceNotice,
} = require('./desktopNotify.cjs');

const paths = ['check_in', 'check_out', 'wifi_lost', 'wifi_detected', 'reminder', 'left_office', 'no_connection', 'not_configured'];
for (const kind of paths) {
  let calls = 0;
  const result = deliverAttendanceNotice('win32', kind, () => {
    calls += 1;
  });
  assert.strictEqual(result.shown, false, kind);
  assert.strictEqual(calls, 0, `Windows notification API must not run for ${kind}`);
  assert.strictEqual(attendanceNoticeUsesSystemNotification('win32', kind), false);
}

let linuxCalls = 0;
const linux = deliverAttendanceNotice('linux', 'check_in', () => {
  linuxCalls += 1;
});
assert.strictEqual(linux.shown, true);
assert.strictEqual(linuxCalls, 1);

let androidCalls = 0;
deliverAttendanceNotice('android', 'check_out', () => {
  androidCalls += 1;
});
assert.strictEqual(androidCalls, 1);

const main = fs.readFileSync(path.join(__dirname, 'main.cjs'), 'utf8');
assert.ok(main.includes("deliverAttendanceNotice(process.platform, kind"), 'notify() must go through the silent helper');
for (const kind of ['check_in', 'check_out', 'left_office', 'reminder', 'wifi_lost', 'no_connection']) {
  assert.ok(main.includes(`'${kind}'`), `main.cjs missing notice kind ${kind}`);
}
assert.ok(!/function notify[\s\S]{0,400}new Notification/.test(main), 'notify() must not construct Notification directly');
assert.strictEqual(SILENT_ON_WINDOWS.has('check_in'), true);

const setup = fs.readFileSync(path.join(__dirname, '../src/utils/autoAttendanceSetup.ts'), 'utf8');
assert.ok(setup.includes("platform === 'win32'"), 'Windows must skip the notification permission step');
assert.ok(setup.includes('skipNotificationPermission'));

console.log('desktopNotify tests ok');
