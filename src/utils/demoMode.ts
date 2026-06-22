/** Known demo account emails — sandbox only, isolated from production data in DB. */
export const DEMO_EMAILS = [
  'admin@walfia.ai',
  'manager@walfia.ai',
  'employee@walfia.ai',
] as const;

export const DEMO_ACCOUNTS = [
  {
    email: 'admin@walfia.ai',
    password: 'admin123',
    roleLabel: 'Admin',
    personName: 'Sarah Jenkins',
    accent: 'var(--accent-primary)',
    icon: 'shield' as const,
  },
  {
    email: 'manager@walfia.ai',
    password: 'manager123',
    roleLabel: 'Manager',
    personName: 'Michael Scott',
    accent: 'var(--color-warning)',
    icon: 'users' as const,
  },
  {
    email: 'employee@walfia.ai',
    password: 'employee123',
    roleLabel: 'Employee',
    personName: 'Jim Halpert',
    accent: 'var(--color-success)',
    icon: 'user' as const,
  },
] as const;

export function isDemoProfile(profile: { email?: string; is_demo?: boolean } | null | undefined): boolean {
  if (!profile) return false;
  if (profile.is_demo === true) return true;
  return DEMO_EMAILS.includes(profile.email as typeof DEMO_EMAILS[number]);
}
