#!/usr/bin/env node
/**
 * Generates Scorr-Client-Feature-Guide.pdf — complete product guide.
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
  'Download & install · Register your organization · Sign up',
  'Admin, HR, Manager & Employee dashboards',
  'Mark attendance · Assign tasks · Daily reports · Rewards',
].forEach((line, i) => doc.text(line, M, 96 + i * 7));

doc.setFontSize(10);
doc.setTextColor(148, 163, 184);
doc.text('Live platform:   https://scorr.walfia.ai', M, 128);
doc.text(`Document date:  ${generated}`, M, 136);
doc.text('Prepared by:     Walfia', M, 144);
doc.text('Support:         info@walfia.ai', M, 152);

doc.setFontSize(9);
doc.setTextColor(100, 116, 139);
doc.text('Android APK · iPhone Home Screen · Web · Same login everywhere', M, H - 22);

newPage();

// TOC
title('Table of Contents');
[
  ['1.', 'What is Scorr?'],
  ['2.', 'How to download the app'],
  ['3.', 'How to install (Android & iPhone)'],
  ['4.', 'How to register an organization'],
  ['5.', 'How to sign in & set up security (MFA)'],
  ['6.', 'Roles at a glance'],
  ['7.', 'Admin dashboard — how to use it'],
  ['8.', 'HR dashboard — how to use it'],
  ['9.', 'Manager dashboard — how to use it'],
  ['10.', 'Employee dashboard — how to use it'],
  ['11.', 'How to mark attendance'],
  ['12.', 'How to assign tasks (Admin & Manager)'],
  ['13.', 'KPI completion & review'],
  ['14.', 'Rewards & gifts'],
  ['15.', 'Daily work reports'],
  ['16.', 'Office GPS & live tracking'],
  ['17.', 'Analytics, exports & notifications'],
  ['18.', 'Security & account deletion'],
  ['19.', 'Plans, trial & demo'],
  ['20.', 'Troubleshooting & support'],
  ['21.', 'Quick reference'],
].forEach(([num, label]) => tocItem(num, label));
drawFooter();
newPage();

// 1
title('1. What is Scorr?');
para('Scorr (https://scorr.walfia.ai) is your company workspace for performance KPIs, GPS attendance, leave, daily work reports, and weightage-based rewards. One account works on the website, the Android app, and the iPhone Home Screen app.');
para('Each registered company is private. Staff in one organization cannot see another company’s people, tasks, attendance, or reports.');

h2('What you can do');
bullet('Register your organization and invite Admin, HR, Managers, and Employees.');
bullet('Assign KPI tasks with weightage (0–100% per person) and review completions.');
bullet('Mark attendance with GPS, remote/hybrid modes, shifts, and leave.');
bullet('Submit daily work reports (employees, managers, and HR report to admin).');
bullet('Redeem company gifts with monthly weightage (Current / Used / Banked).');
bullet('Track field teams live and export monthly/quarterly reports.');

note('Timezone for shifts and month-end weightage: Asia/Karachi. Branding can be customized by Admin under Settings.');
drawFooter();
newPage();

// 2
title('2. How to download the app');
para('Open the website on your phone or computer: https://scorr.walfia.ai. Scroll to the Mobile App section, or jump to https://scorr.walfia.ai/#download-app.');

h1('2.1 Android');
bullet('On the homepage, find Download Scorr for Android & iOS.');
bullet('Tap Download Android App — this downloads the file scorr.apk (latest version).');
bullet('You can also open: https://scorr.walfia.ai/downloads/scorr.apk');
bullet('App ID: ai.walfia.scorr · Version is shown on the download card (e.g. 1.3.4).');
bullet('Direct APK download remains available until 1 November 2026 (until Google Play is live).');

h1('2.2 iPhone / iPad');
bullet('There is no separate APK for iPhone. Install from Safari as a Home Screen app.');
bullet('Open https://scorr.walfia.ai/?app=1 in Safari (see Section 3 for install steps).');
bullet('When the App Store listing is live, the site will show Get it on the App Store.');

h1('2.3 This PDF guide');
bullet('Download anytime: https://scorr.walfia.ai/downloads/Scorr-Client-Feature-Guide.pdf');
bullet('Or run locally: npm run docs:client-guide');

note('Inside the already-installed Android/iOS app, store/download buttons are hidden — you already have Scorr installed.');
drawFooter();
newPage();

// 3
title('3. How to install (Android & iPhone)');

h1('3.1 Install on Android');
step(1, 'Tap Download Android App on https://scorr.walfia.ai/#download-app.');
step(2, 'Open your phone’s Downloads folder (or the notification) and tap scorr.apk.');
step(3, 'If Android asks “Install unknown apps?” or “Allow from this source?”, allow it for your browser or Files app.');
step(4, 'Tap Install → Open.');
step(5, 'Sign in with your company email and password.');
step(6, 'When prompted, allow Location (while using the app) so GPS attendance can work.');
bullet('If install is blocked: Settings → Apps → Special access → Install unknown apps → enable for Chrome/Files.');
bullet('If an older Scorr is installed, update by installing the new APK over it (same app ID).');

h1('3.2 Install on iPhone / iPad (Safari)');
warn('Use Safari only — Chrome or other browsers cannot Add to Home Screen the same way.');
step(1, 'Open https://scorr.walfia.ai/?app=1 in Safari.');
step(2, 'Tap the Share button (square with an arrow pointing up).');
step(3, 'Scroll the share sheet and tap Add to Home Screen.');
step(4, 'Confirm the name Scorr → tap Add.');
step(5, 'Open the new Scorr icon on your Home Screen → Sign In.');
step(6, 'Allow Location when you use GPS attendance.');

h1('3.3 Website (desktop or mobile browser)');
bullet('You can use Scorr fully in the browser at https://scorr.walfia.ai without installing.');
bullet('Sign In with the same email and password as the apps.');

h1('3.4 After install — first open');
bullet('Sign in → accept the monitoring / location policy if shown.');
bullet('Enroll authenticator MFA and save backup codes (Section 5).');
bullet('Your role (Admin, HR, Manager, or Employee) opens the matching dashboard.');
drawFooter();
newPage();

// 4
title('4. How to register an organization');
para('Company registration creates your private Scorr tenant. The first person who registers becomes the company Administrator. A 3-day free trial starts when Walfia approves the company — not when you submit the form. No credit card is required.');

h1('4.1 Register Company');
step(1, 'Open https://scorr.walfia.ai and choose Register Company — Free for 3 Days (or the Sign In page → Register Company tab).');
step(2, 'Account step: Company name, your full name, admin email, phone, password (minimum 6 characters), confirm password → Continue.');
step(3, 'Company step: Optional industry and headcount band → Create account.');
step(4, 'Enter the 6-digit email verification code → Verify and continue. Use Resend code if needed.');
step(5, 'You will see Awaiting admin approval. You cannot open the dashboard until approved.');

h1('4.2 What happens next');
bullet('Walfia (info@walfia.ai) is notified.');
bullet('Platform owner opens /platform → Pending → Approve (or Reject).');
bullet('On Approve, a 3-day Professional-level trial starts.');
bullet('You become the first Administrator and company owner.');

h1('4.3 After approval — first login');
step(1, 'Sign in with the same email and password.');
step(2, 'Accept the policy checkbox if prompted.');
step(3, 'Enroll MFA and download your backup codes.');
step(4, 'You land in the Admin console — add departments, people, offices, shifts, and tasks.');

warn('If status is Rejected, registration was not approved. If Trial ended or Account paused, contact info@walfia.ai.');
drawFooter();
newPage();

// 5
title('5. How to sign in & set up security (MFA)');

h1('5.1 Sign In');
bullet('Website or app → Sign In.');
bullet('Enter Email Address and Password. Accept the policy checkbox when shown.');
bullet('Forgot password? Enter your registered email → Send password. Scorr emails a temporary password (rate-limited; wait about 15 minutes if blocked).');

h1('5.2 Authenticator MFA (required)');
para('After password, Scorr opens Authenticator required. Use Google Authenticator or Microsoft Authenticator.');
step(1, 'Scan the QR code (or type the Manual key).');
step(2, 'Enter your account password and the 6-digit authenticator code → Verify and continue.');
step(3, 'Save 10 one-time backup codes (XXXX-XXXX). Download or copy them and store offline.');
step(4, 'Later logins: password + authenticator code, or one unused backup code.');

h1('5.3 Lost phone / authenticator');
bullet('On the MFA screen: Send verification code to your login email → Verify → re-enroll.');
bullet('Or ask your Admin → People → Reset authenticator.');
bullet('Settings → Account security: regenerate backup codes, set a recovery email.');

note('Demo sandbox accounts skip MFA. Real Admin, HR, Manager, and Employee accounts must enroll.');
drawFooter();
newPage();

// 6
title('6. Roles at a glance');
para('Each person has one role. The role chooses the dashboard. Header badges show: Admin · HR · Manager · Employee.');

tableHeader(['Role', 'Main purpose']);
tableRow('Admin', 'Full company setup: people, departments, assign tasks, rewards, attendance, Office GPS, live tracking, analytics, export, branding. Reviews manager/HR leave and daily reports.');
tableRow('HR', 'HR console: My day attendance, organization attendance/shifts, daily report to admin, review staff reports, rewards, people ops. Must report to a company admin.');
tableRow('Manager', 'Team KPIs, assign tasks, leave approvals, My day attendance, team attendance, rewards approvals, own daily report.');
tableRow('Employee', 'Own KPIs, GPS/remote attendance, leave requests, daily report, redeem gifts.');
spacer();

h2('Rules when adding people');
bullet('Employees and managers need a department.');
bullet('HR must report to a company admin (Reports to is required).');
bullet('Work location: Office (GPS) · Remote (supervisor marks) · Hybrid.');
bullet('People only see their own company — never other tenants.');
drawFooter();
newPage();

// 7
title('7. Admin dashboard — how to use it');
para('Eyebrow: Admin console. After sign-in you see the sidebar menu. Use it to run the whole organization.');

h1('7.1 Sidebar menus');
featureBlock('People', 'Add teammates. Set role, department, job title, Reports to, work location. Email login details, reset password or authenticator, open a person’s hub (KPIs, attendance, rewards, reports).');
featureBlock('Assign Task', 'Create KPI templates and assign tasks with weightage and dates. Review completions: Approve & award or Send back.');
featureBlock('Daily Reports', 'See every manager and employee daily report by date and department. Filter All roles / Managers / Employees / HR. Stats show submitted vs missing.');
featureBlock('Rewards', 'KPI awards, History, People, Redemptions, Catalog. Approve, Delivered, or Reject gift requests.');
featureBlock('KPI & Rewards', 'Company weightage board: Earned, Current, Used, Banked per person.');
featureBlock('Analytics', 'Individual performance trends and attainment.');
featureBlock('Attendance', 'Leave approvals, Remote/hybrid marking, Shifts, History (by department). HR appears under Human Resources.');
featureBlock('Office GPS', 'Create geofence zones, assign to people/teams, manage offices.');
featureBlock('Live Tracking', 'Today’s field board: At site / Away / Offline.');
featureBlock('Departments', 'Org structure (Sales, Marketing, …).');
featureBlock('Export', 'Monthly or quarterly Excel / PDF / CSV.');
featureBlock('Settings', 'Branding (name, logo, colors) + Account security + Delete my account.');

h1('7.2 First-week checklist');
step(1, 'Settings — company name, logo, colors.');
step(2, 'Departments — create departments.');
step(3, 'People — add Managers, Employees, and HR. Set Reports to and Work location.');
step(4, 'Office GPS — create zones and assign staff who use GPS.');
step(5, 'Attendance → Shifts — create shifts and assign people.');
step(6, 'Assign Task — create templates, assign first KPIs.');
step(7, 'Ask everyone to install the app, enroll MFA, and allow Location.');

h1('7.3 What only Admin does');
bullet('Approve manager and HR leave requests.');
bullet('Receive notifications when HR or managers submit daily reports.');
bullet('Approve new company branding and full org settings.');
drawFooter();
newPage();

// 8
title('8. HR dashboard — how to use it');
para('Eyebrow: HR console / HR workspace. HR has company-wide tools and also reports personally to a company admin — like a staff member with attendance and a daily report.');

h1('8.1 Sidebar (same family as Admin)');
bullet('People, Assign Task, Daily Reports, Rewards, KPI & Rewards, Analytics, Attendance, Office GPS, Live Tracking, Departments, Export, Settings.');
bullet('Focus areas for HR day-to-day: Attendance, Daily Reports, People, Rewards, Shifts.');

h1('8.2 Attendance (HR)');
featureBlock('My day', 'Your own shift card, GPS clock in/out (or remote/hybrid), leave request to admin, and your leave history.');
featureBlock('Leave', 'Review pending leave from employees (admin still approves manager/HR leave).');
featureBlock('Remote', 'Mark remote/hybrid staff Present or Absent.');
featureBlock('History', 'Browse by department. HR staff appear under Human Resources (not “Unassigned”).');
featureBlock('Shifts', 'Create/edit/assign company shifts; assigned people get emails.');

h1('8.3 Daily Reports (HR)');
featureBlock('My report', 'Write and submit your daily work log. Only company admins are notified and can read it.');
featureBlock('Organization', 'Review manager and employee daily reports by date and department — professional tabbed workspace.');

h1('8.4 HR reporting line');
bullet('When Admin creates HR: Role = HR (reports to admin), Reports to (admin) is required.');
bullet('HR leave and HR daily reports go to Admin for review.');
bullet('Set Work location so HR can use Office GPS, Remote, or Hybrid attendance.');

note('HR keeps existing company tools (history, shifts, rewards) and gains My day attendance + My report like employees/managers.');
drawFooter();
newPage();

// 9
title('9. Manager dashboard — how to use it');
para('Eyebrow: Manager console. Managers lead a department team and also complete their own KPIs and attendance.');

h1('9.1 Menus');
featureBlock('My KPIs', 'Your own assigned tasks and weightage scoreboard.');
featureBlock('Assign Task', 'Create/assign KPIs to people in your department. Review team completions.');
featureBlock('People', 'Team ranking; open a person for scoreboard details.');
featureBlock('Attendance', 'Approvals (leave) · My day (your check-in) · Team · Shifts · History.');
featureBlock('Rewards', 'Approve / Delivered / Reject team gift requests. Redeem your own gifts.');
featureBlock('Daily report', 'Submit your daily work log for admin review.');
featureBlock('Settings', 'Password, Account security, Delete my account.');

h1('9.2 Typical daily flow');
step(1, 'Open Attendance → My day → Clock in (GPS) when you arrive.');
step(2, 'Work your My KPIs; Mark Complete when done.');
step(3, 'Assign Task — give new work to the team with weightage and due dates.');
step(4, 'Approvals — approve or reject employee leave.');
step(5, 'Rewards — arrange pending gift requests.');
step(6, 'Daily report — write what you accomplished today.');
step(7, 'Clock out when you leave (mid-shift checkout is allowed if needed).');

h2('Managers cannot');
bullet('Create company users, departments, or branding.');
bullet('See other companies or unrelated departments.');
drawFooter();
newPage();

// 10
title('10. Employee dashboard — how to use it');
para('Eyebrow: Employee. You only see your own work, attendance, and rewards.');

h1('10.1 Menus');
featureBlock('My KPIs', 'Open and History. Scoreboard shows Left to use, Earned, Used, Banked. Open a task to start it, then Mark Complete.');
featureBlock('Attendance', 'Mark attendance (GPS), Request leave, Attendance history. Download your month/year CSV.');
featureBlock('Rewards', 'Redeem company gifts / catalog with weightage. Track Pending · Approved · Delivered · Rejected.');
featureBlock('Daily report', 'What did you accomplish today? (20–8000 characters). Submit or Update.');
featureBlock('Settings', 'Change password, backup codes, recovery email, Delete my account.');

h1('10.2 Typical daily flow');
step(1, 'Sign in on web or app → allow Location if you use Office GPS.');
step(2, 'Attendance → Mark attendance → Clock in inside your office zone during your shift.');
step(3, 'My KPIs → open tasks, complete work, Mark Complete.');
step(4, 'Daily report → write today’s summary → Submit.');
step(5, 'Clock out when leaving. Request leave from Attendance when needed.');
step(6, 'Rewards → redeem when you have enough Current or Banked weightage.');

note('Opening a KPI starts it. Only receiving the assignment email does not start the task.');
drawFooter();
newPage();

// 11
title('11. How to mark attendance');
para('Attendance uses your Work location (Office / Remote / Hybrid), your assigned shift, and (for Office) an Office GPS zone. Times use Asia/Karachi.');

h1('11.1 Who marks attendance');
tableHeader(['Role', 'Where']);
tableRow('Employee', 'Attendance → Mark attendance');
tableRow('Manager', 'Attendance → My day');
tableRow('HR', 'Attendance → My day');
tableRow('Admin', 'Does not self-clock like staff; reviews Leave, Remote, Shifts, History');
spacer();

h1('11.2 Office (GPS) — clock in / out');
step(1, 'Admin assigns you an Office GPS zone and a shift.');
step(2, 'On your phone, allow Location for Scorr.');
step(3, 'Open Attendance (My day / Mark attendance) during your shift (check-in opens 1 hour before start).');
step(4, 'Stand inside the geofence → Clock in. GPS is captured at that moment.');
step(5, 'Work your day. You can leave and return (multi-visit) — each visit is recorded.');
step(6, 'Clock out when done (allowed mid-shift if you need urgent leave). GPS is captured again.');
bullet('If you forget to clock out, Scorr auto clock-out at shift end when Attendance/Live Tracking opens.');

h1('11.3 Remote');
bullet('You do not use GPS. Your supervisor (manager or admin) marks Present or Absent.');
bullet('That record is saved in your attendance history.');

h1('11.4 Hybrid');
bullet('Office days: use GPS clock in/out.');
bullet('Work-from-home days: mark Present / Absent on My day, or your supervisor marks you.');

h1('11.5 Leave');
bullet('Request leave: Annual / Sick / Other · From / To · reason → Submit.');
bullet('Employee leave → manager (or admin) approves.');
bullet('Manager and HR leave → Admin approves.');

h1('11.6 History & downloads');
bullet('Browse This month / Month by month / Full year.');
bullet('Admin/HR History: pick department (or Human Resources for HR staff) → person → download CSV.');
drawFooter();
newPage();

// 12
title('12. How to assign tasks (Admin & Manager)');
para('Assign Task is how work becomes measurable KPIs with weightage. Admins can assign across the company; managers assign within their department.');

h1('12.1 Concepts');
tableHeader(['Term', 'Meaning']);
tableRow('Weight / Weightage', 'Task importance 1–100%. Sum of open tasks per person cannot exceed 100%.');
tableRow('Template (KPI\'s)', 'Reusable task definition (category, description, late rules).');
tableRow('Assign Task', 'Give a template (or task) to a person with start/due dates and weight.');
tableRow('Achieved', 'On approve: 0 up to the task weight (what they earned).');
tableRow('Periods', 'Overall · Month · Year views on scoreboards.');
spacer();

h1('12.2 Admin — assign a task');
step(1, 'Open Assign Task in the Admin console.');
step(2, 'Optional: KPI\'s tab — create a template (category, weight guidance, description, grace/late rules).');
step(3, 'Assign Task — choose department → person → task/template.');
step(4, 'Set Weight (%), Start date, Due date, optional note. Check the Weight in use meter (must stay ≤ 100%).');
step(5, 'Tap Assign KPI. The person gets in-app + email notification.');
step(6, 'When they Mark Complete, open Review — set Weightage to award → Approve & award or Send back.');

h1('12.3 Manager — assign a task');
step(1, 'Open Assign Task in the Manager console.');
step(2, 'Choose someone in your department.');
step(3, 'Set weight and dates → Assign.');
step(4, 'You (and the reporting manager if applicable) get completion alerts to review.');

h1('12.4 Filters on Assigned Task');
bullet('Current | Review | Completed.');
bullet('Cards show Weight, Start, Due, Progress, Health, Achieved.');
bullet('Actions: Pause / Resume · Edit · Remove (incomplete only where allowed).');

warn('You cannot assign if the person already has 100% open weightage. Finish or remove open tasks first, or lower the new weight.');
drawFooter();
newPage();

// 13
title('13. KPI completion & review');

h1('13.1 Employee / assignee');
step(1, 'My KPIs → Open a task (status becomes In progress).');
step(2, 'Do the work before the due date.');
step(3, 'Mark Complete → status pending_review.');
step(4, 'Wait for Approve & award. Weightage may reveal on the dashboard on the last day of the month.');

h1('13.2 Admin / Manager review');
step(1, 'Open Assign Task → Review filter (or notification deep link).');
step(2, 'Enter Weightage to award (0 to max task weight).');
step(3, 'Approve & award — or Send back with a note.');

h2('Performance bands (typical)');
bullet('Outstanding ≥ 95% · Excellent 90–94 · Good 80–89 · Needs Improvement 70–79 · Unsatisfactory below 70.');

note('Awarded weightage feeds Current / Used / Banked for gifts. Unused closed-month leftovers can move to Banked (never expires).');
drawFooter();
newPage();

// 14
title('14. Rewards & gifts');
para('Rewards use monthly weightage (0–100%), not a separate points wallet.');

tableHeader(['Label', 'Meaning']);
tableRow('Earned', 'From finished/approved tasks this month.');
tableRow('Current / Left to use', 'Spendable now.');
tableRow('Used', 'Spent on gifts this month.');
tableRow('Banked / Saved for later', 'Leftover from closed months — never expires.');
spacer();

h1('14.1 Redeem');
bullet('Employee or Manager → Rewards → choose company gift or catalog item → Redeem.');
bullet('Confirm cost in % weightage on screen.');

h1('14.2 Approve');
bullet('Manager or Admin → Rewards → Redemptions / Gifts to arrange.');
bullet('Approve · Delivered · Reject (reject returns weightage).');

bullet('Examples: movie tickets (streak), dinner voucher (outstanding month), surprise gift (elite streak), catalog items at listed %.');
drawFooter();
newPage();

// 15
title('15. Daily work reports');

h1('15.1 Who submits');
bullet('Employees, Managers, and HR submit their own daily report.');
bullet('Company admins receive notifications and review submissions.');
bullet('Length: minimum 20 characters, maximum 8000.');

h1('15.2 How to submit (Employee / Manager / HR)');
step(1, 'Open Daily report (or Daily Reports → My report for HR).');
step(2, 'Pick the date (today or up to 7 days back).');
step(3, 'Write a clear summary of projects and outcomes.');
step(4, 'Submit today’s report (or Update if already saved).');

h1('15.3 How Admin reviews');
step(1, 'Open Daily Reports.');
step(2, 'Select a date on the calendar.');
step(3, 'Filter department and role (All / Managers / Employees / HR).');
step(4, 'Open cards to read content; see Submitted vs Not submitted counts.');

h1('15.4 How HR uses Daily Reports');
bullet('My report — send your log to admin.');
bullet('Organization — review manager and employee reports company-wide.');
drawFooter();
newPage();

// 16
title('16. Office GPS & live tracking');

h1('16.1 Office GPS (Admin / HR)');
step(1, 'Office GPS → Create zone: name, address, pin (or use current location), radius, Active.');
step(2, 'Assign people — individual, or assign to all employees/managers/HR.');
step(3, 'Manage offices — edit or deactivate zones.');

h1('16.2 Live Tracking');
bullet('Today’s board for GPS staff: At site / Away / Offline / No site.');
bullet('Refreshes about every 2 minutes. Not continuous background spying — attendance events matter most.');
bullet('Managers see their team scope; Admin/HR see the organization.');

note('Location is stored as company attendance data — not sold, never shown to other companies.');
drawFooter();
newPage();

// 17
title('17. Analytics, exports & notifications');

h1('17.1 Analytics');
bullet('Admin/HR: Individual Performance & Activity Analytics — trends and attainment.');

h1('17.2 Export');
bullet('Export → Monthly or Quarterly → Excel, PDF, or CSV.');

h1('17.3 Notifications');
bullet('Bell icon: unread alerts. Tap to deep-link into tasks, leave, gifts, or daily reports.');
bullet('Email subjects include KPI assigned/completed, shift changes, login details, and password/MFA recovery.');
drawFooter();
newPage();

// 18
title('18. Security & account deletion');

h1('18.1 Safety basics');
bullet('Passwords hashed by Supabase Auth; failed logins rate-limited.');
bullet('Idle sessions sign out. Company signup needs email OTP.');
bullet('Privileged roles use TOTP MFA + backup codes.');
bullet('Every record is company-scoped.');

h1('18.2 Device permissions');
tableHeader(['Permission', 'Why']);
tableRow('Internet', 'Sign-in, KPIs, attendance, mail.');
tableRow('Location (while using)', 'Clock in/out at the geofence.');
tableRow('Notifications', 'Optional reminders.');
spacer();

h1('18.3 Delete my account');
para('Help page: https://scorr.walfia.ai/delete-account');
step(1, 'Settings → Account security → Delete my account.');
step(2, 'Type DELETE and enter your password → Confirm.');
warn('Company owners with other members must transfer ownership or delete the whole company first. Email info@walfia.ai for help (within 30 days).');
drawFooter();
newPage();

// 19
title('19. Plans, trial & demo');

tableHeader(['Plan', 'What you get']);
tableRow('Starter', '3-Day Trial at $0, then about $12/user/mo · up to 25 employees.');
tableRow('Professional', 'About $18/user/mo · unlimited seats · GPS/shifts/analytics · Most Popular.');
tableRow('Enterprise', 'Custom — Contact Sales.');
spacer();

h1('19.1 Demo sandbox (?demo=1)');
tableHeader(['Role', 'Login']);
tableRow('Admin', 'admin@walfia.ai / admin123');
tableRow('Manager', 'manager@walfia.ai / manager123');
tableRow('Employee', 'employee@walfia.ai / employee123');
spacer();
bullet('Demo skips MFA and does not affect real companies. Demo admin cannot create production users.');
drawFooter();
newPage();

// 20
title('20. Troubleshooting & support');
tableHeader(['Problem', 'What to try']);
tableRow('Cannot download APK', 'Use https://scorr.walfia.ai/#download-app → Download Android App. Try another browser.');
tableRow('APK won’t install', 'Allow install from browser/Files; uninstall old build only if signature conflicts, then reinstall.');
tableRow('iPhone install fails', 'Use Safari → Share → Add to Home Screen (not Chrome).');
tableRow('Awaiting approval', 'Wait for Walfia to approve at /platform; email info@walfia.ai if delayed.');
tableRow('Stuck on MFA', 'Backup code, email recovery, or Admin → People → Reset authenticator.');
tableRow('Wrong dashboard', 'Ask Admin to check your role on People.');
tableRow('Cannot assign KPI', 'Department + person required; open weightage ≤ 100%.');
tableRow('GPS check-in fails', 'Precise location on; assigned office; inside radius; within shift window.');
tableRow('HR under wrong group', 'History shows Human Resources for HR; not Unassigned.');
tableRow('Daily report not visible', 'Admin: Daily Reports → pick date. HR: Organization tab.');
spacer();

h1('Need help?');
bullet('Website: https://scorr.walfia.ai');
bullet('Register: Home → Register Company');
bullet('Download apps: https://scorr.walfia.ai/#download-app');
bullet('This guide: https://scorr.walfia.ai/downloads/Scorr-Client-Feature-Guide.pdf');
bullet('Delete account help: https://scorr.walfia.ai/delete-account');
bullet('Support: info@walfia.ai');
drawFooter();
newPage();

// 21
title('21. Quick reference');
tableHeader(['Item', 'Value']);
tableRow('Live URL', 'https://scorr.walfia.ai');
tableRow('Android download', '/downloads/scorr.apk or #download-app');
tableRow('iOS install', 'Safari → Add to Home Screen (?app=1)');
tableRow('App ID', 'ai.walfia.scorr');
tableRow('Company trial after approval', '3 days');
tableRow('Password minimum', '6 characters');
tableRow('Backup codes', '10 single-use');
tableRow('Open KPI weightage', '≤ 100% per person');
tableRow('Daily report length', '20–8000 characters');
tableRow('Shift grace', '60 minutes before start / after end');
tableRow('Geofence default', '~150 m');
tableRow('Direct APK until', '1 November 2026');
spacer();

para('Thank you for using Scorr — KPIs, GPS attendance, daily reports, and rewards in one secure company workspace.');
para('© Walfia · https://scorr.walfia.ai · info@walfia.ai');

drawFooter();

const buf = Buffer.from(doc.output('arraybuffer'));
fs.mkdirSync(path.dirname(OUT_PUBLIC), { recursive: true });
fs.writeFileSync(OUT_PUBLIC, buf);

const sizeMb = (buf.length / 1024 / 1024).toFixed(2);
console.log('✅ Scorr Complete User Guide PDF generated');
console.log(`   → ${OUT_PUBLIC}`);
console.log(`   Size: ${sizeMb} MB · ${doc.getNumberOfPages()} pages`);
