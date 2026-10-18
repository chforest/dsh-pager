import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
const pluginTag = source => source?.kind==='plugin'?source.plugin:typeof source?.kind==='string'&&source.kind.startsWith('plugin:')?source.kind.slice(7):null
const eventsOf = session => typeof session?.snapshotEvents==='function'?session.snapshotEvents():session?.events||[]
const message = e => e?.data?.message || e?.data
const sourceTag = row => 'dsh-recovery/' + row.id
const isTask = (session,turn) => {
  const start=eventsOf(session).findLastIndex(e=>e.type==='turn/start'&&e.data?.turn===turn)
  if(start<0)return false
  for(let i=start+1;i<eventsOf(session).length;i++){
    const e=eventsOf(session)[i];if(e.type==='turn/start')break
    if(e.type==='user/message'&&pluginTag(message(e)?.source)?.startsWith('dsh-tasks/'))return true
  }
  return false
}
export const recoveryPrompt = '服务在上一轮尚未结束时中断，现在只在本聊天核对断点。先用当前聊天已有信息识别原目标和最后一步，区分已完成、未开始和结果未知。仅在确实需要时检查该步明确涉及的文件或独立回执，不扫描无关目录、环境变量或宿主会话日志。纯等待/睡眠和无产物的只读操作可根据原调用语义判断，不必重复等待或寻找不存在的产物。结果未知的工具调用绝不能直接重放，先核产物；发送、发布、付款等沿用原授权范围并核对独立回执，授权或结果不清楚就等待用户。不要扩展任务，不改变模型或权限，不把此提示当新授权。核实后继续尚未完成且已获授权的工作；若原工作已完成只汇报核对结果。'

