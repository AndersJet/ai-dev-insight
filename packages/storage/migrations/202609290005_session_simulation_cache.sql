CREATE TABLE session_simulation_cache (
  session_id uuid PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id),
  run_id uuid NOT NULL REFERENCES session_derivations(id) ON DELETE CASCADE,
  cache_key text NOT NULL,
  result jsonb NOT NULL CHECK (jsonb_typeof(result)='object')
);
CREATE INDEX session_simulation_cache_run ON session_simulation_cache(run_id);
