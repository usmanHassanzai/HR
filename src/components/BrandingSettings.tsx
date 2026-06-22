import { useState } from 'react';
import { Palette, RotateCcw, Check } from 'lucide-react';
import { BrandingConfig, DEFAULT_BRANDING, DEFAULT_LOGO_URL, loadBranding, saveBranding, usesBundledWordmark } from '../lib/branding';
import BrandLogo from './BrandLogo';

interface BrandingSettingsProps {
  isDemo?: boolean;
}

export default function BrandingSettings({ isDemo = false }: BrandingSettingsProps) {
  const [config, setConfig] = useState<BrandingConfig>(loadBranding(isDemo));
  const [saved, setSaved] = useState(false);

  const update = (patch: Partial<BrandingConfig>) => {
    setConfig((c) => ({ ...c, ...patch }));
    setSaved(false);
  };

  const handleSave = () => {
    saveBranding(config, isDemo);
    setSaved(true);
    setTimeout(() => setSaved(false), 2500);
  };

  const handleReset = () => {
    setConfig({ ...DEFAULT_BRANDING });
    saveBranding({ ...DEFAULT_BRANDING }, isDemo);
  };

  return (
    <div className="animate-fade-in" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))', gap: '1.5rem' }}>
      <div className="glass-panel">
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.6rem', marginBottom: '1.25rem' }}>
          <Palette size={18} style={{ color: 'var(--accent-primary)' }} />
          <h3 style={{ margin: 0 }}>White-Label Branding</h3>
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
          <button className="btn btn-primary" onClick={handleSave}>
            {saved ? <><Check size={16} /> Saved & Applied</> : 'Save & Apply'}
          </button>
          <button className="btn btn-secondary" onClick={handleReset}>
            <RotateCcw size={16} /> Reset
          </button>
        </div>
      </div>

      {/* Live preview */}
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
        <p style={{ fontSize: '0.8rem', color: 'var(--text-muted)', marginTop: '1rem' }}>
          Branding applies instantly across the app and persists on this device. Promote to an{' '}
          <code>app_settings</code> table for org-wide branding.
        </p>
      </div>
    </div>
  );
}
