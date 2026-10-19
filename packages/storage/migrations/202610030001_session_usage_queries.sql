CREATE TABLE session_usage_queries (
 provider_account text NOT NULL,
 session_id uuid NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
 user_id uuid NOT NULL REFERENCES users(id),
 provider_user_id text NOT NULL,
 cleanup_generation integer NOT NULL,
 ingest_epoch integer NOT NULL,
 hook_key text NOT NULL,
 observed_at timestamptz NOT NULL,
 revision bigint NOT NULL DEFAULT 1,
 result jsonb NOT NULL CHECK(jsonb_typeof(result)='object'),
 PRIMARY KEY(provider_account,session_id),
 FOREIGN KEY(user_id,session_id) REFERENCES sessions(user_id,id)
);
CREATE INDEX session_usage_queries_owner ON session_usage_queries(provider_account,user_id);
