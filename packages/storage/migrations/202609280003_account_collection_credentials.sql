-- Existing installations and their historical event references remain intact.
-- Older hash-only credentials require an explicit reset before personal download.
ALTER TABLE installations ADD COLUMN credential_ciphertext text;
CREATE UNIQUE INDEX installations_one_shared_credential
  ON installations(user_id) WHERE enabled AND credential_ciphertext IS NOT NULL;
