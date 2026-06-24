import { useEffect, useState } from 'react';
import { supabase } from '../lib/supabase';
import { Profile } from '../utils/kpiHelpers';
import NotificationCenter from './NotificationCenter';
import { LogOut, User, Shield, Briefcase } from 'lucide-react';
import { BrandingConfig, loadBranding, usesBundledWordmark } from '../lib/branding';
import { isDemoProfile } from '../utils/demoMode';
import BrandLogo from './BrandLogo';
import ThemeToggle from './ThemeToggle';

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
          <span className="badge badge-off-track" style={{ fontSize: '0.7rem', display: 'inline-flex', alignItems: 'center', gap: '0.25rem' }}>
            <Shield size={10} /> Admin
          </span>
        );
      case 'manager':
        return (
          <span className="badge badge-at-risk" style={{ fontSize: '0.7rem', display: 'inline-flex', alignItems: 'center', gap: '0.25rem' }}>
            <Briefcase size={10} /> Manager
          </span>
        );
      default:
        return (
          <span className="badge badge-on-track" style={{ fontSize: '0.7rem', display: 'inline-flex', alignItems: 'center', gap: '0.25rem' }}>
            <User size={10} /> Employee
          </span>
        );
    }
  };

  return (
    <header className="glass-panel app-header animate-fade-in">
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
      </div>
    </header>
  );
}
