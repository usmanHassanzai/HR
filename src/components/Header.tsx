import { useEffect, useState } from 'react';
import { supabase } from '../lib/supabase';
import { Profile } from '../utils/kpiHelpers';
import NotificationCenter from './NotificationCenter';
import { LogOut, User, Shield, Briefcase } from 'lucide-react';
import { BrandingConfig, loadBranding, usesBundledWordmark } from '../lib/branding';
import { isDemoProfile } from '../utils/demoMode';
import BrandLogo from './BrandLogo';
import ThemeToggle from './ThemeToggle';
import { isAppShell } from '../utils/nativePlatform';

interface HeaderProps {
  profile: Profile;
  onLogout: () => void;
  onNavigateHome?: () => void;
}

export default function Header({ profile, onLogout, onNavigateHome }: HeaderProps) {
  const demoMode = isDemoProfile(profile);
  const [branding, setBranding] = useState<BrandingConfig>(loadBranding(demoMode));

  useEffect(() => {
    setBranding(loadBranding(demoMode));
  }, [demoMode]);

  useEffect(() => {
    const handler = (e: Event) => setBranding((e as CustomEvent<BrandingConfig>).detail);
    window.addEventListener('branding-updated', handler);
    return () => window.removeEventListener('branding-updated', handler);
  }, []);

  const handleLogout = async () => {
    try {
      await supabase.auth.signOut();
      onLogout();
    } catch (err) {
      console.error('Logout error:', err);
    }
  };

  const getRoleBadge = (role: string) => {
    switch (role) {
      case 'admin':
        return (
          <span className="badge badge-off-track app-header__role">
            <Shield size={10} /> Admin
          </span>
        );
      case 'manager':
        return (
          <span className="badge badge-at-risk app-header__role">
            <Briefcase size={10} /> Manager
          </span>
        );
      default:
        return (
          <span className="badge badge-on-track app-header__role">
            <User size={10} /> Employee
          </span>
        );
    }
  };

  const brandBlock = (
    <div
      onClick={onNavigateHome}
      className="header-brand"
      style={{ cursor: onNavigateHome ? 'pointer' : 'default' }}
    >
      <BrandLogo src={branding.logoUrl} variant="header" alt={branding.brandName} />
      {!usesBundledWordmark(branding) && (
        <div className="header-brand-text">
          <h2>{branding.brandName}</h2>
          <span>{branding.tagline}</span>
        </div>
      )}
    </div>
  );

  const iconActions = (
    <>
      <ThemeToggle compact />
      <NotificationCenter userId={profile.id} />
      <button
        className="btn btn-secondary"
        onClick={handleLogout}
        style={{
          padding: '0.65rem',
          borderRadius: '50%',
          width: '40px',
          height: '40px',
          color: 'var(--color-danger)',
          borderColor: 'transparent',
        }}
        title="Sign Out"
      >
        <LogOut size={16} />
      </button>
    </>
  );

  /* APK / installed app — own row for name + role so nothing is clipped */
  if (isAppShell()) {
    return (
      <header className="glass-panel app-header app-header--shell">
        <div className="app-header__top">
          {brandBlock}
          <div className="header-actions header-actions--icons">{iconActions}</div>
        </div>
        <div className="app-header__profile" aria-label="Signed in user">
          <div className="header-avatar">
            <User size={18} />
          </div>
          <div className="app-header__profile-text">
            <span className="app-header__name">{profile.full_name}</span>
            {getRoleBadge(profile.role)}
          </div>
        </div>
      </header>
    );
  }

  return (
    <header className="glass-panel app-header animate-fade-in">
      {brandBlock}

      <div className="header-actions">
        <div className="header-user">
          <div className="header-user-text">
            <div className="header-user-name">{profile.full_name}</div>
            <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: '2px' }}>
              {getRoleBadge(profile.role)}
            </div>
          </div>
          <div className="header-avatar">
            <User size={18} />
          </div>
        </div>

        <div className="header-divider" />

        {iconActions}
      </div>
    </header>
  );
}
