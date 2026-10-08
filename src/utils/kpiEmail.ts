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
    `Hi ${employeeName},\n\nYour manager assigned you a new KPI task.\n\nTask: ${department}\nDue by: ${endDate}${description ? `\n\nDetails: ${description}` : ''}\n\nThis email does not start the task. Open Scorr, look at the task, then it will show as In progress. Mark it Complete when you finish.`
  );
}

export async function emailKpiCompleted(opts: {
  toEmail: string;
  toName: string;
  employeeName: string;
  kpiName: string;
  dueDate?: string;
  recipientKind?: 'manager' | 'assigner';
}) {
  const { toEmail, toName, employeeName, kpiName, dueDate, recipientKind } = opts;
  if (!toEmail) return;
  const why =
    recipientKind === 'assigner'
      ? 'You assigned this KPI task.'
      : 'They report to you.';
  const dueLine = dueDate ? `\nDue date: ${dueDate}` : '';
  await sendKpiEmail(
    toEmail,
    `KPI completed: ${kpiName}`,
    `Hi ${toName || 'there'},\n\n${employeeName} marked the KPI task "${kpiName}" as complete.\n\n${why}${dueLine}\n\nOpen Scorr to review their work and score.`
  );
}

export async function emailKpiOverdue(employeeEmail: string, employeeName: string, department: string, endDate: string, redoCount: number) {
  await sendKpiEmail(
    employeeEmail,
    `KPI overdue: ${department}`,
    `Hi ${employeeName},\n\nYour KPI "${department}" was due ${endDate} and is not yet complete.\n\nMiss count: ${redoCount}/3. After 3 missed deadlines your weightage and score will be affected.\n\nPlease complete it in Scorr as soon as possible.`
  );
}

export async function emailKpiAssignmentUpdated(opts: {
  employeeEmail: string;
  employeeName: string;
  kpiName: string;
  editorName: string;
  editorRole: string;
  changeLines: string[];
}) {
  const { employeeEmail, employeeName, kpiName, editorName, editorRole, changeLines } = opts;
  if (!employeeEmail || !changeLines.length) return;
  const who = editorName.trim()
    ? `${editorName.trim()} (${editorRole})`
    : editorRole;
  const changes = changeLines.map((line) => `• ${line}`).join('\n');
  await sendKpiEmail(
    employeeEmail,
    `KPI updated: ${kpiName}`,
    `Hi ${employeeName},\n\nYour assigned task "${kpiName}" was updated by ${who}.\n\nWhat changed:\n${changes}\n\nOpen Scorr to review the updated task.`,
  );
}

export async function emailKpiRemoved(opts: {
  employeeEmail: string;
  employeeName: string;
  kpiName: string;
  removerName: string;
  removerRole: string;
  weightLabel?: string;
}) {
  const { employeeEmail, employeeName, kpiName, removerName, removerRole, weightLabel } = opts;
  if (!employeeEmail) return;
  const who = removerName.trim()
    ? `${removerName.trim()} (${removerRole})`
    : removerRole;
  const weightLine = weightLabel ? `\nWeightage removed: ${weightLabel}` : '';
  await sendKpiEmail(
    employeeEmail,
    `KPI removed: ${kpiName}`,
    `Hi ${employeeName || 'there'},\n\nYour assigned task "${kpiName}" was removed by ${who}.${weightLine}\n\nIt no longer appears on your dashboard and its weightage no longer counts.\n\nOpen Scorr if you need details from your manager.`,
  );
}

/** After review: email ONLY the person who owns the KPI (employee or manager). */
export async function emailKpiWeightageAwarded(opts: {
  toEmail: string;
  toName: string;
  kpiName: string;
  weightLabel: string;
  reviewerName?: string;
  note?: string;
  approved: boolean;
}) {
  const { toEmail, toName, kpiName, reviewerName, note, approved } = opts;
  if (!toEmail) return;
  const by = reviewerName?.trim() ? `\nReviewed by: ${reviewerName.trim()}` : '';
  const noteLine = note?.trim() ? `\nNote: ${note.trim()}` : '';
  if (approved) {
    await sendKpiEmail(
      toEmail,
      `KPI approved: ${kpiName}`,
      `Hi ${toName || 'there'},\n\nYour KPI task "${kpiName}" was approved.${by}${noteLine}\n\nYour awarded weightage is posted on the last day of the month. Until then, the task stays in History as approved.`,
    );
    return;
  }
  await sendKpiEmail(
    toEmail,
    `KPI sent back: ${kpiName}`,
    `Hi ${toName || 'there'},\n\nYour KPI task "${kpiName}" was sent back for more work.${by}${noteLine}\n\nOpen Scorr to update it and submit again.`,
  );
}

export async function emailShiftAssigned(opts: {
  email: string;
  name: string;
  shiftName: string;
  hours: string;
  days: string;
  assignerLabel?: string;
}) {
  const { email, name, shiftName, hours, days, assignerLabel } = opts;
  if (!email) return;
  const by = assignerLabel?.trim() ? `\nAssigned by: ${assignerLabel.trim()}` : '';
  await sendKpiEmail(
    email,
    `Active shift assigned: ${shiftName}`,
    `Hi ${name || 'there'},\n\nAn Active shift has been assigned to you on Scorr.\n\nActive shift: ${shiftName}\nHours: ${hours}\nWorking days: ${days}${by}\n\nOpen Scorr → Attendance to see your Active shift and clock in during those hours.`,
  );
}

export async function emailShiftUpdated(opts: {
  email: string;
  name: string;
  shiftName: string;
  hours: string;
  days: string;
  assignerLabel?: string;
}) {
  const { email, name, shiftName, hours, days, assignerLabel } = opts;
  if (!email) return;
  const by = assignerLabel?.trim() ? `\nUpdated by: ${assignerLabel.trim()}` : '';
  await sendKpiEmail(
    email,
    `Active shift updated: ${shiftName}`,
    `Hi ${name || 'there'},\n\nYour Active shift on Scorr was changed.\n\nActive shift: ${shiftName}\nHours: ${hours}\nWorking days: ${days}${by}\n\nOpen Scorr → Attendance to review the new schedule.`,
  );
}
