-- Up Migration

-- Create tables for asset_categories and assets.
CREATE TABLE asset_categories (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        varchar(100) NOT NULL,
  slug        varchar(100) NOT NULL UNIQUE,
  parent_id   uuid REFERENCES asset_categories(id) ON DELETE RESTRICT,
  sort_order  smallint NOT NULL DEFAULT 0,
  created_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT asset_categories_not_own_parent CHECK (parent_id <> id)
);

CREATE TABLE assets (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id            uuid REFERENCES users(id) ON DELETE CASCADE,     -- NULL = shared library
  category_id         uuid REFERENCES asset_categories(id) ON DELETE SET NULL,
  type                asset_type NOT NULL,
  name                varchar(150) NOT NULL,
  original_public_id  text NOT NULL,
  resource_type       varchar(10) NOT NULL,                              -- Cloudinary: image | video | raw
  optimized_public_id text,
  thumbnail_url       text,
  format              varchar(10) NOT NULL,
  size_bytes          bigint NOT NULL CHECK (size_bytes > 0),
  status              asset_status NOT NULL DEFAULT 'PROCESSING',
  error               text,
  meta                jsonb NOT NULL DEFAULT '{}',
  tags                text[] NOT NULL DEFAULT '{}',
  license             varchar(50),
  author_name         varchar(150),
  source_url          text,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  deleted_at          timestamptz,
  -- a shared-library asset must carry its license and original author
  CONSTRAINT assets_library_needs_credit
    CHECK (owner_id IS NOT NULL OR (license IS NOT NULL AND author_name IS NOT NULL))
);

CREATE INDEX assets_by_owner ON assets (owner_id, type, created_at DESC) WHERE deleted_at IS NULL;
CREATE INDEX assets_library_by_category ON assets (category_id, type) WHERE owner_id IS NULL;
CREATE INDEX assets_tags ON assets USING gin (tags);
CREATE INDEX assets_name_trgm ON assets USING gin (name gin_trgm_ops);

CREATE TRIGGER assets_set_updated_at BEFORE UPDATE ON assets
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- users.storage_used_bytes always equals the total size of the owner's assets that are not deleted. Counted: insert, soft delete / restore, size change, hard delete.
CREATE FUNCTION assets_sync_storage() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  old_bytes bigint := 0;
  new_bytes bigint := 0;
BEGIN
  IF TG_OP IN ('UPDATE', 'DELETE') AND OLD.owner_id IS NOT NULL AND OLD.deleted_at IS NULL THEN
    old_bytes := OLD.size_bytes;
  END IF;
  IF TG_OP IN ('INSERT', 'UPDATE') AND NEW.owner_id IS NOT NULL AND NEW.deleted_at IS NULL THEN
    new_bytes := NEW.size_bytes;
  END IF;

  IF TG_OP = 'UPDATE' AND OLD.owner_id IS DISTINCT FROM NEW.owner_id THEN
    -- ownership change: take it from the old owner and give it to the new one
    IF OLD.owner_id IS NOT NULL THEN
      UPDATE users SET storage_used_bytes = storage_used_bytes - old_bytes WHERE id = OLD.owner_id;
    END IF;
    IF NEW.owner_id IS NOT NULL THEN
      UPDATE users SET storage_used_bytes = storage_used_bytes + new_bytes WHERE id = NEW.owner_id;
    END IF;
  ELSIF new_bytes <> old_bytes THEN
    UPDATE users
       SET storage_used_bytes = storage_used_bytes + (new_bytes - old_bytes)
     WHERE id = COALESCE(NEW.owner_id, OLD.owner_id);
  END IF;

  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER assets_sync_storage_trg
  AFTER INSERT OR UPDATE OF size_bytes, deleted_at, owner_id OR DELETE ON assets
  FOR EACH ROW EXECUTE FUNCTION assets_sync_storage();

-- Down Migration
DROP TRIGGER assets_sync_storage_trg ON assets;
DROP FUNCTION assets_sync_storage();
DROP TABLE assets;
DROP TABLE asset_categories;
