import assert from 'node:assert/strict';
import test from 'node:test';
import {assessStaticStopWindowCompetition, STATIC_COMPETITION_FENCES} from './session-list-capacity-oracle.mjs';

const fences = () => Object.fromEntries(STATIC_COMPETITION_FENCES.map(name => [name, true]));
function staticSession(sessionId = 'static-official', channel = 'official', second = '100') {
  const billId = 'bill-' + sessionId;
  return {session_id: sessionId, user_id: 'owner', initial_channel: channel, known_fences: fences(),
    bills: [{id: billId, basis: 'stop_window', source_window: {ids: [billId], start_seconds: [second]}}]};
}
function competitor(sessionId = 'continued-long', first = '0', last = '1000', changes = {}) {
  return {session_id: sessionId, user_id: 'owner', first_floor_seconds: first, last_floor_seconds: last,
    has_retained_hook: true, history_redacted: false, history_expired: false, ...changes};
}
const assess = (staticSessions, competitorSessions = []) => assessStaticStopWindowCompetition({staticSessions, competitorSessions});

test('no competitor keeps the initial channel and bill', () => {
  const result = assess([staticSession()]);
  assert.equal(result.status, 'complete');
  assert.deepEqual(result.suppressed_session_ids, []);
  assert.deepEqual(result.channel_adjustments, []);
  assert.equal(result.session_results[0].expected_channel, 'official');
  assert.deepEqual(result.session_results[0].retained_bill_ids, ['bill-static-official']);
});

test('a persisted long continuation suppresses exact covered static IDs', () => {
  const result = assess([staticSession('official'), staticSession('mixed', 'mixed'),
    staticSession('outside', 'official', '1001')], [competitor()]);
  assert.equal(result.status, 'complete');
  assert.deepEqual(result.suppressed_session_ids, ['mixed', 'official']);
  assert.deepEqual(result.channel_adjustments, [
    {session_id: 'mixed', user_id: 'owner', initial_channel: 'mixed', expected_channel: 'custom'},
    {session_id: 'official', user_id: 'owner', initial_channel: 'official', expected_channel: 'unknown'},
  ]);
  assert.equal(result.suppressed_bills.length, 2);
  assert.ok(result.suppressed_bills.every(bill => bill.competitor_session_ids[0] === 'continued-long'));
});

test('PostgreSQL floor seconds use inclusive endpoints and exact BigInt comparisons', () => {
  for (const second of ['100', '200']) {
    assert.deepEqual(assess([staticSession('boundary', 'official', second)],
      [competitor('same-floor', '100', '200')]).suppressed_session_ids, ['boundary']);
  }
  assert.deepEqual(assess([staticSession('before', 'official', '99'), staticSession('after', 'official', '201')],
    [competitor('same-floor', '100', '200')]).suppressed_session_ids, []);
  assert.deepEqual(assess([staticSession('negative', 'official', '-1')],
    [competitor('negative-floor', '-1', '-1')]).suppressed_session_ids, ['negative']);
  assert.deepEqual(assess([staticSession('precise', 'official', '9007199254740993')],
    [competitor('big-integer', '9007199254740992', '9007199254740992')]).suppressed_session_ids, []);
  assert.deepEqual(assess([staticSession('precise', 'official', '9007199254740993')],
    [competitor('big-integer', '9007199254740993', '9007199254740993')]).suppressed_session_ids, ['precise']);
});

test('self, other owner, no retained Hook, redacted and expired facts are excluded', () => {
  const result = assess([staticSession()], [
    competitor('static-official'), competitor('other-owner', '0', '1000', {user_id: 'elsewhere'}),
    competitor('no-retained-hook', '0', '1000', {has_retained_hook: false}),
    competitor('redacted', '0', '1000', {history_redacted: true}),
    competitor('expired', '0', '1000', {history_expired: true}),
  ]);
  assert.equal(result.status, 'complete');
  assert.deepEqual(result.suppressed_session_ids, []);
});

test('a direct single_hook_query bill is never suppressed by a session range', () => {
  const session = staticSession();
  session.bills[0] = {id: 'direct-bill', basis: 'single_hook_query'};
  const result = assess([session], [competitor()]);
  assert.equal(result.status, 'complete');
  assert.deepEqual(result.suppressed_session_ids, []);
  assert.deepEqual(result.session_results[0].retained_bill_ids, ['direct-bill']);
});

