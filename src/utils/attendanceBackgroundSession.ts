import { Profile } from './kpiHelpers';

const GEO_HOLD_KEY = 'scorr-geo-hold';
const GEO_HOLD_EVENT = 'scorr-geo-hold';

let latestProfile: Profile | null = null;

export function setAttendanceLogoutProfile(profile: Profile | null) {
  latestProfile = profile;
}

export function getAttendanceLogoutProfile(): Profile | null {
  return latestProfile;
}

export function isGeoHold(): boolean {
  try {
    return localStorage.getItem(GEO_HOLD_KEY) === '1';
  } catch {
    return false;
  }
}

export function lockDashboardForGeo() {
  try {
    localStorage.setItem(GEO_HOLD_KEY, '1');
  } catch {
    /* ignore */
  }
  window.dispatchEvent(new Event(GEO_HOLD_EVENT));
}

export function clearGeoHold() {
  try {
    localStorage.removeItem(GEO_HOLD_KEY);
  } catch {
    /* ignore */
  }
  window.dispatchEvent(new Event(GEO_HOLD_EVENT));
}

export function subscribeGeoHold(onChange: () => void): () => void {
  const onStorage = (e: StorageEvent) => {
    if (e.key === GEO_HOLD_KEY || e.key == null) onChange();
  };
  window.addEventListener(GEO_HOLD_EVENT, onChange);
  window.addEventListener('storage', onStorage);
  return () => {
    window.removeEventListener(GEO_HOLD_EVENT, onChange);
    window.removeEventListener('storage', onStorage);
  };
}

/** Background GPS after logout is disabled — location is only used at clock-in/out. */
export async function shouldContinueGpsAfterLogout(_profile?: Profile | null): Promise<boolean> {
  return false;
}
