import { Download, Copy, ShieldAlert } from 'lucide-react';
import { copyBackupCodes, downloadBackupCodesTxt } from '../utils/mfaRecovery';
import { useState } from 'react';

interface BackupCodesRevealModalProps {
  codes: string[];
  fullName?: string;
  onDone: () => void;
}

export default function BackupCodesRevealModal({ codes, fullName, onDone }: BackupCodesRevealModalProps) {
  const [copied, setCopied] = useState(false);
  const [ack, setAck] = useState(false);

  return (
    <div className="kpi-edit-overlay" role="presentation">
      <div className="kpi-edit-dialog" role="dialog" aria-modal="true" aria-labelledby="backup-codes-title" style={{ maxWidth: 480 }}>
        <header className="kpi-edit-dialog__head">
          <div>
            <p className="kpi-edit-dialog__kicker">Account security</p>
            <h2 id="backup-codes-title">Save your backup codes</h2>
          </div>
        </header>
        <div className="kpi-edit-dialog__body">
          <p style={{ display: 'flex', gap: '0.5rem', alignItems: 'flex-start', color: 'var(--color-warning)', fontSize: '0.88rem', lineHeight: 1.45 }}>
            <ShieldAlert size={18} style={{ flexShrink: 0, marginTop: 2 }} />
            Save these now. You won&apos;t be able to see them again. Each code works once if you lose your authenticator.
          </p>
          <ol style={{
            margin: '1rem 0',
            padding: '0.85rem 0.85rem 0.85rem 2rem',
            borderRadius: 10,
            background: 'var(--surface-muted)',
            border: '1px solid var(--border-color)',
            fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
            fontSize: '0.95rem',
            letterSpacing: '0.04em',
          }}
          >
            {codes.map((c) => (
              <li key={c} style={{ marginBottom: '0.35rem' }}>{c}</li>
            ))}
          </ol>
          <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
            <button
              type="button"
              className="btn btn-secondary"
              onClick={() => {
                downloadBackupCodesTxt(codes, fullName);
              }}
            >
              <Download size={16} /> Download as .txt
            </button>
            <button
              type="button"
              className="btn btn-secondary"
              onClick={() => {
                void copyBackupCodes(codes).then(() => {
                  setCopied(true);
                  setTimeout(() => setCopied(false), 2000);
                });
              }}
            >
              <Copy size={16} /> {copied ? 'Copied' : 'Copy to clipboard'}
            </button>
          </div>
          <label style={{ display: 'flex', gap: '0.5rem', alignItems: 'flex-start', marginTop: '1rem', fontSize: '0.85rem' }}>
            <input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} style={{ marginTop: 3 }} />
            <span>I saved these codes somewhere safe</span>
          </label>
        </div>
        <footer className="kpi-edit-dialog__foot">
          <button type="button" className="btn btn-primary" disabled={!ack} onClick={onDone}>
            Continue to dashboard
          </button>
        </footer>
      </div>
    </div>
  );
}
