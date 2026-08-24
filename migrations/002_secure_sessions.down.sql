DROP TABLE sessions;

DROP TRIGGER users_security_version_monotonic ON users;
DROP FUNCTION prevent_user_security_version_decrease();

ALTER TABLE users
  DROP CONSTRAINT users_security_version_valid,
  DROP COLUMN security_version;
