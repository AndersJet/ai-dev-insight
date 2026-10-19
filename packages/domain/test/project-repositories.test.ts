import {test} from 'node:test';
import assert from 'node:assert/strict';
import {classifyRepositoryAddress} from '../src/project-repositories.js';
import {parseRepositoryAddress,normalizeRepositoryAddresses,normalizeRepositoryHost} from '../../contracts/src/repository-address.js';

test('repository classification uses valid literal 10-network hosts and does not mistake lookalikes or malformed addresses for them',()=>{
  assert.deepEqual(classifyRepositoryAddress('ssh://git:synthetic-secret@10.12.3.4/team/app.git'),{
    address:'ssh://10.12.3.4/team/app.git',host:'10.12.3.4',source_tag:'department',reason:'internal_ipv4',
  });
  assert.equal(classifyRepositoryAddress('https://10.example.com/team/app.git').source_tag,'personal');
  assert.equal(classifyRepositoryAddress('https://110.12.3.4/team/app.git').source_tag,'personal');
  for(const input of ['https://10.999.1.2/team/app.git','https://10.1/team/app.git','https://010.1.2.3/team/app.git','not a repository','https://git.example.com']){
    assert.deepEqual(classifyRepositoryAddress(input),{address:null,host:null,source_tag:null,reason:'unrecognized'});
  }
});

test('host and repository allowlists have different exact boundaries and removing the last match restores personal classification',()=>{
  const host={kind:'host' as const,value:'GIT.EXAMPLE.COM'};
  for(const address of ['https://git.example.com/team/app.git','ssh://git.example.com:2222/other/repo','git://git.example.com/team/app.git'])assert.equal(classifyRepositoryAddress(address,[host]).source_tag,'department');
  for(const address of ['https://sub.git.example.com/team/app.git','https://git.example.com.evil.example/team/app.git'])assert.equal(classifyRepositoryAddress(address,[host]).source_tag,'personal');
  const exact={kind:'repository' as const,value:'https://git.example.com/team/app.git'};
  assert.equal(classifyRepositoryAddress('https://user:synthetic-token@git.example.com/team/app.git?access_token=synthetic-secret',[exact]).source_tag,'department');
  for(const address of ['ssh://git.example.com/team/app.git','https://git.example.com:443/team/app.git','https://git.example.com/team/app.git/sub','https://git.example.com/Team/app.git','https://git.example.com/team/app'])assert.equal(classifyRepositoryAddress(address,[exact]).source_tag,'personal');
  for(const rules of [[host,exact],[host],[exact]])assert.equal(classifyRepositoryAddress(exact.value,rules).reason,'allowlist');
  assert.equal(classifyRepositoryAddress(exact.value,[]).source_tag,'personal');
});

test('SCP remotes and IPv6 remotes remove credentials without collapsing their transport or path identity',()=>{
  assert.deepEqual(parseRepositoryAddress('git@git.example.com:team/App.git'),{address:'git.example.com:team/App.git',host:'git.example.com',internal_ipv4:false});
  assert.equal(classifyRepositoryAddress('git@10.1.2.3:team/app.git').source_tag,'department');
  assert.equal(classifyRepositoryAddress('git@git.example.com:team/app.git',[{kind:'repository',value:'ssh://git.example.com/team/app.git'}]).source_tag,'personal');
  assert.deepEqual(parseRepositoryAddress('ssh://secret:synthetic-token@[2001:0db8::1]:2222/team/app.git?token=synthetic-query#synthetic-fragment'),{address:'ssh://[2001:db8::1]:2222/team/app.git',host:'[2001:db8::1]',internal_ipv4:false});
  for(const host of ['git.example.com:443','[::1]:80','*.example.com','git.example.com/path','10.999.1.2'])assert.equal(normalizeRepositoryHost(host),null);
  for(const input of ['C:/private/repo.git','C:\\private\\repo.git','file:///private/repo.git','ext::secret-command','https://git.example.com:99999/team/app.git','https://git.example.com/team/%0aapp.git'])assert.equal(parseRepositoryAddress(input),null);
  const secret='synthetic-secret-that-must-not-survive';
  const parsed=parseRepositoryAddress(`https://user:${secret}@git.example.com/team/app.git?token=${secret}#${secret}`);
  assert.ok(parsed);assert.equal(JSON.stringify(parsed).includes(secret),false);
});

test('repository address sets sanitize before deduplication and retain distinct addresses plus one unknown',()=>{
  const remotes=[
    {name:'origin',direction:'fetch',address:'HTTPS://user:synthetic-secret@GIT.EXAMPLE.COM/team/app.git?token=synthetic-secret#private'},
    {name:'origin',direction:'push',address:'https://git.example.com/team/app.git'},
    {name:'upstream',direction:'fetch',address:'https://git.example.com/team/app.git'},
    {address:'ssh://git.example.com/team/app.git'},
    {address:'https://git.example.com/team/other.git'},
    {address:null},{address:'not a repository'},{address:'file:///private/repository'},{address:null},
  ];
  assert.deepEqual(normalizeRepositoryAddresses(remotes),[
    {address:'https://git.example.com/team/app.git'},
    {address:'ssh://git.example.com/team/app.git'},
    {address:'https://git.example.com/team/other.git'},
    {address:null},
  ]);
  assert.equal(JSON.stringify(normalizeRepositoryAddresses(remotes)).includes('synthetic-secret'),false);
  assert.deepEqual(normalizeRepositoryAddresses([]),[]);
  assert.equal(remotes[0]!.name,'origin','normalizing evidence must not mutate replay payloads');
});
