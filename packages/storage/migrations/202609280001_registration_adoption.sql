-- New rollout: no historical account/Hook inference or eligibility backfill.
ALTER TABLE users ADD COLUMN registered_at timestamptz;
ALTER TABLE users ADD COLUMN email_verified_at timestamptz;
ALTER TABLE users ADD COLUMN adopted_at timestamptz;
ALTER TABLE users ADD CONSTRAINT users_registration_consistent CHECK (
  (registered_at IS NULL AND email_verified_at IS NULL AND adopted_at IS NULL)
  OR (registered_at IS NOT NULL AND email_verified_at IS NOT NULL AND (adopted_at IS NULL OR adopted_at >= registered_at))
);
CREATE INDEX users_registered_idx ON users (registered_at,id) WHERE registered_at IS NOT NULL;
CREATE TABLE registration_challenges (
  email text PRIMARY KEY,
  id uuid NOT NULL,
  code_hash text NOT NULL,
  requested_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 5),
  delivered_at timestamptz,
  consumed_at timestamptz
);
CREATE TABLE registration_rate_limits (
  bucket text PRIMARY KEY,
  window_start timestamptz NOT NULL,
  attempts integer NOT NULL CHECK (attempts >= 0)
);
