-- Runs only on a NEW PostgreSQL data directory, never as an application migration.
-- psql reads the secret from its environment rather than a command argument.
\getenv app_password ADI_APP_DB_PASSWORD
CREATE ROLE adi_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION PASSWORD :'app_password';
GRANT CONNECT, CREATE ON DATABASE adi TO adi_app;
CREATE EXTENSION IF NOT EXISTS btree_gist WITH SCHEMA public;
CREATE EXTENSION IF NOT EXISTS pg_trgm WITH SCHEMA public;
