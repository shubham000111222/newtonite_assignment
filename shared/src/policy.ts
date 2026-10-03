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

export function can(user: UserContext, action: Action, item: WorkItemContext | { team_id: string }): boolean {
  const role = user.memberships[item.team_id];
  if (!role) return false;

  switch (action) {
    case 'view':
    case 'create_item':
    case 'comment':
      return true;
      
    case 'claim':
      return 'assignee_id' in item && item.assignee_id === null;
      
    case 'unassign':
      if (role === 'lead' || role === 'admin') return true;
      return 'assignee_id' in item && item.assignee_id === user.id;

    case 'assign':
    case 'change_priority':
      return role === 'lead' || role === 'admin';

    case 'transition':
      if (role === 'lead' || role === 'admin') return true;
      return 'assignee_id' in item && item.assignee_id === user.id;

    case 'approve_reject':
      if (role !== 'approver' && role !== 'admin') return false;
      if (!('requires_approval' in item) || !item.requires_approval) return false;
      return item.created_by !== user.id;

    case 'manage_members':
      return role === 'admin';

    default:
      return false;
  }
}
