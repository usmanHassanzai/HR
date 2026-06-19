import { useRef, useState } from 'react';
import { supabaseSignup } from '../lib/supabase';
import {
  CONNECTORS,
  HrisConnector,
  HrisEmployee,
  parseEmployeeCsv,
  generateTempPassword,
} from '../utils/hrisConnectors';
import { Building2, Upload, Loader2, CheckCircle, AlertCircle, Download, Users } from 'lucide-react';

interface HrisIntegrationProps {
  onImported?: () => void;
}

interface ImportResult {
  created: number;
  skipped: number;
  failed: number;
  messages: string[];
}

export default function HrisIntegration({ onImported }: HrisIntegrationProps) {
  const [employees, setEmployees] = useState<HrisEmployee[]>([]);
  const [source, setSource] = useState<string>('');
  const [loading, setLoading] = useState(false);
  const [importing, setImporting] = useState(false);
  const [result, setResult] = useState<ImportResult | null>(null);
  const [error, setError] = useState('');
  const fileRef = useRef<HTMLInputElement>(null);

  const loadFromConnector = async (connector: HrisConnector) => {
    setLoading(true);
    setError('');
    setResult(null);
    try {
      const emps = await connector.fetchEmployees();
      setEmployees(emps);
      setSource(connector.name);
    } catch (e: any) {
      setError(e.message || 'Failed to fetch from connector.');
    } finally {
      setLoading(false);
    }
  };

  const handleFile = async (file: File) => {
    setError('');
    setResult(null);
    const text = await file.text();
    const { employees: emps, errors } = parseEmployeeCsv(text);
    setEmployees(emps);
    setSource(file.name);
    if (errors.length) setError(errors.join(' '));
  };

  const handleImport = async () => {
    if (employees.length === 0) return;
    setImporting(true);
    setResult(null);
    const res: ImportResult = { created: 0, skipped: 0, failed: 0, messages: [] };

    for (const emp of employees) {
      try {
        const { data, error: signErr } = await supabaseSignup.auth.signUp({
          email: emp.email,
          password: generateTempPassword(),
          options: { data: { full_name: emp.full_name, role: emp.role } },
        });
        if (signErr) {
          if (/already registered|already exists/i.test(signErr.message)) {
            res.skipped++;
          } else {
            res.failed++;
            res.messages.push(`${emp.email}: ${signErr.message}`);
          }
        } else if (data.user) {
          res.created++;
        }
      } catch (e: any) {
        res.failed++;
        res.messages.push(`${emp.email}: ${e.message}`);
      }
    }
    await supabaseSignup.auth.signOut();
    setResult(res);
    setImporting(false);
    onImported?.();
  };

  const downloadTemplate = () => {
    const csv = 'full_name,email,role,department\nJane Doe,jane.doe@company.com,employee,Sales\nJohn Lead,john.lead@company.com,manager,Sales';
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'employee-import-template.csv';
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="animate-fade-in" style={{ display: 'flex', flexDirection: 'column', gap: '1.5rem' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '0.6rem' }}>
        <Building2 size={20} style={{ color: 'var(--accent-primary)' }} />
        <h3 style={{ margin: 0 }}>HRIS Integrations</h3>
      </div>

      {/* Connector cards */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: '1rem' }}>
        {CONNECTORS.map((c) => (
          <div key={c.id} className="glass-panel" style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
            <strong>{c.name}</strong>
            <p style={{ fontSize: '0.82rem', flex: 1 }}>{c.description}</p>
            <button className="btn btn-secondary" onClick={() => loadFromConnector(c)} disabled={loading || importing}>
              {loading ? <Loader2 size={15} className="animate-spin" style={{ animation: 'spin 1s linear infinite' }} /> : <Download size={15} />}
              Sync directory
            </button>
          </div>
        ))}

        {/* CSV upload card */}
        <div className="glass-panel" style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
          <strong>CSV / Excel Upload</strong>
          <p style={{ fontSize: '0.82rem', flex: 1 }}>Bulk-import staff from an exported spreadsheet (.csv).</p>
          <input
            ref={fileRef}
            type="file"
            accept=".csv,text/csv"
            style={{ display: 'none' }}
            onChange={(e) => e.target.files?.[0] && handleFile(e.target.files[0])}
          />
          <div style={{ display: 'flex', gap: '0.5rem' }}>
            <button className="btn btn-secondary" style={{ flex: 1 }} onClick={() => fileRef.current?.click()} disabled={importing}>
              <Upload size={15} /> Choose file
            </button>
            <button className="btn btn-secondary" onClick={downloadTemplate} title="Download CSV template">
              <Download size={15} />
            </button>
          </div>
        </div>
      </div>

      {error && (
        <div className="glass-panel" style={{ borderLeft: '4px solid var(--color-warning)', display: 'flex', gap: '0.5rem', alignItems: 'flex-start' }}>
          <AlertCircle size={18} style={{ color: 'var(--color-warning)', flexShrink: 0 }} />
          <span style={{ fontSize: '0.85rem' }}>{error}</span>
        </div>
      )}

      {/* Preview + import */}
      {employees.length > 0 && (
        <div className="glass-panel">
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '0.75rem', marginBottom: '1rem' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
              <Users size={16} style={{ color: 'var(--accent-primary)' }} />
              <strong>{employees.length} employees from {source}</strong>
            </div>
            <button className="btn btn-primary" onClick={handleImport} disabled={importing}>
              {importing ? <><Loader2 size={16} className="animate-spin" style={{ animation: 'spin 1s linear infinite' }} /> Importing…</> : `Import ${employees.length} employees`}
            </button>
          </div>

          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.85rem' }}>
              <thead>
                <tr style={{ textAlign: 'left', color: 'var(--text-muted)' }}>
                  <th style={{ padding: '0.5rem' }}>Name</th>
                  <th style={{ padding: '0.5rem' }}>Email</th>
                  <th style={{ padding: '0.5rem' }}>Role</th>
                  <th style={{ padding: '0.5rem' }}>Department</th>
                </tr>
              </thead>
              <tbody>
                {employees.map((e, i) => (
                  <tr key={i} style={{ borderTop: '1px solid var(--border-color)' }}>
                    <td style={{ padding: '0.5rem' }}>{e.full_name}</td>
                    <td style={{ padding: '0.5rem', color: 'var(--text-secondary)' }}>{e.email}</td>
                    <td style={{ padding: '0.5rem' }}>
                      <span className={`badge ${e.role === 'admin' ? 'badge-off-track' : e.role === 'manager' ? 'badge-at-risk' : 'badge-on-track'}`}>{e.role}</span>
                    </td>
                    <td style={{ padding: '0.5rem', color: 'var(--text-secondary)' }}>{e.department || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Import result */}
      {result && (
        <div className="glass-panel" style={{ borderLeft: '4px solid var(--color-success)' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.5rem' }}>
            <CheckCircle size={18} style={{ color: 'var(--color-success)' }} />
            <strong>Import complete</strong>
          </div>
          <p style={{ fontSize: '0.9rem' }}>
            Created <strong style={{ color: 'var(--color-success)' }}>{result.created}</strong> ·
            Skipped (already existed) <strong>{result.skipped}</strong> ·
            Failed <strong style={{ color: result.failed ? 'var(--color-danger)' : 'inherit' }}>{result.failed}</strong>
          </p>
          {result.messages.length > 0 && (
            <ul style={{ fontSize: '0.8rem', color: 'var(--text-muted)', marginTop: '0.5rem', paddingLeft: '1.25rem' }}>
              {result.messages.slice(0, 5).map((m, i) => <li key={i}>{m}</li>)}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
