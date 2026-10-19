-- Additional packed Unicode-codepoint GIN on the existing native prompt_search.
-- No facts/full-text column or existing prompt GIN is removed.
-- Normal migrations keep the existing 5s statement budget. On a populated DB,
-- the DBA prebuilds this exact function and index with a dedicated, bounded 15min
-- maintenance connection, then normal migration validates/reuses the same OIDs.
-- Never replace an indexed function: a mismatch must stop for operator review.
LOCK TABLE hook_events IN SHARE MODE;
DO $migration$
DECLARE
 target_schema text := current_schema();
 function_id oid;
 index_id oid;
 native_projection text;
 native_lower oid := 'pg_catalog.lower(pg_catalog.text)'::regprocedure;
 native_text_eq oid := 'pg_catalog.=(pg_catalog.text,pg_catalog.text)'::regoperator;
 native_jsonb_text oid := 'pg_catalog.->>(pg_catalog.jsonb,pg_catalog.text)'::regoperator;
 expected_body text := $grams$
 SELECT ARRAY(SELECT DISTINCT
  ascii(substr(c,1,1))::bigint*4398046511104::bigint+ascii(substr(c,2,1))::bigint*2097152::bigint+ascii(substr(c,3,1))::bigint AS gram
 FROM(
  SELECT m[1] c FROM regexp_matches(l,'(...)','gs') m
  UNION ALL SELECT m[1] FROM regexp_matches(substr(l,2),'(...)','gs') m
  UNION ALL SELECT m[1] FROM regexp_matches(substr(l,3),'(...)','gs') m
 ) chunks ORDER BY gram)
