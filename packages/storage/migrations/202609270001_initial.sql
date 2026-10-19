-- Up Migration
-- Fresh PostgreSQL application schema. No legacy import or cutback compatibility.
SELECT pg_advisory_xact_lock(hashtextextended('adi:extension:btree_gist',0));
CREATE EXTENSION IF NOT EXISTS btree_gist WITH SCHEMA public;

CREATE FUNCTION record_job_status_since() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
      BEGIN IF NEW.status IS DISTINCT FROM OLD.status THEN NEW.status_since=clock_timestamp(); END IF; RETURN NEW; END;
    $$;

CREATE TABLE audit_events (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    actor_id uuid,
    action text NOT NULL,
    target_id uuid,
    scope_id uuid,
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT audit_system_actor CHECK (((actor_id IS NOT NULL) OR (action = ANY (ARRAY['configuration_admin_retired'::text, 'configuration_admin_synchronized'::text]))))
);

CREATE TABLE cleanup_journal_parts (
    job_id uuid NOT NULL,
    part integer NOT NULL,
    digest text NOT NULL,
    session_count integer NOT NULL
);

CREATE TABLE cleanup_previews (
    id uuid NOT NULL,
    creator_id uuid NOT NULL,
    user_id uuid NOT NULL,
    from_at timestamp with time zone NOT NULL,
    to_at timestamp with time zone NOT NULL,
    fingerprint text NOT NULL,
    counts jsonb NOT NULL,
    target_email text NOT NULL,
    target_name text NOT NULL,
    target_version integer NOT NULL,
    cleanup_generation integer NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT cleanup_previews_check CHECK ((to_at > from_at))
);

