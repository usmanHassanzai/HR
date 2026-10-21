/**
 * Windows 11 turns off only the check-in toast.
 * Check-out, shift-end (the check-out toast), and reminders stay as in 1.3.45.
 * Wi-Fi-change and "left the office" stay off because those events no longer
 * check a Windows 11 session out. Other platforms show every kind.
 */
const SILENT_ON_WINDOWS11 = new Set([
  'check_in',
  'wifi_detected',
  'wifi_lost',
  'left_office',
]);

function attendanceNoticeUsesSystemNotification(platform, kind, options) {
  const windows11 = Boolean(options && options.windows11);
  if (platform === 'win32' && windows11 && SILENT_ON_WINDOWS11.has(String(kind || ''))) return false;
  return true;
}

/**
 * @param {string} platform process.platform
 * @param {string} kind
 * @param {() => void} showSystemNotification invoked only when a toast is allowed
 * @param {{ windows11?: boolean }} [options]
 */
function deliverAttendanceNotice(platform, kind, showSystemNotification, options) {
  if (!attendanceNoticeUsesSystemNotification(platform, kind, options)) {
    return { shown: false, kind };
  }
  if (typeof showSystemNotification === 'function') showSystemNotification();
  return { shown: true, kind };
}

module.exports = {
  SILENT_ON_WINDOWS11,
  attendanceNoticeUsesSystemNotification,
  deliverAttendanceNotice,
};
