/** Independent fixture oracle. Inputs are initial fixture facts plus persisted
 * session boundaries, never API channels or the product's query relation.
 * Every second below is PostgreSQL's floor(extract(epoch ...))::text; this
 * module deliberately does not parse a timestamp or round through Number. */
export const STATIC_COMPETITION_FENCES = Object.freeze([
  'hook_key_current',
  'cleanup_generation_current',
  'ingest_epoch_current',
  'provider_identity_current',
  'recovery_clear',
  'retention_eligible',
  'cleanup_clear',
  'history_clear',
  'bill_claims_clear',
]);

const channels = new Set(['official', 'mixed', 'custom', 'pending', 'unknown']);
const integerSecond = value => typeof value === 'string' && /^-?(?:0|[1-9][0-9]*)$/.test(value);
const identifier = value => typeof value === 'string' && value.length > 0;

/**
 * staticSessions: [{session_id, user_id, initial_channel, known_fences,
 *   bills: [{id, basis: 'stop_window' | 'single_hook_query',
 *     source_window?: {ids: [billId], start_seconds: [pgIntegerString]}}]}]
 * competitorSessions: [{session_id, user_id, first_floor_seconds,
 *   last_floor_seconds, has_retained_hook, history_redacted, history_expired}]
 *
 * known_fences contains every exported fence with the literal value true.
 * has_retained_hook is an independently read EXISTS fact after current
 * retention and cleanup fences; session bounds alone cannot establish it.
 *
 * This narrow oracle models the fixture's one-candidate Stop windows. An
 * unsupported/unknown fact is inconclusive, never an inferred safe result.
 * suppressed_session_ids contains sessions whose entire initial official
 * component is suppressed. A surviving direct or safe bill keeps its channel.
 * No live-source plan or missing-event denominator is accepted or modified.
 */
export function assessStaticStopWindowCompetition({staticSessions, competitorSessions}) {
  if (!Array.isArray(staticSessions) || !Array.isArray(competitorSessions)) {
    throw new TypeError('Static competition oracle requires both fact arrays');
  }

  const owners = new Map();
  for (const competitor of competitorSessions) {
    if (!identifier(competitor?.session_id) || !identifier(competitor?.user_id)) {
      throw new TypeError('A persisted competitor must identify its session and owner');
    }
    const sessions = owners.get(competitor.user_id) ?? [];
    sessions.push(competitor);
    owners.set(competitor.user_id, sessions);
  }

  const seen = new Set();
  const sessionResults = [];
  const suppressedBills = [];
  const inconclusive = [];
  for (const session of staticSessions) {
    if (!identifier(session?.session_id) || !identifier(session?.user_id) || seen.has(session.session_id)) {
      throw new TypeError('Static sessions require unique IDs and identified owners');
    }
    seen.add(session.session_id);
    const issues = [];
    const issue = (reason, details = {}, billId = null) => {
      issues.push({session_id: session.session_id, bill_id: billId, reason, ...details});
    };
    if (!channels.has(session.initial_channel)) issue('unknown_initial_channel');
    for (const fence of STATIC_COMPETITION_FENCES) {
      if (session.known_fences?.[fence] !== true) {
        issue('unverified_fence', {fence, observed: session.known_fences?.[fence] ?? null});
      }
    }
    if (!Array.isArray(session.bills) || session.bills.length === 0) issue('missing_initial_bills');

    const retainedBillIds = [];
    const suppressedBillIds = [];
    const sessionSuppressedBills = [];
    const seenBills = new Set();
    if (issues.length === 0) for (const bill of session.bills) {
      if (!identifier(bill?.id) || seenBills.has(bill.id)) {
        issue('invalid_initial_bill', {}, bill?.id ?? null);
        continue;
      }
      seenBills.add(bill.id);
      if (bill.basis === 'single_hook_query') {
        retainedBillIds.push(bill.id);
        continue;
      }
      if (bill.basis !== 'stop_window') {
        issue('unsupported_bill_basis', {}, bill.id);
        continue;
      }
      const window = bill.source_window;
      if (!Array.isArray(window?.ids) || window.ids.length !== 1 || window.ids[0] !== bill.id ||
          !Array.isArray(window.start_seconds) || window.start_seconds.length !== 1 ||
          !integerSecond(window.start_seconds[0])) {
        issue('unsupported_single_candidate_window', {}, bill.id);
        continue;
      }
      const second = BigInt(window.start_seconds[0]);
      const competingIds = new Set();
      const uncertainIds = new Set();
      for (const competitor of owners.get(session.user_id) ?? []) {
        if (competitor.session_id === session.session_id || competitor.history_redacted === true ||
            competitor.history_expired === true || competitor.has_retained_hook === false) continue;
        if (!integerSecond(competitor.first_floor_seconds) || !integerSecond(competitor.last_floor_seconds)) {
          uncertainIds.add(competitor.session_id);
          continue;
        }
        const first = BigInt(competitor.first_floor_seconds), last = BigInt(competitor.last_floor_seconds);
        if (first > last) {
          uncertainIds.add(competitor.session_id);
          continue;
        }
        if (second < first || second > last) continue;
        if (competitor.history_redacted !== false || competitor.history_expired !== false ||
            competitor.has_retained_hook !== true) {
          uncertainIds.add(competitor.session_id);
          continue;
        }
        competingIds.add(competitor.session_id);
      }
      if (competingIds.size > 0) {
        suppressedBillIds.push(bill.id);
        sessionSuppressedBills.push({session_id: session.session_id, user_id: session.user_id,
          bill_id: bill.id, start_seconds: window.start_seconds[0], competitor_session_ids: [...competingIds].sort()});
      } else if (uncertainIds.size > 0) {
        issue('unverified_competitor', {competitor_session_ids: [...uncertainIds].sort()}, bill.id);
      } else {
        retainedBillIds.push(bill.id);
      }
    }
    // Partial evidence is kept local to its session, not promoted into an
    // adjustment that a caller could count as a completed oracle result.
    const complete = issues.length === 0;
    const allSuppressed = complete && suppressedBillIds.length > 0 && retainedBillIds.length === 0;
    const expectedChannel = !complete ? null : !allSuppressed ? session.initial_channel :
      session.initial_channel === 'official' ? 'unknown' : session.initial_channel === 'mixed' ? 'custom' : null;
    if (allSuppressed && expectedChannel === null) issue('initial_channel_has_no_official_component');
    const conclusive = issues.length === 0;
    if (conclusive) suppressedBills.push(...sessionSuppressedBills);
    inconclusive.push(...issues);
    sessionResults.push({session_id: session.session_id, user_id: session.user_id,
      status: conclusive ? 'complete' : 'inconclusive', initial_channel: session.initial_channel,
      expected_channel: conclusive ? expectedChannel : null,
      suppressed_bill_ids: conclusive ? suppressedBillIds.sort() : [],
      retained_bill_ids: conclusive ? retainedBillIds.sort() : [],
      official_component_suppressed: conclusive && allSuppressed});
  }
  sessionResults.sort((a, b) => a.session_id < b.session_id ? -1 : a.session_id > b.session_id ? 1 : 0);
  const affected = sessionResults.filter(session => session.official_component_suppressed);
  return {status: inconclusive.length === 0 ? 'complete' : 'inconclusive',
    evaluated_static_sessions: staticSessions.length,
    suppressed_session_ids: affected.map(session => session.session_id),
    channel_adjustments: affected.map(session => ({session_id: session.session_id, user_id: session.user_id,
      initial_channel: session.initial_channel, expected_channel: session.expected_channel})),
    suppressed_bills: suppressedBills, session_results: sessionResults, inconclusive};
}
