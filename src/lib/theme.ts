export type ThemePreference = 'light' | 'dark' | 'system';

const STORAGE_KEY = 'scorr-theme';

export function getStoredThemePreference(): ThemePreference {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    if (v === 'light' || v === 'dark' || v === 'system') return v;
  } catch {
    /* private mode */
  }
  return 'system';
}

export function resolveEffectiveTheme(preference: ThemePreference = getStoredThemePreference()): 'light' | 'dark' {
  if (preference === 'light' || preference === 'dark') return preference;
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

export function applyTheme(preference: ThemePreference = getStoredThemePreference()): 'light' | 'dark' {
  const effective = resolveEffectiveTheme(preference);
  document.documentElement.setAttribute('data-theme', effective);
  document.documentElement.setAttribute('data-theme-pref', preference);

  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) {
    meta.setAttribute('content', effective === 'light' ? '#f4f7fb' : '#0b1120');
  }

  window.dispatchEvent(new CustomEvent('theme-changed', { detail: { preference, effective } }));
  return effective;
}

export function setThemePreference(preference: ThemePreference): void {
  localStorage.setItem(STORAGE_KEY, preference);
  applyTheme(preference);
}

/** Call before React mount to avoid flash of wrong theme. */
export function initTheme(): void {
  applyTheme(getStoredThemePreference());

  const mq = window.matchMedia('(prefers-color-scheme: dark)');
  const onChange = () => {
    if (getStoredThemePreference() === 'system') applyTheme('system');
  };
  mq.addEventListener('change', onChange);
}

export function cycleThemePreference(): ThemePreference {
  const order: ThemePreference[] = ['light', 'dark', 'system'];
  const current = getStoredThemePreference();
  const next = order[(order.indexOf(current) + 1) % order.length];
  setThemePreference(next);
  return next;
}

export function themePreferenceLabel(pref: ThemePreference): string {
  if (pref === 'light') return 'Light';
  if (pref === 'dark') return 'Night';
  return 'Auto';
}
