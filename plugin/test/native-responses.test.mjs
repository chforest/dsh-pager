import test from 'node:test'
import assert from 'node:assert/strict'
import {createNativeResponses} from '../native-responses.mjs'
const turn=()=>new Promise(r=>setImmediate(r))
function fixture(fetcher=async()=>new Response(JSON.stringify({result:{ok:true}}))){
 let resolve,ended=false;const queue=[{type:'ready',clientId:'client-fixture'}]
 const ctx={webServer:{port:1234},connection:{browserPeer:{principal:{kind:'owner'}}},typertGateway:{wireStream:{open:async(_e,_p,_u,_peer,signal)=>{
  signal.addEventListener('abort',()=>{ended=true;resolve?.()},{once:true})
  return(async function*(){while(!ended){if(queue.length)yield queue.shift();else await new Promise(r=>resolve=r)}})()
 }}}}
 const bridge=createNativeResponses(ctx,{fetcher}),frames=[];bridge.subscribe({onMux:f=>frames.push(f)})
 return{bridge,frames,push:f=>{queue.push(f);resolve?.()}}
}
test('native approval binds session and pending identity; only explicit one-shot decisions',async t=>{
 const calls=[],f=fixture(async(_url,options)=>{calls.push(JSON.parse(options.body));return new Response(JSON.stringify({result:{ok:true}}))});t.after(()=>f.bridge.close())
 f.push({type:'waterfall',event:'approval/request',eventId:'event-fixture',agentId:'session-fixture',request:{toolName:'fixture'}});await turn()
 const body={rpcId:'native:event-fixture',result:{ok:true,value:{sessionId:'other',approvalId:'event-fixture',outcome:'allowed-once'}}}
 await assert.rejects(f.bridge.respond(body),{status:403});assert.equal(calls.length,0)
 body.result.value.sessionId='session-fixture';body.result.value.remember=true
 await assert.rejects(f.bridge.respond(body),{status:400});delete body.result.value.remember
 assert.deepEqual(await f.bridge.respond(body),{accepted:true});assert.equal(calls.length,1)
 assert.equal(calls[0].payload.args.outcome.value,'allowed-once')
 await assert.rejects(f.bridge.respond(body),{status:409});assert.equal(calls.length,1)
})
test('unknown result is not retried and withdrawn questions cannot be answered',async t=>{
 const f=fixture(async()=>{throw Error('unknown')});t.after(()=>f.bridge.close())
 f.push({type:'waterfall',event:'approval/request',eventId:'a',agentId:'s',request:{}});await turn()
 const body={rpcId:'native:a',result:{ok:true,value:{sessionId:'s',approvalId:'a',outcome:'rejected'}}}
 await assert.rejects(f.bridge.respond(body),/unknown/);await assert.rejects(f.bridge.respond(body),{status:409})
 f.push({type:'waterfall',event:'user-questions/request',eventId:'q',agentId:'s',request:{questions:[{id:'q1',question:'fixture'}]}});f.push({type:'cancel',eventId:'q'});await turn()
 await assert.rejects(f.bridge.respond({rpcId:'native:q',result:{ok:true,value:{sessionId:'s',answer:{answers:[{id:'q1',selected:['yes']}]}}}}),{status:409})
})
