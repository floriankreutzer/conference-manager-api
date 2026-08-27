LOCK TABLE users IN ACCESS EXCLUSIVE MODE;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM users
    WHERE lifecycle_revision > 1
    LIMIT 1
  ) THEN
    RAISE EXCEPTION 'TENANT_USER_LIFECYCLE_REVISIONS_REQUIRE_REVIEW' USING ERRCODE = '55000';
  END IF;
END;
$$;

DROP TRIGGER users_lifecycle_revision_monotonic ON users;
DROP FUNCTION prevent_user_lifecycle_revision_decrease();

ALTER TABLE users
  DROP COLUMN lifecycle_revision;
