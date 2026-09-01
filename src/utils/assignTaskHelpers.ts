import { Profile, Kpi } from './kpiHelpers';
import { Department } from './departmentHelpers';

export type AssignmentRow = { employee: Profile; kpi: Kpi };

export type EmployeeAssignmentGroup = {
  employee: Profile;
  tasks: Kpi[];
};

export type DepartmentAssignmentSection = {
  deptId: string;
  deptName: string;
  orgWeight?: number;
  taskCount: number;
  employees: EmployeeAssignmentGroup[];
};

function resolveDepartmentKey(kpi: Kpi, departments: Department[]): string {
  if (kpi.department_id) return kpi.department_id;
  const byName = departments.find(
    (d) => d.name.toLowerCase() === (kpi.department || '').toLowerCase(),
  );
  if (byName) return byName.id;
  return `name:${(kpi.department || 'General').trim() || 'General'}`;
}

export function buildDepartmentAssignmentSections(
  rows: AssignmentRow[],
  departments: Department[],
): DepartmentAssignmentSection[] {
  const tree = new Map<string, Map<string, EmployeeAssignmentGroup>>();

  for (const { employee, kpi } of rows) {
    const deptKey = resolveDepartmentKey(kpi, departments);
    if (!tree.has(deptKey)) tree.set(deptKey, new Map());
    const empMap = tree.get(deptKey)!;
    if (!empMap.has(employee.id)) {
      empMap.set(employee.id, { employee, tasks: [] });
    }
    empMap.get(employee.id)!.tasks.push(kpi);
  }

  const sections: DepartmentAssignmentSection[] = [];
  const usedKeys = new Set<string>();

  for (const dept of departments) {
    const empMap =
      tree.get(dept.id) ||
      tree.get(`name:${dept.name}`) ||
      tree.get(dept.name);
    if (!empMap?.size) continue;

    usedKeys.add(dept.id);
    usedKeys.add(`name:${dept.name}`);
    usedKeys.add(dept.name);

    const employees = Array.from(empMap.values()).sort((a, b) =>
      a.employee.full_name.localeCompare(b.employee.full_name),
    );
    const taskCount = employees.reduce((n, e) => n + e.tasks.length, 0);

    sections.push({
      deptId: dept.id,
      deptName: dept.name,
      orgWeight: dept.org_weight_pct,
      taskCount,
      employees,
    });
  }

  for (const [key, empMap] of tree) {
    if (usedKeys.has(key) || !empMap.size) continue;
    const deptName = key.startsWith('name:') ? key.slice(5) : key;
    const employees = Array.from(empMap.values()).sort((a, b) =>
      a.employee.full_name.localeCompare(b.employee.full_name),
    );
    sections.push({
      deptId: key,
      deptName,
      taskCount: employees.reduce((n, e) => n + e.tasks.length, 0),
      employees,
    });
  }

  return sections;
}

/** Admin overview: every department, all employees in that dept, with or without tasks. */
export function buildAdminDepartmentOverview(
  employees: Profile[],
  teamKpisByUser: Record<string, Kpi[]>,
  departments: Department[],
): DepartmentAssignmentSection[] {
  const sections: DepartmentAssignmentSection[] = departments
    .slice()
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((dept) => {
      const deptEmployees = employees
        .filter((e) => e.department_id === dept.id)
        .sort((a, b) => a.full_name.localeCompare(b.full_name));

      const groups: EmployeeAssignmentGroup[] = deptEmployees.map((employee) => ({
        employee,
        tasks: teamKpisByUser[employee.id] || [],
      }));

      return {
        deptId: dept.id,
        deptName: dept.name,
        orgWeight: dept.org_weight_pct,
        taskCount: groups.reduce((n, g) => n + g.tasks.length, 0),
        employees: groups,
      };
    });

  const unassigned = employees.filter((e) => !e.department_id || !departments.some((d) => d.id === e.department_id));
  if (unassigned.length > 0) {
    const groups: EmployeeAssignmentGroup[] = unassigned
      .sort((a, b) => a.full_name.localeCompare(b.full_name))
      .map((employee) => ({
        employee,
        tasks: teamKpisByUser[employee.id] || [],
      }));
    sections.push({
      deptId: '__unassigned__',
      deptName: 'Unassigned',
      taskCount: groups.reduce((n, g) => n + g.tasks.length, 0),
      employees: groups,
    });
  }

  return sections;
}

