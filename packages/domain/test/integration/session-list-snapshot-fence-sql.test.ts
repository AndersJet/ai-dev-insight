import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {stopUsageFixture} from '../helpers/stop-usage.js';
import {createSessionListSnapshotPublisher} from '../../src/session-list-snapshot-publisher.js';
import {createSessionListSnapshotReader} from '../../src/session-list-snapshot-reading.js';
import {createSessionReadService} from '../../src/session-reading.js';

test('the SQL boolean fence rejects a removed snapshot owner globally while an unaffected owned read remains valid',async t=>{
 const f=await stopUsageFixture(t),other=randomUUID();
 await f.db.query("INSERT INTO users(id,email_key,display_name) VALUES($1,'removed-fence-owner@example.invalid','Removed owner')",[other]);
 const options={providerAccount:'stop-test',stopWindowEnabled:true},publisher=createSessionListSnapshotPublisher(f.db,options);
 await publisher.runOne(true);
 const snapshots=createSessionListSnapshotReader(f.db,options),reader=createSessionReadService(f.db,f.identity,{...options,snapshots});
 assert.equal((await reader.listAll(f.login.token,{})).total,1,'warm the global header, entries and result view before removal');
 await f.db.query('DELETE FROM users WHERE id=$1',[other]);
 await assert.rejects(reader.listAll(f.login.token,{}),{code:'content_changed'});
 assert.equal((await reader.listMine(f.login.token,{})).total,1,'an unrelated removed owner must not revoke the self-only snapshot');
 assert.equal((await reader.listAll(f.login.token,{user_id:randomUUID()})).total,0,'unknown owner filters preserve the original empty-view contract');
});
