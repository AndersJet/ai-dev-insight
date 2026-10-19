import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { testDatabase } from '../../../storage/test/helpers.js';
import { createIdentityService } from '../../src/identity.js';
import { createAnalyticsService } from '../../src/analytics.js';
import { createOrganizationService } from '../../src/organization.js';
import { createSessionDerivationService } from '../../src/session-derivation.js';

const clock = () => new Date('2026-09-24T12:00:00Z');
const period = { from: '2026-09-20T16:00:00Z', to: '2026-09-23T16:00:00Z' };
async function fixture(t: TestContext) {
  const db = await testDatabase(t); await db.migrate(); await db.ensurePartitions(new Date('2026-09-01Z'), new Date('2026-10-01Z'));
  const identity = createIdentityService(db, { emailDomains: ['example.invalid'], clock });
  const seed = await identity.bootstrap({ email: 'analytics-root@example.invalid', name: '统计超管' });
  const temp = await identity.login('analytics-root@example.invalid', seed.temporaryPassword);
  const root = await identity.changePassword(temp.token, seed.temporaryPassword, 'analytics-root-password');
  const departments = [randomUUID(), randomUUID()] as const;
  await db.query('INSERT INTO departments(id,name) VALUES($1,$2),($3,$4)', [departments[0], '历史A部门', departments[1], '历史B部门']);
  const people = [randomUUID(), randomUUID(), randomUUID()]; const installations = [randomUUID(), randomUUID(), randomUUID()];
  for (let i = 0; i < people.length; i++) {
    await db.query('INSERT INTO users(id,email_key,display_name) VALUES($1,$2,$3)', [people[i], `analytics-${i}@example.invalid`, `统计员工${i}`]);
    await db.query('INSERT INTO installations(id,user_id,token_hash,label) VALUES($1,$2,$3,$4)', [installations[i], people[i], String(i + 1).repeat(64), '合成安装']);
  }
  await db.query('INSERT INTO membership_periods(user_id,department_id,valid_from,valid_to) VALUES($1,$2,$3,$4),($1,$5,$4,NULL),($6,$2,$3,NULL),($7,$5,$3,NULL)', [people[0], departments[0], '2026-09-20Z', '2026-09-22Z', departments[1], people[1], people[2]]);
  await db.query("UPDATE users SET registered_at='2026-09-20Z' WHERE id=ANY($1::uuid[])", [[people[0],people[1]]]);
  const facts = [[0, '2026-09-21T01:00:00Z'], [0, '2026-09-22T01:00:00Z'], [0, '2026-09-23T01:00:00Z'], [1, '2026-09-21T02:00:00Z'], [1, '2026-09-22T02:00:00Z'], [2, '2026-09-21T03:00:00Z']] as const;
  for (const [i, [person, occurred_at]] of facts.entries()) await db.ingest({ schema_version: 2, installation_id: installations[person]!, client_event_id: `p-${i}`, occurred_at, event_type: 'UserPromptSubmit', source_session_id: `session-${person}`, payload: { prompt: `PRIVATE_PROMPT_${person}`, repo_url: 'PRIVATE_REPOSITORY' } }, { admissionEpoch: 1, receivedAt: clock() });
  await db.ingest({ schema_version: 2, installation_id: installations[1]!, client_event_id: 'tool', occurred_at: '2026-09-22T02:01:00Z', event_type: 'PostToolUse', source_session_id: 'session-1', payload: { tool_response: 'PRIVATE_TOOL_OUTPUT' } }, { admissionEpoch: 1, receivedAt: clock() });
  return { db, identity, root, departments, people, analytics: createAnalyticsService(db, identity, { clock }) };
}

test('overview deduplicates cross-day and cross-department people and sessions, with event-time registration and no manual expiry', async t => {
  const { analytics, root, departments } = await fixture(t);
  const all = await analytics.overview(root.token, period);
  assert.equal(all.observed_users, 3); assert.equal(all.eligible_users, 2); assert.equal(all.eligible_observed_users, 2);
  assert.equal(all.observed_outside_eligibility, 1); assert.equal(all.outside_eligibility_prompt_events, 1); assert.equal(all.coverage_ratio, 1);
  assert.equal(all.sessions, 3); assert.equal(all.prompt_turns, 6); assert.equal(all.tool_events, 1);
  const a = await analytics.overview(root.token, { ...period, department_id: departments[0] });
  const b = await analytics.overview(root.token, { ...period, department_id: departments[1] });
  assert.equal(a.sessions, 2); assert.equal(b.sessions, 2); assert.equal(a.eligible_users + b.eligible_users, 3);
  assert.equal(a.prompt_turns, 3); assert.equal(b.prompt_turns, 3); assert.equal(b.eligible_users, 1); assert.equal(b.eligible_observed_users, 1);
  assert.ok(!JSON.stringify(all).includes('PRIVATE_')); assert.equal(all.quality.pending_sessions, 3);
  const thirdDay = await analytics.overview(root.token, { from: '2026-09-22T16:00:00Z', to: '2026-09-23T16:00:00Z' });
  assert.equal(thirdDay.eligible_users, 2); assert.equal(thirdDay.observed_users, 1); assert.equal(thirdDay.eligible_observed_users, 1); assert.equal(thirdDay.coverage_ratio, 0.5);
});

