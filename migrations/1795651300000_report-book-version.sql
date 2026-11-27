-- Up Migration
ALTER TABLE reports
    ADD COLUMN book_version_id uuid REFERENCES book_versions(id) ON DELETE SET NULL,
    ADD COLUMN reported_page_id uuid;

UPDATE reports SET reported_page_id = page_id WHERE page_id IS NOT NULL;

-- Down Migration
ALTER TABLE reports DROP COLUMN reported_page_id, DROP COLUMN book_version_id;
