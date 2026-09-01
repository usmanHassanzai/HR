#!/usr/bin/env node
/**
 * Generates Scorr-Client-Feature-Guide.pdf — full product, tabs, KPI,
 * attendance, device permissions, and security explanation.
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
  doc.text('Project Guideline', M + 18, 9);
  doc.text('scorr.walfia.ai', W - M, 9, { align: 'right' });
}

function drawFooter() {
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(8);
  doc.setTextColor(148, 163, 184);
  doc.text(`Page ${pageNum}`, W / 2, FOOTER_Y, { align: 'center' });
  doc.text('© Walfia · Project Guideline', M, FOOTER_Y);
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
doc.text('Complete Project Guideline', M, 84);

doc.setFont('helvetica', 'normal');
doc.setFontSize(11.5);
doc.setTextColor(203, 213, 225);
const coverBlurb = [
  'How Scorr works — company registration, every role and tab,',
  'KPI scoring, attendance & GPS, device permissions, and how',
  'your data is protected.',
];
coverBlurb.forEach((line, i) => doc.text(line, M, 100 + i * 7));

doc.setFontSize(10);
doc.setTextColor(148, 163, 184);
doc.text('Live platform:  https://scorr.walfia.ai', M, 130);
doc.text(`Document date: ${generated}`, M, 138);
doc.text('Prepared by:    Walfia', M, 146);

doc.setFontSize(9);
doc.setTextColor(100, 116, 139);
doc.text('Registration · Tabs · KPIs · Attendance · Security · Devices', M, H - 22);

newPage();

title('Table of Contents');
const toc = [
  ['1.', 'What is Scorr?'],
  ['2.', 'How to Register Your Organization'],
  ['3.', 'User Roles at a Glance'],
  ['4.', 'Administrator tabs (complete)'],
  ['5.', 'How to Add People'],
  ['6.', 'First-Time Admin Setup'],
  ['7.', 'Manager tabs (complete)'],
  ['8.', 'Employee tabs (complete)'],
  ['9.', 'HR role'],
  ['10.', 'Departments'],
  ['11.', 'KPI tasks and scoring'],
  ['12.', 'Attendance, leave and GPS'],
  ['13.', 'What the app needs from the device'],
  ['14.', 'Rewards and reports'],
  ['15.', 'Mobile apps'],
  ['16.', 'Security — how Scorr protects data'],
  ['17.', 'What “secure” means (honest guarantee)'],
  ['18.', 'How the platform is built'],
  ['19.', 'Troubleshooting'],
];
toc.forEach(([num, label]) => {
  ensure();
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(10);
  doc.setTextColor(51, 65, 85);
  doc.text(`${num}  ${label}`, M + 2, y);
  y += LINE + 1;
});
drawFooter();
newPage();

// ═══════════════════════════════════════════════════════════════
// 1
// ═══════════════════════════════════════════════════════════════
title('1. What is Scorr?');
para('Scorr (scorr.walfia.ai) is a company workspace for performance, attendance, and rewards. One login serves the website, Android app, and iPhone home-screen app.');
para('Each registered company is a private tenant. Staff in Company A cannot open Company B’s people, KPIs, attendance, or GPS records.');
h2('What you can run in one place');
bullet('KPI tasks in four categories, with manager ratings and an automatic monthly score.');
bullet('Departments, people, roles, and reporting lines.');
bullet('GPS attendance (geofence), shifts, leave, and live team location for authorized managers/admins.');
bullet('Rewards points from KPI score, catalog redemption, and approvals.');
bullet('Daily work reports, analytics, and PDF/Excel/CSV exports.');
note('The person who registers the company becomes the first Administrator after Walfia approves the organization.');
drawFooter();
newPage();

title('2. How to Register Your Organization');
para('Use the public Register Company form. No credit card is required. After approval you receive a 3-day trial with full product access.');

h1('2.1 Fill the form');
step(1, 'Open https://scorr.walfia.ai and choose Register Company.');
step(2, 'Enter company name, industry, and approximate headcount.');
step(3, 'Enter your name, work email, phone, and a password (at least 6 characters, confirmed).');
step(4, 'Choose a plan (Trial / Starter / Professional / Enterprise).');
step(5, 'Scorr emails a one-time code (OTP) to that work email. Enter the code to prove you own the mailbox. Registration does not complete without this step.');
step(6, 'Submit. You will see that the company is waiting for platform approval.');

h1('2.2 After you submit');
bullet('The organization is stored as pending.');
bullet('Walfia (platform owner) is notified by email and in the Companies console.');
bullet('When approved, sign in with the same email and password.');
bullet('Scorr opens the Admin dashboard. A short onboarding wizard can help you add people, a default shift, and first KPI categories.');
note('Do not create the rest of your team until the company is approved and you can sign in as Admin.');

h1('2.3 First sign-in');
step(1, 'https://scorr.walfia.ai → Sign In.');
step(2, 'Accept the monitoring and data-use policy (attendance location at clock-in/out and KPI records). Sign-in is blocked until this is checked.');
step(3, 'Admins, managers, and HR must then set up an authenticator app (Google Authenticator, Microsoft Authenticator, or Authy) and enter a 6-digit code. Demo sandbox accounts skip this.');
drawFooter();
newPage();

// ═══════════════════════════════════════════════════════════════
// 3 ROLES
// ═══════════════════════════════════════════════════════════════
title('3. User Roles at a Glance');
para('Each person has one role. The role chooses the dashboard and what the database will allow.');
tableHeader(['Role', 'Main purpose']);
tableRow('Admin', 'Whole company: people, departments, assign KPIs, points board, rewards catalog, attendance, GPS sites, live map, reports, analytics, branding in Settings.');
tableRow('Manager', 'Team only: assign tasks, team ranking, own KPIs, team attendance/leave, live tracking of reports, team rewards, password and daily report in Settings.');
tableRow('Employee', 'Own work: My KPIs, attendance/leave/shift, rewards, password and daily report in Settings. No branding tab.');
tableRow('HR', 'Company shifts and rewards support. Does not replace Admin for users or branding.');
spacer();
h1('Access rules');
bullet('Employees see only their own KPIs, attendance, points, and reports.');
bullet('Managers see direct reports (and department team where designed), not every company.');
bullet('Admins see the organization they belong to, not other companies.');
bullet('Platform owner (Walfia) approves companies; it is not a second copy of your staff files for daily HR work.');
drawFooter();
newPage();

title('4. Administrator tabs (complete)');
para('Sidebar groups: Organization, Performance, Workforce. Branding is not its own tab — it lives under Settings.');

h1('4.1 Organization');
featureBlock('People', 'Company directory. Add users, set role (employee/manager/admin/HR), department, reporting manager, reset password, reset authenticator, edit account, remove user, open that person’s assigned tasks.');
featureBlock('Departments', 'Create/rename/remove departments (Sales, Finance, …). This is structure only — not a KPI score library.');
featureBlock('KPI Points', 'Organization scores and points for individuals this period.');

h1('4.2 Performance');
featureBlock('Assign Task', 'Create a KPI in a category, set weight and dates, pick department then person, optional note, Assign. Then review assigned tasks and rate them. Sequential dropdowns: department → person → KPI.');
featureBlock('Analytics', 'Company KPI health, trends, and attainment.');
featureBlock('Reports', 'Monthly or quarterly export as Excel, PDF, or CSV.');
featureBlock('Rewards', 'Monthly points job, catalog, approve and fulfill redemptions.');

h1('4.3 Workforce');
featureBlock('Attendance', 'Leave approvals, attendance history, check-in oversight for the company.');
featureBlock('Daily Reports', 'Read submitted daily work logs by department and role.');
featureBlock('Live Tracking', 'Map and table of who is at site, away, or offline (from GPS pings while checked in).');
featureBlock('Office GPS', 'Office/site pin, radius (typically 50 m), assign sites to staff.');
featureBlock('Settings', 'White-label branding: company name, logo, tagline, colors. Managers and employees cannot open this.');
drawFooter();
newPage();

// ═══════════════════════════════════════════════════════════════
// 5 ADD USERS
// ═══════════════════════════════════════════════════════════════
title('5. How to Add Employees, Managers & Admins');
para('Only an Administrator can create new accounts. You must already be signed in to your company’s Admin dashboard (not the demo sandbox).');

h1('5.1 Before you add people');
bullet('Create Departments first (Admin → Departments). Managers and employees need a department.');
bullet('Create Managers before Employees if you want to assign a reporting manager.');
bullet('Have each person’s work email ready — that email becomes their login.');

h1('5.2 Open the Add User form');
step(1, 'Sign in as Admin at https://scorr.walfia.ai');
step(2, 'Open the People tab (default home of Admin).');
step(3, 'On the right (or below on mobile), find the panel “Add new user”.');

h1('5.3 Fields you fill in');
tableHeader(['Field', 'What to enter']);
tableRow('Full name', 'Person’s display name (e.g. Sara Khan).');
tableRow('Email', 'Work email they will use to sign in.');
tableRow('Password', 'Temporary password (min 6 characters). Share it securely; they can change it later.');
tableRow('System role', 'Choose Employee, Manager, or Admin.');
tableRow('Department', 'Required for Manager and Employee. Not required for Admin.');
tableRow('Assign manager', 'Only for Employee. Optional — pick a manager in the same department.');
spacer();

h1('5.4 How to add an Employee');
step(1, 'Set System role to Employee.');
step(2, 'Select their Department.');
step(3, 'Optionally select Assign manager (managers in that department appear in the list).');
step(4, 'Enter name, email, password → click Register user.');
step(5, 'Tell the employee their email and temporary password so they can sign in.');

h1('5.5 How to add a Manager');
step(1, 'Set System role to Manager.');
step(2, 'Select Assign department to manager (required).');
step(3, 'Enter name, email, password → Register user.');
step(4, 'Later, when adding employees in that department, select this manager as their reporting manager.');

h1('5.6 How to add another Admin');
step(1, 'Set System role to Admin.');
step(2, 'Department is not required for admins.');
step(3, 'Enter name, email, password → Register user.');
step(4, 'The new admin can sign in and manage the full organization.');

note('Demo accounts: If you are signed in as the public demo admin, you cannot add real company users. Sign out and use your production company admin account instead.');

h1('5.7 After a user is created');
bullet('They appear immediately in the Users directory.');
bullet('They sign in at scorr.walfia.ai with the email/password you set.');
bullet('Scorr opens the correct dashboard based on role (Admin / Manager / Employee).');
bullet('You can change an employee/manager’s department from the Users table.');
bullet('Use Reset password on a user card if they forget their password.');
drawFooter();
newPage();

// ═══════════════════════════════════════════════════════════════
// 6 CHECKLIST
// ═══════════════════════════════════════════════════════════════
title('6. First-Time Admin Setup Checklist');
para('After your company is approved, complete these steps in order for a smooth launch:');
step(1, 'Sign in as Admin.');
step(2, 'Departments — create your departments. Add KPI metrics on each board (library totals may exceed 100%).');
step(3, 'Users — add Managers for each department.');
step(4, 'Users — add Employees and assign each to a department and manager.');
step(5, 'Office GPS — add your office locations if you use GPS attendance.');
step(6, 'Settings — set company name, logo, and colors (branding).');
step(7, 'Assign Task — department → person → KPI category, weight, dates.');
step(8, 'Rewards — review the catalog.');
step(9, 'Ask staff to install an authenticator (admins/managers/HR) and allow location on the phone if you use GPS attendance.');
drawFooter();
newPage();

// ═══════════════════════════════════════════════════════════════
// 7 MANAGER
// ═══════════════════════════════════════════════════════════════
title('7. Manager tabs (complete)');
para('Managers do not see the whole company. They work with people who report to them, plus their own KPIs. There is no Branding tab.');
featureBlock('Assign Task', 'Create a KPI (category, name, weight, dates, optional note) and assign it to someone in the manager’s department. Tasks and Points panes: assigned work vs team scores.');
featureBlock('Team', 'Ranking of direct reports by this month’s KPI achievement. Tap a person to open a read-only view of their My KPIs.');
featureBlock('My KPIs', 'Tasks assigned to the manager. This month score, rating (Outstanding … Unsatisfactory), and points per task after the admin/supervisor rates them.');
featureBlock('Attendance', 'Team leave, check-in, shifts, and a Live tracking section for the team map.');
featureBlock('Rewards', 'Approve team redemptions and see team point balances. Personal points are not shown here.');
featureBlock('Settings', 'Change password and submit the manager’s daily work report. No logo/theme editor.');
h1('Managers cannot');
bullet('Create company users, departments, or branding.');
bullet('See other companies or unrelated departments’ staff.');
drawFooter();
newPage();

title('8. Employee tabs (complete)');
para('Employees only see their own records. There is no Branding tab and no Assign Task.');
featureBlock('My KPIs', 'This month score (achievement of assigned weight), performance rating, done count, and one card per task: category, weight, dates, points after manager rating, Started/Completed on Monthly Goal and Urgent Tasks.');
featureBlock('Attendance', 'GPS check-in/out, assigned shift, leave requests, personal history.');
featureBlock('Rewards', 'Balance, catalog, redeem, pending/approved/fulfilled.');
featureBlock('Settings', 'Change password and daily report.');
drawFooter();
newPage();

title('9. HR role');
para('HR is a dedicated role for shift assignment and rewards operations without full Admin powers (no People directory, no branding, no company-wide KPI assign unless also given those tools). HR uses Shifts and Rewards screens.');
drawFooter();
newPage();

title('10. Departments');
para('Departments are folders for people (and which manager owns which team). They are not a second scoring engine.');
bullet('Admin creates names such as Sales or Operations.');
bullet('Each employee/manager should belong to a department so Assign Task can list them.');
bullet('KPI weight cap is per person (pending assignments ≤ 100%), not per department total.');
bullet('Removing a department does not delete historical KPI scores already saved on people.');
drawFooter();
newPage();

// ═══════════════════════════════════════════════════════════════
// 9 DAILY REPORTS
// ═══════════════════════════════════════════════════════════════
title('11. KPI tasks and scoring');
para('A KPI is one assigned task with a weight (%). The manager or admin rates it. The employee does not type the score.');

h1('11.1 Four categories');
bullet('Monthly Goal — employee can mark Started / Completed. Manager rates Achieved / Partially Achieved / Not Achieved.');
bullet('Quality — manager rates Good / Average / Poor.');
bullet('Punctuality & Behaviour — Always on Time / Behaves Well / Always Late / Behaves Not Good.');
bullet('Urgent Tasks — employee can mark progress. Manager rates On Time / Late.');

h1('11.2 Assign process');
step(1, 'Admin or Manager opens Assign Task.');
step(2, 'Choose department, then the person in that department.');
step(3, 'Choose category and KPI, set weight (1–100%), start and end dates, optional note.');
step(4, 'Assign. The person is notified. Pending weights for that one person cannot exceed 100%.');
bullet('Other people have their own 100% budgets.');

h1('11.3 Points on one task');
para('Points = weight × multiplier from the rating:');
bullet('100% of weight: Achieved, Always on Time, Good, On Time.');
bullet('50% of weight: Partially Achieved, Average, Behaves Well.');
bullet('0% of weight: Not Achieved, Always Late, Behaves Not Good, Poor, Late.');
para('Example: weight 15%, Achieved → 15.00 points. Partially Achieved → 7.50. Not Achieved → 0.');

h1('11.4 This month score and Rating');
para('This month % = (sum of points) ÷ (sum of assigned weights) × 100. One 15% task rated Achieved is 100%, not 15%. Unrated tasks count as 0 points but still sit in the weight, so the score stays honest until they are rated.');
bullet('95–100 Outstanding · 90–94 Excellent · 80–89 Good · 70–79 Needs Improvement · below 70 Unsatisfactory.');
bullet('Started/Completed by the employee does not award points by itself — the manager rating does.');
drawFooter();
newPage();

// ═══════════════════════════════════════════════════════════════
// 11 ATTENDANCE
// ═══════════════════════════════════════════════════════════════
title('12. Attendance, leave and GPS');

h1('12.1 Office GPS (Admin)');
step(1, 'Open Office GPS.');
step(2, 'Save a site: name, map pin, radius (about 50 metres).');
step(3, 'Assign the site to people (everyone or selected staff).');
bullet('Times use Asia/Karachi.');

h1('12.2 How check-in works');
bullet('Staff allow location. When they are inside the radius during the assigned shift, Scorr can clock them in.');
bullet('Leaving the radius can clock them out. Checkout is GPS-based, not a fake button from another city.');
bullet('On Android, a background location service can keep sending pings while a session is open so the live map stays current.');
bullet('Remote/hybrid work modes can allow check-in without the office pin when the company enables that for the person.');
bullet('If the shift ends, the system can auto check-out.');

h1('12.3 Leave');
bullet('Employee requests type (including Other) and dates.');
bullet('Manager (team) or Admin approves or rejects. Emails go out on status change.');

h1('12.4 Shifts');
bullet('Managers/HR/Admin set start/end and working days. Employees see My Shift on Attendance.');
bullet('Entry/exit can store the location used at clock events.');
drawFooter();
newPage();

title('13. What the app needs from the device');
para('Scorr only asks for permissions that the feature needs. You can refuse; GPS attendance will not work without location.');
tableHeader(['Permission', 'Why']);
tableRow('Internet', 'Sign-in, load KPIs, save attendance, send mail via the server.');
tableRow('Location (precise)', 'Clock in/out at the office geofence; live tracking while checked in.');
tableRow('Location (background)', 'Android: continue attendance pings if you leave the app during a shift. iOS asks for Always if you use automatic attendance.');
tableRow('Foreground service', 'Android notification while attendance tracking is active — required by the OS, not ads.');
tableRow('Notifications', 'Optional: shift/attendance reminders on Android 13+.');
tableRow('Camera', 'Not used by Scorr itself. Authenticator apps use the camera only to scan the MFA QR on another screen.');
spacer();
h1('What we do not need');
bullet('Contacts, photos, microphone, SMS, or call logs.');
bullet('Root/jailbreak. Do not install Scorr on a compromised phone.');
note('Location is stored as attendance pings and check-in/out coordinates for your company administrators and managers — not sold, and not shown to other companies.');
drawFooter();
newPage();

// ═══════════════════════════════════════════════════════════════
// 12 REWARDS
// ═══════════════════════════════════════════════════════════════
title('14. Rewards and reports');
para('Points never expire. After the monthly job, score bands become points:');
tableHeader(['Monthly KPI score', 'Points']);
tableRow('90% or higher', '1,000 points');
tableRow('80% – 89%', '500 points');
tableRow('70% – 79%', '250 points');
tableRow('Below 70%', '0 points');
spacer();

h1('Redemption flow');
step(1, 'Admin maintains the catalog (name, cost in points, description).');
step(2, 'Employee redeems an item.');
step(3, 'Manager or Admin approves.');
step(4, 'Item is marked fulfilled when delivered.');
drawFooter();
newPage();

// ═══════════════════════════════════════════════════════════════
// 13 REPORTS
// ═══════════════════════════════════════════════════════════════
h1('14.1 Reports');
bullet('Admin Reports — monthly/quarterly Excel, PDF, CSV.');
bullet('Admin Analytics — charts and attainment.');
bullet('Personal export — My KPIs PDF/Excel.');
bullet('Admin Daily Reports — text logs from Settings on staff dashboards.');
drawFooter();
newPage();

title('15. Mobile apps');

h1('15.1 Android');
step(1, 'Open https://scorr.walfia.ai on the phone.');
step(2, 'Go to the Mobile App / Download section.');
step(3, 'Download scorr.apk and allow install from this source if asked.');
step(4, 'Open the app and sign in with your Scorr email and password.');

h1('15.2 iPhone / iPad');
para('A native App Store IPA is not required for daily use. Install as a Home Screen app:');
step(1, 'Open Safari and go to https://scorr.walfia.ai');
step(2, 'Tap the Share button.');
step(3, 'Tap Add to Home Screen.');
step(4, 'Open the Scorr icon and sign in.');
bullet('Enable Location when prompted so GPS attendance works.');
drawFooter();
newPage();

// ═══════════════════════════════════════════════════════════════
// 15 SECURITY
// ═══════════════════════════════════════════════════════════════
title('16. Security — how Scorr protects data');
para('Scorr is built so ordinary users never hold database master keys. The browser and the Android app only use a public “anon” key plus your personal login token. Privileged actions run on the server as checked functions.');

h1('16.1 Transport and hosting');
bullet('https://scorr.walfia.ai uses TLS (HTTPS) on Vercel. The API is https://*.supabase.co with TLS.');
bullet('Data at rest is stored in Supabase/PostgreSQL on AWS (Asia), with platform disk encryption.');
bullet('Email is sent from noreply@scorr.walfia.ai through Resend; templates are server-side.');

h1('16.2 Accounts');
bullet('Passwords are stored by Supabase Auth (hashed). Scorr never stores a readable password.');
bullet('Too many failed logins on an email are rate-limited (about 15 minutes).');
bullet('Forgot password does not tell attackers whether an email exists. Reset is time-limited.');
bullet('Company signup requires an email OTP before the account is created.');
bullet('Idle sessions sign out after 20 minutes of no activity.');
bullet('Admins, managers, and HR must enroll TOTP (authenticator). AAL2 is required for sensitive admin actions such as resetting someone else’s authenticator.');
bullet('If an authenticator is lost, a company admin (who already passed MFA) can reset factors so old 6-digit codes stop working. The person scans a new QR. Phone authenticator apps do not allow Scorr to delete the old icon on the phone — the user should remove the old Scorr entry themselves.');

h1('16.3 Isolation and permissions');
bullet('Every business record is tied to a company. Row Level Security and role checks (employee / manager / admin / HR / platform owner) decide who can read or write.');
bullet('Employees cannot call admin user-create or branding save.');
bullet('Managers cannot assign KPIs outside the allowed department/team.');
bullet('GPS pings are written as the signed-in user, not as an arbitrary other employee id from the phone.');

h1('16.4 Policy and audit');
bullet('Sign-in records that the user accepted location/KPI monitoring.');
bullet('Admins can reset passwords and authenticators with an audit trail in notifications/email.');
bullet('Deleting a company (platform owner) removes that tenant’s workspace.');
drawFooter();
newPage();

title('17. What “secure” means (honest guarantee)');
para('No cloud HR product can truthfully promise that it is “totally secure forever.” Attackers, stolen phones, and weak passwords exist in every industry. What Scorr does guarantee as a product design is the following:');
bullet('Your company data is not mixed into another company’s screens.');
bullet('Traffic to Scorr and the database is encrypted in transit (HTTPS).');
bullet('Staff passwords are not stored in plain text.');
bullet('Privileged roles need an authenticator, not password alone.');
bullet('Location is used for attendance you enabled, not for silent advertising.');
para('Your side of the guarantee: unique passwords, do not share authenticator screenshots, keep phones updated, only install the APK from scorr.walfia.ai, and ask Admin to reset MFA if a device is lost.');
para('Walfia’s side: keep hosting on reputable providers (Vercel, Supabase/AWS), restrict service keys to the server, and keep improving database rules. Independent penetration tests and certifications (SOC 2 / ISO 27001) are a separate commercial engagement — they are not claimed as already issued in this guide.');
note('If you need a formal DPA, data-residency letter, or pentest report for procurement, contact Walfia (info@walfia.ai) so the legal pack matches your contract — this PDF is an operational guide, not a legal warranty.');
drawFooter();
newPage();

title('18. How the platform is built');
para('Scorr is the live product at https://scorr.walfia.ai.');
bullet('Website: React application on Vercel.');
bullet('Login and data: Supabase Auth + PostgreSQL.');
bullet('Mail: Resend.');
tableHeader(['Item', 'Value']);
tableRow('App', 'https://scorr.walfia.ai');
tableRow('This PDF', 'https://scorr.walfia.ai/downloads/Scorr-Client-Feature-Guide.pdf');
tableRow('Hosting', 'Vercel (HTTPS)');
drawFooter();
newPage();

title('19. Troubleshooting');

tableHeader(['Problem', 'What to try']);
tableRow('Cannot sign in', 'If the email is registered: you will see “Incorrect password.” If the email is unknown: “Incorrect email and password.” After company registration, wait until the company is approved.');
tableRow('Wrong dashboard opens', 'Your role is set incorrectly. Ask Admin to check role on Users tab.');
tableRow('Cannot add users', 'You must be Admin (not Manager/Employee). Demo admin cannot add real users.');
tableRow('Manager list empty', 'Create Manager accounts first, in the same department as the employee.');
tableRow('Department required error', 'Managers and employees need a department. Create one under Departments.');
tableRow('Authenticator lost', 'Admin → People → ⋮ → Reset authenticator. Then sign in and scan the new QR. Delete the old Scorr row in Google Authenticator yourself.');
tableRow('GPS check-in fails', 'Enable location (and background on Android); confirm Office GPS site is assigned.');
tableRow('No daily reports visible', 'Only Admin sees others’ reports. Staff must submit from Daily Report tab.');
tableRow('Cannot assign KPIs', 'Admin: select department first, then a person in that department, then KPI(s), then dates. The person list is empty until a department is chosen. That person’s pending weight cannot exceed 100%.');
tableRow('Assignment rejected at 110%', 'That employee already has too much pending weight. Pick a smaller KPI or complete/remove an existing assignment. Other employees are not counted.');
tableRow('Assigned 10% became 100%', 'This is fixed: assigned weight stays as set (1–100%). Refresh the site after the latest update.');
spacer();

h1('Need help?');
para('Website: https://scorr.walfia.ai');
bullet('Register: Home page → Register Company');
bullet('Sign in: Home page → Sign In');
bullet('Download apps: Home page → Mobile App section');
bullet('This guide: /downloads/Scorr-Client-Feature-Guide.pdf');
spacer();
para('Thank you for using Scorr. With clear roles, simple registration, and one place to add your team, your organization can run performance, attendance, and rewards together.');

drawFooter();

// ═══════════════════════════════════════════════════════════════
// WRITE
// ═══════════════════════════════════════════════════════════════
const buf = Buffer.from(doc.output('arraybuffer'));
fs.mkdirSync(path.dirname(OUT_PUBLIC), { recursive: true });
fs.writeFileSync(OUT_PUBLIC, buf);

const sizeMb = (buf.length / 1024 / 1024).toFixed(2);
console.log('✅ Scorr Project Guideline PDF generated');
console.log(`   → ${OUT_PUBLIC}`);
console.log(`   Size: ${sizeMb} MB · ${doc.getNumberOfPages()} pages`);
