/**
 * Automatic attendance for the iPhone/iPad Home Screen app.
 * Paused while attendance / office / auto-attendance rules are rebuilt.
 */

/** Banner copy for the Home Screen web app limitation. */
export const IOS_HOME_BACKGROUND_BANNER =
  'Attendance, office and automatic attendance rules are being rebuilt. Everything is paused.';

/** Start GPS automatic attendance. Paused while rules are rebuilt. */
export function startIosHomeAttendance(): Promise<void> {
  return Promise.resolve();
}

export function stopIosHomeAttendance(): void {
  /* no-op while rules are rebuilt */
}
