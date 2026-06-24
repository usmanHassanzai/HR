/**
 * Phase 3 — Custom Branding
 *
 * Enterprise white-label theming. The brand config is persisted in
 * localStorage and applied at runtime by overriding the design-system CSS
 * variables on :root. This keeps branding instant, offline-friendly (useful
 * for the native app), and decoupled from the database. It can later be
 * promoted to a shared `app_settings` table for org-wide branding.
 */

export interface BrandingConfig {
  brandName: string;
  tagline: string;
  accentPrimary: string;   // hex, e.g. #7c5cff
  accentSecondary: string; // hex
  logoUrl: string;         // optional remote logo; empty → bundled Scorr SVG
}

/** Bundled logos served from /public */
export const DEFAULT_LOGO_URL = '/scorr-wordmark.svg';
export const DEFAULT_LOGO_FULL_URL = '/scorr-logo.svg';

export const DEFAULT_BRANDING: BrandingConfig = {
  brandName: 'Scorr',
  tagline: 'scorr.walfia.ai',
  accentPrimary: '#2DD4A8',
  accentSecondary: '#38BDF8',
  logoUrl: DEFAULT_LOGO_URL,
};

const STORAGE_KEY = 'scorr-branding';
const DEMO_STORAGE_KEY = 'scorr-branding-demo';

export function getBrandingStorageKey(isDemo = false): string {
  return isDemo ? DEMO_STORAGE_KEY : STORAGE_KEY;
}

/** Resolve logo URL — empty string falls back to bundled asset. */
export function resolveLogoUrl(url?: string): string {
  return url?.trim() || DEFAULT_LOGO_URL;
}

/** True when using the wide bundled logo (text is baked into the SVG). */
export function usesBundledWordmark(config: Pick<BrandingConfig, 'logoUrl'>): boolean {
  const u = resolveLogoUrl(config.logoUrl);
  return (
    u === DEFAULT_LOGO_URL ||
    u === DEFAULT_LOGO_FULL_URL ||
    u.endsWith('/scorr-logo.svg') ||
    u.endsWith('/scorr-wordmark.svg')
  );
}

export function loadBranding(isDemo = false): BrandingConfig {
  try {
    const key = getBrandingStorageKey(isDemo);
    let raw = localStorage.getItem(key);
    if (!raw && !isDemo) raw = localStorage.getItem('walfia-branding'); // legacy key
    if (!raw) return { ...DEFAULT_BRANDING };
    const parsed = { ...DEFAULT_BRANDING, ...JSON.parse(raw) };
    // Auto-migrate pre-Scorr branding
    if (parsed.brandName === 'Walfia AI' || parsed.tagline === 'HR KPI Dashboard') {
      parsed.brandName = DEFAULT_BRANDING.brandName;
      parsed.tagline = DEFAULT_BRANDING.tagline;
    }
    if (!parsed.logoUrl?.trim() || parsed.logoUrl === '/scorr-logo.svg') {
      parsed.logoUrl = DEFAULT_BRANDING.logoUrl;
    }
    if (parsed.accentPrimary === '#7C5CFF' || parsed.accentSecondary === '#C04CFB'
      || parsed.accentPrimary === '#00E5A0' || parsed.accentSecondary === '#1AD4FF') {
      parsed.accentPrimary = DEFAULT_BRANDING.accentPrimary;
      parsed.accentSecondary = DEFAULT_BRANDING.accentSecondary;
    }
    return parsed;
  } catch {
    return { ...DEFAULT_BRANDING };
  }
}

export function saveBranding(config: BrandingConfig, isDemo = false): void {
  localStorage.setItem(getBrandingStorageKey(isDemo), JSON.stringify(config));
  applyBranding(config);
  // Notify listeners (e.g. Header) within the same tab.
  window.dispatchEvent(new CustomEvent('branding-updated', { detail: config }));
}

/** Convert #rrggbb to an "r, g, b" string for rgba() usage. */
function hexToRgb(hex: string): string {
  const m = hex.replace('#', '');
  const full = m.length === 3 ? m.split('').map((c) => c + c).join('') : m;
  const n = parseInt(full, 16);
  const r = (n >> 16) & 255;
  const g = (n >> 8) & 255;
  const b = n & 255;
  return `${r}, ${g}, ${b}`;
}

/** Apply the branding config to the document's CSS variables + title. */
export function applyBranding(config: BrandingConfig): void {
  const root = document.documentElement;
  const rgb = hexToRgb(config.accentPrimary);

  root.style.setProperty('--accent-primary', config.accentPrimary);
  root.style.setProperty('--accent-secondary', config.accentSecondary);
  root.style.setProperty(
    '--accent-gradient',
    `linear-gradient(135deg, ${config.accentPrimary} 0%, ${config.accentSecondary} 100%)`
  );
  root.style.setProperty('--accent-glow', `0 0 20px rgba(${rgb}, 0.3)`);
  root.style.setProperty('--border-hover', `rgba(${rgb}, 0.4)`);

  document.title = `${config.brandName} — ${config.tagline}`;
}
