import assert from 'node:assert/strict';

const base='deploy/product/compose.session-capacity.yml';
const unchanged=[{service:'api',cpu:.5,memory:768*1024**2},{service:'collector',cpu:1.25,memory:1024**3}];
const profiles={
 baseline:{name:'baseline',compose_files:[base],services:[{service:'postgres-capacity',cpu:1,memory:2*1024**3},{service:'worker',cpu:.6,memory:1536*1024**2},...unchanged]},
 'pg2-worker2':{name:'pg2-worker2',compose_files:[base,'deploy/product/compose.session-capacity-2cpu.yml'],services:[{service:'postgres-capacity',cpu:2,memory:4*1024**3},{service:'worker',cpu:2,memory:2*1024**3},...unchanged]},
};

export function sessionCapacityResourceProfile(name='baseline'){
 assert.ok(Object.hasOwn(profiles,name),'Unknown explicitly declared synthetic resource profile: '+name);
 return globalThis.structuredClone(profiles[name]);
}

export function assertSessionCapacityResource(profile,record){
 const expected=profile.services.find(s=>s.service===record.service);
 assert.ok(expected,'Unexpected synthetic service: '+record.service);
 assert.equal(record.cpu,expected.cpu,record.service+' CPU must match declared '+profile.name+' profile');
 assert.equal(record.memory,expected.memory,record.service+' memory must match declared '+profile.name+' profile');
}
