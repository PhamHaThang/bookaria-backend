-- Up Migration

-- Create tables for users, auth_sessions, and auth_tokens.
CREATE TABLE users (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email               citext NOT NULL UNIQUE,
  password_hash       text,                         -- bcrypt; NULL when the account only uses Google
  google_sub          text UNIQUE,
  display_name        varchar(100) NOT NULL,
  avatar_url          text,
  organization        varchar(150),
  bio                 varchar(500),
  role                user_role NOT NULL DEFAULT 'AUTHOR',
  status              user_status NOT NULL DEFAULT 'ACTIVE',
  email_verified_at   timestamptz,                  -- NULL = not verified yet, cannot publish
  failed_login_count  smallint NOT NULL DEFAULT 0,
  locked_until        timestamptz,                  -- temporary lock after 5 wrong passwords
  storage_quota_bytes bigint NOT NULL DEFAULT 524288000,   -- 500 MB
  storage_used_bytes  bigint NOT NULL DEFAULT 0 CHECK (storage_used_bytes >= 0),
  last_login_at       timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  -- there must be at least one way to sign in
  CONSTRAINT users_has_login_method CHECK (password_hash IS NOT NULL OR google_sub IS NOT NULL)
);
CREATE TRIGGER users_set_updated_at BEFORE UPDATE ON users
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();


-- At least one active ADMIN must always remain. Fires on demotion, lock and delete.
CREATE FUNCTION keep_last_admin() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.role = 'ADMIN' AND OLD.status = 'ACTIVE'
     AND (TG_OP = 'DELETE' OR NEW.role <> 'ADMIN' OR NEW.status <> 'ACTIVE') THEN
    IF NOT EXISTS (
      SELECT 1 FROM users WHERE role = 'ADMIN' AND status = 'ACTIVE' AND id <> OLD.id
    ) THEN
      RAISE EXCEPTION 'LAST_ADMIN' USING ERRCODE = 'restrict_violation';
    END IF;
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER users_keep_last_admin
  BEFORE UPDATE OF role, status OR DELETE ON users
  FOR EACH ROW EXECUTE FUNCTION keep_last_admin();

CREATE TABLE auth_sessions (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id            uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  refresh_token_hash text NOT NULL UNIQUE,          -- SHA-256 of the refresh token; the token itself is never stored
  user_agent         text,
  expires_at         timestamptz NOT NULL,          -- 7 days after sign-in
  revoked_at         timestamptz,
  last_used_at       timestamptz,
  created_at         timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX auth_sessions_active_by_user ON auth_sessions (user_id) WHERE revoked_at IS NULL;

CREATE TABLE auth_tokens (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type        auth_token_type NOT NULL,
  token_hash  text NOT NULL UNIQUE,                 -- hash of the code sent in the email link
  expires_at  timestamptz NOT NULL,                 -- 24 h for VERIFY_EMAIL, 30 min for RESET_PASSWORD
  used_at     timestamptz,                          -- NULL = unused; a code works once
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- Finding the unused codes of a user (to cancel them when a new one is issued).
CREATE INDEX auth_tokens_unused_by_user ON auth_tokens (user_id, type) WHERE used_at IS NULL;

-- Down Migration
DROP TABLE auth_tokens;
DROP TABLE auth_sessions;
DROP TRIGGER users_keep_last_admin ON users;
DROP FUNCTION keep_last_admin();
DROP TABLE users;
