-- Up Migration
ALTER TABLE assets ADD COLUMN storage_purged_at timestamptz;
CREATE INDEX assets_pending_storage_cleanup ON assets (id)
WHERE deleted_at IS NOT NULL AND storage_purged_at IS NULL;

-- Down Migration
DROP INDEX assets_pending_storage_cleanup;
ALTER TABLE assets DROP COLUMN storage_purged_at;
