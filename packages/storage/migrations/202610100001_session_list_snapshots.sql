-- Immutable owner payloads are reused by complete, atomically published lists.
-- Payloads may contain private prompt excerpts and participate in user cleanup.
CREATE TABLE session_list_snapshot_entries (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 owner_revision text NOT NULL CHECK(length(owner_revision)>0),
 cleanup_generation integer NOT NULL CHECK(cleanup_generation>=0),
 payload jsonb NOT NULL CHECK(jsonb_typeof(payload)='object'),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX session_list_snapshot_entries_owner ON session_list_snapshot_entries(user_id,cleanup_generation);
CREATE TABLE session_list_snapshots (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 config_key text NOT NULL,
 provider_account text,
 as_of timestamptz NOT NULL,
 expires_at timestamptz NOT NULL CHECK(expires_at>as_of),
 safety_fence jsonb NOT NULL CHECK(jsonb_typeof(safety_fence)='object'),
 owner_entries jsonb NOT NULL CHECK(jsonb_typeof(owner_entries)='object'),
 state text NOT NULL DEFAULT 'published' CHECK(state='published'),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX session_list_snapshots_latest ON session_list_snapshots(config_key,as_of DESC,id DESC);
CREATE INDEX session_list_snapshots_expiration ON session_list_snapshots(expires_at);