test('a surviving direct or safe bill preserves the official component', () => {
  const session = staticSession();
  session.bills.push({id: 'direct-bill', basis: 'single_hook_query'},
    {id: 'safe-bill', basis: 'stop_window', source_window: {ids: ['safe-bill'], start_seconds: ['2000']}});
  const result = assess([session], [competitor()]);
  assert.equal(result.status, 'complete');
  assert.deepEqual(result.suppressed_session_ids, []);
  assert.equal(result.suppressed_bills.length, 1);
  assert.deepEqual(result.session_results[0].retained_bill_ids, ['direct-bill', 'safe-bill']);
  assert.equal(result.session_results[0].expected_channel, 'official');
});

test('every unknown or failed target fence is explicitly inconclusive', () => {
  for (const name of STATIC_COMPETITION_FENCES) for (const value of [undefined, null, false, 'unknown']) {
    const session = staticSession();
    session.known_fences[name] = value;
    const result = assess([session], [competitor()]);
    assert.equal(result.status, 'inconclusive', name);
    assert.equal(result.session_results[0].expected_channel, null);
    assert.deepEqual(result.suppressed_session_ids, []);
    assert.deepEqual(result.channel_adjustments, []);
    assert.ok(result.inconclusive.some(issue => issue.reason === 'unverified_fence' && issue.fence === name));
  }
});

test('unknown eligibility and malformed relevant bounds never establish safety', () => {
  for (const changes of [{has_retained_hook: null}, {history_redacted: null}, {history_expired: undefined},
    {first_floor_seconds: 0}, {last_floor_seconds: '100.0'}, {first_floor_seconds: '200', last_floor_seconds: '100'}]) {
    const result = assess([staticSession()], [competitor('uncertain', '0', '1000', changes)]);
    assert.equal(result.status, 'inconclusive');
    assert.equal(result.inconclusive[0].reason, 'unverified_competitor');
    assert.deepEqual(result.suppressed_session_ids, []);
  }
  assert.equal(assess([staticSession()], [competitor('outside', '200', '300', {has_retained_hook: null})]).status, 'complete');
});

test('one verified competitor is sufficient even if another competitor is unknown', () => {
  const result = assess([staticSession()], [competitor('unknown', '0', '1000', {has_retained_hook: null}), competitor('verified')]);
  assert.equal(result.status, 'complete');
  assert.deepEqual(result.suppressed_session_ids, ['static-official']);
  assert.deepEqual(result.suppressed_bills[0].competitor_session_ids, ['verified']);
});

test('non-single candidates and non-PG integer strings are explicitly unsupported', () => {
  for (const window of [{ids: ['bill-static-official', 'another'], start_seconds: ['100']},
    {ids: ['wrong-bill'], start_seconds: ['100']}, {ids: ['bill-static-official'], start_seconds: ['100', '101']},
    {ids: ['bill-static-official'], start_seconds: [100]}, {ids: ['bill-static-official'], start_seconds: ['100.0']}]) {
    const session = staticSession();
    session.bills[0].source_window = window;
    const result = assess([session], [competitor()]);
    assert.equal(result.status, 'inconclusive');
    assert.equal(result.inconclusive[0].reason, 'unsupported_single_candidate_window');
    assert.deepEqual(result.channel_adjustments, []);
  }
});

test('fact arrays are immutable inputs and the oracle returns no pass flag', () => {
  const session = staticSession(), other = competitor();
  for (const object of [session.bills[0].source_window.ids, session.bills[0].source_window.start_seconds,
    session.bills[0].source_window, session.bills[0], session.bills, session.known_fences, session, other]) Object.freeze(object);
  const result = assess(Object.freeze([session]), Object.freeze([other]));
  assert.equal(result.status, 'complete');
  assert.equal(Object.hasOwn(result, 'pass'), false);
});

test('invalid identities, duplicate static IDs and malformed fact containers are rejected', () => {
  assert.throws(() => assess([staticSession(), staticSession()]), /unique IDs/);
  assert.throws(() => assess([staticSession()], [{session_id: 'missing-owner'}]), /identify/);
  assert.throws(() => assessStaticStopWindowCompetition({staticSessions: [], competitorSessions: null}), /fact arrays/);
});
