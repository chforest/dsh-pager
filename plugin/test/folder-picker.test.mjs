import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const source=fs.readFileSync(new URL('../www/folder-picker.js',import.meta.url),'utf8');
function model(fetcher){const module={exports:{}};vm.runInNewContext(source,{module,AbortController,Error,JSON,setTimeout,clearTimeout,crypto:{randomUUID:()=> '00000000-0000-4000-8000-000000000001'}});return module.exports.createFolderModel(fetcher);}
const reply=value=>({ok:true,status:200,json:async()=>({ok:true,value})});

test('opening folder picker only reads computer locations and never auto-selects a drive',async()=>{
  const calls=[],picker=model(async(url,options)=>{calls.push({url,options});return reply({path:null,parent:null,roots:[{name:'D盘',path:'D:\\'}],entries:[],workspaces:[]});});
  await picker.navigate();assert.equal(picker.state.path,null);assert.equal(await picker.select(),null);
  assert.equal(calls.length,1);assert.equal(calls[0].url,'/m/api/folders?path=');assert.notEqual(calls[0].options.method,'POST');
  assert.equal(picker.cancel(),true);assert.equal(calls.length,1);
});

test('folder navigation aborts earlier reads and ignores stale or cancelled directory results',async()=>{
  const requests=[],picker=model((url,options)=>new Promise(resolve=>requests.push({url,options,resolve})));
  const first=picker.navigate('D:\\older'),second=picker.navigate('E:\\chosen');assert.equal(requests[0].options.signal.aborted,true);
  requests[1].resolve(reply({path:'E:\\chosen',parent:'E:\\',entries:[]}));await second;
  requests[0].resolve(reply({path:'D:\\older',parent:'D:\\',entries:[]}));await first;assert.equal(picker.state.path,'E:\\chosen');
  const late=picker.navigate('D:\\late');picker.cancel();assert.equal(requests[2].options.signal.aborted,true);
  requests[2].resolve(reply({path:'D:\\late'}));await late;assert.equal(picker.state.path,'E:\\chosen');assert.equal(await picker.select(),null);
});

test('only explicit folder confirmation creates one workspace and waits for authoritative id',async()=>{
  const calls=[];let finish;
  const picker=model((url,options)=>{calls.push({url,options});return options.method==='POST'?new Promise(resolve=>{finish=resolve;}):Promise.resolve(reply({path:'D:\\项目',parent:'D:\\',entries:[],workspaces:[]}));});
  await picker.navigate('D:\\项目');assert.equal(calls.length,1);
  const selected=picker.select();assert.equal(await picker.select(),null);assert.equal(calls.length,2);assert.equal(picker.cancel(),false,'confirmation is already in flight');
  const body=JSON.parse(calls[1].options.body);assert.equal(body.path,'D:\\项目');assert.ok(body.requestId);
  finish(reply({workspace:{workspaceId:'w-new',title:'项目',path:'D:\\项目'},created:true}));const workspace=await selected;
  assert.equal(workspace.id,'w-new');assert.equal(workspace.workspaceId,'w-new');assert.equal(picker.state.finished,true);
});

test('unknown workspace creation response cannot automatically replay or return a fabricated workspace',async()=>{
  let posts=0;const picker=model(async(url,options)=>{if(options.method==='POST'){posts++;throw new Error('response lost');}return reply({path:'D:\\项目',entries:[]});});
  await picker.navigate('D:\\项目');assert.equal(await picker.select(),null);assert.equal(picker.state.uncertain,true);assert.match(picker.state.error,/不会自动重试/);
  assert.equal(await picker.select(),null);assert.equal(posts,1);assert.equal(picker.cancel(),true);
});

test('409 outcome_unknown locks folder creation rather than generating a fresh request id',async()=>{
  let posts=0;const picker=model(async(url,options)=>{if(options.method==='POST'){posts++;return{ok:false,status:409,json:async()=>({ok:false,error:{code:'outcome_unknown',message:'工作区创建结果未确认'}})};}return reply({path:'D:\\资料',entries:[]});});
  await picker.navigate('D:\\资料');assert.equal(await picker.select(),null);assert.equal(picker.state.uncertain,true);assert.match(picker.state.error,/不会自动重试/);
  assert.equal(await picker.select(),null);assert.equal(posts,1);
  await picker.navigate('D:\\资料');assert.equal(await picker.select(),null);assert.equal(posts,1,'navigation cannot unlock an unknown mutation');
});

test('folder UI renders server-provided file names as text instead of HTML',()=>{
  assert.doesNotMatch(source,/innerHTML\s*=|insertAdjacentHTML/);assert.match(source,/node\.textContent=text/);
  assert.match(source,/这是电脑上的文件夹，不是手机文件/);
});
