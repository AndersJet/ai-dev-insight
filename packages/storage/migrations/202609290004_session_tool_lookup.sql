DROP INDEX session_step_identity;
CREATE INDEX session_step_call_lookup ON session_steps(run_id,installation_id,tool_use_id) WHERE tool_use_id IS NOT NULL;
CREATE INDEX session_derivation_published_version ON session_derivations(metric_version,session_id) WHERE state='published';
