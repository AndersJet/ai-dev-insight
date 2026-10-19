import {test} from 'node:test';
import assert from 'node:assert/strict';
import {zipSync} from 'fflate';
import {pluginFixture} from '../plugin-fixture.js';
import {createApi} from '../../src/app.js';
import {createPluginReleaseService} from '../../../../packages/domain/src/plugin-releases.js';
function packageFile(build:string,version='1.0.0'){
 const manifest={name:'adi-project-tracker',publisher:'ai-dev-insight',version,adiBuildId:build,main:'./dist/extension.cjs',engines:{vscode:'^1.107.0'}};
 return Buffer.from(zipSync({'extension/package.json':Buffer.from(JSON.stringify(manifest)),'extension/dist/extension.cjs':Buffer.from('module.exports = '+JSON.stringify(build)+';'),'extension.vsixmanifest':Buffer.from(`<PackageManifest><Metadata><Identity Id="adi-project-tracker" Version="${version}" Publisher="${manifest.publisher}"/></Metadata></PackageManifest>`),'[Content_Types].xml':Buffer.from('<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>')}));
}
function multipart(data:Buffer){return Buffer.concat([Buffer.from('--test-boundary\r\nContent-Disposition: form-data; name="file"; filename="plugin.vsix"\r\nContent-Type: application/octet-stream\r\n\r\n'),data,Buffer.from('\r\n--test-boundary--\r\n')]);}
test('上传检查插件包，正式下载匿名可用且试用只能由指定插件账号获取',async t=>{
 const f=await pluginFixture(t);const app=createApi(undefined,{identity:f.identity,plugin:{db:f.db,signingKey:Buffer.alloc(32,17)},pluginReleases:createPluginReleaseService(f.db,f.identity),allowedOrigin:'http://web.example.invalid'});t.after(()=>app.close());
 const headers={...f.headers,'content-type':'multipart/form-data; boundary=test-boundary'};
 const invalid=await app.inject({method:'POST',url:'/api/v1/system/plugin-releases/upload',headers,payload:multipart(Buffer.from('not a zip'))});assert.equal(invalid.statusCode,422,invalid.body);
 const bytes=packageFile('a'.repeat(64));const uploaded=await app.inject({method:'POST',url:'/api/v1/system/plugin-releases/upload',headers,payload:multipart(bytes)});assert.equal(uploaded.statusCode,200,uploaded.body);const r=uploaded.json().data;
 assert.equal(r.state,'draft');assert.equal((await app.inject({url:r.download_path})).statusCode,401);
 const pilot=await app.inject({method:'POST',url:`/api/v1/system/plugin-releases/${r.id}/pilot`,headers:f.headers,payload:{build_id:r.build_id,user_ids:[f.root.user.user_id]}});assert.equal(pilot.statusCode,200,pilot.body);
 assert.equal((await app.inject({url:'/api/v1/plugin-releases/trial'})).statusCode,401);
 const trial=await app.inject({url:'/api/v1/plugin-releases/trial',headers:f.bearer});assert.equal(trial.statusCode,200,trial.body);assert.equal(trial.json().data.build_id,r.build_id);
 assert.equal((await app.inject({url:r.download_path,headers:f.bearer})).rawPayload.equals(bytes),true);
 const pub=await app.inject({method:'POST',url:`/api/v1/system/plugin-releases/${r.id}/publish`,headers:f.headers,payload:{build_id:r.build_id}});assert.equal(pub.statusCode,200,pub.body);
 await f.db.query('UPDATE data_identity SET collection_enabled=false');
 const current=await app.inject({url:'/api/v1/plugin-releases/current'});assert.equal(current.statusCode,200,current.body);assert.equal(current.json().data.build_id,r.build_id);
 assert.equal((await app.inject({url:r.download_path})).rawPayload.equals(bytes),true);
});
export {packageFile,multipart};

test('普通员工不能管理发行，伪造或越权试用及不合法包均拒绝',async t=>{
 const f=await pluginFixture(t);const {createPluginCredentialService}=await import('@adi/domain');
 await f.registration.register({email:'synthetic.release-employee@example.org',display_name:'合成员工',password:'synthetic-release-employee-password',department_id:f.department.id});const employee=await f.identity.login('synthetic.release-employee@example.org','synthetic-release-employee-password');
 const token=(await createPluginCredentialService(f.db,f.identity,{encryptionKey:Buffer.alloc(32,17)}).credential(employee.token)).api_token;
 const service=createPluginReleaseService(f.db,f.identity),app=createApi(undefined,{identity:f.identity,pluginReleases:service,plugin:{db:f.db,signingKey:Buffer.alloc(32,17)},allowedOrigin:'http://web.example.invalid'});t.after(()=>app.close());
 const eheaders={cookie:`adi_session=${employee.token}`,'x-csrf-token':employee.csrfToken,origin:'http://web.example.invalid'};
 assert.equal((await app.inject({url:'/api/v1/system/plugin-releases',headers:eheaders})).statusCode,403);
 const file=packageFile('e'.repeat(64));assert.equal((await app.inject({method:'POST',url:'/api/v1/system/plugin-releases/upload',headers:{...eheaders,'content-type':'multipart/form-data; boundary=test-boundary'},payload:multipart(file)})).statusCode,403);
 assert.equal((await app.inject({method:'POST',url:'/api/v1/system/plugin-releases/upload',headers:{...f.headers,'x-csrf-token':'forged','content-type':'multipart/form-data; boundary=test-boundary'},payload:multipart(file)})).statusCode,403);
 const r=await service.upload(f.root.token,{version:'1.0.0',build_id:'e'.repeat(64),package:file});await service.setPilot(f.root.token,r.id,{build_id:r.build_id,user_ids:[f.root.user.user_id]});
 const denied=await app.inject({url:r.download_path,headers:{authorization:`Bearer ${token}`}});assert.equal(denied.statusCode,403);assert.equal(denied.body.includes('synthetic executable'),false);
 assert.equal((await app.inject({url:'/api/v1/plugin-releases/trial',headers:{authorization:`Bearer ${token}`}})).json().data,null);
 const broken=Buffer.from(packageFile('f'.repeat(64),'1.1.0'));let offset=0;while(broken.readUInt32LE(offset)===0x04034b50){const size=broken.readUInt32LE(offset+18),nameLength=broken.readUInt16LE(offset+26),extraLength=broken.readUInt16LE(offset+28),payload=offset+30+nameLength+extraLength;const name=broken.subarray(offset+30,offset+30+nameLength).toString();if(name==='extension/dist/extension.cjs'){broken.fill(0xff,payload,payload+size);break;}offset=payload+size;}
 assert.equal((await app.inject({method:'POST',url:'/api/v1/system/plugin-releases/upload',headers:{...f.headers,'content-type':'multipart/form-data; boundary=test-boundary'},payload:multipart(broken)})).statusCode,422);
 const wrong=Buffer.from(zipSync({'extension/package.json':Buffer.from(JSON.stringify({name:'other',publisher:'other',version:'1.0.0'}))}));
 assert.equal((await app.inject({method:'POST',url:'/api/v1/system/plugin-releases/upload',headers:{...f.headers,'content-type':'multipart/form-data; boundary=test-boundary'},payload:multipart(wrong)})).statusCode,422);
 const inconsistent=Buffer.from(file);inconsistent.writeUInt16LE(1,inconsistent.length-22+8);
 assert.equal((await app.inject({method:'POST',url:'/api/v1/system/plugin-releases/upload',headers:{...f.headers,'content-type':'multipart/form-data; boundary=test-boundary'},payload:multipart(inconsistent)})).statusCode,422);
});
