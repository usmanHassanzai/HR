#!/usr/bin/env node
/**
 * Generates Scorr-Client-Feature-Guide.pdf — clear user guide for
 * organization registration, roles (admin / manager / employee),
 * and how to add users.
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
  'How Scorr works for your organization — registration,',
  'roles, users, KPIs, assignment, attendance, GPS,',
  'rewards, reports, and mobile — in one document.',
];
coverBlurb.forEach((line, i) => doc.text(line, M, 100 + i * 7));

doc.setFontSize(10);
doc.setTextColor(148, 163, 184);
doc.text('Live platform:  https://scorr.walfia.ai', M, 130);
doc.text(`Document date: ${generated}`, M, 138);
doc.text('Prepared by:    Walfia', M, 146);

doc.setFontSize(9);
doc.setTextColor(100, 116, 139);
doc.text('Registration · Roles · KPIs · Assignment · Attendance · Rewards', M, H - 22);

newPage();

// ═══════════════════════════════════════════════════════════════
// TOC
// ═══════════════════════════════════════════════════════════════
title('Table of Contents');
const toc = [
  ['1.', 'What is Scorr?'],
  ['2.', 'How to Register Your Organization'],
  ['3.', 'User Roles at a Glance'],
  ['4.', 'Administrator — What They Do'],
  ['5.', 'How to Add Employees, Managers & Admins'],
  ['6.', 'First-Time Admin Setup Checklist'],
  ['7.', 'Manager — What They Do'],
  ['8.', 'Employee — What They Do'],
  ['9.', 'Daily Work Reports'],
  ['10.', 'KPI Library, Assignment & Scoring'],
  ['11.', 'Attendance, Leave & GPS'],
  ['12.', 'Rewards & Points'],
  ['13.', 'Reports & Analytics'],
  ['14.', 'Mobile Apps (Android & iPhone)'],
  ['15.', 'Sign In, Passwords & Security'],
  ['16.', 'How the Platform Is Built (Overview)'],
  ['17.', 'Quick Troubleshooting'],
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
para('Scorr is an HR performance platform for companies. It brings KPIs, attendance, GPS check-in, leave, rewards, daily work reports, and management reports into one secure place.');
para('Each company gets its own private workspace. Your data is never shared with other organizations.');
spacer();
h2('Three types of users');
bullet('Administrator — runs the whole company account (users, departments, settings, reports).');
bullet('Manager — leads a department/team (assign KPIs, approve leave, track the team).');
bullet('Employee — does daily work (complete KPIs, check in, request leave, submit daily reports, redeem rewards).');
spacer();
note('Tip: The person who registers the company becomes the first Administrator after approval.');
drawFooter();
newPage();

// ═══════════════════════════════════════════════════════════════
// 2 REGISTER
// ═══════════════════════════════════════════════════════════════
title('2. How to Register Your Organization');
para('Anyone starting a new company on Scorr uses the public registration form. No credit card is required. New companies receive a 3-day free trial after approval.');

h1('2.1 Step-by-step registration');
step(1, 'Open https://scorr.walfia.ai in a browser.');
step(2, 'Click “Register Company” (top navigation or hero button).');
step(3, 'Fill in organization details:');
bullet('Company name (required)');
bullet('Industry and approximate employee count (recommended)');
bullet('Website, address, city, country (optional)');
step(4, 'Fill in your contact details as the company admin:');
bullet('Full name and job title');
bullet('Work email and phone (required)');
bullet('Password (minimum 6 characters) and confirm password');
step(5, 'Choose a subscription plan (Trial / Starter / Professional / Enterprise). Trial starts with full platform access for 3 days after approval.');
step(6, 'Submit the form.');
step(7, 'You will see: “Please wait for admin approval.”');

h1('2.2 What happens after you submit');
bullet('Your organization is created as a pending registration.');
bullet('The Scorr platform admin receives an email and in-app notification.');
bullet('Review usually completes within about 24 hours.');
bullet('When approved, sign in with the same email and password you registered.');
bullet('You land in the Administrator dashboard and can set up departments and users.');

note('Important: Do not create employee accounts until your company registration is approved and you can sign in as Admin.');

h1('2.3 After approval — first sign-in');
step(1, 'Go to https://scorr.walfia.ai and open Sign In.');
step(2, 'Enter your registered email and password.');
step(3, 'Scorr opens the Admin dashboard automatically because your role is Admin.');
drawFooter();
newPage();

// ═══════════════════════════════════════════════════════════════
// 3 ROLES
// ═══════════════════════════════════════════════════════════════
title('3. User Roles at a Glance');
para('Every person in your company has exactly one role. The role decides which screens they see and what they can change.');

tableHeader(['Role', 'Main purpose']);
tableRow('Admin', 'Full company control: add users, departments, branding, KPIs org-wide, attendance oversight, GPS sites, rewards catalog, analytics, daily reports review.');
tableRow('Manager', 'Lead their department/team: assign KPIs to direct reports, approve leave/attendance, team rewards, shifts, live tracking of their team, personal KPIs, daily report.');
tableRow('Employee', 'Personal work: view/complete KPIs, GPS check-in, leave requests, points & rewards, submit daily work report.');
spacer();

h1('Access rules (simple)');
bullet('Employees see only their own data.');
bullet('Managers see only their assigned team (direct reports), not the whole company.');
bullet('Admins see the entire organization.');
bullet('These rules are enforced by secure login and database permissions.');
drawFooter();
newPage();

// ═══════════════════════════════════════════════════════════════
// 4 ADMIN WORK
// ═══════════════════════════════════════════════════════════════
title('4. Administrator — What They Do');
para('The Admin dashboard is organized in a sidebar: Organization, Performance, and Workforce. Below is what each area is for in plain language.');

h1('4.1 Organization');
featureBlock('Users', 'Directory of everyone in the company. Search and filter by role or department. Add new people, change department, reset passwords, or remove accounts. This is where you create Employees, Managers, and additional Admins.');
featureBlock('Departments', 'Build your company structure (e.g. Sales, HR, Finance). Organization-level department weightages are separate from KPI libraries. On each department you can add as many KPI metrics as you need. The combined KPI library weight can exceed 100% — that list is a catalog, not an employee’s capacity.');
featureBlock('Branding', 'Put your company name, logo, tagline, and colors on the platform so it looks like your product.');

h1('4.2 Performance');
featureBlock('KPI Management', 'Create and edit the KPI library for each department: name, description, and weight (1–100% per KPI). Add as many KPIs as you need. Finance can be 30+30+20+20+40 = 140% and still save. The 100% rule is not applied here.');
featureBlock('Assign Task (KPIs)', 'Assign KPIs to people in a department. Order is: (1) select department, (2) select an employee or manager who belongs to that department, (3) select KPI task(s), (4) set start and end dates, then Assign. Each person has an independent 100% pending-assignment cap. Ahmed 40% + Ali 70% + Sara 10% is valid because they are different people.');
featureBlock('Reports', 'Download monthly or quarterly company reports as PDF, Excel, or CSV.');
featureBlock('Analytics', 'Charts for KPI health, trends, forecasts, and attainment by department or category.');
featureBlock('Rewards', 'Run the monthly points job, approve/fulfill redemptions, and manage the rewards catalog (gift items employees can redeem).');

h1('4.3 Workforce');
featureBlock('Attendance', 'Approve leave org-wide and review attendance history (filter by department, export CSV).');
featureBlock('Daily Reports', 'Read daily work logs submitted by managers and employees, filtered by department and role.');
featureBlock('Office GPS', 'Define office/site locations with a map radius so staff can auto check in when they arrive.');
featureBlock('Live Tracking', 'See who is at site, away, or offline on a live map and table.');
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
step(2, 'Open the Users tab (default home screen of Admin).');
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
step(6, 'Branding — set company name, logo, and colors.');
step(7, 'KPI Management — confirm department KPI libraries, then Assign Task — department first, then a person in that department, then KPIs and dates.');
step(8, 'Rewards — review or edit the rewards catalog.');
step(9, 'Ask managers and employees to sign in and enable location on mobile if needed.');
drawFooter();
newPage();

// ═══════════════════════════════════════════════════════════════
// 7 MANAGER
// ═══════════════════════════════════════════════════════════════
title('7. Manager — What They Do');
para('Managers focus on their team. They do not see the whole company — only people assigned to them as direct reports, plus their own personal KPIs.');

h1('7.1 Daily / weekly work');
featureBlock('Team Performance', 'See team points, leaderboard, and who is on track / at risk / off track. Open any team member’s performance view (read-only).');
featureBlock('KPI Tasks', 'Create KPIs for your department (any number; library total can exceed 100%). Then assign those KPIs only to your direct reports. A 10% or 70% KPI keeps that weight. Pending assignments for one person cannot exceed 100%. Re-assigning replaces pending tasks for that department only.');
featureBlock('Team Rewards', 'Approve redemption requests and mark rewards as fulfilled when delivered.');
featureBlock('Attendance & Leave', 'Approve or reject leave and attendance corrections. Create shifts and assign them. View today\'s team attendance and history.');
featureBlock('Live Tracking', 'Map/table of where the team is (at site / away / offline).');
featureBlock('Daily Report', 'Write and submit the manager’s own daily work log for the admin to review.');
featureBlock('My KPIs / Personal', 'Managers also complete their own KPI tasks and can export personal reports.');

h1('7.2 What managers cannot do');
bullet('Cannot register new company users (Admin only).');
bullet('Cannot change company branding or create departments.');
bullet('Cannot see other departments’ staff unless those people report to them.');
drawFooter();
newPage();

// ═══════════════════════════════════════════════════════════════
// 8 EMPLOYEE
// ═══════════════════════════════════════════════════════════════
title('8. Employee — What They Do');
para('Employees use a simpler dashboard focused on their own work.');

h1('8.1 My KPIs');
bullet('See Performance Index (health score) — Excellent / Needs Improvement / Critical.');
bullet('Each assigned KPI is a card: name, weight, achievement %, score (achievement × weight), dates, and status (On Track / At Risk / Off Track).');
bullet('Example: 80% achieved on a 40% weight KPI = 32 points. Unused assignment capacity is not filled in automatically.');
bullet('You only see your own assignments — never another employee’s KPIs.');
bullet('Mark a task complete when finished — the manager is notified.');
bullet('Export personal KPI report as PDF or Excel.');

h1('8.2 Attendance & leave');
bullet('GPS check-in / check-out when at an assigned office site (location permission required).');
bullet('Request leave (type + dates) and track approval status.');
bullet('View personal attendance history and assigned shift.');

h1('8.3 Rewards');
bullet('See points balance and how monthly KPI score converts to points.');
bullet('Browse the catalog and redeem rewards.');
bullet('Track redemption status (pending → approved → fulfilled).');

h1('8.4 Daily Report');
bullet('Write what you did today in the Daily Report tab.');
bullet('Submit for the day — Admin can read it later in Daily Reports.');
bullet('You can view your own past submissions.');
drawFooter();
newPage();

// ═══════════════════════════════════════════════════════════════
// 9 DAILY REPORTS
// ═══════════════════════════════════════════════════════════════
title('9. Daily Work Reports');
para('Employees and managers submit a short text log of work done each day. Only Administrators review these reports.');

h1('9.1 For staff (Employee / Manager)');
step(1, 'Open the Daily Report tab on your dashboard.');
step(2, 'Select the date (usually today) and write your work summary.');
step(3, 'Click Submit. The report is saved in the company database.');

h1('9.2 For Admin');
step(1, 'Open Workforce → Daily Reports.');
step(2, 'Choose a department from the dropdown (or All departments).');
step(3, 'Filter by Managers & Employees / Managers only / Employees only.');
step(4, 'Pick a person to read their report. People who have not submitted show as “Not submitted”.');
drawFooter();
newPage();

// ═══════════════════════════════════════════════════════════════
// 10 KPI
// ═══════════════════════════════════════════════════════════════
title('10. KPI Library, Assignment & Scoring');
para('KPIs (Key Performance Indicators) are measurable goals. A department KPI is a reusable item in a library. An assignment connects that KPI to one employee with the same weight, dates, and later achievement.');

h1('10.1 Department KPI library (no 100% cap)');
bullet('Admin → Performance → KPI Management, or Departments, or Manager → Create KPIs.');
bullet('Add as many KPIs as you need. Each KPI has its own weight (1–100%). A 70% KPI stays 70%.');
bullet('The combined library weight for a department can exceed 100% (for example 30+30+20+20+40+70+10 = 220%). That is allowed.');
bullet('The department is a catalog. It is not an employee’s 100% assignment capacity.');
note('Do not treat “Finance library = 100%” as a limit. You can still add another KPI after 30+30+20+20.');

h1('10.2 Employee assignment (100% cap per person)');
bullet('The 100% rule applies only to one employee’s active/pending assignments.');
bullet('Current assigned weight + new KPI weight ≤ 100% is allowed. Exactly 100% is allowed. 101%+ for that same person is rejected.');
bullet('Different employees are independent. Ahmed 40% + Ali 70% + Sara 10% = 120% company-wide is valid.');
bullet('Selecting several KPIs for one person: their weights are added together before save.');
note('Example: Ahmed has 70%. A 20% KPI is allowed (90%). A 40% KPI is rejected (110%). Remaining capacity was 30%.');

h1('10.3 Assign as Admin (required order)');
step(1, 'Sign in as Admin → Performance → Assign Task → New assignment.');
step(2, 'Select the department first.');
step(3, 'The list then shows only employees and managers who belong to that department. Pick one person.');
step(4, 'Select one or more KPI tasks from that department’s library. Each keeps its configured weight.');
step(5, 'Set start and end dates (they default to the current month).');
step(6, 'Click Assign. The person is emailed. Tasks appear on their My KPIs board immediately.');
bullet('Assigning a KPI does not move the person to another department.');
bullet('Re-assigning the same department replaces their pending tasks for that department only. Completed history is kept.');

h1('10.4 Assign as a Manager');
step(1, 'Open KPI Tasks → Assign Tasks.');
step(2, 'Pick a direct report (managers cannot assign outside their team).');
step(3, 'Select KPIs from your department library, set dates, and assign.');
bullet('The same per-employee 100% cap applies.');

h1('10.5 How scores work');
bullet('KPI contribution = achievement % × KPI weight. Example: 80% × 40% weight = 32 points.');
bullet('Employee total score = sum of contributions. Unused remaining capacity is not redistributed.');
bullet('Status: On Track, At Risk, Off Track, or Completed.');
bullet('Overdue tasks send notifications and email. Missing 3 deadlines can apply a −300 point penalty.');
drawFooter();
newPage();

// ═══════════════════════════════════════════════════════════════
// 11 ATTENDANCE
// ═══════════════════════════════════════════════════════════════
title('11. Attendance, Leave & GPS');

h1('11.1 Office GPS (Admin setup)');
step(1, 'Admin → Office GPS.');
step(2, 'Add a site: name, address, coordinates (map or live GPS), and radius (typically 50 m).');
step(3, 'Assign the site to people so they can auto check in when they enter the zone.');
bullet('Assign to everyone, or assign to selected employees/managers individually.');
bullet('Shift times use Pakistan time (Asia/Karachi).');

h1('11.2 Check-in for staff');
bullet('Allow location permission in the browser or mobile app.');
bullet('When inside the geofence, the system can clock them in automatically.');
bullet('Leaving the zone can clock them out.');

h1('11.3 Leave');
bullet('Employee submits leave with type and date range.');
bullet('Manager (for their team) or Admin approves/rejects.');
bullet('Balances are tracked; email alerts are sent on status changes.');

h1('11.4 Shifts (Manager)');
bullet('Create shifts with start/end time and grace period (overnight supported).');
bullet('Assign shifts to team members; employees see “My Shift”.');
drawFooter();
newPage();

// ═══════════════════════════════════════════════════════════════
// 12 REWARDS
// ═══════════════════════════════════════════════════════════════
title('12. Rewards & Points');
para('Points never expire. At month end, Admin runs the monthly points job based on KPI score tiers:');

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
title('13. Reports & Analytics');
bullet('Admin Reports — monthly/quarterly exports (PDF, Excel, CSV) with KPI snapshots and insights.');
bullet('Admin Analytics — status charts, trends, forecasts, attainment by department.');
bullet('Personal export — employees and managers download their own KPI PDF/Excel.');
bullet('AI narratives — optional commentary on KPI performance to help reviews.');
drawFooter();
newPage();

// ═══════════════════════════════════════════════════════════════
// 14 MOBILE
// ═══════════════════════════════════════════════════════════════
title('14. Mobile Apps (Android & iPhone)');

h1('14.1 Android');
step(1, 'Open https://scorr.walfia.ai on the phone.');
step(2, 'Go to the Mobile App / Download section.');
step(3, 'Download scorr.apk and allow install from this source if asked.');
step(4, 'Open the app and sign in with your Scorr email and password.');

h1('14.2 iPhone / iPad');
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
title('15. Sign In, Passwords & Security');
bullet('Everyone signs in at https://scorr.walfia.ai with email + password.');
bullet('If the email exists but the password is wrong, Scorr shows “Incorrect password.”');
bullet('If the email is not registered, Scorr shows “Incorrect email and password.”');
bullet('Role decides which dashboard opens.');
bullet('Users can change their own password from profile settings.');
bullet('Admins can reset any user’s password from the Users directory.');
bullet('Each company’s data is isolated — no cross-company access.');
bullet('Platform owner (Walfia) approves new company registrations in a separate Companies portal.');
drawFooter();
newPage();

// ═══════════════════════════════════════════════════════════════
// 16 PLATFORM
// ═══════════════════════════════════════════════════════════════
title('16. How the Platform Is Built (Overview)');
para('Scorr is the live product at https://scorr.walfia.ai. This section is for stakeholders who want a simple picture of how the system is put together.');

h1('16.1 What you use every day');
bullet('Website: React app hosted on Vercel (project “hr”).');
bullet('Login and data: Supabase (secure accounts + company database).');
bullet('Email alerts: Resend, from noreply@scorr.walfia.ai (KPI assigned, completed, overdue).');
bullet('Each company is a private workspace. Other companies cannot see your data.');

h1('16.2 Core work flow');
para('Admin or Manager assigns KPI tasks → Employee completes them before the deadline → Monthly score becomes points → Employee redeems rewards → Manager or Admin approves.');

h1('16.3 Live URL & domain');
tableHeader(['Item', 'Value']);
tableRow('App', 'https://scorr.walfia.ai');
tableRow('Brand domain', 'walfia.ai');
tableRow('Hosting', 'Vercel (automatic HTTPS)');
spacer();

h1('16.4 Mobile');
bullet('Android: download Scorr APK from the website Download section.');
bullet('iPhone: Safari → Share → Add to Home Screen (recommended).');
bullet('Same login as the website. GPS attendance needs Location permission.');
drawFooter();
newPage();

// ═══════════════════════════════════════════════════════════════
// 17 TROUBLESHOOT
// ═══════════════════════════════════════════════════════════════
title('17. Quick Troubleshooting');

tableHeader(['Problem', 'What to try']);
tableRow('Cannot sign in', 'If the email is registered: you will see “Incorrect password.” If the email is unknown: “Incorrect email and password.” After company registration, wait until the company is approved.');
tableRow('Wrong dashboard opens', 'Your role is set incorrectly. Ask Admin to check role on Users tab.');
tableRow('Cannot add users', 'You must be Admin (not Manager/Employee). Demo admin cannot add real users.');
tableRow('Manager list empty', 'Create Manager accounts first, in the same department as the employee.');
tableRow('Department required error', 'Managers and employees need a department. Create one under Departments.');
tableRow('Cannot add another department KPI', 'This is allowed. Library totals may exceed 100%. Use Add KPI, give it a name and weight (1–100%), then wait for autosave.');
tableRow('GPS check-in fails', 'Enable location permission; confirm Admin assigned an Office GPS site.');
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
