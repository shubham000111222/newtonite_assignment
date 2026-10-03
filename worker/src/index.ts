import { Pool } from 'pg';

const pool = new Pool({
  connectionString: process.env.DATABASE_URL || 'postgres://postgres:password@localhost:5432/newtonite'
});

const MAX_ATTEMPTS = 5;
const VISIBILITY_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes
const BATCH_SIZE = 10;
const POLL_INTERVAL_MS = 1000;

async function processJob(client: any, job: any) {
  // Get event details
  const { rows: eventRows } = await client.query('SELECT * FROM events WHERE id = $1', [job.event_id]);
  const event = eventRows[0];
  
  if (!event) {
    throw new Error('Event not found');
  }

  // Get item
  const { rows: itemRows } = await client.query('SELECT * FROM work_items WHERE id = $1', [event.work_item_id]);
  const item = itemRows[0];

  if (!item) {
    throw new Error('Work item not found');
  }

  // Figure out who to notify
  // We notify assignees if it's assigned to someone else, or the creator, etc.
  // We'll keep it simple: notify all leads/approvers in the team, and the assignee, except the actor.
  const { rows: users } = await client.query(`
    SELECT DISTINCT u.id 
    FROM users u
    JOIN memberships m ON m.user_id = u.id
    WHERE m.team_id = $1 
    AND (m.role IN ('lead', 'approver', 'admin') OR u.id = $2)
    AND u.id != $3
  `, [item.team_id, item.assignee_id || '00000000-0000-0000-0000-000000000000', event.actor_id]);

  let notifyCount = 0;
  for (const user of users) {
    const title = `New event on work item: ${item.title}`;
    const body = `Event: ${event.type}`;
    // Idempotent creation
    await client.query(`
      INSERT INTO notifications (user_id, job_id, title, body)
      VALUES ($1, $2, $3, $4)
      ON CONFLICT (job_id, user_id) DO NOTHING
    `, [user.id, job.id, title, body]);
    notifyCount++;
  }

  console.log(`Job ${job.id}: generated ${notifyCount} notifications.`);
}

async function runWorkerIteration() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Reclaim crashed jobs
    await client.query(`
      UPDATE jobs 
      SET status = 'failed', locked_until = NULL
      WHERE status = 'running' AND locked_until < NOW()
    `);

    // Poll for jobs
    const { rows: jobs } = await client.query(`
      SELECT * FROM jobs 
      WHERE status IN ('pending', 'failed') AND run_at <= NOW()
      ORDER BY created_at ASC
      LIMIT $1 
      FOR UPDATE SKIP LOCKED
    `, [BATCH_SIZE]);

    if (jobs.length === 0) {
      await client.query('ROLLBACK');
      return false; // No jobs processed
    }

    // Mark as running
    const jobIds = jobs.map(j => j.id);
    await client.query(`
      UPDATE jobs 
      SET status = 'running', locked_until = NOW() + interval '5 minutes'
      WHERE id = ANY($1)
    `, [jobIds]);
    
    await client.query('COMMIT');

    // Process each job independently
    for (const job of jobs) {
      const jobClient = await pool.connect();
      try {
        await jobClient.query('BEGIN');
        await processJob(jobClient, job);
        
        await jobClient.query(`
          UPDATE jobs 
          SET status = 'completed', locked_until = NULL 
          WHERE id = $1
        `, [job.id]);
        await jobClient.query('COMMIT');
      } catch (err: any) {
        await jobClient.query('ROLLBACK');
        
        // Handle failure
        const failClient = await pool.connect();
        try {
          await failClient.query('BEGIN');
          const attempts = job.attempts + 1;
          const status = attempts >= MAX_ATTEMPTS ? 'dead' : 'failed';
          
          // Exponential backoff: 2^attempts * 10 seconds + jitter
          const backoffSeconds = Math.pow(2, attempts) * 10 + Math.random() * 5;
          
          await failClient.query(`
            UPDATE jobs 
            SET status = $1, attempts = $2, run_at = NOW() + interval '1 second' * $3, 
                last_error = $4, locked_until = NULL
            WHERE id = $5
          `, [status, attempts, backoffSeconds, err.message || String(err), job.id]);
          await failClient.query('COMMIT');
          console.error(`Job ${job.id} failed: ${err.message}. Status -> ${status}`);
        } catch (failErr) {
          await failClient.query('ROLLBACK');
          console.error(`Failed to update job ${job.id} after failure`, failErr);
        } finally {
          failClient.release();
        }
      } finally {
        jobClient.release();
      }
    }

    return true; // Jobs were processed
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Worker iteration error:', err);
    return false;
  } finally {
    client.release();
  }
}

async function startWorker() {
  console.log('Worker started');
  while (true) {
    const processed = await runWorkerIteration();
    if (!processed) {
      await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL_MS));
    }
  }
}

startWorker().catch(err => {
  console.error('Worker failed to start', err);
  process.exit(1);
});
