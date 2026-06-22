import { sendKpiEmail } from './kpiEmail';
import { LeaveType, LEAVE_TYPE_LABEL } from './attendanceHelpers';

interface AdminRecipient {
  email: string;
  name: string;
}

export interface LeaveRequestEmailPayload {
  employee_name: string;
  leave_type: LeaveType;
  start_date: string;
  end_date: string;
  days_count: number;
  reason?: string | null;
  requester_role: string;
  manager_email?: string | null;
  manager_name?: string | null;
  admin_recipients?: AdminRecipient[];
}

export async function emailLeaveRequestNotifications(payload: LeaveRequestEmailPayload) {
  const typeLabel = LEAVE_TYPE_LABEL[payload.leave_type] || payload.leave_type;
  const reasonLine = payload.reason ? `\nReason: ${payload.reason}` : '';

  if (payload.requester_role === 'manager') {
    const admins = payload.admin_recipients || [];
    await Promise.all(
      admins.map((admin) =>
        sendKpiEmail(
          admin.email,
          `Leave request from manager ${payload.employee_name}`,
          `Hi ${admin.name},\n\n${payload.employee_name} (Manager) has requested ${typeLabel}.\n\nDates: ${payload.start_date} to ${payload.end_date}\nDays: ${payload.days_count}${reasonLine}\n\nPlease review and approve in the Scorr admin dashboard under Attendance & Leave.`
        )
      )
    );
    return;
  }

  if (payload.manager_email) {
    await sendKpiEmail(
      payload.manager_email,
      `Leave request from ${payload.employee_name}`,
      `Hi ${payload.manager_name || 'Manager'},\n\n${payload.employee_name} has requested ${typeLabel}.\n\nDates: ${payload.start_date} to ${payload.end_date}\nDays: ${payload.days_count}${reasonLine}\n\nPlease review and approve in your Scorr manager dashboard under Attendance & Leave.`
    );
  }

  const admins = payload.admin_recipients || [];
  await Promise.all(
    admins.map((admin) =>
      sendKpiEmail(
        admin.email,
        `Leave request from ${payload.employee_name}`,
        `Hi ${admin.name},\n\n${payload.employee_name} (Employee) has requested ${typeLabel}.\n\nDates: ${payload.start_date} to ${payload.end_date}\nDays: ${payload.days_count}${reasonLine}\n\nThe employee's manager can approve this in their dashboard. You can also view it under Leave Approvals in the admin dashboard.`
      )
    )
  );
}
