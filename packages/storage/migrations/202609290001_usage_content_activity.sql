-- Separate record changes from verification timestamps and moving query windows.
-- Existing scopes acquire the fingerprint on their next verified publication.
ALTER TABLE usage_scopes ADD COLUMN records_hash text;
ALTER TABLE usage_scopes ADD COLUMN last_content_change_at timestamptz;
ALTER TABLE usage_scopes ADD CONSTRAINT usage_scopes_records_hash_check
  CHECK (records_hash IS NULL OR records_hash ~ '^[a-f0-9]{64}$');
