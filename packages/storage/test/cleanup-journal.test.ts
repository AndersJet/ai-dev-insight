import {test} from 'node:test';import assert from 'node:assert/strict';import {mkdtemp,rm,readdir,writeFile} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join} from 'node:path';import {randomUUID} from 'node:crypto';import {createCleanupJournal} from '../src/cleanup-journal.js';
test('cleanup recovery records are immutable, retryable, scoped to a dataset and validated before replay',async t=>{
 const directory=await mkdtemp(join(tmpdir(),'adi-cleanup-journal-'));t.after(()=>rm(directory,{recursive:true,force:true}));const journal=createCleanupJournal(directory),dataset=randomUUID(),operation=randomUUID();const ids=[randomUUID(),randomUUID()].sort();
 const record={version:1 as const,dataset_id:dataset,operation_id:operation,user_id:randomUUID(),target_email:'cleanup@example.invalid',actor_id:randomUUID(),from:'2026-09-22T00:00:00.000Z',to:'2026-09-23T00:00:00.000Z',cleanup_generation:1,created_at:'2026-09-24T12:00:00.000Z'};
 const pages=async function*(){yield ids;};const first=await journal.publish(record,pages());assert.equal((await journal.publish(record,pages())).digest,first.digest);const loaded=await journal.open(dataset,operation);assert.equal(loaded.record.user_id,record.user_id);const restored:string[]=[];for await(const page of loaded.sessions())restored.push(...page);assert.deepEqual(restored,ids);
 await assert.rejects(journal.publish({...record,target_email:'different@example.invalid'},pages()));await assert.rejects(journal.open(randomUUID(),operation));
 const files=await readdir(join(directory,dataset,operation));const part=files.find(name=>name.startsWith('part-'))!;await writeFile(join(directory,dataset,operation,part),'corrupted');await assert.rejects(journal.open(dataset,operation));
});
test('a pinned cleanup checkpoint detects a missing whole accepted operation',async t=>{
 const directory=await mkdtemp(join(tmpdir(),'adi-checkpoint-'));t.after(()=>rm(directory,{recursive:true,force:true}));const journal=createCleanupJournal(directory),dataset=randomUUID(),operation=randomUUID();
 await journal.accept({version:1,dataset_id:dataset,operation_id:operation,user_id:randomUUID(),target_email:'accepted@example.invalid',actor_id:randomUUID(),from:'2026-09-22T00:00:00.000Z',to:'2026-09-23T00:00:00.000Z',cleanup_generation:1,created_at:'2026-09-24T12:00:00.000Z'});
 const checkpoint=await journal.createCheckpoint(dataset,'a'.repeat(64));assert.equal((await journal.verifyCheckpoint(dataset,checkpoint)).length,1);await rm(join(directory,dataset,operation),{recursive:true});await assert.rejects(journal.verifyCheckpoint(dataset,checkpoint));
});

test('accepted cleanup proofs retain paged project ordering barriers and reject missing or changed barrier parts',async t=>{
 const directory=await mkdtemp(join(tmpdir(),'adi-project-proof-'));t.after(()=>rm(directory,{recursive:true,force:true}));
 const journal=createCleanupJournal(directory),dataset=randomUUID(),operation=randomUUID(),collector=randomUUID();
 const base={version:1 as const,dataset_id:dataset,operation_id:operation,user_id:randomUUID(),target_email:'project-proof@example.invalid',actor_id:randomUUID(),from:'2026-09-22T00:00:00.000Z',to:'2026-09-23T00:00:00.000Z',cleanup_generation:1,created_at:'2026-09-24T12:00:00.000Z'};
 const barriers=Array.from({length:501},(_,i)=>({collector_id:collector,workspace_key:i.toString(16).padStart(64,'0'),latest_sequence:'9',confirmed_sequence:'7'}));
 const pages=async function*(){yield barriers.slice(0,500);yield barriers.slice(500);};
 const project_barriers=await journal.writeProjects(base,pages());
 assert.equal(project_barriers.parts,2);assert.equal(project_barriers.barriers,501);
 const record={...base,project_barriers};await journal.accept(record);
 const checkpoint=await journal.createCheckpoint(dataset,'a'.repeat(64));const proof=(await journal.verifyCheckpoint(dataset,checkpoint))[0]!;
 const restored=[];for await(const page of proof.projects())restored.push(...page);assert.deepEqual(restored,barriers);
 assert.deepEqual(await journal.writeProjects(base,pages()),project_barriers);
 await assert.rejects(journal.writeProjects(base,(async function*(){yield [{...barriers[0]!,confirmed_sequence:'8'}];})()));
 await writeFile(join(directory,dataset,operation,'project-part-000001.json'),'corrupted');
 await assert.rejects(journal.verifyCheckpoint(dataset,checkpoint));
});
