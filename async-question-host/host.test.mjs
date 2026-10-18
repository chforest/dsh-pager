import {test} from 'node:test';import assert from 'node:assert/strict';import path from 'node:path';import {apply} from './index.js';
test('candidate native defineTool accepts async question registration without executing it',{skip:!process.env.DSH_TEST_PROFILE?'Set DSH_TEST_PROFILE to an isolated SDK installation':false},async()=>{
 const before=process.argv[1];let registered;
 try{process.argv[1]=path.join(process.env.DSH_TEST_PROFILE,'entry.mjs');await apply({systemPrompt:{section:()=>{}},tools:{register:tool=>{registered=tool}}});}finally{process.argv[1]=before}
 assert.equal(registered.name,'ask_user_async');assert.equal(typeof registered.execute,'function');assert.equal(registered.parameters.type,'object');assert.equal(registered.timeoutMs,90000);
});
for(const modern of [false,true])test('async host authenticates only local question creation without replay '+modern,{skip:!process.env.DSH_TEST_PROFILE?'Set DSH_TEST_PROFILE to an isolated SDK installation':false},async()=>{
 const argv=process.argv[1],originalFetch=globalThis.fetch,calls=[];let registered;
 const agent={id:'session-fixture',session:{id:'session-fixture'}},agents={get:()=>agent,roots:()=>[agent]};
 globalThis.fetch=async(url,options)=>{calls.push({url:String(url),options});return calls.length===1&&modern?{status:302,headers:{getSetCookie:()=>['fixture-owner=yes; HttpOnly']},body:{cancel:async()=>{}}}:{ok:false,status:401,json:async()=>({ok:false,error:{message:'fixture unauthorized'}})};};
 try{
  process.argv[1]=path.join(process.env.DSH_TEST_PROFILE,'entry.mjs');
  await apply({webServer:{port:12345},get:()=>agents,connection:modern?{authenticatedUrl:url=>url+'?fixture=1'}:undefined,systemPrompt:{section:()=>{}},tools:{register:tool=>{registered=tool}}});
  await assert.rejects(registered.execute({question:'fixture?',independent_work:'fixture work'},{agent,callId:'fixture-call'}),/fixture unauthorized/);
  assert.equal(calls.length,modern?2:1);const write=calls.at(-1);assert.equal(new URL(write.url).pathname,'/m/api/async-questions/create');assert.equal(write.options.method,'POST');assert.equal(write.options.headers.get('cookie'),modern?'fixture-owner=yes':null);assert.equal(write.options.redirect,'error');
 }finally{process.argv[1]=argv;globalThis.fetch=originalFetch}
});
