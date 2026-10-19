ALTER TABLE cleanup_requests ADD COLUMN project_barriers_required boolean NOT NULL DEFAULT false;
CREATE TABLE cleanup_project_barriers (
  job_id uuid NOT NULL REFERENCES cleanup_requests(job_id) ON DELETE CASCADE,
  collector_id uuid NOT NULL,
  workspace_key text NOT NULL CHECK (workspace_key ~ '^[a-f0-9]{64}$'),
  latest_sequence bigint NOT NULL CHECK (latest_sequence>=0),
  confirmed_sequence bigint NOT NULL CHECK (confirmed_sequence>=0 AND confirmed_sequence<=latest_sequence),
  PRIMARY KEY(job_id,collector_id,workspace_key)
);