$grams$;
BEGIN
 IF pg_catalog.current_setting('server_encoding')<>'UTF8'
  OR NOT(SELECT collisdeterministic FROM pg_catalog.pg_collation WHERE oid='pg_catalog."default"'::regcollation) THEN
  RAISE EXCEPTION USING ERRCODE='55000',MESSAGE='literal prompt grams require UTF8 and the deterministic database default collation';
 END IF;
 -- Build the canonical projection with explicit native function/operator OIDs.
 -- The empty temporary reference stores no facts and is removed immediately.
 CREATE TEMP TABLE adi_literal_grams_projection_reference(
  event_type pg_catalog.text,payload pg_catalog.jsonb,
  prompt_search pg_catalog.text GENERATED ALWAYS AS (
   CASE WHEN event_type OPERATOR(pg_catalog.=) 'UserPromptSubmit'::pg_catalog.text
    THEN pg_catalog.lower(payload OPERATOR(pg_catalog.->>) 'prompt'::pg_catalog.text) END) STORED
 ) ON COMMIT DROP;
 SELECT pg_catalog.pg_get_expr(d.adbin,d.adrelid) INTO native_projection
  FROM pg_catalog.pg_attrdef d JOIN pg_catalog.pg_attribute a ON a.attrelid=d.adrelid AND a.attnum=d.adnum
  WHERE d.adrelid='pg_temp.adi_literal_grams_projection_reference'::regclass AND a.attname='prompt_search';
 DROP TABLE pg_temp.adi_literal_grams_projection_reference;
 -- An already-applied migration is not permission for a substituted leaf
 -- projection. Verify every current table partition before trusting its grams.
 IF EXISTS(SELECT 1 FROM pg_catalog.pg_partition_tree('hook_events'::regclass) table_part
  LEFT JOIN pg_catalog.pg_attribute a ON a.attrelid=table_part.relid AND a.attname='prompt_search' AND NOT a.attisdropped
  LEFT JOIN pg_catalog.pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum
  WHERE (a.atttypid='pg_catalog.text'::regtype AND a.attgenerated='s' AND NOT a.attnotnull
   AND a.attcollation='pg_catalog."default"'::regcollation
   AND pg_catalog.pg_get_expr(d.adbin,d.adrelid)=native_projection
   AND ARRAY(SELECT (token[1])::oid FROM pg_catalog.regexp_matches(d.adbin::text,':funcid ([0-9]+)','g') tokens(token))=ARRAY[native_lower]
   AND ARRAY(SELECT (token[1])::oid FROM pg_catalog.regexp_matches(d.adbin::text,':opno ([0-9]+)','g') tokens(token) ORDER BY (token[1])::oid)
    =ARRAY(SELECT op FROM pg_catalog.unnest(ARRAY[native_text_eq,native_jsonb_text]) op ORDER BY op)) IS NOT TRUE) THEN
  RAISE EXCEPTION USING ERRCODE='55000',MESSAGE='literal prompt grams require the exact native stored prompt_search on every table partition';
 END IF;
 function_id := pg_catalog.to_regprocedure(pg_catalog.format('%I.hook_prompt_codepoint_grams(pg_catalog.text)',target_schema));
 IF EXISTS(SELECT 1 FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace
  WHERE n.nspname=target_schema AND p.proname='hook_prompt_codepoint_grams' AND p.oid IS DISTINCT FROM function_id) THEN
  RAISE EXCEPTION USING ERRCODE='55000',MESSAGE='hook_prompt_codepoint_grams must have only the exact text-to-bigint-array signature';
 END IF;
 IF function_id IS NULL THEN
  EXECUTE pg_catalog.format('CREATE FUNCTION %I.hook_prompt_codepoint_grams(l pg_catalog.text) RETURNS pg_catalog.int8[] LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE SET search_path=pg_catalog AS %L',target_schema,expected_body);
  function_id := pg_catalog.to_regprocedure(pg_catalog.format('%I.hook_prompt_codepoint_grams(pg_catalog.text)',target_schema));
 END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_language lang ON lang.oid=p.prolang
  WHERE p.oid=function_id AND lang.lanname='sql' AND p.prokind='f'
   AND p.provolatile='i' AND p.proparallel='s' AND p.proisstrict
   AND NOT p.prosecdef AND NOT p.proleakproof AND NOT p.proretset
   AND p.pronargs=1 AND p.proargtypes[0]='pg_catalog.text'::regtype AND p.prorettype='pg_catalog.int8[]'::regtype
   AND p.provariadic=0 AND p.prosupport=0 AND p.procost=100 AND p.prorows=0 AND p.pronargdefaults=0 AND p.proargdefaults IS NULL
   AND p.proallargtypes IS NULL AND p.proargmodes IS NULL AND p.proargnames=ARRAY['l']::text[]
   AND p.probin IS NULL AND p.prosqlbody IS NULL AND p.prosrc=expected_body
   AND p.proconfig=ARRAY['search_path=pg_catalog']::text[]) THEN
  RAISE EXCEPTION USING ERRCODE='55000',MESSAGE='hook_prompt_codepoint_grams must retain the exact immutable strict parallel-safe SQL body and pg_catalog-only search_path';
 END IF;
 -- Qualification pins this expression to the verified function OID, even when
 -- an administrator prebuilt it before this normal bounded migration.
 EXECUTE pg_catalog.format('CREATE INDEX IF NOT EXISTS hook_prompt_literal_grams ON %I.hook_events USING gin (%I.hook_prompt_codepoint_grams(prompt_search) pg_catalog.array_ops) WHERE event_type=''UserPromptSubmit''',target_schema,target_schema);
 SELECT c.oid INTO index_id FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
  WHERE n.nspname=target_schema AND c.relname='hook_prompt_literal_grams';
 IF NOT EXISTS(SELECT 1 FROM pg_catalog.pg_index i JOIN pg_catalog.pg_class c ON c.oid=i.indexrelid
  WHERE i.indexrelid=index_id AND i.indrelid='hook_events'::regclass AND c.relkind='I') THEN
  RAISE EXCEPTION USING ERRCODE='55000',MESSAGE='hook_prompt_literal_grams must be the partitioned hook_events index';
 END IF;
 IF EXISTS(
  WITH table_parts AS (SELECT * FROM pg_catalog.pg_partition_tree('hook_events'::regclass)),
   index_parts AS (SELECT * FROM pg_catalog.pg_partition_tree(index_id))
  SELECT 1 FROM index_parts part
  LEFT JOIN pg_catalog.pg_index i ON i.indexrelid=part.relid
  LEFT JOIN pg_catalog.pg_class c ON c.oid=i.indexrelid
  LEFT JOIN table_parts table_part ON table_part.relid=i.indrelid
  LEFT JOIN pg_catalog.pg_index parent_index ON parent_index.indexrelid=part.parentrelid
  LEFT JOIN pg_catalog.pg_am am ON am.oid=c.relam
  LEFT JOIN pg_catalog.pg_opclass op ON op.oid=i.indclass[0]
  LEFT JOIN pg_catalog.pg_namespace op_ns ON op_ns.oid=op.opcnamespace
  LEFT JOIN pg_catalog.pg_attribute key_attr ON key_attr.attrelid=i.indexrelid AND key_attr.attnum=1 AND NOT key_attr.attisdropped
  WHERE (table_part.relid IS NOT NULL AND part.isleaf=table_part.isleaf
   AND ((part.parentrelid IS NULL AND table_part.parentrelid IS NULL) OR parent_index.indrelid=table_part.parentrelid)
   AND c.relkind=CASE WHEN table_part.isleaf THEN 'i'::"char" ELSE 'I'::"char" END
   AND am.amname='gin' AND i.indisvalid AND i.indisready AND i.indislive
   AND i.indnkeyatts=1 AND i.indnatts=1 AND i.indkey[0]=0
   AND i.indcollation[0]=0 AND key_attr.atttypid='pg_catalog.int8'::regtype AND key_attr.attcollation=0
   AND op_ns.nspname='pg_catalog' AND op.opcname='array_ops' AND op.opcmethod=am.oid
   AND op.opcintype='pg_catalog.anyarray'::regtype AND op.opckeytype='pg_catalog.anyelement'::regtype
   AND pg_catalog.pg_get_expr(i.indexprs,i.indrelid)='hook_prompt_codepoint_grams(prompt_search)'
   AND pg_catalog.pg_get_expr(i.indpred,i.indrelid)='(event_type = ''UserPromptSubmit''::text)'
   AND EXISTS(SELECT 1 FROM pg_catalog.pg_depend dep WHERE dep.classid='pg_catalog.pg_class'::regclass
    AND dep.objid=i.indexrelid AND dep.objsubid=0 AND dep.refclassid='pg_catalog.pg_proc'::regclass
    AND dep.refobjid=function_id AND dep.deptype='n')) IS NOT TRUE) THEN
  RAISE EXCEPTION USING ERRCODE='55000',MESSAGE='every literal prompt GIN partition must bind the verified function, exact expression/predicate, native array_ops, int8 keys and live ready valid state';
 END IF;
 IF EXISTS(
  WITH table_parts AS (SELECT * FROM pg_catalog.pg_partition_tree('hook_events'::regclass)),
   index_parts AS (SELECT i.indrelid FROM pg_catalog.pg_partition_tree(index_id) part JOIN pg_catalog.pg_index i ON i.indexrelid=part.relid)
  SELECT 1 FROM table_parts table_part
  WHERE (SELECT count(*) FROM index_parts part WHERE part.indrelid=table_part.relid)<>1) THEN
  RAISE EXCEPTION USING ERRCODE='55000',MESSAGE='literal prompt GIN must cover every hook_events table partition exactly once';
 END IF;
END
$migration$;
