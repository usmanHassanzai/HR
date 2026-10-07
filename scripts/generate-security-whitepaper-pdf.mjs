#!/usr/bin/env node
/**
 * Generates Scorr-Security-Overview.pdf — organization-facing security brief.
 *
 * Run: npm run docs:security-guide
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { jsPDF } from 'jspdf';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'public', 'downloads', 'Scorr-Security-Overview.pdf');

const M = 16;
const W = 210;
const H = 297;
const LINE = 5.2;
const MAX_W = W - M * 2;
const FOOTER_Y = H - 10;

const doc = new jsPDF({ unit: 'mm', format: 'a4' });
let y = M;
let pageNum = 1;

function newPage() {
  doc.addPage();
  pageNum += 1;
  y = M + 6;
  header();
}

function header() {
  if (pageNum === 1) return;
  doc.setFillColor(248, 250, 252);
  doc.rect(0, 0, W, 14, 'F');
  doc.setDrawColor(226, 232, 240);
  doc.line(0, 14, W, 14);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(8);
  doc.setTextColor(13, 148, 136);
  doc.text('SCORR', M, 9);
  doc.setFont('helvetica', 'normal');
  doc.setTextColor(100, 116, 139);
  doc.text('Security Overview for Organizations', M + 18, 9);
  doc.text('Confidential', W - M, 9, { align: 'right' });
}

function footer() {
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(8);
  doc.setTextColor(148, 163, 184);
  doc.text(`Page ${pageNum}`, W / 2, FOOTER_Y, { align: 'center' });
  doc.text('© Walfia · Scorr Security', M, FOOTER_Y);
}

function ensure(h = LINE) {
  if (y + h > FOOTER_Y - 4) {
    footer();
    newPage();
  }
}

function title(text) {
  ensure(14);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(14);
  doc.setTextColor(15, 23, 42);
  doc.text(text, M, y);
  y += 7;
  doc.setDrawColor(13, 148, 136);
  doc.setLineWidth(0.55);
  doc.line(M, y, M + 40, y);
  y += 6;
}

function h1(text) {
  ensure(11);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(11);
  doc.setTextColor(13, 148, 136);
  doc.text(text, M, y);
  y += 6.2;
}

function h2(text) {
  ensure(9);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(10);
  doc.setTextColor(30, 41, 59);
  doc.text(text, M, y);
  y += 5.4;
}

function para(text) {
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(9.8);
  doc.setTextColor(51, 65, 85);
  for (const line of doc.splitTextToSize(text, MAX_W)) {
    ensure();
    doc.text(line, M, y);
    y += LINE;
  }
  y += 1.6;
}

function bullet(text) {
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(9.8);
  doc.setTextColor(51, 65, 85);
  for (const line of doc.splitTextToSize(`•  ${text}`, MAX_W - 2)) {
    ensure();
    doc.text(line, M + 1, y);
    y += LINE;
  }
}

function note(text) {
  const lines = doc.splitTextToSize(text, MAX_W - 8);
  const boxH = lines.length * LINE + 6;
  ensure(boxH + 2);
  doc.setFillColor(240, 253, 250);
  doc.setDrawColor(13, 148, 136);
  doc.setLineWidth(0.35);
  doc.roundedRect(M, y - 3, MAX_W, boxH, 1.5, 1.5, 'FD');
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(9.1);
  doc.setTextColor(15, 118, 110);
  let ty = y + 2;
  for (const line of lines) {
    doc.text(line, M + 4, ty);
    ty += LINE;
  }
  y += boxH + 4;
}

function warn(text) {
  const lines = doc.splitTextToSize(text, MAX_W - 8);
  const boxH = lines.length * LINE + 6;
  ensure(boxH + 2);
  doc.setFillColor(255, 251, 235);
  doc.setDrawColor(217, 119, 6);
  doc.setLineWidth(0.35);
  doc.roundedRect(M, y - 3, MAX_W, boxH, 1.5, 1.5, 'FD');
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(9.1);
  doc.setTextColor(146, 64, 14);
  let ty = y + 2;
  for (const line of lines) {
    doc.text(line, M + 4, ty);
    ty += LINE;
  }
  y += boxH + 4;
}

function tableHeader(a, b) {
  ensure(10);
  doc.setFillColor(241, 245, 249);
  doc.rect(M, y - 4, MAX_W, 7, 'F');
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(8.8);
  doc.setTextColor(30, 41, 59);
  doc.text(a, M + 2, y);
  doc.text(b, M + 52, y);
  y += 7;
}

function tableRow(label, value) {
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(8.8);
  doc.setTextColor(51, 65, 85);
  const valLines = doc.splitTextToSize(String(value), MAX_W - 56);
  ensure(valLines.length * LINE + 2);
  doc.text(String(label), M + 2, y);
  doc.setFont('helvetica', 'normal');
  doc.text(valLines[0], M + 52, y);
  y += LINE;
  for (let i = 1; i < valLines.length; i++) {
    ensure();
    doc.text(valLines[i], M + 52, y);
    y += LINE;
  }
  y += 0.6;
}

function tocItem(n, label) {
  ensure();
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(9.8);
  doc.setTextColor(51, 65, 85);
  doc.text(`${n}  ${label}`, M + 2, y);
  y += LINE + 0.7;
}

function spacer(h = 3) {
  y += h;
}

const generated = new Date().toLocaleDateString('en-US', {
  year: 'numeric',
  month: 'long',
  day: 'numeric',
});

// ── Cover ──────────────────────────────────────────────────────
doc.setFillColor(11, 17, 32);
doc.rect(0, 0, W, H, 'F');
doc.setFillColor(13, 148, 136);
doc.rect(0, 0, 6, H, 'F');
doc.rect(0, H - 8, W, 8, 'F');

doc.setTextColor(45, 212, 168);
doc.setFont('helvetica', 'bold');
doc.setFontSize(12);
doc.text('WALFIA  ·  SECURITY BRIEF', M + 4, 48);

doc.setTextColor(248, 250, 252);
doc.setFontSize(28);
doc.text('Scorr Security', M + 4, 72);
doc.setFontSize(16);
doc.text('Overview for Organizations', M + 4, 84);

doc.setFont('helvetica', 'normal');
doc.setFontSize(11);
doc.setTextColor(203, 213, 225);
[
  'How Scorr protects your company data, people, and sessions —',
  'written so you can share this with leadership, IT, and compliance.',
].forEach((line, i) => doc.text(line, M + 4, 104 + i * 7));

doc.setFontSize(10);
doc.setTextColor(148, 163, 184);
doc.text('Platform:     https://scorr.walfia.ai', M + 4, 132);
doc.text(`Document:    ${generated}`, M + 4, 140);
doc.text('Contact:      info@walfia.ai', M + 4, 148);
doc.text('Audience:    Company admins · IT · Security reviewers', M + 4, 156);

doc.setFontSize(9);
doc.setTextColor(100, 116, 139);
doc.text('Multi-tenant · MFA · RLS · Desktop & mobile apps · Encrypted transport', M + 4, H - 22);

newPage();

title('Table of Contents');
[
  ['1.', 'Executive summary'],
  ['2.', 'Security principles'],
  ['3.', 'Multi-tenant data isolation'],
  ['4.', 'Authentication & passwords'],
  ['5.', 'Multi-factor authentication (MFA)'],
  ['6.', 'Session security & idle lock'],
  ['7.', 'Role-based access control'],
  ['8.', 'Database & API protection (RLS)'],
  ['9.', 'Company onboarding controls'],
  ['10.', 'Attendance & location data'],
  ['11.', 'Demo sandbox isolation'],
  ['12.', 'Account recovery & deletion'],
  ['13.', 'Desktop & mobile apps (Windows, Linux, Android, iOS)'],
  ['14.', 'What we do not claim'],
  ['15.', 'Security checklist for your organization'],
  ['16.', 'Contact & further documents'],
].forEach(([n, l]) => tocItem(n, l));
footer();
newPage();

// 1
title('1. Executive summary');
para('Scorr is a multi-company performance and attendance platform available on the web, Windows, Linux, Android, and iPhone. Every organization runs as a private tenant: your people, KPIs, attendance, rewards, daily reports, and GPS records are separated from every other company on the same platform.');
para('Security is built into the product — not bolted on later. Access requires a verified login, mandatory authenticator MFA for real accounts, and database policies that enforce who can read or write each record.');

h2('In one sentence');
note('Scorr is designed so that only authenticated users in your company, with the correct role, can see your data — over encrypted HTTPS — with MFA, rate limits, idle session lock, and company-scoped storage.');

h2('Who this document is for');
bullet('Company leadership evaluating Scorr for rollout.');
bullet('IT / security teams reviewing architecture and controls.');
bullet('HR and Admin owners who must explain “how secure is it?” to stakeholders.');
footer();
newPage();

// 2
title('2. Security principles');
bullet('Least privilege — each role sees only what the role needs (Admin, HR, Manager, Employee).');
bullet('Tenant isolation — company_id scopes data; Company A cannot query Company B.');
bullet('Defense in depth — browser/app → HTTPS → Auth → role checks → Row Level Security → security-definer RPCs.');
bullet('Verify identity — password + MFA (TOTP) for production accounts; backup codes and email recovery when devices are lost.');
bullet('Minimize sensitive data — location and Wi-Fi signals are used only inside the attendance window (shift −60 / +60 minutes) for automatic or manual office attendance; not sold or shared across tenants.');
bullet('Audit & recovery — login attempt recording, admin authenticator reset, account deletion with owner safeguards.');
footer();
newPage();

// 3
title('3. Multi-tenant data isolation');
para('Scorr hosts many organizations on one platform. Isolation is enforced in application logic and in the database.');

h1('3.1 How tenants are separated');
bullet('Every user and business record is tied to a company_id.');
bullet('Queries and RPC functions resolve the current company from the signed-in user.');
bullet('Lists (people, KPIs, attendance, reports, rewards) are filtered to that company.');
bullet('Platform-owner tools (/platform) approve companies; they are not a “super user” inside your day-to-day employee data for other orgs beyond platform operations.');

h1('3.2 What this means for you');
bullet('Your competitors on Scorr cannot open your dashboards or export your files.');
bullet('Managers only see their allowed team scope; employees only see their own records.');
bullet('HR and Admin work inside your organization boundary.');

warn('Isolation depends on correct role assignment. Train admins to assign HR / Manager / Employee carefully and keep “Reports to” accurate.');
footer();
newPage();

// 4
title('4. Authentication & passwords');

h1('4.1 Identity provider');
para('Scorr uses Supabase Auth for sign-in. Passwords are hashed by the auth service — they are not stored as readable plain text in your company tables.');

h1('4.2 Password rules & reset');
bullet('Minimum password length: 6 characters (enforced at registration and change).');
bullet('Forgot password: rate-limited email of a temporary password (about 15 minutes cool-down when limited).');
bullet('Change password: verified through a secured server function so MFA sessions remain consistent.');

h1('4.3 Login abuse protection');
bullet('Failed sign-in attempts are recorded.');
bullet('Rate limiting blocks rapid password guessing (“Too many sign-in attempts. Wait 15 minutes…”).');
bullet('Forgot-password requests are also rate-limited.');
bullet('Generic error messages avoid revealing whether an email exists when that would help attackers.');

tableHeader('Control', 'Purpose');
tableRow('Hashed passwords', 'Credential theft from DB does not expose clear passwords.');
tableRow('Login rate limit', 'Slows brute-force attacks.');
tableRow('Forgot-password limit', 'Stops reset email flooding.');
tableRow('HTTPS only', 'Credentials and tokens travel encrypted in transit.');
spacer();
footer();
newPage();

// 5
title('5. Multi-factor authentication (MFA)');
para('Production Admin, HR, Manager, and Employee accounts must enroll authenticator MFA. Demo sandbox accounts skip MFA by design.');

h1('5.1 What users enroll');
bullet('TOTP apps: Google Authenticator or Microsoft Authenticator (industry-standard time-based codes).');
bullet('After enrollment, users receive 10 one-time backup codes (format like ABCD-EFGH).');
bullet('Backup codes are burned after use — store them offline.');

h1('5.2 Daily login');
bullet('Password (first factor) + authenticator code (second factor), or');
bullet('Password + one unused backup code if the phone is unavailable.');
bullet('Optional: “Trust this device” after a successful code — skip MFA on that device for a limited time (default 7 days; company policy).');
bullet('Trusted-device tokens are hashed server-side, rotated on each use, and never slide past the original expiry.');
bullet('Web: HttpOnly Secure SameSite=Strict cookie. Apps: Keystore / Keychain / desktop safeStorage.');
bullet('Auto-revoked on password change/reset, admin authenticator reset, MFA re-enrollment, or user deletion.');
bullet('Platform owners always ask for a code (no trust). Admins can set Always ask for staff or privileged roles.');

h1('5.3 Lost device recovery');
bullet('Email OTP recovery path (time-limited) to verify the user, then re-enroll a new authenticator.');
bullet('Optional recovery email under Settings → Account security.');
bullet('Company Admin can Reset authenticator from People for a locked-out teammate (privileged action).');

note('MFA raises the bar significantly: a stolen password alone is not enough to open the dashboard for production accounts.');
footer();
newPage();

// 6
title('6. Session security & idle lock');

h1('6.1 Session model');
bullet('After successful auth + MFA, Scorr issues a session for the browser or native app.');
bullet('Sessions are bound to the authenticated user; API calls use that identity (auth.uid()).');

h1('6.2 Idle auto-logout');
bullet('If there is no user activity for 60 minutes, the portal locks / signs out.');
bullet('Activity includes normal interaction (mouse, keyboard, touch).');
bullet('This reduces risk on shared or unattended office devices.');

h1('6.3 Practical guidance for organizations');
bullet('Require staff to lock phones and laptops when away from desk.');
bullet('Do not share login credentials between people — create one account per person.');
bullet('Revoke access promptly in People when someone leaves the company.');
footer();
newPage();

// 7
title('7. Role-based access control');
para('Scorr enforces four company roles. The UI and server both respect the role.');

tableHeader('Role', 'Security-relevant access');
tableRow('Admin', 'Full company configuration: people, departments, offices, tasks, rewards, attendance oversight, exports, branding. Approves manager/HR leave; receives HR/manager daily-report alerts.');
tableRow('HR', 'Company operations console; must report to a company admin. Own attendance + daily report go to admin. Cannot bypass tenant isolation.');
tableRow('Manager', 'Department/team scope: assign KPIs, approve employee leave/gifts, own attendance and daily report.');
tableRow('Employee', 'Own KPIs, attendance, leave requests, daily report, gift redeem — no company-wide admin tools.');
spacer();

h2('Why this matters');
bullet('A compromised employee password (even with MFA bypass attempts) still cannot manage the whole org.');
bullet('Managers cannot see unrelated departments outside their allowed scope.');
bullet('Privilege changes are controlled by Admin in People.');
footer();
newPage();

// 8
title('8. Database & API protection (RLS)');

h1('8.1 Row Level Security');
para('PostgreSQL Row Level Security (RLS) is enabled on core tables (users, KPIs, notifications, attendance-related data, and other business tables). Policies typically allow:');
bullet('A user to read/update their own rows.');
bullet('A manager to access their team where is_manager_of applies.');
bullet('Admin/HR (company privileged roles) to manage within the company.');

h1('8.2 Security-definer functions');
bullet('Sensitive operations run through controlled SQL functions (SECURITY DEFINER) that still check auth.uid(), role, and company.');
bullet('Examples: attendance geo processing, leave submit/review, daily report submit, user updates, office assignment.');
bullet('Clients cannot freely rewrite another company’s tables through the public API.');

h1('8.3 Edge functions for privileged actions');
bullet('Password change, forgot password, MFA recovery, authenticator reset, account deletion, and similar flows run as server-side edge functions.');
bullet('These keep privileged Auth Admin operations off the browser.');

note('Even if someone tampers with the UI, the database policies and RPCs are the source of truth for authorization.');
footer();
newPage();

// 9
title('9. Company onboarding controls');

h1('9.1 Registration is not instant full access');
bullet('Register Company collects account + company details.');
bullet('Email verification OTP (6 digits) confirms the registrant owns the inbox.');
bullet('Status becomes awaiting platform approval — dashboard stays closed until approved.');
bullet('Walfia platform owner reviews at /platform (Approve / Reject / Pause).');
bullet('Trial starts on approval — reduces fake or abusive signups.');

h1('9.2 Ongoing company status');
bullet('Paused / suspended / rejected companies cannot use the product normally.');
bullet('Contact info@walfia.ai for account status issues.');
footer();
newPage();

// 10
title('10. Attendance & location data');

h1('10.1 What is collected');
bullet('Automatic attendance (one-time device enrollment, non-expiring device token): phone GPS and/or office Wi-Fi (public IP + BSSID), or laptop on/off on the office network. Check-in/out only inside W = [shift start − 60 min, shift end + 60 min] in the shift’s IANA time zone (e.g. America/Chicago). Outside W nothing is recorded.');
bullet('Server clock (UTC) is authoritative; device clock skew is corrected. Raw location pings outside W are rejected and pings older than 90 days are deleted.');
bullet('Optional manual clock-in/out uses the same window rules. Leave days and supervisor remote/hybrid day status do not write clock times.');
bullet('Shift times, present/absent marks, leave requests, and visit segments for multi-visit days.');
bullet('Remote staff may be marked by supervisors without GPS.');

h1('10.2 How it is protected');
bullet('Location APIs require a secure context (HTTPS) — e.g. https://scorr.walfia.ai.');
bullet('Attendance records are company-scoped; other tenants cannot read them.');
bullet('Managers see team-relevant attendance; employees see their own history.');
bullet('Scorr does not sell location data and does not expose it to other organizations.');
bullet('Background GPS/Wi-Fi on mobile runs only during W (geofence + short foreground service), not 24/7 — not sold, not shared across companies, and not marketing tracking.');

h1('10.3 Organizational recommendations');
bullet('Publish an internal policy: when GPS is required, that auto attendance runs after first sign-in, and why.');
bullet('Ask staff to grant Always / background location on the phone app for Office GPS roles.');
bullet('Assign Office GPS zones only to people who need them.');
bullet('Use Remote/Hybrid work modes when GPS is not appropriate.');
footer();
newPage();

// 11
title('11. Demo sandbox isolation');
para('Public demo accounts (?demo=1) exist for product trials. They are isolated from production companies.');
bullet('Demo users are flagged is_demo.');
bullet('enforce_demo_isolation prevents demo sessions from touching real company users.');
bullet('Demo admins cannot provision real production staff.');
bullet('MFA is skipped only for demo — never for real company accounts.');

note('Always evaluate security using a real approved company account, not the public demo personas.');
footer();
newPage();

// 12
title('12. Account recovery & deletion');

h1('12.1 Recovery');
bullet('Forgot password → rate-limited temporary password email.');
bullet('MFA email recovery + backup codes + admin authenticator reset.');
bullet('Settings → Account security: regenerate backup codes, set recovery email, view recovery-related activity where available.');

h1('12.2 Account deletion');
bullet('Self-serve: Settings → Delete my account (type DELETE + password).');
bullet('Help page: https://scorr.walfia.ai/delete-account');
bullet('Company owners with remaining members must transfer ownership or confirm full company deletion — prevents accidental wipe of a live org.');
bullet('Email info@walfia.ai for assisted requests (handled within stated support window).');
footer();
newPage();

// 13
title('13. Desktop & mobile apps (Windows, Linux, Android, iOS)');
para('Scorr offers the same authenticated experience on Windows and Linux desktop installers, Android APK, iPhone Home Screen / native shell, and the website. All clients talk to the same backend over HTTPS with the same MFA and company isolation.');

h1('13.1 Shared security properties');
bullet('Same Sign In, MFA (TOTP), backup codes, roles, and tenant isolation as the website.');
bullet('Store/download CTAs are hidden inside an already-installed app shell.');
bullet('Location permission is requested for Office GPS attendance — on phones, prefer Always / background so auto check-in/out works without opening the dashboard.');
bullet('Manual Clock in / Clock out remain available; background GPS is attendance-only.');
bullet('Session idle lock and privileged MFA gates apply on every client.');

h1('13.2 Windows desktop (Scorr-Setup.exe)');
bullet('Official installer from https://scorr.walfia.ai/#download-windows (GitHub Release asset Scorr-Setup.exe, version 1.3.5+).');
bullet('Installs permanently with Start Menu and Desktop shortcuts — not a portable unzip-only build.');
bullet('Loads the live app shell (https://scorr.walfia.ai/?app=1) inside a locked-down Electron window (no marketing chrome).');
bullet('If Windows SmartScreen warns, verify the download came from scorr.walfia.ai / the official GitHub Release before continuing.');
bullet('Uninstall via Windows Settings → Apps when an employee leaves or a device is retired.');

h1('13.3 Linux desktop (Scorr.deb)');
bullet('Official package from https://scorr.walfia.ai/#download-linux (Scorr.deb, version 1.3.5+).');
bullet('Install with: sudo apt install ./Scorr.deb — then open Scorr from the applications menu.');
bullet('Same Electron shell and backend auth as Windows; keep packages updated from the official download page.');

h1('13.4 Android & iOS');
bullet('Android APK and iPhone Home Screen / native shell use the same Scorr backend and auth.');
bullet('Android 1.3.5+ includes background attendance GPS after the first sign-in (foreground notification while location is checked).');
bullet('Keep devices updated; install APKs only from https://scorr.walfia.ai/#download-app (official source).');

warn('Do not install Scorr Setup.exe, .deb, or APKs from unknown websites. Official source: scorr.walfia.ai (and the linked GitHub Release).');
footer();
newPage();

// 14
title('14. What we do not claim');
para('Transparency builds trust. This brief describes product and platform controls as implemented in Scorr. It is not a substitute for your own legal, privacy, or compliance review.');
bullet('This document does not assert a specific third-party certification (for example SOC 2 or ISO 27001) unless Walfia has separately provided that certificate to you.');
bullet('Security is shared: strong MFA and access hygiene on your side remain essential.');
bullet('No system can guarantee zero risk; Scorr reduces risk through layered controls.');
bullet('For contracts, DPAs, or region-specific residency requirements, contact info@walfia.ai.');
footer();
newPage();

// 15
title('15. Security checklist for your organization');
h2('Before go-live');
bullet('Approve only real company admins; complete MFA enrollment for every production user.');
bullet('Create departments; assign Managers and Employees with correct Reports to lines.');
bullet('Set Work location (Office / Remote / Hybrid) per person.');
bullet('Configure Office GPS only where needed; tell staff that auto attendance uses background location after first sign-in.');
bullet('Train staff: never share passwords; store backup codes offline.');

h2('Ongoing');
bullet('Offboard leavers the same day in People (or reset password / remove access).');
bullet('Review Admin/HR privileges quarterly.');
bullet('Monitor Daily Reports and leave approvals for unusual patterns.');
bullet('Keep Windows, Linux, Android, and iOS builds current from the official download page.');
bullet('Escalate suspected account takeover to info@walfia.ai immediately.');
footer();
newPage();

// 16
title('16. Contact & further documents');
tableHeader('Resource', 'Where');
tableRow('Live product', 'https://scorr.walfia.ai');
tableRow('This security PDF', 'https://scorr.walfia.ai/downloads/Scorr-Security-Overview.pdf');
tableRow('Full user guide PDF', 'https://scorr.walfia.ai/downloads/Scorr-Client-Feature-Guide.pdf');
tableRow('App download (all platforms)', 'https://scorr.walfia.ai/#download-app');
tableRow('Windows installer', 'https://scorr.walfia.ai/#download-windows');
tableRow('Linux .deb', 'https://scorr.walfia.ai/#download-linux');
tableRow('Delete-account help', 'https://scorr.walfia.ai/delete-account');
tableRow('Support', 'info@walfia.ai');
spacer();

para('Scorr is built so organizations can run KPIs, attendance, and rewards with clear boundaries: one company, authenticated people, verified MFA, and database-enforced access — on web, Windows, Linux, Android, and iPhone. Share this brief with your IT and leadership teams when evaluating or rolling out Scorr.');
para('© Walfia · https://scorr.walfia.ai · info@walfia.ai');
para(`Document generated: ${generated}`);

footer();

const buf = Buffer.from(doc.output('arraybuffer'));
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, buf);
console.log('✅ Scorr Security Overview PDF generated');
console.log(`   → ${OUT}`);
console.log(`   Size: ${(buf.length / 1024).toFixed(1)} KB · ${doc.getNumberOfPages()} pages`);
