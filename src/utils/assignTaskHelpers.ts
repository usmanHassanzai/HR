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

      const groups: EmployeeAssignmentGroup[] = deptEmployees.map((employee) => {
        const all = teamKpisByUser[employee.id] || [];
        const tasks = all.filter((k) => {
          if (k.department_id) return k.department_id === dept.id;
          const kDept = (k.department || '').trim().toLowerCase();
          return kDept === dept.name.toLowerCase() || kDept === dept.slug.toLowerCase();
        });
        return { employee, tasks };
      });

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

export function filterAssignmentSections(
  sections: DepartmentAssignmentSection[],
  opts: { departmentId?: string; search?: string },
): DepartmentAssignmentSection[] {
  let list = sections;
  if (opts.departmentId && opts.departmentId !== 'all') {
    list = list.filter((s) => s.deptId === opts.departmentId);
  }
  const q = opts.search?.trim().toLowerCase();
  if (!q) return list;

  return list
    .map((section) => {
      const employees = section.employees
        .map((g) => {
          const empMatch =
            g.employee.full_name.toLowerCase().includes(q) ||
            g.employee.email.toLowerCase().includes(q);
          const tasks = g.tasks.filter(
            (k) =>
              k.name.toLowerCase().includes(q) ||
              (k.description || '').toLowerCase().includes(q),
          );
          if (empMatch) return { ...g, tasks: g.tasks };
          if (tasks.length) return { ...g, tasks };
          return null;
        })
        .filter(Boolean) as EmployeeAssignmentGroup[];
      const deptMatch = section.deptName.toLowerCase().includes(q);
      if (deptMatch || employees.length) {
        return { ...section, employees, taskCount: employees.reduce((n, e) => n + e.tasks.length, 0) };
      }
      return null;
    })
    .filter(Boolean) as DepartmentAssignmentSection[];
}
