-- Up Migration
-- Add two columns to the auth_sessions table to support refresh token rotation.
--   previous_token_hash: "a refresh token that was already replaced must not come back, or the whole
--                         session is revoked" can only be checked if we remember the replaced token.
--   remember:            "remember me" decides whether the cookie survives the browser being closed;
--                         a refresh must keep that choice.
ALTER TABLE auth_sessions
  ADD COLUMN previous_token_hash text,
  ADD COLUMN remember boolean NOT NULL DEFAULT false;

CREATE INDEX auth_sessions_previous_hash ON auth_sessions (previous_token_hash)
  WHERE previous_token_hash IS NOT NULL;


-- Down Migration
DROP INDEX auth_sessions_previous_hash;
ALTER TABLE auth_sessions
  DROP COLUMN remember,
  DROP COLUMN previous_token_hash;
