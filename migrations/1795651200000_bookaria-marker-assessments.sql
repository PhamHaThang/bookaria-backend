-- Up Migration
ALTER TABLE bookaria_markers
    ADD COLUMN assessment jsonb,
    DROP COLUMN marker_score;

-- Down Migration
ALTER TABLE bookaria_markers
    ADD COLUMN marker_score smallint CHECK (marker_score BETWEEN 0 AND 5),
    DROP COLUMN assessment;
