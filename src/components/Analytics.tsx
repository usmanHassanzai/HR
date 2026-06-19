import { useEffect, useMemo, useState } from 'react';
import {
  fetchAnalyticsData,
  AnalyticsData,
  monthlyTrend,
  linearForecast,
  statusDistribution,
  categoryAttainment,
  periodComparison,
} from '../utils/analyticsHelpers';
import { Kpi } from '../utils/kpiHelpers';
import { TrendingUp, TrendingDown, Minus, Loader2, BarChart3, Activity, Sparkles } from 'lucide-react';

interface AnalyticsProps {
  /** Scope analytics to a single user; omit for org-wide (admin). */
  userId?: string;
  title?: string;
}

const SUCCESS = 'var(--color-success)';
const WARNING = 'var(--color-warning)';
const DANGER = 'var(--color-danger)';
const ACCENT = 'var(--accent-primary)';

export default function Analytics({ userId, title = 'Advanced Analytics' }: AnalyticsProps) {
  const [data, setData] = useState<AnalyticsData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [selectedKpiId, setSelectedKpiId] = useState<string>('');

  useEffect(() => {
    let active = true;
    setLoading(true);
    fetchAnalyticsData(userId)
      .then((d) => {
        if (!active) return;
        setData(d);
        if (d.kpis.length) setSelectedKpiId(d.kpis[0].id);
      })
      .catch((e) => active && setError(e.message))
      .finally(() => active && setLoading(false));
    return () => {
      active = false;
    };
  }, [userId]);

  const selectedKpi = useMemo(
    () => data?.kpis.find((k) => k.id === selectedKpiId),
    [data, selectedKpiId]
  );

  const trend = useMemo(() => {
    if (!data || !selectedKpi) return [];
    const subs = data.submissions.filter((s) => s.kpi_id === selectedKpi.id);
    const series = monthlyTrend(subs, 6);
    // If there is no submission history, synthesize a baseline from current value.
    const hasData = series.some((p) => p.value !== 0);
    if (!hasData && selectedKpi) {
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
      <div style={{ display: 'flex', justifyContent: 'center', padding: '3rem' }}>
        <Loader2 size={28} className="animate-spin" style={{ color: ACCENT, animation: 'spin 1s linear infinite' }} />
      </div>
    );
  }
  if (error) {
    return <div className="glass-panel" style={{ borderLeft: `4px solid ${DANGER}` }}>{error}</div>;
  }
  if (!data) return null;

  const dist = statusDistribution(data.kpis);
  const cats = categoryAttainment(data.kpis);
  const period = periodComparison(data.users, data.kpis);

  return (
    <div className="animate-fade-in" style={{ display: 'flex', flexDirection: 'column', gap: '1.5rem' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '0.6rem' }}>
        <BarChart3 size={20} style={{ color: ACCENT }} />
        <h3 style={{ margin: 0 }}>{title}</h3>
      </div>

      {/* Top metric row: period comparison + status donut */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))', gap: '1.5rem' }}>
        <div className="glass-panel">
          <p style={{ fontSize: '0.75rem', textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--text-muted)' }}>
            Year-over-Period Comparison
          </p>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: '0.75rem', marginTop: '0.5rem' }}>
            <span style={{ fontSize: '2.5rem', fontFamily: 'var(--font-display)', fontWeight: 800 }}>{period.current}%</span>
            <ChangeBadge value={period.changePct} />
          </div>
          <p style={{ fontSize: '0.85rem', marginTop: '0.25rem' }}>
            {period.label} · previous {period.previous}%
          </p>
        </div>

        <div className="glass-panel">
          <p style={{ fontSize: '0.75rem', textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--text-muted)', marginBottom: '0.75rem' }}>
            KPI Status Distribution
          </p>
          <div style={{ display: 'flex', alignItems: 'center', gap: '1.25rem' }}>
            <Donut dist={dist} />
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.4rem', fontSize: '0.85rem' }}>
              <Legend color={SUCCESS} label="On Track" value={dist.onTrack} />
              <Legend color={WARNING} label="At Risk" value={dist.atRisk} />
              <Legend color={DANGER} label="Off Track" value={dist.offTrack} />
            </div>
          </div>
        </div>
      </div>

      {/* Trend + predictive forecast */}
      <div className="glass-panel">
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '0.75rem', marginBottom: '1rem' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            <Activity size={16} style={{ color: ACCENT }} />
            <strong>Trend & Predictive Forecast</strong>
          </div>
          {data.kpis.length > 0 && (
            <select value={selectedKpiId} onChange={(e) => setSelectedKpiId(e.target.value)} style={{ width: 'auto', minWidth: '200px' }}>
              {data.kpis.map((k: Kpi) => (
                <option key={k.id} value={k.id}>{k.name}</option>
              ))}
            </select>
          )}
        </div>

        {trend.length > 0 ? (
          <>
            <LineChart points={trend} forecastValue={forecast.nextValue} />
            <div style={{ display: 'flex', gap: '1.5rem', flexWrap: 'wrap', marginTop: '1rem', fontSize: '0.85rem' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
                <Sparkles size={15} style={{ color: ACCENT }} />
                <span>
                  Next-period forecast:{' '}
                  <strong>{forecast.nextValue.toFixed(1)}</strong>
                </span>
              </div>
              <span style={{ color: 'var(--text-muted)' }}>
                Direction:{' '}
                <span style={{ color: forecast.direction === 'up' ? SUCCESS : forecast.direction === 'down' ? DANGER : 'var(--text-secondary)' }}>
                  {forecast.direction}
                </span>
              </span>
              <span style={{ color: 'var(--text-muted)' }}>
                Model confidence (R²): <strong>{(forecast.confidence * 100).toFixed(0)}%</strong>
              </span>
            </div>
          </>
        ) : (
          <p style={{ color: 'var(--text-muted)' }}>No KPI data available for trend analysis.</p>
        )}
      </div>

      {/* Category attainment bars */}
      <div className="glass-panel">
        <strong style={{ display: 'block', marginBottom: '1rem' }}>Attainment by Category</strong>
        {cats.length > 0 ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.85rem' }}>
            {cats.map((c) => (
              <div key={c.category}>
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.85rem', marginBottom: '0.3rem' }}>
                  <span>{c.category}</span>
                  <strong>{c.attainment}%</strong>
                </div>
                <div style={{ height: '10px', background: 'rgba(255,255,255,0.06)', borderRadius: '9999px', overflow: 'hidden' }}>
                  <div
                    style={{
                      width: `${Math.min(100, c.attainment)}%`,
                      height: '100%',
                      borderRadius: '9999px',
                      background: c.attainment >= 100 ? SUCCESS : c.attainment >= 85 ? WARNING : DANGER,
                      transition: 'width 0.6s ease',
                    }}
                  />
                </div>
              </div>
            ))}
          </div>
        ) : (
          <p style={{ color: 'var(--text-muted)' }}>No categories to display.</p>
        )}
      </div>
    </div>
  );
}

function ChangeBadge({ value }: { value: number }) {
  const up = value > 0;
  const flat = value === 0;
  const color = flat ? 'var(--text-muted)' : up ? SUCCESS : DANGER;
  const Icon = flat ? Minus : up ? TrendingUp : TrendingDown;
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: '0.25rem', color, fontWeight: 600, fontSize: '0.95rem' }}>
      <Icon size={16} /> {Math.abs(value)}%
    </span>
  );
}

