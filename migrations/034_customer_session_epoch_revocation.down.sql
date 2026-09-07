-- Customer-session authorization-epoch revocation is deliberately irreversible.
-- Removing version 34 bookkeeping must never make a pre-cutover session usable again.
SELECT 1;
