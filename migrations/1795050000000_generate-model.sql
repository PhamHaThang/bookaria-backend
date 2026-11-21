-- Up Migration
ALTER TYPE job_type ADD VALUE IF NOT EXISTS 'GENERATE_MODEL';

-- Down Migration
-- Retain the enum value so existing generation jobs remain readable.
SELECT 1;
