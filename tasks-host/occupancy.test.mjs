import {test} from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import {createTaskService} from './service.mjs';import {createNativeAdapter} from './index.js';
for(const legacy of [false,true])test('active run avoids revisiting 160k prior events with '+(legacy?'cached legacy marker':'eventStartSeq'),async()=>{
 let reads=0;const history=[];
 for(let i=0;i<160000;i++){const event={seq:i,data:{}};Object.defineProperty(event,'type',{get(){reads++;return 'fixture/history'}});history.push(Object.freeze(event));}
 const tail=[{seq:160000,type:'automatic-task/start',data:{runId:'r',sourceTag:'dsh-tasks/r'}},{seq:160001,type:'automatic-task/goal',data:{runId:'r',sourceTag:'dsh-tasks/r',goalId:'g'}},{seq:160002,type:'turn/start',data:{turn:1}},{seq:160003,type:'user/message',data:{message:{source:{kind:'goal',goalId:'g'}}}}];
 let snapshot=Object.freeze([...history,...tail]);const agent={id:'s',status:'running',session:{header:{},get events(){return snapshot}}};
 const adapter=createNativeAdapter({agents:{get:()=>agent},goals:{get:()=>({id:'g',phase:'active',activation:'armed'})}},{}),task={continuous:true,sourceSessionId:'s',context:{workspacePath:os.tmpdir()}},run={id:'r',sourceTag:'dsh-tasks/r',sessionId:'s',stage:'accepted',status:'running',goal:{id:'g'},inSourceSession:true,...legacy?{}:{eventStartSeq:159999}};
 assert.equal((await adapter.inspect(task,run)).status,'running');if(!legacy)assert.ok(reads<=1,'only constant-time checkpoint anchor may be read');const baseline=reads;
 for(let i=0;i<20;i++){snapshot=Object.freeze([...snapshot,{seq:snapshot.length,type:'fixture/delta',data:{}}]);assert.equal((await adapter.inspect(task,run)).status,'running');}
 assert.equal(reads,baseline,'new immutable snapshots must never re-scan history before marker');
 snapshot=Object.freeze([...snapshot,{seq:snapshot.length,type:'automatic-task/goal',data:{runId:'r',sourceTag:'wrong',goalId:'g'}}]);await assert.rejects(adapter.inspect(task,run),/归属数据无效/);
});
test('immutable SDK snapshots inspect only appended tail, never revisit 160k old events',async()=>{
 let historicalReads=0;
 const events=[{seq:1,type:'turn/start',data:{turn:1}},{seq:2,type:'user/message',data:{message:{source:{kind:'plugin',plugin:'dsh-tasks/old'}}}}];
 for(let i=0;i<160000;i++){const e={seq:i+3,data:{}};Object.defineProperty(e,'type',{get(){historicalReads++;return 'fixture/delta'}});events.push(e);}
 events.push({seq:160003,type:'turn/end',data:{turn:1,reason:{kind:'completed'}}});
 let snapshot=Object.freeze(events.map(event=>Object.freeze(event)));const originalSnapshot=snapshot;const session={header:{},get events(){return snapshot}};const append=(...tail)=>{const previous=snapshot;snapshot=Object.freeze([...snapshot,...tail.map(event=>Object.freeze(event))]);assert.notEqual(snapshot,previous);assert.equal(snapshot[previous.length-1],previous.at(-1));};
 const agent={id:'s',status:'idle',inbox:{hasPending:false},session};let goal={id:'old-goal',phase:'paused',activation:'disarmed'};
 const adapter=createNativeAdapter({agents:{get:()=>agent},goals:{get:()=>goal}},{}),task={continuous:true,archived:true,context:{workspacePath:os.tmpdir()}},run={id:'old',sourceTag:'dsh-tasks/old',sessionId:'s',stage:'accepted',status:'interrupted',goal:{id:'old-goal'}};
 assert.equal((await adapter.inspect(task,run)).occupancyConfirmedStopped,true);const baseline=historicalReads;
 append({seq:160004,type:'turn/start',data:{turn:2}},{seq:160005,type:'user/message',data:{message:{source:{kind:'goal',goalId:'new-goal'}}}});agent.status='running';goal={id:'new-goal',phase:'active',activation:'armed'};
 for(let i=0;i<25;i++){append({seq:160006+i,type:'fixture/delta',data:{}});assert.equal((await adapter.inspect(task,run)).occupancyConfirmedStopped,true);}
 assert.equal(originalSnapshot.length,160003,'prior SDK snapshot never grows');
 assert.equal(historicalReads,baseline,'stream growth must not call bounds/inspectRun on historical events');
 append({seq:160031,type:'user/message',data:{message:{source:{kind:'plugin',plugin:'dsh-tasks/old'}}}});assert.equal((await adapter.inspect(task,run)).occupancyConfirmedStopped,false);
});
test('new owned goal in shared session does not resurrect a proven stopped archive; old run activity does',async()=>{
 const events=[{seq:1,type:'turn/start',data:{turn:1}},{seq:2,type:'user/message',data:{message:{source:{kind:'plugin',plugin:'dsh-tasks/old'}}}},{seq:3,type:'turn/end',data:{turn:1,reason:{kind:'completed'}}}];
 const agent={id:'s',status:'idle',inbox:{hasPending:false},session:{header:{},events}};let goal={id:'old-goal',revision:1,phase:'paused',activation:'disarmed'};
 const adapter=createNativeAdapter({agents:{get:()=>agent},goals:{get:()=>goal}},{}),task={continuous:true,archived:true,context:{workspacePath:os.tmpdir()}},run={id:'old',sourceTag:'dsh-tasks/old',sessionId:'s',stage:'accepted',status:'interrupted',goal:{id:'old-goal'}};
 assert.equal((await adapter.inspect(task,run)).occupancyConfirmedStopped,true);
 events.push({seq:4,type:'turn/start',data:{turn:2}},{seq:5,type:'user/message',data:{message:{source:{kind:'goal',goalId:'new-goal'}}}});agent.status='running';goal={id:'new-goal',revision:1,phase:'active',activation:'armed'};
 const unrelated=await adapter.inspect(task,run);assert.equal(unrelated.occupancyConfirmedStopped,true);assert.equal(unrelated.running,false,'service occupancy refers to old run, not shared agent');
 events.push({seq:6,type:'fixture/delta',data:{}});assert.equal((await adapter.inspect(task,run)).occupancyConfirmedStopped,true,'proof survives subsequent new-turn deltas');
 goal={id:'old-goal',revision:2,phase:'active',activation:'armed'};assert.equal((await adapter.inspect(task,run)).occupancyConfirmedStopped,false);
});
test('snapshot replacement is not append when session or old boundary identity changes',async()=>{
 let events=Object.freeze([{seq:0,type:'fixture',data:{}}]);let session={header:{},get events(){return events}};
 const agent={id:'s',status:'idle',inbox:{hasPending:false},get session(){return session}};let goal=null;
 const adapter=createNativeAdapter({agents:{get:()=>agent},goals:{get:()=>goal}},{}),task={continuous:true,archived:true,context:{workspacePath:os.tmpdir()}},run={id:'r',sourceTag:'dsh-tasks/r',sessionId:'s',stage:'accepted',status:'interrupted',goal:{id:'old'}};
 assert.equal((await adapter.inspect(task,run)).occupancyConfirmedStopped,true);
 agent.status='running';goal={id:'new',phase:'active',activation:'armed'};
 events=Object.freeze([{seq:0,type:'replacement',data:{}},{seq:1,type:'turn/start',data:{turn:2}},{seq:2,type:'user/message',data:{message:{source:{kind:'goal',goalId:'new'}}}}]);
 assert.equal((await adapter.inspect(task,run)).occupancyConfirmedStopped,false,'same length prefix with different boundary cannot inherit stopped proof');
 agent.status='idle';goal=null;assert.equal((await adapter.inspect(task,run)).occupancyConfirmedStopped,true);
 session={header:{},get events(){return events}};agent.status='running';goal={id:'new',phase:'active',activation:'armed'};
 assert.equal((await adapter.inspect(task,run)).occupancyConfirmedStopped,false,'new session object cannot inherit old proof');
});
test('native inspection handles more than 150k events in a single owned turn',async()=>{
 const events=[{seq:1,type:'turn/start',data:{turn:1}},{seq:2,type:'user/message',data:{message:{source:{kind:'plugin',plugin:'dsh-tasks/r'}}}}];
 for(let i=0;i<160000;i++)events.push({seq:i+3,type:'fixture/delta',data:{}});
 events.push({seq:160003,type:'assistant/message',data:{message:{content:[{type:'text',text:'fixture final'}]}}},{seq:160004,type:'turn/end',data:{turn:1,reason:{kind:'completed'}}});
 const agent={id:'s',status:'idle',inbox:{hasPending:false},session:{header:{},events}};
 const adapter=createNativeAdapter({agents:{get:()=>agent},goals:{get:()=>({id:'g',phase:'paused',activation:'disarmed'})}},{});
 const task={continuous:true,archived:true,context:{workspacePath:os.tmpdir()}},run={id:'r',sourceTag:'dsh-tasks/r',sessionId:'s',stage:'accepted',status:'interrupted',goal:{id:'g'}};
 const view=await adapter.inspect(task,run);assert.equal(view.occupancyConfirmedStopped,true);assert.equal(view.summary,'fixture final');
 events.pop();assert.equal((await adapter.inspect(task,run)).summary,'fixture final','open owned turn also avoids spread argument limit');
});
test('suppressed inspection cache skips unchanged scans but invalidates on events, goal, state and agent identity',async()=>{
 let reads=0;const event={seq:1,data:{}};Object.defineProperty(event,'type',{get(){reads++;return 'fixture'}});
 const events=[event];let agent={id:'s',status:'idle',inbox:{hasPending:false},session:{header:{},events}},goal={id:'g',revision:1,phase:'paused',activation:'disarmed'};
 const adapter=createNativeAdapter({agents:{get:()=>agent},goals:{get:()=>goal}},{}),task={continuous:true,archived:true,context:{workspacePath:os.tmpdir()}},run={id:'r',sourceTag:'dsh-tasks/r',sessionId:'s',stage:'accepted',status:'interrupted',goal:{id:'g'}};
 assert.equal((await adapter.inspect(task,run)).occupancyConfirmedStopped,true);const first=reads;
 await adapter.inspect(task,run);assert.equal(reads,first);
 agent.status='running';assert.equal((await adapter.inspect(task,run)).occupancyConfirmedStopped,false);assert.ok(reads>first);agent.status='idle';
 goal={...goal,revision:2,activation:'armed'};assert.equal((await adapter.inspect(task,run)).occupancyConfirmedStopped,false);goal={...goal,revision:3,activation:'disarmed'};
 events.push({seq:2,type:'approval/asked',data:{id:'x'}});assert.equal((await adapter.inspect(task,run)).occupancyConfirmedStopped,false);
 events.push({seq:3,type:'approval/decided',data:{id:'x'}});assert.equal((await adapter.inspect(task,run)).occupancyConfirmedStopped,true);
 agent.inbox.hasPending=true;assert.equal((await adapter.inspect(task,run)).occupancyConfirmedStopped,false);agent.inbox.hasPending=false;
 agent={...agent,status:'running'};assert.equal((await adapter.inspect(task,run)).occupancyConfirmedStopped,false);agent.status='idle';
 await adapter.inspect(task,run);for(let i=0;i<129;i++)await adapter.inspect(task,{...run,id:'r'+i,sourceTag:'dsh-tasks/r'+i});const before=reads;await adapter.inspect(task,run);assert.ok(reads>before,'old entries evicted after 128 cached runs');
});
test('cold archived inspection only resolves existing session through read-only models, never create or prompt',async t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'cold-occupancy-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));let agent;const calls=[];
 const adapter=createNativeAdapter({agents:{get:()=>agent},goals:{get:()=>({id:'g',phase:'paused',activation:'disarmed'})}},{rpc:async(method,payload)=>{
  calls.push(method);if(method==='workspace.list')return{items:[{workspaceId:'w',path:dir}]};
  assert.equal(method,'session.models');assert.equal(payload.sessionId,'saved-session');agent={id:'saved-session',status:'idle',inbox:{hasPending:false},session:{header:{cwd:dir},events:[]}};return{current:{provider:'fixture',model:'fixture'}};
 }});
 const task={workspaceId:'w',continuous:true,archived:true,context:{workspacePath:dir}},run={id:'r',sourceTag:'dsh-tasks/r',sessionId:'saved-session',stage:'accepted',status:'interrupted',goal:{id:'g'}};
 assert.equal((await adapter.inspect(task,run)).occupancyConfirmedStopped,true);assert.deepEqual(calls,['workspace.list','session.models']);
 agent=undefined;calls.length=0;assert.notEqual((await adapter.inspect(task,{...run,status:'unknown'})).occupancyConfirmedStopped,true);assert.deepEqual(calls,[]);
});
test('confirmed stopped archived runs release both global slots and source-session occupancy without replay',async t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'task-occupancy-'));let now=0,dispatch=0,inspected=0;
 const old=i=>({id:'old'+i,title:'archived',archived:true,enabled:false,status:'interrupted',lastRun:{id:'r'+i,sessionId:'source',stage:'accepted',status:'interrupted',running:false}});
 fs.writeFileSync(path.join(dir,'tasks.json'),JSON.stringify({version:1,tasks:[old(1),old(2)],requests:[]}));
 const adapter={validate:async()=>({}),prepare:async()=>{},canStart:async()=>true,dispatch:async()=>{dispatch++;return{running:false}},inspect:async(task)=>{inspected++;return{status:'interrupted',running:false,occupancyConfirmedStopped:task.archived}},disarm:async()=>{}};
 const service=createTaskService({dir,adapter,now:()=>now});t.after(async()=>{await service.close();fs.rmSync(dir,{recursive:true,force:true})});
 await service.mutate({action:'create',task:{title:'due',objective:'fixture',workspaceId:'w',sourceSessionId:'source',schedule:{kind:'interval',seconds:300}}});now=301000;await service.tick();await service.drain();assert.equal(dispatch,1);assert.ok(inspected>=2);const rows=await service.list();for(const old of rows.filter(x=>x.archived)){assert.equal(old.enabled,false);assert.equal(old.lastRun.status,'interrupted');}
});
for(const view of [{running:true,occupancyConfirmedStopped:false},{running:false},{running:false,occupancyConfirmedStopped:false}])test('unproven or running archived work still occupies slots '+JSON.stringify(view),async t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'task-unknown-'));let dispatch=0,now=0;
 fs.writeFileSync(path.join(dir,'tasks.json'),JSON.stringify({version:1,requests:[],tasks:[{id:'old',archived:true,enabled:false,status:'interrupted',lastRun:{id:'r',status:'interrupted',stage:'accepted',running:false}}]}));
 const service=createTaskService({dir,maxActive:1,now:()=>now,adapter:{validate:async()=>({}),inspect:async()=>view,prepare:async()=>{},dispatch:async()=>{dispatch++},disarm:async()=>{}}});t.after(async()=>{await service.close();fs.rmSync(dir,{recursive:true,force:true})});await service.mutate({action:'create',task:{title:'due',objective:'fixture',workspaceId:'w',schedule:{kind:'interval',seconds:300}}});now=301000;await service.tick();await service.drain();assert.equal(dispatch,0);
});
test('native inspection confirms only idle, disarmed, non-unknown work with no approvals or inbox',async()=>{
 const events=[],agent={id:'s',status:'idle',inbox:{hasPending:false},session:{header:{},events}};let goal={id:'g',phase:'paused',activation:'disarmed'};let attached=true;
 const adapter=createNativeAdapter({agents:{get:()=>attached?agent:null},goals:{get:()=>goal}},{});
 const task={continuous:true,archived:true,context:{workspacePath:os.tmpdir()}},run={id:'r',sourceTag:'dsh-tasks/r',sessionId:'s',stage:'accepted',status:'interrupted',goal:{id:'g'}};
 assert.equal((await adapter.inspect(task,run)).occupancyConfirmedStopped,true);
 for(const status of ['running','disposed']){agent.status=status;assert.notEqual((await adapter.inspect(task,run)).occupancyConfirmedStopped,true);}agent.status='idle';
 goal.activation='armed';assert.notEqual((await adapter.inspect(task,run)).occupancyConfirmedStopped,true);goal.activation='disarmed';
 agent.inbox.hasPending=true;assert.notEqual((await adapter.inspect(task,run)).occupancyConfirmedStopped,true);agent.inbox.hasPending=false;
 events.push({type:'approval/asked',data:{id:'approval'}});assert.notEqual((await adapter.inspect(task,run)).occupancyConfirmedStopped,true);events.pop();
 assert.notEqual((await adapter.inspect(task,{...run,status:'unknown'})).occupancyConfirmedStopped,true);
  events.push({seq:1,type:'turn/start',data:{turn:1}},{seq:2,type:'user/message',data:{message:{source:{kind:'plugin',plugin:'dsh-tasks/r'}}}},{seq:3,type:'tool/result',data:{error:{code:'TOOL_OUTCOME_UNKNOWN'}}});assert.notEqual((await adapter.inspect(task,run)).occupancyConfirmedStopped,true);events.length=0;
 attached=false;assert.notEqual((await adapter.inspect(task,run)).occupancyConfirmedStopped,true);
});
for(const continuous of [true,false])test('unrelated later unknown result cannot pin an old run '+continuous,async()=>{
 const events=[{seq:1,type:'turn/start',data:{turn:1}},{seq:2,type:'user/message',data:{message:{source:{kind:'plugin',plugin:'dsh-tasks/r'}}}},{seq:3,type:'turn/end',data:{turn:1,reason:{kind:'completed'}}},{seq:4,type:'turn/start',data:{turn:2}},{seq:5,type:'user/message',data:{message:{source:{kind:'user'}}}},{seq:6,type:'tool/result',data:{error:{code:'TOOL_OUTCOME_UNKNOWN'}}},{seq:7,type:'turn/end',data:{turn:2,reason:{kind:'completed'}}}];
 const agent={id:'s',status:'idle',inbox:{hasPending:false},session:{header:{},events}};
 const adapter=createNativeAdapter({agents:{get:()=>agent},goals:{get:()=>null}},{}),task={continuous,archived:true,context:{workspacePath:os.tmpdir()}},run={id:'r',sourceTag:'dsh-tasks/r',sessionId:'s',stage:'accepted',status:'interrupted'};
 assert.equal((await adapter.inspect(task,run)).occupancyConfirmedStopped,true);
 events.splice(2,0,{seq:2.5,type:'tool/result',data:{error:{code:'TOOL_OUTCOME_UNKNOWN'}}});assert.equal((await adapter.inspect(task,run)).occupancyConfirmedStopped,false);
});
test('stopped proof is rechecked and never resumes a manual pause',async t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'task-proof-'));let proof=true,dispatch=0,now=0;
 const paused={id:'paused',enabled:false,manualPause:true,archived:false,status:'paused',lastRun:{id:'old',sessionId:'source',stage:'accepted',status:'paused',running:true}};
 fs.writeFileSync(path.join(dir,'tasks.json'),JSON.stringify({version:1,requests:[],tasks:[paused]}));
 const adapter={validate:async()=>({}),inspect:async()=>({running:!proof,occupancyConfirmedStopped:proof}),canStart:async()=>true,prepare:async()=>{},dispatch:async()=>{dispatch++;return{running:false}},disarm:async()=>{throw Error('must not disarm manually paused run')}};
 const service=createTaskService({dir,maxActive:1,adapter,now:()=>now});t.after(async()=>{await service.close();fs.rmSync(dir,{recursive:true,force:true})});
 const row=await service.mutate({action:'create',task:{title:'due',objective:'fixture',workspaceId:'w',schedule:{kind:'interval',seconds:300}}});await service.list();proof=false;now=301000;await service.tick();await service.drain();assert.equal(dispatch,0);
 const [saved]=await service.list('paused');assert.equal(saved.manualPause,true);assert.equal(saved.enabled,false);assert.equal(saved.status,'paused');
});
