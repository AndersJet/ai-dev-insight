// Shared by read-side gap reporting and background rechecks. Only Token and
// comparison dimensions are required here; amount/currency are out of scope.
export const incompleteTokenRecordSql=`value->'usage'->>'total_tokens' IS NULL OR value->'usage'->>'prompt_tokens' IS NULL OR value->'usage'->>'completion_tokens' IS NULL
 OR NULLIF(value->>'model_name','') IS NULL OR COALESCE(value->>'model_source','') NOT IN('Trae','Custom') OR COALESCE(value->>'model_type','') NOT IN('Chat','CUE')
 OR COALESCE(value->'quality' ? 'token_sum_mismatch',false)`;
