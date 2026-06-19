import { callEdgeFunction } from './edgeFunctionClient';

export async function sendKpiEmail(to: string, subject: string, body: string) {
  if (!to) return;
  try {
    await callEdgeFunction('kpi_email', { to, subject, body });
  } catch (e) {
    console.warn('Email send failed (in-app notification still created):', e);
  }
}

export async function emailKpiAssigned(employeeEmail: string, employeeName: string, department: string, endDate: string, description?: string) {
  await sendKpiEmail(
    employeeEmail,
    `New KPI assigned: ${department}`,
    `Hi ${employeeName},\n\nYour manager assigned you a new KPI task.\n\nDepartment: ${department}\nDue by: ${endDate}${description ? `\n\nDetails: ${description}` : ''}\n\nLog in to Scorr to view and complete it.`
  );
}

export async function emailKpiCompleted(managerEmail: string, managerName: string, employeeName: string, department: string) {
  await sendKpiEmail(
    managerEmail,
    `KPI completed by ${employeeName}`,
    `Hi ${managerName},\n\n${employeeName} marked their KPI as complete.\n\nDepartment: ${department}\n\nReview it in your Scorr manager dashboard.`
  );
}

export async function emailKpiOverdue(employeeEmail: string, employeeName: string, department: string, endDate: string, redoCount: number) {
  await sendKpiEmail(
    employeeEmail,
    `KPI overdue: ${department}`,
    `Hi ${employeeName},\n\nYour KPI "${department}" was due ${endDate} and is not yet complete.\n\nMiss count: ${redoCount}/3. After 3 missed deadlines you will lose reward points.\n\nPlease complete it in Scorr as soon as possible.`
  );
}
