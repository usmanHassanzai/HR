/**
 * Windows 11 automatic check-in is silent.
 * Windows 10, Linux, Android, and iOS keep system notifications.
 */
const SILENT_ON_WINDOWS11 = new Set([
  'check_in',
  'check_out',
  'wifi_detected',
  'wifi_lost',
  'reminder',
  'left_office',
  'no_connection',
  'not_configured',
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
