-- Stream heads contain only identity hashes and ordering barriers. Removing
-- evidence must not lower them and promote a superseded repository again.
CREATE TABLE project_streams (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id),
  collector_id uuid NOT NULL,
  workspace_key text NOT NULL CHECK (workspace_key ~ '^[a-f0-9]{64}$'),
  latest_sequence bigint NOT NULL DEFAULT 0 CHECK (latest_sequence>=0),
  confirmed_sequence bigint NOT NULL DEFAULT 0 CHECK (confirmed_sequence>=0),
  UNIQUE(user_id,collector_id,workspace_key),
  UNIQUE(id,user_id,collector_id)
);
CREATE TABLE project_observations (
  user_id uuid NOT NULL REFERENCES users(id),
  collector_id uuid NOT NULL,
  id uuid NOT NULL,
  sequence bigint NOT NULL CHECK (sequence>0),
  project_id uuid NOT NULL,
  observed_at timestamptz NOT NULL,
  received_at timestamptz NOT NULL,
  source_event_id uuid NOT NULL,
  source_event_at timestamptz NOT NULL,
  source_session_id uuid REFERENCES sessions(id) ON DELETE SET NULL,
  cleanup_generation integer NOT NULL,
  payload_hash text NOT NULL,
  state text NOT NULL CHECK (state IN ('repository','not_git','no_remote','failed','unknown')),
  evidence jsonb NOT NULL CHECK (jsonb_typeof(evidence)='object'),
  PRIMARY KEY(user_id,collector_id,id),
  UNIQUE(user_id,collector_id,sequence),
  FOREIGN KEY(project_id,user_id,collector_id) REFERENCES project_streams(id,user_id,collector_id)
);
CREATE INDEX project_observations_stream ON project_observations(project_id,sequence);
CREATE INDEX project_observations_time ON project_observations(observed_at);
CREATE INDEX project_observations_source_time ON project_observations(source_event_at);
CREATE TABLE project_hook_links (
  event_id uuid NOT NULL,
  occurred_at timestamptz NOT NULL,
  user_id uuid NOT NULL REFERENCES users(id),
  collector_id uuid NOT NULL,
  project_id uuid REFERENCES project_streams(id),
  session_id uuid NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  unresolved_reason text,
  PRIMARY KEY(event_id,occurred_at)
);
CREATE INDEX project_hook_links_project ON project_hook_links(project_id,session_id,occurred_at);
CREATE INDEX project_hook_links_time ON project_hook_links(occurred_at);
