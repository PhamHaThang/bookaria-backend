-- Up Migration
-- Create table for bookaria_markers, books, book_versions, pages, page_assets, preview_links.
CREATE TABLE bookaria_markers (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  number          integer NOT NULL UNIQUE CHECK (number > 0),
  image_public_id text NOT NULL,
  seed            bigint NOT NULL UNIQUE,
  mind_public_id  text NOT NULL,
  validated_at    timestamptz,                  -- only validated markers are handed out to pages
  marker_score    smallint CHECK (marker_score BETWEEN 0 AND 5),
  is_active       boolean NOT NULL DEFAULT true,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE books (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id               uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  title                  varchar(200) NOT NULL,
  description            text,
  topic                  varchar(50),
  language               varchar(10) NOT NULL DEFAULT 'vi',
  age_min                smallint,
  age_max                smallint,
  page_format            page_format NOT NULL DEFAULT 'A4',
  page_aspect            numeric(6,4) NOT NULL DEFAULT 1.4142 CHECK (page_aspect > 0),  -- height / width
  cover_asset_id         uuid REFERENCES assets(id) ON DELETE SET NULL,
  visibility             book_visibility NOT NULL DEFAULT 'PRIVATE',
  status                 book_status NOT NULL DEFAULT 'DRAFT',
  slug                   varchar(80) UNIQUE,    -- NULL until the first publish, never changes after
  current_version_id     uuid,                  -- foreign key added below (books <-> book_versions is circular)
  is_template            boolean NOT NULL DEFAULT false,
  view_count             bigint NOT NULL DEFAULT 0,
  first_published_at     timestamptz,
  taken_down_at          timestamptz,
  taken_down_reason      text,
  visibility_before_lock book_visibility,
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now(),
  deleted_at             timestamptz,           -- soft delete: 30 days in the trash
  CONSTRAINT books_age_min_range CHECK (age_min IS NULL OR age_min BETWEEN 0 AND 18),
  CONSTRAINT books_age_max_range CHECK (age_max IS NULL OR age_max BETWEEN 0 AND 18),
  CONSTRAINT books_age_order     CHECK (age_min IS NULL OR age_max IS NULL OR age_min <= age_max),
  CONSTRAINT books_published_has_slug CHECK (status = 'DRAFT' OR slug IS NOT NULL),
  CONSTRAINT books_taken_down_is_private CHECK (taken_down_at IS NULL OR visibility = 'PRIVATE'),
  CONSTRAINT books_taken_down_has_reason CHECK ((taken_down_at IS NULL) = (taken_down_reason IS NULL))
);

CREATE INDEX books_by_owner ON books (owner_id, updated_at DESC) WHERE deleted_at IS NULL;
CREATE INDEX books_public_listing ON books (topic, language, first_published_at DESC)
  WHERE visibility = 'PUBLIC' AND deleted_at IS NULL;
CREATE INDEX books_title_trgm ON books USING gin (title gin_trgm_ops);

CREATE TRIGGER books_set_updated_at BEFORE UPDATE ON books
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- A published book that gets edited becomes CHANGED. This is the books side: editing
-- the book's own content columns. Changing visibility, slug, status itself does not count.
CREATE FUNCTION books_mark_changed() RETURNS trigger
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

CREATE TRIGGER books_mark_changed_trg BEFORE UPDATE ON books
  FOR EACH ROW EXECUTE FUNCTION books_mark_changed();

CREATE TABLE book_versions (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  book_id            uuid NOT NULL REFERENCES books(id) ON DELETE CASCADE,
  version_no         integer NOT NULL CHECK (version_no > 0),
  schema_version     smallint NOT NULL,
  manifest_public_id text NOT NULL,
  mind_groups        jsonb NOT NULL,        -- [{ group, public_id, page_ids }], at most 10 pages per group
  page_count         smallint NOT NULL,
  ar_page_count      smallint NOT NULL,
  total_size_bytes   bigint NOT NULL,
  published_by       uuid REFERENCES users(id) ON DELETE SET NULL,
  published_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT book_versions_unique_no UNIQUE (book_id, version_no)
);

-- Versions are immutable: only inserts (and cascade deletes with the book).
-- One exception: when the publisher's account is deleted, the foreign key (ON DELETE SET NULL)
-- must be able to clear published_by. Any other change is refused.
CREATE FUNCTION book_versions_guard() RETURNS trigger
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

CREATE TRIGGER book_versions_immutable BEFORE UPDATE ON book_versions
  FOR EACH ROW EXECUTE FUNCTION book_versions_guard();
CREATE TRIGGER book_versions_no_truncate BEFORE TRUNCATE ON book_versions
  FOR EACH STATEMENT EXECUTE FUNCTION forbid_change();

ALTER TABLE books
  ADD CONSTRAINT books_current_version_fk
  FOREIGN KEY (current_version_id) REFERENCES book_versions(id) ON DELETE SET NULL;

CREATE TABLE pages (
  id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  book_id                   uuid NOT NULL REFERENCES books(id) ON DELETE CASCADE,
  order_index               integer NOT NULL CHECK (order_index >= 0),
  title                     varchar(150),
  image_asset_id            uuid NOT NULL REFERENCES assets(id) ON DELETE RESTRICT,
  marker_mode               marker_mode NOT NULL DEFAULT 'BOOKARIA_MARKER',
  marker_score              smallint CHECK (marker_score BETWEEN 0 AND 5),   -- custom markers only
  marker_features           integer CHECK (marker_features >= 0),
  marker_report             jsonb,
  marker_mind_public_id     text,                                            -- custom markers only
  bookaria_marker_id        uuid REFERENCES bookaria_markers(id) ON DELETE RESTRICT,
  bookaria_marker_transform jsonb,
  scene                     jsonb NOT NULL DEFAULT '{"schemaVersion":1,"objects":[],"interactions":[]}',
  settings                  jsonb NOT NULL DEFAULT '{}',
  revision                  integer NOT NULL DEFAULT 0,                      -- optimistic lock
  created_at                timestamptz NOT NULL DEFAULT now(),
  updated_at                timestamptz NOT NULL DEFAULT now(),
  -- DEFERRABLE so that several pages can swap places inside one transaction
  CONSTRAINT pages_order_unique UNIQUE (book_id, order_index) DEFERRABLE INITIALLY DEFERRED,
  -- each Bookaria marker number is used once per book (NULLs are allowed many times)
  CONSTRAINT pages_marker_unique_per_book UNIQUE (book_id, bookaria_marker_id),
  CONSTRAINT pages_bookaria_marker_iff_mode
    CHECK ((marker_mode = 'BOOKARIA_MARKER') = (bookaria_marker_id IS NOT NULL)),
  CONSTRAINT pages_custom_marker_has_mind
    CHECK ((marker_mode = 'CUSTOM_MARKER') = (marker_mind_public_id IS NOT NULL))
);

CREATE TRIGGER pages_set_updated_at BEFORE UPDATE ON pages
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- The page image must be a READY image that belongs to the book's author or to the shared library.
CREATE FUNCTION pages_check_image() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  img assets%ROWTYPE;
  book_owner uuid;
BEGIN
  SELECT * INTO img FROM assets WHERE id = NEW.image_asset_id;
  SELECT owner_id INTO book_owner FROM books WHERE id = NEW.book_id;
  IF img.type <> 'IMAGE' OR img.status <> 'READY' OR img.deleted_at IS NOT NULL
     OR (img.owner_id IS NOT NULL AND img.owner_id <> book_owner) THEN
    RAISE EXCEPTION 'The image of a page must be a READY image of the author or of the shared library'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER pages_check_image_trg
  BEFORE INSERT OR UPDATE OF image_asset_id ON pages
  FOR EACH ROW EXECUTE FUNCTION pages_check_image();

-- A published book whose pages change becomes CHANGED.
CREATE FUNCTION pages_mark_book_changed() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  UPDATE books SET status = 'CHANGED'
   WHERE id = COALESCE(NEW.book_id, OLD.book_id) AND status = 'PUBLISHED';
  RETURN NULL;
END
$$;

CREATE TRIGGER pages_mark_book_changed_trg
  AFTER INSERT OR UPDATE OR DELETE ON pages
  FOR EACH ROW EXECUTE FUNCTION pages_mark_book_changed();

CREATE TABLE page_assets (
  page_id    uuid NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  asset_id   uuid NOT NULL REFERENCES assets(id) ON DELETE RESTRICT,  -- RESTRICT blocks deleting an asset in use
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (page_id, asset_id)
);
CREATE INDEX page_assets_by_asset ON page_assets (asset_id);

CREATE TABLE preview_links (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  book_id     uuid NOT NULL REFERENCES books(id) ON DELETE CASCADE,
  token       varchar(32) NOT NULL UNIQUE,
  manifest    jsonb NOT NULL,
  mind_groups jsonb,
  created_by  uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at  timestamptz NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX preview_links_by_expiry ON preview_links (expires_at);

-- Down Migration
DROP TABLE preview_links;
DROP TABLE page_assets;
DROP TRIGGER pages_mark_book_changed_trg ON pages;
DROP FUNCTION pages_mark_book_changed();
DROP TRIGGER pages_check_image_trg ON pages;
DROP FUNCTION pages_check_image();
DROP TABLE pages;
ALTER TABLE books DROP CONSTRAINT books_current_version_fk;
DROP TABLE book_versions;
DROP FUNCTION book_versions_guard();
DROP TRIGGER books_mark_changed_trg ON books;
DROP FUNCTION books_mark_changed();
DROP TABLE books;
DROP TABLE bookaria_markers;
