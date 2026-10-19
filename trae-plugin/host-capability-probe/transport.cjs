'use strict';
const http=require('node:http');
const allowed=new Set(['/api/setup','/api/login','/api/me','/api/exchange','/api/today']);
function createTransport(origin){
 const u=new URL(origin);if(u.protocol!=='http:'||u.hostname!=='127.0.0.1'||!u.port||u.pathname!=='/'||u.username||u.password||u.search||u.hash)throw new Error('probe_origin_required');
 let apiToken;
 function request(path,method='GET',body,headers={}){
  if(!allowed.has(path))throw new Error('probe_path_required');
  return new Promise((resolve,reject)=>{const payload=body===undefined?null:Buffer.from(JSON.stringify(body));let bytes=0;const chunks=[];
   const req=http.request(new URL(path,origin),{method,headers:{...(payload?{'Content-Type':'application/json','Content-Length':String(payload.length)}:{}),...headers,Origin:origin}},res=>{
    res.on('data',b=>{bytes+=b.length;if(bytes>65536){res.destroy();req.destroy();reject(new Error('probe_response_limit'));return;}chunks.push(b);});
    res.on('error',()=>reject(new Error('probe_transport_failed')));
    res.on('end',()=>{try{resolve({status:res.statusCode,headers:res.headers,json:JSON.parse(Buffer.concat(chunks).toString('utf8'))});}catch{reject(new Error('probe_json_failed'));}});
   });req.setTimeout(3000,()=>req.destroy(new Error('probe_timeout')));req.on('error',()=>reject(new Error('probe_transport_failed')));if(payload)req.write(payload);req.end();
  });
 }
 function status(response,expected){if(response.status!==expected)throw new Error('probe_status_mismatch');return response;}
 function summary(data){
  if(data?.synthetic!==true||data.timezone!=='Asia/Shanghai')throw new Error('probe_summary_mismatch');
  for(const k of ['official_chat_tokens','official_cue_tokens','content_estimate_tokens'])if(!/^\d{1,18}$/.test(data[k]))throw new Error('probe_summary_mismatch');
  return {synthetic:true,business_date:data.business_date,timezone:data.timezone,official_chat_tokens:data.official_chat_tokens,official_cue_tokens:data.official_cue_tokens,hook_sessions:data.hook_sessions,prompt_turns:data.prompt_turns,content_estimate_tokens:data.content_estimate_tokens,as_of:data.as_of};
 }
 return {
  async run(email='probe@example.invalid',password='SyntheticOnly1234'){
   const setup=status(await request('/api/setup'),200);const login=status(await request('/api/login','POST',{email,password}),200);
   const cookies=login.headers['set-cookie'];if(!Array.isArray(cookies)||cookies.length!==2)throw new Error('probe_cookie_count');
   const values=new Map(cookies.map(c=>{const pair=c.split(';',1)[0],i=pair.indexOf('=');return [pair.slice(0,i),pair.slice(i+1)];}));
   const cookie=[...values].map(([k,v])=>k+'='+v).join('; '),csrf=login.json.data.csrf_token;
   if(values.get('adi_probe_csrf')!==csrf||!values.has('adi_probe_session'))throw new Error('probe_cookie_mismatch');
   status(await request('/api/me','GET',undefined,{Cookie:cookie}),200);
   status(await request('/api/exchange','POST',{}, {Cookie:cookie,'X-CSRF-Token':'synthetic-wrong-csrf'}),403);
   const exchange=status(await request('/api/exchange','POST',{}, {Cookie:cookie,'X-CSRF-Token':csrf}),200);
   const repeat=status(await request('/api/exchange','POST',{}, {Cookie:cookie,'X-CSRF-Token':csrf}),200);
   apiToken=exchange.json.data.api_token;
   if(typeof apiToken!=='string'||!apiToken.startsWith('probe_api_')||apiToken!==repeat.json.data.api_token)throw new Error('probe_token_mismatch');
   status(await request('/api/today'),401);
   const today=status(await request('/api/today','GET',undefined,{Authorization:'Bearer '+apiToken}),200);
   return {checks:{setup_received:Array.isArray(setup.json.data.departments),two_set_cookie:true,http_only_session:/(?:^|;)\s*HttpOnly(?:;|$)/i.test(cookies.find(c=>c.startsWith('adi_probe_session='))),private_cookie_get:true,wrong_csrf_rejected:true,same_account_mock_token_reused:true,bearer_today:true,https_tested:false},summary:summary(today.json.data)};
  },
  async today(){if(!apiToken)throw new Error('probe_run_first');return summary(status(await request('/api/today','GET',undefined,{Authorization:'Bearer '+apiToken}),200).json.data);},
  clear(){apiToken=undefined;}
 };
}
module.exports={createTransport};
