import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import {createRequire} from 'node:module'
import {fileURLToPath,pathToFileURL} from 'node:url'
import {createRecovery} from './recovery.mjs?focused-v3'
import {recoveryPaths} from './user-data.mjs'
export const name='recovery'
export const inject=['agents','sessions','goals','webServer','tools']
export function registerRestartTool(ctx,defineTool,recovery){
  return ctx.tools.register(defineTool({name:'dsh_prepare_restart',description:'仅在用户已批准更新/重启时调用：保存10分钟内的一次重启恢复意图，不执行更新。手动停止/暂停不会恢复，未知工具结果先核对，不直接重放。',parameters:{},output:{schema:{type:'object',additionalProperties:true},render:(_args,value)=>[{type:'text',text:JSON.stringify(value)}]},isConcurrencySafe:()=>false,async execute(){return recovery.prepareRestart()}}))
}
export async function apply(ctx,config={}){
  const fromHost=createRequire(path.resolve(process.argv[1]))
  const {createUserMessage}=await import(pathToFileURL(fromHost.resolve('@deepseek-ai/dsh-llm')).href)
  const {defineTool}=await import(pathToFileURL(fromHost.resolve('@deepseek-ai/dsh-tools')).href)
  const key=Symbol.for('dsh.recovery.boot'), startup=Symbol.for('dsh.recovery.startup')
  const bootId=globalThis[key] ||= crypto.randomUUID()
  const {tasksFile,stateFile}=recoveryPaths(config)
  const adapter={
    async isTaskSession(id,row){if(!fs.existsSync(tasksFile))return false;const data=JSON.parse(fs.readFileSync(tasksFile,'utf8'));return data.tasks.some(t=>t.lastRun?.sessionId===id&&((row.sourceTag&&row.sourceTag===t.lastRun.sourceTag)||(row.goalId&&row.goalId===t.lastRun.goal?.id)))},
    onError:message=>ctx.logger.warn(message),
    async load(id){if(!ctx.agents.get(id)){const r=await fetch(`http://127.0.0.1:${ctx.webServer.port}/api/session.models`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({type:'client-request',rpcId:crypto.randomUUID(),method:'session.models',payload:{sessionId:id}}),signal:AbortSignal.timeout(30000)});const data=await r.json();if(!r.ok||!data.result?.ok)throw Error('session load unavailable')}const a=ctx.agents.get(id);if(!a)throw Error('session missing');return a},
    goal:agent=>ctx.goals.get(agent),
    async send(agent,text,plugin){agent.followup(createUserMessage({content:[{type:'text',text}],source:{kind:'plugin',plugin}}));if(!await ctx.sessions.flush(agent.session))throw Error('recovery outcome unconfirmed')}
  }
  const recovery=createRecovery({file:stateFile,bootId,adapter,sharedContext:globalThis[startup]})
  globalThis[startup] ||= recovery.context
  ctx.on('session/event',(session,event)=>recovery.observe(session,event))
  for(const agent of ctx.agents.roots())recovery.trackCurrent(agent)
  ctx.effect(()=>registerRestartTool(ctx,defineTool,recovery),'recovery preparation tool')
  ctx.effect(()=>ctx.tools.register(defineTool({name:'dsh_recovery_status',description:'只读查看更新/重启恢复状态及断点，不执行重启、不续发任务。',parameters:{},output:{schema:{type:'object',additionalProperties:true},render:(_args,value)=>[{type:'text',text:JSON.stringify(value)}]},isConcurrencySafe:()=>true,execute:async()=>recovery.status()})),'recovery status tool')
  const timer=setInterval(()=>void recovery.recover(),5000);timer.unref?.()
  ctx.effect(()=>()=>{clearInterval(timer);recovery.close()},'recovery journal close')
  // No restore during apply: startup dependencies finish before first pass.
}