test('member drilldown constrains every statistic to the selected event-time department and excludes private content',async t=>{
 const {db,analytics,root,departments,people}=await fixture(t);const worker=createSessionDerivationService(db,{clock});while(await worker.runOne()){/* Publish the fixture projections. */}
 const first=await analytics.member(root.token,people[0]!,{...period,department_id:departments[0]});assert.equal(first.scope.member?.id,people[0]);assert.equal(first.scope.member?.name,'统计员工0');assert.equal(first.prompt_turns,1);assert.equal(first.active_days,1);assert.equal(first.sessions,1);
 const second=await analytics.member(root.token,people[0]!,{...period,department_id:departments[1]});assert.equal(second.prompt_turns,2);assert.equal(second.outside_eligibility_prompt_events,0);
 const query={...period,scope:'organization' as const,department_id:departments[0],member_id:people[0]!};const trend=await analytics.trends(root.token,query);assert.deepEqual(trend.items.map(row=>row.prompt_turns),[1,0,0]);
 assert.equal((await analytics.purposes(root.token,query)).total_sessions,1);assert.equal((await analytics.contentEstimate(root.token,query)).estimate.sessions,1);
 assert.doesNotMatch(JSON.stringify([first,second,trend,await analytics.purposes(root.token,query)]),/PRIVATE_|source_session_id|repo_url|payload/);
 await assert.rejects(analytics.member(root.token,people[2]!,{...period,department_id:departments[0]}),{code:'not_found'});await assert.rejects(analytics.member(root.token,people[0]!,period),{code:'invalid_scope'});await assert.rejects(analytics.overview(root.token,{...query,scope:'self'}),{code:'invalid_scope'});
});
test('department managers may drill only authorized cohorts while personal and generic group scopes stay narrow',async t=>{
 const {db,analytics,root,identity,people,departments}=await fixture(t);const reset=await identity.resetPassword(root.token,people[1]!,1);const initial=await identity.login('analytics-1@example.invalid',reset.temporaryPassword);const employee=await identity.changePassword(initial.token,reset.temporaryPassword,'member-statistics-password');
 const query={...period,scope:'organization' as const,department_id:departments[0],member_id:people[0]!};await assert.rejects(analytics.overview(employee.token,query),{code:'forbidden'});
 await createOrganizationService(db,identity,{clock}).setDepartmentAdmins(root.token,departments[0],[people[1]!],1);const manager=await identity.login('analytics-1@example.invalid','member-statistics-password');
 assert.equal((await analytics.member(manager.token,people[0]!,{...period,department_id:departments[0]})).prompt_turns,1);await assert.rejects(analytics.member(manager.token,people[0]!,{...period,department_id:departments[1]}),{code:'forbidden'});
 await assert.rejects(analytics.overview(manager.token,{...period,scope:'organization',member_id:people[0]!}),{code:'invalid_scope'});await assert.rejects(analytics.members(manager.token,query),{code:'invalid_scope'});
 for(const read of [analytics.trends,analytics.purposes,analytics.contentEstimate,analytics.officialUsage,analytics.models,analytics.declaredModels])await assert.rejects(read(manager.token,{...query,department_id:departments[1]}),{code:'forbidden'});
 await db.query('DELETE FROM role_grants WHERE user_id=$1',[people[1]]);await assert.rejects(analytics.member(manager.token,people[0]!,{...period,department_id:departments[0]}),{code:'forbidden'});
});

