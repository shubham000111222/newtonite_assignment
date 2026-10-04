export const DASHBOARD_FILTERS = {
  is_open: `status NOT IN ('resolved', 'closed')`,
  awaiting_approval: `requires_approval = true AND approval_state = 'pending' AND status NOT IN ('resolved', 'closed')`,
  unassigned_urgent: `assignee_id IS NULL AND priority = 'urgent' AND status NOT IN ('resolved', 'closed')`,
  overdue_stale: `status NOT IN ('resolved', 'closed') AND (due_at < NOW() OR updated_at < NOW() - INTERVAL '7 days')`,
  recently_changed: `updated_at >= NOW() - INTERVAL '1 day'`
};
