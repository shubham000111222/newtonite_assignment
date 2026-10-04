import { FastifyInstance } from 'fastify';
import { UserContext } from '../../../shared/src/policy';
import { DASHBOARD_FILTERS } from '../utils/dashboardFilters';

export default async function dashboardRoutes(fastify: FastifyInstance) {
  const pool = (fastify as any).db;

  fastify.get('/api/v1/dashboard', { preValidation: [(fastify as any).authenticate] }, async (req, reply) => {
    const user = req.user as UserContext;
    const { team_id } = req.query as { team_id?: string };

    let teamIds = Object.keys(user.memberships);
    if (team_id) {
      if (!user.memberships[team_id]) {
        return reply.status(404).send({ error: { message: 'Team not found' } });
      }
      teamIds = [team_id];
    }

    if (teamIds.length === 0) {
      return { assignedToMe: 0, awaitingApproval: 0, unassignedUrgent: 0, overdueStale: 0, recentlyChanged: 0 };
    }

    const assignedToMePromise = pool.query(`
      SELECT COUNT(*) as count 
      FROM work_items 
      WHERE team_id = ANY($1) AND assignee_id = $2 AND ${DASHBOARD_FILTERS.is_open}
    `, [teamIds, user.id]);

    const awaitingApprovalPromise = pool.query(`
      SELECT COUNT(*) as count 
      FROM work_items 
      WHERE team_id = ANY($1) AND ${DASHBOARD_FILTERS.awaiting_approval}
    `, [teamIds]);

    const unassignedUrgentPromise = pool.query(`
      SELECT COUNT(*) as count 
      FROM work_items 
      WHERE team_id = ANY($1) AND ${DASHBOARD_FILTERS.unassigned_urgent}
    `, [teamIds]);

    const overdueStalePromise = pool.query(`
      SELECT COUNT(*) as count 
      FROM work_items 
      WHERE team_id = ANY($1) AND ${DASHBOARD_FILTERS.overdue_stale}
    `, [teamIds]);

    const recentlyChangedPromise = pool.query(`
      SELECT COUNT(*) as count 
      FROM work_items 
      WHERE team_id = ANY($1) AND ${DASHBOARD_FILTERS.recently_changed}
    `, [teamIds]);

    const [assignedToMe, awaitingApproval, unassignedUrgent, overdueStale, recentlyChanged] = await Promise.all([
      assignedToMePromise, awaitingApprovalPromise, unassignedUrgentPromise, overdueStalePromise, recentlyChangedPromise
    ]);

    return {
      assignedToMe: parseInt(assignedToMe.rows[0].count, 10),
      awaitingApproval: parseInt(awaitingApproval.rows[0].count, 10),
      unassignedUrgent: parseInt(unassignedUrgent.rows[0].count, 10),
      overdueStale: parseInt(overdueStale.rows[0].count, 10),
      recentlyChanged: parseInt(recentlyChanged.rows[0].count, 10)
    };
  });
}
