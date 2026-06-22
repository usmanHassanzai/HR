/**
 * Generates Scorr-Project-Documentation.pdf
 * Run: node scripts/generate-project-doc-pdf.mjs
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { jsPDF } from 'jspdf';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'docs', 'Scorr-Project-Documentation.pdf');

const M = 18;
const W = 210;
const H = 297;
const LINE = 5.8;
const MAX_W = W - M * 2;

const doc = new jsPDF({ unit: 'mm', format: 'a4' });
let y = M;

function newPage() {
  doc.addPage();
  y = M;
}

function ensure(h = LINE) {
  if (y + h > H - M) newPage();
}

function title(text) {
  ensure(14);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(18);
  doc.setTextColor(15, 24, 32);
  doc.text(text, M, y);
  y += 10;
}

function h1(text) {
  ensure(12);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(13);
  doc.setTextColor(45, 212, 168);
  doc.text(text, M, y);
  y += 8;
}

function h2(text) {
  ensure(10);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(11);
  doc.setTextColor(30, 41, 59);
  doc.text(text, M, y);
  y += 7;
}

function para(text) {
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(10);
  doc.setTextColor(51, 65, 85);
  const lines = doc.splitTextToSize(text, MAX_W);
  for (const line of lines) {
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
  const lines = doc.splitTextToSize(`• ${text}`, MAX_W - 4);
  for (const line of lines) {
    ensure();
    doc.text(line, M + 2, y);
    y += LINE;
  }
}

function tableRow(cols, bold = false) {
  ensure();
  doc.setFont('helvetica', bold ? 'bold' : 'normal');
  doc.setFontSize(9);
  doc.setTextColor(51, 65, 85);
  const cw = [52, MAX_W - 52];
  doc.text(String(cols[0]), M, y);
  const lines = doc.splitTextToSize(String(cols[1]), cw[1] - 4);
  doc.text(lines[0], M + cw[0], y);
  y += LINE;
  for (let i = 1; i < lines.length; i++) {
    ensure();
    doc.text(lines[i], M + cw[0], y);
    y += LINE;
  }
}

function divider() {
  y += 2;
  doc.setDrawColor(200, 210, 220);
  doc.line(M, y, W - M, y);
  y += 6;
}

// ── Cover ──
doc.setFillColor(18, 24, 32);
doc.rect(0, 0, W, H, 'F');
doc.setTextColor(45, 212, 168);
doc.setFont('helvetica', 'bold');
doc.setFontSize(28);
doc.text('Scorr', M, 80);
doc.setFontSize(14);
doc.setTextColor(241, 245, 249);
doc.text('HR KPI & Rewards Platform', M, 92);
doc.setFontSize(11);
doc.setTextColor(148, 163, 184);
doc.text('Complete Project Documentation', M, 104);
doc.text('Live: https://scorr.walfia.ai', M, 118);
doc.text('Repository: github.com/usmanHassanzai/HR', M, 126);
doc.text(`Generated: ${new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' })}`, M, 134);
doc.text('Walfia · scorr.walfia.ai', M, H - 24);

newPage();

// ── 1. Overview ──
title('1. Project Overview');
para('Scorr is a role-based HR performance and rewards web application. Managers assign KPI tasks with deadlines; employees complete them; the system calculates health scores, awards monthly points, and lets employees redeem rewards that managers approve.');
divider();

h1('1.1 User Roles');
tableRow(['Admin', 'User directory, reports (PDF/Excel/CSV), analytics, branding, rewards catalog, monthly points job']);
tableRow(['Manager', 'Team leaderboard, KPI assignment, team reward approvals, own KPIs and points']);
tableRow(['Employee', 'KPI dashboard, mark tasks complete, rewards and points, notifications']);
y += 4;

h1('1.2 Core Workflow');
bullet('Manager assigns KPI (employee, department, dates) via KPI Config');
bullet('Employee marks KPI complete before deadline');
bullet('Overdue KPIs trigger notifications and email via Resend');
bullet('3 missed deadlines = −300 points penalty');
bullet('End of month: Admin runs Monthly Points Job');
bullet('Employee redeems catalog reward → Manager approves → Fulfilled');
divider();

// ── 2. Technology Stack ──
title('2. Technology Stack');

h1('2.1 Frontend');
tableRow(['React', '19.2.6 — UI library']);
tableRow(['TypeScript', '6.x — type-safe JavaScript']);
tableRow(['Vite', '8.x — build tool and dev server']);
tableRow(['CSS', 'Vanilla CSS design system (index.css)']);
tableRow(['Lucide React', 'Icons throughout the UI']);
tableRow(['Supabase JS', '@supabase/supabase-js 2.x — API client']);
tableRow(['jsPDF', 'Client-side PDF export for KPI reports']);
tableRow(['SheetJS (xlsx)', 'Excel export for admin reports']);
tableRow(['Capacitor 8', 'Optional native Android/iOS wrapper (PWA)']);
tableRow(['PWA', 'manifest.webmanifest + service worker (sw.js)']);
y += 4;

h1('2.2 Backend (Supabase)');
tableRow(['Supabase Auth', 'Email/password login, JWT sessions']);
tableRow(['PostgreSQL', 'Managed database (Supabase hosted)']);
tableRow(['Row Level Security', 'Role-based data access on all tables']);
tableRow(['SQL RPCs', 'Server functions: assign_kpi_manager, complete_kpi_employee, calculate_monthly_points, etc.']);
tableRow(['Realtime', 'Live KPI and notification subscriptions']);
tableRow(['Edge Functions', 'Deno serverless: kpi_email, export_report, auto_score, ai_narrative, monthly_target']);
y += 4;

h1('2.3 Database Tables');
bullet('users — profiles linked to auth.users (role, manager, health_score)');
bullet('kpis — assigned tasks, status, dates, completion, AI narrative');
bullet('kpi_submissions — historical KPI value submissions');
bullet('tasks — employee task list');
bullet('notifications — in-app alerts (info, alert, escalation, reminder)');
bullet('points_ledger — monthly points earned per employee (never expire)');
bullet('rewards_catalog — redeemable rewards (name, cost, icon)');
bullet('reward_redemptions — redemption workflow (pending → approved → fulfilled)');
y += 4;

h1('2.4 DevOps & Infrastructure');
tableRow(['GitHub', 'Source code: usmanHassanzai/HR']);
tableRow(['Vercel', 'Production hosting, CI/CD, SSL, custom domain']);
tableRow(['GoDaddy', 'DNS for walfia.ai domain']);
tableRow(['Resend', 'Transactional email API']);
tableRow(['who.is', 'DNS lookup tool (diagnostic only, not production)']);
divider();

// ── 3. Domain ──
title('3. Domain & DNS');

h1('3.1 Domains Used');
tableRow(['Main domain', 'walfia.ai — registered and managed on GoDaddy']);
tableRow(['App URL', 'scorr.walfia.ai — where Scorr is live']);
tableRow(['Vercel URL', 'hr-walfia.vercel.app — default Vercel deployment URL']);
tableRow(['Email from', 'noreply@scorr.walfia.ai — verified in Resend']);
y += 4;

h1('3.2 Why scorr.walfia.ai (subdomain)?');
bullet('Matches Scorr branding and email domain');
bullet('Leaves walfia.ai available for a future company homepage');
bullet('Standard pattern: app.company.com');
y += 4;

h1('3.3 DNS Configuration (GoDaddy)');
tableRow(['Type', 'CNAME']);
tableRow(['Name / Host', 'scorr']);
tableRow(['Value / Points to', 'cname.vercel-dns.com']);
tableRow(['TTL', '1 Hour (default)']);
para('Vercel project "hr" → Settings → Domains → scorr.walfia.ai added. SSL is automatic.');
divider();

// ── 4. Why Each Service ──
title('4. Why We Used Each Service');

h2('Vercel — Frontend Hosting');
para('Hosts the static React build (dist/). Connects to GitHub for automatic deploys on push. Provides free SSL, CDN, and environment variables for Supabase keys. Build: npm run build → output dist/.');
y += 2;

h2('GoDaddy — Domain & DNS');
para('You own walfia.ai on GoDaddy. DNS records (CNAME) tell browsers that scorr.walfia.ai should reach Vercel servers. GoDaddy does NOT host the application code — only domain routing.');
y += 2;

h2('who.is — DNS Lookup (one-time tool)');
para('Used during setup to verify who controls walfia.ai DNS (showed GoDaddy nameservers: domaincontrol.com). Not part of the running application — only for troubleshooting.');
y += 2;

h2('Supabase — Backend Platform');
para('All-in-one backend: authentication, PostgreSQL database, REST/Realtime API, Row Level Security, and Edge Functions. Project ref: yvnbxweitelowucdhwpg. Site URL configured to https://scorr.walfia.ai.');
y += 2;

h2('Resend — Email Delivery');
para('Sends KPI notification emails (overdue, completed). Domain scorr.walfia.ai verified in Resend. API key stored in Supabase Edge Function secrets — NOT in Vercel or GitHub. Edge function: supabase/functions/kpi_email/.');
y += 2;

h2('GitHub — Version Control');
para('Stores all source code. Vercel watches the main branch and redeploys on every push.');
divider();

// ── 5. Rewards ──
title('5. Rewards & Points System');

h1('5.1 Monthly Performance Tiers (points never expire)');
tableRow(['KPI Score ≥ 90%', '+1,000 points']);
tableRow(['KPI Score 80–89%', '+500 points']);
tableRow(['KPI Score 70–79%', '+250 points']);
tableRow(['KPI Score < 70%', '0 points']);
y += 4;

h1('5.2 Redemption');
bullet('Catalog items cost 1,000 points each (Team Dinner, Movie Tickets, Half-Day Leave, Gift Voucher)');
bullet('Employee redeems → status pending → Manager approves → fulfilled');
bullet('Admin can override org-wide in Rewards tab');
y += 4;

h1('5.3 Penalties');
bullet('3 missed KPI deadlines = −300 points (via check_overdue_kpis RPC)');
divider();

// ── 6. Environment ──
title('6. Environment Variables');

h1('6.1 Vercel (Production frontend only)');
tableRow(['VITE_SUPABASE_URL', 'https://yvnbxweitelowucdhwpg.supabase.co']);
tableRow(['VITE_SUPABASE_ANON_KEY', 'Supabase public anon key (safe for browser)']);
y += 4;

h1('6.2 Local .env (never commit to GitHub)');
tableRow(['VITE_SUPABASE_URL', 'Supabase project URL']);
tableRow(['VITE_SUPABASE_ANON_KEY', 'Anon key']);
tableRow(['SUPABASE_SERVICE_ROLE_KEY', 'Server-only — scripts only']);
tableRow(['SUPABASE_PAT', 'Supabase personal access token for scripts']);
tableRow(['RESEND_API_KEY', 'For deploy-kpi-email.mjs']);
tableRow(['KPI_EMAIL_FROM', 'Scorr <noreply@scorr.walfia.ai>']);
divider();

// ── 7. Project Structure ──
title('7. Key Files & Folders');
bullet('src/components/ — React UI (AdminDashboard, ManagerDashboard, EmployeeDashboard, etc.)');
bullet('src/lib/supabase.ts — Supabase client configuration');
bullet('src/utils/ — Helpers (KPI, export, email, rewards tiers)');
bullet('supabase/schema.sql — Full database schema, RLS, RPCs, triggers');
bullet('supabase/seed.sql — Demo users and sample data');
bullet('supabase/functions/ — Edge functions (kpi_email, export_report, etc.)');
bullet('scripts/ — setup-db, deploy-production, migrations');
bullet('vercel.json — SPA routing and cache headers');
bullet('public/ — Static assets, PWA manifest, logos');
divider();

// ── 8. Demo & Deploy ──
title('8. Demo Accounts & Deployment');

h1('8.1 Demo Logins');
tableRow(['Admin', 'admin@walfia.ai / admin123']);
tableRow(['Manager', 'manager@walfia.ai / manager123']);
tableRow(['Employee', 'employee@walfia.ai / employee123']);
y += 4;

h1('8.2 Deployment Steps');
bullet('1. Push code to GitHub (main branch)');
bullet('2. Vercel auto-builds and deploys');
bullet('3. GoDaddy CNAME: scorr → cname.vercel-dns.com');
bullet('4. Supabase Auth URL = https://scorr.walfia.ai');
bullet('5. Resend domain verified for scorr.walfia.ai');
y += 4;

h1('8.3 Useful Commands');
bullet('npm run dev — local development');
bullet('npm run build — production build');
bullet('node scripts/setup-db.mjs — initialize database');
bullet('node scripts/update-rewards-tiers.mjs — apply rewards SQL');
bullet('node scripts/deploy-kpi-email.mjs — deploy email function');
bullet('node scripts/generate-project-doc-pdf.mjs — regenerate this PDF');
divider();

// ── Footer page ──
ensure(20);
doc.setFont('helvetica', 'italic');
doc.setFontSize(9);
doc.setTextColor(148, 163, 184);
para('Scorr — Performance & Rewards Platform · https://scorr.walfia.ai · © Walfia');
para('This document describes the production system as deployed. Keep .env secrets private and rotate keys if exposed.');

fs.mkdirSync(path.dirname(OUT), { recursive: true });
const buf = doc.output('arraybuffer');
fs.writeFileSync(OUT, Buffer.from(buf));
console.log(`✅ PDF written → ${OUT}`);
