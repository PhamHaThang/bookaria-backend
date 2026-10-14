-- Up Migration
-- A single object may have at most one queued or running job at a time.
CREATE UNIQUE INDEX jobs_one_open_per_ref ON jobs (ref_type, ref_id)
  WHERE status IN ('QUEUED', 'RUNNING');

-- Down Migration
DROP INDEX jobs_one_open_per_ref;
