-- Up Migration
-- Bookaria scores were legacy 0-5 stars, not the current independent MindAR metrics.
UPDATE bookaria_markers SET marker_score = NULL WHERE marker_score IS NOT NULL;

-- Down Migration
-- A legacy score cannot be reconstructed from an unassessed marker.
SELECT 1;
