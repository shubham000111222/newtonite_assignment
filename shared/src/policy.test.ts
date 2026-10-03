import test from 'node:test';
import assert from 'node:assert';
import { can, UserContext, WorkItemContext } from './policy';

test('Policy Module', async (t) => {
  const memberUser: UserContext = { id: 'u1', memberships: { 't1': 'member' } };
  const adminUser: UserContext = { id: 'u2', memberships: { 't1': 'admin' } };
  const approverUser: UserContext = { id: 'u3', memberships: { 't1': 'approver' } };

  const item: WorkItemContext = {
    id: 'w1',
    team_id: 't1',
    assignee_id: null,
    requires_approval: true,
    approval_state: 'pending',
    created_by: 'u1'
  };

  await t.test('cross-team access denied', () => {
    assert.strictEqual(can(memberUser, 'view', { team_id: 't2' }), false);
  });

  await t.test('member can view and claim unassigned', () => {
    assert.strictEqual(can(memberUser, 'view', item), true);
    assert.strictEqual(can(memberUser, 'claim', item), true);
  });

  await t.test('member cannot assign or change priority', () => {
    assert.strictEqual(can(memberUser, 'assign', item), false);
    assert.strictEqual(can(memberUser, 'change_priority', item), false);
  });

  await t.test('admin can manage members and assign', () => {
    assert.strictEqual(can(adminUser, 'manage_members', { team_id: 't1' }), true);
    assert.strictEqual(can(adminUser, 'assign', item), true);
  });

  await t.test('approver cannot approve own item', () => {
    const ownItem = { ...item, created_by: 'u3' };
    assert.strictEqual(can(approverUser, 'approve_reject', ownItem), false);
  });

  await t.test('approver can approve others items', () => {
    assert.strictEqual(can(approverUser, 'approve_reject', item), true);
  });
});
