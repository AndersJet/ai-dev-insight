-- Only the independent plugin channel's new table; no historical backfill,
-- expiry, partitions, Hook/user foreign keys or cleanup side tables.
CREATE TABLE plugin_project_observations (
  observation_id uuid NOT NULL,
  collector_id uuid NOT NULL,
  sequence bigint NOT NULL CHECK (sequence > 0),
  nt_email text NOT NULL CHECK (length(nt_email) <= 254),
  source_config_id uuid NOT NULL,
  platform text NOT NULL CHECK (platform IN ('macos','windows')),
  workspace_path text NOT NULL CHECK (length(workspace_path) BETWEEN 1 AND 4096),
  workspace_key text NOT NULL CHECK (workspace_key ~ '^[a-f0-9]{64}$'),
  observed_at timestamptz NOT NULL,
  received_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  state text NOT NULL CHECK (state IN ('repository','not_git','no_remote','failed','unknown')),
  reason text,
  git_root text,
  remotes jsonb NOT NULL CHECK (jsonb_typeof(remotes)='array'),
  plugin_version text NOT NULL,
  payload_hash text NOT NULL,
  PRIMARY KEY(collector_id,observation_id),
  UNIQUE(collector_id,sequence)
);
CREATE INDEX plugin_observations_project ON plugin_project_observations(nt_email,collector_id,workspace_key,sequence DESC);
CREATE INDEX plugin_observations_time ON plugin_project_observations(observed_at DESC);
