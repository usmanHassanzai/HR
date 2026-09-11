import { useCallback, useEffect, useState } from 'react';
import { supabase } from '../lib/supabase';
import {
  AlertCircle,
  CheckCircle2,
  Gift,
  Loader2,
  PlayCircle,
  Settings2,
} from 'lucide-react';
import type { KpiAwardConfig, KpiAwardPipelineRow } from '../utils/kpiAwardHelpers';
import { awardRuleLabel } from '../utils/kpiAwardHelpers';

export default function AdminKpiAwardsPanel() {
  const [pipeline, setPipeline] = useState<KpiAwardPipelineRow[]>([]);
  const [config, setConfig] = useState<KpiAwardConfig | null>(null);
  const [form, setForm] = useState<Partial<KpiAwardConfig>>({});
  const [loading, setLoading] = useState(true);
  const [running, setRunning] = useState(false);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    const [cfgRes, pipeRes] = await Promise.all([
      supabase.rpc('get_kpi_award_config'),
      supabase.rpc('get_kpi_award_pipeline'),
    ]);
    if (cfgRes.error) setMsg(`Error: ${cfgRes.error.message}`);
    else {
      const row = ((cfgRes.data || []) as KpiAwardConfig[])[0] || null;
      setConfig(row);
      if (row) setForm(row);
    }
    if (pipeRes.error && !cfgRes.error) setMsg(`Error: ${pipeRes.error.message}`);
    else setPipeline((pipeRes.data || []) as KpiAwardPipelineRow[]);
    setLoading(false);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const runCheck = async () => {
    setRunning(true);
    setMsg('');
    const { data, error } = await supabase.rpc('evaluate_kpi_awards');
    setRunning(false);
    if (error) {
      setMsg(`Error: ${error.message}`);
      return;
    }
    setMsg(`Check complete — ${Number(data) || 0} new qualification(s).`);
    await load();
  };

  const saveConfig = async () => {
    if (!form.movie_reward_name?.trim() || !form.dinner_reward_name?.trim() || !form.gift_reward_name?.trim()) {
      setMsg('Error: Reward names are required.');
      return;
    }
    setSaving(true);
    setMsg('');
    const { error } = await supabase.rpc('update_kpi_award_config', {
      p_movie_min: Number(form.movie_min_pct),
      p_movie_max: Number(form.movie_max_pct),
      p_movie_months: Number(form.movie_months),
      p_movie_name: form.movie_reward_name.trim(),
      p_dinner_min: Number(form.dinner_min_pct),
      p_dinner_max: Number(form.dinner_max_pct),
      p_dinner_months: Number(form.dinner_months || 1),
      p_dinner_name: form.dinner_reward_name.trim(),
      p_gift_min: Number(form.gift_min_pct),
      p_gift_max: Number(form.gift_max_pct ?? 100),
      p_gift_months: Number(form.gift_months),
      p_gift_name: form.gift_reward_name.trim(),
    });
    setSaving(false);
    if (error) {
      setMsg(`Error: ${error.message}`);
      return;
    }
    setMsg('Award settings saved. They apply to the next check.');
    await load();
  };

  const setStatus = async (id: string, status: string) => {
    setMsg('');
    const { error } = await supabase.rpc('set_kpi_award_status', { p_id: id, p_status: status });
    if (error) setMsg(`Error: ${error.message}`);
    else {
      setMsg(
        status === 'rejected'
          ? 'Request rejected — weightage returned.'
          : status === 'fulfilled' || status === 'issued'
            ? 'Marked as fulfilled.'
            : status === 'approved'
              ? 'Gift approved.'
              : `Status: ${status}.`,
      );
      await load();
    }
  };

  const eligible = pipeline.filter((r) => r.bucket === 'eligible');
  const close = pipeline.filter((r) => r.bucket === 'close');

  if (loading && !config) {
    return (
      <div className="admin-rewards-loading">
        <Loader2 size={28} className="spin-icon" />
        <span>Loading KPI awards…</span>
      </div>
    );
  }

  return (
    <div className="kpi-award-admin">
      {msg && (
        <div className={`admin-rewards-alert ${/^error/i.test(msg) ? 'admin-rewards-alert--error' : 'admin-rewards-alert--success'}`} role="alert">
          {/^error/i.test(msg) ? <AlertCircle size={18} /> : <CheckCircle2 size={18} />}
          <span>{msg}</span>
        </div>
      )}

      <section className="admin-rewards-card glass-panel">
        <div className="admin-rewards-card__head">
          <div>
              <h3>
              <Gift size={18} /> Milestone awards
            </h3>
            <p>Company gifts from KPI score: movie tickets, dinner for 2, and surprise gift. Approve, then mark fulfilled when delivered.</p>
          </div>
          <button type="button" className="btn btn-primary btn-sm" onClick={() => void runCheck()} disabled={running}>
            {running ? <Loader2 size={14} className="spin-icon" /> : <PlayCircle size={14} />}
            Run check now
          </button>
        </div>
        {eligible.length === 0 ? (
          <div className="admin-rewards-empty">
            <CheckCircle2 size={36} strokeWidth={1.25} />
            <h4>No one waiting</h4>
            <p>Run the check after monthly scores are in, or wait for the 1st-of-month job.</p>
          </div>
        ) : (
          <div className="admin-rewards-table-wrap">
            <table className="admin-rewards-table">
              <thead>
                <tr>
                  <th>Person</th>
                  <th>Reward</th>
                  <th>Why</th>
                  <th>Status</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {eligible.map((r) => (
                  <tr key={r.qualification_id || `${r.employee_id}-${r.rule_key}`}>
                    <td>
                      <strong>{r.full_name}</strong>
                      <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>{r.email}</div>
                    </td>
                    <td>{r.reward_name}</td>
                    <td style={{ fontSize: '0.82rem' }}>{r.detail}</td>
                    <td style={{ textTransform: 'capitalize' }}>{r.status || 'pending'}</td>
                    <td>
                      {r.qualification_id && (r.status === 'pending' || r.status === 'pending_fulfillment') && (
                        <button type="button" className="btn btn-secondary btn-sm" onClick={() => void setStatus(r.qualification_id!, 'approved')}>
                          Approve
                        </button>
                      )}
                      {r.qualification_id && r.status !== 'issued' && r.status !== 'fulfilled' && r.status !== 'dismissed' && (
                        <>
                          <button type="button" className="btn btn-primary btn-sm" style={{ marginLeft: '0.35rem' }} onClick={() => void setStatus(r.qualification_id!, 'fulfilled')}>
                            Fulfilled
                          </button>
                          <button
                            type="button"
                            className="btn btn-secondary btn-sm"
                            style={{ marginLeft: '0.35rem' }}
                            onClick={() => {
                              if (window.confirm(`Reject this gift request for ${r.full_name}? Weightage will be returned.`)) {
                                void setStatus(r.qualification_id!, 'rejected');
                              }
                            }}
                          >
                            Reject
                          </button>
                        </>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="admin-rewards-card glass-panel">
        <h3>Close to a reward</h3>
        <p>One or two months (or a few percent) away — follow up so nobody is missed.</p>
        {close.length === 0 ? (
          <p className="admin-rewards-empty" style={{ padding: '1.25rem' }}>Nobody is close this period.</p>
        ) : (
          <ul className="kpi-award-close-list">
            {close.map((r) => (
              <li key={`${r.employee_id}-${r.rule_key}`}>
                <strong>{r.full_name}</strong>
                <span> · {awardRuleLabel(r.rule_key)}</span>
                <p>{r.detail}</p>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="admin-rewards-card glass-panel">
        <div className="admin-rewards-card__head">
          <div>
            <h3>
              <Settings2 size={18} /> Award settings
            </h3>
            <p>Change weightage targets, streak length, or gift names for this company only. Targets use completed KPI weightage (0–100%).</p>
          </div>
        </div>
        <div className="kpi-award-settings">
          <fieldset>
            <legend>Consistent Good Performer (movie tickets)</legend>
            <label>
              Min weightage %
              <input type="number" min={0} max={100} value={form.movie_min_pct ?? 90} onChange={(e) => setForm({ ...form, movie_min_pct: Number(e.target.value) })} />
            </label>
            <label>
              Max weightage %
              <input type="number" min={0} max={100} step={0.01} value={form.movie_max_pct ?? 95} onChange={(e) => setForm({ ...form, movie_max_pct: Number(e.target.value) })} />
              <span style={{ display: 'block', fontSize: '0.72rem', color: 'var(--text-muted)', marginTop: '0.25rem' }}>
                Streak requires this band every month in a row (default 90–95%).
              </span>
            </label>
            <label>
              Months
              <input type="number" min={1} max={24} value={form.movie_months ?? 3} onChange={(e) => setForm({ ...form, movie_months: Number(e.target.value) })} />
            </label>
            <label className="kpi-award-settings__wide">
              Reward name
              <input value={form.movie_reward_name ?? ''} onChange={(e) => setForm({ ...form, movie_reward_name: e.target.value })} />
            </label>
          </fieldset>
          <fieldset>
            <legend>Outstanding Month (dinner)</legend>
            <label>
              Min weightage %
              <input type="number" min={0} max={100} value={form.dinner_min_pct ?? 95} onChange={(e) => setForm({ ...form, dinner_min_pct: Number(e.target.value) })} />
            </label>
            <label>
              Max weightage %
              <input type="number" min={0} max={100} value={form.dinner_max_pct ?? 100} onChange={(e) => setForm({ ...form, dinner_max_pct: Number(e.target.value) })} />
            </label>
            <label className="kpi-award-settings__wide">
              Reward name
              <input value={form.dinner_reward_name ?? ''} onChange={(e) => setForm({ ...form, dinner_reward_name: e.target.value })} />
            </label>
          </fieldset>
          <fieldset>
            <legend>Elite Consistency (surprise gift)</legend>
            <label>
              Min weightage %
              <input type="number" min={0} max={100} value={form.gift_min_pct ?? 90} onChange={(e) => setForm({ ...form, gift_min_pct: Number(e.target.value) })} />
            </label>
            <label>
              Max weightage %
              <input type="number" min={0} max={100} step={0.01} value={form.gift_max_pct ?? 95} onChange={(e) => setForm({ ...form, gift_max_pct: Number(e.target.value) })} />
              <span style={{ display: 'block', fontSize: '0.72rem', color: 'var(--text-muted)', marginTop: '0.25rem' }}>
                Must hit this band every month in a row (default 90–95%).
              </span>
            </label>
            <label>
              Months
              <input type="number" min={1} max={24} value={form.gift_months ?? 6} onChange={(e) => setForm({ ...form, gift_months: Number(e.target.value) })} />
            </label>
            <label className="kpi-award-settings__wide">
              Reward name
              <input value={form.gift_reward_name ?? ''} onChange={(e) => setForm({ ...form, gift_reward_name: e.target.value })} />
            </label>
          </fieldset>
          <button type="button" className="btn btn-primary" disabled={saving} onClick={() => void saveConfig()}>
            {saving ? <Loader2 size={14} className="spin-icon" /> : null}
            Save settings
          </button>
        </div>
      </section>
    </div>
  );
}
