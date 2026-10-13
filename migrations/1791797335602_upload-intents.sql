-- Up Migration
CREATE TABLE upload_intents (
  asset_id      uuid PRIMARY KEY,                        -- becomes assets.id; also inside public_id
  user_id       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  purpose       varchar(20) NOT NULL
                CHECK (purpose IN ('ASSET', 'PAGE_IMAGE', 'AVATAR', 'MARKER_MIND')),
  public_id     text NOT NULL UNIQUE,                    -- where the file goes on Storage
  resource_type varchar(10) NOT NULL CHECK (resource_type IN ('image', 'video', 'raw')),
  file_name     varchar(255) NOT NULL,                   -- as the browser reported it
  mime_type     varchar(100) NOT NULL,
  size_bytes    bigint NOT NULL CHECK (size_bytes > 0),  -- as the browser said; Storage has the real size
  created_at    timestamptz NOT NULL DEFAULT now(),
  expires_at    timestamptz NOT NULL,                    -- the signature is useless after this
  completed_at  timestamptz                              -- set once, by "complete"
);

CREATE INDEX upload_intents_by_user ON upload_intents (user_id, created_at DESC);
CREATE INDEX upload_intents_open ON upload_intents (expires_at) WHERE completed_at IS NULL;

ALTER TABLE upload_intents ENABLE ROW LEVEL SECURITY;
-- Down Migration
DROP TABLE upload_intents;
