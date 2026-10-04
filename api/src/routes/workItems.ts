import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import * as crypto from 'crypto';
import { can, checkPermission, WorkItemContext, UserContext, Action } from '../../../shared/src/policy';

// Business-logic error used inside withIdempotency handlers.
// Throwing this ensures the transaction (including the idempotency key insert)
// is rolled back, and a proper HTTP response is sent. Never call reply.send()
// directly inside a withIdempotency handler — always throw AppError instead.
class AppError extends Error {
  constructor(public statusCode: number, public body: any) {
    super(body?.error?.message || 'Application error');
  }
}

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
      await client.query('SAVEPOINT idemp_sp');

      // Attempt to insert idempotency key
      try {
        await client.query(`
          INSERT INTO idempotency_keys (key, user_id, route, request_hash)
          VALUES ($1, $2, $3, $4)
        `, [key, userId, route, requestHash]);
      } catch (err: any) {
        if (err.code === '23505') { // unique_violation
          await client.query('ROLLBACK TO SAVEPOINT idemp_sp');
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

      // Execute business logic. Handlers MUST throw AppError on failure
      // so this transaction (including the idempotency key) is rolled back.
      const response = await handler(client);
      
      // Only reached on success — store the 200 response for future replays
      await client.query(`
        UPDATE idempotency_keys 
        SET response_status = 200, response_body = $1
        WHERE key = $2 AND user_id = $3
      `, [response, key, userId]);

      await client.query('COMMIT');
      return response;
    } catch (err) {
      // ROLLBACK may fail if the connection is dead — Postgres auto-rolls back
      // severed connections, so swallow the error.
      await client.query('ROLLBACK').catch(() => {});
      if (err instanceof AppError) {
        // Business error: tx rolled back, idempotency key NOT persisted.
        // Client can safely retry with the same key.
        return reply.status(err.statusCode).send(err.body);
      }
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
        throw new AppError(403, { error: { code: 'FORBIDDEN', message: 'Forbidden' } });
      }

      const { rows } = await client.query(`
        INSERT INTO work_items (team_id, title, description, type, priority, requires_approval, created_by)
        VALUES ($1, $2, $3, $4, $5, $6, $7)
        RETURNING *
      `, [input.team_id, input.title, input.description, input.type, input.priority, input.requires_approval, user.id]);

      const item = rows[0];

      // Add event + outbox job atomically in the same transaction
      const eventRes = await client.query(`
        INSERT INTO events (work_item_id, team_id, actor_id, type, payload)
        VALUES ($1, $2, $3, $4, $5) RETURNING id
      `, [item.id, item.team_id, user.id, 'created', { item }]);
      await client.query(`
        INSERT INTO jobs (type, event_id, payload) VALUES ('notification', $1, $2)
      `, [eventRes.rows[0].id, {}]);

      return item;
    });
  });

  // AllowedActions Helper
  function getPermissions(user: UserContext, item: WorkItemContext) {
    const allowedActions: string[] = [];
    const actionReasons: Record<string, string> = {};
    const allActions: Action[] = ['view', 'create_item', 'comment', 'claim', 'unassign', 'assign', 'change_priority', 'transition', 'approve_reject'];
    for (const action of allActions) {
      const p = checkPermission(user, action, item);
      if (p.allowed) {
        allowedActions.push(action);
      } else if (p.reason) {
        actionReasons[action] = p.reason;
      }
    }
    return { allowedActions, actionReasons };
  }

  // Get item
  fastify.get('/api/v1/work-items/:id', { preValidation: [(fastify as any).authenticate] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const { rows } = await pool.query(`
      SELECT w.*, u.name as assignee_name 
      FROM work_items w 
      LEFT JOIN users u ON w.assignee_id = u.id 
      WHERE w.id = $1
    `, [id]);
    if (rows.length === 0) return reply.status(404).send({ error: { message: 'Not found' } });
    
    const item = rows[0];
    const user = req.user as UserContext;
    // Cross-team → 404, not 403, so we don't leak item existence
    if (!can(user, 'view', item)) return reply.status(404).send({ error: { message: 'Not found' } });

    Object.assign(item, getPermissions(user, item));
    return item;
  });

  // List items
  fastify.get('/api/v1/work-items', { preValidation: [(fastify as any).authenticate] }, async (req, reply) => {
    const user = req.user as UserContext;
    const { team_id, status, priority, assignee_id, type, overdue, q, cursor, limit = 50 } = req.query as any;

    // Cross-team → 404 (do not leak existence)
    if (!team_id || !user.memberships[team_id]) {
      return reply.status(404).send({ error: { message: 'Not found' } });
    }

    let query = `
      SELECT w.*, u.name as assignee_name 
      FROM work_items w 
      LEFT JOIN users u ON w.assignee_id = u.id 
      WHERE w.team_id = $1
    `;
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
      query += ` AND (w.updated_at, w.id) < (SELECT updated_at, id FROM work_items WHERE id = $${vIdx++})`;
      values.push(cursor);
    }

    // Must match the idx_work_items_team_status_prio_updated index if possible,
    // but a general order by updated_at DESC is required for keyset pagination.
    query += ` ORDER BY w.updated_at DESC, w.id DESC LIMIT $${vIdx++}`;
    values.push(parseInt(limit));

    const { rows } = await pool.query(query, values);
    const nextCursor = rows.length === parseInt(limit) ? rows[rows.length - 1].id : null;
    
    rows.forEach((row: any) => {
      Object.assign(row, getPermissions(user, row));
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
      const { rows } = await client.query('SELECT * FROM work_items WHERE id = $1 ', [id]);
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
        Object.assign(updatedItem, getPermissions(user, updatedItem));
        return updatedItem;
      }
      
      await client.query('COMMIT');
      Object.assign(item, getPermissions(user, item));
      return item;
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {});
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

      // FOR UPDATE ensures the policy check sees a consistent snapshot
      // that won't change before the atomic UPDATE below.
      const { rows } = await client.query('SELECT * FROM work_items WHERE id = $1 FOR UPDATE', [id]);
      if (rows.length === 0) throw new AppError(404, { error: { message: 'Not found' } });
      const p = checkPermission(user, 'claim', rows[0]);

      if (!p.allowed) {
        if (p.reason === 'Already assigned') {
          const current = await client.query('SELECT u.name FROM work_items w LEFT JOIN users u ON w.assignee_id = u.id WHERE w.id = $1', [id]);
          throw new AppError(409, { 
            error: { code: 'CONFLICT', message: `Item was already claimed by ${current.rows[0]?.name || 'another user'}` } 
          });
        }
        throw new AppError(403, { error: { message: p.reason || 'Forbidden' } });
      }

      // Atomic claim — the WHERE assignee_id IS NULL guard is the real
      // concurrency control. Only one concurrent caller wins.
      const updateRes = await client.query(`
        UPDATE work_items 
        SET assignee_id = $1, version = version + 1, updated_at = NOW()
        WHERE id = $2 AND assignee_id IS NULL
        RETURNING *
      `, [user.id, id]);

      if (updateRes.rows.length === 0) {
        // Fallback for atomic failure if somehow the policy check passed
        const current = await client.query('SELECT u.name FROM work_items w LEFT JOIN users u ON w.assignee_id = u.id WHERE w.id = $1', [id]);
        throw new AppError(409, { 
          error: { code: 'CONFLICT', message: `Item was already claimed by ${current.rows[0]?.name || 'another user'}` } 
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

      Object.assign(updatedItem, getPermissions(user, updatedItem));
      return updatedItem;
    });
  });

  // Release
  fastify.post('/api/v1/work-items/:id/release', { preValidation: [(fastify as any).authenticate] }, async (req, reply) => {
    return withIdempotency(req, reply, async (client) => {
      const { id } = req.params as { id: string };
      const user = req.user as UserContext;

      const { rows } = await client.query('SELECT * FROM work_items WHERE id = $1 ', [id]);
      if (rows.length === 0) throw new AppError(404, { error: { message: 'Not found' } });
      if (!can(user, 'unassign', rows[0])) throw new AppError(403, { error: { message: 'Forbidden' } });

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

      Object.assign(updatedItem, getPermissions(user, updatedItem));
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

      const { rows } = await client.query('SELECT * FROM work_items WHERE id = $1 ', [id]);
      if (rows.length === 0) throw new AppError(404, { error: { message: 'Not found' } });
      if (!can(user, 'assign', rows[0])) throw new AppError(403, { error: { message: 'Forbidden' } });

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

      Object.assign(updatedItem, getPermissions(user, updatedItem));
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

      const { rows } = await client.query('SELECT * FROM work_items WHERE id = $1 ', [id]);
      if (rows.length === 0) throw new AppError(404, { error: { message: 'Not found' } });
      const item = rows[0];

      const p = checkPermission(user, 'transition', item);
      if (!p.allowed) {
        console.log('TRANSITION FORBIDDEN', p.reason, user, item);
        throw new AppError(403, { error: { message: 'Forbidden' } });
      }
      if (item.version !== input.version) throw new AppError(409, { error: { code: 'CONFLICT', message: 'Version mismatch', item } });
      
      if (!isValidTransition(item.status, input.status)) {
        throw new AppError(422, { error: { message: 'Illegal transition', from: item.status, to: input.status } });
      }

      // Reopen logic requires reason
      if ((item.status === 'resolved' || item.status === 'closed') && input.status === 'in_progress') {
        if (!input.reason) throw new AppError(422, { error: { message: 'Reason required for reopen' } });
      }

      // Approval gate: items requiring approval cannot resolve/close without it.
      // Exception: new → closed (discard junk item without needing approval).
      if ((input.status === 'resolved' || input.status === 'closed') && item.requires_approval) {
        if (item.approval_state !== 'approved' && !(item.status === 'new' && input.status === 'closed')) {
          throw new AppError(422, { error: { message: 'Item requires approval before resolution' } });
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

      Object.assign(updatedItem, getPermissions(user, updatedItem));
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

      const { rows } = await client.query('SELECT * FROM work_items WHERE id = $1 ', [id]);
      if (rows.length === 0) throw new AppError(404, { error: { message: 'Not found' } });
      const item = rows[0];

      if (!can(user, 'approve_reject', item)) throw new AppError(403, { error: { message: 'Forbidden' } });
      if (item.version !== input.version) throw new AppError(409, { error: { code: 'CONFLICT', message: 'Version mismatch', item } });

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

      Object.assign(updatedItem, getPermissions(user, updatedItem));
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

      const { rows } = await client.query('SELECT * FROM work_items WHERE id = $1 ', [id]);
      if (rows.length === 0) throw new AppError(404, { error: { message: 'Not found' } });
      const item = rows[0];

      if (!can(user, 'approve_reject', item)) throw new AppError(403, { error: { message: 'Forbidden' } });
      if (item.version !== input.version) throw new AppError(409, { error: { code: 'CONFLICT', message: 'Version mismatch', item } });

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

      Object.assign(updatedItem, getPermissions(user, updatedItem));
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
      if (rows.length === 0) throw new AppError(404, { error: { message: 'Not found' } });
      const item = rows[0];
      if (!can(user, 'comment', item)) throw new AppError(403, { error: { message: 'Forbidden' } });

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

  // List Comments — keyset pagination on (created_at, id) for stability
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
      // Keyset on (created_at, id) to avoid skips/dupes when two comments
      // share the same created_at timestamp.
      query += ` AND (created_at, id) > (SELECT created_at, id FROM comments WHERE id = $3)`;
      values.push(cursor);
    }
    query += ' ORDER BY created_at ASC, id ASC LIMIT $2';

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
