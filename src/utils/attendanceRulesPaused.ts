/** Shared copy while attendance / office / auto-attendance rules are rebuilt. */
export const ATTENDANCE_RULES_PAUSED_MESSAGE =
  'Attendance check-in/out writes are paused while rules are rebuilt. Office radius location checks still run for every assigned employee.';

export function isRulesNotConfigured(result: unknown): boolean {
  if (!result || typeof result !== 'object') return false;
  const r = result as Record<string, unknown>;
  return (
    r.status === 'rules_not_configured' ||
    r.action === 'rules_not_configured' ||
    r.reason === 'rules_not_configured'
  );
}

/** True when the server evaluated office radius even though attendance writes are paused. */
export function hasOfficeRadiusPresence(result: unknown): boolean {
  if (!result || typeof result !== 'object') return false;
  const r = result as Record<string, unknown>;
  return (
    typeof r.inside_office === 'boolean' ||
    r.action === 'inside_office' ||
    r.action === 'outside_radius' ||
    r.action === 'outside_office'
  );
}
