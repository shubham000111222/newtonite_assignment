import { FastifyInstance } from 'fastify';
import { UserContext } from '../../../shared/src/policy';

export default async function notificationsRoutes(fastify: FastifyInstance) {
  const pool = (fastify as any).db;

  fastify.get('/api/v1/notifications', { preValidation: [(fastify as any).authenticate] }, async (req, reply) => {
    const user = req.user as UserContext;
    const { limit = 50, cursor } = req.query as any;

    let query = 'SELECT * FROM notifications WHERE user_id = $1';
    const values: any[] = [user.id, parseInt(limit)];
    
    if (cursor) {
      query += ' AND created_at < (SELECT created_at FROM notifications WHERE id = $3)';
      values.push(cursor);
    }
    
    query += ' ORDER BY created_at DESC LIMIT $2';

    const { rows } = await pool.query(query, values);
    const nextCursor = rows.length === parseInt(limit) ? rows[rows.length - 1].id : null;
    
    return { items: rows, nextCursor };
  });

  fastify.post('/api/v1/notifications/:id/read', { preValidation: [(fastify as any).authenticate] }, async (req, reply) => {
    const user = req.user as UserContext;
    const { id } = req.params as { id: string };

    const { rows } = await pool.query(`
      UPDATE notifications 
      SET read_at = NOW() 
      WHERE id = $1 AND user_id = $2 AND read_at IS NULL
      RETURNING *
    `, [id, user.id]);

    if (rows.length === 0) {
      // It might already be read or doesn't belong to user
      const current = await pool.query('SELECT * FROM notifications WHERE id = $1 AND user_id = $2', [id, user.id]);
      if (current.rows.length === 0) return reply.status(404).send({ error: { message: 'Not found' } });
      return current.rows[0];
    }

    return rows[0];
  });
}
