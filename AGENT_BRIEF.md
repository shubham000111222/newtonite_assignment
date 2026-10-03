# AGENT_BRIEF.md — Newtonite "Operations Under Pressure" build

> **Agent: read this entire file at the start of every session and before starting every phase.**
> This file is the source of truth for scope, rules and progress. Update the **Progress Tracker** and **Progress Log** sections yourself after each completed step (see "Working Protocol"). Do not edit any other section unless I ask.

---

## 0. Working Protocol (mandatory)

1. **Plan first.** Start in Planning mode. Produce the plan (full DDL, permission matrix, transition table, API contract) and **stop for my approval** before writing code.
2. **Phase by phase.** Build only the current phase. After finishing it:
   - run the app and tests yourself and report **real output**, not assumptions;
   - tick the boxes in the Progress Tracker and append an entry to the Progress Log (date/time, what was done, commands to verify, files changed, open issues);
   - commit to git with a clear message (`phase-N: ...`);
   - **stop and wait for my "continue".**
3. **No scope creep.** If something is not in this file, do not build it. If a decision is ambiguous, pick the simplest reasonable option, record it under **Assumptions** (section 9) and in the README, and move on.
4. **I must be able to explain and modify every line in a live review.** Keep code small, typed and readable: thin route handlers, logic in service modules, SQL in one data-access layer, no dead code. Add short comments at the non-obvious correctness points: the conditional UPDATE, transaction boundaries, the idempotency flow, the `SKIP LOCKED` query.
5. **If blocked or running out of time**, cut in this order: frontend polish → seed size → extra filters. **Never cut:** the critical behaviours, their tests, or the docs.
6. At the start of a new session, read the Progress Tracker, summarise where we are in 3 lines, then continue from the first unchecked item.

---

## 1. Progress Tracker

Legend: `[ ]` todo · `[~]` in progress · `[x]` done and verified

### Planning
- [x] Plan produced: full DDL, permission matrix, transition table, API contract
- [ ] Plan approved by me

### Phase 1 — Scaffold, DB, auth, policy
- [ ] Repo scaffold (api, worker, web, shared), TypeScript configs
- [ ] docker-compose: postgres, api, worker, web (one command up)
- [ ] Migrations for all tables and indexes
- [ ] Seed script (configurable size; several teams/roles; 10k+ items; large events table)
- [ ] Auth: login, hashed passwords, signed token, `/me`
- [ ] Central policy module (`can(user, action, item)`) with unit tests
- [ ] Error format, request IDs, request logging, rate limiting
- [ ] Phase 1 committed

### Phase 2 — Work-items API
- [ ] Create / get / patch work items (with version)
- [ ] Atomic claim and release
- [ ] Assign / reassign (lead+)
- [ ] Workflow transition table enforced server-side
- [ ] Approval flow (approve / reject; approver cannot approve own item)
- [ ] Idempotency-Key middleware (replay, mismatch, in-flight race)
- [ ] Every mutation writes event row in the same transaction
- [ ] Comments (with idempotency)
- [ ] List with keyset pagination, filters, full-text search
- [ ] `allowedActions` returned on item responses
- [ ] Dashboard summary endpoint (SQL aggregates)
- [ ] Phase 2 committed

### Phase 3 — Outbox, worker, notifications
- [ ] Job row written in same transaction as item change + event
- [ ] Worker polling with `FOR UPDATE SKIP LOCKED`
- [ ] Exponential backoff + jitter, max attempts, dead status
- [ ] Lease/visibility timeout for crashed worker
- [ ] Idempotent notification creation (unique constraints)
- [ ] Notifications API
- [ ] Admin endpoint/CLI to inspect failed/dead jobs
- [ ] Phase 3 committed

### Phase 4 — Frontend
- [ ] Login, routing, API client with Idempotency-Key handling
- [ ] Dashboard (cards deep-link to filtered lists)
- [ ] List: filters, search, cursor "load more", URL-synced state, loading/empty/error states
- [ ] Detail: fields, `allowedActions`-driven buttons, comments, paginated timeline
- [ ] Optimistic updates with rollback and 409 reconciliation
- [ ] Polling + refetch on focus + "item updated, refresh" banner
- [ ] Buttons disabled while pending; idempotency key reused on retry
- [ ] Phase 4 committed

### Phase 5 — Tests and docs
- [ ] Concurrent claims test (exactly one winner)
- [ ] Stale-version test (reject, accept, version increments)
- [ ] Idempotency tests (replay, different payload rejected)
- [ ] Authorization tests (cross-team 404, wrong role 403, approver self-approve blocked)
- [ ] Workflow tests (illegal transition, approval-gated resolve)
- [ ] Outbox tests (atomicity, double-run → one notification, retry → dead, lease reclaim)
- [ ] Keyset pagination stability test (inserts between pages)
- [ ] Mutation check: removing `assignee_id IS NULL` makes the claim test fail, then restored
- [ ] README.md (run, seed logins, tests, layout, Mermaid diagram, Assumptions)
- [ ] ENGINEERING_DECISIONS.md (draft, ~5 decisions)
- [ ] KNOWN_LIMITATIONS.md
- [ ] Phase 5 committed
- [ ] Final check: fresh clone → `docker compose up` → app works → tests pass

