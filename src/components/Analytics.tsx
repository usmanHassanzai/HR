import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  fetchAnalyticsData,
  AnalyticsData,
  monthlyTrend,
  linearForecast,
  statusDistribution,
  categoryAttainment,
  departmentAttainment,
  periodComparison,
} from '../utils/analyticsHelpers';
import { Kpi } from '../utils/kpiHelpers';
import {
  TrendingUp,
  TrendingDown,
  Minus,
  Loader2,
  BarChart3,
  Activity,
  Sparkles,
  RefreshCw,
  AlertCircle,
  Users,
  Target,
  Layers,
  Building2,
} from 'lucide-react';
import '../styles/admin-analytics.css';

interface AnalyticsProps {
  /** Scope analytics to a single user; omit for org-wide (admin). */
  userId?: string;
  title?: string;
  subtitle?: string;
}

const SUCCESS = 'var(--color-success)';
const WARNING = 'var(--color-warning)';
const DANGER = 'var(--color-danger)';

function filterDemoScope(data: AnalyticsData): AnalyticsData {
  const users = data.users.filter((u) => !u.is_demo);
  const userIds = new Set(users.map((u) => u.id));
  return {
    users,
    kpis: data.kpis.filter((k) => userIds.has(k.user_id)),
    submissions: data.submissions.filter((s) => userIds.has(s.user_id)),
  };
}

function attainmentBarClass(pct: number): string {
  if (pct >= 100) return 'admin-analytics-bar-fill--success';
  if (pct >= 85) return 'admin-analytics-bar-fill--warning';
  return 'admin-analytics-bar-fill--danger';
}

