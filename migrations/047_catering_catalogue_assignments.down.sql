LOCK TABLE catering_catalogue_assignment_heads, catering_catalogue_assignment_revisions,
  catering_catalogue_assignment_entries, catering_catalogue_assignment_seals IN ACCESS EXCLUSIVE MODE;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM catering_catalogue_assignment_heads)
    OR EXISTS (SELECT 1 FROM catering_catalogue_assignment_revisions)
    OR EXISTS (SELECT 1 FROM catering_catalogue_assignment_entries)
    OR EXISTS (SELECT 1 FROM catering_catalogue_assignment_seals) THEN
    RAISE EXCEPTION 'CATERING_CATALOGUE_ASSIGNMENT_ROLLBACK_REQUIRES_REVIEW' USING ERRCODE = '55000';
  END IF;
END $$;
DROP TABLE catering_catalogue_assignment_heads;
DROP TABLE catering_catalogue_assignment_seals;
DROP TABLE catering_catalogue_assignment_entries;
DROP TABLE catering_catalogue_assignment_revisions;
DROP FUNCTION verify_catering_catalogue_assignment_revision();
DROP FUNCTION guard_catering_catalogue_assignment_head();
DROP FUNCTION guard_catering_catalogue_assignment_entry();
