import { useEffect, useState } from 'react';
import { Monitor, Moon, Sun } from 'lucide-react';
import {
  ThemePreference,
  cycleThemePreference,
  getStoredThemePreference,
  themePreferenceLabel,
} from '../lib/theme';

interface ThemeToggleProps {
  /** Compact icon-only button for header */
  compact?: boolean;
}

export default function ThemeToggle({ compact = false }: ThemeToggleProps) {
  const [pref, setPref] = useState<ThemePreference>(() => getStoredThemePreference());

  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent<{ preference: ThemePreference }>).detail;
      if (detail?.preference) setPref(detail.preference);
    };
    window.addEventListener('theme-changed', handler);
    return () => window.removeEventListener('theme-changed', handler);
  }, []);

  const Icon = pref === 'light' ? Sun : pref === 'dark' ? Moon : Monitor;
  const label = themePreferenceLabel(pref);

  const handleClick = () => setPref(cycleThemePreference());

  if (compact) {
    return (
      <button
        type="button"
        className="theme-toggle theme-toggle--compact btn btn-secondary"
        onClick={handleClick}
        title={`Theme: ${label}. Click to switch.`}
        aria-label={`Theme: ${label}. Click to switch.`}
      >
        <Icon size={16} />
      </button>
    );
  }

  return (
    <button type="button" className="theme-toggle btn btn-secondary btn-sm" onClick={handleClick}>
      <Icon size={15} />
      {label}
    </button>
  );
}
