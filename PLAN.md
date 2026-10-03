# Project Plan

## 1. Full DDL

```sql
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

CREATE TABLE users (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  email VARCHAR(255) UNIQUE NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  name VARCHAR(255) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE teams (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name VARCHAR(255) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TYPE team_role AS ENUM ('member', 'lead', 'approver', 'admin');

CREATE TABLE memberships (
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  team_id UUID NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  role team_role NOT NULL,
  PRIMARY KEY (user_id, team_id)
);

CREATE TYPE work_item_type AS ENUM ('task', 'bug', 'incident', 'request');
CREATE TYPE work_item_status AS ENUM ('new', 'triaged', 'in_progress', 'blocked', 'resolved', 'closed');
CREATE TYPE work_item_priority AS ENUM ('low', 'medium', 'high', 'urgent');
CREATE TYPE approval_state AS ENUM ('pending', 'approved', 'rejected');

CREATE TABLE work_items (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  team_id UUID NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  title VARCHAR(255) NOT NULL,
  description TEXT NOT NULL,
  type work_item_type NOT NULL,
  status work_item_status NOT NULL DEFAULT 'new',
  priority work_item_priority NOT NULL DEFAULT 'medium',
  assignee_id UUID REFERENCES users(id) ON DELETE SET NULL,
  requires_approval BOOLEAN NOT NULL DEFAULT FALSE,
  approval_state approval_state,
  due_at TIMESTAMPTZ,
  created_by UUID NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  version INT NOT NULL DEFAULT 1,
  search TSVECTOR
);

-- Indexes for work_items
-- Optimise list queries filtered by team, status, priority, and sorted by updated_at
CREATE INDEX idx_work_items_team_status_prio_updated ON work_items (team_id, status, priority, updated_at DESC, id);
-- Optimise dashboard queries for items assigned to a specific user and their status
CREATE INDEX idx_work_items_assignee_status ON work_items (assignee_id, status);
-- Optimise finding overdue items within a team
CREATE INDEX idx_work_items_team_due_at ON work_items (team_id, due_at);
-- Optimise full-text search
CREATE INDEX idx_work_items_search ON work_items USING GIN(search);

CREATE TABLE events (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  work_item_id UUID NOT NULL REFERENCES work_items(id) ON DELETE CASCADE,
  team_id UUID NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  actor_id UUID REFERENCES users(id) ON DELETE SET NULL,
  type VARCHAR(50) NOT NULL, -- e.g., 'created', 'status_changed', 'assigned'
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Optimise timeline fetching for a specific work item
CREATE INDEX idx_events_item_created ON events (work_item_id, created_at DESC, id);

CREATE TABLE comments (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  work_item_id UUID NOT NULL REFERENCES work_items(id) ON DELETE CASCADE,
  author_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  content TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_comments_work_item ON comments (work_item_id, created_at ASC);

CREATE TABLE idempotency_keys (
  key VARCHAR(255) NOT NULL,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  route VARCHAR(255) NOT NULL,
  request_hash VARCHAR(255) NOT NULL,
  response_status INT,
  response_body JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, key)
);

CREATE TYPE job_status AS ENUM ('pending', 'running', 'failed', 'dead', 'completed');

CREATE TABLE jobs (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  type VARCHAR(50) NOT NULL, -- 'notification'
  event_id UUID NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  payload JSONB NOT NULL,
  status job_status NOT NULL DEFAULT 'pending',
  attempts INT NOT NULL DEFAULT 0,
  run_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  locked_until TIMESTAMPTZ,
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Only one job of a specific type per event
CREATE UNIQUE INDEX idx_jobs_type_event_id ON jobs (type, event_id);
-- Optimise worker polling
CREATE INDEX idx_jobs_pending ON jobs (status, run_at) WHERE status IN ('pending', 'failed');

CREATE TABLE notifications (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  job_id UUID NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  title VARCHAR(255) NOT NULL,
  body TEXT,
  read_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Ensure idempotency of notifications per job and recipient
CREATE UNIQUE INDEX idx_notifications_job_user ON notifications (job_id, user_id);
CREATE INDEX idx_notifications_user_created ON notifications (user_id, created_at DESC);
```

