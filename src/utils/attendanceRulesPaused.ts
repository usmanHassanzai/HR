/** Shown only when the server still returns a paused / rules_not_configured write block. */
export const ATTENDANCE_RULES_PAUSED_MESSAGE =
  'Check-in/out writes are paused on the server. Automatic check-in on Android and desktop uses configured office Wi-Fi first, else office radius.';

/** Short product copy for the Clock in panel (writes live). */
export const MANUAL_CHECKIN_RULE_MESSAGE =
  'Clock in: configured office Wi-Fi (location not required), or GPS inside your assigned office radius. Window: 1 hour before shift start until shift end. Public Wi-Fi does not count.';

export function isRulesNotConfigured(result: unknown): boolean {
  if (!result || typeof result !== 'object') return false;
  const r = result as Record<string, unknown>;
  return (
    r.status === 'rules_not_configured' ||
    r.action === 'rules_not_configured' ||
    r.reason === 'rules_not_configured' ||
    r.writes_paused === true
  );
}

/** True when the server evaluated office radius from assigned locations. */
export function hasOfficeRadiusPresence(result: unknown): boolean {
  if (!result || typeof result !== 'object') return false;
  const r = result as Record<string, unknown>;
  return (
    typeof r.inside_office === 'boolean' ||
    r.action === 'inside_office' ||
    r.action === 'outside_radius' ||
    r.action === 'outside_office' ||
    r.reason === 'assignment_presence'
  );
}
