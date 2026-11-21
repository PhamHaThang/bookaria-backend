-- Up Migration
ALTER TABLE upload_intents DROP CONSTRAINT upload_intents_purpose_check;
ALTER TABLE upload_intents ADD CONSTRAINT upload_intents_purpose_check
  CHECK (purpose IN ('ASSET', 'PAGE_IMAGE', 'AVATAR', 'MARKER_MIND', 'MODEL_INPUT'));
CREATE INDEX upload_intents_model_expiry ON upload_intents (expires_at)
  WHERE purpose = 'MODEL_INPUT';
CREATE INDEX jobs_model_inputs_by_owner ON jobs (created_by, created_at DESC)
  WHERE payload ? 'modelInputName';

-- Down Migration
DROP INDEX upload_intents_model_expiry;
DROP INDEX jobs_model_inputs_by_owner;
DELETE FROM upload_intents WHERE purpose = 'MODEL_INPUT';
ALTER TABLE upload_intents DROP CONSTRAINT upload_intents_purpose_check;
ALTER TABLE upload_intents ADD CONSTRAINT upload_intents_purpose_check
  CHECK (purpose IN ('ASSET', 'PAGE_IMAGE', 'AVATAR', 'MARKER_MIND'));
