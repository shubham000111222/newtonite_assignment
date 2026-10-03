# Engineering Decisions

1. **Postgres-only Design**
   I chose to use PostgreSQL as the single source of truth for both primary operational data and background job queueing. This removes the need for Redis or Kafka, reducing infrastructural complexity. By utilizing `FOR UPDATE SKIP LOCKED`, we achieve high concurrency polling of the `jobs` table without race conditions, safely mimicking a true message queue.

2. **Optimistic Locking + Atomic Claims**
   Instead of pessimistic locks across HTTP boundaries, we employ optimistic concurrency control using a `version` integer. When updates conflict, the API rejects the write with a 409 status, forcing the client to refetch the current state. However, for "claims", we bypass versions and use an atomic `UPDATE ... WHERE id = $1 AND assignee_id IS NULL` to ensure precisely one person can claim a work item, resolving the classic read-then-write race without heavy transaction isolation tricks.

3. **Transactional Outbox vs Message Queue**
   To guarantee that events (e.g., status changes) and their side-effects (e.g., notifications) are strictly consistent, we write the domain mutation, the event log, and the outbox `job` in a single database transaction. This protects against dual-write failures (e.g., updating the database but failing to publish a Kafka message). 

4. **Centralized Policy Authorization**
   Authorization is handled in a single, reusable `can(user, action, item)` function instead of being scattered throughout route handlers. This keeps rules cohesive, easily testable in unit tests, and allows us to return `allowedActions` to the frontend dynamically so the UI stays in sync with backend permissions.

5. **What Was Intentionally Not Built**
   I omitted complex abstractions like Prisma or TypeORM in favor of raw SQL (`pg` driver) because raw SQL provides transparent control over locking (`FOR UPDATE SKIP LOCKED`), transactional boundaries, and advanced features like JSONB and `tsvector` without ORM overhead. I also omitted a complex frontend routing setup, keeping it strictly minimal to demonstrate end-to-end functionality rather than building a heavy SPA.