test('personal scope stays personal and department grants restrict historical facts after a transfer', async t => {
  const { db, analytics, identity, root, people, departments } = await fixture(t);
  const password = await identity.resetPassword(root.token, people[0]!, 1);
  const temporary = await identity.login('analytics-0@example.invalid', password.temporaryPassword);
  const employee = await identity.changePassword(temporary.token, password.temporaryPassword, 'analytics-person-password');
  const own = await analytics.overview(employee.token, period); assert.equal(own.scope.kind, 'self'); assert.equal(own.prompt_turns, 3); assert.equal(own.observed_users, 1);
  await assert.rejects(analytics.overview(employee.token, { ...period, scope: 'organization' }), { code: 'forbidden' });
  await assert.rejects(analytics.overview(employee.token, { ...period, department_id: departments[0] }), { code: 'forbidden' });
  await assert.rejects(analytics.contentEstimate(employee.token, { ...period, department_id: departments[0] }), { code: 'forbidden' });
  assert.equal((await analytics.contentEstimate(employee.token, { ...period, scope: 'self' })).estimate.sessions, 1);
  const organization = createOrganizationService(db, identity, { clock });
  await organization.setDepartmentAdmins(root.token, departments[0], [people[0]!], 1);
  const manager = await identity.login('analytics-0@example.invalid', 'analytics-person-password');
  assert.equal((await analytics.overview(manager.token, { ...period, department_id: departments[0] })).prompt_turns, 3);
  await assert.rejects(analytics.overview(manager.token, { ...period, department_id: departments[1] }), { code: 'forbidden' });
  await assert.rejects(analytics.contentEstimate(manager.token, { ...period, department_id: departments[1] }), { code: 'forbidden' });
  assert.equal((await analytics.contentEstimate(manager.token, { ...period, department_id: departments[0] })).estimate.sessions, 2);
  assert.equal((await analytics.overview(manager.token, { ...period, scope: 'self' })).prompt_turns, 3);
  assert.equal((await analytics.overview(root.token, { ...period, scope: 'self' })).observed_users, 0);
  assert.equal((await db.query('SELECT count(*) FROM hook_events')).rows[0]?.count, '7');
});

test('recent-window boundaries, zero denominators and cleanup are explicit without treating inactivity as processing lag', async t => {
  const { db, analytics, identity, root, people } = await fixture(t);
  const defaults = await analytics.overview(root.token);
  assert.deepEqual(defaults.period, { from: '2026-09-17T16:00:00.000Z', to: '2026-09-24T16:00:00.000Z' });
  await analytics.overview(root.token, { from: '2026-08-10T16:00:00Z', to: '2026-09-24T16:00:00Z' });
  await assert.rejects(analytics.overview(root.token, { from: '2026-08-10T15:59:59.999Z', to: period.to }), { code: 'invalid_period' });
  await assert.rejects(analytics.overview(root.token, { from: period.from }), { code: 'invalid_period' });
  await assert.rejects(analytics.overview(root.token, { from: period.from, to: '2026-09-24T16:00:00.001Z' }), { code: 'invalid_period' });
  const february = createAnalyticsService(db, identity, { clock: () => new Date('2026-03-03T12:00:00Z') });
  await assert.rejects(february.overview(root.token, { from: '2026-02-30T00:00:00Z', to: '2026-03-03T00:00:00Z' }), { code: 'invalid_period' });
  const empty = await analytics.overview(root.token, { from: '2026-09-18T00:00:00Z', to: '2026-09-19T00:00:00Z' });
  assert.equal(empty.coverage_ratio, null); assert.equal(empty.coverage_reason, 'no_eligible_members');
  const derivations = createSessionDerivationService(db, { clock }); let n = 0; while (await derivations.runOne()) assert.ok(++n < 15);
  const ready = await analytics.overview(root.token, period); assert.equal(ready.quality.state, 'ready'); assert.equal(ready.quality.lag_seconds, 0);
  await db.transaction(async client => {
    await client.query('UPDATE users SET cleanup_generation=cleanup_generation+1 WHERE id=$1', [people[1]]);
    await client.query('INSERT INTO cleanup_tombstones(user_id,from_at,to_at,generation) VALUES($1,$2,$3,1)', [people[1], '2026-09-21Z', '2026-09-22Z']);
  });
  const cleaning = await analytics.overview(root.token, period);
  assert.equal(cleaning.prompt_turns, 5); assert.equal(cleaning.quality.state, 'rebuilding'); assert.equal(cleaning.quality.lag_seconds, null);
  const sid = (await db.query('SELECT id FROM sessions WHERE user_id=$1', [people[1]])).rows[0]!.id;
  await derivations.enqueueRebuild(sid); await derivations.runOne();
  assert.equal((await analytics.overview(root.token, period)).quality.state, 'ready');
});

test('trends keep zero days and weekly distinct counts are not sums of daily counts', async t => {
  const { analytics, root } = await fixture(t);
  const daily = await analytics.trends(root.token, { ...period, granularity: 'day' });
  assert.deepEqual(daily.items.map(item => [item.date, item.observed_users, item.eligible_users, item.eligible_observed_users, item.prompt_turns]), [
    ['2026-09-21', 3, 2, 2, 3], ['2026-09-22', 2, 2, 2, 2], ['2026-09-23', 1, 2, 1, 1],
  ]);
  const weekly = await analytics.trends(root.token, { ...period, granularity: 'week' });
  assert.equal(weekly.items.length, 1); assert.equal(weekly.items[0]?.observed_users, 3); assert.equal(weekly.items[0]?.sessions, 3); assert.equal(weekly.items[0]?.prompt_turns, 6);
  const zero = await analytics.trends(root.token, { from: '2026-09-23T16:00:00Z', to: '2026-09-24T16:00:00Z' });
  assert.equal(zero.items.length, 1); assert.equal(zero.items[0]?.observed_users, 0); assert.equal(zero.items[0]?.eligible_users, 2);
});

