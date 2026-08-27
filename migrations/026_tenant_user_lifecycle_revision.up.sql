ALTER TABLE users
  ADD COLUMN lifecycle_revision bigint NOT NULL DEFAULT 1,
  ADD CONSTRAINT users_lifecycle_revision_valid CHECK (lifecycle_revision >= 1);

CREATE FUNCTION prevent_user_lifecycle_revision_decrease()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.lifecycle_revision < OLD.lifecycle_revision THEN
    RAISE EXCEPTION 'lifecycle_revision cannot decrease' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER users_lifecycle_revision_monotonic
BEFORE UPDATE OF lifecycle_revision ON users
FOR EACH ROW
EXECUTE FUNCTION prevent_user_lifecycle_revision_decrease();