function personId(employee: Profile): string {
  return String(employee.id || '');
}

function applyTaskFilters(
  tasks: Kpi[],
  opts: {
    status?: 'all' | 'pending' | 'completed';
    dateFrom?: string;
    dateTo?: string;
    search?: string;
  },
): Kpi[] {
  let next = tasks;
  if (opts.status === 'pending') {
    next = next.filter((k) => k.completion_status !== 'completed');
  } else if (opts.status === 'completed') {
    next = next.filter((k) => k.completion_status === 'completed');
  }
  if (opts.dateFrom) {
    next = next.filter((k) => (k.start_date || '') >= opts.dateFrom!);
  }
  if (opts.dateTo) {
    next = next.filter((k) => (k.end_date || k.start_date || '') <= opts.dateTo!);
  }
  const q = opts.search?.trim().toLowerCase();
  if (q) {
    next = next.filter(
      (k) =>
        k.name.toLowerCase().includes(q) ||
        (k.description || '').toLowerCase().includes(q) ||
        (k.assignment_notes || '').toLowerCase().includes(q),
    );
  }
  return next;
}

export function filterAssignmentSections(
  sections: DepartmentAssignmentSection[],
  opts: {
    departmentId?: string;
    search?: string;
    employeeId?: string;
    status?: 'all' | 'pending' | 'completed';
    managerId?: string;
    dateFrom?: string;
    dateTo?: string;
  },
): DepartmentAssignmentSection[] {
  const employeeId = opts.employeeId && opts.employeeId !== 'all' ? String(opts.employeeId) : '';
  const departmentId = opts.departmentId && opts.departmentId !== 'all' ? opts.departmentId : '';
  const q = opts.search?.trim().toLowerCase() || '';

  if (employeeId) {
    const merged = new Map<string, EmployeeAssignmentGroup>();
    let home: DepartmentAssignmentSection | undefined;
    for (const section of sections) {
      for (const group of section.employees) {
        if (personId(group.employee) !== employeeId) continue;
        const existing = merged.get(employeeId);
        const tasks = applyTaskFilters(group.tasks, opts);
        if (existing) {
          const seen = new Set(existing.tasks.map((t) => t.id));
          existing.tasks = existing.tasks.concat(tasks.filter((t) => !seen.has(t.id)));
        } else {
          merged.set(employeeId, { employee: group.employee, tasks });
          home = section;
        }
        if (departmentId && section.deptId === departmentId) home = section;
      }
    }
    const group = merged.get(employeeId);
    if (!group || !home) return [];
    if ((opts.status && opts.status !== 'all') || opts.dateFrom || opts.dateTo || q) {
      if (group.tasks.length === 0 && !(q && group.employee.full_name.toLowerCase().includes(q))) {
        return [];
      }
    }
    return [{
      ...home,
      employees: [group],
      taskCount: group.tasks.length,
    }];
  }

  let list = departmentId ? sections.filter((s) => s.deptId === departmentId) : sections;

  return list
    .map((section) => {
      const employees = section.employees
        .map((g) => {
          if (opts.managerId && opts.managerId !== 'all' && g.employee.manager_id !== opts.managerId) return null;

          let tasks = applyTaskFilters(g.tasks, { ...opts, search: undefined });
          if (q) {
            const empMatch =
              g.employee.full_name.toLowerCase().includes(q) ||
              g.employee.email.toLowerCase().includes(q);
            const matchingTasks = applyTaskFilters(g.tasks, opts);
            if (empMatch) return { ...g, tasks };
            if (matchingTasks.length) return { ...g, tasks: matchingTasks };
            return null;
          }
          return { ...g, tasks };
        })
        .filter((g): g is EmployeeAssignmentGroup => Boolean(g))
        .filter((g) => {
          if ((opts.status && opts.status !== 'all') || opts.dateFrom || opts.dateTo) {
            return g.tasks.length > 0;
          }
          return true;
        });

      const deptMatch = Boolean(q && section.deptName.toLowerCase().includes(q));
      if (deptMatch || employees.length) {
        return { ...section, employees, taskCount: employees.reduce((n, e) => n + e.tasks.length, 0) };
      }
      return null;
    })
    .filter(Boolean) as DepartmentAssignmentSection[];
}
