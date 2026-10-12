/** Manual check-in/out RPCs remain paused; auto check-in + early/any-location check-out are live on Android + desktop. */
export const ATTENDANCE_RULES_PAUSED_MESSAGE =
  'Manual Clock in / Clock out is still paused. Automatic check-in runs on Android and desktop on office Wi-Fi or inside the office radius. Check-out can happen from any location during the shift, or automatically at shift end.';

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
