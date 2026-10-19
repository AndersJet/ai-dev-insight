-- Hook admission advances only existing periodic jobs. Locate its provider
-- namespaces by the authenticated owner without scanning all identities.
CREATE INDEX usage_identity_user ON usage_provider_identities(user_id,provider_account);
