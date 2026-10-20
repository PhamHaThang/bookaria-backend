-- Up Migration
-- Freeze print inputs with the publication, never reconstruct old print data from a new draft.
ALTER TABLE book_versions ADD COLUMN print_source jsonb;
-- Existing book_versions_guard uses to_jsonb, so it also protects this new column.

-- Down Migration
ALTER TABLE book_versions DROP COLUMN print_source;
