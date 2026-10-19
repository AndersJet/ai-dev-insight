export function safeReturnPath(value: unknown, fallback: string): string {
  if (typeof value !== 'string' || value.includes('\\') || /(?:^|\/)\.\.(?:\/|$)/.test(value)) return fallback;
  return /^\/(?:my|organization|all|code-flow|plugin-code-flow|organization-management|system|history)(?:\/|\?|$)/.test(value) ? value : fallback;
}