test('department comparison and member statistics are paged, period-bound and contain no private content', async t => {
  const { analytics, root, departments } = await fixture(t);
  const first = await analytics.departments(root.token, { ...period, limit: 1 });
  assert.equal(first.total, 2); assert.equal(first.items[0]?.name, '历史A部门'); assert.equal(first.items[0]?.prompt_turns, 3); assert.ok(first.next_cursor);
  const second = await analytics.departments(root.token, { ...period, limit: 1, cursor: first.next_cursor! });
  assert.equal(second.items[0]?.name, '历史B部门'); assert.equal(second.items[0]?.eligible_users, 1); assert.equal(second.has_more, false);
  await assert.rejects(analytics.departments(root.token, { ...period, from: '2026-09-19T16:00:00Z', limit: 1, cursor: first.next_cursor! }), { code: 'invalid_cursor' });
  const members = await analytics.members(root.token, { ...period, department_id: departments[0], limit: 10 });
  assert.equal(members.total, 2); assert.deepEqual(members.items.map(item => [item.name, item.prompt_turns, item.active_days]), [['统计员工0', 1, 1], ['统计员工1', 2, 2]]);
  assert.ok(!JSON.stringify(members).includes('PRIVATE_'));
  const emptySearch = await analytics.members(root.token, { ...period, department_id: departments[0], search: '找不到' });
  assert.equal(emptySearch.total, 0); assert.deepEqual(emptySearch.items, []);
});

test('purpose distribution uses only events inside the requested department and period', async t => {
  const { db, analytics, root, departments, people } = await fixture(t);
  for (const [i, at, type, payload] of [
    [0, '2026-09-21T05:00:00Z', 'UserPromptSubmit', { prompt: '修复 PRIVATE_FIX' }],
    [0, '2026-09-22T05:00:00Z', 'UserPromptSubmit', { prompt: '写测试 PRIVATE_TEST' }],
    [1, '2026-09-21T06:00:00Z', 'PreToolUse', { tool_use_id: 'read', tool_name: 'Read' }],
  ] as const) {
    const installation = (await db.query('SELECT id FROM installations WHERE user_id=$1', [people[i]])).rows[0]!.id;
    await db.ingest({ schema_version: 2, installation_id: installation, client_event_id: `purpose-${at}`, occurred_at: at, event_type: type, source_session_id: `session-${i}`, payload }, { admissionEpoch: 1, receivedAt: clock() });
  }
  const pending = await analytics.purposes(root.token, period);
  assert.equal(pending.total_sessions, 3); assert.equal(pending.pending_sessions, 3);
  const worker = createSessionDerivationService(db, { clock }); let n = 0; while (await worker.runOne()) assert.ok(++n < 15);
  const a = await analytics.purposes(root.token, { ...period, department_id: departments[0] });
  const b = await analytics.purposes(root.token, { ...period, department_id: departments[1] });
  assert.equal(a.items.find(item => item.purpose === 'bugfix')?.sessions, 1);
  assert.equal(a.items.find(item => item.purpose === 'learning')?.behavior_sessions, 1);
  assert.equal(b.items.find(item => item.purpose === 'test')?.sessions, 1);
  assert.equal(b.items.find(item => item.purpose === 'bugfix')?.sessions, 0);
  assert.ok(!JSON.stringify(a).includes('PRIVATE_')); assert.equal(a.pending_sessions, 0);
});

test('tool-only observations remain visible without being counted as observed prompts', async t => {
  const { db, analytics, root, people, departments } = await fixture(t);
  const installation = (await db.query('SELECT id FROM installations WHERE user_id=$1', [people[2]])).rows[0]!.id;
  await db.ingest({ schema_version: 2, installation_id: installation, client_event_id: 'tool-only-today', occurred_at: '2026-09-24T01:00:00Z', event_type: 'PostToolUse', source_session_id: 'tool-only-today', payload: { tool_name: 'Read' } }, { admissionEpoch: 1, receivedAt: clock() });
  const scope = { from: '2026-09-23T16:00:00Z', to: '2026-09-24T16:00:00Z', department_id: departments[1] };
  const summary = await analytics.overview(root.token, scope); assert.equal(summary.observed_users, 0); assert.equal(summary.tool_events, 1); assert.equal(summary.sessions, 1);
  const row = (await analytics.members(root.token, scope)).items.find(item => item.id === people[2]);
  assert.equal(row?.observed_users, 0); assert.equal(row?.sessions, 1); assert.equal(row?.tool_events, 1);
});
