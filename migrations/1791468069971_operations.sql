-- Up Migration
-- Create for jobs, notifications, audit_logs, view_events, reports and Row Level Security.

CREATE TABLE jobs (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  type        job_type NOT NULL,
  status      job_status NOT NULL DEFAULT 'QUEUED',
  ref_type    job_ref_type NOT NULL,
  ref_id      uuid NOT NULL,
  payload     jsonb NOT NULL DEFAULT '{}',
  result      jsonb,
  progress    smallint NOT NULL DEFAULT 0 CHECK (progress BETWEEN 0 AND 100),
  attempts    smallint NOT NULL DEFAULT 0 CHECK (attempts <= 3),
  error       text,
  created_by  uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  started_at  timestamptz,
  finished_at timestamptz
);
CREATE INDEX jobs_by_ref ON jobs (ref_type, ref_id, created_at DESC);
CREATE INDEX jobs_open ON jobs (status, created_at) WHERE status IN ('QUEUED', 'RUNNING', 'FAILED');

CREATE TABLE notifications (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type       varchar(30) NOT NULL,
  title      varchar(150) NOT NULL,
  body       text,
  link       text,
  read_at    timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX notifications_unread ON notifications (user_id, created_at DESC) WHERE read_at IS NULL;

CREATE TABLE audit_logs (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  actor_id    uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  action      varchar(50) NOT NULL,
  target_type varchar(20) NOT NULL,
  target_id   uuid NOT NULL,
  detail      jsonb,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- The admin log is append-only: no update, no delete.
CREATE TRIGGER audit_logs_append_only BEFORE UPDATE OR DELETE ON audit_logs
  FOR EACH ROW EXECUTE FUNCTION forbid_change();
-- TRUNCATE skips row triggers, so it needs its own statement-level trigger.
CREATE TRIGGER audit_logs_no_truncate BEFORE TRUNCATE ON audit_logs
  FOR EACH STATEMENT EXECUTE FUNCTION forbid_change();

CREATE TABLE view_events (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  book_id         uuid NOT NULL REFERENCES books(id) ON DELETE CASCADE,
  book_version_id uuid REFERENCES book_versions(id) ON DELETE SET NULL,
  page_id         uuid REFERENCES pages(id) ON DELETE SET NULL,
  event           view_event_type NOT NULL,
  object_id       varchar(50),
  session_id      uuid NOT NULL,
  device_type     varchar(10),
  os              varchar(20),
  browser         varchar(20),
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX view_events_by_book ON view_events (book_id, created_at);
CREATE INDEX view_events_by_page ON view_events (page_id, event);

CREATE TABLE reports (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  book_id              uuid NOT NULL REFERENCES books(id) ON DELETE CASCADE,
  reason               report_reason NOT NULL,
  note                 varchar(1000),
  reporter_fingerprint text NOT NULL,
  status               report_status NOT NULL DEFAULT 'OPEN',
  handled_by           uuid REFERENCES users(id) ON DELETE SET NULL,
  handled_at           timestamptz,
  resolution_note      text,
  created_at           timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT reports_handled_has_handler CHECK (status = 'OPEN' OR handled_by IS NOT NULL)
);
CREATE INDEX reports_open ON reports (status, created_at) WHERE status = 'OPEN';

-- Supabase opens a REST API on every table of the `public` schema. The backend connects directly
-- with `pg`, so we switch Row Level Security on and create no policy: everything else is denied.
-- (The table owner, which the backend uses, is not affected.)
ALTER TABLE users            ENABLE ROW LEVEL SECURITY;
ALTER TABLE auth_sessions    ENABLE ROW LEVEL SECURITY;
ALTER TABLE auth_tokens      ENABLE ROW LEVEL SECURITY;
ALTER TABLE asset_categories ENABLE ROW LEVEL SECURITY;
ALTER TABLE assets           ENABLE ROW LEVEL SECURITY;
ALTER TABLE bookaria_markers ENABLE ROW LEVEL SECURITY;
ALTER TABLE books            ENABLE ROW LEVEL SECURITY;
ALTER TABLE book_versions    ENABLE ROW LEVEL SECURITY;
ALTER TABLE pages            ENABLE ROW LEVEL SECURITY;
ALTER TABLE page_assets      ENABLE ROW LEVEL SECURITY;
ALTER TABLE preview_links    ENABLE ROW LEVEL SECURITY;
ALTER TABLE jobs             ENABLE ROW LEVEL SECURITY;
ALTER TABLE notifications    ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_logs       ENABLE ROW LEVEL SECURITY;
ALTER TABLE view_events      ENABLE ROW LEVEL SECURITY;
ALTER TABLE reports          ENABLE ROW LEVEL SECURITY;

-- Down Migration
DROP TABLE reports;
DROP TABLE view_events;
DROP TABLE audit_logs;
DROP TABLE notifications;
DROP TABLE jobs;
