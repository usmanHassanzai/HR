import { useEffect, useState } from 'react';
import { supabase } from '../lib/supabase';
import { Profile } from '../utils/kpiHelpers';
import NotificationCenter from './NotificationCenter';
import { LogOut, User, Shield, Briefcase, Building2 } from 'lucide-react';
import { BrandingConfig, loadBranding, usesBundledWordmark } from '../lib/branding';
import { isDemoProfile } from '../utils/demoMode';
import { usePlatformOwnerAccess } from '../utils/usePlatformOwnerAccess';
import BrandLogo from './BrandLogo';
import ThemeToggle from './ThemeToggle';
import { isAppShell } from '../utils/nativePlatform';

interface HeaderProps {
  profile: Profile;
  onLogout: () => void;
  onNavigateHome?: () => void;
}

function userInitials(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? '')
    .join('') || '?';
}

export default function Header({ profile, onLogout, onNavigateHome }: HeaderProps) {
  const demoMode = isDemoProfile(profile);
  const { isOwner: platformOwner } = usePlatformOwnerAccess(profile);
  const [branding, setBranding] = useState<BrandingConfig>(loadBranding(demoMode));
  const shellLayout = isAppShell();

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

  const toolbar = (
    <div className="app-header__toolbar">
      <ThemeToggle compact />
      <NotificationCenter userId={profile.id} />
      <button
        type="button"
        className="app-header__icon-btn app-header__icon-btn--logout"
        onClick={handleLogout}
        title="Sign out"
        aria-label="Sign out"
      >
        <LogOut size={17} />
      </button>
    </div>
  );

  const platformLink = platformOwner && profile.role === 'admin' ? (
    <a
      href="/platform"
      className="app-header__platform-link"
      title="Registered Companies"
      aria-label="Registered Companies"
    >
      <Building2 size={16} />
      <span className="app-header__platform-label">Companies</span>
    </a>
  ) : null;

  const profileBlock = (
    <div className="app-header__profile" aria-label="Signed in user">
      <div className="app-header__avatar" aria-hidden="true">
        {userInitials(profile.full_name)}
      </div>
      <div className="app-header__profile-text">
        <span className="app-header__name">{profile.full_name}</span>
        {getRoleBadge(profile.role)}
      </div>
    </div>
  );

  if (shellLayout) {
    return (
      <header className="glass-panel app-header app-header--dashboard app-header--stacked">
        <div className="app-header__brand-row">
          {brandBlock}
          {toolbar}
        </div>
        <div className="app-header__user-row">
          {platformLink}
          {profileBlock}
        </div>
      </header>
    );
  }

  return (
    <header className="glass-panel app-header app-header--dashboard app-header--inline animate-fade-in">
      <div className="app-header__start">{brandBlock}</div>
      <div className="app-header__end">
        {platformLink}
        {profileBlock}
        {toolbar}
      </div>
    </header>
  );
}
