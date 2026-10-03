import { Client } from 'pg';
import * as crypto from 'crypto';
import * as argon2 from 'argon2';

const DB_URL = process.env.DATABASE_URL || 'postgres://postgres:password@localhost:5432/newtonite';

async function seed() {
  const client = new Client({ connectionString: DB_URL });
  await client.connect();
  console.log('Connected to DB');

  try {
    // Clear existing
    await client.query('TRUNCATE users, teams, memberships, work_items, events, comments, idempotency_keys, jobs, notifications CASCADE');

    console.log('Seeding teams...');
    const teams = [];
    for (let i = 0; i < 5; i++) {
      const res = await client.query('INSERT INTO teams (name) VALUES ($1) RETURNING id', [`Team ${i + 1}`]);
      teams.push(res.rows[0].id);
    }

    console.log('Seeding users...');
    const users = [];
    const passwordHash = await argon2.hash('password123');
    for (let i = 0; i < 20; i++) {
      const email = `user${i}@example.com`;
      const res = await client.query('INSERT INTO users (email, password_hash, name) VALUES ($1, $2, $3) RETURNING id', [
        email,
        passwordHash,
        `User ${i}`
      ]);
      users.push(res.rows[0].id);
    }

    console.log('Seeding memberships...');
    const roles = ['member', 'lead', 'approver', 'admin'];
    for (let i = 0; i < users.length; i++) {
      // Each user belongs to 1 or 2 teams
      const userTeams = [teams[i % teams.length]];
      if (i % 3 === 0) userTeams.push(teams[(i + 1) % teams.length]);
      
      for (const t of userTeams) {
        const role = roles[i % roles.length];
        await client.query('INSERT INTO memberships (user_id, team_id, role) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING', [users[i], t, role]);
      }
    }

    console.log('Seeding work items...');
    const types = ['task', 'bug', 'incident', 'request'];
    const statuses = ['new', 'triaged', 'in_progress', 'blocked', 'resolved', 'closed'];
    const priorities = ['low', 'medium', 'high', 'urgent'];
    
    // Batch inserts for performance
    const ITEM_COUNT = parseInt(process.env.SEED_SIZE || '1000', 10); // using 1000 for fast local dev by default
    let itemIds = [];
    for (let i = 0; i < ITEM_COUNT; i++) {
      const teamId = teams[i % teams.length];
      const type = types[i % types.length];
      const status = statuses[i % statuses.length];
      const priority = priorities[i % priorities.length];
      const assigneeId = (i % 2 === 0) ? users[i % users.length] : null;
      const createdBy = users[(i + 1) % users.length];
      
      const res = await client.query(`
        INSERT INTO work_items (team_id, title, description, type, status, priority, assignee_id, requires_approval, created_by)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id
      `, [teamId, `Work Item ${i}`, `Description for item ${i}`, type, status, priority, assigneeId, i % 5 === 0, createdBy]);
      itemIds.push(res.rows[0].id);
    }

    console.log('Seeding events...');
    for (let i = 0; i < itemIds.length; i++) {
      const itemId = itemIds[i];
      const teamId = teams[i % teams.length];
      const actorId = users[i % users.length];
      await client.query(`
        INSERT INTO events (work_item_id, team_id, actor_id, type, payload)
        VALUES ($1, $2, $3, $4, $5)
      `, [itemId, teamId, actorId, 'created', { note: 'Initial creation' }]);
    }
    
    console.log(`Seed completed: 5 teams, 20 users, ${ITEM_COUNT} work items and events.`);
  } catch (err) {
    console.error('Seed error', err);
  } finally {
    await client.end();
  }
}

seed();
