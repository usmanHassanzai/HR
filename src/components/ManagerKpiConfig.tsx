import { useEffect, useMemo, useState } from 'react';
import { AlertCircle, Building2, CheckCircle2, ChevronLeft, ClipboardList, Loader2, Pencil, Plus, Search, Send, Trash2, X } from 'lucide-react';
import { supabase } from '../lib/supabase';
import { Profile, Kpi, displayRoleLabel } from '../utils/kpiHelpers';
import { Department } from '../utils/departmentHelpers';
import { hydrateKpiLastEdits } from '../utils/kpiAssignmentEdits';
import { emailKpiAssigned } from '../utils/kpiEmail';
import { formatKpiWeight, KPI_WEIGHT_CAP, remainingKpiWeightBudget, sumEmployeeKpiWeights } from '../utils/kpiWeightHelpers';
import { useSupabaseRealtime } from '../utils/useSupabaseRealtime';
import EmployeeKpiWeightMeter from './EmployeeKpiWeightMeter';
import AssignedKpiCard from './AssignedKpiCard';
import { KPI_CATEGORIES, kpiCategoryMeta, type KpiCategoryId } from '../utils/kpiCategories';
import EditAssignedKpiModal from './EditAssignedKpiModal';
import '../styles/assign-tasks.css';
import '../styles/manager-kpi-tasks.css';
import '../styles/admin-dashboard.css';

type Desk = 'library' | 'assign' | 'board';

type KpiTemplate = {
  id: string;
  name: string;
  description: string | null;
  kpi_category: string;
  weight: number;
  active: boolean;
};

function karachiToday(): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Karachi',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
}

function defaultKpiDates(): { start: string; end: string } {
  const start = karachiToday();
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Karachi',
    year: 'numeric',
    month: '2-digit',
  }).formatToParts(new Date());
  const y = Number(parts.find((p) => p.type === 'year')?.value);
  const m = Number(parts.find((p) => p.type === 'month')?.value);
  const last = new Date(y, m, 0).getDate();
  const end = `${y}-${String(m).padStart(2, '0')}-${String(last).padStart(2, '0')}`;
  return { start, end: end < start ? start : end };
}

function initials(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0]?.toUpperCase() ?? '')
    .join('') || '?';
}

type DeptGroup = { id: string; name: string; people: Profile[] };

function roleOrder(role: string): number {
  if (role === 'manager') return 0;
  if (role === 'employee') return 1;
  return 2;
}

function matchPerson(p: Profile, q: string): boolean {
  const s = q.trim().toLowerCase();
  if (!s) return true;
  return p.full_name.toLowerCase().includes(s) || p.email.toLowerCase().includes(s) || displayRoleLabel(p.role).toLowerCase().includes(s);
}

function groupPeopleByDepartment(people: Profile[], departments: Department[]): DeptGroup[] {
  const known = new Set(departments.map((d) => d.id));
  const groups: DeptGroup[] = [...departments]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((d) => ({
      id: d.id,
      name: d.name,
      people: people
        .filter((p) => p.department_id === d.id)
        .sort((a, b) => roleOrder(a.role) - roleOrder(b.role) || a.full_name.localeCompare(b.full_name)),
    }))
    .filter((g) => g.people.length > 0);

  const unassigned = people
    .filter((p) => !p.department_id || !known.has(p.department_id))
    .sort((a, b) => roleOrder(a.role) - roleOrder(b.role) || a.full_name.localeCompare(b.full_name));
  if (unassigned.length) {
    groups.push({ id: '_none', name: 'No department', people: unassigned });
  }
  return groups;
}

function StudioSteps({
  step,
  labels,
}: {
  step: number;
  labels: string[];
}) {
  return (
    <ol className="studio-steps" aria-label="Assignment steps">
      {labels.map((label, i) => {
        const n = i + 1;
        return (
          <li key={label} className={step === n ? 'is-on' : step > n ? 'is-done' : undefined}>
            <span>{n}</span>
            {label}
          </li>
        );
      })}
    </ol>
  );
}

const CATEGORY_HELP: Record<KpiCategoryId, string> = {
  monthly_goal: 'They open the task in Scorr to start it (In progress), then mark Complete. Points follow Score, Weight, and whether they finish by the due date.',
  quality: 'They open the task in Scorr to start it, then mark Complete. Points follow Score, Weight, and the due date.',
  punctuality_behaviour: 'They open the task in Scorr to start it, then mark Complete. Points follow Score, Weight, and the due date.',
  urgent_tasks: 'They open the task in Scorr to start it, then mark Complete. On time awards the full Score; after the due date awards half.',
};

interface ManagerKpiConfigProps {
  assignerId: string;
  isAdmin?: boolean;
  managerDepartmentId?: string | null;
  hideChrome?: boolean;
  initialDesk?: Desk;
  initialUserId?: string;
  initialDeptId?: string;
}

