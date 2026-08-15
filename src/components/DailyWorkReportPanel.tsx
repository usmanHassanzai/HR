import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import {
  FileText,
  Send,
  Loader2,
  CheckCircle2,
  AlertCircle,
  Calendar,
  Clock,
  Pencil,
} from 'lucide-react';
import { Profile } from '../utils/kpiHelpers';
import {
  DailyWorkReport,
  fetchMyDailyWorkReports,
  formatReportDate,
  formatReportTime,
  submitDailyWorkReport,
  todayIsoDate,
} from '../utils/dailyWorkReportHelpers';
import '../styles/daily-work-reports.css';

interface DailyWorkReportPanelProps {
  profile: Profile;
}

const MIN_CHARS = 20;
const MAX_CHARS = 8000;

export default function DailyWorkReportPanel({ profile }: DailyWorkReportPanelProps) {
  const today = todayIsoDate();
  const [content, setContent] = useState('');
  const [reportDate, setReportDate] = useState(today);
  const [history, setHistory] = useState<DailyWorkReport[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const rows = await fetchMyDailyWorkReports(45);
      setHistory(rows);
    } catch (err) {
      console.error(err);
      setMessage({ type: 'error', text: 'Could not load your daily reports.' });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const existingForDate = useMemo(
    () => history.find((r) => r.report_date === reportDate) ?? null,
    [history, reportDate],
  );

  useEffect(() => {
    if (existingForDate) setContent(existingForDate.content);
    else setContent('');
  }, [existingForDate, reportDate]);

  const trimmedLen = content.trim().length;
  const canSubmit = trimmedLen >= MIN_CHARS && trimmedLen <= MAX_CHARS && !saving;

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (!canSubmit) return;
    setSaving(true);
    setMessage(null);
    try {
      await submitDailyWorkReport(content, reportDate);
      setMessage({
        type: 'success',
        text: existingForDate
          ? 'Daily report updated successfully.'
          : 'Daily report submitted. Your admin can review it now.',
      });
      await load();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Could not submit report.';
      setMessage({ type: 'error', text: msg });
    } finally {
      setSaving(false);
    }
  };

  const minDate = (() => {
    const d = new Date();
    d.setDate(d.getDate() - 7);
    return d.toISOString().slice(0, 10);
  })();

  return (
    <div className="dwr-panel animate-fade-in">
      <div className="dwr-hero glass-panel">
        <div className="dwr-hero__icon">
          <FileText size={22} />
        </div>
        <div className="dwr-hero__copy">
          <span className="dash-eyebrow">Daily work log</span>
          <h2>What did you accomplish today?</h2>
          <p>
            Write a clear summary of your work for the day. Only organization admins can read submitted reports.
            {profile.role === 'manager' ? ' Managers submit the same daily log as employees.' : ''}
          </p>
        </div>
      </div>

      <form className="dwr-compose glass-panel" onSubmit={handleSubmit}>
        <div className="dwr-compose__head">
          <div>
            <h3>{existingForDate ? 'Update report' : 'Submit today\'s report'}</h3>
            <p>Minimum {MIN_CHARS} characters · be specific about projects and outcomes</p>
          </div>
          <label className="dwr-date-field">
            <Calendar size={14} />
            <input
              type="date"
              value={reportDate}
              min={minDate}
              max={today}
              onChange={(e) => setReportDate(e.target.value)}
            />
          </label>
        </div>

        {existingForDate && (
          <div className="dwr-edit-banner">
            <Pencil size={14} />
            Editing report for {formatReportDate(reportDate)} — last saved {formatReportTime(existingForDate.updated_at)}
          </div>
        )}

        <textarea
          className="dwr-textarea"
          value={content}
          onChange={(e) => setContent(e.target.value.slice(0, MAX_CHARS))}
          placeholder={`Example:\n• Completed client proposal draft for Project Atlas\n• Coordinated with design on homepage revisions\n• Reviewed pending leave requests for my team\n• Planned tomorrow's sprint priorities`}
          rows={10}
          required
        />

        <div className="dwr-compose__footer">
          <span className={`dwr-char-count ${trimmedLen < MIN_CHARS ? 'dwr-char-count--warn' : ''}`}>
            {trimmedLen} / {MAX_CHARS}
            {trimmedLen < MIN_CHARS ? ` · ${MIN_CHARS - trimmedLen} more needed` : ''}
          </span>
          <button type="submit" className="btn btn-primary" disabled={!canSubmit}>
            {saving ? <Loader2 size={16} className="spin-icon" /> : <Send size={16} />}
            {existingForDate ? 'Update report' : 'Submit report'}
          </button>
        </div>

        {message && (
          <div className={`dwr-alert dwr-alert--${message.type}`}>
            {message.type === 'success' ? <CheckCircle2 size={16} /> : <AlertCircle size={16} />}
            <span>{message.text}</span>
          </div>
        )}
      </form>

      <div className="dwr-history glass-panel">
        <div className="dwr-history__head">
          <h3>Your recent reports</h3>
          <p>Submitted entries appear here for your records</p>
        </div>

        {loading ? (
          <div className="dwr-empty">
            <Loader2 size={22} className="spin-icon" /> Loading…
          </div>
        ) : history.length === 0 ? (
          <div className="dwr-empty">
            <FileText size={28} />
            <p>No reports yet. Submit your first daily work summary above.</p>
          </div>
        ) : (
          <ul className="dwr-history__list">
            {history.map((row) => (
              <li key={row.id} className="dwr-history__item">
                <div className="dwr-history__meta">
                  <strong>{formatReportDate(row.report_date)}</strong>
                  <span>
                    <Clock size={12} /> {formatReportTime(row.submitted_at)}
                  </span>
                  {row.report_date === today && <span className="dwr-badge dwr-badge--today">Today</span>}
                </div>
                <p>{row.content}</p>
                <button
                  type="button"
                  className="btn btn-secondary btn-sm"
                  onClick={() => {
                    setReportDate(row.report_date);
                    window.scrollTo({ top: 0, behavior: 'smooth' });
                  }}
                >
                  <Pencil size={14} /> Edit
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
