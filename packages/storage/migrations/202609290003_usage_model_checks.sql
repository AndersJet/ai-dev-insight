CREATE TABLE usage_model_checks (
  scope_id uuid PRIMARY KEY REFERENCES usage_scopes(id) ON DELETE CASCADE,
  source_key text NOT NULL,
  owner_key text NOT NULL,
  source_revision integer NOT NULL,
  cleanup_generation integer NOT NULL,
  checked_at timestamptz NOT NULL,
  result jsonb NOT NULL CHECK (jsonb_typeof(result)='object')
);
