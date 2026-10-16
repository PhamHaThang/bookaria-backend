-- Up Migration
-- ---------------------------------------------------------------------------------------------
-- 1. version_assets: protect the assets of PUBLISHED versions.
-- ---------------------------------------------------------------------------------------------
CREATE TABLE version_assets (
  book_version_id uuid NOT NULL REFERENCES book_versions(id) ON DELETE CASCADE,
  asset_id        uuid NOT NULL REFERENCES assets(id) ON DELETE RESTRICT,
  created_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (book_version_id, asset_id)
);
CREATE INDEX version_assets_by_asset ON version_assets (asset_id);
ALTER TABLE version_assets ENABLE ROW LEVEL SECURITY;

-- ---------------------------------------------------------------------------------------------
-- 2. books.page_width_mm: the real printed width of a page.
-- ---------------------------------------------------------------------------------------------
ALTER TABLE books
  ADD COLUMN page_width_mm numeric(5,1) NOT NULL DEFAULT 210
  CONSTRAINT books_page_width_range CHECK (page_width_mm > 0 AND page_width_mm <= 1000);
UPDATE books SET page_width_mm = CASE page_format WHEN 'A5' THEN 148 ELSE 210 END;

-- ---------------------------------------------------------------------------------------------
-- 3. "CHANGED" only for real content changes.
--    Problem (proved): the worker re-scoring a marker (or any bookkeeping column such as revision or
--    updated_at) turned a published book into CHANGED although nothing the reader sees was different.
-- ---------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION pages_mark_book_changed() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND
     (OLD.scene, OLD.settings, OLD.image_asset_id, OLD.marker_mode, OLD.marker_mind_public_id,
      OLD.bookaria_marker_id, OLD.bookaria_marker_transform, OLD.title, OLD.order_index)
     IS NOT DISTINCT FROM
     (NEW.scene, NEW.settings, NEW.image_asset_id, NEW.marker_mode, NEW.marker_mind_public_id,
      NEW.bookaria_marker_id, NEW.bookaria_marker_transform, NEW.title, NEW.order_index) THEN
    RETURN NULL; -- only scoring data, revision or updated_at changed: not published content
  END IF;
  UPDATE books SET status = 'CHANGED'
   WHERE id = COALESCE(NEW.book_id, OLD.book_id) AND status = 'PUBLISHED';
  RETURN NULL;
END
$$;

-- The books side: the page width is content too (it changes how the book is printed).
CREATE OR REPLACE FUNCTION books_mark_changed() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status = 'PUBLISHED' AND NEW.status = 'PUBLISHED' AND (
       (OLD.title, OLD.description, OLD.topic, OLD.language, OLD.age_min, OLD.age_max,
        OLD.page_format, OLD.page_aspect, OLD.page_width_mm, OLD.cover_asset_id)
       IS DISTINCT FROM
       (NEW.title, NEW.description, NEW.topic, NEW.language, NEW.age_min, NEW.age_max,
        NEW.page_format, NEW.page_aspect, NEW.page_width_mm, NEW.cover_asset_id)
     ) THEN
    NEW.status := 'CHANGED';
  END IF;
  RETURN NEW;
END
$$;

-- ---------------------------------------------------------------------------------------------
-- 4. reports.page_id: the API already accepts the page a report is about, but there
--    was no column for it. The index serves the rule "one report per book per device per 24 hours".
-- ---------------------------------------------------------------------------------------------
ALTER TABLE reports ADD COLUMN page_id uuid REFERENCES pages(id) ON DELETE SET NULL;
CREATE INDEX reports_duplicate_check ON reports (book_id, reporter_fingerprint, created_at);

-- ---------------------------------------------------------------------------------------------
-- 5. jobs: error as { code, message } (what the Job DTO returns) and no two open jobs of the same
--    type for the same target. The unique index makes "no parallel publish" race-free, which
--    SELECT ... FOR UPDATE on the book alone does not guarantee for the job rows.
-- ---------------------------------------------------------------------------------------------
ALTER TABLE jobs ALTER COLUMN error TYPE jsonb
  USING CASE WHEN error IS NULL THEN NULL ELSE jsonb_build_object('code', 'UNKNOWN', 'message', error) END;