---

## 2. Progress Log

> Append newest entries at the bottom. Format:
> `### YYYY-MM-DD HH:MM — Phase N — <title>` then: done / verified with / files changed / open issues.

_(empty — agent appends here)_

### 2026-10-03 18:35 — Planning — Produced Project Plan
- **Done**: Created the full project plan with DDL, permission matrix, transition table, and API contract.
- **Verified with**: N/A (Planning phase)
- **Files changed**: Created `PLAN.md`
- **Open issues**: Waiting for approval before proceeding to Phase 1.

---

## 3. Problem Context

Build the first usable version of an internal operations work-management web app for a company with several hundred employees. Design for: thousands of users, hundreds to a few thousand concurrent users, many teams, tens of thousands of active work items, and a large, growing activity history. I have one working day, so prioritise **correctness of a small system over feature count**.

Teams currently coordinate via chat, spreadsheets and email. Requests (customer issues, engineering problems, payment investigations, production incidents, compliance requests, tasks needing approval) get lost, get double-worked, change ownership repeatedly and are edited concurrently. Management cannot see what is happening, who owns it, what needs attention, what changed, or why a decision was made.

A work item must let a user understand: what it is and why it exists; its state and importance; who is responsible; what has happened previously; what needs attention next.

---

## 4. Tech Stack (do not deviate)

- PostgreSQL 16; Node.js + TypeScript API (Fastify); Zod validation; plain SQL migrations (node-pg-migrate or similar); `pg` driver. **No heavy ORM.**
- React + Vite + TypeScript; TanStack Query for server state; React Router.
- Vitest (or Jest) with API integration tests against a **real Postgres test database**.
- docker-compose bringing up: postgres, api, worker, web. One command to run everything, with seed data.
- **NO** Redis, Kafka, websockets, SSO, microservices, or anything else not listed.

---

## 5. Data Model

Propose exact DDL in the plan; keep it close to this.

- `users`, `teams`, `memberships(user_id, team_id, role)`
- `work_items(id, team_id, title, description, type, status, priority, assignee_id nullable, requires_approval bool, approval_state, due_at nullable, created_by, created_at, updated_at, version int, search tsvector)`
- `events` — append-only history: `(id, work_item_id, team_id, actor_id, type, payload jsonb, created_at)`
- `comments`
- `idempotency_keys(key, user_id, route, request_hash, response_status, response_body, created_at)`, unique on `(user_id, key)`
- `jobs` (outbox): `(id, type, event_id, payload, status, attempts, run_at, locked_until, last_error, created_at)`, unique on `(type, event_id)`
- `notifications` (unique constraint that makes creation idempotent per job/recipient)

Indexes (comment each one explaining why it exists):
- `(team_id, status, priority, updated_at DESC, id)`
- `(assignee_id, status)`
- `(team_id, due_at)`
- GIN on `search`
- `events (work_item_id, created_at DESC, id)`

---

## 6. Roles, Authorization, Workflow

### Roles (scoped per team via memberships; a user can have different roles in different teams)
- **member**: view team items, create items, comment, claim unassigned items, transition items they own
- **lead**: all member rights + reassign, change priority, transition any team item, unassign
- **approver**: approve/reject approval-required items (cannot approve an item they created)
- **admin**: manage memberships + everything above, within their team

### Authorization rules
- Enforced **on the server in ONE central policy module** (`can(user, action, item)`) used by **every** handler. No inline role checks in routes. UI hiding is cosmetic only.
- Resource-level: decision depends on membership + role + item state + ownership.
- Cross-team access → **404** (do not leak existence). Same-team insufficient role → **403**.
- Auth is minimal: email + password, hashed (argon2 or bcrypt), signed token/session. Seed users across multiple teams and roles. Do not over-invest here.

### Workflow
Statuses: `new → triaged → in_progress → blocked ↔ in_progress → resolved → closed`; reopen: `resolved/closed → in_progress` with a required reason.
- Define the transition table in **one data structure**, enforced server-side. Illegal transition → 422/409 with a clear error.
- Items with `requires_approval` cannot move to `resolved/closed` until approved by an approver.
- Priority: `low, medium, high, urgent`.
- Every transition passes the policy check.

---

## 7. Critical Correctness Behaviours (core of the assessment — implement AND test each)

