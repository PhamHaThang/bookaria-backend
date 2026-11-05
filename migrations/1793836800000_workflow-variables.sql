-- Up Migration
ALTER TABLE books ADD COLUMN workflow_variables jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(workflow_variables) = 'array');

-- Down Migration
ALTER TABLE books DROP COLUMN workflow_variables;
