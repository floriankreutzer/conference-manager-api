UPDATE sessions
SET revoked_at = GREATEST(issued_at, clock_timestamp())
WHERE revoked_at IS NULL;
