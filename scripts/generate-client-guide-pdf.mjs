#!/usr/bin/env node
/**
 * Generates Scorr-Client-Feature-Guide.pdf — Scorr-only product guide.
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
const LINE = 5.4;
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
  doc.text('User Guide', M + 18, 9);
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
  doc.setFontSize(15);
  doc.setTextColor(15, 23, 42);
  doc.text(text, M, y);
  y += 8;
  doc.setDrawColor(13, 148, 136);
  doc.setLineWidth(0.6);
  doc.line(M, y, M + 36, y);
  y += 7;
}

function h1(text) {
  ensure(11);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(11.5);
  doc.setTextColor(13, 148, 136);
  doc.text(text, M, y);
  y += 7;
}

function h2(text) {
  ensure(9);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(10.5);
  doc.setTextColor(30, 41, 59);
  doc.text(text, M, y);
  y += 6;
}

function para(text) {
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(10);
  doc.setTextColor(51, 65, 85);
  for (const line of doc.splitTextToSize(text, MAX_W)) {
    ensure();
    doc.text(line, M, y);
    y += LINE;
  }
  y += 2;
}

function bullet(text) {
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(10);
  doc.setTextColor(51, 65, 85);
  for (const line of doc.splitTextToSize(`•  ${text}`, MAX_W - 2)) {
    ensure();
    doc.text(line, M + 1, y);
    y += LINE;
  }
}

function step(n, text) {
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(10);
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
  y += 1.5;
}

function note(text) {
  ensure(14);
  doc.setFillColor(240, 253, 250);
  doc.setDrawColor(13, 148, 136);
  doc.setLineWidth(0.4);
  const lines = doc.splitTextToSize(text, MAX_W - 8);
  const boxH = lines.length * LINE + 6;
  ensure(boxH + 2);
  doc.roundedRect(M, y - 3, MAX_W, boxH, 1.5, 1.5, 'FD');
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(9.5);
  doc.setTextColor(15, 118, 110);
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
  doc.setFontSize(10);
  doc.setTextColor(15, 23, 42);
  doc.text(name, M, y);
  y += 5.5;
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(9.5);
  doc.setTextColor(71, 85, 105);
  for (const line of doc.splitTextToSize(desc, MAX_W - 4)) {
    ensure();
    doc.text(line, M + 3, y);
    y += LINE;
  }
  y += 3;
}

function tableHeader(cols) {
  ensure(10);
  doc.setFillColor(241, 245, 249);
  doc.rect(M, y - 4, MAX_W, 7, 'F');
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(9);
  doc.setTextColor(30, 41, 59);
  doc.text(cols[0], M + 2, y);
  doc.text(cols[1], M + 48, y);
  y += 7;
}

function tableRow(label, value) {
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(9);
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
  y += 1;
}

function spacer(h = 4) {
  y += h;
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
doc.setFontSize(32);
doc.text('Scorr', M, 68);

doc.setTextColor(248, 250, 252);
doc.setFontSize(15);
doc.text('User Guide', M, 84);

doc.setFont('helvetica', 'normal');
doc.setFontSize(11.5);
doc.setTextColor(203, 213, 225);
[
  'Company workspace for KPIs, attendance, and rewards.',
  'Weightage (0–100%), company gifts, Banked leftovers,',
  'GPS attendance, and authenticator-secured sign-in.',
].forEach((line, i) => doc.text(line, M, 100 + i * 7));

doc.setFontSize(10);
doc.setTextColor(148, 163, 184);
doc.text('Live platform:  https://scorr.walfia.ai', M, 130);
doc.text(`Document date: ${generated}`, M, 138);
doc.text('Prepared by:    Walfia', M, 146);

doc.setFontSize(9);
doc.setTextColor(100, 116, 139);
doc.text('Registration · KPIs · Rewards · Attendance · Mobile · Security', M, H - 22);

newPage();

title('Table of Contents');
[
  ['1.', 'What is Scorr?'],
  ['2.', 'Register your organization'],
  ['3.', 'Roles'],
  ['4.', 'Administrator menu'],
  ['5.', 'Add people'],
  ['6.', 'First-time admin checklist'],
  ['7.', 'Manager menu'],
  ['8.', 'Employee menu'],
  ['9.', 'HR role'],
  ['10.', 'Departments & KPI weightage'],
  ['11.', 'Rewards (weightage, Banked, gifts)'],
  ['12.', 'Attendance, leave, shifts & GPS'],
  ['13.', 'Device permissions'],
  ['14.', 'Mobile apps'],
  ['15.', 'Security (MFA & recovery)'],
  ['16.', 'Troubleshooting'],
].forEach(([num, label]) => {
  ensure();
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(10);
  doc.setTextColor(51, 65, 85);
  doc.text(`${num}  ${label}`, M + 2, y);
  y += LINE + 1;
});
drawFooter();
newPage();

// 1
title('1. What is Scorr?');
para('Scorr (https://scorr.walfia.ai) is a company workspace for performance KPIs, GPS attendance, and company gifts. One login works on the website, Android app, and iPhone Home Screen app.');
para('Each registered company is a private tenant. Staff in Company A cannot open Company B’s people, KPIs, attendance, or GPS records.');
h2('What you run in one place');
bullet('KPI tasks with weightage (0–100% per person). Overall, Month, and Year views.');
bullet('Departments, people, roles, and reporting lines.');
bullet('GPS attendance (geofence), day and overnight shifts, leave, and live team location.');
bullet('Company rewards based on monthly weightage — not a separate points wallet.');
bullet('Daily work reports, analytics, and exports.');
bullet('Authenticator MFA, backup codes, and email OTP recovery.');
note('The person who registers the company becomes the first Administrator after the organization is approved.');
drawFooter();
newPage();

// 2
title('2. Register your organization');
para('Use Register Company on the public site. After approval you receive trial access with full product features.');

h1('2.1 Fill the form');
step(1, 'Open https://scorr.walfia.ai and choose Register Company.');
step(2, 'Enter company name, industry, and approximate headcount.');
step(3, 'Enter your name, work email, phone, and password (at least 6 characters).');
step(4, 'Choose a plan.');
step(5, 'Enter the one-time email code (OTP). Registration does not finish without it.');
step(6, 'Submit and wait for platform approval.');

h1('2.2 After approval');
bullet('Sign in with the same email and password.');
bullet('Scorr opens the Admin dashboard.');
bullet('Do not create the rest of the team until you can sign in as Admin.');

h1('2.3 First sign-in');
step(1, 'https://scorr.walfia.ai → Sign In.');
step(2, 'Accept the monitoring / data-use policy (required).');
step(3, 'Set up an authenticator app (Google Authenticator, Microsoft Authenticator, or Authy).');
step(4, 'Save backup codes offline — each code works once.');
step(5, 'Later logins: password + authenticator code (or one unused backup code).');
note('Lost authenticator and no backup codes? On the MFA screen use email OTP recovery, then re-enroll MFA. Admins can also reset authenticators from People.');
drawFooter();
newPage();

// 3
title('3. Roles');
para('Each person has one role. The role chooses the dashboard and what Scorr allows.');
tableHeader(['Role', 'Main purpose']);
tableRow('Admin', 'Whole company: people, departments, assign KPIs, rewards, attendance, GPS, live map, analytics, export, branding.');
tableRow('Manager', 'Team: assign tasks, team ranking, own KPIs, team attendance/leave, live tracking, approve/reject team gifts.');
tableRow('Employee', 'Own work: My KPIs, attendance/leave, redeem gifts, Account Security, daily report.');
tableRow('HR', 'Shifts and rewards support without full Admin powers.');
spacer();
bullet('Employees see only their own records.');
bullet('Managers see their team, not every department.');
bullet('Admins see only their organization.');
drawFooter();
newPage();

// 4
title('4. Administrator menu');
para('Sidebar order on the Admin dashboard (as shown in Scorr):');

featureBlock('People', 'Directory: add users, roles, department, reporting manager, reset password / authenticator, open a person’s tasks and scoreboard.');
featureBlock('Assign Task', 'Pick department → person → KPI, set weightage and dates, Assign. Completing a task notifies the reporting manager and the assigner.');
featureBlock('Daily Reports', 'Read staff daily work logs by department and role.');
featureBlock('Rewards', 'Company gifts catalog, redemption queue (approve / reject / fulfill), and gift history. Reject returns weightage.');
featureBlock('KPI & Rewards', 'People board with Earned / Current / Used / Banked weightage for the month. Open a person for the full scoreboard and tasks.');
featureBlock('Analytics', 'Company KPI health, trends, and per-person weightage.');
featureBlock('Attendance', 'Leave approvals and attendance history. Opening Attendance reconciles ended shifts.');
featureBlock('Office GPS', 'Office/site pin, radius, assign sites to staff.');
featureBlock('Live Tracking', 'Who is at site, away, or offline while checked in.');
featureBlock('Departments', 'Org structure only (Sales, Finance, …) — not a separate score engine.');
featureBlock('Export', 'Monthly or quarterly Excel, PDF, or CSV.');
featureBlock('Settings', 'Company name, logo, tagline, and colors.');
drawFooter();
newPage();

// 5
title('5. Add people');
para('Only an Administrator can create accounts. Sign in to your production company Admin dashboard (not the public demo).');

h1('5.1 Before you add people');
bullet('Create Departments first.');
bullet('Create Managers before Employees if you need reporting lines.');
bullet('Use each person’s work email — that becomes their login.');

h1('5.2 Fields');
tableHeader(['Field', 'What to enter']);
tableRow('Full name', 'Display name.');
tableRow('Email', 'Work email used to sign in.');
tableRow('Password', 'Temporary password (min 6 characters). Share it securely.');
tableRow('System role', 'Employee, Manager, Admin, or HR.');
tableRow('Department', 'Required for Manager and Employee.');
tableRow('Assign manager', 'Optional for Employee — pick a manager in the same department.');
spacer();

h1('5.3 After create');
bullet('They appear in People immediately.');
bullet('They enroll MFA, save backup codes, then open their dashboard.');
bullet('Use Reset password or Reset authenticator when someone is locked out.');
note('Demo admin cannot add real company users. Sign out and use your company Admin account.');
drawFooter();
newPage();

// 6
title('6. First-time admin checklist');
step(1, 'Sign in as Admin.');
step(2, 'Departments — create departments. Add KPI metrics on each board if needed (library totals may exceed 100%).');
step(3, 'People — add Managers, then Employees.');
step(4, 'Office GPS — add sites if you use GPS attendance.');
step(5, 'Settings — company name, logo, colors.');
step(6, 'Assign Task — department → person → KPI, weightage, dates.');
step(7, 'Rewards — review the catalog and gift rules.');
step(8, 'Ask every staff member to enroll MFA and allow location if you use GPS.');
drawFooter();
newPage();

// 7
title('7. Manager menu');
para('Managers work with their team and their own KPIs. There is no Branding tab.');
featureBlock('Assign Task', 'Assign KPIs in the manager’s department. Completions notify the assigner and reporting manager.');
featureBlock('Team / People', 'Team ranking. Open a person for a read-only scoreboard.');
featureBlock('My KPIs', 'Manager’s own tasks and weightage scoreboard.');
featureBlock('Attendance', 'Team leave, check-in, shifts, and live tracking.');
featureBlock('Rewards', 'Approve, reject, or mark delivered for team gift requests. Reject returns weightage. Personal redeem uses Current or Banked.');
featureBlock('Settings', 'Password, Account Security, daily work report.');
h1('Managers cannot');
bullet('Create company users, departments, or branding.');
bullet('See unrelated departments or other companies.');
drawFooter();
newPage();

// 8
title('8. Employee menu');
featureBlock('My KPIs', 'Weightage scoreboard: Total, Assigned, Earned, Current, Used, Banked (for the current month), Unassigned. Switch Overall / Month / Year. Mark Complete to notify manager and assigner.');
featureBlock('Attendance', 'GPS check-in/out, shift, leave requests, personal history. Shift end auto clock-out closes open visits.');
featureBlock('Rewards', 'Company gifts and catalog. Redeem with Current when this month qualifies, or Redeem with Banked when Banked covers the gift cost. Track request status (pending / approved / delivered / rejected).');
featureBlock('Settings', 'Password, Account Security, daily report.');
drawFooter();
newPage();

// 9
title('9. HR role');
para('HR supports shifts and rewards operations without full Admin powers (no People directory, no branding).');
drawFooter();
newPage();

// 10
title('10. Departments & KPI weightage');
para('Departments group people and managers. They are not a second scoring engine.');
bullet('Each employee/manager belongs to a department so Assign Task can list them.');
bullet('Pending/active KPI weight for one person cannot exceed 100%. Other people have their own 100% budgets.');
bullet('Department KPI libraries may list many metrics; assignment still respects the per-person 100% cap.');
bullet('Removing a department does not delete historical scores already saved on people.');

h1('10.1 Weightage on the scoreboard');
bullet('Earned — completed KPI weightage this month (0–100%).');
bullet('Current — remaining available this month after gift use / banking.');
bullet('Used — weightage spent on monthly gifts this month (cannot exceed Earned).');
bullet('Banked — leftover weightage saved across months after monthly gift redemptions.');
bullet('Overall / Month / Year filters are independent.');

h1('10.2 Assign & complete');
step(1, 'Admin or Manager opens Assign Task.');
step(2, 'Department → person → category / KPI → weightage → dates → Assign.');
step(3, 'Person marks Complete. Email + in-app alerts go to reporting manager and assigner.');
bullet('Performance labels: 95–100 Outstanding · 90–94 Excellent · 80–89 Good · 70–79 Needs Improvement · below 70 Unsatisfactory.');
drawFooter();
newPage();

// 11 — CURRENT REWARDS MODEL
title('11. Rewards (weightage, Banked, gifts)');
para('Scorr rewards use monthly weightage (0–100%), not a separate points balance that never expires. Gifts are arranged by managers or admins after someone redeems.');

h1('11.1 Balance terms');
tableHeader(['Term', 'Meaning']);
tableRow('Earned', 'This month’s completed KPI weightage.');
tableRow('Current', 'What is still available this month.');
tableRow('Used', 'Gift cost charged this month (never shown above Earned).');
tableRow('Banked', 'Leftovers after monthly gifts, summed across months.');
spacer();

h1('11.2 Monthly gifts (dinner or catalog)');
bullet('One monthly gift per person per month — either dinner voucher or one catalog item.');
bullet('Cost is the gift requirement only (for example dinner minimum %, or catalog weightage required) — not all of Current.');
bullet('This month’s Current must meet the gift requirement to redeem with Current.');
bullet('After paying, leftover Current moves into Banked.');
bullet('Reject (manager/admin) returns the spent weightage and undoes that redeem’s bank moves.');

h1('11.3 Redeem with Banked');
bullet('When Banked is high enough to cover a dinner or catalog cost, use Redeem with Banked.');
bullet('Banked pays the gift fully; this month’s Current is not required to be in-band for that path.');
bullet('Still one monthly gift per month.');
bullet('Streak gifts (movie / surprise) do not spend Current or Banked.');

h1('11.4 Streak gifts');
bullet('Movie tickets — keep earned weightage in the 90–95% band for 3 months in a row.');
bullet('Surprise gift — keep 90–95% for 6 months in a row.');
bullet('A streak gift can be redeemed in the same month as one monthly gift.');

h1('11.5 Approval flow');
step(1, 'Employee or manager redeems (Current or Banked).');
step(2, 'Manager or Admin approves, rejects, or marks delivered.');
step(3, 'Rejected requests refund weightage; the person can redeem again that month if rules allow.');
note('Catalog items show the weightage they require. Dinner uses your company’s configured minimum (typically 95%).');
drawFooter();
newPage();

// 12
title('12. Attendance, leave, shifts & GPS');

h1('12.1 Office GPS (Admin)');
step(1, 'Open Office GPS.');
step(2, 'Save a site: name, map pin, radius (about 50 metres).');
step(3, 'Assign the site to people.');
bullet('Times use Asia/Karachi.');

h1('12.2 Check-in');
bullet('Staff allow location. Inside the radius during the shift, Scorr can clock them in.');
bullet('Leaving the radius can clock them out.');
bullet('Android can keep sending pings while a session is open for the live map.');
bullet('Remote/hybrid modes can allow check-in without the office pin when enabled for that person.');
bullet('Multiple visits in one day are supported.');

h1('12.3 Overnight shifts & auto clock-out');
bullet('Shifts may cross midnight.');
bullet('When the shift ends, Scorr auto clock-out closes open visits.');
bullet('Opening Attendance or Live Tracking also reconciles ended shifts.');

h1('12.4 Leave & shifts');
bullet('Employee requests leave; Manager or Admin approves or rejects.');
bullet('Managers/HR/Admin set shift start/end and working days.');
drawFooter();
newPage();

// 13
title('13. Device permissions');
para('Scorr only asks for permissions the feature needs.');
tableHeader(['Permission', 'Why']);
tableRow('Internet', 'Sign-in, KPIs, attendance, server mail.');
tableRow('Location (precise)', 'Clock in/out at the geofence; live tracking while checked in.');
tableRow('Location (background)', 'Android: attendance pings if the app is in the background during a shift.');
tableRow('Foreground service', 'Android notification while attendance tracking is active.');
tableRow('Notifications', 'Optional shift/attendance reminders.');
tableRow('Camera', 'Not used by Scorr. Authenticator apps may use camera to scan the MFA QR.');
spacer();
bullet('Scorr does not need contacts, photos, microphone, SMS, or call logs.');
note('Location is stored as attendance for your company admins and managers — not sold, and not shown to other companies.');
drawFooter();
newPage();

// 14
title('14. Mobile apps');

h1('14.1 Android');
step(1, 'Open https://scorr.walfia.ai on the phone.');
step(2, 'Open the Mobile App / Download section.');
step(3, 'Download scorr.apk and allow install from this source if asked.');
step(4, 'Sign in with your Scorr email and password.');

h1('14.2 iPhone / iPad');
para('Install as a Home Screen app (Safari):');
step(1, 'Open https://scorr.walfia.ai in Safari.');
step(2, 'Share → Add to Home Screen.');
step(3, 'Open the Scorr icon and sign in.');
bullet('Enable Location when prompted for GPS attendance.');
drawFooter();
newPage();

// 15
title('15. Security (MFA & recovery)');
para('The browser and Android app use a public key plus your personal login. Privileged actions run as checked server functions.');

h1('15.1 Accounts');
bullet('Passwords are hashed by Supabase Auth — never stored readable.');
bullet('Failed logins are rate-limited.');
bullet('Idle sessions sign out after inactivity.');
bullet('Company signup requires email OTP.');
bullet('Admins, managers, HR, and employees enroll TOTP authenticator MFA.');
bullet('Save one-time backup codes. Each works once.');
bullet('Lost authenticator: email OTP on the MFA screen, then re-enroll — or ask Admin → People → Reset authenticator.');
bullet('Settings → Account Security: regenerate backup codes and review recovery.');

h1('15.2 Isolation');
bullet('Every record is tied to a company. Role checks decide who can read or write.');
bullet('Employees cannot create users or change branding.');
bullet('Managers cannot assign KPIs outside their allowed team.');
bullet('GPS pings are written as the signed-in user only.');
drawFooter();
newPage();

// 16
title('16. Troubleshooting');
tableHeader(['Problem', 'What to try']);
tableRow('Cannot sign in', 'Registered email + wrong password → “Incorrect password.” Unknown email → “Incorrect email and password.” Wait until the company is approved after registration.');
tableRow('Wrong dashboard', 'Ask Admin to check role on People.');
tableRow('Cannot add users', 'Must be Admin. Demo admin cannot add real users.');
tableRow('Department required', 'Create the department first, then assign Manager/Employee.');
tableRow('Authenticator lost', 'MFA screen → email OTP → re-enroll, or Admin reset authenticator.');
tableRow('Used looks higher than Earned', 'Used is gift cost this month and is capped at Earned. Refresh; only one monthly gift should apply.');
tableRow('Cannot redeem gift', 'Need Current in range for Redeem, or enough Banked for Redeem with Banked. Only one monthly gift per month.');
tableRow('Still working after shift', 'Open Attendance or Live Tracking to reconcile. Auto clock-out should close visits at shift end.');
tableRow('GPS check-in fails', 'Enable location; confirm site assignment; be inside radius during the shift.');
tableRow('Cannot assign KPIs', 'Pick department first, then person. That person’s pending weightage cannot exceed 100%.');
spacer();

h1('Need help?');
para('Website: https://scorr.walfia.ai');
bullet('Register: Home → Register Company');
bullet('Sign in: Home → Sign In');
bullet('Android APK: Home → Mobile App');
bullet('This guide: https://scorr.walfia.ai/downloads/Scorr-Client-Feature-Guide.pdf');
spacer();
para('Thank you for using Scorr — KPIs, attendance, and weightage-based rewards in one company workspace.');

drawFooter();

const buf = Buffer.from(doc.output('arraybuffer'));
fs.mkdirSync(path.dirname(OUT_PUBLIC), { recursive: true });
fs.writeFileSync(OUT_PUBLIC, buf);

const sizeMb = (buf.length / 1024 / 1024).toFixed(2);
console.log('✅ Scorr User Guide PDF generated');
console.log(`   → ${OUT_PUBLIC}`);
console.log(`   Size: ${sizeMb} MB · ${doc.getNumberOfPages()} pages`);
