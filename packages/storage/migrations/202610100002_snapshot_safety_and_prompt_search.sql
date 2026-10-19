-- Administrative prerequisite. Application initialization does not install or
-- relocate shared extensions and never changes database-role privileges.
DO $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_extension e JOIN pg_namespace n ON n.oid=e.extnamespace WHERE e.extname='pg_trgm' AND n.nspname='public') THEN
  RAISE EXCEPTION USING ERRCODE='55000',MESSAGE='public.pg_trgm must be preinstalled by the database administrator';
 END IF;
END $$;
CREATE INDEX IF NOT EXISTS hook_prompt_trgm ON hook_events USING gin ((payload->>'prompt') public.gin_trgm_ops) WHERE event_type='UserPromptSubmit';
-- IF NOT EXISTS supports an administrator's bounded maintenance prebuild, but
-- an unrelated relation with this name must never silently satisfy migration.
DO $$ DECLARE index_id oid; BEGIN
 SELECT c.oid INTO index_id FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
  WHERE c.relname='hook_prompt_trgm' AND n.nspname=current_schema();
 IF NOT EXISTS(SELECT 1 FROM pg_catalog.pg_index i JOIN pg_catalog.pg_class c ON c.oid=i.indexrelid
  JOIN pg_catalog.pg_am a ON a.oid=c.relam JOIN pg_catalog.pg_opclass op ON op.oid=i.indclass[0]
  JOIN pg_catalog.pg_namespace ns ON ns.oid=op.opcnamespace
  JOIN pg_catalog.pg_extension ext ON ext.extname='pg_trgm' AND ext.extnamespace=ns.oid
  WHERE i.indexrelid=index_id AND i.indrelid='hook_events'::regclass AND c.relkind IN('i','I')
   AND a.amname='gin' AND i.indisvalid AND i.indisready AND i.indislive AND i.indnkeyatts=1 AND i.indnatts=1 AND i.indkey[0]=0
   AND op.opcname='gin_trgm_ops' AND ns.nspname='public' AND op.opcmethod=a.oid
   AND i.indcollation[0]=(SELECT oid FROM pg_catalog.pg_collation WHERE collname='default' AND collnamespace='pg_catalog'::regnamespace)
   AND EXISTS(SELECT 1 FROM pg_catalog.pg_depend d WHERE d.classid='pg_opclass'::regclass AND d.objid=op.oid AND d.refclassid='pg_extension'::regclass AND d.refobjid=ext.oid AND d.deptype='e')
   AND pg_catalog.regexp_replace(pg_catalog.pg_get_expr(i.indexprs,i.indrelid),'[[:space:]]','','g')='(payload->>''prompt''::text)'
   AND pg_catalog.regexp_replace(pg_catalog.pg_get_expr(i.indpred,i.indrelid),'[[:space:]]','','g')='(event_type=''UserPromptSubmit''::text)') THEN
  RAISE EXCEPTION USING ERRCODE='55000',MESSAGE='hook_prompt_trgm must be a valid prompt-only GIN index with the public.pg_trgm operator class';
 END IF;
END $$;

CREATE FUNCTION clear_session_list_snapshots_on_safety_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.dataset_id IS DISTINCT FROM OLD.dataset_id OR NEW.recovery_id IS DISTINCT FROM OLD.recovery_id OR NEW.retention_cutoff IS DISTINCT FROM OLD.retention_cutoff THEN
  EXECUTE pg_catalog.format('DELETE FROM %I.session_list_snapshots',TG_TABLE_SCHEMA);
  EXECUTE pg_catalog.format('DELETE FROM %I.session_list_snapshot_entries',TG_TABLE_SCHEMA);
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER session_list_snapshot_safety AFTER UPDATE OF dataset_id,recovery_id,retention_cutoff ON data_identity FOR EACH ROW EXECUTE FUNCTION clear_session_list_snapshots_on_safety_change();
