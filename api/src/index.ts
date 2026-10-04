import Fastify from 'fastify';
import fastifyCors from '@fastify/cors';
import fastifyJwt from '@fastify/jwt';
import fastifyRateLimit from '@fastify/rate-limit';
import { Pool } from 'pg';
import * as argon2 from 'argon2';
import { z } from 'zod';
import * as crypto from 'crypto';
import workItemsRoutes from './routes/workItems';
import dashboardRoutes from './routes/dashboard';
import notificationsRoutes from './routes/notifications';
import adminRoutes from './routes/admin';

const fastify = Fastify({ 
  logger: true,
  genReqId: () => crypto.randomUUID()
});

const pool = new Pool({
  connectionString: process.env.DATABASE_URL || 'postgres://postgres:password@localhost:5432/newtonite'
});

fastify.register(fastifyCors, { origin: true });
fastify.register(fastifyJwt, { secret: process.env.JWT_SECRET || 'supersecretkey' });
fastify.register(fastifyRateLimit, { max: 100, timeWindow: '1 minute' });

fastify.decorate('db', pool);

// Error format
fastify.setErrorHandler((error, request, reply) => {
  request.log.error(error);
  if (error instanceof z.ZodError) {
    reply.status(400).send({
      error: { code: 'VALIDATION_ERROR', message: 'Invalid input', details: error.issues }
    });
    return;
  }
  const err = error as any;
  if (err.statusCode) {
    reply.status(err.statusCode).send({
      error: { code: err.code || 'ERROR', message: err.message }
    });
    return;
  }
  reply.status(500).send({
    error: { code: 'INTERNAL_SERVER_ERROR', message: 'Something went wrong' }
  });
});

// Auth Routes
const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1)
});

fastify.post('/api/v1/auth/login', async (request, reply) => {
  const { email, password } = loginSchema.parse(request.body);
  const { rows } = await pool.query('SELECT id, password_hash, name FROM users WHERE email = $1', [email]);
  
  if (rows.length === 0) {
    return reply.status(401).send({ error: { code: 'UNAUTHORIZED', message: 'Invalid credentials' } });
  }

  const user = rows[0];
  const valid = await argon2.verify(user.password_hash, password);
  if (!valid) {
    return reply.status(401).send({ error: { code: 'UNAUTHORIZED', message: 'Invalid credentials' } });
  }

  // Fetch memberships
  const membershipRows = await pool.query('SELECT team_id, role FROM memberships WHERE user_id = $1', [user.id]);
  const memberships: Record<string, string> = {};
  membershipRows.rows.forEach((r: any) => memberships[r.team_id] = r.role);

  const token = fastify.jwt.sign({ id: user.id, name: user.name, memberships });
  return { token, user: { id: user.id, name: user.name, memberships } };
});

fastify.decorate('authenticate', async (request: any, reply: any) => {
  try {
    await request.jwtVerify();
    // Re-fetch memberships from DB on every request so role changes
    // and team removals take effect immediately, not just after re-login.
    const userId = request.user.id;
    const { rows } = await pool.query('SELECT team_id, role FROM memberships WHERE user_id = $1', [userId]);
    const memberships: Record<string, string> = {};
    rows.forEach((r: any) => memberships[r.team_id] = r.role);
    request.user.memberships = memberships;
  } catch (err) {
    reply.status(401).send({ error: { code: 'UNAUTHORIZED', message: 'Missing or invalid token' } });
  }
});

fastify.get('/api/v1/auth/me', { preValidation: [(fastify as any).authenticate] }, async (request, reply) => {
  return { user: (request as any).user };
});

fastify.register(workItemsRoutes);
fastify.register(dashboardRoutes);
fastify.register(notificationsRoutes);
fastify.register(adminRoutes);

fastify.get('/api/v1/health', async (request, reply) => {
  return { status: 'ok' };
});

const start = async () => {
  try {
    await fastify.listen({ port: 3000, host: '0.0.0.0' });
  } catch (err) {
    fastify.log.error(err);
    process.exit(1);
  }
};

start();
