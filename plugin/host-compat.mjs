import path from 'node:path'
import {createRequire} from 'node:module'
import crypto from 'node:crypto'
const error=(message,code='host-compat',status=502)=>Object.assign(new Error(message),{code,status})
export function serviceOf(ctx,name){try{return ctx[name]||ctx.get?.(name)}catch{return undefined}}
export function hasNativeController(ctx){return typeof serviceOf(ctx,'sessionController')?.list==='function'}
export function createOwnerAuthorizer(ctx){
 const connection=serviceOf(ctx,'connection')
 if(typeof connection?.authenticatedUrl!=='function')return hasNativeController(ctx)?()=>({ok:false,status:503}):undefined
 return req=>{
  const status=connection.requestRejection(req);if(status)return{ok:false,status}
  const admission=connection.admit(req)
  if(admission.rejection)return{ok:false,status:admission.rejection}
  return admission.peer?.principal?.kind==='owner'?{ok:true}:{ok:false,status:403}
 }
}
async function opening(factory,signal){
 const controller=new AbortController(),combined=signal?AbortSignal.any([signal,controller.signal]):controller.signal
 const iterator=factory(combined)[Symbol.asyncIterator]()
 try{const result=await iterator.next();if(result.done)throw error('宿主未返回初始快照');return result.value}
 finally{controller.abort();await iterator.return?.()}
}
// Server-only compatibility closure. Never expose directly without an owner gate.
export function createHostRpc(ctx,{fetcher=fetch,assistantStreamChunks}={}){
 return async function hostRpc(method,payload={},timeoutMs=30000,rpcId=crypto.randomUUID()){
  const signal=typeof timeoutMs==='object'?timeoutMs.signal||AbortSignal.timeout(timeoutMs.timeoutMs||30000):AbortSignal.timeout(timeoutMs)
  const session=serviceOf(ctx,'sessionController'),workspace=serviceOf(ctx,'workspaceController')
  if(!hasNativeController(ctx)){
   const port=serviceOf(ctx,'webServer')?.port
   const response=await fetcher(`http://127.0.0.1:${port}/api/${method}`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({type:'client-request',rpcId,method,payload}),signal})
   if(!response.ok)throw error(`DSH ${method} HTTP ${response.status}`)
   const out=(await response.json()).result;if(!out?.ok)throw error(out?.error?.message||`${method} failed`,out?.error?.code)
   return out.value
  }
  if(method==='workspace.list')return (await opening(s=>workspace.follow(s),signal)).value
  if(method==='session.history'){
   const address={kind:'session',sessionId:payload.sessionId}
   const first=await opening(s=>session.follow({address,maxMessages:payload.maxMessages||30},s),signal)
   if(first.type!=='snapshot')throw error('会话快照类型不匹配')
   const page=payload.beforeSeq==null?first:await session.page({address,throughSeq:first.cursor,beforeSeq:payload.beforeSeq,maxMessages:payload.maxMessages||30},signal)
   return{events:(page.records||[]).map(r=>({event:normalizeHostEvent(r.event,assistantStreamChunks)})),hasMore:page.hasMore,projections:first.projections,header:first.header}
  }
  if(method==='session.models'){
   const result=await session.resolveAgent(payload.sessionId);if(result.error)throw error(result.error.message||'会话不可用',result.error.code,409)
   const [catalog,projection]=await Promise.all([session.modelCatalog(),session.projections({sessionId:payload.sessionId},signal)])
   return{...catalog,current:projection?.values?.modelSelection?.next||projection?.values?.modelSelection?.lastUsed||catalog.default}
  }
  if(method==='permissions/catalog')return serviceOf(ctx,'permissionPresets').catalog()
  if(method==='commands/list'){
   const result=await session.resolveAgent(payload.args?.agentId);if(result.error)throw error(result.error.message||'会话不可用',result.error.code,409)
   return serviceOf(ctx,'commands').list(result.agent)
  }
  if(method==='commands/execute'){
   const args=payload.args||{},result=await session.resolveAgent(args.agentId);if(result.error)throw error(result.error.message||'会话不可用',result.error.code,409)
   if(args.images?.length)throw error('旧命令图片接口不兼容', 'unsupported',400)
   const execution=await serviceOf(ctx,'commands').execute(result.agent,args.line,[],signal)
   if(!execution)throw error('命令不存在','command-not-found',404)
   return execution
  }
  const [domain,operation]=method.split('.')
  const allowed={session:['list','search','create','rename','selectModel','prompt','cancel','attachment','updateQueue','projections'],workspace:['create','rename','archiveSession','unarchiveSession','pinSession','unpinSession']}
  if(!allowed[domain]?.includes(operation))throw error(`新版宿主不支持兼容调用 ${method}`,'unsupported',501)
  const controller=domain==='session'?session:workspace
  if(typeof controller?.[operation]!=='function')throw error('宿主服务不可用','unavailable',503)
  const request=method==='session.prompt'?{...payload,requestId:payload.requestId||rpcId}:payload
  return controller[operation](request,signal)
 }
}
export function createHostEvents(ctx,{assistantStreamChunks}={}){
 if(!hasNativeController(ctx))return undefined
 return ({onMux,onHost,onError=()=>{}})=>{
  const controller=new AbortController(),disposers=[]
  const on=(event,callback)=>disposers.push(ctx.on(event,callback))
  const projection=frame=>{if(frame.key==='permissions'&&frame.value)frame={...frame,value:{...serviceOf(ctx,'permissionPresets').catalog(),...frame.value}};onMux({payload:{...frame,type:'session/projection'}});if(frame.key==='inbox')onMux({payload:{type:'session/queue',sessionId:frame.sessionId,items:legacyQueue(frame.value)}})}
  on('session/event',(session,event)=>onMux({payload:{type:'session/event',sessionId:session.id,event:normalizeHostEvent(event,assistantStreamChunks)}}))
  on('agent/assistant-stream',({agent,frame})=>{if(frame.type==='chunk')onMux({payload:{type:'session/event',sessionId:agent.session.id,event:{type:'assistant/chunk',seq:agent.session.seq-1+(frame.index+1)/(frame.index+2),time:frame.time,data:{chunk:frame.chunk}}}})})
  on('api-session/status',(sessionId,running)=>onHost({payload:{type:'host/session-status',sessionId,running}}))
  on('api-session/added',summary=>onHost({payload:{type:'host/session-added',...summary}}))
  on('api-session/removed',sessionId=>onHost({payload:{type:'host/session-removed',sessionId}}))
  on('api-session/error',(sessionId,message)=>onHost({payload:{type:'host/agent-error',sessionId,message}}))
  void(async()=>{try{for await(const frame of serviceOf(ctx,'sessionController').control(controller.signal)){
   if(frame.type==='projection')projection(frame)
   else if(frame.type==='baseline')for(const[sessionId,p]of Object.entries(frame.value.projections))for(const[key,value]of Object.entries(p.values||{}))projection({sessionId,key,value})
  }}catch(e){if(!controller.signal.aborted)onError(e)}})()
  void(async()=>{try{for await(const frame of serviceOf(ctx,'workspaceController').follow(controller.signal)){if(frame.type!=='baseline')onHost({payload:{type:'host/workspace-changed'}})}}catch(e){if(!controller.signal.aborted)onError(e)}})()
  return()=>{controller.abort();for(const dispose of disposers)dispose?.()}
 }
}

