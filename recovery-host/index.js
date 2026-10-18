import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import {createRequire} from 'node:module'
import {fileURLToPath,pathToFileURL} from 'node:url'
import {createRecovery} from './recovery.mjs?focused-v3'
import {recoveryPaths} from './user-data.mjs'
import {createHostRpc,nativeHostDependencies} from '../plugin/host-compat.mjs'
export const name='recovery'
export const inject = [...new Set(['agents','sessions','goals','webServer','tools',...nativeHostDependencies()])]
export function registerRestartTool(ctx,defineTool,recovery){
  return ctx.tools.register(defineTool({name:'dsh_prepare_restart',description:'仅在用户已批准更新/重启时调用：保存10分钟内的一次重启恢复意图，不执行更新。手动停止/暂停不会恢复，未知工具结果先核对，不直接重放。',parameters:{},output:{schema:{type:'object',additionalProperties:true},render:(_args,value)=>[{type:'text',text:JSON.stringify(value)}]},isConcurrencySafe:()=>false,async execute(){return recovery.prepareRestart()}}))
}
export async function apply(ctx,config={}){
  const fromHost={resolve:spec=>{for(const c of [process.argv[1]&&!process.argv[1].startsWith('-')?path.resolve(process.argv[1]):null,import.meta.url,'/Applications/DeepSeek Harness.app/Contents/Resources/app.asar/package.json'].filter(Boolean)){try{return createRequire(c).resolve(spec)}catch{}}return createRequire(import.meta.url).resolve(spec)}}
  const {createUserMessage}=await import(pathToFileURL(fromHost.resolve('@deepseek-ai/dsh-llm')).href)
  const {defineTool}=await import(pathToFileURL(fromHost.resolve('@deepseek-ai/dsh-tools')).href)
  const sessionModule=await import(pathToFileURL(fromHost.resolve('@deepseek-ai/dsh-session')).href)
  const modern=sessionModule.SESSION_FORMAT_VERSION>=4, rpc=createHostRpc(ctx)
  const key=Symbol.for('dsh.recovery.boot'), startup=Symbol.for('dsh.recovery.startup')
  const bootId=globalThis[key] ||= crypto.randomUUID()
  const {tasksFile,stateFile}=recoveryPaths(config)
  const adapter={
    async isTaskSession(id,row){if(!fs.existsSync(tasksFile))return false;const data=JSON.parse(fs.readFileSync(tasksFile,'utf8'));return data.tasks.some(t=>t.lastRun?.sessionId===id&&((row.sourceTag&&row.sourceTag===t.lastRun.sourceTag)||(row.goalId&&row.goalId===t.lastRun.goal?.id)))},
    onError:message=>ctx.logger.warn(message),
    async load(id){if(!ctx.agents.get(id))await rpc('session.models',{sessionId:id},30000);const a=ctx.agents.get(id);if(!a)throw Error('session missing');return a},
    goal:agent=>ctx.goals.get(agent),
    async send(agent,text,plugin){agent.followup(createUserMessage({content:[{type:'text',text}],source:modern?{kind:'plugin:'+plugin}:{kind:'plugin',plugin}}));if(!await ctx.sessions.flush(agent.session))throw Error('recovery outcome unconfirmed')}
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
