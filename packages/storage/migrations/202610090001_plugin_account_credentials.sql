-- Account identity is independent of an individual collector and Web sessions.
CREATE TABLE plugin_account_credentials (
  user_id uuid PRIMARY KEY REFERENCES users(id),
  token_hash text NOT NULL UNIQUE CHECK(token_hash ~ '^[a-f0-9]{64}$'),
  credential_ciphertext text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE plugin_collectors (
  collector_id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id),
  source_config_id uuid NOT NULL,
  source_secret_hash text NOT NULL CHECK(source_secret_hash ~ '^[a-f0-9]{64}$'),
  platform text NOT NULL CHECK(platform IN('macos','windows')),
  plugin_version text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  last_seen timestamptz
);
CREATE INDEX plugin_collectors_user ON plugin_collectors(user_id,created_at,collector_id);
