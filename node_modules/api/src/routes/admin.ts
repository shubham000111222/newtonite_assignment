import { FastifyInstance } from 'fastify';
import { UserContext } from '../../../shared/src/policy';

export default async function adminRoutes(fastify: FastifyInstance) {
  const pool = (fastify as any).db;

  fastify.get('/api/v1/admin/jobs', { preValidation: [(fastify as any).authenticate] }, async (req, reply) => {
    const user = req.user as UserContext;
    // Check global admin or just some condition. We'll check if user has 'admin' in any team for now.
    const isGlobalAdmin = Object.values(user.memberships).includes('admin');
    if (!isGlobalAdmin) {
      return reply.status(403).send({ error: { message: 'Forbidden' } });
    }

    const { status, limit = 50, cursor } = req.query as any;

    let query = 'SELECT * FROM jobs WHERE 1=1';
    const values: any[] = [parseInt(limit)];
    let vIdx = 2;

    if (status) {
      query += ` AND status = $${vIdx++}`;
      values.push(status);
    } else {
      query += ` AND status IN ('failed', 'dead')`;
    }

    if (cursor) {
      // Keyset pagination using created_at DESC
      query += ` AND created_at < (SELECT created_at FROM jobs WHERE id = $${vIdx++})`;
      values.push(cursor);
    }

    query += ` ORDER BY created_at DESC LIMIT $1`;

    const { rows } = await pool.query(query, values);
    const nextCursor = rows.length === parseInt(limit) ? rows[rows.length - 1].id : null;
    
    return { items: rows, nextCursor };
  });
}
