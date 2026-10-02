#!/usr/bin/env node
/**
 * Generates Scorr-Client-Feature-Guide.pdf — complete product guide from scratch.
 *
 * Run: npm run docs:client-guide
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { jsPDF } from 'jspdf';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const OUT_PUBLIC = path.join(ROOT, 'public', 'downloads', 'Scorr-Client-Feature-Guide.pdf');

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
  drawPageHeader();
}

function drawPageHeader() {
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
  doc.text('Complete User Guide', M + 18, 9);
  doc.text('scorr.walfia.ai', W - M, 9, { align: 'right' });
}

function drawFooter() {
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(8);
  doc.setTextColor(148, 163, 184);
  doc.text(`Page ${pageNum}`, W / 2, FOOTER_Y, { align: 'center' });
  doc.text('© Walfia · Scorr', M, FOOTER_Y);
}

function ensure(h = LINE) {
  if (y + h > FOOTER_Y - 4) {
    drawFooter();
    newPage();
  }
}

function title(text) {
  ensure(14);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(14.5);
  doc.setTextColor(15, 23, 42);
  doc.text(text, M, y);
  y += 7.5;
  doc.setDrawColor(13, 148, 136);
  doc.setLineWidth(0.6);
  doc.line(M, y, M + 36, y);
  y += 6.5;
}

function h1(text) {
  ensure(11);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(11);
  doc.setTextColor(13, 148, 136);
  doc.text(text, M, y);
  y += 6.5;
}

function h2(text) {
  ensure(9);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(10);
  doc.setTextColor(30, 41, 59);
  doc.text(text, M, y);
  y += 5.5;
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
  y += 1.8;
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

function step(n, text) {
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(9.8);
  doc.setTextColor(13, 148, 136);
  const label = `Step ${n}:`;
  ensure();
  doc.text(label, M, y);
  const labelW = doc.getTextWidth(label) + 2;
  doc.setFont('helvetica', 'normal');
  doc.setTextColor(51, 65, 85);
  const lines = doc.splitTextToSize(text, MAX_W - labelW);
  doc.text(lines[0], M + labelW, y);
  y += LINE;
  for (let i = 1; i < lines.length; i++) {
    ensure();
    doc.text(lines[i], M + labelW, y);
    y += LINE;
  }
  y += 1.2;
}

function note(text) {
  const lines = doc.splitTextToSize(text, MAX_W - 8);
  const boxH = lines.length * LINE + 6;
  ensure(boxH + 2);
  doc.setFillColor(240, 253, 250);
  doc.setDrawColor(13, 148, 136);
  doc.setLineWidth(0.4);
  doc.roundedRect(M, y - 3, MAX_W, boxH, 1.5, 1.5, 'FD');
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(9.2);
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
  doc.setFillColor(254, 242, 242);
  doc.setDrawColor(185, 28, 28);
  doc.setLineWidth(0.4);
  doc.roundedRect(M, y - 3, MAX_W, boxH, 1.5, 1.5, 'FD');
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(9.2);
  doc.setTextColor(153, 27, 27);
  let ty = y + 2;
  for (const line of lines) {
    doc.text(line, M + 4, ty);
    ty += LINE;
  }
  y += boxH + 4;
}

function featureBlock(name, desc) {
  ensure(12);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(9.8);
  doc.setTextColor(15, 23, 42);
  doc.text(name, M, y);
  y += 5.2;
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(9.3);
  doc.setTextColor(71, 85, 105);
  for (const line of doc.splitTextToSize(desc, MAX_W - 4)) {
    ensure();
    doc.text(line, M + 3, y);
    y += LINE;
  }
  y += 2.5;
}

function tableHeader(cols) {
  ensure(10);
  doc.setFillColor(241, 245, 249);
  doc.rect(M, y - 4, MAX_W, 7, 'F');
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(8.8);
  doc.setTextColor(30, 41, 59);
  doc.text(cols[0], M + 2, y);
  doc.text(cols[1], M + 48, y);
  y += 7;
}

function tableRow(label, value) {
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(8.8);
  doc.setTextColor(51, 65, 85);
  const valLines = doc.splitTextToSize(String(value), MAX_W - 52);
  ensure(valLines.length * LINE + 2);
  doc.text(String(label), M + 2, y);
  doc.setFont('helvetica', 'normal');
  doc.text(valLines[0], M + 48, y);
  y += LINE;
  for (let i = 1; i < valLines.length; i++) {
    ensure();
    doc.text(valLines[i], M + 48, y);
    y += LINE;
  }
  y += 0.8;
}

function spacer(h = 3.5) {
  y += h;
}

function tocItem(num, label) {
  ensure();
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(9.8);
  doc.setTextColor(51, 65, 85);
  doc.text(`${num}  ${label}`, M + 2, y);
  y += LINE + 0.8;
}

const generated = new Date().toLocaleDateString('en-US', {
  year: 'numeric',
  month: 'long',
  day: 'numeric',
});

// ═══════════════════════════════════════════════════════════════
// COVER
// ═══════════════════════════════════════════════════════════════
doc.setFillColor(11, 17, 32);
doc.rect(0, 0, W, H, 'F');
doc.setFillColor(13, 148, 136);
doc.rect(0, H - 8, W, 8, 'F');

doc.setTextColor(45, 212, 168);
doc.setFont('helvetica', 'bold');
doc.setFontSize(34);
doc.text('Scorr', M, 62);

doc.setTextColor(248, 250, 252);
doc.setFontSize(16);
doc.text('Complete User Guide', M, 78);

doc.setFont('helvetica', 'normal');
doc.setFontSize(11);
doc.setTextColor(203, 213, 225);
[
  'Everything about Scorr — from company registration',
  'and roles to KPIs, weightage rewards, GPS attendance,',
  'live tracking, mobile apps, security, and account deletion.',
].forEach((line, i) => doc.text(line, M, 96 + i * 7));

doc.setFontSize(10);
doc.setTextColor(148, 163, 184);
doc.text('Live platform:   https://scorr.walfia.ai', M, 128);
doc.text(`Document date:  ${generated}`, M, 136);
doc.text('Prepared by:     Walfia', M, 144);
doc.text('Support:         info@walfia.ai', M, 152);

doc.setFontSize(9);
doc.setTextColor(100, 116, 139);
doc.text('Registration · Roles · KPIs · Rewards · Attendance · Mobile · Security', M, H - 22);

newPage();

// TOC
title('Table of Contents');
[
  ['1.', 'What is Scorr?'],
  ['2.', 'Getting started — register, trial & approval'],
  ['3.', 'Sign in, passwords & first-time MFA'],
  ['4.', 'Roles explained (Admin, HR, Manager, Employee)'],
  ['5.', 'Administrator console — every menu'],
  ['6.', 'Add people, departments & branding'],
  ['7.', 'First-time admin checklist'],
  ['8.', 'Manager console'],
  ['9.', 'Employee console'],
  ['10.', 'KPIs — weightage, score, assign & review'],
  ['11.', 'Rewards — Current, Used, Banked & gifts'],
  ['12.', 'Attendance, shifts, leave & GPS'],
  ['13.', 'Office GPS zones & live tracking'],
  ['14.', 'Daily work reports'],
  ['15.', 'Analytics, exports & notifications'],
  ['16.', 'Mobile apps (Android & iPhone)'],
  ['17.', 'Security, recovery & account deletion'],
  ['18.', 'Plans, trial & demo sandbox'],
  ['19.', 'Troubleshooting & support'],
  ['20.', 'Quick reference numbers'],
].forEach(([num, label]) => tocItem(num, label));
drawFooter();
newPage();

// 1
title('1. What is Scorr?');
para('Scorr (https://scorr.walfia.ai) is a company workspace for performance management, GPS attendance, and weightage-based rewards. One login works on the website, the Android app, and the iPhone Home Screen app.');
para('Each registered company is a private tenant. Staff in Company A cannot see Company B’s people, KPIs, attendance, rewards, or GPS records. Role-based dashboards give Admin, HR, Manager, and Employee exactly the tools they need.');

h2('What you run in one place');
bullet('KPI tasks with weightage (0–100% per person). Overall, Month, and Year views stay independent.');
bullet('Departments, people, roles, job titles, and reporting lines.');
bullet('GPS attendance with geofenced offices, day and overnight shifts, multi-visit days, leave, and live team location.');
bullet('Company gifts and a reward catalog paid with monthly weightage (Current / Used / Banked) — not a separate points wallet.');
bullet('Daily work reports, analytics, and Excel / PDF / CSV exports.');
bullet('Authenticator MFA (Google or Microsoft Authenticator), backup codes, and email recovery.');

h2('Who it is for');
bullet('Company admins who set up people, offices, KPIs, and branding.');
bullet('Managers who assign tasks, approve leave and gifts, and coach their team.');
bullet('HR staff who work in the HR console with company-wide access (reports to an admin).');
bullet('Employees who complete KPIs, clock in/out, request leave, and redeem gifts.');
bullet('Platform owner (info@walfia.ai) who approves new companies at /platform.');

note('Timezone for shifts, periods, and month-end weightage reveal: Asia/Karachi. Branding defaults to “Scorr” with tagline scorr.walfia.ai — admins can white-label name, logo, and colors.');
drawFooter();
newPage();

// 2
title('2. Getting started — register, trial & approval');
para('New organizations start on the public site. The 3-day free trial begins when the platform owner approves the company — not when you submit the form. No credit card is required.');

h1('2.1 Register Company (2 steps)');
step(1, 'Open https://scorr.walfia.ai and choose Register Company — Free for 3 Days.');
step(2, 'Step 1 of 2 (Account): Company name, your name, admin email, phone, password (min 6 characters), confirm password → Continue.');
step(3, 'Step 2 of 2 (Company): Optional industry and headcount (1–10, 11–25, 26–50, 51–100, 101–250, 250+) → Create account.');
step(4, 'Enter the 6-digit email verification code (Verify and continue). Use Resend code if needed.');
step(5, 'Wait for platform approval. You will see Awaiting admin approval and cannot open the dashboard yet.');

h1('2.2 What happens behind the scenes');
bullet('info@walfia.ai is notified of the registration.');
bullet('Platform owner opens /platform → Pending → Approve (or Reject / Edit / Pause later).');
bullet('On Approve, a 3-day trial starts (trial_ends_at = now + 3 days) with full Professional-level features.');
bullet('The registrant becomes the first Administrator and company owner.');

h1('2.3 After approval');
step(1, 'Sign in with the same email and password.');
step(2, 'Accept the monitoring / location / data-use policy if prompted.');
step(3, 'Enroll authenticator MFA and save backup codes (see Section 3).');
step(4, 'You land in the Admin console — then add departments, people, offices, and KPIs.');

warn('If status is Rejected, registration was not approved. If Trial ended or Account paused, contact info@walfia.ai. Suspended / paused companies cannot use the dashboard until resumed.');
drawFooter();
newPage();

// 3
title('3. Sign in, passwords & first-time MFA');

h1('3.1 Sign In');
bullet('Website: https://scorr.walfia.ai → Sign In. Tabs: Sign In | Register Company.');
bullet('Fields: Email Address, Password. Accept the policy checkbox when shown.');
bullet('Forgot password? Enter your registered email → Send password. Scorr emails a temporary password (rate-limited; wait about 15 minutes if blocked).');
bullet('Wrong password → “Incorrect password.” Unknown email → “Incorrect email and password.”');

h1('3.2 Authenticator MFA (required for real accounts)');
para('After password, Scorr opens Authenticator required. Use Google Authenticator or Microsoft Authenticator.');
step(1, 'Scan the QR code (or enter the Manual key). Factor name: Scorr authenticator.');
step(2, 'Enter your Account password and the 6-digit code → Verify and continue.');
step(3, 'Save 10 one-time backup codes (XXXX-XXXX). Download as .txt (scorr-backup-codes.txt) or Copy to clipboard. Store them offline.');
step(4, 'Later logins: password + authenticator code, or one unused backup code (Use backup code).');

h1('3.3 Lost authenticator');
bullet('On the MFA screen: Send verification code to your login email (expires in 20 minutes) → Verify email code → re-enroll a new authenticator.');
bullet('Optional: set a separate recovery email under Settings → Account security (confirm within 20 minutes).');
bullet('Admin can Reset authenticator from People for a locked-out teammate.');
bullet('Request admin to reset authenticator is also available on the MFA gate.');

h1('3.4 Change password & Account security');
bullet('Settings → Change password (min 6 characters; must differ from current).');
bullet('Settings → Account security (2FA recovery): regenerate 10 backup codes, set recovery email, view recovery audit trail.');
note('Demo sandbox accounts skip MFA. Production Admin, HR, Manager, and Employee accounts must enroll.');
drawFooter();
newPage();

// 4
title('4. Roles explained');
para('Each person has one role. The role chooses the dashboard and what Scorr allows. Header badges show: Admin · HR · Manager · Employee.');

tableHeader(['Role', 'Main purpose']);
tableRow('Admin', 'Full company: People, Assign Task, Daily Reports, Rewards, KPI & Rewards, Analytics, Attendance, Office GPS, Live Tracking, Departments, Export, Settings (branding + security).');
tableRow('HR', 'Same admin-style console labeled HR console; reports to a company admin; company-wide access for day-to-day HR operations.');
tableRow('Manager', 'Team: My KPIs, Assign Task, People, Attendance, Rewards, Daily report, Settings. Assign to department staff; approve leave and gifts.');
tableRow('Employee', 'Own work: My KPIs, Attendance, Rewards, Daily report, Settings.');
tableRow('Platform owner', 'Approve/reject/pause/resume/delete companies at /platform. Not a normal company role.');
spacer();

h2('Rules when adding people');
bullet('Employee — KPIs, attendance, rewards.');
bullet('Manager — team tasks and approvals.');
bullet('HR — reports to admin, company-wide access.');
bullet('Admin — full company settings.');
bullet('HR must report to a company admin. Employees and managers need a department.');
bullet('Employees see only their own records. Managers see their team. Admins/HR see their organization only.');
drawFooter();
newPage();

// 5
title('5. Administrator console — every menu');
para('Eyebrow: Admin console (or HR console). Sidebar items and what they do:');

featureBlock('People', 'Add teammates, set roles, department, job title, Reports to, email login details, reset password / authenticator, open a person’s related modules (KPIs, attendance, rewards, reports, analytics).');
featureBlock('Assign Task', 'Create KPI templates, assign tasks with weightage and dates, review completions (Approve & award / Send back), pause/resume, edit or remove assignments.');
featureBlock('Daily Reports', 'Staff daily work logs by department and role (Both / Managers only / Employees only). See who submitted and who has not.');
featureBlock('Rewards', 'Tabs: KPI awards, History, People, Redemptions, Catalog. Approve / Delivered / Reject gift requests. Reject returns weightage.');
featureBlock('KPI & Rewards', 'Each person’s weightage board: Earned, Current, Used, Banked. Open a person for the full scoreboard and tasks.');
featureBlock('Analytics', 'Individual Performance & Activity Analytics — trends, attainment, per-person health.');
featureBlock('Attendance', 'Leave, remote/hybrid marking, shifts, history, company location window. Opening Attendance reconciles ended shifts.');
featureBlock('Office GPS', 'Create geofence zones, assign people or whole teams, manage all offices.');
featureBlock('Live Tracking', 'Field team locations for today — At site / Away / Offline / No site. Refreshes about every 2 minutes.');
featureBlock('Departments', 'Org structure only (Sales, Finance, …). Not a separate score engine.');
featureBlock('Export', 'Monthly or quarterly reports as Excel, PDF, or CSV.');
featureBlock('Settings', 'White-label branding (name, tagline, logo URL, colors) + Account security (2FA recovery) + Delete my account.');
drawFooter();
newPage();

// 6
title('6. Add people, departments & branding');

h1('6.1 Departments first');
bullet('Open Departments → create the org units you need.');
bullet('Managers and employees must belong to a department so Assign Task can list them.');
bullet('Removing a department does not erase historical scores already saved on people.');

h1('6.2 Add person (People)');
tableHeader(['Field', 'What to enter']);
tableRow('Full name', 'Display name in dashboards and emails.');
tableRow('Email', 'Work email used to sign in (unique).');
tableRow('Password', 'Temporary password (min 6). Share securely or Email login details.');
tableRow('System role', 'Employee, Manager, HR, or Admin.');
tableRow('Department', 'Required for Manager and Employee.');
tableRow('Job title', 'Optional title shown on profiles.');
tableRow('Reports to', 'Manager or admin as required by role.');
tableRow('Work location', 'Office (GPS) · Remote (supervisor marks) · Hybrid.');
spacer();

h1('6.3 After create');
bullet('They appear in People immediately.');
bullet('They sign in, enroll MFA, save backup codes, then open their dashboard.');
bullet('Use Reset password or Reset authenticator when someone is locked out.');
bullet('Person hub shows Current / Used / Banked and shortcuts to related modules.');

h1('6.4 Branding (Admin Settings)');
bullet('White-Label Branding: Brand Name, Tagline, Logo URL, Primary Color, Secondary Color, Reset.');
bullet('Changes sync for your company workspace.');

warn('Demo sandbox admin cannot add real company users. Sign out and use your approved company Admin account.');
drawFooter();
newPage();

// 7
title('7. First-time admin checklist');
step(1, 'Sign in as Admin after approval and finish MFA enrollment.');
step(2, 'Settings — set company name, logo, and colors.');
step(3, 'Departments — create departments.');
step(4, 'People — add Managers, then Employees (and HR if needed). Email login details where helpful.');
step(5, 'Office GPS — create zones (name, pin, radius) and assign people or teams if you use GPS attendance.');
step(6, 'Attendance → Shifts — define day and overnight shifts; assign people.');
step(7, 'Assign Task → KPI\'s — create templates; then Assign Task with weightage and dates.');
step(8, 'Rewards — review KPI awards (movie / dinner / surprise), catalog items, and redemption queue.');
step(9, 'Ask every staff member to enroll MFA and allow Location if you use GPS.');
step(10, 'Optional: Export a sample monthly report to verify data.');
drawFooter();
newPage();

// 8
title('8. Manager console');
para('Eyebrow: Manager console. Managers work with their department team and their own KPIs. There is no company Branding tab.');

featureBlock('My KPIs', 'Manager’s own tasks and weightage scoreboard (same employee-style board).');
featureBlock('Assign Task', 'Assign KPIs to department staff. Completions notify the assigner and reporting manager.');
featureBlock('People', 'Team ranking and open a person for scoreboard / related views.');
featureBlock('Attendance', 'Approvals, My day, Team, Shifts, History — leave approvals, check-in, live team context.');
featureBlock('Rewards', 'Gifts to arrange: Approve / Delivered / Reject. Reject returns weightage. Personal redeem uses Current or Banked.');
featureBlock('Daily report', 'Submit or update your own daily work log.');
featureBlock('Settings', 'Change password, Account security, Delete my account.');

h2('Managers cannot');
bullet('Create company users, departments, or branding.');
bullet('See unrelated departments or other companies.');
bullet('Assign KPIs outside their allowed team.');
drawFooter();
newPage();

// 9
title('9. Employee console');
para('Eyebrow: Employee. Employees only see their own records.');

featureBlock('My KPIs', 'Open and History. Scoreboard: Left to use now, Month limit, Earned this month, Used on gifts, Left to use, Saved for later (Banked). Mark Complete when done. Switch Overall / Month / Year.');
featureBlock('Attendance', 'Mark attendance (GPS clock in/out), Request leave, Attendance history. Multi-visit days and auto clock-out at shift end.');
featureBlock('Rewards', 'Company gifts and reward catalog. Redeem with spendable weightage. Track Pending / Approved / Delivered / Rejected.');
featureBlock('Daily report', 'What did you accomplish today? Min 20 / max 8000 characters. Submit or Update.');
featureBlock('Settings', 'Change password, Account security (backup codes, recovery email), Delete my account.');
drawFooter();
newPage();

// 10
title('10. KPIs — weightage, score, assign & review');

h1('10.1 Core terms');
tableHeader(['Term', 'Meaning / limit']);
tableRow('Weight / Weightage', 'Per task 1–100%. Sum of open tasks per person ≤ 100%.');
tableRow('Achieved / Awarded', 'On approve: 0 up to the task’s weight (cannot exceed assigned).');
tableRow('Score', 'Points-style index that can rise above 100 when people over-deliver. Boards emphasize weightage.');
tableRow('Categories', 'Monthly Goal · Quality · Punctuality & Behaviour · Urgent Tasks (grouping only).');
tableRow('Periods', 'Overall | Month | Year — independent views.');
tableRow('Reveal', 'Awarded weightage shows on the assignee dashboard on the last calendar day of the month.');
spacer();

h2('Performance labels');
bullet('Outstanding ≥ 95% · Excellent 90–94 · Good 80–89 · Needs Improvement 70–79 · Unsatisfactory below 70.');

h1('10.2 End-to-end workflow');
step(1, 'KPI\'s tab — create a template for a department person (category, late rules, grace days, description, weight 1–100%).');
step(2, 'Assign Task — Who / What / When & note · Weight (%) · Start/Due · optional pause for Urgent → Assign KPI to {Name}. Meter shows Weight in use.');
step(3, 'Employee opens the task (= In progress). Receiving the email alone does NOT start the task.');
step(4, 'Employee Marks Complete → pending_review. Email + in-app alerts go to reporting manager and assigner.');
step(5, 'Review completion — Weightage to award (max N) → Approve & award OR Send back.');
step(6, 'On the last day of the month, awarded weightage reveals. Unused closed-month leftovers can move to Saved for later (Banked).');

h1('10.3 Assigned Task filters');
bullet('Current | Review | Completed.');
bullet('Cards show Weight, Start, Due, Progress (In progress / Complete), Health (Going well / Needs attention / Behind), Achieved.');
bullet('Actions: Pause / Resume · Edit · Remove.');

h1('10.4 Employee board labels');
bullet('Open (N) | History (N).');
bullet('Your weightage at a glance / KPI weightage (badge Max 100%).');
bullet('Left to use now · Month limit · Earned this month · Used on gifts · Left to use · Saved for later.');

note('Opening a task starts it. Completing it notifies the reporting manager and the person who assigned it. Overdue notices may show a miss count.');
drawFooter();
newPage();

// 11
title('11. Rewards — Current, Used, Banked & gifts');
para('Scorr rewards use monthly weightage (0–100%), not a separate forever-points wallet. Managers or admins arrange gifts after someone redeems.');

h1('11.1 Balance terms (use these labels)');
tableHeader(['Label', 'Meaning']);
tableRow('Earned this month', 'From finished / approved tasks (self views may defer until month-end reveal).');
tableRow('Current / Left to use', 'Spendable now (month remaining ± banked where applicable).');
tableRow('Used / Used on gifts', 'Spent on catalog or company gifts.');
tableRow('Banked / Saved for later', 'Unused closed-month weightage — never expires.');
spacer();
para('Simple check: Earned + Banked − Used = Left to use (depending on the surface labels shown).');

h1('11.2 Company gifts (KPI awards)');
bullet('2 movie tickets — consistent good performer streak (about 90–95% × 3 months).');
bullet('Dinner voucher for 2 — outstanding month band (about 95–100%) using Current + banked.');
bullet('Surprise gift from the company — elite consistency (about 90–95% × 6 months).');
bullet('CTA: Redeem → Requested. Admin legends: Consistent Good Performer · Outstanding Month · Elite Consistency.');

h1('11.3 Reward catalog');
bullet('Items cost 0–100% weightage (Need X% / Uses X%).');
bullet('Typically one monthly gift path (dinner or catalog) per person per month — follow on-screen rules.');
bullet('Reject refunds weightage so the person can try again if rules allow.');

h1('11.4 Approval flow');
step(1, 'Employee or manager redeems a gift or catalog item.');
step(2, 'Manager/Admin opens Rewards → Redemptions (or Gifts to arrange).');
step(3, 'Approve, mark Delivered, or Reject (reject returns weightage).');
step(4, 'Statuses: Pending · Approved · Delivered · Rejected.');

note('Streak gifts (movie / surprise) follow streak rules and may not spend Current the same way as catalog items. Always read the redeem confirmation on screen.');
drawFooter();
newPage();

// 12
title('12. Attendance, shifts, leave & GPS');
para('Page title: Attendance & Leave. Times use Asia/Karachi.');

h1('12.1 Tabs by role');
tableHeader(['Role', 'Tabs']);
tableRow('Employee', 'Mark attendance · Request leave · Attendance history');
tableRow('Manager', 'Approvals · My day · Team · Shifts · History');
tableRow('Admin / HR', 'Leave · Remote · Shifts · History (+ Company location window)');
spacer();

h1('12.2 Shifts');
bullet('Shift name, Start time, End time, Work days → Save shift.');
bullet('Overnight shift — end time is on the next day (e.g. 8 PM → 8 AM).');
bullet('Check-in opens 1 hour before start. Manual clock-out allowed until 1 hour after end.');
bullet('Default example window often Mon–Fri 09:00–18:00; companies can set a Company location window.');
bullet('People get Active shift assigned/updated notifications.');

h1('12.3 GPS clock in / out');
bullet('Card: Shift location · Entry + exit · Clock in / Clock out.');
bullet('GPS is captured at clock-in and clock-out (event-based — not continuous tracking while you work).');
bullet('Multi-visit: This shift\'s visits · #N · On site now · minutes summed; time away is not counted.');
bullet('Be inside the geofence during the shift. Status copy: Inside / Outside zone, still present, checked out, shift ended + 1 hour.');

h1('12.4 Auto clock-out');
bullet('If still checked in when the shift ends, Scorr stamps clock-out at shift end.');
bullet('Notes like Auto clock-out (shift ended) / Clocked out (shift ended).');
bullet('Opening Attendance or Live Tracking also reconciles ended shifts.');

h1('12.5 Leave');
bullet('Request time off: Type Annual / Sick / Other · From / To · Submit request.');
bullet('Stats: Annual leave left · Sick leave left · Leave days this month.');
bullet('Manager/Admin: Approve or Reject.');

h1('12.6 Work location modes');
bullet('Office (GPS / check-in) — must use geofence.');
bullet('Remote (supervisor marks attendance) — Present / Absent.');
bullet('Hybrid — office GPS days plus Working from home / Absent today options.');

h1('12.7 History');
bullet('This month (daily) / Month by month / Full year.');
bullet('Download CSV / by department. Source GPS or Manual. Present / Absent / Late / Half Day.');
drawFooter();
newPage();

// 13
title('13. Office GPS zones & live tracking');

h1('13.1 Office GPS (Admin)');
para('Header: Office GPS zones. Steps: 1 · Capture & save zone · 2 · Assign people · 3 · Manage offices.');
bullet('Tabs: Create zone · Assign people · All offices.');
bullet('Fields: Office name, Address, Lat/Lng, Check-in radius (meters), Active zone.');
bullet('Set office to my current location to capture the pin.');
bullet('UI radius typically 30–2000 m (default about 150 m). Server effective floor is about ≥ 150 m with an accuracy buffer.');

h1('13.2 Assign people');
bullet('Assign to employees and managers individually.');
bullet('Assign by manager (whole team) — Team zone; personal overrides can replace manager inheritance.');

h1('13.3 Live Tracking');
bullet('Shows today’s board for people on GPS attendance — not a continuous spy map.');
bullet('Stats: Employees · At site now · Away · Offline / no site · Managers on GPS.');
bullet('Filters: All / At site / Away / Offline / No site. Refresh about every 2 minutes.');
bullet('Badges: Clocked in · Clocked out · Last seen at site/away · No entry today · No work site · Tracking off.');

note('Location is stored as attendance for your company admins and managers — not sold, and never shown to other companies.');
drawFooter();
newPage();

// 14
title('14. Daily work reports');

h1('14.1 Employee / Manager');
bullet('Eyebrow: Daily work log.');
bullet('What did you accomplish today?');
bullet('Length: minimum 20 characters, maximum 8000.');
bullet('Submit today\'s report or Update report.');
bullet('Your recent reports lists past submissions.');

h1('14.2 Admin');
bullet('Daily work reports — Staff listed / Submitted / Not submitted.');
bullet('Filter by department and search. Role filter: Both / Managers only / Employees only.');
bullet('In-app alert: View daily reports when new submissions arrive.');
drawFooter();
newPage();

// 15
title('15. Analytics, exports & notifications');

h1('15.1 Analytics');
bullet('Admin: Individual Performance & Activity Analytics.');
bullet('Trends, attainment, and per-person KPI health for coaching and reviews.');

h1('15.2 Export');
bullet('Monthly report or Quarterly report.');
bullet('Formats: Excel · PDF · CSV.');

h1('15.3 In-app notifications');
bullet('Bell: Notifications (N unread) · Mark all as read.');
bullet('Types include KPI assigned/completed/overdue/updated/removed/approved/sent back, shift changes, gifts, and daily report alerts.');

h1('15.4 Email subjects you may receive');
bullet('New KPI assigned: … (does not start the task by itself)');
bullet('KPI completed / overdue / updated / removed / approved / sent back');
bullet('Active shift assigned/updated');
bullet('Your Scorr account login details (when an admin emails credentials)');
bullet('Password reset / MFA recovery messages');
drawFooter();
newPage();

// 16
title('16. Mobile apps (Android & iPhone)');
para('Install CTAs are hidden inside the already-installed native app. On the website:');

h1('16.1 Android');
step(1, 'Open https://scorr.walfia.ai on the phone (or use Download Android App on the homepage).');
step(2, 'Go to the Mobile App section.');
step(3, 'Tap Download Android App — this downloads scorr.apk (direct APK while Google Play listing is not live).');
step(4, 'Open Downloads → scorr.apk → allow install from this source if Android asks.');
step(5, 'Open Scorr → sign in → allow Location for attendance.');
bullet('Direct APK remains available until 1 November 2026; prefer the store once published.');
bullet('App ID: ai.walfia.scorr');

h1('16.2 iPhone / iPad (Home Screen app)');
para('Native App Store listing may not be live yet. Home Screen install works today in Safari:');
step(1, 'Open https://scorr.walfia.ai (or https://scorr.walfia.ai/?app=1) in Safari — not Chrome.');
step(2, 'Tap Share (square with arrow up).');
step(3, 'Scroll → Add to Home Screen → Add.');
step(4, 'Open the Scorr icon — Sign In / Register only.');
step(5, 'Sign in and allow Location for GPS attendance.');

h1('16.3 Same product on every device');
bullet('Same login, MFA, KPIs, weightage rewards, attendance, and reports.');
bullet('Hamburger navigation on mobile dashboards.');
drawFooter();
newPage();

// 17
title('17. Security, recovery & account deletion');

h1('17.1 How accounts stay safe');
bullet('Passwords are hashed by Supabase Auth — never stored readable.');
bullet('Failed logins are rate-limited (~15 minutes when locked).');
bullet('Idle sessions sign out after inactivity.');
bullet('Company signup requires email OTP.');
bullet('Privileged roles use TOTP MFA + backup codes + optional email recovery.');
bullet('Every record is tied to a company_id. Role checks decide who can read or write.');

h1('17.2 Device permissions');
tableHeader(['Permission', 'Why']);
tableRow('Internet', 'Sign-in, KPIs, attendance, mail.');
tableRow('Location (while using)', 'Clock in/out at the geofence.');
tableRow('Notifications', 'Optional shift / attendance reminders.');
tableRow('Camera', 'Not used by Scorr itself; authenticator apps may scan the MFA QR.');
spacer();
bullet('Scorr does not need contacts, photos, microphone, SMS, or call logs for core features.');

h1('17.3 Delete my account');
para('Public help page: https://scorr.walfia.ai/delete-account');
step(1, 'Sign in → Settings → Account security → Delete my account.');
step(2, 'Read the warnings. Type DELETE and enter your password.');
step(3, 'Confirm. Deletion is permanent.');
warn('Company owners: if other members remain, you must transfer ownership or confirm deleting the entire company (all employees and company data). If you are the only member, deleting your account also removes the empty company. Platform owner and demo accounts cannot self-delete here. Email info@walfia.ai for help (processed within 30 days).');
drawFooter();
newPage();

// 18
title('18. Plans, trial & demo sandbox');

h1('18.1 Pricing (landing)');
tableHeader(['Plan', 'What you get']);
tableRow('Starter', '3-Day Trial at $0, then about $12/user/mo · up to 25 employees.');
tableRow('Professional', 'About $18/user/mo · unlimited seats · shifts/GPS/emails/analytics · Most Popular.');
tableRow('Enterprise', 'Custom — SSO/HRIS, white-label, dedicated support · Contact Sales.');
spacer();
bullet('Trial: 3 days of full access after approval, no credit card.');
bullet('Security (MFA, backup codes, recovery, company isolation) is included — not an add-on.');

h1('18.2 Demo sandbox (?demo=1)');
para('Public demo is isolated and does not affect real companies. Banner: Demo sandbox mode.');
tableHeader(['Role', 'Login']);
tableRow('Admin', 'admin@walfia.ai / admin123 (persona Sarah Jenkins)');
tableRow('Manager', 'manager@walfia.ai / manager123 (persona Michael Scott)');
tableRow('Employee', 'employee@walfia.ai / employee123 (persona Jim Halpert)');
spacer();
bullet('MFA is skipped for demo. Demo expires after 3 days → Demo expired.');
bullet('Demo admin cannot provision real production users.');
drawFooter();
newPage();

// 19
title('19. Troubleshooting & support');
tableHeader(['Problem', 'What to try']);
tableRow('Cannot sign in', 'Check email/password. Wait for company approval after registration. Forgot password → Send password.');
tableRow('Stuck on MFA', 'Use backup code, email OTP recovery, or ask Admin → People → Reset authenticator.');
tableRow('Wrong dashboard', 'Ask Admin to check role on People.');
tableRow('Cannot add users', 'Must be Admin on a real company (not demo).');
tableRow('Department required', 'Create the department first, then assign Manager/Employee.');
tableRow('Cannot assign KPI', 'Pick department → person. That person’s open weightage cannot exceed 100%.');
tableRow('Cannot redeem gift', 'Need enough Current/Banked per on-screen rules; only one monthly gift path may apply.');
tableRow('GPS check-in fails', 'Enable precise location; confirm site assignment; be inside radius during shift window.');
tableRow('Still checked in after shift', 'Open Attendance or Live Tracking to reconcile; auto clock-out should stamp shift end.');
tableRow('Android APK won’t install', 'Allow install from browser/files; download again from Mobile App section.');
tableRow('iPhone install', 'Use Safari → Share → Add to Home Screen (not Chrome).');
tableRow('Delete account blocked', 'Owners with other members must wipe company or transfer ownership first.');
spacer();

h1('Need help?');
bullet('Website: https://scorr.walfia.ai');
bullet('Register: Home → Register Company');
bullet('Sign in: Home → Sign In');
bullet('Delete account help: https://scorr.walfia.ai/delete-account');
bullet('Android APK / iOS install: Home → Mobile App');
bullet('This guide: https://scorr.walfia.ai/downloads/Scorr-Client-Feature-Guide.pdf');
bullet('Support email: info@walfia.ai');
drawFooter();
newPage();

// 20
title('20. Quick reference numbers');
tableHeader(['Item', 'Value']);
tableRow('Company trial after approval', '3 days');
tableRow('Demo sandbox lifetime', '3 days');
tableRow('Password minimum', '6 characters');
tableRow('Email / MFA OTP', '6 digits');
tableRow('Backup codes', '10 single-use codes');
tableRow('Email recovery / OTP window', '20 minutes');
tableRow('Login rate-limit cool-down', 'About 15 minutes');
tableRow('Open KPI weightage pool', '≤ 100% per person');
tableRow('Per-task weight', '1–100%');
tableRow('Review award range', '0 … task weight');
tableRow('Score / gift ceiling', 'May exceed 100');
tableRow('Weightage reveal', 'Last calendar day of month');
tableRow('Banked weightage', 'Never expires');
tableRow('Shift edge / grace', '60 minutes before start / after end');
tableRow('Geofence default / floor', '~150 m (UI 30–2000)');
tableRow('Daily report length', '20–8000 characters');
tableRow('Live board refresh', '~2 minutes');
tableRow('Account deletion help SLA', 'Within 30 days via email');
tableRow('Direct APK until', '1 November 2026');
tableRow('App ID', 'ai.walfia.scorr');
spacer();

para('Thank you for using Scorr — performance KPIs, GPS attendance, and weightage-based rewards in one secure company workspace.');
para('© Walfia · https://scorr.walfia.ai · info@walfia.ai');

drawFooter();

const buf = Buffer.from(doc.output('arraybuffer'));
fs.mkdirSync(path.dirname(OUT_PUBLIC), { recursive: true });
fs.writeFileSync(OUT_PUBLIC, buf);

const sizeMb = (buf.length / 1024 / 1024).toFixed(2);
console.log('✅ Scorr Complete User Guide PDF generated');
console.log(`   → ${OUT_PUBLIC}`);
console.log(`   Size: ${sizeMb} MB · ${doc.getNumberOfPages()} pages`);
