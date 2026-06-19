/**
 * Phase 3 — HRIS Integration
 *
 * A pluggable connector abstraction for importing employee directories from
 * external HR platforms (SAP SuccessFactors, Workday, BambooHR) or a CSV/Excel
 * upload. Each named platform ships with a mock connector that returns sample
 * records; swapping in a real implementation only requires fulfilling the
 * `HrisConnector.fetchEmployees` contract (the rest of the UI is unchanged).
 *
 * Real connectors would authenticate with the vendor API (OAuth / API key)
 * inside an Edge Function — credentials must never live in the browser bundle.
 */
import { UserRole } from './kpiHelpers';

export interface HrisEmployee {
  full_name: string;
  email: string;
  role: UserRole;
  department?: string;
}

export interface HrisConnector {
  id: string;
  name: string;
  description: string;
  /** Returns the live employee roster from the source system. */
  fetchEmployees: () => Promise<HrisEmployee[]>;
}

function delay<T>(value: T, ms = 700): Promise<T> {
  return new Promise((resolve) => setTimeout(() => resolve(value), ms));
}

const BAMBOO_SAMPLE: HrisEmployee[] = [
  { full_name: 'Pam Beesly', email: 'pam.beesly@bamboo.example', role: 'employee', department: 'Reception' },
  { full_name: 'Stanley Hudson', email: 'stanley.hudson@bamboo.example', role: 'employee', department: 'Sales' },
  { full_name: 'Phyllis Vance', email: 'phyllis.vance@bamboo.example', role: 'employee', department: 'Sales' },
];

const WORKDAY_SAMPLE: HrisEmployee[] = [
  { full_name: 'Holly Flax', email: 'holly.flax@workday.example', role: 'manager', department: 'Human Resources' },
  { full_name: 'Ryan Howard', email: 'ryan.howard@workday.example', role: 'employee', department: 'Marketing' },
  { full_name: 'Kelly Kapoor', email: 'kelly.kapoor@workday.example', role: 'employee', department: 'Customer Relations' },
];

const SAP_SAMPLE: HrisEmployee[] = [
  { full_name: 'Darryl Philbin', email: 'darryl.philbin@sap.example', role: 'manager', department: 'Warehouse' },
  { full_name: 'Erin Hannon', email: 'erin.hannon@sap.example', role: 'employee', department: 'Reception' },
];

export const CONNECTORS: HrisConnector[] = [
  {
    id: 'bamboohr',
    name: 'BambooHR',
    description: 'Sync the employee directory from BambooHR.',
    fetchEmployees: () => delay(BAMBOO_SAMPLE),
  },
  {
    id: 'workday',
    name: 'Workday',
    description: 'Import worker records from Workday HCM.',
    fetchEmployees: () => delay(WORKDAY_SAMPLE),
  },
  {
    id: 'sap',
    name: 'SAP SuccessFactors',
    description: 'Pull employee master data from SAP.',
    fetchEmployees: () => delay(SAP_SAMPLE),
  },
];

const VALID_ROLES: UserRole[] = ['employee', 'manager', 'admin'];

/**
 * Parse a CSV string into employee records. Expected headers (case-insensitive):
 * full_name (or name), email, role, department. Role defaults to "employee".
 */
export function parseEmployeeCsv(text: string): { employees: HrisEmployee[]; errors: string[] } {
  const errors: string[] = [];
  const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length === 0) return { employees: [], errors: ['File is empty.'] };

  const header = lines[0].split(',').map((h) => h.trim().toLowerCase());
  const idx = (names: string[]) => names.map((n) => header.indexOf(n)).find((i) => i >= 0) ?? -1;
  const nameIdx = idx(['full_name', 'name', 'full name']);
  const emailIdx = idx(['email', 'email_address', 'work_email']);
  const roleIdx = idx(['role']);
  const deptIdx = idx(['department', 'dept']);

  if (nameIdx < 0 || emailIdx < 0) {
    return { employees: [], errors: ['CSV must include at least "name" and "email" columns.'] };
  }

  const employees: HrisEmployee[] = [];
  for (let i = 1; i < lines.length; i++) {
    const cols = splitCsvLine(lines[i]);
    const full_name = (cols[nameIdx] || '').trim();
    const email = (cols[emailIdx] || '').trim().toLowerCase();
    if (!full_name || !email) {
      errors.push(`Row ${i + 1}: missing name or email — skipped.`);
      continue;
    }
    let role = ((roleIdx >= 0 ? cols[roleIdx] : '') || 'employee').trim().toLowerCase() as UserRole;
    if (!VALID_ROLES.includes(role)) role = 'employee';
    employees.push({
      full_name,
      email,
      role,
      department: deptIdx >= 0 ? (cols[deptIdx] || '').trim() : undefined,
    });
  }
  return { employees, errors };
}

/** Minimal CSV line splitter that respects double-quoted fields. */
function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (ch === ',' && !inQuotes) {
      out.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }
  out.push(cur);
  return out;
}

/** Generate a reasonably strong temporary password for imported accounts. */
export function generateTempPassword(): string {
  return 'Hr!' + Math.random().toString(36).slice(2, 10) + Math.floor(Math.random() * 90 + 10);
}
