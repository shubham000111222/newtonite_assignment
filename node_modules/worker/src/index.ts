import { Pool } from 'pg';

const pool = new Pool({
  connectionString: process.env.DATABASE_URL || 'postgres://postgres:password@localhost:5432/newtonite'
});

const MAX_ATTEMPTS = 5;
const VISIBILITY_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes
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
  // Notify all leads/approvers in the team, and the assignee, except the actor.
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
    // Idempotent creation — ON CONFLICT DO NOTHING ensures running a job
    // twice produces exactly one notification per user.
    const result = await client.query(`
      INSERT INTO notifications (user_id, job_id, title, body)
      VALUES ($1, $2, $3, $4)
      ON CONFLICT (job_id, user_id) DO NOTHING
    `, [user.id, job.id, title, body]);
    // Only count actual inserts, not conflict-skips
    notifyCount += result.rowCount ?? 0;
  }

  console.log(`Job ${job.id}: generated ${notifyCount} notifications.`);
}

async function runWorkerIteration() {
  // Reclaim crashed jobs in a separate, short transaction so the changes
  // are visible to the polling query below (which runs in its own tx).
  const reclaimClient = await pool.connect();
  try {
    // Increment attempts on reclaim so a perpetually-crashing job
    // eventually reaches MAX_ATTEMPTS and goes dead.
    await reclaimClient.query(`
      UPDATE jobs 
      SET status = CASE WHEN attempts + 1 >= $1 THEN 'dead'::job_status ELSE 'failed'::job_status END,
          attempts = attempts + 1,
          locked_until = NULL,
          last_error = 'Reclaimed after worker crash (lease expired)'
      WHERE status = 'running' AND locked_until < NOW()
    `, [MAX_ATTEMPTS]);
  } catch (err) {
    console.error('Reclaim error:', err);
  } finally {
    reclaimClient.release();
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Poll for jobs — one at a time to avoid lease expiry on later items
    // in a large batch.
    const { rows: jobs } = await client.query(`
      SELECT * FROM jobs 
      WHERE status IN ('pending', 'failed') AND run_at <= NOW()
      ORDER BY created_at ASC
      LIMIT 1 
      FOR UPDATE SKIP LOCKED
    `);

    if (jobs.length === 0) {
      await client.query('ROLLBACK');
      return false; // No jobs processed
    }

    const job = jobs[0];

    // Mark as running with a lease
    await client.query(`
      UPDATE jobs 
      SET status = 'running', locked_until = NOW() + interval '5 minutes'
      WHERE id = $1
    `, [job.id]);
    
    await client.query('COMMIT');

    // Process the job in its own transaction
    const jobClient = await pool.connect();
    try {
      await jobClient.query('BEGIN');
      await processJob(jobClient, job);
      
      // Verify the lease is still ours before marking complete.
      // If it expired and was reclaimed, another worker may have re-processed it.
      const result = await jobClient.query(`
        UPDATE jobs 
        SET status = 'completed', locked_until = NULL 
        WHERE id = $1 AND status = 'running'
        RETURNING id
      `, [job.id]);

      if (result.rowCount === 0) {
        // Lease was reclaimed while we were processing — discard our work.
        // Notifications are idempotent (ON CONFLICT DO NOTHING) so no harm done.
        await jobClient.query('ROLLBACK');
        console.warn(`Job ${job.id}: lease expired during processing, discarding.`);
      } else {
        await jobClient.query('COMMIT');
      }
    } catch (err: any) {
      await jobClient.query('ROLLBACK').catch(() => {});
      
      // Handle failure — increment attempts and apply backoff
      const failClient = await pool.connect();
      try {
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
        console.error(`Job ${job.id} failed: ${err.message}. Status -> ${status}`);
      } catch (failErr) {
        console.error(`Failed to update job ${job.id} after failure`, failErr);
      } finally {
        failClient.release();
      }
    } finally {
      jobClient.release();
    }

    return true; // A job was processed
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
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