export default function Analytics({
  userId,
  title = 'Analytics',
  subtitle = 'Track KPI health, trends, forecasts, and attainment across your organization.',
}: AnalyticsProps) {
  const [data, setData] = useState<AnalyticsData | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState('');
  const [selectedKpiId, setSelectedKpiId] = useState<string>('');

  const load = useCallback(async (silent = false) => {
    if (!silent) setLoading(true);
    else setRefreshing(true);
    setError('');
    try {
      const raw = await fetchAnalyticsData(userId);
      const scoped = userId ? raw : filterDemoScope(raw);
      setData(scoped);
      if (scoped.kpis.length) {
        setSelectedKpiId((prev) =>
          prev && scoped.kpis.some((k) => k.id === prev) ? prev : scoped.kpis[0].id,
        );
      } else {
        setSelectedKpiId('');
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load analytics');
    } finally {
      if (!silent) setLoading(false);
      else setRefreshing(false);
    }
  }, [userId]);

  useEffect(() => {
    void load();
  }, [load]);

  const selectedKpi = useMemo(
    () => data?.kpis.find((k) => k.id === selectedKpiId),
    [data, selectedKpiId],
  );

  const trend = useMemo(() => {
    if (!data || !selectedKpi) return [];
    const subs = data.submissions.filter((s) => s.kpi_id === selectedKpi.id);
    const series = monthlyTrend(subs, 6);
    const hasData = series.some((p) => p.value !== 0);
    if (!hasData) {
      return series.map((p, i) => ({
        ...p,
        value: Number(selectedKpi.current_value) * (0.9 + (i / series.length) * 0.1),
      }));
    }
    return series;
  }, [data, selectedKpi]);

  const forecast = useMemo(() => linearForecast(trend.map((t) => t.value)), [trend]);

  if (loading) {
    return (
      <div className="admin-analytics-loading">
        <Loader2 className="animate-spin" size={32} style={{ color: 'var(--accent-primary)' }} />
        <span>Loading analytics…</span>
      </div>
    );
  }

  if (error) {
    return (
      <div className="admin-analytics-page">
        <div className="admin-analytics-alert" role="alert">
          <AlertCircle size={18} />
          <span>{error}</span>
        </div>
        <button type="button" className="btn btn-secondary btn-sm" onClick={() => void load()}>
          <RefreshCw size={14} /> Retry
        </button>
      </div>
    );
  }

  if (!data) return null;

  const dist = statusDistribution(data.kpis);
  const cats = categoryAttainment(data.kpis);
  const depts = departmentAttainment(data.kpis);
  const period = periodComparison(data.users, data.kpis);
  const employeeCount = data.users.filter((u) => u.role === 'employee' || u.role === 'manager').length;
  const submissionCount = data.submissions.length;

  const isOrgView = !userId;

  return (
    <div className="admin-analytics-page animate-fade-in">
      <header className="admin-analytics-header glass-panel">
        <div className="admin-analytics-header__main">
          <div className="admin-analytics-header__icon">
            <BarChart3 size={22} />
          </div>
          <div>
            <h2 className="admin-analytics-header__title">{title}</h2>
            <p className="admin-analytics-header__subtitle">{subtitle}</p>
          </div>
        </div>

        <div className="admin-analytics-stats">
          <div className="admin-analytics-stat admin-analytics-stat--accent">
            <span className="admin-analytics-stat__label">Total KPIs</span>
            <strong>{dist.total}</strong>
          </div>
          <div className="admin-analytics-stat admin-analytics-stat--success">
            <span className="admin-analytics-stat__label">On track</span>
            <strong>{dist.onTrack}</strong>
          </div>
          <div className="admin-analytics-stat admin-analytics-stat--warning">
            <span className="admin-analytics-stat__label">At risk</span>
            <strong>{dist.atRisk}</strong>
          </div>
          <div className="admin-analytics-stat admin-analytics-stat--danger">
            <span className="admin-analytics-stat__label">Off track</span>
            <strong>{dist.offTrack}</strong>
          </div>
          {isOrgView && (
            <>
              <div className="admin-analytics-stat">
                <span className="admin-analytics-stat__label">People tracked</span>
                <strong>{employeeCount}</strong>
              </div>
              <div className="admin-analytics-stat">
                <span className="admin-analytics-stat__label">Submissions</span>
                <strong>{submissionCount}</strong>
              </div>
            </>
          )}
        </div>
      </header>

      <div className="admin-analytics-grid">
        <section className="glass-panel admin-analytics-card">
          <p className="admin-analytics-card__eyebrow">Period comparison</p>
          <div className="admin-analytics-card__value-row">
            <span className="admin-analytics-card__value">{period.current}%</span>
            <ChangeBadge value={period.changePct} />
          </div>
          <p className="admin-analytics-card__hint">
            {period.label} · previous period {period.previous}%
          </p>
        </section>

        <section className="glass-panel admin-analytics-card">
          <p className="admin-analytics-card__eyebrow">KPI status distribution</p>
          <div className="admin-analytics-donut-wrap">
            <Donut dist={dist} />
            <div className="admin-analytics-legend">
              <Legend color={SUCCESS} label="On track" value={dist.onTrack} />
              <Legend color={WARNING} label="At risk" value={dist.atRisk} />
              <Legend color={DANGER} label="Off track" value={dist.offTrack} />
            </div>
          </div>
        </section>
      </div>

      <section className="glass-panel admin-analytics-section">
        <div className="admin-analytics-section__head">
          <div>
            <h3 className="admin-analytics-section__title">
              <Activity size={17} style={{ color: 'var(--accent-primary)' }} />
              Trend & predictive forecast
            </h3>
            <p className="admin-analytics-section__hint">
              Six-month submission trend with linear regression forecast for the selected KPI.
            </p>
          </div>
        </div>

        <div className="admin-analytics-toolbar">
          <div className="form-group">
            <label className="form-label" htmlFor="analytics-kpi-select">KPI</label>
            <select
              id="analytics-kpi-select"
              className="form-input"
              value={selectedKpiId}
              onChange={(e) => setSelectedKpiId(e.target.value)}
              disabled={!data.kpis.length}
            >
              {data.kpis.length === 0 ? (
                <option value="">No KPIs available</option>
              ) : (
                data.kpis.map((k: Kpi) => (
                  <option key={k.id} value={k.id}>{k.name}</option>
                ))
              )}
            </select>
          </div>
          <div className="admin-analytics-toolbar__actions">
            <button type="button" className="btn btn-secondary btn-sm" onClick={() => void load(true)} disabled={refreshing}>
              <RefreshCw size={14} className={refreshing ? 'animate-spin' : ''} />
              Refresh
            </button>
          </div>
        </div>

        {trend.length > 0 && selectedKpi ? (
          <>
            <LineChart points={trend} forecastValue={forecast.nextValue} />
            <div className="admin-analytics-forecast-meta">
              <div className="admin-analytics-forecast-meta__item">
                <Sparkles size={15} style={{ color: 'var(--accent-primary)' }} />
                Next-period forecast: <strong>{forecast.nextValue.toFixed(1)}</strong>
              </div>
              <div className="admin-analytics-forecast-meta__item">
                Direction:{' '}
                <strong style={{
                  color: forecast.direction === 'up' ? SUCCESS : forecast.direction === 'down' ? DANGER : 'var(--text-secondary)',
                }}>
                  {forecast.direction}
                </strong>
              </div>
              <div className="admin-analytics-forecast-meta__item">
                Model confidence (R²): <strong>{(forecast.confidence * 100).toFixed(0)}%</strong>
              </div>
              {selectedKpi.department && (
                <div className="admin-analytics-forecast-meta__item">
                  <Building2 size={14} />
                  {selectedKpi.department}
                </div>
              )}
            </div>
          </>
        ) : (
          <div className="admin-analytics-empty">
            <Target size={36} />
            <p>No KPI data available for trend analysis yet.</p>
          </div>
        )}
      </section>

      <div className="admin-analytics-two-col">
        <section className="glass-panel admin-analytics-section">
          <div className="admin-analytics-section__head">
            <div>
              <h3 className="admin-analytics-section__title">
                <Layers size={17} />
                Attainment by category
              </h3>
              <p className="admin-analytics-section__hint">Average progress vs target grouped by KPI category.</p>
            </div>
          </div>
          {cats.length > 0 ? (
            <div className="admin-analytics-bars">
              {cats.map((c) => (
                <div key={c.category} className="admin-analytics-bar-row">
                  <div className="admin-analytics-bar-row__head">
                    <span className="admin-analytics-bar-row__label">{c.category}</span>
                    <span className="admin-analytics-bar-row__pct">{c.attainment}%</span>
                  </div>
                  <div className="admin-analytics-bar-track">
                    <div
                      className={`admin-analytics-bar-fill ${attainmentBarClass(c.attainment)}`}
                      style={{ width: `${Math.min(100, c.attainment)}%` }}
                    />
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <div className="admin-analytics-empty" style={{ padding: '2rem 1rem' }}>
              <Layers size={32} />
              <p>No category data yet.</p>
            </div>
          )}
        </section>

        <section className="glass-panel admin-analytics-section">
          <div className="admin-analytics-section__head">
            <div>
              <h3 className="admin-analytics-section__title">
                <Users size={17} />
                Attainment by department
              </h3>
              <p className="admin-analytics-section__hint">Department-level KPI performance snapshot.</p>
            </div>
          </div>
          {depts.length > 0 ? (
            <div className="admin-analytics-bars">
              {depts.map((d) => (
                <div key={d.category} className="admin-analytics-bar-row">
                  <div className="admin-analytics-bar-row__head">
                    <span className="admin-analytics-bar-row__label">{d.category}</span>
                    <span className="admin-analytics-bar-row__pct">{d.attainment}%</span>
                  </div>
                  <div className="admin-analytics-bar-track">
                    <div
                      className={`admin-analytics-bar-fill ${attainmentBarClass(d.attainment)}`}
                      style={{ width: `${Math.min(100, d.attainment)}%` }}
                    />
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <div className="admin-analytics-empty" style={{ padding: '2rem 1rem' }}>
              <Building2 size={32} />
              <p>No department KPI data yet.</p>
            </div>
          )}
        </section>
      </div>
    </div>
  );
}

function ChangeBadge({ value }: { value: number }) {
  const up = value > 0;
  const flat = value === 0;
  const Icon = flat ? Minus : up ? TrendingUp : TrendingDown;
  const cls = flat ? 'admin-analytics-change--flat' : up ? 'admin-analytics-change--up' : 'admin-analytics-change--down';
  return (
    <span className={`admin-analytics-change ${cls}`}>
      <Icon size={15} />
      {Math.abs(value)}%
    </span>
  );
}

function Legend({ color, label, value }: { color: string; label: string; value: number }) {
  return (
    <div className="admin-analytics-legend__item">
      <span className="admin-analytics-legend__dot" style={{ background: color }} />
      {label}
      <span className="admin-analytics-legend__value">{value}</span>
    </div>
  );
}

function Donut({ dist }: { dist: { onTrack: number; atRisk: number; offTrack: number; total: number } }) {
  const size = 100;
  const stroke = 14;
  const r = (size - stroke) / 2;
  const circ = 2 * Math.PI * r;
  const total = dist.total || 1;
  const segments = [
    { color: SUCCESS, frac: dist.onTrack / total },
    { color: WARNING, frac: dist.atRisk / total },
    { color: DANGER, frac: dist.offTrack / total },
  ];
  let offset = 0;
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden>
      <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="color-mix(in srgb, var(--text-primary) 8%, transparent)" strokeWidth={stroke} />
      {segments.map((s, i) => {
        const len = s.frac * circ;
        const el = (
          <circle
            key={i}
            cx={size / 2}
            cy={size / 2}
            r={r}
            fill="none"
            stroke={s.color}
            strokeWidth={stroke}
            strokeDasharray={`${len} ${circ - len}`}
            strokeDashoffset={-offset}
            transform={`rotate(-90 ${size / 2} ${size / 2})`}
          />
        );
        offset += len;
        return el;
      })}
      <text x="50%" y="50%" textAnchor="middle" dominantBaseline="central" fill="var(--text-primary)" fontSize="22" fontWeight="700">
        {dist.total}
      </text>
    </svg>
  );
}

function LineChart({ points, forecastValue }: { points: { label: string; value: number }[]; forecastValue: number }) {
  const w = 640;
  const h = 200;
  const padX = 36;
  const padY = 24;
  const all = [...points.map((p) => p.value), forecastValue];
  const max = Math.max(...all, 1);
  const min = Math.min(...all, 0);
  const range = max - min || 1;
  const n = points.length;
  const stepX = (w - padX * 2) / Math.max(1, n - 1);

  const xy = (i: number, v: number) => {
    const x = padX + i * stepX;
    const y = h - padY - ((v - min) / range) * (h - padY * 2);
    return { x, y };
  };

  const path = points.map((p, i) => {
    const { x, y } = xy(i, p.value);
    return `${i === 0 ? 'M' : 'L'} ${x.toFixed(1)} ${y.toFixed(1)}`;
  }).join(' ');

  const last = xy(n - 1, points[n - 1]?.value ?? 0);
  const fc = xy(n - 1 + 1, forecastValue);
  const fcX = Math.min(w - padX / 2, fc.x);

  return (
    <svg className="admin-analytics-chart" width="100%" viewBox={`0 0 ${w} ${h}`}>
      <defs>
        <linearGradient id="admin-analytics-fill" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="var(--accent-primary)" stopOpacity="0.25" />
          <stop offset="100%" stopColor="var(--accent-primary)" stopOpacity="0" />
        </linearGradient>
      </defs>
      <path d={`${path} L ${last.x} ${h - padY} L ${padX} ${h - padY} Z`} fill="url(#admin-analytics-fill)" />
      <path d={path} fill="none" stroke="var(--accent-primary)" strokeWidth={2.5} strokeLinejoin="round" />
      <path
        d={`M ${last.x} ${last.y} L ${fcX} ${fc.y}`}
        fill="none"
        stroke="var(--accent-secondary, var(--accent-primary))"
        strokeWidth={2.5}
        strokeDasharray="5 5"
      />
      <circle cx={fcX} cy={fc.y} r={5} fill="var(--accent-secondary, var(--accent-primary))" />
      {points.map((p, i) => {
        const { x, y } = xy(i, p.value);
        return (
          <g key={i}>
            <circle cx={x} cy={y} r={3.5} fill="var(--accent-primary)" />
            <text x={x} y={h - 6} textAnchor="middle" fontSize="11" fill="var(--text-muted)">{p.label}</text>
          </g>
        );
      })}
      <text x={fcX} y={h - 6} textAnchor="middle" fontSize="11" fill="var(--accent-secondary, var(--accent-primary))">Next</text>
    </svg>
  );
}