export function normalizeHostEvent(event,assistantStreamChunks){
 if(!event)return event
 const data=event.data||{},message=data.message
 if(event.type==='assistant/message'&&!message?.content&&Array.isArray(data.stream)){
  const chunks=assistantStreamChunks?Array.from(assistantStreamChunks(data.stream,'block-end')):data.stream.filter(r=>r.type==='chunk').map(r=>r.chunk).filter(c=>c.type==='block-end')
  return{...event,data:{...data,message:{...message,role:'assistant',content:chunks.map(c=>c.block).filter(Boolean)}}}
 }
 if(event.type==='tool/result'&&message?.role==='tool')return{...event,data:{...data,message:{...message,content:[{type:'tool-result',id:message.toolCallId,toolCallId:message.toolCallId,isError:!!message.isError,content:message.content||[]}]}}}
 return event
}

export function legacyQueue(value){return [...(value?.['next-turn']||[]).map(message=>({id:message.id,placement:'queued',message})),...(value?.['next-step']||[]).map(message=>({id:message.id,placement:'steering',message}))]}

export function nativeHostDependencies(entry=process.argv[1]){
 try{createRequire(path.resolve(entry)).resolve('@deepseek-ai/dsh-api-session-controller');return ['sessionController','workspaceController','connection','commands','typertGateway','permissionPresets']}catch{return []}
}
