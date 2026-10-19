CREATE TABLE repository_allowlist (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind text NOT NULL CHECK (kind IN ('host','repository')),
  value text NOT NULL CHECK (length(value) BETWEEN 1 AND 4096),
  value_hash text NOT NULL CHECK (value_hash ~ '^[a-f0-9]{64}$'),
  version integer NOT NULL DEFAULT 1 CHECK (version>0),
  created_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (kind,value_hash)
);
