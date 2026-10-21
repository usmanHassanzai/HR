/**
 * Windows automatic check-in is silent. Android, iOS, and Linux are unchanged.
 * These kinds must never call the Windows notification API.
 */
const SILENT_ON_WINDOWS = new Set([
  'check_in',
  'check_out',
  'wifi_detected',
  'wifi_lost',
  'reminder',
  'left_office',
  'no_connection',
  'not_configured',
]);

function attendanceNoticeUsesSystemNotification(platform, kind) {
  if (platform === 'win32' && SILENT_ON_WINDOWS.has(String(kind || ''))) return false;
  return true;
}

/**
 * @param {string} platform process.platform
 * @param {string} kind
 * @param {() => void} showSystemNotification invoked only when a toast is allowed
 */
function deliverAttendanceNotice(platform, kind, showSystemNotification) {
  if (!attendanceNoticeUsesSystemNotification(platform, kind)) {
    return { shown: false, kind };
  }
  if (typeof showSystemNotification === 'function') showSystemNotification();
  return { shown: true, kind };
}

module.exports = {
  SILENT_ON_WINDOWS,
  attendanceNoticeUsesSystemNotification,
  deliverAttendanceNotice,
};
