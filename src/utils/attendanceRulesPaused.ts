/** Shared copy while attendance / office / auto-attendance rules are rebuilt. */
export const ATTENDANCE_RULES_PAUSED_MESSAGE =
  'Attendance, office and automatic attendance rules are being rebuilt. Everything is paused.';

export function isRulesNotConfigured(result: unknown): boolean {
  if (!result || typeof result !== 'object') return false;
  const r = result as Record<string, unknown>;
  return (
    r.status === 'rules_not_configured' ||
    r.action === 'rules_not_configured' ||
    r.reason === 'rules_not_configured'
  );
}
