import { supabase } from '../lib/supabase';
import { sendKpiEmail } from './kpiEmail';

const LOGIN_URL = 'https://scorr.walfia.ai';

export function generateTempPassword(length = 10): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!@$%';
  const bytes = new Uint8Array(length);
  if (typeof crypto !== 'undefined' && crypto.getRandomValues) {
    crypto.getRandomValues(bytes);
  } else {
    for (let i = 0; i < length; i++) bytes[i] = Math.floor(Math.random() * 256);
  }
  let out = '';
  for (let i = 0; i < length; i++) out += chars[bytes[i]! % chars.length];
  return out;
}

function roleLabel(role: string): string {
  if (role === 'admin') return 'Administrator';
  if (role === 'manager') return 'Manager';
  return 'Employee';
}

/** Professional Scorr login credentials email (via Resend / kpi_email). */
export async function emailLoginCredentials(opts: {
  to: string;
  fullName: string;
  password: string;
  role: string;
  companyName?: string;
  departmentName?: string;
}): Promise<void> {
  const name = opts.fullName.trim() || 'there';
  const company = opts.companyName?.trim();
  const dept = opts.departmentName?.trim();

  const body = [
    `Dear ${name},`,
    '',
    company
      ? `Welcome to Scorr. Your account for ${company} has been created by your administrator.`
      : 'Welcome to Scorr. Your account has been created by your administrator.',
    '',
    'Please use the details below to sign in:',
    '',
    `Login URL: ${LOGIN_URL}`,
    `Email: ${opts.to.trim()}`,
    `Temporary password: ${opts.password}`,
    `Role: ${roleLabel(opts.role)}`,
    dept ? `Department: ${dept}` : null,
    '',
    'For your security, please sign in and change your password after your first login.',
    '',
    'If you did not expect this email, contact your company administrator.',
    '',
    'Kind regards,',
    'The Scorr Team',
    'https://scorr.walfia.ai',
  ]
    .filter((line) => line !== null)
    .join('\n');

  await sendKpiEmail(opts.to.trim(), 'Your Scorr account login details', body);
}

/**
 * Sets a new temporary password for an existing user and emails it via Scorr.
 * Old passwords cannot be recovered — this always issues a fresh temporary password.
 */
export async function resetAndEmailLoginCredentials(opts: {
  userId: string;
  email: string;
  fullName: string;
  role: string;
  departmentName?: string;
  companyName?: string;
  password?: string;
}): Promise<string> {
  const email = opts.email.trim();
  if (!email) throw new Error('User has no email address.');

  const password = (opts.password?.trim() || generateTempPassword());
  if (password.length < 6) throw new Error('Password must be at least 6 characters.');

  const { error: rpcErr } = await supabase.rpc('reset_user_password_admin', {
    p_user_id: opts.userId,
    p_new_password: password,
  });
  if (rpcErr) throw rpcErr;

  await emailLoginCredentials({
    to: email,
    fullName: opts.fullName,
    password,
    role: opts.role,
    departmentName: opts.departmentName,
    companyName: opts.companyName,
  });

  return password;
}
