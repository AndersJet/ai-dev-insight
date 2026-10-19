-- Structural upgrade only on a clean usage dataset. A populated old dataset
-- must go through the separately reviewed, non-destructive transfer workflow.
DO $$ BEGIN
  IF EXISTS(SELECT 1 FROM users LIMIT 1)
    OR EXISTS(SELECT 1 FROM departments LIMIT 1)
    OR EXISTS(SELECT 1 FROM credentials LIMIT 1)
    OR EXISTS(SELECT 1 FROM installations LIMIT 1)
    OR EXISTS(SELECT 1 FROM repository_allowlist LIMIT 1)
    OR EXISTS(SELECT 1 FROM usage_provider_identities LIMIT 1)
    OR EXISTS(SELECT 1 FROM usage_department_catalog LIMIT 1)
    OR EXISTS(SELECT 1 FROM usage_department_mappings LIMIT 1)
    OR EXISTS(SELECT 1 FROM usage_mapping_state LIMIT 1)
    OR EXISTS(SELECT 1 FROM usage_provider_control LIMIT 1)
    OR EXISTS(SELECT 1 FROM hook_events LIMIT 1)
    OR EXISTS(SELECT 1 FROM sessions LIMIT 1)
    OR EXISTS(SELECT 1 FROM session_derivations LIMIT 1)
    OR EXISTS(SELECT 1 FROM project_observations LIMIT 1)
    OR EXISTS(SELECT 1 FROM plugin_project_observations LIMIT 1)
    OR EXISTS(SELECT 1 FROM project_streams LIMIT 1)
    OR EXISTS(SELECT 1 FROM usage_observations LIMIT 1)
    OR EXISTS(SELECT 1 FROM usage_scopes LIMIT 1)
    OR EXISTS(SELECT 1 FROM usage_snapshot_runs LIMIT 1)
    OR EXISTS(SELECT 1 FROM usage_backfills LIMIT 1)
    OR EXISTS(SELECT 1 FROM jobs LIMIT 1)
    OR EXISTS(SELECT 1 FROM login_sessions LIMIT 1)
    OR EXISTS(SELECT 1 FROM cleanup_tombstones LIMIT 1)
    OR EXISTS(SELECT 1 FROM recovery_runs LIMIT 1) THEN
    RAISE EXCEPTION 'independent_clean_dataset_required';
  END IF;
END $$;

ALTER TABLE data_identity ADD COLUMN collection_baseline_at timestamptz;
ALTER TABLE data_identity ADD COLUMN collection_enabled boolean NOT NULL DEFAULT true;
ALTER TABLE data_identity ADD CONSTRAINT collection_baseline_business_day
  CHECK(collection_baseline_at IS NULL OR date_trunc('day',collection_baseline_at AT TIME ZONE 'Asia/Shanghai')=collection_baseline_at AT TIME ZONE 'Asia/Shanghai');
CREATE TABLE dataset_rebuild_state(
  singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),
  source_dataset_id uuid NOT NULL,
  manifest_digest text NOT NULL CHECK(manifest_digest ~ '^[a-f0-9]{64}$'),
  baseline_at timestamptz NOT NULL,
  prepared_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  validation_digest text CHECK(validation_digest ~ '^[a-f0-9]{64}$'),
  opened_at timestamptz
);

ALTER TABLE project_streams ADD COLUMN source_kind text NOT NULL DEFAULT 'hook' CHECK(source_kind IN('hook','plugin'));
ALTER TABLE project_streams ADD COLUMN platform text CHECK(platform IN('macos','windows'));
ALTER TABLE project_streams ADD COLUMN seen_sequence bigint NOT NULL DEFAULT 0 CHECK(seen_sequence>=0);
ALTER TABLE project_streams ADD COLUMN barrier_sequence bigint NOT NULL DEFAULT 0 CHECK(barrier_sequence>=0);
ALTER TABLE project_streams DROP CONSTRAINT project_streams_user_id_collector_id_workspace_key_key;
ALTER TABLE project_streams ADD UNIQUE(user_id,source_kind,collector_id,workspace_key);
ALTER TABLE project_streams ADD UNIQUE(id,user_id,source_kind,collector_id);

