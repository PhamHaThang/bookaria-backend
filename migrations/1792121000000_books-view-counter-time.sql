-- Up Migration
-- Reading activity increments view_count without changing the book's edit timestamp.
CREATE FUNCTION books_set_updated_at_except_views() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.view_count IS DISTINCT FROM OLD.view_count
     AND (to_jsonb(NEW) - 'view_count' - 'updated_at')
         IS NOT DISTINCT FROM (to_jsonb(OLD) - 'view_count' - 'updated_at') THEN
    NEW.updated_at := OLD.updated_at;
  ELSE
    NEW.updated_at := now();
  END IF;
  RETURN NEW;
END
$$;

DROP TRIGGER books_set_updated_at ON books;
CREATE TRIGGER books_set_updated_at BEFORE UPDATE ON books
  FOR EACH ROW EXECUTE FUNCTION books_set_updated_at_except_views();

-- Down Migration
DROP TRIGGER books_set_updated_at ON books;
DROP FUNCTION books_set_updated_at_except_views();
CREATE TRIGGER books_set_updated_at BEFORE UPDATE ON books
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
