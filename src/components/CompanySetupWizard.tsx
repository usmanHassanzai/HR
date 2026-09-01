import { useEffect, useState } from 'react';
import { Building2, CheckCircle2, Loader2, Plus, Trash2, Users, Clock, Target } from 'lucide-react';
import { supabase, supabaseSignup } from '../lib/supabase';
import { Profile } from '../utils/kpiHelpers';
import { Company } from '../utils/companyHelpers';
import { KPI_CATEGORIES } from '../utils/kpiCategories';
import PasswordField from './PasswordField';
import '../styles/company-register.css';

interface CompanySetupWizardProps {
  profile: Profile;
  company: Company;
  onFinished: () => void;
}

type WizardStep = 1 | 2 | 3 | 4;

type DraftPerson = { name: string; email: string; password: string };

function monthRange(): { start: string; end: string } {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const last = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
  return { start: `${y}-${m}-01`, end: `${y}-${m}-${String(last).padStart(2, '0')}` };
}

export default function CompanySetupWizard({ profile, company, onFinished }: CompanySetupWizardProps) {
  const [step, setStep] = useState<WizardStep>(1);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [people, setPeople] = useState<DraftPerson[]>([{ name: '', email: '', password: '' }]);
  const [addedCount, setAddedCount] = useState(0);
  const [shiftName, setShiftName] = useState('Office hours');
  const [startTime, setStartTime] = useState('09:00');
  const [endTime, setEndTime] = useState('18:00');
  const [shiftSaved, setShiftSaved] = useState(false);
  const [kpiCats, setKpiCats] = useState<string[]>(['monthly_goal']);
  const [deptId, setDeptId] = useState<string | null>(null);

  useEffect(() => {
    void supabase.rpc('get_departments').then(({ data }) => {
      const rows = (data || []) as { id: string }[];
      setDeptId(rows[0]?.id ?? null);
    });
  }, []);

  const finish = async () => {
    setBusy(true);
    setError('');
    try {
      await supabase.rpc('complete_company_onboarding');
      onFinished();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not finish setup.');
    } finally {
      setBusy(false);
    }
  };

  const savePeople = async () => {
    const rows = people.filter((p) => p.name.trim() && p.email.trim() && p.password.length >= 6);
    if (!rows.length) {
      setStep(2);
      return;
    }
    setBusy(true);
    setError('');
    try {
      let n = 0;
      for (const p of rows) {
        const { error: signupError } = await supabaseSignup.auth.signUp({
          email: p.email.trim(),
          password: p.password,
          options: {
            data: {
              full_name: p.name.trim(),
              role: 'employee',
              company_id: profile.company_id ?? undefined,
              department_id: deptId || undefined,
            },
          },
        });
        if (signupError) throw signupError;
        await supabaseSignup.auth.signOut();
        n += 1;
      }
      setAddedCount(n);
      setStep(2);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not add that person.');
    } finally {
      setBusy(false);
    }
  };

  const saveShift = async () => {
    if (!shiftName.trim()) {
      setStep(3);
      return;
    }
    setBusy(true);
    setError('');
    try {
      const { error: rpcError } = await supabase.rpc('upsert_work_shift', {
        p_name: shiftName.trim(),
        p_start_time: startTime,
        p_end_time: endTime,
        p_days_of_week: [1, 2, 3, 4, 5],
        p_grace_minutes: 60,
        p_crosses_midnight: false,
        p_apply_to_all: true,
      });
      if (rpcError) throw rpcError;
      setShiftSaved(true);
      setStep(3);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not save the shift.');
    } finally {
      setBusy(false);
    }
  };

  const saveKpis = async () => {
    setBusy(true);
    setError('');
    try {
      const dates = monthRange();
      const weight = kpiCats.length ? Math.round((100 / kpiCats.length) * 100) / 100 : 0;
      for (const cat of kpiCats) {
        const meta = KPI_CATEGORIES.find((c) => c.id === cat);
        const { error: rpcError } = await supabase.rpc('assign_employee_kpi', {
          p_employee_id: profile.id,
          p_kpi_name: meta?.label || cat,
          p_description: 'Starter KPI from company setup',
          p_weight: weight,
          p_start_date: dates.start,
          p_end_date: dates.end,
          p_notes: null,
          p_category: cat,
        });
        if (rpcError) throw rpcError;
      }
      setStep(4);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not save KPI starters.');
    } finally {
      setBusy(false);
    }
  };

  const toggleCat = (id: string) => {
    setKpiCats((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  };

  return (
    <div className="dashboard-container" style={{ display: 'flex', justifyContent: 'center', padding: '2rem 1rem' }}>
      <div className="glass-panel company-setup">
        <div className="company-register__head">
          <div className="company-register__head-icon"><Building2 size={22} /></div>
          <div>
            <p className="company-register__progress">Step {step} of 4</p>
            <h2 className="company-register__title">Set up {company.name}</h2>
            <p className="company-register__intro">Four short steps. Skip any you want to do later.</p>
          </div>
        </div>

        <ol className="company-register__steps company-register__steps--four" aria-label="Setup progress">
          <li className={step === 1 ? 'is-active' : step > 1 ? 'is-done' : ''}>People</li>
          <li className={step === 2 ? 'is-active' : step > 2 ? 'is-done' : ''}>Shifts</li>
          <li className={step === 3 ? 'is-active' : step > 3 ? 'is-done' : ''}>KPIs</li>
          <li className={step === 4 ? 'is-active' : ''}>Done</li>
        </ol>

        {error && <p className="company-register__banner">{error}</p>}

        {step === 1 && (
          <section>
            <h3 className="company-setup__h"><Users size={16} /> Add employees</h3>
            <p className="company-register__intro">Name, email, and a temporary password. They can change it after sign-in.</p>
            {people.map((p, i) => (
              <div key={i} className="company-setup__person">
                <input className="input-field" placeholder="Full name" value={p.name} onChange={(e) => {
                  const next = [...people];
                  next[i] = { ...next[i], name: e.target.value };
                  setPeople(next);
                }} />
                <input className="input-field" type="email" placeholder="Work email" value={p.email} onChange={(e) => {
                  const next = [...people];
                  next[i] = { ...next[i], email: e.target.value };
                  setPeople(next);
                }} />
                <PasswordField className="input-field" placeholder="Temp password" value={p.password} onChange={(e) => {
                  const next = [...people];
                  next[i] = { ...next[i], password: e.target.value };
                  setPeople(next);
                }} />
                {people.length > 1 && (
                  <button type="button" className="btn btn-secondary btn-sm" onClick={() => setPeople(people.filter((_, j) => j !== i))} aria-label="Remove">
                    <Trash2 size={14} />
                  </button>
                )}
              </div>
            ))}
            <button type="button" className="btn btn-secondary btn-sm" onClick={() => setPeople([...people, { name: '', email: '', password: '' }])}>
              <Plus size={14} /> Add another
            </button>
            <div className="company-register__actions">
              <button type="button" className="btn btn-secondary" onClick={() => setStep(2)}>Skip</button>
              <button type="button" className="btn btn-primary" disabled={busy} onClick={() => void savePeople()}>
                {busy ? <Loader2 size={16} className="animate-spin" /> : null}
                Save and continue
              </button>
            </div>
          </section>
        )}

        {step === 2 && (
          <section>
            <h3 className="company-setup__h"><Clock size={16} /> Shift timings</h3>
            <p className="company-register__intro">Default Monday–Friday hours for attendance.</p>
            <div className="company-register__grid">
              <label className="company-register__field" style={{ gridColumn: '1 / -1' }}>
                <span>Shift name</span>
                <input className="input-field" value={shiftName} onChange={(e) => setShiftName(e.target.value)} />
              </label>
              <label className="company-register__field">
                <span>Start</span>
                <input className="input-field" type="time" value={startTime} onChange={(e) => setStartTime(e.target.value)} />
              </label>
              <label className="company-register__field">
                <span>End</span>
                <input className="input-field" type="time" value={endTime} onChange={(e) => setEndTime(e.target.value)} />
              </label>
            </div>
            <div className="company-register__actions">
              <button type="button" className="btn btn-secondary" onClick={() => setStep(3)}>Skip</button>
              <button type="button" className="btn btn-primary" disabled={busy} onClick={() => void saveShift()}>
                {busy ? <Loader2 size={16} className="animate-spin" /> : null}
                Save shift
              </button>
            </div>
          </section>
        )}

        {step === 3 && (
          <section>
            <h3 className="company-setup__h"><Target size={16} /> KPI categories</h3>
            <p className="company-register__intro">
              Everyone uses these four categories. Tick the ones to assign to yourself this month (equal weight). You can assign more from KPIs later.
            </p>
            <div className="company-setup__cats">
              {KPI_CATEGORIES.map((c) => (
                <label key={c.id} className={`company-setup__cat${kpiCats.includes(c.id) ? ' is-on' : ''}`}>
                  <input type="checkbox" checked={kpiCats.includes(c.id)} onChange={() => toggleCat(c.id)} />
                  <span>{c.label}</span>
                </label>
              ))}
            </div>
            <div className="company-register__actions">
              <button type="button" className="btn btn-secondary" onClick={() => setStep(4)}>Skip</button>
              <button type="button" className="btn btn-primary" disabled={busy} onClick={() => {
                if (!kpiCats.length) {
                  setStep(4);
                  return;
                }
                void saveKpis();
              }}>
                {busy ? <Loader2 size={16} className="animate-spin" /> : null}
                {kpiCats.length ? 'Assign and finish' : 'Finish setup'}
              </button>
            </div>
          </section>
        )}

        {step === 4 && (
          <section style={{ textAlign: 'center' }}>
            <CheckCircle2 size={40} className="company-register__success-icon" style={{ color: 'var(--color-success)' }} />
            <h3>You&apos;re ready</h3>
            <p className="company-register__intro">
              {addedCount ? `${addedCount} teammate${addedCount === 1 ? '' : 's'} added. ` : ''}
              {shiftSaved ? 'Default shift saved. ' : ''}
              Open the dashboard to keep going.
            </p>
            <button type="button" className="btn btn-primary" disabled={busy} onClick={() => void finish()}>
              Go to dashboard
            </button>
          </section>
        )}
      </div>
    </div>
  );
}