1. **Atomic claim.** Two simultaneous claims → exactly one wins via a single conditional `UPDATE ... WHERE id=$1 AND assignee_id IS NULL`. Loser gets 409 including the current owner. No read-then-write race.
2. **Optimistic concurrency.** Updates require the item `version` (If-Match or body field). Mismatch → 409 with current item state. Version increments on every mutation. UI shows a "changed by X, review" prompt, never a silent overwrite.
3. **Idempotency.** create, claim, transition, comment, approve accept an `Idempotency-Key` header. Same key + same payload → stored response, no duplicate side effects. Same key + different payload → 422. Handle the in-flight race (concurrent identical keys) using the unique constraint.
4. **Server-side workflow + approval rules** (section 6).
5. **Resource-level authorization** (section 6).
6. **Reliable async via transactional outbox.** Item change + event row + job row are written in **ONE transaction**. A separate worker process polls `jobs` with `FOR UPDATE SKIP LOCKED` and creates notifications (assignment, mention, approval requested, status change). Retries with exponential backoff + jitter; job marked `dead` after N attempts; processing is idempotent (running a job twice yields one notification, enforced by unique constraints). Worker crash mid-job is handled by a lease/visibility timeout. Failed/dead jobs are inspectable (admin endpoint or CLI).

---

## 8. API and Frontend Requirements

### API
- REST under `/api/v1`; consistent error format `{ "error": { "code", "message", "details" } }`; Zod validation on all inputs; correct status codes.
- Endpoints (roughly): auth, me, teams, team members, work-items (list/create/get/patch), `POST claim`, `POST release`, `POST assign`, `POST transition`, `POST approve/reject`, `GET/POST comments`, `GET events` (history), `GET dashboard`, `GET notifications`, admin jobs.
- Lists use **keyset (cursor) pagination only, never OFFSET**, stable ordering, max page size.
- Filters (combinable): status, priority, assignee, team, type, overdue, text search (`tsvector`, `websearch_to_tsquery`).
- Never load the full dataset into memory. Basic rate limiting; request logging with request IDs.
- Item responses include server-computed `allowedActions` for the current user.

### Frontend
- **Dashboard** backed by SQL aggregates: assigned to me, awaiting my approval, unassigned urgent, overdue/stale (no update in N days), recently changed. Each card deep-links into a filtered list.
- **List**: filters, search, cursor-based "load more", URL-synced filter state, loading/empty/error states.
- **Detail**: description, status/priority/owner, actions derived from `allowedActions`, comments, paginated activity timeline.
- **State**: TanStack Query for server state; optimistic updates for claim/transition/comment with rollback and reconciliation on 409/error (clear message + refetch); light polling (15–30s) + refetch on window focus + "this item was updated, refresh" banner when version changed under the user.
- Generate a fresh Idempotency-Key per user intent; **reuse it on retry** so double-clicks and network retries are safe. Disable buttons while pending.
- Coherent, responsive UX over decoration. Plain clean CSS is fine.

---

## 9. Assumptions

_(agent records assumptions here as they are made, one line each, with the phase)_

---

## 10. Tests (target the risks; no coverage chasing)

Integration tests against real Postgres covering at least:
- N concurrent claims (`Promise.all`) → exactly one success, the rest 409
- stale-version update rejected; correct version accepted; version increments
- idempotent replay returns same response, no duplicates; same key with different payload rejected
- cross-team → 404; insufficient role → 403; approver cannot approve own item
- illegal transition rejected; approval-gated resolve rejected before approval
- outbox: event + job written atomically (simulate failure → neither persists); job processed twice → one notification; failing job retries then goes dead; crashed-worker lease is reclaimed
- keyset pagination stays stable (no duplicates, no skips) while rows are inserted between pages

Then prove the concurrency test is meaningful: temporarily remove the `assignee_id IS NULL` guard, confirm the test fails, restore it.

---

## 11. Deliverables

- Working source code + seed script (several teams, ~10k+ generated items, large events table; size configurable)
- **README.md**: prerequisites, one-command run, seeded login credentials, how to run tests, project layout, Assumptions, Mermaid architecture diagram
- **ENGINEERING_DECISIONS.md**: ~5 key decisions with trade-offs — Postgres-only design; optimistic locking + atomic claim; outbox vs message queue; central policy authorization; what was intentionally not built. Write as a plain first-person **draft**; I will rewrite it myself.
- **KNOWN_LIMITATIONS.md**: honest list (no SSO, no attachments, no SLA engine, polling not push, single region, untuned search ranking, in-app notifications only) + "what I'd do with another week" + "what changes at 10x scale" (read replicas, time-partitioned events, a real queue, cached dashboard aggregates, push updates)
- Automated tests as above

---

## 12. Start

Begin now: read this file, then produce the **Plan** (section 0, step 1) and stop for approval.
