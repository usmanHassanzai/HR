import { useCallback, useEffect, useState } from 'react';
import { supabase } from '../lib/supabase';
import { Profile } from '../utils/kpiHelpers';
import {
  Trophy,
  Gift,
  Loader2,
  CheckCircle,
  AlertCircle,
  Users,
  ArrowLeft,
  ChevronRight,
} from 'lucide-react';
import type { KpiAwardPipelineRow, KpiAwardProgress } from '../utils/kpiAwardHelpers';
import { awardGiftLine } from '../utils/kpiAwardHelpers';
import KpiAwardProgressList from './KpiAwardProgressList';
import '../styles/manager-rewards.css';
import '../styles/employee-rewards.css';

interface ManagerRewardsPanelProps {
  managerId: string;
}

type TeamGiftRow = {
  id: string;
  full_name: string;
  email: string;
  isSelf: boolean;
  progress: KpiAwardProgress[];
};

function statusLabel(status: string): string {
  if (status === 'approved') return 'Approved';
  if (status === 'issued' || status === 'fulfilled') return 'Delivered';
  return 'Pending';
}

export default function ManagerRewardsPanel({ managerId }: ManagerRewardsPanelProps) {
  const [myProgress, setMyProgress] = useState<KpiAwardProgress[]>([]);
  const [team, setTeam] = useState<TeamGiftRow[]>([]);
  const [queue, setQueue] = useState<KpiAwardPipelineRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [msg, setMsg] = useState('');
  const [msgError, setMsgError] = useState(false);
  const [selected, setSelected] = useState<TeamGiftRow | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    const [mineRes, reportsRes, pipeRes] = await Promise.all([
      supabase.rpc('get_kpi_award_progress', { p_user_id: managerId }),
      supabase.rpc('get_direct_reports', { p_manager_id: managerId }),
      supabase.rpc('get_kpi_award_pipeline'),
    ]);

    if (mineRes.data) setMyProgress(mineRes.data as KpiAwardProgress[]);

    const members = ((reportsRes.data || []) as Profile[]).filter((u) => !u.is_demo);
    const progressLists = await Promise.all(
      members.map((m) => supabase.rpc('get_kpi_award_progress', { p_user_id: m.id })),
    );

    const nextTeam: TeamGiftRow[] = [
      {
        id: managerId,
        full_name: 'You',
        email: '',
        isSelf: true,
        progress: (mineRes.data || []) as KpiAwardProgress[],
      },
      ...members.map((m, i) => ({
        id: m.id,
        full_name: m.full_name,
        email: m.email,
        isSelf: false,
        progress: (progressLists[i]?.data || []) as KpiAwardProgress[],
      })),
    ];
    setTeam(nextTeam);
    setSelected((prev) => (prev ? nextTeam.find((t) => t.id === prev.id) ?? null : null));

    if (pipeRes.error) {
      setQueue([]);
    } else {
      setQueue(((pipeRes.data || []) as KpiAwardPipelineRow[]).filter((r) => r.bucket === 'eligible'));
    }
    setLoading(false);
  }, [managerId]);

  useEffect(() => {
    void load();
  }, [load]);

  const updateGift = async (id: string, status: string) => {
    setMsg('');
    setMsgError(false);
    const { error } = await supabase.rpc('set_kpi_award_status', { p_id: id, p_status: status });
    if (error) {
      setMsgError(true);
      setMsg(error.message);
    } else {
      setMsg(status === 'fulfilled' || status === 'issued' ? 'Gift marked delivered.' : 'Gift approved.');
      void load();
    }
  };

  if (loading && myProgress.length === 0 && team.length === 0) {
    return (
      <div className="mgr-rewards-loading">
        <Loader2 size={28} className="spin-icon" />
        <span>Loading rewards…</span>
      </div>
    );
  }

  return (
    <div className="mgr-rewards-page animate-fade-in">
      <header className="mgr-rewards-header glass-panel">
        <div className="mgr-rewards-header__main">
          <div className="mgr-rewards-header__icon">
            <Trophy size={22} />
          </div>
          <div>
            <h2 className="mgr-rewards-header__title">Company rewards</h2>
            <p className="mgr-rewards-header__subtitle">
              The same three gifts as employees: movie tickets, dinner for 2, and a surprise gift. You can earn them too, and approve them person by person.
            </p>
          </div>
        </div>
        <div className="mgr-rewards-stats">
          <div className="mgr-rewards-stat mgr-rewards-stat--gold">
            <span className="mgr-rewards-stat__label">Gifts to arrange</span>
            <strong>{queue.length}</strong>
          </div>
        </div>
      </header>

      {msg && (
        <div className={`mgr-rewards-alert ${msgError ? 'mgr-rewards-alert--error' : 'mgr-rewards-alert--success'}`}>
          {msgError ? <AlertCircle size={16} /> : <CheckCircle size={16} />}
          <span>{msg}</span>
        </div>
      )}

      <KpiAwardProgressList
        rows={myProgress}
        title="Your rewards"
        intro="These gifts come from your monthly KPI score — the same rules as everyone else."
      />

      <section className="mgr-rewards-card">
        <h3>
          <Gift size={18} /> Gifts to arrange
          {queue.length > 0 && <span className="mgr-rewards-count-badge">{queue.length}</span>}
        </h3>
        <p>Approve, then mark delivered when the gift is given.</p>
        {queue.length === 0 ? (
          <div className="mgr-rewards-empty">
            <CheckCircle size={36} strokeWidth={1.25} />
            <h4>Nothing waiting</h4>
            <p>No pending movie tickets, dinner vouchers, or surprise gifts right now.</p>
          </div>
        ) : (
          <div className="mgr-rewards-queue">
            {queue.map((r) => (
              <article key={r.qualification_id || `${r.employee_id}-${r.rule_key}`} className="mgr-rewards-queue-item">
                <div className="mgr-rewards-queue-item__body">
                  <strong>{r.full_name}</strong>
                  <span>{r.reward_name} · {statusLabel(r.status || 'pending')}</span>
                </div>
                {r.qualification_id && (r.status === 'pending' || r.status === 'pending_fulfillment') && (
                  <button type="button" className="btn btn-secondary btn-sm" onClick={() => void updateGift(r.qualification_id!, 'approved')}>
                    Approve
                  </button>
                )}
                {r.qualification_id && r.status !== 'issued' && r.status !== 'fulfilled' && (
                  <button type="button" className="btn btn-primary btn-sm" onClick={() => void updateGift(r.qualification_id!, 'fulfilled')}>
                    Delivered
                  </button>
                )}
              </article>
            ))}
          </div>
        )}
      </section>

      <section className="mgr-rewards-card">
        <h3>
          <Users size={18} /> Each person
        </h3>
        <p>Progress toward each company gift. Tap a person for details.</p>
        {team.length === 0 ? (
          <p className="mgr-rewards-empty" style={{ padding: '1rem' }}>No team members to show yet.</p>
        ) : (
          <div className="mgr-rewards-table-wrap">
            <table className="mgr-rewards-table">
              <thead>
                <tr>
                  <th>Person</th>
                  <th>2 movie tickets</th>
                  <th>Dinner for 2</th>
                  <th>Surprise gift</th>
                  <th className="mgr-rewards-table__chevron-col" aria-hidden />
                </tr>
              </thead>
              <tbody>
                {team.map((m) => (
                  <tr
                    key={m.id}
                    className="mgr-rewards-table__row--clickable"
                    tabIndex={0}
                    role="button"
                    aria-label={`View gift progress for ${m.full_name}`}
                    onClick={() => setSelected(m)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        setSelected(m);
                      }
                    }}
                  >
                    <td>
                      <strong>{m.full_name}</strong>
                      {m.email ? <div className="mgr-rewards-table__email">{m.email}</div> : null}
                    </td>
                    <td>{awardGiftLine(m.progress.find((r) => r.rule_key === 'movie_tickets'), '0/3 months')}</td>
                    <td>{awardGiftLine(m.progress.find((r) => r.rule_key === 'dinner_voucher'), '0/1 month')}</td>
                    <td>{awardGiftLine(m.progress.find((r) => r.rule_key === 'surprise_gift'), '0/6 months')}</td>
                    <td className="mgr-rewards-table__chevron-col">
                      <ChevronRight size={16} aria-hidden />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {selected && (
        <div className="mgr-rewards-person-overlay" onClick={() => setSelected(null)} role="presentation">
          <div
            className="mgr-rewards-person-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="mgr-rewards-person-title"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="mgr-rewards-person-dialog__top">
              <button type="button" className="mgr-rewards-person-back" onClick={() => setSelected(null)}>
                <ArrowLeft size={18} />
                Back
              </button>
            </div>
            <header className="mgr-rewards-person-dialog__header">
              <h2 id="mgr-rewards-person-title">{selected.full_name}</h2>
              {selected.email ? <p>{selected.email}</p> : null}
            </header>
            <KpiAwardProgressList
              rows={selected.progress}
              title={selected.isSelf ? 'Your gift progress' : `${selected.full_name}'s gift progress`}
              intro="Months in band count toward each gift. Dinner needs one month in the score band — scores above the band do not count."
            />
          </div>
        </div>
      )}
    </div>
  );
}
