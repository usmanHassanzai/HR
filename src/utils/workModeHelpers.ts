import type { WorkMode } from './kpiHelpers';

export const WORK_MODE_OPTIONS: { value: WorkMode; label: string; shortLabel: string }[] = [
  { value: 'office', label: 'Office (GPS / check-in)', shortLabel: 'Office' },
  { value: 'remote', label: 'Remote (supervisor marks attendance)', shortLabel: 'Remote' },
  { value: 'hybrid', label: 'Hybrid (office GPS + remote days)', shortLabel: 'Hybrid' },
];

export function normalizeWorkMode(mode?: string | null): WorkMode {
  if (mode === 'remote' || mode === 'hybrid') return mode;
  return 'office';
}

export function workModeLabel(mode?: string | null, short = true): string {
  const value = normalizeWorkMode(mode);
  const opt = WORK_MODE_OPTIONS.find((o) => o.value === value);
  return short ? (opt?.shortLabel ?? 'Office') : (opt?.label ?? 'Office');
}

export function usesOfficeGps(mode?: string | null): boolean {
  return normalizeWorkMode(mode) !== 'remote';
}

export function canMarkRemoteAttendance(mode?: string | null): boolean {
  const value = normalizeWorkMode(mode);
  return value === 'remote' || value === 'hybrid';
}