## 2. Permission Matrix (`can(user, action, item)`)

A central policy module evaluates whether a user is authorised to perform an action on a specific resource (usually `work_item` or `team`).
A user must have a membership in the item's `team_id`.

**Actions**:
- `view`: Any member of the team (`member`, `lead`, `approver`, `admin`).
- `create_item`: Any member of the team.
- `comment`: Any member of the team.
- `claim`: Any member, if the item is unassigned.
- `unassign`: Self (current assignee), `lead`, or `admin`.
- `assign`: `lead` or `admin`.
- `change_priority`: `lead` or `admin`.
- `transition`: 
  - If member/approver: Only if they are the current `assignee_id`.
  - If lead/admin: Any item in the team.
- `approve_reject`: 
  - Must have `approver` or `admin` role.
  - AND `item.requires_approval` is true.
  - AND `user.id != item.created_by` (Cannot approve own item).
- `manage_members`: Only `admin`.

## 3. Transition Table

Valid states: `new`, `triaged`, `in_progress`, `blocked`, `resolved`, `closed`.

**Valid Transitions**:
- `new` -> `triaged`, `in_progress`, `closed` (e.g. invalid/duplicate)
- `triaged` -> `in_progress`, `blocked`, `closed`
- `in_progress` -> `blocked`, `resolved`, `closed`
- `blocked` -> `in_progress`, `closed`
- `resolved` -> `closed`, `in_progress` (reopen with a required reason)
- `closed` -> `in_progress` (reopen with a required reason)

**Approval Gate**:
- If `requires_approval` is true, the item CANNOT transition to `resolved` or `closed` UNLESS `approval_state = 'approved'`. (Exception: closing directly from `new` as invalid is permitted).

## 4. API Contract

### Authentication
- `POST /api/v1/auth/login` - returns `{ token, user }`
- `GET /api/v1/auth/me`

### Teams & Members
- `GET /api/v1/teams`
- `GET /api/v1/teams/:id/members`

### Work Items
- `GET /api/v1/work-items` 
  - Query params: `team_id`, `status`, `priority`, `assignee_id`, `cursor`, `q` (search), `limit`. 
  - Returns `{ items: [{...}], nextCursor }`.
- `POST /api/v1/work-items` (Requires `Idempotency-Key` header)
- `GET /api/v1/work-items/:id` 
  - Returns item details including `allowedActions` array for the calling user.
- `PATCH /api/v1/work-items/:id` (Requires `version` body field for optimistic concurrency; used for title/description updates)

### Work Item Actions (Mutations)
- `POST /api/v1/work-items/:id/claim` (Idempotency-Key) - Sets assignee to self.
- `POST /api/v1/work-items/:id/release` (Idempotency-Key) - Removes assignee.
- `POST /api/v1/work-items/:id/assign` (Idempotency-Key) - Body: `{ assignee_id }`.
- `POST /api/v1/work-items/:id/transition` (Idempotency-Key) - Body: `{ status, version, reason? }`.
- `POST /api/v1/work-items/:id/approve` (Idempotency-Key) - Body: `{ version, comment? }`.
- `POST /api/v1/work-items/:id/reject` (Idempotency-Key) - Body: `{ version, reason }`.

### Comments & Events
- `GET /api/v1/work-items/:id/comments` (Keyset pagination)
- `POST /api/v1/work-items/:id/comments` (Idempotency-Key)
- `GET /api/v1/work-items/:id/events` (Timeline history, keyset pagination)

### Dashboard & Notifications
- `GET /api/v1/dashboard` (Query param: `team_id`) - Returns SQL aggregates counts.
- `GET /api/v1/notifications`

### Admin
- `GET /api/v1/admin/jobs` (failed/dead jobs)