CREATE TABLE cleanup_requests (
    job_id uuid NOT NULL,
    dataset_id uuid NOT NULL,
    preview_id uuid NOT NULL,
    creator_id uuid NOT NULL,
    executor_id uuid NOT NULL,
    executor_auth_version integer NOT NULL,
    user_id uuid NOT NULL,
    target_email text NOT NULL,
    from_at timestamp with time zone NOT NULL,
    to_at timestamp with time zone NOT NULL,
    cleanup_generation integer NOT NULL,
    request_hash text NOT NULL,
    idempotency_hash text NOT NULL,
    phase text DEFAULT 'journal'::text NOT NULL,
    journal_digest text,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    acceptance_digest text,
    CONSTRAINT cleanup_requests_acceptance_digest_check CHECK ((acceptance_digest ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT cleanup_requests_check CHECK ((to_at > from_at))
);

CREATE TABLE cleanup_sessions (
    job_id uuid NOT NULL,
    session_id uuid NOT NULL
);

CREATE TABLE cleanup_tombstones (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    from_at timestamp with time zone NOT NULL,
    to_at timestamp with time zone NOT NULL,
    generation integer NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT cleanup_tombstones_check CHECK ((to_at > from_at)),
    CONSTRAINT cleanup_tombstones_generation_check CHECK ((generation > 0))
);

CREATE TABLE credentials (
    user_id uuid NOT NULL,
    password_hash text NOT NULL,
    must_change boolean DEFAULT true NOT NULL,
    temporary_expires_at timestamp with time zone,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT credentials_check CHECK (((NOT must_change) OR (temporary_expires_at IS NOT NULL)))
);

CREATE TABLE data_identity (
    singleton boolean DEFAULT true NOT NULL,
    dataset_id uuid DEFAULT gen_random_uuid() NOT NULL,
    recovery_id uuid,
    retention_cutoff timestamp with time zone,
    CONSTRAINT data_identity_singleton_check CHECK (singleton)
);

CREATE TABLE database_monitor_state (
    singleton boolean DEFAULT true NOT NULL,
    observation jsonb,
    observed_at timestamp with time zone,
    next_run_at timestamp with time zone DEFAULT now() NOT NULL,
    last_error text,
    revision bigint DEFAULT 0 NOT NULL,
    CONSTRAINT database_monitor_state_singleton_check CHECK (singleton)
);

CREATE TABLE departments (
    id uuid NOT NULL,
    name text NOT NULL,
    version integer DEFAULT 1 NOT NULL,
    deleted_at timestamp with time zone,
    CONSTRAINT departments_name_check CHECK ((btrim(name) <> ''::text)),
    CONSTRAINT departments_version_check CHECK ((version > 0))
);

CREATE TABLE eligibility_periods (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    included boolean NOT NULL,
    valid_from timestamp with time zone NOT NULL,
    valid_to timestamp with time zone,
    CONSTRAINT eligibility_periods_check CHECK (((valid_to IS NULL) OR (valid_to > valid_from)))
);

CREATE TABLE event_keys (
    installation_id uuid NOT NULL,
    client_event_id text NOT NULL,
    event_id uuid NOT NULL,
    occurred_at timestamp with time zone NOT NULL,
    payload_hash text NOT NULL,
    first_seen timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE hook_events (
    id uuid NOT NULL,
    occurred_at timestamp with time zone NOT NULL,
    received_at timestamp with time zone DEFAULT now() NOT NULL,
    user_id uuid NOT NULL,
    department_id uuid,
    installation_id uuid NOT NULL,
    session_id uuid NOT NULL,
    event_type text NOT NULL,
    payload jsonb NOT NULL,
    schema_version integer DEFAULT 1 NOT NULL,
    identity_quality text DEFAULT 'installation'::text NOT NULL,
    timestamp_source text DEFAULT 'unknown'::text NOT NULL,
    capture_generation integer DEFAULT 0 NOT NULL,
    CONSTRAINT hook_events_payload_check CHECK ((jsonb_typeof(payload) = 'object'::text)),
    CONSTRAINT hook_events_timestamp_source_check CHECK ((timestamp_source = ANY (ARRAY['client_observed'::text, 'source_reported'::text, 'unknown'::text])))
)
PARTITION BY RANGE (occurred_at);

CREATE TABLE import_batches (
    id uuid NOT NULL,
    creator_id uuid NOT NULL,
    creator_auth_version integer NOT NULL,
    department_id uuid NOT NULL,
    department_version integer NOT NULL,
    mode text NOT NULL,
    source_name text NOT NULL,
    rows jsonb NOT NULL,
    counts jsonb NOT NULL,
    preview_hash text NOT NULL,
    status text DEFAULT 'previewed'::text NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    job_id uuid,
    idempotency_key text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT import_batches_mode_check CHECK ((mode = ANY (ARRAY['insert_only'::text, 'upsert'::text]))),
    CONSTRAINT import_batches_status_check CHECK ((status = ANY (ARRAY['previewed'::text, 'queued'::text, 'succeeded'::text, 'failed'::text])))
);

CREATE TABLE installations (
    id uuid NOT NULL,
    user_id uuid NOT NULL,
    token_hash text NOT NULL,
    label text NOT NULL,
    enabled boolean DEFAULT true NOT NULL,
    last_seen timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    revoked_at timestamp with time zone,
    CONSTRAINT installation_revocation CHECK (((revoked_at IS NULL) OR (NOT enabled))),
    CONSTRAINT installations_token_hash_check CHECK ((token_hash ~ '^[0-9a-f]{64}$'::text))
);

CREATE TABLE jobs (
    id uuid NOT NULL,
    kind text NOT NULL,
    dedupe_key text NOT NULL,
    payload jsonb DEFAULT '{}'::jsonb NOT NULL,
    status text DEFAULT 'queued'::text NOT NULL,
    generation integer DEFAULT 1 NOT NULL,
    attempt integer DEFAULT 0 NOT NULL,
    available_at timestamp with time zone DEFAULT now() NOT NULL,
    lease_until timestamp with time zone,
    progress jsonb DEFAULT '{}'::jsonb NOT NULL,
    error_code text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    lease_token uuid,
    status_since timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT jobs_status_check CHECK ((status = ANY (ARRAY['queued'::text, 'running'::text, 'succeeded'::text, 'failed'::text, 'cancelled'::text])))
);

CREATE TABLE login_sessions (
    token_hash text NOT NULL,
    user_id uuid NOT NULL,
    auth_version integer NOT NULL,
    csrf_hash text NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT login_sessions_csrf_hash_check CHECK ((csrf_hash ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT login_sessions_token_hash_check CHECK ((token_hash ~ '^[0-9a-f]{64}$'::text))
);

CREATE TABLE membership_periods (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    department_id uuid NOT NULL,
    valid_from timestamp with time zone NOT NULL,
    valid_to timestamp with time zone,
    CONSTRAINT membership_periods_time_range CHECK (((valid_to IS NULL) OR (valid_to >= valid_from)))
);

CREATE TABLE monitor_alert_events (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    payload jsonb NOT NULL,
    target text,
    status text NOT NULL,
    attempt integer DEFAULT 0 NOT NULL,
    lease_token uuid,
    lease_until timestamp with time zone,
    available_at timestamp with time zone DEFAULT now() NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    last_error text
);

CREATE TABLE monitor_alerts (
    key text NOT NULL,
    severity text NOT NULL,
    subject text,
    value text,
    last_observed_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE personal_model_revisions (
    user_id uuid NOT NULL,
    revision bigint DEFAULT 0 NOT NULL
);

CREATE TABLE recovery_access_reviews (
    id uuid NOT NULL,
    run_id uuid NOT NULL,
    snapshot_digest text NOT NULL,
    target_digest text NOT NULL,
    checkpoint_digest text NOT NULL,
    bootstrap_user_id uuid NOT NULL,
    bootstrap_email text NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL
);

CREATE TABLE recovery_cleanup_operations (
    job_id uuid NOT NULL,
    run_id uuid NOT NULL,
    record jsonb NOT NULL,
    journal_digest text NOT NULL,
    user_id uuid,
    cleanup_generation integer NOT NULL,
    phase text DEFAULT 'events'::text NOT NULL,
    progress jsonb DEFAULT '{}'::jsonb NOT NULL,
    complete boolean DEFAULT false NOT NULL,
    absent_user boolean DEFAULT false NOT NULL,
    accepted_digest text,
    manifest_digest text,
    operation_id uuid NOT NULL
);

CREATE TABLE recovery_cleanup_sessions (
    job_id uuid NOT NULL,
    session_id uuid NOT NULL
);

CREATE TABLE recovery_events (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    run_id uuid NOT NULL,
    action text NOT NULL,
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL
);

CREATE TABLE recovery_runs (
    id uuid NOT NULL,
    dataset_id uuid NOT NULL,
    state text NOT NULL,
    inventory_digest text,
    prepare_token uuid,
    operator_label text DEFAULT 'local-operator'::text NOT NULL,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    updated_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    checkpoint_id uuid,
    checkpoint_digest text,
    access_review_id uuid,
    access_state_digest text,
    release_token_hash text,
    bootstrap_auth_version integer,
    credential_expires_at timestamp with time zone,
    release_summary jsonb,
    release_ack_digest text,
    CONSTRAINT recovery_runs_state_check CHECK ((state = ANY (ARRAY['quarantined'::text, 'preparing'::text, 'replaying'::text, 'awaiting_identity_review'::text, 'access_applied'::text, 'credential_ready'::text, 'released'::text])))
);

CREATE TABLE retention_derivations (
    run_id uuid NOT NULL,
    session_id uuid NOT NULL,
    user_id uuid NOT NULL,
    table_index integer DEFAULT 0 NOT NULL
);

CREATE TABLE retention_state (
    singleton boolean DEFAULT true NOT NULL,
    run_id uuid,
    cutoff timestamp with time zone,
    phase text DEFAULT 'idle'::text NOT NULL,
    progress jsonb DEFAULT '{}'::jsonb NOT NULL,
    started_at timestamp with time zone,
    last_success_at timestamp with time zone,
    next_run_at timestamp with time zone,
    retry_at timestamp with time zone,
    last_error text,
    updated_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    completed_scope text,
    CONSTRAINT retention_state_singleton_check CHECK (singleton)
);

CREATE TABLE retention_targets (
    session_id uuid NOT NULL,
    user_id uuid NOT NULL,
    initialized boolean DEFAULT false NOT NULL,
    references_done boolean DEFAULT false NOT NULL
);

CREATE TABLE role_grants (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    role text NOT NULL,
    scope_id uuid,
    valid_from timestamp with time zone NOT NULL,
    valid_to timestamp with time zone,
    CONSTRAINT role_grants_check CHECK (((role = 'department_admin'::text) = (scope_id IS NOT NULL))),
    CONSTRAINT role_grants_check1 CHECK (((valid_to IS NULL) OR (valid_to > valid_from))),
    CONSTRAINT role_grants_role_check CHECK ((role = ANY (ARRAY['super'::text, 'anc_admin'::text, 'department_admin'::text])))
);

CREATE TABLE runtime_heartbeats (
    component text NOT NULL,
    boot_id uuid NOT NULL,
    sequence bigint NOT NULL,
    state text NOT NULL,
    metrics jsonb NOT NULL,
    first_observed_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    last_observed_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT runtime_heartbeats_component_check CHECK ((component = ANY (ARRAY['collector'::text, 'worker'::text, 'usage_worker'::text, 'cleanup_worker'::text, 'maintenance_worker'::text]))),
    CONSTRAINT runtime_heartbeats_metrics_check CHECK (((jsonb_typeof(metrics) = 'object'::text) AND (octet_length((metrics)::text) <= 8192))),
    CONSTRAINT runtime_heartbeats_sequence_check CHECK ((sequence > 0)),
    CONSTRAINT runtime_heartbeats_state_check CHECK ((state = ANY (ARRAY['running'::text, 'degraded'::text, 'stopped'::text])))
);

CREATE TABLE session_days (
    run_id uuid NOT NULL,
    session_id uuid NOT NULL,
    user_id uuid NOT NULL,
    business_date date NOT NULL,
    department_id uuid,
    event_count integer NOT NULL,
    prompt_count integer NOT NULL,
    tool_event_count integer NOT NULL
);

CREATE TABLE session_derivations (
    id uuid NOT NULL,
    session_id uuid NOT NULL,
    user_id uuid NOT NULL,
    source_generation integer NOT NULL,
    cleanup_generation integer NOT NULL,
    state text DEFAULT 'building'::text NOT NULL,
    from_at timestamp with time zone NOT NULL,
    to_at timestamp with time zone NOT NULL,
    checkpoint jsonb DEFAULT '{}'::jsonb NOT NULL,
    summary jsonb DEFAULT '{}'::jsonb NOT NULL,
    source_watermark timestamp with time zone,
    metric_version text DEFAULT 'session-v1'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    computed_at timestamp with time zone,
    retire_after timestamp with time zone,
    CONSTRAINT session_derivations_state_check CHECK ((state = ANY (ARRAY['building'::text, 'published'::text, 'superseded'::text, 'abandoned'::text])))
);

CREATE TABLE session_fragments (
    run_id uuid NOT NULL,
    session_id uuid NOT NULL,
    user_id uuid NOT NULL,
    department_id uuid,
    event_id uuid NOT NULL,
    occurred_at timestamp with time zone NOT NULL,
    business_date date NOT NULL,
    kind text NOT NULL,
    ordinal integer NOT NULL,
    turn_index integer,
    step_id uuid,
    purpose text,
    assistant_tokens_estimate numeric(30,0) DEFAULT 0 NOT NULL,
    behavior_purpose text,
    workspace text,
    workspace_key text,
    repository_clues jsonb DEFAULT '[]'::jsonb NOT NULL,
    repository_clues_truncated boolean DEFAULT false NOT NULL,
    hook_model text,
    CONSTRAINT session_fragments_behavior_purpose_check CHECK ((behavior_purpose = ANY (ARRAY['test'::text, 'feature'::text, 'learning'::text])))
)
PARTITION BY RANGE (occurred_at);

CREATE TABLE session_personal_models (
    session_id uuid NOT NULL,
    user_id uuid NOT NULL,
    models jsonb NOT NULL,
    version integer DEFAULT 1 NOT NULL,
    cleanup_generation integer NOT NULL,
    updated_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT session_personal_models_models_check CHECK (((jsonb_typeof(models) = 'array'::text) AND (jsonb_array_length(models) <= 10)))
);

CREATE TABLE session_steps (
    run_id uuid NOT NULL,
    id uuid NOT NULL,
    turn_index integer,
    installation_id uuid NOT NULL,
    tool_use_id text,
    tool_name text,
    pre_event_id uuid,
    pre_at timestamp with time zone,
    post_event_id uuid,
    post_at timestamp with time zone,
    duration_ms bigint,
    status text NOT NULL,
    error_evidence text,
    input_tokens_estimate numeric(30,0) DEFAULT 0 NOT NULL,
    output_tokens_estimate numeric(30,0) DEFAULT 0 NOT NULL,
    input_event_id uuid,
    input_at timestamp with time zone,
    simulation_mutating boolean,
    CONSTRAINT session_steps_duration_ms_check CHECK (((duration_ms IS NULL) OR (duration_ms >= 0))),
    CONSTRAINT session_steps_status_check CHECK ((status = ANY (ARRAY['incomplete'::text, 'returned'::text, 'success'::text, 'error'::text]))),
    CONSTRAINT step_input_reference CHECK (((input_event_id IS NULL) = (input_at IS NULL)))
);

CREATE TABLE session_turns (
    run_id uuid NOT NULL,
    turn_index integer NOT NULL,
    prompt_event_id uuid NOT NULL,
    prompt_at timestamp with time zone NOT NULL,
    response_event_id uuid,
    response_at timestamp with time zone,
    last_at timestamp with time zone NOT NULL,
    completion_kind text DEFAULT 'missing'::text NOT NULL,
    completion_event_id uuid,
    completion_at timestamp with time zone,
    prompt_tokens_estimate numeric(30,0) DEFAULT 0 NOT NULL,
    CONSTRAINT session_turns_completion_kind_check CHECK ((completion_kind = ANY (ARRAY['missing'::text, 'stop_observed'::text, 'idle_prompt'::text]))),
    CONSTRAINT session_turns_turn_index_check CHECK ((turn_index > 0))
);

CREATE TABLE sessions (
    id uuid NOT NULL,
    user_id uuid NOT NULL,
    source_session_id text NOT NULL,
    first_at timestamp with time zone NOT NULL,
    last_at timestamp with time zone NOT NULL,
    status text DEFAULT 'unknown'::text NOT NULL,
    quality text DEFAULT 'observed'::text NOT NULL,
    derived_run_id uuid,
    history_redacted boolean DEFAULT false NOT NULL,
    history_expired boolean DEFAULT false NOT NULL,
    CONSTRAINT sessions_check CHECK ((last_at >= first_at)),
    CONSTRAINT sessions_status_check CHECK ((status = ANY (ARRAY['active'::text, 'completed'::text, 'error'::text, 'unknown'::text])))
);

CREATE TABLE usage_attribution_evidence (
    provider_account text NOT NULL,
    session_id uuid NOT NULL,
    user_id uuid NOT NULL,
    billing_session_id text NOT NULL,
    provider_user_id text NOT NULL,
    cleanup_generation integer NOT NULL,
    ingest_epoch integer NOT NULL,
    first_seen_at timestamp with time zone NOT NULL,
    last_seen_at timestamp with time zone NOT NULL,
    response_hash text NOT NULL,
    request_id text,
    CONSTRAINT usage_attribution_evidence_billing_session_id_check CHECK (((length(billing_session_id) >= 1) AND (length(billing_session_id) <= 256)))
);

CREATE TABLE usage_attribution_revisions (
    provider_account text NOT NULL,
    user_id uuid NOT NULL,
    revision bigint DEFAULT 0 NOT NULL
);

CREATE TABLE usage_attribution_subjects (
    provider_account text NOT NULL,
    session_id uuid NOT NULL,
    user_id uuid NOT NULL,
    generation integer DEFAULT 1 NOT NULL,
    probe_state text NOT NULL,
    requested_at timestamp with time zone NOT NULL,
    observed_at timestamp with time zone,
    error_code text,
    response_hash text,
    cleanup_generation integer DEFAULT '-1'::integer NOT NULL,
    CONSTRAINT usage_attribution_subjects_probe_state_check CHECK ((probe_state = ANY (ARRAY['running'::text, 'observed'::text, 'empty'::text, 'failed'::text])))
);

CREATE TABLE usage_backfill_days (
    backfill_id uuid NOT NULL,
    business_date date NOT NULL,
    first_verified_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL
);

CREATE TABLE usage_backfills (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    provider_account text NOT NULL,
    user_id uuid NOT NULL,
    ingest_epoch integer NOT NULL,
    from_date date NOT NULL,
    to_date date NOT NULL,
    as_of timestamp with time zone NOT NULL,
    next_date date NOT NULL,
    queued_at timestamp with time zone,
    completed_at timestamp with time zone,
    superseded_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT usage_backfills_check CHECK (((to_date - from_date) = 44))
);

CREATE TABLE usage_department_catalog (
    provider_account text NOT NULL,
    external_department_id text NOT NULL,
    name text DEFAULT ''::text NOT NULL,
    full_path text DEFAULT ''::text NOT NULL,
    last_observed_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL
);

CREATE TABLE usage_department_mappings (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    provider_account text NOT NULL,
    external_department_id text NOT NULL,
    department_id uuid NOT NULL,
    valid_from timestamp with time zone NOT NULL,
    valid_to timestamp with time zone,
    created_by uuid NOT NULL,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT usage_department_mappings_check CHECK (((valid_to IS NULL) OR (valid_to > valid_from))),
    CONSTRAINT usage_department_mappings_external_department_id_check CHECK (((length(external_department_id) >= 1) AND (length(external_department_id) <= 256)))
);

CREATE TABLE usage_mapping_state (
    provider_account text NOT NULL,
    version integer DEFAULT 1 NOT NULL
);

CREATE TABLE usage_observations (
    run_id uuid NOT NULL,
    part integer NOT NULL,
    page integer NOT NULL,
    item_index integer NOT NULL,
    row_hash text NOT NULL,
    value jsonb NOT NULL,
    CONSTRAINT usage_observations_item_index_check CHECK ((item_index >= 0)),
    CONSTRAINT usage_observations_value_check CHECK ((jsonb_typeof(value) = 'object'::text))
);

CREATE TABLE usage_provider_control (
    provider_account text NOT NULL,
    next_request_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    paused_until timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    last_granted_at timestamp with time zone,
    interval_ms integer NOT NULL,
    discovery_cursor uuid,
    discovery_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    dispatch_turn bigint DEFAULT 0 NOT NULL,
    last_discovered_at timestamp with time zone,
    backfill_reset_at timestamp with time zone,
    CONSTRAINT usage_provider_control_interval_ms_check CHECK (((interval_ms >= 20) AND (interval_ms <= 5000)))
);

CREATE TABLE usage_provider_identities (
    provider_account text NOT NULL,
    user_id uuid NOT NULL,
    provider_user_id text NOT NULL,
    verified_email text NOT NULL,
    verified_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL
);

CREATE TABLE usage_scopes (
    id uuid NOT NULL,
    provider_account text NOT NULL,
    user_id uuid NOT NULL,
    business_date date NOT NULL,
    active_run_id uuid,
    published_run_id uuid,
    verified_run_id uuid,
    revision integer DEFAULT 0 NOT NULL,
    last_verified_at timestamp with time zone,
    CONSTRAINT usage_scopes_revision_check CHECK ((revision >= 0))
);

CREATE TABLE usage_snapshot_pages (
    run_id uuid NOT NULL,
    part integer NOT NULL,
    page integer NOT NULL,
    query jsonb NOT NULL,
    fingerprint text NOT NULL,
    response_hash text NOT NULL,
    request_id text,
    observed_at timestamp with time zone NOT NULL,
    row_count integer NOT NULL,
    CONSTRAINT usage_snapshot_pages_page_check CHECK ((page >= 1)),
    CONSTRAINT usage_snapshot_pages_row_count_check CHECK ((row_count >= 0))
);

CREATE TABLE usage_snapshot_parts (
    run_id uuid NOT NULL,
    part integer NOT NULL,
    start_second bigint NOT NULL,
    end_second bigint NOT NULL,
    expected_total integer,
    expected_pages integer,
    next_page integer DEFAULT 1 NOT NULL,
    CONSTRAINT usage_snapshot_parts_check CHECK ((end_second >= start_second)),
    CONSTRAINT usage_snapshot_parts_expected_pages_check CHECK ((expected_pages >= 1)),
    CONSTRAINT usage_snapshot_parts_expected_total_check CHECK ((expected_total >= 0)),
    CONSTRAINT usage_snapshot_parts_next_page_check CHECK ((next_page >= 1)),
    CONSTRAINT usage_snapshot_parts_part_check CHECK ((part >= 0))
);

CREATE TABLE usage_snapshot_runs (
    id uuid NOT NULL,
    scope_id uuid NOT NULL,
    state text NOT NULL,
    lease_token uuid,
    lease_until timestamp with time zone,
    captured_email text NOT NULL,
    requested_provider_user_id text,
    observed_provider_user_id text,
    ingest_epoch integer NOT NULL,
    cleanup_generation integer NOT NULL,
    from_second bigint NOT NULL,
    to_second bigint NOT NULL,
    page_size integer NOT NULL,
    row_count integer DEFAULT 0 NOT NULL,
    byte_count integer DEFAULT 0 NOT NULL,
    content_hash text,
    data_run_id uuid,
    started_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    completed_at timestamp with time zone,
    error_code text,
    captured_at timestamp with time zone,
    CONSTRAINT usage_snapshot_runs_byte_count_check CHECK ((byte_count >= 0)),
    CONSTRAINT usage_snapshot_runs_check CHECK ((to_second >= from_second)),
    CONSTRAINT usage_snapshot_runs_page_size_check CHECK (((page_size >= 1) AND (page_size <= 500))),
    CONSTRAINT usage_snapshot_runs_row_count_check CHECK ((row_count >= 0)),
    CONSTRAINT usage_snapshot_runs_state_check CHECK ((state = ANY (ARRAY['building'::text, 'published'::text, 'superseded'::text, 'unchanged'::text, 'failed'::text, 'abandoned'::text, 'redacted'::text, 'expired'::text])))
);

CREATE TABLE users (
    id uuid NOT NULL,
    email_key text NOT NULL,
    display_name text NOT NULL,
    status text DEFAULT 'active'::text NOT NULL,
    auth_version integer DEFAULT 1 NOT NULL,
    ingest_epoch integer DEFAULT 1 NOT NULL,
    version integer DEFAULT 1 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    cleanup_generation integer DEFAULT 0 NOT NULL,
    management_source text DEFAULT 'system'::text NOT NULL,
    CONSTRAINT users_auth_version_check CHECK ((auth_version > 0)),
    CONSTRAINT users_display_name_check CHECK ((btrim(display_name) <> ''::text)),
    CONSTRAINT users_email_key_check CHECK (((email_key = lower(btrim(email_key))) AND (email_key <> ''::text))),
    CONSTRAINT users_ingest_epoch_check CHECK ((ingest_epoch > 0)),
    CONSTRAINT users_management_source_check CHECK ((management_source = ANY (ARRAY['system'::text, 'environment'::text]))),
    CONSTRAINT users_status_check CHECK ((status = ANY (ARRAY['active'::text, 'suspended'::text, 'deleted'::text]))),
    CONSTRAINT users_version_check CHECK ((version > 0))
);

ALTER TABLE ONLY audit_events
    ADD CONSTRAINT audit_events_pkey PRIMARY KEY (id);

ALTER TABLE ONLY cleanup_journal_parts
    ADD CONSTRAINT cleanup_journal_parts_pkey PRIMARY KEY (job_id, part);

ALTER TABLE ONLY cleanup_previews
    ADD CONSTRAINT cleanup_previews_pkey PRIMARY KEY (id);

ALTER TABLE ONLY cleanup_requests
    ADD CONSTRAINT cleanup_requests_creator_id_idempotency_hash_key UNIQUE (creator_id, idempotency_hash);

ALTER TABLE ONLY cleanup_requests
    ADD CONSTRAINT cleanup_requests_pkey PRIMARY KEY (job_id);

ALTER TABLE ONLY cleanup_requests
    ADD CONSTRAINT cleanup_requests_preview_id_key UNIQUE (preview_id);

ALTER TABLE ONLY cleanup_sessions
    ADD CONSTRAINT cleanup_sessions_pkey PRIMARY KEY (job_id, session_id);

ALTER TABLE ONLY cleanup_tombstones
    ADD CONSTRAINT cleanup_tombstones_pkey PRIMARY KEY (id);

ALTER TABLE ONLY credentials
    ADD CONSTRAINT credentials_pkey PRIMARY KEY (user_id);

ALTER TABLE ONLY data_identity
    ADD CONSTRAINT data_identity_pkey PRIMARY KEY (singleton);

ALTER TABLE ONLY database_monitor_state
    ADD CONSTRAINT database_monitor_state_pkey PRIMARY KEY (singleton);

ALTER TABLE ONLY departments
    ADD CONSTRAINT departments_pkey PRIMARY KEY (id);

ALTER TABLE ONLY eligibility_periods
    ADD CONSTRAINT eligibility_periods_pkey PRIMARY KEY (id);

ALTER TABLE ONLY eligibility_periods
    ADD CONSTRAINT eligibility_periods_user_id_tstzrange_excl EXCLUDE USING gist (user_id WITH =, tstzrange(valid_from, valid_to, '[)'::text) WITH &&);

ALTER TABLE ONLY event_keys
    ADD CONSTRAINT event_keys_pkey PRIMARY KEY (installation_id, client_event_id);

ALTER TABLE ONLY hook_events
    ADD CONSTRAINT hook_events_pkey PRIMARY KEY (occurred_at, id);

ALTER TABLE ONLY import_batches
    ADD CONSTRAINT import_batches_job_id_key UNIQUE (job_id);

ALTER TABLE ONLY import_batches
    ADD CONSTRAINT import_batches_pkey PRIMARY KEY (id);

ALTER TABLE ONLY installations
    ADD CONSTRAINT installations_pkey PRIMARY KEY (id);

ALTER TABLE ONLY installations
    ADD CONSTRAINT installations_token_hash_key UNIQUE (token_hash);

ALTER TABLE ONLY installations
    ADD CONSTRAINT installations_user_id_id_key UNIQUE (user_id, id);

ALTER TABLE ONLY jobs
    ADD CONSTRAINT jobs_dedupe_key_key UNIQUE (dedupe_key);

ALTER TABLE ONLY jobs
    ADD CONSTRAINT jobs_pkey PRIMARY KEY (id);

ALTER TABLE ONLY login_sessions
    ADD CONSTRAINT login_sessions_pkey PRIMARY KEY (token_hash);

ALTER TABLE ONLY membership_periods
    ADD CONSTRAINT membership_periods_pkey PRIMARY KEY (id);

ALTER TABLE ONLY membership_periods
    ADD CONSTRAINT membership_periods_user_id_tstzrange_excl EXCLUDE USING gist (user_id WITH =, tstzrange(valid_from, valid_to, '[)'::text) WITH &&);

ALTER TABLE ONLY monitor_alert_events
    ADD CONSTRAINT monitor_alert_events_pkey PRIMARY KEY (id);

ALTER TABLE ONLY monitor_alerts
    ADD CONSTRAINT monitor_alerts_pkey PRIMARY KEY (key);

ALTER TABLE ONLY personal_model_revisions
    ADD CONSTRAINT personal_model_revisions_pkey PRIMARY KEY (user_id);

ALTER TABLE ONLY recovery_access_reviews
    ADD CONSTRAINT recovery_access_reviews_pkey PRIMARY KEY (id);

ALTER TABLE ONLY recovery_cleanup_operations
    ADD CONSTRAINT recovery_cleanup_operations_pkey PRIMARY KEY (job_id);

ALTER TABLE ONLY recovery_cleanup_sessions
    ADD CONSTRAINT recovery_cleanup_sessions_pkey PRIMARY KEY (job_id, session_id);

ALTER TABLE ONLY recovery_events
    ADD CONSTRAINT recovery_events_pkey PRIMARY KEY (id);

ALTER TABLE ONLY recovery_runs
    ADD CONSTRAINT recovery_runs_pkey PRIMARY KEY (id);

ALTER TABLE ONLY retention_derivations
    ADD CONSTRAINT retention_derivations_pkey PRIMARY KEY (run_id);

ALTER TABLE ONLY retention_state
    ADD CONSTRAINT retention_state_pkey PRIMARY KEY (singleton);

ALTER TABLE ONLY retention_targets
    ADD CONSTRAINT retention_targets_pkey PRIMARY KEY (session_id);

ALTER TABLE ONLY role_grants
    ADD CONSTRAINT role_grants_pkey PRIMARY KEY (id);

ALTER TABLE ONLY role_grants
    ADD CONSTRAINT role_grants_user_id_role_coalesce_tstzrange_excl EXCLUDE USING gist (user_id WITH =, role WITH =, COALESCE((scope_id)::text, 'global'::text) WITH =, tstzrange(valid_from, valid_to, '[)'::text) WITH &&);

ALTER TABLE ONLY runtime_heartbeats
    ADD CONSTRAINT runtime_heartbeats_pkey PRIMARY KEY (component, boot_id);

ALTER TABLE ONLY session_days
    ADD CONSTRAINT session_days_run_id_business_date_department_id_key UNIQUE NULLS NOT DISTINCT (run_id, business_date, department_id);

ALTER TABLE ONLY session_derivations
    ADD CONSTRAINT session_derivations_pkey PRIMARY KEY (id);

ALTER TABLE ONLY session_fragments
    ADD CONSTRAINT session_fragments_pkey PRIMARY KEY (run_id, occurred_at, event_id);

ALTER TABLE ONLY session_personal_models
    ADD CONSTRAINT session_personal_models_pkey PRIMARY KEY (session_id);

ALTER TABLE ONLY session_steps
    ADD CONSTRAINT session_steps_pkey PRIMARY KEY (run_id, id);

ALTER TABLE ONLY session_turns
    ADD CONSTRAINT session_turns_pkey PRIMARY KEY (run_id, turn_index);

ALTER TABLE ONLY sessions
    ADD CONSTRAINT sessions_pkey PRIMARY KEY (id);

ALTER TABLE ONLY sessions
    ADD CONSTRAINT sessions_user_id_id_key UNIQUE (user_id, id);

ALTER TABLE ONLY sessions
    ADD CONSTRAINT sessions_user_id_source_session_id_key UNIQUE (user_id, source_session_id);

ALTER TABLE ONLY usage_attribution_evidence
    ADD CONSTRAINT usage_attribution_evidence_pkey PRIMARY KEY (provider_account, session_id, billing_session_id);

ALTER TABLE ONLY usage_attribution_revisions
    ADD CONSTRAINT usage_attribution_revisions_pkey PRIMARY KEY (provider_account, user_id);

ALTER TABLE ONLY usage_attribution_subjects
    ADD CONSTRAINT usage_attribution_subjects_pkey PRIMARY KEY (provider_account, session_id);

ALTER TABLE ONLY usage_backfill_days
    ADD CONSTRAINT usage_backfill_days_pkey PRIMARY KEY (backfill_id, business_date);

ALTER TABLE ONLY usage_backfills
    ADD CONSTRAINT usage_backfills_pkey PRIMARY KEY (id);

ALTER TABLE ONLY usage_department_catalog
    ADD CONSTRAINT usage_department_catalog_pkey PRIMARY KEY (provider_account, external_department_id);

ALTER TABLE ONLY usage_department_mappings
    ADD CONSTRAINT usage_department_mappings_pkey PRIMARY KEY (id);

ALTER TABLE ONLY usage_department_mappings
    ADD CONSTRAINT usage_department_mappings_provider_account_external_depart_excl EXCLUDE USING gist (provider_account WITH =, external_department_id WITH =, tstzrange(valid_from, valid_to, '[)'::text) WITH &&);

ALTER TABLE ONLY usage_mapping_state
    ADD CONSTRAINT usage_mapping_state_pkey PRIMARY KEY (provider_account);

ALTER TABLE ONLY usage_observations
    ADD CONSTRAINT usage_observations_pkey PRIMARY KEY (run_id, part, page, item_index);

ALTER TABLE ONLY usage_provider_control
    ADD CONSTRAINT usage_provider_control_pkey PRIMARY KEY (provider_account);

ALTER TABLE ONLY usage_provider_identities
    ADD CONSTRAINT usage_provider_identities_pkey PRIMARY KEY (provider_account, user_id);

ALTER TABLE ONLY usage_provider_identities
    ADD CONSTRAINT usage_provider_identities_provider_account_provider_user_id_key UNIQUE (provider_account, provider_user_id);

ALTER TABLE ONLY usage_scopes
    ADD CONSTRAINT usage_scopes_pkey PRIMARY KEY (id);

ALTER TABLE ONLY usage_scopes
    ADD CONSTRAINT usage_scopes_provider_account_user_id_business_date_key UNIQUE (provider_account, user_id, business_date);

ALTER TABLE ONLY usage_snapshot_pages
    ADD CONSTRAINT usage_snapshot_pages_pkey PRIMARY KEY (run_id, part, page);

ALTER TABLE ONLY usage_snapshot_parts
    ADD CONSTRAINT usage_snapshot_parts_pkey PRIMARY KEY (run_id, part);

ALTER TABLE ONLY usage_snapshot_runs
    ADD CONSTRAINT usage_snapshot_runs_id_scope_id_key UNIQUE (id, scope_id);

ALTER TABLE ONLY usage_snapshot_runs
    ADD CONSTRAINT usage_snapshot_runs_pkey PRIMARY KEY (id);

ALTER TABLE ONLY users
    ADD CONSTRAINT users_email_key_key UNIQUE (email_key);

ALTER TABLE ONLY users
    ADD CONSTRAINT users_pkey PRIMARY KEY (id);

CREATE INDEX attribution_evidence_retention ON usage_attribution_evidence USING btree (last_seen_at);

CREATE INDEX audit_events_time ON audit_events USING btree (created_at, id);

CREATE INDEX cleanup_jobs_expired ON jobs USING btree (lease_until, id) WHERE ((kind = 'cleanup'::text) AND (status = 'running'::text));

CREATE INDEX cleanup_jobs_ready ON jobs USING btree (available_at, id) WHERE ((kind = 'cleanup'::text) AND (status = 'queued'::text));

CREATE INDEX cleanup_previews_expiry ON cleanup_previews USING btree (expires_at);

CREATE INDEX cleanup_request_confirmed_scope ON cleanup_requests USING btree (user_id, cleanup_generation, from_at, to_at) WHERE ((acceptance_digest IS NOT NULL) OR (journal_digest IS NOT NULL));

CREATE INDEX cleanup_requests_user ON cleanup_requests USING btree (user_id, created_at);

CREATE INDEX cleanup_user_time ON cleanup_tombstones USING btree (user_id, from_at, to_at);

CREATE UNIQUE INDEX departments_active_name ON departments USING btree (lower(name)) WHERE (deleted_at IS NULL);

CREATE INDEX derivation_retirement ON session_derivations USING btree (retire_after) WHERE (retire_after IS NOT NULL);

CREATE INDEX derivation_session ON session_derivations USING btree (session_id, source_generation);

CREATE INDEX derivations_retention ON session_derivations USING btree (from_at, session_id);

CREATE INDEX event_keys_retention ON event_keys USING btree (occurred_at);

CREATE INDEX fragment_run_order ON ONLY session_fragments USING btree (run_id, ordinal);

CREATE INDEX fragment_scope_time ON ONLY session_fragments USING btree (department_id, occurred_at, user_id);

CREATE INDEX hook_events_department_time ON ONLY hook_events USING btree (department_id, occurred_at, id);

CREATE INDEX hook_events_session_order ON ONLY hook_events USING btree (session_id, occurred_at, (
CASE event_type
    WHEN 'SessionStart'::text THEN 0
    WHEN 'UserPromptSubmit'::text THEN 1
    WHEN 'PreToolUse'::text THEN 2
    WHEN 'PostToolUse'::text THEN 3
    WHEN 'Stop'::text THEN 4
    WHEN 'Notification'::text THEN 5
    ELSE 6
END), id);

CREATE INDEX hook_events_user_time ON ONLY hook_events USING btree (user_id, occurred_at, id);

CREATE INDEX import_expiry ON import_batches USING btree (expires_at);

CREATE UNIQUE INDEX import_idempotency ON import_batches USING btree (creator_id, idempotency_key) WHERE (idempotency_key IS NOT NULL);

CREATE INDEX installations_user_created ON installations USING btree (user_id, created_at DESC, id DESC);

CREATE INDEX jobs_ready ON jobs USING btree (status, available_at);

CREATE INDEX jobs_terminal_retention ON jobs USING btree (status_since, id) WHERE (status = ANY (ARRAY['succeeded'::text, 'failed'::text, 'cancelled'::text]));

CREATE INDEX login_sessions_expiry ON login_sessions USING btree (expires_at);

CREATE INDEX login_sessions_user ON login_sessions USING btree (user_id);

CREATE INDEX membership_department_period ON membership_periods USING btree (department_id, valid_from, valid_to);

CREATE INDEX monitor_alert_delivery ON monitor_alert_events USING btree (target, available_at) WHERE (status = ANY (ARRAY['queued'::text, 'running'::text]));

CREATE UNIQUE INDEX one_active_configuration_admin ON users USING btree (management_source) WHERE ((management_source = 'environment'::text) AND (status = 'active'::text));

CREATE UNIQUE INDEX recovery_operation_per_run ON recovery_cleanup_operations USING btree (run_id, operation_id);

CREATE INDEX runtime_heartbeats_recent ON runtime_heartbeats USING btree (component, last_observed_at DESC);

CREATE INDEX session_days_scope ON session_days USING btree (business_date, department_id, user_id);

CREATE UNIQUE INDEX session_step_identity ON session_steps USING btree (run_id, turn_index, installation_id, tool_use_id) NULLS NOT DISTINCT WHERE (tool_use_id IS NOT NULL);

CREATE INDEX sessions_derived_run ON sessions USING btree (derived_run_id) WHERE (derived_run_id IS NOT NULL);

CREATE INDEX sessions_retention ON sessions USING btree (first_at, id);

CREATE INDEX sessions_user_time ON sessions USING btree (user_id, last_at DESC, id);

CREATE INDEX step_input_reference ON session_steps USING btree (run_id, input_event_id, input_at);

CREATE INDEX step_output_reference ON session_steps USING btree (run_id, post_event_id, post_at);

CREATE INDEX turn_prompt_reference ON session_turns USING btree (run_id, prompt_event_id, prompt_at);

CREATE INDEX usage_attribution_jobs_expired ON jobs USING btree (lease_until, id) WHERE ((kind = 'usage_attribution'::text) AND (status = 'running'::text));

CREATE INDEX usage_attribution_jobs_ready ON jobs USING btree (((payload ->> 'provider_account'::text)), status, available_at, id) WHERE (kind = 'usage_attribution'::text);

CREATE INDEX usage_attribution_owner_billing ON usage_attribution_evidence USING btree (provider_account, user_id, billing_session_id);

CREATE UNIQUE INDEX usage_backfill_current ON usage_backfills USING btree (provider_account, user_id, ingest_epoch) WHERE (superseded_at IS NULL);

CREATE INDEX usage_department_mapping_target ON usage_department_mappings USING btree (provider_account, department_id, valid_from);

CREATE INDEX usage_jobs_expired ON jobs USING btree (lease_until, id) WHERE ((kind = 'usage_sync'::text) AND (status = 'running'::text));

CREATE INDEX usage_jobs_ready ON jobs USING btree (((payload ->> 'provider_account'::text)), status, available_at, id) WHERE (kind = 'usage_sync'::text);

CREATE INDEX usage_runs_data_reference ON usage_snapshot_runs USING btree (data_run_id, scope_id);

CREATE INDEX usage_runs_retired ON usage_snapshot_runs USING btree (state, completed_at);

CREATE INDEX usage_runs_scope ON usage_snapshot_runs USING btree (scope_id, id);

CREATE INDEX usage_scope_retention ON usage_scopes USING btree (business_date, id);

CREATE INDEX usage_scope_user_date ON usage_scopes USING btree (user_id, business_date);

CREATE INDEX usage_sync_queued_drafts ON jobs USING btree (((payload ->> 'provider_account'::text))) WHERE ((kind = 'usage_sync'::text) AND (status = 'queued'::text) AND (progress ? 'draft'::text));

CREATE TRIGGER job_status_since BEFORE UPDATE OF status ON jobs FOR EACH ROW EXECUTE FUNCTION record_job_status_since();

ALTER TABLE ONLY audit_events
    ADD CONSTRAINT audit_events_actor_id_fkey FOREIGN KEY (actor_id) REFERENCES users(id);

ALTER TABLE ONLY cleanup_journal_parts
    ADD CONSTRAINT cleanup_journal_parts_job_id_fkey FOREIGN KEY (job_id) REFERENCES cleanup_requests(job_id);

ALTER TABLE ONLY cleanup_previews
    ADD CONSTRAINT cleanup_previews_creator_id_fkey FOREIGN KEY (creator_id) REFERENCES users(id);

ALTER TABLE ONLY cleanup_previews
    ADD CONSTRAINT cleanup_previews_user_id_fkey FOREIGN KEY (user_id) REFERENCES users(id);

ALTER TABLE ONLY cleanup_requests
    ADD CONSTRAINT cleanup_requests_creator_id_fkey FOREIGN KEY (creator_id) REFERENCES users(id);

ALTER TABLE ONLY cleanup_requests
    ADD CONSTRAINT cleanup_requests_executor_id_fkey FOREIGN KEY (executor_id) REFERENCES users(id);

ALTER TABLE ONLY cleanup_requests
    ADD CONSTRAINT cleanup_requests_job_id_fkey FOREIGN KEY (job_id) REFERENCES jobs(id);

ALTER TABLE ONLY cleanup_requests
    ADD CONSTRAINT cleanup_requests_preview_id_fkey FOREIGN KEY (preview_id) REFERENCES cleanup_previews(id);

ALTER TABLE ONLY cleanup_requests
    ADD CONSTRAINT cleanup_requests_user_id_fkey FOREIGN KEY (user_id) REFERENCES users(id);

ALTER TABLE ONLY cleanup_sessions
    ADD CONSTRAINT cleanup_sessions_job_id_fkey FOREIGN KEY (job_id) REFERENCES cleanup_requests(job_id);

ALTER TABLE ONLY cleanup_tombstones
    ADD CONSTRAINT cleanup_tombstones_user_id_fkey FOREIGN KEY (user_id) REFERENCES users(id);

ALTER TABLE ONLY credentials
    ADD CONSTRAINT credentials_user_id_fkey FOREIGN KEY (user_id) REFERENCES users(id);

ALTER TABLE ONLY data_identity
    ADD CONSTRAINT data_identity_recovery_id_fkey FOREIGN KEY (recovery_id) REFERENCES recovery_runs(id);

ALTER TABLE ONLY eligibility_periods
    ADD CONSTRAINT eligibility_periods_user_id_fkey FOREIGN KEY (user_id) REFERENCES users(id);

ALTER TABLE ONLY event_keys
    ADD CONSTRAINT event_keys_installation_id_fkey FOREIGN KEY (installation_id) REFERENCES installations(id);

ALTER TABLE hook_events
    ADD CONSTRAINT hook_events_department_id_fkey FOREIGN KEY (department_id) REFERENCES departments(id);

ALTER TABLE hook_events
    ADD CONSTRAINT hook_events_user_id_fkey FOREIGN KEY (user_id) REFERENCES users(id);

ALTER TABLE hook_events
    ADD CONSTRAINT hook_events_user_id_installation_id_fkey FOREIGN KEY (user_id, installation_id) REFERENCES installations(user_id, id);

ALTER TABLE hook_events
    ADD CONSTRAINT hook_events_user_id_session_id_fkey FOREIGN KEY (user_id, session_id) REFERENCES sessions(user_id, id);

ALTER TABLE ONLY import_batches
    ADD CONSTRAINT import_batches_creator_id_fkey FOREIGN KEY (creator_id) REFERENCES users(id);

ALTER TABLE ONLY import_batches
    ADD CONSTRAINT import_batches_department_id_fkey FOREIGN KEY (department_id) REFERENCES departments(id);

ALTER TABLE ONLY import_batches
    ADD CONSTRAINT import_batches_job_id_fkey FOREIGN KEY (job_id) REFERENCES jobs(id);

ALTER TABLE ONLY installations
    ADD CONSTRAINT installations_user_id_fkey FOREIGN KEY (user_id) REFERENCES users(id);

ALTER TABLE ONLY login_sessions
    ADD CONSTRAINT login_sessions_user_id_fkey FOREIGN KEY (user_id) REFERENCES users(id);

ALTER TABLE ONLY membership_periods
    ADD CONSTRAINT membership_periods_department_id_fkey FOREIGN KEY (department_id) REFERENCES departments(id);

ALTER TABLE ONLY membership_periods
    ADD CONSTRAINT membership_periods_user_id_fkey FOREIGN KEY (user_id) REFERENCES users(id);

ALTER TABLE ONLY personal_model_revisions
    ADD CONSTRAINT personal_model_revisions_user_id_fkey FOREIGN KEY (user_id) REFERENCES users(id);

ALTER TABLE ONLY recovery_access_reviews
    ADD CONSTRAINT recovery_access_reviews_run_id_fkey FOREIGN KEY (run_id) REFERENCES recovery_runs(id);

ALTER TABLE ONLY recovery_cleanup_operations
    ADD CONSTRAINT recovery_cleanup_operations_run_id_fkey FOREIGN KEY (run_id) REFERENCES recovery_runs(id);

ALTER TABLE ONLY recovery_cleanup_sessions
    ADD CONSTRAINT recovery_cleanup_sessions_job_id_fkey FOREIGN KEY (job_id) REFERENCES recovery_cleanup_operations(job_id);

ALTER TABLE ONLY recovery_events
    ADD CONSTRAINT recovery_events_run_id_fkey FOREIGN KEY (run_id) REFERENCES recovery_runs(id);

ALTER TABLE ONLY recovery_runs
    ADD CONSTRAINT recovery_runs_access_review_id_fkey FOREIGN KEY (access_review_id) REFERENCES recovery_access_reviews(id);

ALTER TABLE ONLY role_grants
    ADD CONSTRAINT role_grants_scope_id_fkey FOREIGN KEY (scope_id) REFERENCES departments(id);

ALTER TABLE ONLY role_grants
    ADD CONSTRAINT role_grants_user_id_fkey FOREIGN KEY (user_id) REFERENCES users(id);

ALTER TABLE ONLY session_days
    ADD CONSTRAINT session_days_run_id_fkey FOREIGN KEY (run_id) REFERENCES session_derivations(id) ON DELETE CASCADE;

ALTER TABLE ONLY session_derivations
    ADD CONSTRAINT session_derivations_session_id_fkey FOREIGN KEY (session_id) REFERENCES sessions(id);

ALTER TABLE ONLY session_derivations
    ADD CONSTRAINT session_derivations_user_id_fkey FOREIGN KEY (user_id) REFERENCES users(id);

ALTER TABLE session_fragments
    ADD CONSTRAINT session_fragments_run_id_fkey FOREIGN KEY (run_id) REFERENCES session_derivations(id) ON DELETE CASCADE;

ALTER TABLE ONLY session_personal_models
    ADD CONSTRAINT session_personal_models_user_id_session_id_fkey FOREIGN KEY (user_id, session_id) REFERENCES sessions(user_id, id);

ALTER TABLE ONLY session_steps
    ADD CONSTRAINT session_steps_run_id_fkey FOREIGN KEY (run_id) REFERENCES session_derivations(id) ON DELETE CASCADE;

ALTER TABLE ONLY session_turns
    ADD CONSTRAINT session_turns_run_id_fkey FOREIGN KEY (run_id) REFERENCES session_derivations(id) ON DELETE CASCADE;

ALTER TABLE ONLY sessions
    ADD CONSTRAINT sessions_derived_run_id_fkey FOREIGN KEY (derived_run_id) REFERENCES session_derivations(id);

ALTER TABLE ONLY sessions
    ADD CONSTRAINT sessions_user_id_fkey FOREIGN KEY (user_id) REFERENCES users(id);

ALTER TABLE ONLY usage_attribution_evidence
    ADD CONSTRAINT usage_attribution_evidence_provider_account_session_id_fkey FOREIGN KEY (provider_account, session_id) REFERENCES usage_attribution_subjects(provider_account, session_id);

ALTER TABLE ONLY usage_attribution_evidence
    ADD CONSTRAINT usage_attribution_evidence_user_id_session_id_fkey FOREIGN KEY (user_id, session_id) REFERENCES sessions(user_id, id);

ALTER TABLE ONLY usage_attribution_revisions
    ADD CONSTRAINT usage_attribution_revisions_user_id_fkey FOREIGN KEY (user_id) REFERENCES users(id);

ALTER TABLE ONLY usage_attribution_subjects
    ADD CONSTRAINT usage_attribution_subjects_user_id_session_id_fkey FOREIGN KEY (user_id, session_id) REFERENCES sessions(user_id, id);

ALTER TABLE ONLY usage_backfill_days
    ADD CONSTRAINT usage_backfill_days_backfill_id_fkey FOREIGN KEY (backfill_id) REFERENCES usage_backfills(id);

ALTER TABLE ONLY usage_backfills
    ADD CONSTRAINT usage_backfills_user_id_fkey FOREIGN KEY (user_id) REFERENCES users(id);

ALTER TABLE ONLY usage_department_mappings
    ADD CONSTRAINT usage_department_mappings_created_by_fkey FOREIGN KEY (created_by) REFERENCES users(id);

ALTER TABLE ONLY usage_department_mappings
    ADD CONSTRAINT usage_department_mappings_department_id_fkey FOREIGN KEY (department_id) REFERENCES departments(id);

ALTER TABLE ONLY usage_observations
    ADD CONSTRAINT usage_observations_run_id_part_page_fkey FOREIGN KEY (run_id, part, page) REFERENCES usage_snapshot_pages(run_id, part, page) ON DELETE CASCADE;

ALTER TABLE ONLY usage_provider_identities
    ADD CONSTRAINT usage_provider_identities_user_id_fkey FOREIGN KEY (user_id) REFERENCES users(id);

ALTER TABLE ONLY usage_scopes
    ADD CONSTRAINT usage_scopes_active_run_id_id_fkey FOREIGN KEY (active_run_id, id) REFERENCES usage_snapshot_runs(id, scope_id);

ALTER TABLE ONLY usage_scopes
    ADD CONSTRAINT usage_scopes_published_run_id_id_fkey FOREIGN KEY (published_run_id, id) REFERENCES usage_snapshot_runs(id, scope_id);

ALTER TABLE ONLY usage_scopes
    ADD CONSTRAINT usage_scopes_user_id_fkey FOREIGN KEY (user_id) REFERENCES users(id);

ALTER TABLE ONLY usage_scopes
    ADD CONSTRAINT usage_scopes_verified_run_id_id_fkey FOREIGN KEY (verified_run_id, id) REFERENCES usage_snapshot_runs(id, scope_id);

ALTER TABLE ONLY usage_snapshot_pages
    ADD CONSTRAINT usage_snapshot_pages_run_id_part_fkey FOREIGN KEY (run_id, part) REFERENCES usage_snapshot_parts(run_id, part) ON DELETE CASCADE;

ALTER TABLE ONLY usage_snapshot_parts
    ADD CONSTRAINT usage_snapshot_parts_run_id_fkey FOREIGN KEY (run_id) REFERENCES usage_snapshot_runs(id) ON DELETE CASCADE;

ALTER TABLE ONLY usage_snapshot_runs
    ADD CONSTRAINT usage_snapshot_runs_data_run_id_scope_id_fkey FOREIGN KEY (data_run_id, scope_id) REFERENCES usage_snapshot_runs(id, scope_id);

ALTER TABLE ONLY usage_snapshot_runs
    ADD CONSTRAINT usage_snapshot_runs_scope_id_fkey FOREIGN KEY (scope_id) REFERENCES usage_scopes(id);

INSERT INTO data_identity(singleton) VALUES(true);
INSERT INTO retention_state(singleton) VALUES(true);
INSERT INTO database_monitor_state(singleton) VALUES(true);
