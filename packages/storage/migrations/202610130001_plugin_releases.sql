-- Small bounded VSIX artifacts share the existing durable database/backup boundary.
CREATE TABLE plugin_releases (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 version text NOT NULL UNIQUE CHECK(version ~ '^[0-9]+\.[0-9]+\.[0-9]+$'),
 build_id text NOT NULL UNIQUE CHECK(build_id ~ '^[a-f0-9]{64}$'),
 sha256 text NOT NULL CHECK(sha256 ~ '^[a-f0-9]{64}$'),
 bytes integer NOT NULL CHECK(bytes BETWEEN 1 AND 16777216),
 artifact bytea NOT NULL CHECK(octet_length(artifact)=bytes),
 state text NOT NULL DEFAULT 'draft' CHECK(state IN('draft','pilot','released')),
 pilot_user_ids uuid[] NOT NULL DEFAULT '{}',
 uploaded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 published_at timestamptz,
 created_by uuid NOT NULL REFERENCES users(id),
 CHECK((state='released')=(published_at IS NOT NULL))
);
CREATE TABLE plugin_release_channels (
 singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),
 stable_id uuid REFERENCES plugin_releases(id),
 pilot_id uuid REFERENCES plugin_releases(id)
);
INSERT INTO plugin_release_channels(singleton) VALUES(true);
-- A released artifact remains immutable even if another caller bypasses the service.
CREATE FUNCTION protect_released_plugin() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF OLD.state='released' THEN RAISE EXCEPTION 'released plugin is immutable' USING ERRCODE='23514'; END IF;
 IF TG_OP='DELETE' THEN RETURN OLD; END IF;
 RETURN NEW;
END
$$;
CREATE TRIGGER immutable_released_plugin BEFORE UPDATE OR DELETE ON plugin_releases
 FOR EACH ROW EXECUTE FUNCTION protect_released_plugin();
