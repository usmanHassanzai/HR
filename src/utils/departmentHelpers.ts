/** Department types, KPI indicators, and helpers */

export interface Department {
  id: string;
  name: string;
  slug: string;
  org_weight_pct: number;
  active: boolean;
  kpi_count?: number;
  active_kpi_count?: number;
  indicator_count?: number;
}

export interface DepartmentKpiIndicator {
  id: string;
  department_id: string;
  department_name?: string;
  name: string;
  description: string | null;
  weight_pct: number;
  sort_order: number;
}

/** Functional departments from KPI board template */
export const FUNCTIONAL_DEPARTMENTS = [
  {
    name: 'Finance',
    slug: 'finance',
    org_weight_pct: 25,
    indicators: [
      { name: 'Budget Variance', description: 'Measures differences between projected and actual costs.', weight_pct: 30 },
      { name: 'Accounts Receivable Turnover', description: 'Tracks speed of client payments.', weight_pct: 30 },
      { name: 'Gross Profit Margin', description: 'Evaluates conversion of revenue to profit.', weight_pct: 20 },
      { name: 'Operating Cash Flow', description: 'Assesses cash generated versus required to sustain operations.', weight_pct: 20 },
    ],
  },
  {
    name: 'Sales & Marketing',
    slug: 'sales-marketing',
    org_weight_pct: 25,
    indicators: [
      { name: 'Lead Conversion Rate', description: 'Percentage of leads that turn into customers.', weight_pct: 30 },
      { name: 'Customer Acquisition Cost (CAC)', description: 'Total marketing/sales spend divided by new customers.', weight_pct: 30 },
      { name: 'Monthly Sales Target / Volume', description: 'Actual revenue versus monthly quota.', weight_pct: 30 },
      { name: 'Customer Retention', description: 'Rate of retained customers or renewals.', weight_pct: 10 },
    ],
  },
  {
    name: 'Human Resources',
    slug: 'human-resources',
    org_weight_pct: 25,
    indicators: [
      { name: 'Monthly Employee Turnover Rate', description: 'Percentage of staff leaving the organization.', weight_pct: 30 },
      { name: 'Time to Hire', description: 'Average days to fill an open position.', weight_pct: 30 },
      { name: 'Training & Development Hours', description: 'Average hours completed per employee.', weight_pct: 20 },
      { name: 'Employee Satisfaction (NPS)', description: 'Score reflecting workplace engagement.', weight_pct: 20 },
    ],
  },
  {
    name: 'Operations & Supply Chain',
    slug: 'operations-supply-chain',
    org_weight_pct: 25,
    indicators: [
      { name: 'On-Time Delivery (OTD)', description: 'Orders delivered within the promised time frame.', weight_pct: 40 },
      { name: 'Defect or Error Rate', description: 'Percentage of products/services failing quality checks.', weight_pct: 30 },
      { name: 'Process Efficiency / Turnaround Time', description: 'Average time to complete a core service request.', weight_pct: 30 },
    ],
  },
] as const;

export function formatWeightPct(pct: number): string {
  return `${Number(pct).toFixed(1)}%`;
}

export function sumWeights(depts: { org_weight_pct: number }[]): number {
  return depts.reduce((s, d) => s + Number(d.org_weight_pct || 0), 0);
}

export function sumIndicatorWeights(indicators: { weight_pct: number }[]): number {
  return indicators.reduce((s, i) => s + Number(i.weight_pct || 0), 0);
}

export function weightsValid(depts: { org_weight_pct: number }[]): boolean {
  return Math.abs(sumWeights(depts) - 100) <= 0.05;
}

export function indicatorWeightsValid(indicators: { weight_pct: number }[]): boolean {
  return Math.abs(sumIndicatorWeights(indicators) - 100) <= 0.05;
}

/** Default KPI board auto-applied to every new department (same structure as image template). */
export const DEFAULT_NEW_DEPARTMENT_KPIS = [
  { name: 'Performance Target / Volume', description: 'Actual results versus monthly quota or target.', weight_pct: 30 },
  { name: 'Quality & Accuracy', description: 'Percentage of work passing quality checks.', weight_pct: 30 },
  { name: 'Timeliness / Delivery', description: 'Tasks completed within the promised time frame.', weight_pct: 20 },
  { name: 'Efficiency & Productivity', description: 'Average time to complete core department processes.', weight_pct: 20 },
] as const;
