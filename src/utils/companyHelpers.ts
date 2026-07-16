export type CompanyStatus = 'pending' | 'active' | 'rejected' | 'suspended';
export type SubscriptionPlan = 'starter' | 'professional' | 'enterprise' | 'trial';

export interface Company {
  id: string;
  name: string;
  status: CompanyStatus;
  contact_email: string;
  contact_phone?: string | null;
  subscription_plan?: SubscriptionPlan | null;
  trial_ends_at?: string | null;
  created_at?: string;
}

export interface CompanyRegistrationForm {
  companyName: string;
  industry: string;
  employeeCount: string;
  website: string;
  fullName: string;
  jobTitle: string;
  phone: string;
  email: string;
  password: string;
  confirmPassword: string;
  subscriptionPlan: SubscriptionPlan;
  addressLine: string;
  city: string;
  country: string;
  notes: string;
}

export interface PlatformCompanyRow {
  id: string;
  name: string;
  slug: string;
  status: CompanyStatus;
  contact_email: string;
  contact_name: string | null;
  contact_phone: string | null;
  job_title: string | null;
  industry: string | null;
  employee_count: string | null;
  website: string | null;
  address_line: string | null;
  city: string | null;
  country: string | null;
  subscription_plan: SubscriptionPlan | null;
  registration_notes: string | null;
  owner_email: string | null;
  owner_name: string | null;
  created_at: string;
  approved_at: string | null;
  user_count: number;
}

export interface PlatformNotification {
  id: string;
  company_id: string | null;
  title: string;
  message: string;
  read: boolean;
  created_at: string;
}

export const PLATFORM_OWNER_EMAIL = 'samiya@walfia.ai';
export const PLATFORM_PATH = '/platform';

export const SUBSCRIPTION_PLANS: { id: SubscriptionPlan; label: string; description: string }[] = [
  { id: 'trial', label: 'Free Trial', description: '3-day demo — upgrade after approval' },
  { id: 'starter', label: 'Starter', description: 'Up to 25 employees · $12/user/mo' },
  { id: 'professional', label: 'Professional', description: 'Unlimited employees · $18/user/mo' },
  { id: 'enterprise', label: 'Enterprise', description: 'Custom volume pricing & SSO' },
];

export const INDUSTRY_OPTIONS = [
  'Technology', 'Finance', 'Healthcare', 'Retail', 'Manufacturing',
  'Education', 'Hospitality', 'Logistics', 'Consulting', 'Other',
];

export const EMPLOYEE_COUNT_OPTIONS = [
  '1–10', '11–25', '26–50', '51–100', '101–250', '250+',
];

export function isPlatformOwner(profile: { email?: string; is_platform_owner?: boolean } | null): boolean {
  if (!profile) return false;
  if (profile.is_platform_owner) return true;
  return profile.email?.toLowerCase() === PLATFORM_OWNER_EMAIL.toLowerCase();
}

export function isPlatformRoute(): boolean {
  return typeof window !== 'undefined' && window.location.pathname.startsWith(PLATFORM_PATH);
}

export async function fetchMyCompany(supabase: { rpc: (name: string) => PromiseLike<{ data: unknown; error: unknown }> }) {
  const { data, error } = await supabase.rpc('get_my_company');
  if (error) throw error;
  const rows = data as Company[] | null;
  return rows?.[0] ?? null;
}

export function buildRegistrationEmailBody(form: CompanyRegistrationForm): string {
  return [
    `Company: ${form.companyName}`,
    `Contact: ${form.fullName}${form.jobTitle ? ` (${form.jobTitle})` : ''}`,
    `Email: ${form.email}`,
    `Phone: ${form.phone || '—'}`,
    `Subscription: ${form.subscriptionPlan}`,
    `Industry: ${form.industry || '—'}`,
    `Team size: ${form.employeeCount || '—'}`,
    `Website: ${form.website || '—'}`,
    `Location: ${[form.city, form.country].filter(Boolean).join(', ') || '—'}`,
    form.notes ? `Notes: ${form.notes}` : '',
    '',
    'Review and approve: https://scorr.walfia.ai/platform',
  ].filter(Boolean).join('\n');
}
