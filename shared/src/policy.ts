export type TeamRole = 'member' | 'lead' | 'approver' | 'admin';

export interface UserContext {
  id: string;
  memberships: Record<string, TeamRole>; // team_id -> role
}

export interface WorkItemContext {
  id: string;
  team_id: string;
  assignee_id: string | null;
  requires_approval: boolean;
  approval_state: 'pending' | 'approved' | 'rejected' | null;
  created_by: string;
}

export type Action = 
  | 'view' 
  | 'create_item' 
  | 'comment' 
  | 'claim' 
  | 'unassign' 
  | 'assign' 
  | 'change_priority' 
  | 'transition' 
  | 'approve_reject' 
  | 'manage_members';

export function checkPermission(user: UserContext, action: Action, item: any): { allowed: boolean; reason?: string } {
  const role = user.memberships[item.team_id];
  if (!role) return { allowed: false, reason: 'Not a team member' };

  switch (action) {
    case 'view':
    case 'create_item':
    case 'comment':
      return { allowed: true };
      
    case 'claim':
      if ('status' in item && (item.status === 'resolved' || item.status === 'closed')) {
        return { allowed: false, reason: 'Item is already ' + item.status };
      }
      if ('assignee_id' in item && item.assignee_id !== null) {
        return { allowed: false, reason: 'Already assigned' };
      }
      return { allowed: true };
      
    case 'unassign':
      if (role === 'lead' || role === 'admin') return { allowed: true };
      if ('assignee_id' in item && item.assignee_id !== user.id) {
        return { allowed: false, reason: 'Not assigned to you' };
      }
      return { allowed: true };

    case 'assign':
    case 'change_priority':
      if (role !== 'lead' && role !== 'admin') {
        return { allowed: false, reason: 'Requires lead/admin role' };
      }
      return { allowed: true };

    case 'transition':
      if (role === 'lead' || role === 'admin') return { allowed: true };
      if ('assignee_id' in item && item.assignee_id !== user.id) {
        return { allowed: false, reason: 'Not assigned to you' };
      }
      return { allowed: true };

    case 'approve_reject':
      if (role !== 'approver' && role !== 'admin') {
        return { allowed: false, reason: 'Requires approver/admin role' };
      }
      if (!('requires_approval' in item) || !item.requires_approval) {
        return { allowed: false, reason: 'Does not require approval' };
      }
      if (item.created_by === user.id) {
        return { allowed: false, reason: 'Cannot approve your own request' };
      }
      return { allowed: true };

    case 'manage_members':
      if (role !== 'admin') return { allowed: false, reason: 'Requires admin role' };
      return { allowed: true };

    default:
      return { allowed: false, reason: 'Unknown action' };
  }
}

export function can(user: UserContext, action: Action, item: any): boolean {
  return checkPermission(user, action, item).allowed;
}
