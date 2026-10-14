-- Up Migration
-- Existing pages keep their assigned marker; only new assignments require an active marker.
CREATE FUNCTION pages_check_active_bookaria_marker() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  marker_active boolean;
BEGIN
  IF NEW.marker_mode = 'BOOKARIA_MARKER' THEN
    SELECT is_active INTO marker_active
      FROM bookaria_markers WHERE id = NEW.bookaria_marker_id;
    IF marker_active IS NOT TRUE THEN
      RAISE EXCEPTION 'A page cannot use an inactive Bookaria marker'
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER pages_check_active_bookaria_marker_trg
  BEFORE INSERT OR UPDATE OF marker_mode, bookaria_marker_id ON pages
  FOR EACH ROW EXECUTE FUNCTION pages_check_active_bookaria_marker();

-- Down Migration
DROP TRIGGER pages_check_active_bookaria_marker_trg ON pages;
DROP FUNCTION pages_check_active_bookaria_marker();
