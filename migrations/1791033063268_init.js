exports.up = (pgm) => {
  pgm.sql(`
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

    CREATE INDEX idx_work_items_team_status_prio_updated ON work_items (team_id, status, priority, updated_at DESC, id);
    CREATE INDEX idx_work_items_assignee_status ON work_items (assignee_id, status);
    CREATE INDEX idx_work_items_team_due_at ON work_items (team_id, due_at);
    CREATE INDEX idx_work_items_search ON work_items USING GIN(search);

    -- Trigger to keep the search tsvector column populated.
    -- Without this, the GIN index is useless and full-text queries return zero rows.
    CREATE OR REPLACE FUNCTION work_items_search_update() RETURNS trigger AS $$
    BEGIN
      NEW.search := to_tsvector('english', coalesce(NEW.title, '') || ' ' || coalesce(NEW.description, ''));
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql;

    CREATE TRIGGER trg_work_items_search
      BEFORE INSERT OR UPDATE OF title, description ON work_items
      FOR EACH ROW EXECUTE FUNCTION work_items_search_update();

    CREATE TABLE events (
      id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
      work_item_id UUID NOT NULL REFERENCES work_items(id) ON DELETE CASCADE,
      team_id UUID NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
      actor_id UUID REFERENCES users(id) ON DELETE SET NULL,
      type VARCHAR(50) NOT NULL, 
      payload JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

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
      type VARCHAR(50) NOT NULL,
      event_id UUID NOT NULL REFERENCES events(id) ON DELETE CASCADE,
      payload JSONB NOT NULL,
      status job_status NOT NULL DEFAULT 'pending',
      attempts INT NOT NULL DEFAULT 0,
      run_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      locked_until TIMESTAMPTZ,
      last_error TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE UNIQUE INDEX idx_jobs_type_event_id ON jobs (type, event_id);
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

    CREATE UNIQUE INDEX idx_notifications_job_user ON notifications (job_id, user_id);
    CREATE INDEX idx_notifications_user_created ON notifications (user_id, created_at DESC);
  `);
};
