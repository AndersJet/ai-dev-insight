export const HOOK_JSON_WIRE_BYTES = 2 * 1024 * 1024;
export const HOOK_JSON_EXPANDED_BYTES = 4 * 1024 * 1024;
export type JsonBudgetFailure = 'wire_limit' | 'expanded_limit' | 'numeric_range';
/** Conservative UTF-8 text bound before PostgreSQL expands numeric exponents.
 * This is a lexical budget check, not a JSON/schema validator. The original
 * text still goes to PostgreSQL; parsed JS numbers are never serialized back.
 */
export function jsonBudgetFailure(text: string, options: { wireBytes?: number; expandedBytes?: number } = {}): JsonBudgetFailure | null {
  const wireLimit = options.wireBytes ?? HOOK_JSON_WIRE_BYTES;
  const expandedLimit = options.expandedBytes ?? HOOK_JSON_EXPANDED_BYTES;
  if (!Number.isSafeInteger(wireLimit) || wireLimit < 1 || !Number.isSafeInteger(expandedLimit) || expandedLimit < 1) throw new Error('JSON budgets must be positive integers');
  if (text.length > wireLimit) return 'wire_limit';
  const bytes = new TextEncoder().encode(text).byteLength;
  if (bytes > wireLimit) return 'wire_limit';
  let expanded = bytes;
  // Sticky matching scans once. Quoted digits (including escaped quotes) are
  // skipped; this also budgets overwritten duplicate-key values conservatively.
  const number = /(-?)(0|[1-9]\d*)(?:\.(\d+))?(?:[eE]([+-]?\d+))?/y;
  for (let at = 0; at < text.length; at++) {
    const char = text[at]!;
    if (char === '"') {
      // indexOf scans long prompt/code strings natively. Only quote boundaries
      // require JS work; an odd preceding backslash run escapes that quote.
      let search=at+1;
      for (;;) {const end=text.indexOf('"',search);if(end<0){at=text.length;break;}let escapes=0;for(let before=end-1;before>at&&text[before]==='\\';before--)escapes++;if(escapes%2===0){at=end;break;}search=end+1;}
    } else if (char === ':' || char === ',') {
      // jsonb emits one space after each separator; existing whitespace in the
      // input is already counted, so the result remains an upper bound.
      expanded++;
    } else if (char === '-' || (char >= '0' && char <= '9')) {
      number.lastIndex = at; const token = number.exec(text);
      if (!token) continue; // JSON.parse owns syntax errors.
      const exponent = token[4] === undefined ? 0 : Number(token[4]);
      if (!Number.isSafeInteger(exponent)) return 'numeric_range';
      const before = Math.max(1, token[2]!.length + exponent);
      const after = Math.max(0, (token[3]?.length ?? 0) - exponent);
      // PostgreSQL 18 unconstrained numeric limits. Counting insignificant zero
      // digits too is intentional: admission must not understate the bound.
      if (before > 131072 || after > 16383) return 'numeric_range';
      const width = token[1]!.length + before + (after ? after + 1 : 0);
      expanded += Math.max(0, width - token[0].length);
      at = number.lastIndex - 1;
    }
    if (expanded > expandedLimit) return 'expanded_limit';
  }
  return expanded > expandedLimit ? 'expanded_limit' : null;
}
