/** Shared copy while attendance writes / auto Wi‑Fi engine are rebuilt. */
export const ATTENDANCE_RULES_PAUSED_MESSAGE =
  'Check-in/out writes are paused while auto rules are rebuilt. Assigned location radius and assigned shift windows still apply.';

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