export function createRecovery({file,bootId,adapter,now=Date.now,sharedContext}) {
  fs.mkdirSync(path.dirname(file),{recursive:true})
  let state={version:1,bootId:null,cleanShutdown:true,intent:null,rows:{}}
  if(fs.existsSync(file)) {
    if(fs.lstatSync(file).isSymbolicLink()||fs.statSync(file).size>4*1024*1024)throw Error('recovery journal rejected')
    state=JSON.parse(fs.readFileSync(file,'utf8'))
    if(state.version!==1||!state.rows||typeof state.rows!=='object'||Array.isArray(state.rows))throw Error('recovery journal invalid')
  }
  const previousBootId=state.bootId, sameBoot=previousBootId===bootId
  const update=!!state.intent&&state.intent.bootId===previousBootId&&state.intent.expiresAt>now()
  const context=sharedContext||Object.freeze({bootId,previousBootId,eligible:!!previousBootId&&!sameBoot&&(!state.cleanShutdown||update),reason:sameBoot?'same-boot':update?'update-intent':previousBootId&&!state.cleanShutdown?'crash':'clean',createdAt:now()})
  const candidates=!sameBoot&&context.eligible?Object.values(state.rows).filter(r=>r.bootId===previousBootId&&['active','disposed'].includes(r.status)):[]
  state.bootId=bootId;state.cleanShutdown=false
  if(!sameBoot)state.intent=null
  let closed=false,working=false,failed=false
  function save(){const temp=file+'.'+crypto.randomUUID()+'.tmp';try{const fd=fs.openSync(temp,'wx');try{fs.writeFileSync(fd,JSON.stringify(state));fs.fsyncSync(fd)}finally{fs.closeSync(fd)}fs.renameSync(temp,file)}finally{if(fs.existsSync(temp))fs.unlinkSync(temp)}}
  save()
  function observe(session,event){
    if(closed||failed||session.header?.origin==='subagent'||!['turn/start','user/message','turn/end','goal/change'].includes(event.type))return
    let row=state.rows[session.id]
    if(event.type==='turn/start'){
      const recovering=row&&['dispatching','dispatched','unknown','recovery-running'].includes(row.status)
      row=state.rows[session.id]={id:crypto.randomUUID(),sessionId:session.id,bootId,turn:event.data.turn,startSeq:event.seq,lastUserSeq:-1,status:recovering?'recovery-running':'active'}
    }
    if(!row)return
    if(event.type==='user/message'){
      const source=message(event)?.source
      row.sourceTag=pluginTag(source)
      row.goalId=source?.kind==='goal'?source.goalId:null
      if(pluginTag(source)?.startsWith('dsh-recovery/'))row.status='recovery-running'
      else {row.lastUserSeq=event.seq;if(row.status==='recovery-running')row.status='active'}
      if(pluginTag(source)?.startsWith('dsh-tasks/'))row.status='task-owned'
    }
    if(event.type==='goal/change'&&['pause','clear'].includes(event.data?.operation))row.status='stopped'
    if(event.type==='turn/end'&&event.data.turn===row.turn){
      const reason=event.data.reason
      if(reason?.kind==='aborted'&&reason.reason?.kind==='disposed'&&row.status==='active')row.status='disposed'
      else if(reason?.kind==='aborted'&&reason.reason?.kind==='user')row.status='stopped'
      else if(reason?.kind!=='interrupted'&&row.status!=='disposed')row.status='complete'
    }
    if(Object.keys(state.rows).length>2000)throw Error('recovery journal capacity reached')
    save()
  }
  async function attempt(row){
    const current=state.rows[row.sessionId]
    if(current!==row||!['active','disposed'].includes(row.status))return
    if(await adapter.isTaskSession(row.sessionId,row)){row.status='task-owned';row.note='由自动任务调度器恢复';save();return}
    const agent=await adapter.load(row.sessionId)
    // Loading yields to user input/cancellation. Do not act on a replaced or
    // stopped checkpoint after the awaited native resume.
    if(state.rows[row.sessionId]!==row||!['active','disposed'].includes(row.status))return
    const session=agent.session,events=eventsOf(session)||[]
    const stop=status=>{row.status=status;save()}
    if(isTask(session,row.turn))return stop('task-owned')
    if(agent.status!=='idle'||agent.inbox?.hasPending)return
    const goal=adapter.goal?.(agent)
    if(goal&&goal.phase!=='complete')return stop('goal-owned-or-paused')
    if(events.some(e=>e.type==='user/message'&&pluginTag(message(e)?.source)===sourceTag(row)))return stop('dispatched')
    if(events.some(e=>e.seq>row.lastUserSeq&&e.type==='user/message'))return stop('new-user-input')
    if(events.some(e=>e.seq>row.startSeq&&e.type==='goal/change'&&['pause','clear'].includes(e.data?.operation)))return stop('stopped')
    const end=events.find(e=>e.type==='turn/end'&&e.data?.turn===row.turn&&e.seq>row.startSeq)
    if(end&&!(end.data.reason?.kind==='interrupted'||end.data.reason?.kind==='aborted'&&end.data.reason.reason?.kind==='disposed'))return stop('not-interrupted')
    if(!events.some(e=>e.type==='turn/start'&&e.seq===row.startSeq&&e.data?.turn===row.turn))return stop('anchor-missing')
    const approvals=new Set()
    for(const e of events){if(e.type==='approval/asked')approvals.add(e.data.id);if(e.type==='approval/decided')approvals.delete(e.data.id)}
    if(approvals.size)return stop('waiting-approval')
    // Persist unknown-outcome barrier BEFORE the single followup. Never replay
    // dispatching/unknown records after a crash between send and acknowledgement.
    row.status='dispatching';row.recoverySource=sourceTag(row);save()
    try{await adapter.send(agent,recoveryPrompt,row.recoverySource);if(state.rows[row.sessionId]===row)row.status='dispatched';save()}
    catch{if(state.rows[row.sessionId]===row)row.status='unknown';save()}
  }
  const safeObserve=(session,event)=>{try{observe(session,event)}catch{failed=true;try{adapter.onError?.('recovery checkpoint failed; automatic recovery disabled')}catch{}}}
  return {context,observe:safeObserve,
    trackCurrent(agent){if(agent.status!=='running'||state.rows[agent.session.id])return;const events=eventsOf(agent.session)||[];const start=events.findLastIndex(e=>e.type==='turn/start');if(start>=0)for(const event of events.slice(start))safeObserve(agent.session,event)},
    prepareRestart(){if(failed)throw Error('recovery storage unavailable');const intent={nonce:crypto.randomUUID(),bootId,expiresAt:now()+10*60*1000};state.intent=intent;save();return{...intent,scope:'只准备更新重启；不执行更新，不增加操作授权'}},
    async recover(){if(closed||working||failed)return;working=true;try{for(const row of candidates){if(closed||failed)break;try{await attempt(row)}catch{row.note='恢复核对失败，尚未派发';try{save()}catch{failed=true;adapter.onError?.('recovery journal failed; disabled')}}}}finally{working=false}},
    status(){return {context,rows:Object.values(state.rows).map(({sessionId,status,note})=>({sessionId,status,note:note??null}))}},
    close(){closed=true;state.cleanShutdown=true;try{save()}catch{failed=true;adapter.onError?.('recovery clean shutdown record failed')}}
  }
}
