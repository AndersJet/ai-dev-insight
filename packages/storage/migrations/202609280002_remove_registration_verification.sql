-- Preserve the checksum of the earlier migration, including for test installs.
-- Registration is self-declared; it must not imply verified mailbox ownership.
ALTER TABLE users DROP CONSTRAINT users_registration_consistent;
ALTER TABLE users DROP COLUMN email_verified_at;
ALTER TABLE users ADD CONSTRAINT users_registration_consistent CHECK (
  (registered_at IS NULL AND adopted_at IS NULL)
  OR (registered_at IS NOT NULL AND (adopted_at IS NULL OR adopted_at >= registered_at))
);
DROP TABLE registration_challenges;
-- registration_rate_limits now limits anonymous registration submissions.
