-- Native UTF-8 ILIKE lowers the source and pattern before deterministic LIKE.
-- Store that exact derived value once on the original row. Ingest, cleanup and
-- recovery keep their existing row lifecycle; there is no separate search feed.
-- For a populated database the administrator prebuilds this exact stored column
-- and index in a bounded maintenance window. Application deadlines do not change.
DO $$ BEGIN
 IF current_setting('server_encoding')<>'UTF8' OR NOT(SELECT collisdeterministic FROM pg_catalog.pg_collation WHERE oid='pg_catalog."default"'::regcollation) THEN
  RAISE EXCEPTION USING ERRCODE='55000',MESSAGE='normalized prompt search requires UTF8 and the deterministic database default collation';
 END IF;
END $$;
ALTER TABLE hook_events ADD COLUMN IF NOT EXISTS prompt_search text GENERATED ALWAYS AS (CASE WHEN event_type='UserPromptSubmit' THEN lower(payload->>'prompt') END) STORED;
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM pg_catalog.pg_partition_tree('hook_events'::regclass) table_part
  LEFT JOIN pg_catalog.pg_attribute a ON a.attrelid=table_part.relid AND a.attname='prompt_search' AND NOT a.attisdropped
  LEFT JOIN pg_catalog.pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum
  WHERE (a.atttypid='text'::regtype AND a.attgenerated='s' AND NOT a.attnotnull
   AND a.attcollation='pg_catalog."default"'::regcollation
   AND pg_catalog.regexp_replace(pg_catalog.pg_get_expr(d.adbin,d.adrelid),'[[:space:]]','','g')='CASEWHEN(event_type=''UserPromptSubmit''::text)THENlower((payload->>''prompt''::text))ELSENULL::textEND') IS NOT TRUE) THEN
  RAISE EXCEPTION USING ERRCODE='55000',MESSAGE='prompt_search must be the exact native stored prompt-only lower projection';
 END IF;
END $$;
CREATE INDEX IF NOT EXISTS hook_prompt_search_trgm ON hook_events USING gin (prompt_search public.gin_trgm_ops) WHERE event_type='UserPromptSubmit';
DO $$ DECLARE index_id oid; BEGIN
 SELECT c.oid INTO index_id FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
  WHERE c.relname='hook_prompt_search_trgm' AND n.nspname=current_schema();
 IF NOT EXISTS(SELECT 1 FROM pg_catalog.pg_index i JOIN pg_catalog.pg_class c ON c.oid=i.indexrelid
  JOIN pg_catalog.pg_am a ON a.oid=c.relam JOIN pg_catalog.pg_opclass op ON op.oid=i.indclass[0]
  JOIN pg_catalog.pg_namespace ns ON ns.oid=op.opcnamespace
  JOIN pg_catalog.pg_extension ext ON ext.extname='pg_trgm' AND ext.extnamespace=ns.oid
  JOIN pg_catalog.pg_attribute attr ON attr.attrelid=i.indrelid AND attr.attnum=i.indkey[0]
  WHERE i.indexrelid=index_id AND i.indrelid='hook_events'::regclass AND c.relkind IN('i','I')
   AND a.amname='gin' AND i.indisvalid AND i.indisready AND i.indislive AND i.indnkeyatts=1 AND i.indnatts=1 AND i.indexprs IS NULL AND attr.attname='prompt_search'
   AND op.opcname='gin_trgm_ops' AND ns.nspname='public' AND op.opcmethod=a.oid
   AND i.indcollation[0]='pg_catalog."default"'::regcollation
   AND EXISTS(SELECT 1 FROM pg_catalog.pg_depend d WHERE d.classid='pg_opclass'::regclass AND d.objid=op.oid AND d.refclassid='pg_extension'::regclass AND d.refobjid=ext.oid AND d.deptype='e')
   AND pg_catalog.regexp_replace(pg_catalog.pg_get_expr(i.indpred,i.indrelid),'[[:space:]]','','g')='(event_type=''UserPromptSubmit''::text)') THEN
  RAISE EXCEPTION USING ERRCODE='55000',MESSAGE='hook_prompt_search_trgm must be the valid native normalized prompt-only GIN with public.pg_trgm';
 END IF;
END $$;
