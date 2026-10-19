LOCK TABLE catering_orders,catering_order_versions,catering_order_positions,catering_order_version_seals,
  catering_order_heads,catering_order_quotes,catering_order_decisions,catering_order_version_states IN ACCESS EXCLUSIVE MODE;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM catering_orders) OR EXISTS (SELECT 1 FROM catering_order_versions)
    OR EXISTS (SELECT 1 FROM catering_order_positions) OR EXISTS (SELECT 1 FROM catering_order_version_seals)
    OR EXISTS (SELECT 1 FROM catering_order_heads) OR EXISTS (SELECT 1 FROM catering_order_quotes)
    OR EXISTS (SELECT 1 FROM catering_order_decisions) OR EXISTS (SELECT 1 FROM catering_order_version_states) THEN
    RAISE EXCEPTION 'CATERING_ORDER_ROLLBACK_REQUIRES_REVIEW' USING ERRCODE='55000';
  END IF;
END $$;
ALTER TABLE catering_order_versions DROP CONSTRAINT catering_order_previous_version_fk;
DROP TABLE catering_order_version_states;
DROP TABLE catering_order_decisions;
DROP TABLE catering_order_quotes;
DROP TABLE catering_order_heads;
DROP TABLE catering_order_version_seals;
DROP TABLE catering_order_positions;
DROP TABLE catering_order_versions;
DROP TABLE catering_orders;
DROP FUNCTION reject_catering_order_history_mutation();
DROP FUNCTION guard_catering_order_head();
DROP FUNCTION guard_catering_order_position();
DROP FUNCTION verify_catering_order_version();
DROP FUNCTION guard_catering_order_version_state();
DROP FUNCTION verify_catering_order_review_heads();
DROP FUNCTION verify_catering_order_presence();
