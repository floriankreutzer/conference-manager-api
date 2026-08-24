DROP TABLE sessions;

ALTER TABLE users
  DROP CONSTRAINT users_security_version_valid,
  DROP COLUMN security_version;
