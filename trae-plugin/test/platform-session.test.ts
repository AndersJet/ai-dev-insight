import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {PlatformSession,normalizeWebUrl} from '../src/platform-session.js';

test('a private platform session carries both cookies and CSRF but rejects redirects and subpaths',async()=>{
  assert.equal(normalizeWebUrl('http://EXAMPLE.invalid:80/'),'http://example.invalid');
  for(const url of ['http://example.invalid/trae','http://x.invalid/?q=1','http://u:p@x.invalid/'])assert.throws(()=>normalizeWebUrl(url));
  const requests:{path:string;cookie:string|undefined;csrf:string;origin:string|undefined}[]=[];
  const server=createServer((req,res)=>{
    requests.push({path:req.url!,cookie:req.headers.cookie,csrf:String(req.headers['x-csrf-token']??''),origin:req.headers.origin});
    res.setHeader('Content-Type','application/json');
    if(req.url==='/api/v1/auth/login'){res.setHeader('Set-Cookie',['adi_session=SyntheticSession; HttpOnly; Path=/','adi_csrf=SyntheticCsrf; Path=/']);res.end(JSON.stringify({data:{user_id:'test-user',email:'test@example.org',registered:true,must_change_password:false}}));}
    else if(req.url==='/api/v1/me/plugin-credential'){res.end(JSON.stringify({data:{api_token:'SyntheticApiToken',user_id:'test-user',email:'test@example.org'}}));}
    else if(req.url==='/api/v1/auth/logout'){res.writeHead(204);res.end();}
    else{res.statusCode=302;res.setHeader('Location','https://elsewhere.invalid');res.end('{}');}
  });
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  const address=server.address();assert.ok(address&&typeof address==='object');const origin=`http://127.0.0.1:${address.port}`;
  try{
    const client=new PlatformSession(origin);const signal=new AbortController().signal;
    await client.login('test@example.org','SyntheticPassword123!',signal);
    const token=await client.credential(signal);assert.equal(token.api_token,'SyntheticApiToken');
    assert.equal(requests[1]!.cookie,'adi_session=SyntheticSession; adi_csrf=SyntheticCsrf');assert.equal(requests[1]!.csrf,'SyntheticCsrf');assert.equal(requests[1]!.origin,origin);
    await assert.rejects(client.me(signal),{status:302});
    await client.close(signal);
    assert.equal(requests.at(-1)!.csrf,'SyntheticCsrf');
    await client.credential(signal);assert.equal(requests.at(-1)!.cookie,undefined,'204 logout clears the private cookie jar');
  }finally{await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));}
});
