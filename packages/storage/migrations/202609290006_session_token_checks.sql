CREATE TABLE session_token_checks (
  session_id uuid PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id),
  run_id uuid REFERENCES session_derivations(id) ON DELETE CASCADE,
  source_key text NOT NULL,
  checked_at timestamptz NOT NULL,
  result jsonb NOT NULL CHECK (jsonb_typeof(result)='object')
);
CREATE INDEX session_token_checks_run ON session_token_checks(run_id);