CREATE UNIQUE INDEX jobs_one_open_per_target ON jobs (ref_type, ref_id, type)
  WHERE status IN ('QUEUED', 'RUNNING');

-- ---------------------------------------------------------------------------------------------
-- 6. book_versions.print_pdf_public_id: where the print PDF of a version lives. The PDF job runs
--    after the version exists, so this ONE column may be filled in later (once, NULL -> value).
--    Clearing published_by when its user is deleted remains allowed.
-- ---------------------------------------------------------------------------------------------
ALTER TABLE book_versions ADD COLUMN print_pdf_public_id text;

CREATE OR REPLACE FUNCTION book_versions_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF (to_jsonb(NEW) - 'published_by' - 'print_pdf_public_id')
       IS DISTINCT FROM (to_jsonb(OLD) - 'published_by' - 'print_pdf_public_id')
     OR (NEW.published_by IS DISTINCT FROM OLD.published_by AND NEW.published_by IS NOT NULL)
     OR (NEW.print_pdf_public_id IS DISTINCT FROM OLD.print_pdf_public_id
         AND (OLD.print_pdf_public_id IS NOT NULL OR NEW.print_pdf_public_id IS NULL)) THEN
    RAISE EXCEPTION 'UPDATE on book_versions is not allowed: the table is append-only (except clearing published_by or setting print_pdf_public_id once)'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END
$$;

-- ---------------------------------------------------------------------------------------------
-- 7. slug: same format as the API, and it never changes once it is set
-- ---------------------------------------------------------------------------------------------
ALTER TABLE books ADD CONSTRAINT books_slug_format
  CHECK (slug IS NULL OR slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$');

CREATE FUNCTION books_slug_immutable() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.slug IS NOT NULL AND NEW.slug IS DISTINCT FROM OLD.slug THEN
    RAISE EXCEPTION 'The slug of a published book never changes' USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER books_slug_immutable_trg BEFORE UPDATE OF slug ON books
  FOR EACH ROW EXECUTE FUNCTION books_slug_immutable();

-- Down Migration
DROP TRIGGER books_slug_immutable_trg ON books;
DROP FUNCTION books_slug_immutable();
ALTER TABLE books DROP CONSTRAINT books_slug_format;

CREATE OR REPLACE FUNCTION book_versions_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.published_by IS NULL
     AND (to_jsonb(NEW) - 'published_by') = (to_jsonb(OLD) - 'published_by') THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'UPDATE on book_versions is not allowed: the table is append-only'
    USING ERRCODE = 'restrict_violation';
END
$$;
ALTER TABLE book_versions DROP COLUMN print_pdf_public_id;

DROP INDEX jobs_one_open_per_target;
ALTER TABLE jobs ALTER COLUMN error TYPE text USING error->>'message';

DROP INDEX reports_duplicate_check;
ALTER TABLE reports DROP COLUMN page_id;

CREATE OR REPLACE FUNCTION books_mark_changed() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status = 'PUBLISHED' AND NEW.status = 'PUBLISHED' AND (
       (OLD.title, OLD.description, OLD.topic, OLD.language, OLD.age_min, OLD.age_max,
        OLD.page_format, OLD.page_aspect, OLD.cover_asset_id)
       IS DISTINCT FROM
       (NEW.title, NEW.description, NEW.topic, NEW.language, NEW.age_min, NEW.age_max,
        NEW.page_format, NEW.page_aspect, NEW.cover_asset_id)
     ) THEN
    NEW.status := 'CHANGED';
  END IF;
  RETURN NEW;
END
$$;
CREATE OR REPLACE FUNCTION pages_mark_book_changed() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  UPDATE books SET status = 'CHANGED'
   WHERE id = COALESCE(NEW.book_id, OLD.book_id) AND status = 'PUBLISHED';
  RETURN NULL;
END
$$;

ALTER TABLE books DROP COLUMN page_width_mm;
DROP TABLE version_assets;
