-- Up Migration

-- citext: case-insensitive text (emails). pg_trgm: fast LIKE/ILIKE search.
CREATE EXTENSION IF NOT EXISTS citext;
CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE TYPE user_role        AS ENUM ('AUTHOR', 'ADMIN');
CREATE TYPE user_status      AS ENUM ('ACTIVE', 'LOCKED');
CREATE TYPE auth_token_type  AS ENUM ('VERIFY_EMAIL', 'RESET_PASSWORD');
CREATE TYPE page_format      AS ENUM ('A4', 'A5', 'SQUARE', 'CUSTOM');
CREATE TYPE book_visibility  AS ENUM ('PRIVATE', 'UNLISTED', 'PUBLIC');
CREATE TYPE book_status      AS ENUM ('DRAFT', 'PUBLISHED', 'CHANGED');
CREATE TYPE marker_mode      AS ENUM ('CUSTOM_MARKER', 'BOOKARIA_MARKER', 'NONE');
CREATE TYPE asset_type       AS ENUM ('MODEL', 'IMAGE', 'AUDIO', 'VIDEO');
CREATE TYPE asset_status     AS ENUM ('PROCESSING', 'READY', 'FAILED');
CREATE TYPE job_type         AS ENUM ('SCORE_MARKER', 'OPTIMIZE_ASSET', 'BUILD_PREVIEW', 'EXPORT_PDF', 'PUBLISH_BOOK');
CREATE TYPE job_status       AS ENUM ('QUEUED', 'RUNNING', 'SUCCEEDED', 'FAILED');
CREATE TYPE job_ref_type     AS ENUM ('BOOK', 'PAGE', 'ASSET');
CREATE TYPE view_event_type  AS ENUM ('OPEN', 'PAGE_FOUND', 'TAP', 'SCAN_TIMEOUT');
CREATE TYPE report_reason    AS ENUM ('INAPPROPRIATE', 'COPYRIGHT', 'OTHER');
CREATE TYPE report_status    AS ENUM ('OPEN', 'DISMISSED', 'ACTIONED');

-- Keeps updated_at honest: every table with that column gets a BEFORE UPDATE trigger using this.
CREATE FUNCTION set_updated_at() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END
$$;

-- Used on append-only tables (audit_logs, and book_versions via its own guard): any change is refused.
CREATE FUNCTION forbid_change() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% on % is not allowed: the table is append-only', TG_OP, TG_TABLE_NAME
    USING ERRCODE = 'restrict_violation';
END
$$;

-- Down Migration
DROP FUNCTION forbid_change();
DROP FUNCTION set_updated_at();
DROP TYPE report_status;
DROP TYPE report_reason;
DROP TYPE view_event_type;
DROP TYPE job_ref_type;
DROP TYPE job_status;
DROP TYPE job_type;
DROP TYPE asset_status;
DROP TYPE asset_type;
DROP TYPE marker_mode;
DROP TYPE book_status;
DROP TYPE book_visibility;
DROP TYPE page_format;
DROP TYPE auth_token_type;
DROP TYPE user_status;
DROP TYPE user_role;
DROP EXTENSION pg_trgm;
DROP EXTENSION citext;
