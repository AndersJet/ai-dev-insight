-- Preserve the already-applied 001 checksum. Multiple publications may share
-- as_of; the latest complete publication is then ordered by created_at and id.
DROP INDEX session_list_snapshots_latest;
CREATE INDEX session_list_snapshots_latest ON session_list_snapshots(config_key,as_of DESC,created_at DESC,id DESC);