ALTER TABLE project_observations ADD COLUMN source_kind text NOT NULL DEFAULT 'hook' CHECK(source_kind IN('hook','plugin'));
ALTER TABLE project_observations ADD COLUMN source_config_id uuid;
ALTER TABLE project_observations ADD COLUMN plugin_version text;
ALTER TABLE project_observations ADD COLUMN state_hash text NOT NULL DEFAULT '';
ALTER TABLE project_observations ALTER COLUMN source_event_id DROP NOT NULL;
ALTER TABLE project_observations ALTER COLUMN source_event_at DROP NOT NULL;
ALTER TABLE project_observations DROP CONSTRAINT project_observations_pkey;
ALTER TABLE project_observations DROP CONSTRAINT project_observations_user_id_collector_id_sequence_key;
ALTER TABLE project_observations ADD PRIMARY KEY(user_id,source_kind,collector_id,id);
ALTER TABLE project_observations ADD UNIQUE(user_id,source_kind,collector_id,sequence);
ALTER TABLE project_observations ADD FOREIGN KEY(project_id,user_id,source_kind,collector_id)
  REFERENCES project_streams(id,user_id,source_kind,collector_id);
ALTER TABLE project_observations ADD CONSTRAINT observation_source_evidence CHECK(
  (source_kind='hook' AND source_event_id IS NOT NULL AND source_event_at IS NOT NULL)
  OR (source_kind='plugin' AND source_event_id IS NULL AND source_event_at IS NULL AND source_session_id IS NULL));

-- Minimal identity/order evidence survives physical removal; no repository,
-- path text, prompt or other readable usage content is retained here.
CREATE TABLE project_observation_keys(
  user_id uuid NOT NULL REFERENCES users(id),
  source_kind text NOT NULL CHECK(source_kind IN('hook','plugin')),
  collector_id uuid NOT NULL,
  observation_id uuid NOT NULL,
  sequence bigint NOT NULL CHECK(sequence>0),
  project_id uuid NOT NULL REFERENCES project_streams(id),
  workspace_key text NOT NULL CHECK(workspace_key ~ '^[a-f0-9]{64}$'),
  payload_hash text NOT NULL CHECK(payload_hash ~ '^[a-f0-9]{64}$'),
  fact_id uuid,
  observed_at timestamptz,
  source_event_at timestamptz,
  received_at timestamptz,
  cleared boolean NOT NULL DEFAULT false,
  PRIMARY KEY(user_id,source_kind,collector_id,observation_id),
  UNIQUE(user_id,source_kind,collector_id,sequence)
);
CREATE INDEX project_observation_keys_time ON project_observation_keys(user_id,observed_at);
ALTER TABLE project_hook_links ADD COLUMN observation_id uuid;
ALTER TABLE project_hook_links ADD COLUMN workspace text;
ALTER TABLE project_hook_links ADD COLUMN platform text CHECK(platform IN('macos','windows'));

ALTER TABLE cleanup_project_barriers ADD COLUMN source_kind text NOT NULL DEFAULT 'hook' CHECK(source_kind IN('hook','plugin'));
ALTER TABLE cleanup_project_barriers ADD COLUMN platform text CHECK(platform IN('macos','windows'));
ALTER TABLE cleanup_project_barriers ADD COLUMN seen_sequence bigint NOT NULL DEFAULT 0 CHECK(seen_sequence>=0);
ALTER TABLE cleanup_project_barriers DROP CONSTRAINT cleanup_project_barriers_pkey;
ALTER TABLE cleanup_project_barriers ADD PRIMARY KEY(job_id,source_kind,collector_id,workspace_key);
CREATE TABLE cleanup_project_keys(
  job_id uuid NOT NULL REFERENCES cleanup_requests(job_id) ON DELETE CASCADE,
  source_kind text NOT NULL CHECK(source_kind IN('hook','plugin')),
  collector_id uuid NOT NULL,
  observation_id uuid NOT NULL,
  sequence bigint NOT NULL CHECK(sequence>0),
  workspace_key text NOT NULL CHECK(workspace_key ~ '^[a-f0-9]{64}$'),
  payload_hash text NOT NULL CHECK(payload_hash ~ '^[a-f0-9]{64}$'),
  PRIMARY KEY(job_id,source_kind,collector_id,observation_id)
);

-- The guard above guarantees no old anonymous history is destroyed or promoted.
DROP TABLE plugin_project_observations;