function Legend({ color, label, value }: { color: string; label: string; value: number }) {
  return (
    <span style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
      <span style={{ width: 10, height: 10, borderRadius: 2, background: color, display: 'inline-block' }} />
      {label} <strong style={{ marginLeft: 'auto' }}>{value}</strong>
    </span>
  );
}

function Donut({ dist }: { dist: { onTrack: number; atRisk: number; offTrack: number; total: number } }) {
  const size = 96;
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
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
      <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="rgba(255,255,255,0.06)" strokeWidth={stroke} />
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
            strokeLinecap="butt"
          />
        );
        offset += len;
        return el;
      })}
      <text x="50%" y="50%" textAnchor="middle" dominantBaseline="central" fill="var(--text-primary)" fontSize="20" fontWeight="700">
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
  // Clamp forecast x within view.
  const fcX = Math.min(w - padX / 2, fc.x);

  return (
    <svg width="100%" viewBox={`0 0 ${w} ${h}`} style={{ overflow: 'visible' }}>
      <defs>
        <linearGradient id="lc-fill" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="var(--accent-primary)" stopOpacity="0.25" />
          <stop offset="100%" stopColor="var(--accent-primary)" stopOpacity="0" />
        </linearGradient>
      </defs>

      {/* Area fill */}
      <path d={`${path} L ${last.x} ${h - padY} L ${padX} ${h - padY} Z`} fill="url(#lc-fill)" />
      {/* Main line */}
      <path d={path} fill="none" stroke="var(--accent-primary)" strokeWidth={2.5} strokeLinejoin="round" />
      {/* Forecast dashed segment */}
      <path
        d={`M ${last.x} ${last.y} L ${fcX} ${fc.y}`}
        fill="none"
        stroke="var(--accent-secondary)"
        strokeWidth={2.5}
        strokeDasharray="5 5"
      />
      <circle cx={fcX} cy={fc.y} r={5} fill="var(--accent-secondary)" />

      {/* Points + labels */}
      {points.map((p, i) => {
        const { x, y } = xy(i, p.value);
        return (
          <g key={i}>
            <circle cx={x} cy={y} r={3.5} fill="var(--accent-primary)" />
            <text x={x} y={h - 6} textAnchor="middle" fontSize="11" fill="var(--text-muted)">{p.label}</text>
          </g>
        );
      })}
      <text x={fcX} y={h - 6} textAnchor="middle" fontSize="11" fill="var(--accent-secondary)">Next</text>
    </svg>
  );
}
