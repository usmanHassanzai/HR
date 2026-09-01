export type AttendanceStatus = 'present' | 'absent' | 'late' | 'half_day';
export type ApprovalStatus = 'pending' | 'approved' | 'rejected';
export type LeaveType = 'annual' | 'sick' | 'other';

export interface LeaveBalance {
  year: number;
  annual_allowance: number;
  annual_used: number;
  annual_remaining: number;
  sick_allowance: number;
  sick_used: number;
  sick_remaining: number;
}

export interface AttendanceSummary {
  total_records: number;
  present_approved: number;
  absent: number;
  late: number;
  pending: number;
  attendance_rate: number;
}

export interface LeaveSummary {
  annual_days_taken: number;
  sick_days_taken: number;
  approved_requests: number;
  pending_requests: number;
  total_days_taken: number;
}

export interface AttendanceRecord {
  id: string;
  user_id: string;
  attendance_date: string;
  status: AttendanceStatus;
  approval_status: ApprovalStatus;
  clock_in_at?: string | null;
  clock_out_at?: string | null;
  attendance_source?: string;
  shift_id?: string | null;
  work_minutes?: number | null;
  notes: string | null;
  marked_by: string | null;
  reviewed_by: string | null;
  reviewed_at: string | null;
  created_at: string;
  users?: { full_name: string; email: string };
}

export interface PendingAttendanceRecord {
  id: string;
  user_id: string;
  attendance_date: string;
  status: AttendanceStatus;
  approval_status: ApprovalStatus;
  clock_in_at?: string | null;
  employee_name: string;
  employee_email: string;
}

export interface PendingLeaveRequest {
  id: string;
  user_id: string;
  leave_type: LeaveType;
  leave_custom_type?: string | null;
  start_date: string;
  end_date: string;
  days_count: number;
  reason: string | null;
  status: ApprovalStatus;
  created_at: string;
  employee_name: string;
  employee_email: string;
  employee_role: string;
}

export interface LeaveRequest {
  id: string;
  user_id: string;
  leave_type: LeaveType;
  leave_custom_type?: string | null;
  start_date: string;
  end_date: string;
  days_count: number;
  reason: string | null;
  status: ApprovalStatus;
  reviewed_by: string | null;
  reviewed_at: string | null;
  review_notes: string | null;
  created_at: string;
  users?: { full_name: string; email: string; role: string };
}

export const ATTENDANCE_STATUS_LABEL: Record<AttendanceStatus, string> = {
  present: 'Present',
  absent: 'Absent',
  late: 'Late',
  half_day: 'Half Day',
};

export const LEAVE_TYPE_LABEL: Record<LeaveType, string> = {
  annual: 'Annual Leave',
  sick: 'Sick Leave',
  other: 'Other',
};

export function formatLeaveType(type: LeaveType | string, custom?: string | null): string {
  if (type === 'other') {
    const written = custom?.trim();
    return written ? `Other (${written})` : 'Other';
  }
  return LEAVE_TYPE_LABEL[type as LeaveType] || String(type);
}

export const APPROVAL_LABEL: Record<ApprovalStatus, string> = {
  pending: 'Pending',
  approved: 'Approved',
  rejected: 'Rejected',
};

export function approvalBadgeClass(status: ApprovalStatus): string {
  if (status === 'approved') return 'badge-on-track';
  if (status === 'rejected') return 'badge-off-track';
  return 'badge-at-risk';
}

export function attendanceStatusBadgeClass(status: AttendanceStatus | string): string {
  if (status === 'absent') return 'badge-off-track';
  if (status === 'present') return 'badge-on-track';
  return 'badge-at-risk';
}