export default function ManagerKpiConfig({
  assignerId,
  isAdmin = false,
  managerDepartmentId,
  initialDesk,
  initialUserId,
  initialDeptId,
}: ManagerKpiConfigProps) {
  const [desk, setDesk] = useState<Desk>(initialDesk || 'assign');
  const [templates, setTemplates] = useState<KpiTemplate[]>([]);
  const [reports, setReports] = useState<Profile[]>([]);
  const [departments, setDepartments] = useState<Department[]>([]);
  const [assignUserId, setAssignUserId] = useState(initialUserId || '');
  const [assignDeptId, setAssignDeptId] = useState(initialDeptId || '');
  const [boardUserId, setBoardUserId] = useState(initialUserId || '');
  const [boardDeptId, setBoardDeptId] = useState(initialDeptId || '');
  const [assignKpis, setAssignKpis] = useState<Kpi[]>([]);
  const [boardKpis, setBoardKpis] = useState<Kpi[]>([]);
  const [peopleWithKpis, setPeopleWithKpis] = useState<Set<string>>(() => new Set());
  const [assignKpiId, setAssignKpiId] = useState('');
  const [loading, setLoading] = useState(true);
  const [formLoading, setFormLoading] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [editingAssignment, setEditingAssignment] = useState<{ kpi: Kpi; siblings: Kpi[]; employeeName: string } | null>(null);
  const [editingTemplate, setEditingTemplate] = useState<KpiTemplate | null>(null);
  const [libOpen, setLibOpen] = useState(false);
  const [libQuery, setLibQuery] = useState('');

  const [libName, setLibName] = useState('');
  const [libCategory, setLibCategory] = useState<KpiCategoryId>('monthly_goal');
  const [libDescription, setLibDescription] = useState('');
  const [libWeight, setLibWeight] = useState('10');

  const [assignNotes, setAssignNotes] = useState('');
  const [assignStartDate, setAssignStartDate] = useState(() => defaultKpiDates().start);
  const [assignEndDate, setAssignEndDate] = useState(() => defaultKpiDates().end);
  const [assignWeight, setAssignWeight] = useState('');
  const [assignScore, setAssignScore] = useState('');
  const [boardSearch, setBoardSearch] = useState('');
  const [pauseOngoingOnUrgent, setPauseOngoingOnUrgent] = useState(true);

  const assignPerson = reports.find((r) => r.id === assignUserId) || null;
  const boardPerson = reports.find((r) => r.id === boardUserId) || null;
  const remaining = remainingKpiWeightBudget(assignKpis);
  const selectedTemplate = templates.find((t) => t.id === assignKpiId) || null;
  const selectedWeight = Number(assignWeight || selectedTemplate?.weight || 0);
  const selectedScore = Number(assignScore || selectedWeight || 0);

  useEffect(() => {
    if (!selectedTemplate) {
      setAssignWeight('');
      setAssignScore('');
      return;
    }
    const w = String(selectedTemplate.weight);
    setAssignWeight(w);
    setAssignScore(w);
  }, [selectedTemplate?.id]);

  const loadTemplates = async () => {
    const { data, error: err } = await supabase.rpc('list_kpi_templates', { p_include_inactive: false });
    if (err) {
      setError(err.message);
      setTemplates([]);
      return;
    }
    setTemplates(((data as KpiTemplate[]) || []).filter((t) => t.active !== false));
  };

  const loadPeople = async () => {
    const { data, error: rpcErr } = await supabase.rpc('get_assignable_kpi_people');
    let list = ((data as Profile[]) || []).filter((u) => !u.is_demo).sort((a, b) => a.full_name.localeCompare(b.full_name));
    if (rpcErr || !data) {
      const fallback = isAdmin
        ? await supabase.rpc('get_all_users_admin')
        : await supabase.rpc('get_direct_reports', { p_manager_id: assignerId });
      list = ((fallback.data as Profile[]) || [])
        .filter((u) => !u.is_demo)
        .filter((u) => {
          if (isAdmin) return u.role === 'employee' || u.role === 'manager';
          return u.role === 'employee' && (!managerDepartmentId || u.department_id === managerDepartmentId);
        })
        .sort((a, b) => a.full_name.localeCompare(b.full_name));
    }
    if (!isAdmin) {
      list = list.filter((u) => u.role === 'employee' && (!managerDepartmentId || u.department_id === managerDepartmentId));
    }
    setReports(list);
    await loadPeopleWithKpis(list);
  };

  const loadDepartments = async () => {
    const { data } = await supabase.rpc('get_departments');
    setDepartments(((data as Department[]) || []).filter((d) => d.active !== false));
  };

  const loadPeopleWithKpis = async (people: Profile[]) => {
    const ids = people.map((p) => p.id);
    if (ids.length === 0) {
      setPeopleWithKpis(new Set());
      return;
    }
    const { data } = await supabase.from('kpis').select('user_id').in('user_id', ids);
    setPeopleWithKpis(new Set(((data || []) as { user_id: string }[]).map((row) => row.user_id)));
  };

  const fetchKpis = async (userId: string): Promise<Kpi[]> => {
    if (!userId) return [];
    const { data } = await supabase.from('kpis').select('*').eq('user_id', userId).order('created_at', { ascending: false });
    return hydrateKpiLastEdits((data as Kpi[]) || []);
  };

  useEffect(() => {
    if (initialDesk) setDesk(initialDesk);
  }, [initialDesk]);

  useEffect(() => {
    if (initialUserId) {
      setAssignUserId(initialUserId);
      setBoardUserId(initialUserId);
    }
  }, [initialUserId]);

  useEffect(() => {
    if (initialDeptId) {
      setAssignDeptId(initialDeptId);
      setBoardDeptId(initialDeptId);
    } else if (initialUserId && reports.length > 0) {
      const found = reports.find((r) => r.id === initialUserId);
      if (found?.department_id) {
        setAssignDeptId(found.department_id);
        setBoardDeptId(found.department_id);
      }
    }
  }, [initialDeptId, initialUserId, reports]);

  useEffect(() => {
    const boot = async () => {
      setLoading(true);
      await Promise.all([loadTemplates(), loadPeople(), loadDepartments()]);
      setLoading(false);
    };
    void boot();
  }, [assignerId, isAdmin, managerDepartmentId]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const list = await fetchKpis(assignUserId);
      if (!cancelled) {
        setAssignKpis(list);
        setAssignKpiId('');
      }
    })();
    return () => { cancelled = true; };
  }, [assignUserId]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const list = await fetchKpis(boardUserId);
      if (!cancelled) setBoardKpis(list);
    })();
    return () => { cancelled = true; };
  }, [boardUserId]);

  useSupabaseRealtime('kpi-library-assign', [{ table: 'kpis' }, { table: 'users' }, { table: 'departments' }], () => {
    void loadPeople();
    void loadTemplates();
    void loadDepartments();
    if (assignUserId) void fetchKpis(assignUserId).then(setAssignKpis);
    if (boardUserId) void fetchKpis(boardUserId).then(setBoardKpis);
  });

  useEffect(() => {
    if (!libOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setLibOpen(false);
    };
    window.addEventListener('keydown', onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      window.removeEventListener('keydown', onKey);
      document.body.style.overflow = prev;
    };
  }, [libOpen]);

  const assignGroups = useMemo(() => groupPeopleByDepartment(reports, departments), [reports, departments]);
  const boardPeople = useMemo(() => reports.filter((p) => peopleWithKpis.has(p.id)), [reports, peopleWithKpis]);
  const boardGroups = useMemo(() => groupPeopleByDepartment(boardPeople, departments), [boardPeople, departments]);

  const assignDept = assignGroups.find((g) => g.id === assignDeptId) || null;
  const boardDept = boardGroups.find((g) => g.id === boardDeptId) || null;
  const peopleInAssignDept = isAdmin ? assignDept?.people || [] : reports;
  const peopleInBoardDept = useMemo(
    () => (isAdmin ? boardDept?.people || [] : boardPeople).filter((p) => matchPerson(p, boardSearch)),
    [isAdmin, boardDept, boardPeople, boardSearch],
  );

  const deptNameOf = (id?: string | null) => departments.find((d) => d.id === id)?.name || 'No department';
  const boardStep = isAdmin
    ? (!boardDeptId ? 1 : !boardPerson ? 2 : 3)
    : (!boardPerson ? 1 : 2);

  useEffect(() => {
    if (isAdmin) return;
    if (!managerDepartmentId) return;
    if (!assignDeptId && assignGroups.some((g) => g.id === managerDepartmentId)) setAssignDeptId(managerDepartmentId);
    if (!boardDeptId && boardGroups.some((g) => g.id === managerDepartmentId)) setBoardDeptId(managerDepartmentId);
  }, [isAdmin, managerDepartmentId, assignDeptId, boardDeptId, assignGroups, boardGroups]);

  useEffect(() => {
    if (boardUserId && !peopleWithKpis.has(boardUserId)) {
      setBoardUserId('');
      setBoardKpis([]);
    }
  }, [boardUserId, peopleWithKpis]);

  const visibleTemplates = useMemo(() => {
    const q = libQuery.trim().toLowerCase();
    if (!q) return templates;
    return templates.filter(
      (t) => t.name.toLowerCase().includes(q) || (t.description || '').toLowerCase().includes(q) || kpiCategoryMeta(t.kpi_category).label.toLowerCase().includes(q),
    );
  }, [templates, libQuery]);

  const whoHint = isAdmin
    ? 'Choose department, then the employee or manager, then the KPI, dates, and an optional note.'
    : managerDepartmentId
      ? 'Choose the employee, then the KPI, dates, and an optional note.'
      : 'Ask an admin to set your department before you can assign KPIs.';

  const resetLibraryForm = () => {
    setLibName('');
    setLibDescription('');
    setLibWeight('10');
    setLibCategory('monthly_goal');
    setEditingTemplate(null);
  };

  const openCreate = () => {
    resetLibraryForm();
    setError('');
    setLibOpen(true);
  };

  const openEditTemplate = (tpl: KpiTemplate) => {
    setEditingTemplate(tpl);
    setLibName(tpl.name);
    setLibDescription(tpl.description || '');
    setLibWeight(String(tpl.weight));
    setLibCategory((tpl.kpi_category as KpiCategoryId) || 'monthly_goal');
    setError('');
    setLibOpen(true);
  };

  const handleSaveTemplate = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setSuccess('');
    const weight = Number(libWeight);
    if (!libName.trim()) {
      setError('KPI name is required.');
      return;
    }
    if (!Number.isFinite(weight) || weight < 1 || weight > 100) {
      setError('Weight must be between 1% and 100%.');
      return;
    }
    setFormLoading(true);
    try {
      if (editingTemplate) {
        const { error: err } = await supabase.rpc('update_kpi_template', {
          p_id: editingTemplate.id,
          p_name: libName.trim(),
          p_description: libDescription.trim() || null,
          p_category: libCategory,
          p_weight: weight,
          p_active: true,
        });
        if (err) throw err;
        setSuccess('KPI updated.');
      } else {
        const { error: err } = await supabase.rpc('create_kpi_template', {
          p_name: libName.trim(),
          p_description: libDescription.trim() || null,
          p_category: libCategory,
          p_weight: weight,
        });
        if (err) throw err;
        setSuccess('KPI saved to the library. Assign it from Assign Task.');
      }
      resetLibraryForm();
      setLibOpen(false);
      await loadTemplates();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Could not save this KPI.');
    } finally {
      setFormLoading(false);
    }
  };

  const handleArchiveTemplate = async (tpl: KpiTemplate) => {
    if (!confirm(`Remove “${tpl.name}” from the library? Existing assignments stay.`)) return;
    const { error: err } = await supabase.rpc('update_kpi_template', {
      p_id: tpl.id,
      p_name: tpl.name,
      p_description: tpl.description,
      p_category: tpl.kpi_category,
      p_weight: tpl.weight,
      p_active: false,
    });
    if (err) setError(err.message);
    else {
      setSuccess('KPI removed from the library.');
      await loadTemplates();
    }
  };

  const handleAssign = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setSuccess('');
    if (isAdmin && !assignDeptId) {
      setError('Select a department.');
      return;
    }
    if (!assignUserId) {
      setError('Select who this is for.');
      return;
    }
    if (!selectedTemplate) {
      setError('Select a KPI from the library.');
      return;
    }
    if (!assignStartDate || !assignEndDate) {
      setError('Start date and due date are required.');
      return;
    }
    if (assignEndDate < assignStartDate) {
      setError('Due date must be on or after start date.');
      return;
    }
    if (sumEmployeeKpiWeights(assignKpis) + selectedWeight > KPI_WEIGHT_CAP + 0.05) {
      setError(`Open weights for this person cannot exceed 100% (${formatKpiWeight(remaining)} remaining, selected ${formatKpiWeight(selectedWeight)}).`);
      return;
    }
    if (!Number.isFinite(selectedWeight) || selectedWeight < 1 || selectedWeight > 100) {
      setError('Weight must be between 1% and 100%.');
      return;
    }
    if (!Number.isFinite(selectedScore) || selectedScore < 0) {
      setError('Score cannot be negative.');
      return;
    }
    setFormLoading(true);
    try {
      const tpl = selectedTemplate;
      const isUrgent = tpl.kpi_category === 'urgent_tasks';
      const ongoingIds = assignKpis
        .filter((k) => k.completion_status !== 'completed' && !k.paused_at)
        .map((k) => k.id);

      const { data, error: rpcErr } = await supabase.rpc('assign_kpi_from_template', {
        p_employee_id: assignUserId,
        p_template_id: tpl.id,
        p_start_date: assignStartDate,
        p_end_date: assignEndDate,
        p_notes: assignNotes.trim() || null,
        p_weight: selectedWeight,
        p_assigned_score: selectedScore,
      });
      if (rpcErr) throw rpcErr;

      if (isUrgent && pauseOngoingOnUrgent && ongoingIds.length > 0) {
        await supabase.rpc('pause_assigned_kpis', { p_kpi_ids: ongoingIds });
      }

      const row = Array.isArray(data) ? data[0] : data;
      if (row?.employee_email) {
        await emailKpiAssigned(
          row.employee_email,
          row.employee_name,
          row.kpi_name || tpl.name,
          assignEndDate,
          assignNotes.trim() || tpl.description || '',
        );
      }
      setSuccess(
        isUrgent && pauseOngoingOnUrgent && ongoingIds.length > 0
          ? `Assigned urgent task ${tpl.name} to ${assignPerson?.full_name || 'this person'} and paused ${ongoingIds.length} ongoing task(s).`
          : `Assigned ${tpl.name} to ${assignPerson?.full_name || 'this person'}.`
      );
      setAssignKpiId('');
      setAssignNotes('');
      const dates = defaultKpiDates();
      setAssignStartDate(dates.start);
      setAssignEndDate(dates.end);
      setAssignKpis(await fetchKpis(assignUserId));
      await loadPeopleWithKpis(reports);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Could not assign this KPI.');
    } finally {
      setFormLoading(false);
    }
  };

  const refreshOpenKpis = async () => {
    await loadPeopleWithKpis(reports);
    if (assignUserId) setAssignKpis(await fetchKpis(assignUserId));
    if (boardUserId) setBoardKpis(await fetchKpis(boardUserId));
  };

  const handleDeleteAssigned = async (kpiId: string) => {
    if (!confirm('Remove this assigned KPI?')) return;
    await supabase.from('kpis').delete().eq('id', kpiId);
    await refreshOpenKpis();
  };

  if (loading) {
    return (
      <div className="studio studio--loading">
        <Loader2 className="spin-icon" size={28} />
        <p>Loading workspace…</p>
      </div>
    );
  }

  return (
    <div className="studio">
      <div className="studio-switch" role="tablist" aria-label="KPI workspace">
        <button type="button" role="tab" aria-selected={desk === 'assign'} className={desk === 'assign' ? 'is-on' : undefined} onClick={() => { setDesk('assign'); setError(''); setSuccess(''); }}>
          Assign Task
        </button>
        <button type="button" role="tab" aria-selected={desk === 'library'} className={desk === 'library' ? 'is-on' : undefined} onClick={() => { setDesk('library'); setError(''); setSuccess(''); }}>
          KPI's
        </button>
        <button type="button" role="tab" aria-selected={desk === 'board'} className={desk === 'board' ? 'is-on' : undefined} onClick={() => { setDesk('board'); setError(''); setSuccess(''); }}>
          Assigned Task
        </button>
      </div>

      {error && (
        <div className="login-error-banner" role="alert">
          <AlertCircle size={16} /> {error}
        </div>
      )}
      {success && (
        <div className="login-success-banner">
          <CheckCircle2 size={16} /> {success}
        </div>
      )}

      {desk === 'library' ? (
        <>
          <div className="studio-hero">
            <div>
              <p className="studio-kicker">Library</p>
              <h2>Company KPIs</h2>
              <p>Create the KPI once. It stays here with its weight until you assign it to someone.</p>
            </div>
            <button type="button" className="btn btn-primary" onClick={openCreate}>
              <Plus size={16} /> New KPI
            </button>
          </div>

          <div className="studio-toolbar">
            <div className="studio-search">
              <Search size={16} />
              <input type="search" value={libQuery} onChange={(e) => setLibQuery(e.target.value)} placeholder="Search KPIs" aria-label="Search KPIs" />
            </div>
            <span className="studio-count">{visibleTemplates.length} in library</span>
          </div>

          {visibleTemplates.length === 0 ? (
            <div className="studio-empty">
              <ClipboardList size={40} strokeWidth={1.25} />
              <h3>{templates.length === 0 ? 'Start with your first KPI' : 'No matches'}</h3>
              <p>
                {templates.length === 0
                  ? 'Name it, set the category and weight, then assign it from Assign Task.'
                  : 'Try a different search.'}
              </p>
              {templates.length === 0 && (
                <button type="button" className="btn btn-primary" onClick={openCreate}>
                  <Plus size={16} /> New KPI
                </button>
              )}
            </div>
          ) : (
            <div className="studio-grid">
              {visibleTemplates.map((tpl) => (
                <article key={tpl.id} className="studio-kpi">
                  <div className="studio-kpi__pct" aria-label={`${formatKpiWeight(Number(tpl.weight))} weight`}>
                    <strong>{formatKpiWeight(Number(tpl.weight))}</strong>
                  </div>
                  <div className="studio-kpi__body">
                    <h3>{tpl.name}</h3>
                    <span className="studio-tag">{kpiCategoryMeta(tpl.kpi_category).label}</span>
                    {tpl.description && <p>{tpl.description}</p>}
                    <div className="studio-bar" aria-hidden>
                      <i style={{ width: `${Math.min(100, Number(tpl.weight))}%` }} />
                    </div>
                  </div>
                  <div className="studio-kpi__actions">
                    <button type="button" className="studio-action" onClick={() => openEditTemplate(tpl)}>
                      <Pencil size={14} strokeWidth={2.25} />
                      Edit
                    </button>
                    <button type="button" className="studio-action studio-action--danger" onClick={() => void handleArchiveTemplate(tpl)}>
                      <Trash2 size={14} strokeWidth={2.25} />
                      Remove
                    </button>
                  </div>
                </article>
              ))}
            </div>
          )}
        </>
      ) : desk === 'assign' ? (
        <>
          <div className="studio-hero studio-hero--assign">
            <div>
              <p className="studio-kicker">Assignment</p>
              <h2>Assign Task</h2>
              <p>{whoHint}</p>
            </div>
          </div>
          {(isAdmin ? assignGroups.length === 0 : reports.length === 0) ? (
            <div className="studio-empty studio-empty--panel">
              <Building2 size={36} strokeWidth={1.5} />
              <h3>{isAdmin ? 'No departments with people' : 'No employees yet'}</h3>
              <p>{isAdmin ? 'Add people to a department first.' : 'No department employees yet.'}</p>
            </div>
          ) : (
            <form onSubmit={handleAssign} className="studio-assign-form">
              <div className="studio-assign-form__row">
                {isAdmin && (
                  <label className="studio-assign-field">
                    Department
                    <select
                      value={assignDeptId}
                      onChange={(e) => {
                        setAssignDeptId(e.target.value);
                        setAssignUserId('');
                        setAssignKpiId('');
                        setError('');
                      }}
                      required
                    >
                      <option value="">Select department</option>
                      {assignGroups.map((g) => (
                        <option key={g.id} value={g.id}>
                          {g.name} ({g.people.length})
                        </option>
                      ))}
                    </select>
                  </label>
                )}

                <label className="studio-assign-field">
                  {isAdmin ? 'Employee or manager' : 'Employee'}
                  <select
                    value={assignUserId}
                    onChange={(e) => {
                      setAssignUserId(e.target.value);
                      setAssignKpiId('');
                      setError('');
                    }}
                    disabled={isAdmin && !assignDeptId}
                    required
                  >
                    <option value="">
                      {isAdmin && !assignDeptId ? 'Select a department first' : 'Select employee'}
                    </option>
                    {peopleInAssignDept.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.full_name} · {displayRoleLabel(p.role)}
                      </option>
                    ))}
                  </select>
                </label>
              </div>

              {assignPerson && (
                <div className="studio-assign-person">
                  <div className="studio-assign-person__who">
                    <span className={`studio-av studio-av--lg studio-av--${assignPerson.role}`} aria-hidden>
                      {initials(assignPerson.full_name)}
                    </span>
                    <div>
                      <strong>{assignPerson.full_name}</strong>
                      <p>
                        {displayRoleLabel(assignPerson.role)} · {assignPerson.email}
                        {assignDept ? ` · ${assignDept.name}` : ''}
                      </p>
                    </div>
                  </div>
                  <EmployeeKpiWeightMeter kpis={assignKpis} pendingWeight={selectedWeight} />
                </div>
              )}

              {templates.length === 0 ? (
                <div className="studio-empty studio-empty--compact">
                  <p>Create a KPI in the library first.</p>
                  <button type="button" className="btn btn-primary" onClick={() => { setDesk('library'); openCreate(); }}>
                    <Plus size={16} /> New KPI
                  </button>
                </div>
              ) : (
                <label className="studio-assign-field">
                  KPI
                  <select
                    value={assignKpiId}
                    onChange={(e) => setAssignKpiId(e.target.value)}
                    disabled={!assignUserId}
                    required
                  >
                    <option value="">{assignUserId ? 'Select KPI' : 'Select a person first'}</option>
                    {templates.map((tpl) => (
                      <option key={tpl.id} value={tpl.id}>
                        {tpl.name} · {kpiCategoryMeta(tpl.kpi_category).label} · {formatKpiWeight(Number(tpl.weight))}
                      </option>
                    ))}
                  </select>
                </label>
              )}

              {selectedTemplate && (
                <div className="studio-dates">
                  <label className="studio-assign-field">
                    Weight (%)
                    <input
                      type="number"
                      min={1}
                      max={100}
                      step={0.5}
                      value={assignWeight}
                      onChange={(e) => {
                        const next = e.target.value;
                        setAssignWeight(next);
                        setAssignScore((prev) => (prev === assignWeight || prev === '' ? next : prev));
                      }}
                      required
                    />
                  </label>
                  <label className="studio-assign-field">
                    Score (points if completed on time)
                    <input
                      type="number"
                      min={0}
                      step={0.5}
                      value={assignScore}
                      onChange={(e) => setAssignScore(e.target.value)}
                      required
                    />
                    <span className="studio-muted">Can be higher than weight if you choose.</span>
                  </label>
                </div>
              )}

              <div className="studio-dates">
                <label className="studio-assign-field">
                  Start date
                  <input
                    type="date"
                    value={assignStartDate}
                    onChange={(e) => {
                      const next = e.target.value;
                      setAssignStartDate(next);
                      if (assignEndDate && next && assignEndDate < next) setAssignEndDate(next);
                    }}
                    required
                  />
                </label>
                <label className="studio-assign-field">
                  Due date
                  <input type="date" value={assignEndDate} onChange={(e) => setAssignEndDate(e.target.value)} required />
                </label>
              </div>

              {selectedTemplate?.kpi_category === 'urgent_tasks' && (
                <label className="studio-checkbox-field">
                  <input
                    type="checkbox"
                    checked={pauseOngoingOnUrgent}
                    onChange={(e) => setPauseOngoingOnUrgent(e.target.checked)}
                  />
                  <span>Pause ongoing tasks while they work on this urgent task (auto-extends due dates when resumed)</span>
                </label>
              )}

              <label className="studio-notes studio-assign-field">
                Additional note <span>(optional)</span>
                <textarea rows={4} value={assignNotes} onChange={(e) => setAssignNotes(e.target.value)} placeholder="Anything this person should know" />
              </label>

              <div className="studio-assign-bar">
                <p>
                  {!assignUserId || !assignKpiId
                    ? 'Complete the selections above, then assign.'
                    : `Assign ${selectedTemplate?.name || 'KPI'} (${formatKpiWeight(selectedWeight)}) · ${formatKpiWeight(Math.max(0, remaining - selectedWeight))} left after`}
                </p>
                <button type="submit" className="btn btn-primary" disabled={formLoading || !assignUserId || !assignKpiId}>
                  {formLoading ? <Loader2 size={18} className="spin-icon" /> : <Send size={18} />}
                  Assign KPI{assignPerson ? ` to ${assignPerson.full_name.split(' ')[0]}` : ''}
                </button>
              </div>
            </form>
          )}
        </>
      ) : (
        <>
          <div className="studio-hero">
            <div>
              <p className="studio-kicker">Review</p>
              <h2>Assigned Task</h2>
              <p>
                {isAdmin
                  ? 'Only people who already have KPIs. Select a department, then a person, to check progress.'
                  : 'Only employees in your department who already have KPIs. Select a person to check progress.'}
              </p>
            </div>
          </div>
          <StudioSteps
            step={boardStep}
            labels={isAdmin ? ['Department', 'Person', 'Progress'] : ['Person', 'Progress']}
          />
          <div className="studio-flow">
            {isAdmin && boardStep === 1 && (
              boardGroups.length === 0 ? (
                <div className="studio-empty studio-empty--panel">
                  <ClipboardList size={36} strokeWidth={1.5} />
                  <h3>No assigned KPIs yet</h3>
                  <p>People appear here after a KPI is assigned to them.</p>
                </div>
              ) : (
                <div className="studio-choice-grid">
                  {boardGroups.map((g) => {
                    const managers = g.people.filter((p) => p.role === 'manager').length;
                    const employees = g.people.filter((p) => p.role === 'employee').length;
                    return (
                      <button key={g.id} type="button" className="studio-choice" onClick={() => { setBoardDeptId(g.id); setBoardUserId(''); setBoardSearch(''); }}>
                        <Building2 size={22} strokeWidth={1.75} />
                        <strong>{g.name}</strong>
                        <em>
                          {g.people.length} with KPIs
                          {managers ? ` · ${managers} manager${managers === 1 ? '' : 's'}` : ''}
                          {employees ? ` · ${employees} employee${employees === 1 ? '' : 's'}` : ''}
                        </em>
                      </button>
                    );
                  })}
                </div>
              )
            )}

            {((isAdmin && boardStep === 2 && boardDept) || (!isAdmin && boardStep === 1)) && (
              boardPeople.length === 0 && !isAdmin ? (
                <div className="studio-empty studio-empty--panel">
                  <ClipboardList size={36} strokeWidth={1.5} />
                  <h3>No assigned KPIs yet</h3>
                  <p>People appear here after a KPI is assigned to them.</p>
                </div>
              ) : (
              <>
                <div className="studio-flow__bar">
                  {isAdmin && (
                    <button type="button" className="studio-back" onClick={() => { setBoardDeptId(''); setBoardUserId(''); setBoardSearch(''); }}>
                      <ChevronLeft size={16} /> Departments
                    </button>
                  )}
                  <h3>{isAdmin ? boardDept?.name : 'Your team'}</h3>
                  <div className="studio-search">
                    <Search size={16} />
                    <input type="search" value={boardSearch} onChange={(e) => setBoardSearch(e.target.value)} placeholder={isAdmin ? 'Search this department' : 'Search employees'} aria-label="Search people with KPIs" />
                  </div>
                </div>
                {peopleInBoardDept.length === 0 ? (
                  <p className="studio-muted">{isAdmin ? 'No matches in this department.' : 'No matches.'}</p>
                ) : (
                  <div className="studio-choice-grid studio-choice-grid--people">
                    {peopleInBoardDept.map((p) => (
                      <button key={p.id} type="button" className="studio-choice studio-choice--person" onClick={() => setBoardUserId(p.id)}>
                        <span className={`studio-av studio-av--lg studio-av--${p.role}`} aria-hidden>{initials(p.full_name)}</span>
                        <strong>{p.full_name}</strong>
                        <em>{displayRoleLabel(p.role)}</em>
                      </button>
                    ))}
                  </div>
                )}
              </>
              )
            )}

            {((isAdmin && boardStep === 3) || (!isAdmin && boardStep === 2)) && boardPerson && (
                <div className="studio-main__scroll">
                  <div className="studio-flow__bar">
                    <button type="button" className="studio-back" onClick={() => { setBoardUserId(''); setBoardSearch(''); }}>
                      <ChevronLeft size={16} /> {isAdmin ? (boardDept?.name || 'People') : 'Employees'}
                    </button>
                  </div>
                  <header className="studio-person-head">
                    <span className={`studio-av studio-av--lg studio-av--${boardPerson.role}`} aria-hidden>{initials(boardPerson.full_name)}</span>
                    <div>
                      <h3>{boardPerson.full_name}</h3>
                      <p>{boardPerson.email} · {displayRoleLabel(boardPerson.role)} · {deptNameOf(boardPerson.department_id)} · {boardKpis.length} assigned</p>
                    </div>
                  </header>
                  <EmployeeKpiWeightMeter kpis={boardKpis} compact />
                  {boardKpis.length === 0 ? (
                    <div className="studio-empty studio-empty--compact">
                      <p>This person no longer has assigned KPIs.</p>
                    </div>
                  ) : (
                    <ul className="studio-assigned studio-assigned--board">
                      {boardKpis.map((kpi) => (
                        <li key={kpi.id}>
                          <AssignedKpiCard
                            kpi={kpi}
                            employeeName={boardPerson.full_name}
                            onEdit={() => setEditingAssignment({ kpi, siblings: boardKpis, employeeName: boardPerson.full_name })}
                            onRemove={() => void handleDeleteAssigned(kpi.id)}
                            onUpdated={() => void refreshOpenKpis()}
                          />
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
            )}
          </div>
        </>
      )}

      {libOpen && (
        <>
          <div className="studio-drawer__dim" onClick={() => setLibOpen(false)} />
          <aside className="studio-drawer" role="dialog" aria-labelledby="kpi-drawer-title">
            <header>
              <div>
                <h3 id="kpi-drawer-title">{editingTemplate ? 'Edit KPI' : 'New KPI'}</h3>
                <p>This is saved to the library. Assign it later from Assign Task.</p>
              </div>
              <button type="button" className="studio-icon-btn" onClick={() => setLibOpen(false)} aria-label="Close">
                <X size={18} />
              </button>
            </header>
            <form onSubmit={handleSaveTemplate} className="studio-drawer__form">
              <label>
                Name
                <input value={libName} onChange={(e) => setLibName(e.target.value)} placeholder="e.g. Monthly sales target" required autoFocus />
              </label>
              <fieldset className="studio-cats">
                <legend>Category</legend>
                <div>
                  {KPI_CATEGORIES.map((c) => (
                    <button key={c.id} type="button" className={libCategory === c.id ? 'is-on' : undefined} onClick={() => setLibCategory(c.id)}>
                      {c.label}
                    </button>
                  ))}
                </div>
                <p>{CATEGORY_HELP[libCategory]}</p>
              </fieldset>
              <label>
                Weight %
                <input type="number" min={1} max={100} step={1} value={libWeight} onChange={(e) => setLibWeight(e.target.value)} required />
              </label>
              <label>
                Description <span>(optional)</span>
                <textarea rows={3} value={libDescription} onChange={(e) => setLibDescription(e.target.value)} placeholder="What this KPI measures" />
              </label>
              <div className="studio-drawer__foot">
                <button type="button" className="btn btn-secondary" onClick={() => setLibOpen(false)}>Cancel</button>
                <button type="submit" className="btn btn-primary" disabled={formLoading}>
                  {formLoading ? <Loader2 size={16} className="spin-icon" /> : <Plus size={16} />}
                  {editingTemplate ? 'Save' : 'Create KPI'}
                </button>
              </div>
            </form>
          </aside>
        </>
      )}

      {editingAssignment && (
        <EditAssignedKpiModal
          kpi={editingAssignment.kpi}
          siblingKpis={editingAssignment.siblings}
          employeeName={editingAssignment.employeeName}
          onClose={() => setEditingAssignment(null)}
          onSaved={() => {
            setEditingAssignment(null);
            void refreshOpenKpis();
          }}
        />
      )}
    </div>
  );
}
