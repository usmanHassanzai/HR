import { useEffect, useState } from 'react';
import { Cloud, Loader2, Palette, RotateCcw } from 'lucide-react';
import { BrandingConfig, DEFAULT_BRANDING, DEFAULT_LOGO_URL, fetchCompanyBranding, loadBranding, persistCompanyBranding, usesBundledWordmark } from '../lib/branding';
import BrandLogo from './BrandLogo';
import { useDebouncedEffect } from '../utils/useDebouncedEffect';

interface BrandingSettingsProps {
  isDemo?: boolean;
}

export default function BrandingSettings({ isDemo = false }: BrandingSettingsProps) {
  const [config, setConfig] = useState<BrandingConfig>(loadBranding(isDemo));
  const [loading, setLoading] = useState(!isDemo);
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);

  useEffect(() => {
    if (isDemo) return;
    void (async () => {
      setLoading(true);
      const remote = await fetchCompanyBranding(false);
      if (remote) setConfig(remote);
      setLoading(false);
    })();
  }, [isDemo]);

  const update = (patch: Partial<BrandingConfig>) => {
    setConfig((c) => ({ ...c, ...patch }));
    setDirty(true);
  };

  useDebouncedEffect(
    () => {
      if (!dirty || loading) return;
      setSaving(true);
      void persistCompanyBranding(config, isDemo).finally(() => {
        setSaving(false);
        setDirty(false);
      });
    },
    [config, dirty, loading, isDemo],
    1000,
    !loading,
  );

  const handleReset = () => {
    setConfig({ ...DEFAULT_BRANDING });
    setDirty(true);
    void persistCompanyBranding({ ...DEFAULT_BRANDING }, isDemo);
  };

  if (loading) {
    return (
      <div className="rewards-loading">
        <Loader2 size={28} className="spin-icon" />
      </div>
    );
  }

  return (
    <div className="animate-fade-in" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))', gap: '1.5rem' }}>
      <div className="glass-panel">
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '1.25rem' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.6rem' }}>
            <Palette size={18} style={{ color: 'var(--accent-primary)' }} />
            <h3 style={{ margin: 0 }}>White-Label Branding</h3>
          </div>
          <span style={{ fontSize: '0.78rem', color: 'var(--text-muted)', display: 'flex', alignItems: 'center', gap: '0.35rem' }}>
            {saving ? <><Loader2 size={12} className="spin-icon" /> Saving…</> : dirty ? 'Saving…' : <><Cloud size={12} /> Synced to database</>}
          </span>
        </div>
        {isDemo && (
          <p style={{ fontSize: '0.82rem', color: 'var(--color-warning)', marginBottom: '1rem', padding: '0.65rem 0.85rem', background: 'var(--color-warning-bg)', borderRadius: 'var(--border-radius-sm)' }}>
            Demo branding is saved separately and does not change production settings.
          </p>
        )}

        <div className="form-group">
          <label>Brand Name</label>
          <input value={config.brandName} onChange={(e) => update({ brandName: e.target.value })} placeholder="Acme Corp" />
        </div>

        <div className="form-group">
          <label>Tagline</label>
          <input value={config.tagline} onChange={(e) => update({ tagline: e.target.value })} placeholder="scorr.walfia.ai" />
        </div>

        <div className="form-group">
          <label>Logo URL (optional)</label>
          <input value={config.logoUrl} onChange={(e) => update({ logoUrl: e.target.value })} placeholder={DEFAULT_LOGO_URL} />
        </div>

        <div style={{ display: 'flex', gap: '1rem' }}>
          <div className="form-group" style={{ flex: 1 }}>
            <label>Primary Color</label>
            <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
              <input type="color" value={config.accentPrimary} onChange={(e) => update({ accentPrimary: e.target.value })} style={{ width: 48, height: 40, padding: 2 }} />
              <input value={config.accentPrimary} onChange={(e) => update({ accentPrimary: e.target.value })} />
            </div>
          </div>
          <div className="form-group" style={{ flex: 1 }}>
            <label>Secondary Color</label>
            <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
              <input type="color" value={config.accentSecondary} onChange={(e) => update({ accentSecondary: e.target.value })} style={{ width: 48, height: 40, padding: 2 }} />
              <input value={config.accentSecondary} onChange={(e) => update({ accentSecondary: e.target.value })} />
            </div>
          </div>
        </div>

        <div style={{ display: 'flex', gap: '0.75rem', marginTop: '0.5rem' }}>
          <button type="button" className="btn btn-secondary" onClick={handleReset}>
            <RotateCcw size={16} /> Reset
          </button>
        </div>
        <p style={{ fontSize: '0.78rem', color: 'var(--text-muted)', marginTop: '0.75rem' }}>
          Changes auto-save to Supabase and sync on every device — no manual upload needed.
        </p>
      </div>

      <div className="glass-panel">
        <p style={{ fontSize: '0.75rem', textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--text-muted)', marginBottom: '1rem' }}>
          Live Preview
        </p>
        <div
          style={{
            borderRadius: 'var(--border-radius-md)',
            border: '1px solid var(--border-color)',
            padding: '1.5rem',
            background: 'rgba(0,0,0,0.2)',
          }}
        >
          <div className="branding-preview-header">
            <BrandLogo src={config.logoUrl} variant="preview" alt={config.brandName} />
            {!usesBundledWordmark(config) && (
              <div>
                <div style={{ fontFamily: 'var(--font-display)', fontWeight: 700, fontSize: '1.1rem' }}>{config.brandName || 'Brand Name'}</div>
                <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>{config.tagline || 'Tagline'}</div>
              </div>
            )}
          </div>
          <button
            style={{
              background: `linear-gradient(135deg, ${config.accentPrimary} 0%, ${config.accentSecondary} 100%)`,
              color: 'white',
              width: '100%',
            }}
          >
            Primary Button
          </button>
          <div style={{ display: 'flex', gap: '0.5rem', marginTop: '1rem' }}>
            <span className="badge" style={{ background: 'var(--color-success-bg)', color: 'var(--color-success)' }}>On Track</span>
            <span style={{ color: config.accentPrimary, fontWeight: 600, fontSize: '0.85rem', alignSelf: 'center' }}>Accent text sample</span>
          </div>
        </div>
      </div>
    </div>
  );
}
