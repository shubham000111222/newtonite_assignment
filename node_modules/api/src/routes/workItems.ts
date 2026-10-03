import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import * as crypto from 'crypto';
import { can, WorkItemContext, UserContext, Action } from '../../../shared/src/policy';

export default async function workItemsRoutes(fastify: FastifyInstance) {
  const pool = (fastify as any).db;

  // Idempotency Middleware helper
  async function withIdempotency(
    req: FastifyRequest, 
    reply: FastifyReply, 
    handler: (client: any) => Promise<any>
  ) {
    const key = req.headers['idempotency-key'] as string;
    if (!key) {
      return reply.status(400).send({ error: { code: 'MISSING_IDEMPOTENCY_KEY', message: 'Idempotency-Key header is required' } });
    }

    const userId = (req.user as UserContext).id;
    const route = req.routeOptions.url;
    const bodyStr = JSON.stringify(req.body || {});
    const requestHash = crypto.createHash('sha256').update(bodyStr).digest('hex');

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // Attempt to insert idempotency key
      try {
        await client.query(`
          INSERT INTO idempotency_keys (key, user_id, route, request_hash)
          VALUES ($1, $2, $3, $4)
        `, [key, userId, route, requestHash]);
      } catch (err: any) {
        if (err.code === '23505') { // unique_violation
          // Key exists, fetch it
          const { rows } = await client.query('SELECT * FROM idempotency_keys WHERE key = $1 AND user_id = $2', [key, userId]);
          const existing = rows[0];
          
          if (existing.request_hash !== requestHash) {
            await client.query('ROLLBACK');
            return reply.status(422).send({ error: { code: 'IDEMPOTENCY_MISMATCH', message: 'Payload does not match original request' } });
          }
          
          if (existing.response_status === null) {
            await client.query('ROLLBACK');
            return reply.status(409).send({ error: { code: 'IN_FLIGHT', message: 'Request is already in progress' } });
          }

          await client.query('ROLLBACK');
          return reply.status(existing.response_status).send(existing.response_body);
        }
        throw err;
      }

      // Execute actual business logic inside transaction
      const response = await handler(client);
      
      // Update idempotency key with response
      const status = reply.statusCode || 200;
      await client.query(`
        UPDATE idempotency_keys 
        SET response_status = $1, response_body = $2
        WHERE key = $3 AND user_id = $4
      `, [status, response, key, userId]);

      await client.query('COMMIT');
      return response;
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  const createSchema = z.object({
    team_id: z.string().uuid(),
    title: z.string().min(1),
    description: z.string(),
    type: z.enum(['task', 'bug', 'incident', 'request']),
    priority: z.enum(['low', 'medium', 'high', 'urgent']),
    requires_approval: z.boolean().optional().default(false)
  });

  fastify.post('/api/v1/work-items', { preValidation: [(fastify as any).authenticate] }, async (req, reply) => {
    return withIdempotency(req, reply, async (client) => {
      const input = createSchema.parse(req.body);
      const user = req.user as UserContext;

      if (!can(user, 'create_item', { team_id: input.team_id })) {
        reply.status(403);
        throw new Error('Forbidden');
      }

      const { rows } = await client.query(`
        INSERT INTO work_items (team_id, title, description, type, priority, requires_approval, created_by)
        VALUES ($1, $2, $3, $4, $5, $6, $7)
        RETURNING *
      `, [input.team_id, input.title, input.description, input.type, input.priority, input.requires_approval, user.id]);

      const item = rows[0];

      // Add event
      const eventRes = await client.query(`
        INSERT INTO events (work_item_id, team_id, actor_id, type, payload)
        VALUES ($1, $2, $3, $4, $5) RETURNING id
      `, [item.id, item.team_id, user.id, 'created', { item }]);
      await client.query(`
        INSERT INTO jobs (type, event_id, payload) VALUES ('notification', $1, $2)
      `, [eventRes.rows[0].id, {}]);

      // We should also add a job here, but that is Phase 3! We can add a placeholder or skip for now.

      return item;
    });
  });

  // AllowedActions Helper
  function getAllowedActions(user: UserContext, item: WorkItemContext) {
    const actions: string[] = [];
    const allActions: Action[] = ['view', 'create_item', 'comment', 'claim', 'unassign', 'assign', 'change_priority', 'transition', 'approve_reject'];
    for (const action of allActions) {
      if (can(user, action, item)) {
        actions.push(action);
      }
    }
    return actions;
  }

  // Get item
  fastify.get('/api/v1/work-items/:id', { preValidation: [(fastify as any).authenticate] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const { rows } = await pool.query('SELECT * FROM work_items WHERE id = $1', [id]);
    if (rows.length === 0) return reply.status(404).send({ error: { message: 'Not found' } });
    
    const item = rows[0];
    const user = req.user as UserContext;
    if (!can(user, 'view', item)) return reply.status(404).send({ error: { message: 'Not found' } });

    item.allowedActions = getAllowedActions(user, item);
    return item;
  });

  // List items
  fastify.get('/api/v1/work-items', { preValidation: [(fastify as any).authenticate] }, async (req, reply) => {
    const user = req.user as UserContext;
    const { team_id, status, priority, assignee_id, type, overdue, q, cursor, limit = 50 } = req.query as any;

    if (!team_id || !user.memberships[team_id]) {
      return reply.status(403).send({ error: { message: 'Forbidden: Valid team_id required' } });
    }

    let query = 'SELECT * FROM work_items WHERE team_id = $1';
    const values: any[] = [team_id];
    let vIdx = 2;

    if (status) {
      query += ` AND status = $${vIdx++}`;
      values.push(status);
    }
    if (priority) {
      query += ` AND priority = $${vIdx++}`;
      values.push(priority);
    }
    if (assignee_id) {
      query += ` AND assignee_id = $${vIdx++}`;
      values.push(assignee_id);
    }
    if (type) {
      query += ` AND type = $${vIdx++}`;
      values.push(type);
    }
    if (overdue === 'true') {
      query += ` AND due_at < NOW() AND status NOT IN ('resolved', 'closed')`;
    }
    if (q) {
      query += ` AND search @@ websearch_to_tsquery('english', $${vIdx++})`;
      values.push(q);
    }

    // Keyset pagination using updated_at DESC, id
    if (cursor) {
      query += ` AND (updated_at, id) < (SELECT updated_at, id FROM work_items WHERE id = $${vIdx++})`;
      values.push(cursor);
    }

    // Must match the idx_work_items_team_status_prio_updated index if possible,
    // but a general order by updated_at DESC is required for keyset pagination.
    query += ` ORDER BY updated_at DESC, id DESC LIMIT $${vIdx++}`;
    values.push(parseInt(limit));

    const { rows } = await pool.query(query, values);
    const nextCursor = rows.length === parseInt(limit) ? rows[rows.length - 1].id : null;
    
    rows.forEach((row: any) => {
      row.allowedActions = getAllowedActions(user, row);
    });

    return { items: rows, nextCursor };
  });

  // Patch item (optimistic concurrency)
  const patchSchema = z.object({
    version: z.number(),
    title: z.string().optional(),
    description: z.string().optional()
  });

  fastify.patch('/api/v1/work-items/:id', { preValidation: [(fastify as any).authenticate] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const input = patchSchema.parse(req.body);
    const user = req.user as UserContext;

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const { rows } = await client.query('SELECT * FROM work_items WHERE id = $1 FOR UPDATE', [id]);
      if (rows.length === 0) {
        await client.query('ROLLBACK');
        return reply.status(404).send({ error: { message: 'Not found' } });
      }
      
      const item = rows[0];
      if (!can(user, 'view', item)) {
        await client.query('ROLLBACK');
        return reply.status(404).send({ error: { message: 'Not found' } });
      }

      if (item.version !== input.version) {
        await client.query('ROLLBACK');
        return reply.status(409).send({ error: { code: 'CONFLICT', message: 'Item version changed', item } });
      }

      const updates: string[] = [];
      const values: any[] = [];
      let i = 1;

      if (input.title) {
        updates.push(`title = $${i++}`);
        values.push(input.title);
      }
      if (input.description) {
        updates.push(`description = $${i++}`);
        values.push(input.description);
      }

      if (updates.length > 0) {
        updates.push(`version = version + 1`, `updated_at = NOW()`);
        const updateQuery = `UPDATE work_items SET ${updates.join(', ')} WHERE id = $${i} RETURNING *`;
        values.push(id);
        const updateRes = await client.query(updateQuery, values);
        const updatedItem = updateRes.rows[0];

        const eventRes = await client.query(`
        INSERT INTO events (work_item_id, team_id, actor_id, type, payload)
        VALUES ($1, $2, $3, $4, $5) RETURNING id
      `, [id, updatedItem.team_id, user.id, 'updated', input]);
      await client.query(`
        INSERT INTO jobs (type, event_id, payload) VALUES ('notification', $1, $2)
      `, [eventRes.rows[0].id, {}]);

        await client.query('COMMIT');
        updatedItem.allowedActions = getAllowedActions(user, updatedItem);
        return updatedItem;
      }
      
      await client.query('COMMIT');
      item.allowedActions = getAllowedActions(user, item);
      return item;
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  });

  // Claim
  fastify.post('/api/v1/work-items/:id/claim', { preValidation: [(fastify as any).authenticate] }, async (req, reply) => {
    return withIdempotency(req, reply, async (client) => {
      const { id } = req.params as { id: string };
      const user = req.user as UserContext;

      // Select without lock first to check policy
      const { rows } = await client.query('SELECT * FROM work_items WHERE id = $1', [id]);
      if (rows.length === 0) return reply.status(404).send({ error: { message: 'Not found' } });
      if (!can(user, 'claim', rows[0])) return reply.status(403).send({ error: { message: 'Forbidden' } });

      // Atomic claim
      const updateRes = await client.query(`
        UPDATE work_items 
        SET assignee_id = $1, version = version + 1, updated_at = NOW()
        WHERE id = $2 AND assignee_id IS NULL
        RETURNING *
      `, [user.id, id]);

      if (updateRes.rows.length === 0) {
        // Someone else claimed it or it doesn't exist anymore
        const current = await client.query('SELECT assignee_id FROM work_items WHERE id = $1', [id]);
        return reply.status(409).send({ 
          error: { code: 'CONFLICT', message: 'Already assigned', assignee_id: current.rows[0]?.assignee_id } 
        });
      }

      const updatedItem = updateRes.rows[0];
      const eventRes = await client.query(`
        INSERT INTO events (work_item_id, team_id, actor_id, type, payload)
        VALUES ($1, $2, $3, $4, $5) RETURNING id
      `, [id, updatedItem.team_id, user.id, 'claimed', { assignee_id: user.id }]);
      await client.query(`
        INSERT INTO jobs (type, event_id, payload) VALUES ('notification', $1, $2)
      `, [eventRes.rows[0].id, {}]);

      updatedItem.allowedActions = getAllowedActions(user, updatedItem);
      return updatedItem;
    });
  });

  // Release
  fastify.post('/api/v1/work-items/:id/release', { preValidation: [(fastify as any).authenticate] }, async (req, reply) => {
    return withIdempotency(req, reply, async (client) => {
      const { id } = req.params as { id: string };
      const user = req.user as UserContext;

      const { rows } = await client.query('SELECT * FROM work_items WHERE id = $1', [id]);
      if (rows.length === 0) return reply.status(404).send({ error: { message: 'Not found' } });
      if (!can(user, 'unassign', rows[0])) return reply.status(403).send({ error: { message: 'Forbidden' } });

      const updateRes = await client.query(`
        UPDATE work_items 
        SET assignee_id = NULL, version = version + 1, updated_at = NOW()
        WHERE id = $1
        RETURNING *
      `, [id]);

      const updatedItem = updateRes.rows[0];
      const eventRes = await client.query(`
        INSERT INTO events (work_item_id, team_id, actor_id, type, payload)
        VALUES ($1, $2, $3, $4, $5) RETURNING id
      `, [id, updatedItem.team_id, user.id, 'released', {}]);
      await client.query(`
        INSERT INTO jobs (type, event_id, payload) VALUES ('notification', $1, $2)
      `, [eventRes.rows[0].id, {}]);

      updatedItem.allowedActions = getAllowedActions(user, updatedItem);
      return updatedItem;
    });
  });

  // Assign
  const assignSchema = z.object({ assignee_id: z.string().uuid() });
  fastify.post('/api/v1/work-items/:id/assign', { preValidation: [(fastify as any).authenticate] }, async (req, reply) => {
    return withIdempotency(req, reply, async (client) => {
      const { id } = req.params as { id: string };
      const input = assignSchema.parse(req.body);
      const user = req.user as UserContext;

      const { rows } = await client.query('SELECT * FROM work_items WHERE id = $1', [id]);
      if (rows.length === 0) return reply.status(404).send({ error: { message: 'Not found' } });
      if (!can(user, 'assign', rows[0])) return reply.status(403).send({ error: { message: 'Forbidden' } });

      const updateRes = await client.query(`
        UPDATE work_items 
        SET assignee_id = $1, version = version + 1, updated_at = NOW()
        WHERE id = $2
        RETURNING *
      `, [input.assignee_id, id]);

      const updatedItem = updateRes.rows[0];
      const eventRes = await client.query(`
        INSERT INTO events (work_item_id, team_id, actor_id, type, payload)
        VALUES ($1, $2, $3, $4, $5) RETURNING id
      `, [id, updatedItem.team_id, user.id, 'assigned', { assignee_id: input.assignee_id }]);
      await client.query(`
        INSERT INTO jobs (type, event_id, payload) VALUES ('notification', $1, $2)
      `, [eventRes.rows[0].id, {}]);

      updatedItem.allowedActions = getAllowedActions(user, updatedItem);
      return updatedItem;
    });
  });

  // Transition
  const transitionSchema = z.object({
    version: z.number(),
    status: z.enum(['new', 'triaged', 'in_progress', 'blocked', 'resolved', 'closed']),
    reason: z.string().optional()
  });

  const isValidTransition = (from: string, to: string) => {
    const transitions: Record<string, string[]> = {
      'new': ['triaged', 'in_progress', 'closed'],
      'triaged': ['in_progress', 'blocked', 'closed'],
      'in_progress': ['blocked', 'resolved', 'closed'],
      'blocked': ['in_progress', 'closed'],
      'resolved': ['closed', 'in_progress'],
      'closed': ['in_progress']
    };
    return transitions[from]?.includes(to) ?? false;
  };

  fastify.post('/api/v1/work-items/:id/transition', { preValidation: [(fastify as any).authenticate] }, async (req, reply) => {
    return withIdempotency(req, reply, async (client) => {
      const { id } = req.params as { id: string };
      const input = transitionSchema.parse(req.body);
      const user = req.user as UserContext;

      const { rows } = await client.query('SELECT * FROM work_items WHERE id = $1 FOR UPDATE', [id]);
      if (rows.length === 0) return reply.status(404).send({ error: { message: 'Not found' } });
      const item = rows[0];

      if (!can(user, 'transition', item)) return reply.status(403).send({ error: { message: 'Forbidden' } });
      if (item.version !== input.version) return reply.status(409).send({ error: { code: 'CONFLICT', message: 'Version mismatch' } });
      
      if (!isValidTransition(item.status, input.status)) {
        return reply.status(422).send({ error: { message: 'Illegal transition', from: item.status, to: input.status } });
      }

      // Reopen logic requires reason
      if ((item.status === 'resolved' || item.status === 'closed') && input.status === 'in_progress') {
        if (!input.reason) return reply.status(422).send({ error: { message: 'Reason required for reopen' } });
      }

      // Approval logic
      if ((input.status === 'resolved' || input.status === 'closed') && item.requires_approval) {
        if (item.approval_state !== 'approved' && !(item.status === 'new' && input.status === 'closed')) {
          return reply.status(422).send({ error: { message: 'Item requires approval before resolution' } });
        }
      }

      const updateRes = await client.query(`
        UPDATE work_items 
        SET status = $1, version = version + 1, updated_at = NOW()
        WHERE id = $2
        RETURNING *
      `, [input.status, id]);

      const updatedItem = updateRes.rows[0];
      const eventRes = await client.query(`
        INSERT INTO events (work_item_id, team_id, actor_id, type, payload)
        VALUES ($1, $2, $3, $4, $5) RETURNING id
      `, [id, updatedItem.team_id, user.id, 'status_changed', { from: item.status, to: input.status, reason: input.reason }]);
      await client.query(`
        INSERT INTO jobs (type, event_id, payload) VALUES ('notification', $1, $2)
      `, [eventRes.rows[0].id, {}]);

      updatedItem.allowedActions = getAllowedActions(user, updatedItem);
      return updatedItem;
    });
  });

  // Approve
  const approveSchema = z.object({ version: z.number(), comment: z.string().optional() });
  fastify.post('/api/v1/work-items/:id/approve', { preValidation: [(fastify as any).authenticate] }, async (req, reply) => {
    return withIdempotency(req, reply, async (client) => {
      const { id } = req.params as { id: string };
      const input = approveSchema.parse(req.body);
      const user = req.user as UserContext;

      const { rows } = await client.query('SELECT * FROM work_items WHERE id = $1 FOR UPDATE', [id]);
      if (rows.length === 0) return reply.status(404).send({ error: { message: 'Not found' } });
      const item = rows[0];

      if (!can(user, 'approve_reject', item)) return reply.status(403).send({ error: { message: 'Forbidden' } });
      if (item.version !== input.version) return reply.status(409).send({ error: { code: 'CONFLICT', message: 'Version mismatch' } });

      const updateRes = await client.query(`
        UPDATE work_items 
        SET approval_state = 'approved', version = version + 1, updated_at = NOW()
        WHERE id = $1
        RETURNING *
      `, [id]);

      const updatedItem = updateRes.rows[0];
      const eventRes = await client.query(`
        INSERT INTO events (work_item_id, team_id, actor_id, type, payload)
        VALUES ($1, $2, $3, $4, $5) RETURNING id
      `, [id, updatedItem.team_id, user.id, 'approved', { comment: input.comment }]);
      await client.query(`
        INSERT INTO jobs (type, event_id, payload) VALUES ('notification', $1, $2)
      `, [eventRes.rows[0].id, {}]);

      updatedItem.allowedActions = getAllowedActions(user, updatedItem);
      return updatedItem;
    });
  });

  // Reject
  const rejectSchema = z.object({ version: z.number(), reason: z.string().min(1) });
  fastify.post('/api/v1/work-items/:id/reject', { preValidation: [(fastify as any).authenticate] }, async (req, reply) => {
    return withIdempotency(req, reply, async (client) => {
      const { id } = req.params as { id: string };
      const input = rejectSchema.parse(req.body);
      const user = req.user as UserContext;

      const { rows } = await client.query('SELECT * FROM work_items WHERE id = $1 FOR UPDATE', [id]);
      if (rows.length === 0) return reply.status(404).send({ error: { message: 'Not found' } });
      const item = rows[0];

      if (!can(user, 'approve_reject', item)) return reply.status(403).send({ error: { message: 'Forbidden' } });
      if (item.version !== input.version) return reply.status(409).send({ error: { code: 'CONFLICT', message: 'Version mismatch' } });

      const updateRes = await client.query(`
        UPDATE work_items 
        SET approval_state = 'rejected', version = version + 1, updated_at = NOW()
        WHERE id = $1
        RETURNING *
      `, [id]);

      const updatedItem = updateRes.rows[0];
      const eventRes = await client.query(`
        INSERT INTO events (work_item_id, team_id, actor_id, type, payload)
        VALUES ($1, $2, $3, $4, $5) RETURNING id
      `, [id, updatedItem.team_id, user.id, 'rejected', { reason: input.reason }]);
      await client.query(`
        INSERT INTO jobs (type, event_id, payload) VALUES ('notification', $1, $2)
      `, [eventRes.rows[0].id, {}]);

      updatedItem.allowedActions = getAllowedActions(user, updatedItem);
      return updatedItem;
    });
  });

  // Create Comment
  const commentSchema = z.object({ content: z.string().min(1) });
  fastify.post('/api/v1/work-items/:id/comments', { preValidation: [(fastify as any).authenticate] }, async (req, reply) => {
    return withIdempotency(req, reply, async (client) => {
      const { id } = req.params as { id: string };
      const input = commentSchema.parse(req.body);
      const user = req.user as UserContext;

      const { rows } = await client.query('SELECT * FROM work_items WHERE id = $1', [id]);
      if (rows.length === 0) return reply.status(404).send({ error: { message: 'Not found' } });
      const item = rows[0];
      if (!can(user, 'comment', item)) return reply.status(403).send({ error: { message: 'Forbidden' } });

      const commentRes = await client.query(`
        INSERT INTO comments (work_item_id, author_id, content)
        VALUES ($1, $2, $3)
        RETURNING *
      `, [id, user.id, input.content]);

      const eventRes = await client.query(`
        INSERT INTO events (work_item_id, team_id, actor_id, type, payload)
        VALUES ($1, $2, $3, $4, $5) RETURNING id
      `, [id, item.team_id, user.id, 'commented', { comment_id: commentRes.rows[0].id }]);
      await client.query(`
        INSERT INTO jobs (type, event_id, payload) VALUES ('notification', $1, $2)
      `, [eventRes.rows[0].id, {}]);

      return commentRes.rows[0];
    });
  });

  // List Comments
  fastify.get('/api/v1/work-items/:id/comments', { preValidation: [(fastify as any).authenticate] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const { limit = 50, cursor } = req.query as any;
    
    // Auth check
    const user = req.user as UserContext;
    const { rows: itemRows } = await pool.query('SELECT * FROM work_items WHERE id = $1', [id]);
    if (itemRows.length === 0) return reply.status(404).send({ error: { message: 'Not found' } });
    if (!can(user, 'view', itemRows[0])) return reply.status(404).send({ error: { message: 'Not found' } });

    let query = 'SELECT * FROM comments WHERE work_item_id = $1';
    const values: any[] = [id, parseInt(limit)];
    if (cursor) {
      // Keyset pagination using created_at
      query += ` AND created_at > (SELECT created_at FROM comments WHERE id = $3)`;
      values.push(cursor);
    }
    query += ' ORDER BY created_at ASC LIMIT $2';

    const { rows } = await pool.query(query, values);
    const nextCursor = rows.length === parseInt(limit) ? rows[rows.length - 1].id : null;
    return { items: rows, nextCursor };
  });

  // List Events
  fastify.get('/api/v1/work-items/:id/events', { preValidation: [(fastify as any).authenticate] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const { limit = 50, cursor } = req.query as any;
    
    const user = req.user as UserContext;
    const { rows: itemRows } = await pool.query('SELECT * FROM work_items WHERE id = $1', [id]);
    if (itemRows.length === 0) return reply.status(404).send({ error: { message: 'Not found' } });
    if (!can(user, 'view', itemRows[0])) return reply.status(404).send({ error: { message: 'Not found' } });

    let query = 'SELECT * FROM events WHERE work_item_id = $1';
    const values: any[] = [id, parseInt(limit)];
    if (cursor) {
      // Keyset pagination on events (created_at DESC, id)
      // Since it's DESC, we need <
      query += ` AND (created_at, id) < (SELECT created_at, id FROM events WHERE id = $3)`;
      values.push(cursor);
    }
    query += ' ORDER BY created_at DESC, id DESC LIMIT $2';

    const { rows } = await pool.query(query, values);
    const nextCursor = rows.length === parseInt(limit) ? rows[rows.length - 1].id : null;
    return { items: rows, nextCursor };
  });
}
