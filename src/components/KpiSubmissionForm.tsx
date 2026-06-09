import React, { useState } from 'react';
import { supabase } from '../lib/supabase';
import { Kpi } from '../utils/kpiHelpers';
import { X, Send, AlertCircle, Loader2 } from 'lucide-react';

interface KpiSubmissionFormProps {
  kpis: Kpi[];
  userId: string;
  onClose: () => void;
  onSuccess: () => void;
}

export default function KpiSubmissionForm({ kpis, userId, onClose, onSuccess }: KpiSubmissionFormProps) {
  const [selectedKpiId, setSelectedKpiId] = useState('');
  const [value, setValue] = useState('');
  const [notes, setNotes] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const selectedKpi = kpis.find(k => k.id === selectedKpiId);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedKpiId) {
      setError('Please select a KPI.');
      return;
    }
    if (!value || isNaN(Number(value))) {
      setError('Please enter a valid numeric value.');
      return;
    }

    setLoading(true);
    setError('');

    try {
      const { error: insertError } = await supabase
        .from('kpi_submissions')
        .insert({
          user_id: userId,
          kpi_id: selectedKpiId,
          value: parseFloat(value),
          notes: notes.trim() || null
        });

      if (insertError) {
        setError(insertError.message);
      } else {
        // Success
        setValue('');
        setNotes('');
        setSelectedKpiId('');
        onSuccess();
        onClose();
      }
    } catch (err: any) {
      setError(err.message || 'An unexpected error occurred during submission.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div style={{
      position: 'fixed',
      top: 0,
      left: 0,
      width: '100%',
      height: '100%',
      background: 'rgba(5, 8, 16, 0.8)',
      backdropFilter: 'var(--glass-blur)',
      WebkitBackdropFilter: 'var(--glass-blur)',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      zIndex: 1000,
      padding: '1rem',
      animation: 'fadeIn 0.25s ease-out forwards'
    }}>
      <div className="glass-panel" style={{
        width: '100%',
        maxWidth: '480px',
        position: 'relative',
        boxShadow: 'var(--shadow-lg)',
        border: '1px solid var(--border-hover)',
        animation: 'slideUp 0.3s cubic-bezier(0.16, 1, 0.3, 1) forwards'
      }}>
        {/* Header */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1.5rem', borderBottom: '1px solid var(--border-color)', paddingBottom: '0.75rem' }}>
          <h3 style={{ fontSize: '1.25rem', fontFamily: 'var(--font-display)', margin: 0 }}>Log performance score</h3>
          <button 
            onClick={onClose} 
            style={{ background: 'none', border: 'none', color: 'var(--text-muted)', cursor: 'pointer', display: 'flex' }}
            aria-label="Close"
          >
            <X size={20} />
          </button>
        </div>

        {error && (
          <div style={{ 
            background: 'var(--color-danger-bg)', 
            color: 'var(--color-danger)', 
            padding: '0.75rem 1rem', 
            borderRadius: 'var(--border-radius-sm)', 
            fontSize: '0.85rem', 
            marginBottom: '1.25rem',
            display: 'flex',
            alignItems: 'center',
            gap: '0.5rem'
          }}>
            <AlertCircle size={16} />
            <span>{error}</span>
          </div>
        )}

        <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>
          
          <div className="form-group" style={{ margin: 0 }}>
            <label htmlFor="kpi-select">Select KPI Indicator</label>
            <select
              id="kpi-select"
              value={selectedKpiId}
              onChange={(e) => {
                setSelectedKpiId(e.target.value);
                setError('');
              }}
              disabled={loading}
              required
            >
              <option value="">-- Choose a KPI --</option>
              {kpis.map(kpi => (
                <option key={kpi.id} value={kpi.id}>
                  {kpi.name} ({kpi.category})
                </option>
              ))}
            </select>
          </div>

          {selectedKpi && (
            <div style={{ 
              background: 'rgba(255, 255, 255, 0.02)', 
              padding: '0.75rem 1rem', 
              borderRadius: 'var(--border-radius-sm)', 
              fontSize: '0.8rem',
              border: '1px solid var(--border-color)',
              color: 'var(--text-secondary)'
            }}>
              <strong>Target:</strong> {selectedKpi.target_value} ({selectedKpi.direction === 'higher_better' ? 'Higher is better' : 'Lower is better'})
              {selectedKpi.description && <p style={{ fontSize: '0.75rem', marginTop: '4px', color: 'var(--text-muted)' }}>{selectedKpi.description}</p>}
            </div>
          )}

          <div className="form-group" style={{ margin: 0 }}>
            <label htmlFor="kpi-value">New Metric Value</label>
            <input
              id="kpi-value"
              type="number"
              step="any"
              placeholder="e.g. 84.5"
              value={value}
              onChange={(e) => {
                setValue(e.target.value);
                setError('');
              }}
              disabled={loading}
              required
            />
          </div>

          <div className="form-group" style={{ margin: 0 }}>
            <label htmlFor="kpi-notes">Submission Notes (Optional)</label>
            <textarea
              id="kpi-notes"
              rows={3}
              placeholder="Provide background context for this performance score..."
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              disabled={loading}
              style={{ resize: 'vertical' }}
            />
          </div>

          <div style={{ display: 'flex', gap: '0.75rem', marginTop: '0.5rem', justifyContent: 'flex-end' }}>
            <button 
              type="button" 
              className="btn btn-secondary" 
              onClick={onClose} 
              disabled={loading}
            >
              Cancel
            </button>
            <button 
              type="submit" 
              className="btn btn-primary" 
              disabled={loading}
            >
              {loading ? (
                <>
                  <Loader2 size={16} className="animate-spin" style={{ animation: 'spin 1s linear infinite' }} />
                  Submitting...
                </>
              ) : (
                <>
                  <Send size={14} /> Submit
                </>
              )}
            </button>
          </div>
        </form>
      </div>

      {/* Slide up animation CSS */}
      <style dangerouslySetInnerHTML={{__html: `
        @keyframes slideUp {
          from {
            opacity: 0;
            transform: translateY(30px);
          }
          to {
            opacity: 1;
            transform: translateY(0);
          }
        }
      `}} />
    </div>
  );
}
