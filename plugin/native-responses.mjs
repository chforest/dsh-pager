import crypto from 'node:crypto'
import {createHostFetch,hostOrigin} from './host-http.mjs'
const bad=(message,status=409)=>Object.assign(Error(message),{status})
export function createNativeResponses(ctx,{fetcher=createHostFetch(ctx)}={}){
 const listeners=new Set(),pending=new Map();let controller,clientId,generation=0
 function emit(frame){for(const listener of listeners)listener.onMux?.(frame)}
 function withdrawn(row){emit({payload:row.kind==='approval'?{type:'approval/resolved',sessionId:row.sessionId,approvalId:row.eventId}:{type:'question/resolved',sessionId:row.sessionId,questionRpcId:row.rpc}})}
 async function send(eventId,outcome){
  if(!clientId)throw bad('提问连接已断开，请刷新后核对')
  const response=await fetcher(`${hostOrigin(ctx)}/api/$events/result`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({type:'client-request',rpcId:crypto.randomUUID(),method:'$events/result',payload:{args:{clientId,eventId,outcome}}}),signal:AbortSignal.timeout(30000)})
 const result=await response.json();if(!response.ok||!result.result?.ok)throw bad('回答结果未确认，请刷新核对，不要重复提交')
 }
 async function start(){
  if(controller)return
  const current=++generation;controller=new AbortController();const signal=controller.signal
  try{
   const stream=await ctx.typertGateway.wireStream.open('$events',{args:{}},(async function*(){})(),ctx.connection.browserPeer,signal)
   for await(const frame of stream){
    if(signal.aborted||generation!==current)break
    if(frame.type==='ready'){clientId=frame.clientId;continue}
    if(frame.type==='cancel'){const row=pending.get(frame.eventId);if(row){pending.delete(frame.eventId);withdrawn(row)}continue}
    if(frame.type!=='waterfall')continue
    const kind=frame.event==='approval/request'?'approval':frame.event==='user-questions/request'?'question':null
    if(!kind){await send(frame.eventId,{kind:'next'});continue}
    const row={kind,eventId:frame.eventId,sessionId:frame.agentId,rpc:'native:'+frame.eventId,request:frame.request,state:'pending'}
    row.envelope={rpcId:row.rpc,payload:kind==='approval'?{type:'approval/requested',sessionId:row.sessionId,approvalId:row.eventId,toolName:frame.request.toolName,callId:frame.request.callId,reason:frame.request.reason}:{type:'question/requested',sessionId:row.sessionId,questions:frame.request.questions}}
    pending.set(row.eventId,row);emit(row.envelope)
   }
  }catch(error){if(!signal.aborted)for(const listener of listeners)listener.onError?.(error)}
  finally{if(generation===current){for(const row of pending.values())withdrawn(row);pending.clear();clientId=undefined;controller=undefined}}
 }
 return {
  subscribe(listener){listeners.add(listener);for(const row of pending.values())listener.onMux?.(row.envelope);void start();return()=>{listeners.delete(listener);if(!listeners.size)controller?.abort()}},
  async respond(body){
   const id=typeof body?.rpcId==='string'&&body.rpcId.startsWith('native:')?body.rpcId.slice(7):null,row=pending.get(id)
   if(!row||row.state!=='pending')throw bad('问题已失效或已提交，请核对当前状态')
   const value=body.result?.value
   if(body.result?.ok!==true||value?.sessionId!==row.sessionId)throw bad('回答不属于此对话',403)
   let result
   if(row.kind==='approval'){
    if(value.approvalId!==row.eventId||!['allowed-once','rejected'].includes(value.outcome)||value.remember)throw bad('仅支持对此次操作允许或拒绝',400)
    result=value.outcome
   }else{
    const answers=value.answer?.answers,questions=row.request.questions||[]
    if(!Array.isArray(answers)||answers.length!==questions.length||new Set(answers.map(a=>a.id)).size!==answers.length||answers.some(a=>!questions.some(q=>q.id===a.id)||!Array.isArray(a.selected)||a.selected.some(x=>typeof x!=='string')||a.custom!==undefined&&typeof a.custom!=='string'))throw bad('回答格式无效',400)
    result={answers}
   }
   row.state='submitted' // Write outcome can be unknown: do not automatically resend.
   await send(row.eventId,{kind:'result',value:result})
   pending.delete(row.eventId);withdrawn(row)
   return{accepted:true}
  },
  close(){listeners.clear();controller?.abort()}
 }
}
