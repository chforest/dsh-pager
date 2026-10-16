import {test} from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import {createTaskService} from './service.mjs'
const NOW=Date.parse('2026-10-14T12:00:00Z')
const context={bootId:'new',previousBootId:'old',eligible:true,reason:'crash'}
function fixture(t,{task={},run={},adapter={}}={}){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'task-restart-')),file=path.join(dir,'tasks.json'),calls=[]
 const row={id:crypto.randomUUID(),revision:1,title:'fixture',enabled:true,archived:false,status:'running',schedule:{kind:'manual'},continuous:true,...task,lastRun:{id:crypto.randomUUID(),sessionId:'existing-session',status:'running',stage:'accepted',running:true,...run}}
 fs.writeFileSync(file,JSON.stringify({version:1,runtimeBootId:'old',tasks:[row],requests:[]}))
 const read=()=>JSON.parse(fs.readFileSync(file)).tasks[0]
 const service=createTaskService({dir,now:()=>NOW,adapter:{inspect:async()=>({status:'running',running:true}),inspectRestart:async()=>{calls.push('inspect');return {status:'interrupted',resumable:true}},resumeRestart:async(task,run)=>{calls.push('resume');assert.equal(read().lastRun.restartRecovery.status,'dispatching');assert.equal(run.sessionId,'existing-session');return {status:'running',running:true}},prepare:async()=>assert.fail('must not prepare'),dispatch:async()=>assert.fail('must not dispatch'),...adapter}})
 t.after(async()=>{await service.close();fs.rmSync(dir,{recursive:true,force:true})})
 return {service,calls,read,row,dir}
}
test('accepted crash resumes same run once with write-ahead attempt; concurrent and HMR calls do not replay',async t=>{
 const f=fixture(t);await Promise.all([f.service.recoverRestart(context),f.service.recoverRestart(context)])
 assert.deepEqual(f.calls,['inspect','resume']);assert.equal(f.read().lastRun.id,f.row.lastRun.id)
 assert.equal((await f.service.recoverRestart(context)).reason,'same-boot');assert.equal(f.calls.length,2)
 await f.service.close();const reopened=createTaskService({dir:f.dir,adapter:{resumeRestart:()=>assert.fail('HMR replay')}})
 assert.equal((await reopened.recoverRestart(context)).reason,'same-boot');await reopened.close()
})
for(const [label,override] of [['clean',{reason:'clean'}],['ineligible',{eligible:false}],['wrong prior',{previousBootId:'else'}],['expired update',{reason:'update-intent',intentExpiresAt:NOW-1}]])test(label+' does not resume',async t=>{const f=fixture(t);await f.service.recoverRestart({...context,...override});assert.deepEqual(f.calls,[])})
test('valid update intent permits inspected recovery',async t=>{const f=fixture(t);await f.service.recoverRestart({...context,reason:'update-intent',intentExpiresAt:NOW+60000});assert.deepEqual(f.calls,['inspect','resume'])})
for(const [label,opts] of [['manual pause',{task:{manualPause:true,enabled:false,status:'paused'}}],['archived',{task:{archived:true}}],['unknown dispatch',{run:{stage:'dispatching',status:'unknown'}}],['prior uncertain recovery',{run:{restartRecovery:{status:'unknown'}}}]])test(label+' never resumes',async t=>{const f=fixture(t,opts);await f.service.recoverRestart(context);assert.deepEqual(f.calls,[])})
test('actual completed result is adopted without followup',async t=>{const f=fixture(t,{adapter:{inspectRestart:async()=>({status:'complete',running:false,summary:'verified'})}});const r=await f.service.recoverRestart(context);assert.equal(r.completed,1);assert.equal(f.read().lastRun.status,'complete');assert.deepEqual(f.calls,[])})
test('pending user approval is retained without followup',async t=>{const f=fixture(t,{adapter:{inspectRestart:async()=>({status:'waiting-user',running:false})}});await f.service.recoverRestart(context);assert.equal(f.read().status,'waiting-user');assert.deepEqual(f.calls,[])})
test('unknown recovery is durable and never reissued on next crash',async t=>{const f=fixture(t,{adapter:{resumeRestart:async()=>{throw Error('lost receipt')}}});assert.equal((await f.service.recoverRestart(context)).unknown,1);assert.equal(f.read().lastRun.restartRecovery.status,'unknown');await f.service.close();const reopened=createTaskService({dir:f.dir,adapter:{inspectRestart:()=>assert.fail('unknown replay')}});await reopened.recoverRestart({...context,bootId:'third',previousBootId:'new'});await reopened.close()})
test('missing inspection capability leaves interrupted task for explicit review',async t=>{const f=fixture(t,{adapter:{inspectRestart:undefined}});assert.equal((await f.service.recoverRestart(context)).waiting,1);assert.equal(f.read().enabled,false);assert.deepEqual(f.calls,[])})
test('pause during slow inspection wins and prevents followup',async t=>{
 let resolve,entered;const started=new Promise(r=>entered=r),pending=new Promise(r=>resolve=r)
 const f=fixture(t,{adapter:{inspectRestart:async()=>{entered();return pending},pause:async()=>{}}})
 const recovery=f.service.recoverRestart(context);await started
 await f.service.mutate({action:'pause',id:f.row.id});resolve({status:'interrupted',resumable:true});await recovery
 assert.equal(f.read().manualPause,true);assert.equal(f.read().enabled,false);assert.deepEqual(f.calls,[])
})
test('unsupported or paused goal inspection cannot authorize automatic continuation',async t=>{
 const f=fixture(t,{adapter:{inspectRestart:async()=>({status:'paused',resumable:false,goal:{phase:'paused',maxGoalRounds:8}})}})
 await f.service.recoverRestart(context);assert.equal(f.read().enabled,false);assert.equal(f.read().lastRun.goal.maxGoalRounds,8);assert.deepEqual(f.calls,[])
})
