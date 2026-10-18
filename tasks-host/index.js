import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'
import { taskDataDir } from './user-data.mjs'
import {isPeriodic,periodicProof} from './periodic.mjs'
import {pluginTag,pluginSource,taskRecordType,eventsOf} from './sdk-compat.mjs'
import {createHostRpc,nativeHostDependencies} from '../plugin/host-compat.mjs'
import {authorizeHostOwner} from '../plugin/host-http.mjs'
import { trusted, canonicalTrustedHost } from '../plugin/server.js'
import { registerTaskTools } from './tools.mjs?source-chat-v1'
import { createTaskService } from './service.mjs?periodic-v5'

export const name = 'tasks'
export const inject = [...new Set(['webServer', 'agents', 'goals', 'sessions', 'permissionPresets', 'tools', 'systemPrompt',...nativeHostDependencies()])]
const fail = (message, status = 400) => { throw Object.assign(new Error(message), { status }) }
const ref = goal => ({ id: goal.id, revision: goal.revision })
const textOf = message => (message?.content || []).filter(p => p.type === 'text').map(p => p.text).join('\n')
const eventMessage = event => event?.data?.message || event?.data
export const goalObjective = task => task.objective + '\n\n执行要求（仅在上述目标范围内）：先建立并维护待办步骤，按顺序执行并核验交付；不依赖待答问题的独立工作可继续，权限与授权仍须等待明确确认。' + (task.previousBlockedReason ? '\n上一轮受阻记录（仅背景，非新授权）：'+JSON.stringify(task.previousBlockedReason).slice(0,2000)+'\n先核对外部条件是否变化，不得原样重复失败；未回答的问题或授权请求不代表同意，不能自动重试未知外发。' : '')

// This harness has no downstream event registration API yet. Register only
// our two existing persisted names in its shared vocabulary; never rewrite logs
// or relax the persistence guard for any other unknown event.
export function registerTaskEventCompatibility(sessionModule) {
  if (sessionModule.SESSION_FORMAT_VERSION >= 4 && typeof sessionModule.appendPluginRecord === 'function') return
  const known = sessionModule.KNOWN_SESSION_EVENT_TYPES
  if (!(known instanceof Set)) throw new Error('宿主会话事件兼容接口不可用，自动任务未启动')
  known.add('automatic-task/start')
  known.add('automatic-task/goal')
}
function validTaskMarker(event) {
  const data = event?.data
  return data && typeof data.runId === 'string' && /^[A-Za-z0-9_-]{1,160}$/.test(data.runId)
    && data.sourceTag === 'dsh-tasks/' + data.runId
    && (taskRecordType(event) !== 'automatic-task/goal' || typeof data.goalId === 'string' && /^[A-Za-z0-9_-]{1,160}$/.test(data.goalId))
}

export function createNativeAdapter(ctx, { rpc, createUserMessage, sessionModule }) {
  const modern = sessionModule?.SESSION_FORMAT_VERSION >= 4
  const appendMarker = (session,type,data) => modern ? sessionModule.appendPluginRecord(session,'plugin:dsh-tasks/'+type,data) : session.append('automatic-task/'+type,data)
  const occupancyCache = new Map()
  const runBoundaries = new Map()
  // Session.events is a fresh frozen array after append, not a mutable log.
  // Accepted events retain identity and contiguous seq across those snapshots.
  const appendedSnapshot = (session, events, prior) => {
    if (!prior || prior.session !== session || events.length < prior.length) return false
    if (!prior.length) return true
    if (events[prior.length - 1] !== prior.lastEvent) return false
    if (events.length === prior.length) return true
    return Number.isSafeInteger(prior.seq) && events[prior.length]?.seq === prior.seq + 1 && events.at(-1)?.seq === prior.seq + events.length - prior.length
  }
  const snapshotBoundary = (session, events) => ({session, length:events.length, lastEvent:events.at(-1), seq:events.at(-1)?.seq ?? -1})
  async function flush(session) { if (!await ctx.sessions.flush(session)) fail('会话没有可用持久化，任务不会启动', 409) }
  function owned(task, run) {
    if (!run || !run.sessionId || run.sourceTag !== 'dsh-tasks/' + run.id) fail('任务会话归属不正确', 403)
    if (run.inSourceSession && run.sessionId !== (task.sourceSessionId || task.executionSessionId)) fail('原聊天归属不正确', 403)
    const agent = ctx.agents.get(run.sessionId)
    if (!agent) fail('任务会话尚未加载', 409)
    if (agent.session.header?.cwd && path.resolve(agent.session.header.cwd) !== path.resolve(task.context.workspacePath)) fail('任务会话工作区不一致', 409)
    return agent
  }
  async function workspace(task) {
    const rows = (await rpc('workspace.list', {})).items || []
    const found = rows.find(w => w.workspaceId === task.workspaceId)
    if (!found?.path || !(await fs.promises.stat(found.path)).isDirectory()) fail('任务工作区不存在', 404)
    if (task.context && path.resolve(found.path) !== path.resolve(task.context.workspacePath)) fail('工作区路径已改变，请更新任务后再执行', 409)
    return found
  }
  async function load(task, run) {
    await workspace(task)
    if (run.inSourceSession) {
      if (run.sessionId !== (task.sourceSessionId || task.executionSessionId)) fail('原聊天归属不正确', 403)
      // models resolves a persisted identity via the native agentFor/resume path;
      // unlike session.create it cannot invent a missing session.
      if (!ctx.agents.get(run.sessionId)) await rpc('session.models', { sessionId: run.sessionId })
    } else await rpc('session.create', { sessionId: run.sessionId, workspaceId: task.workspaceId, ...(task.context.agentPreset ? { agentPreset: task.context.agentPreset } : {}) })
    return owned(task, run)
  }
  const busyError = () => Object.assign(new Error('原聊天正在工作或有未完成目标，等待空闲后执行'), { code: 'SOURCE_BUSY', notDispatched: true })
  function idle(agent) {
    const goal = ctx.goals.get(agent)
    const approvals = new Set()
    for (const event of eventsOf(agent.session) || []) { if (event.type === 'approval/asked') approvals.add(event.data.id); else if (event.type === 'approval/decided') approvals.delete(event.data.id) }
    return agent.status === 'idle' && !agent.inbox?.hasPending && !approvals.size && (!goal || goal.phase === 'complete')
  }
  function bounds(agent, run) {
    const events = eventsOf(agent.session) || []
    const identity = JSON.stringify([run.id,run.sourceTag,run.eventStartSeq,!!run.inSourceSession])
    const cached = runBoundaries.get(run.id)
    const reusable = cached?.identity === identity && appendedSnapshot(agent.session,events,cached.boundary)
    let scanFrom = 0, markerIndex = reusable ? cached.markerIndex : -1
    if (reusable) scanFrom = cached.boundary.length
    else if (Number.isSafeInteger(run.eventStartSeq) && run.eventStartSeq >= 0 && events[run.eventStartSeq]?.seq === run.eventStartSeq) {
      // prepare records the previous tail. An empty log uses zero; if its
      // first event is our marker, include it rather than skipping seq zero.
      const anchor=events[run.eventStartSeq]
      scanFrom=taskRecordType(anchor)==='automatic-task/start'&&anchor.data?.runId===run.id ? run.eventStartSeq : run.eventStartSeq+1
    }
    const runStart = reusable ? cached.runStart : scanFrom
    for(let i=scanFrom;i<events.length;i++) {
      const e=events[i]
      if ((taskRecordType(e)==='automatic-task/start'||taskRecordType(e)==='automatic-task/goal')&&!validTaskMarker(e)) fail('自动任务事件归属数据无效，请核对原聊天',409)
      if(markerIndex<0&&taskRecordType(e)==='automatic-task/start'&&e.data?.sourceTag===run.sourceTag&&e.data?.runId===run.id)markerIndex=i
    }
    runBoundaries.delete(run.id)
    runBoundaries.set(run.id,{identity,markerIndex,runStart,boundary:snapshotBoundary(agent.session,events)})
    while(runBoundaries.size>128)runBoundaries.delete(runBoundaries.keys().next().value)
    const after = markerIndex>=0 ? events.slice(markerIndex+1) : run.inSourceSession ? [] : events.slice(runStart)
    const binding = after.find(e => taskRecordType(e) === 'automatic-task/goal' && e.data?.sourceTag === run.sourceTag && e.data?.runId === run.id)
    const goalId = run.goal?.id || binding?.data?.goalId
    const matches = message => pluginTag(message?.source) === run.sourceTag || goalId && message?.source?.kind === 'goal' && message.source.goalId === goalId
    const message = after.find(e => e.type === 'user/message' && matches(eventMessage(e)))
    let start
    if(message)for(let i=after.indexOf(message)-1;i>=0;i--)if(after[i].type==='turn/start'){start=after[i];break}
    const end = start && after.find(e => e.type === 'turn/end' && e.seq > message.seq && e.data?.turn === start.data?.turn)
    const ownedEvents = []
    let turnEvents = [], belongs = false
    for (const event of after) {
      if (event.type === 'turn/start') { turnEvents = []; belongs = false }
      turnEvents.push(event)
      if (event.type === 'user/message' && matches(eventMessage(event))) belongs = true
      if (event.type === 'turn/end') { if (belongs) for (const ownedEvent of turnEvents) ownedEvents.push(ownedEvent); turnEvents = []; belongs = false }
    }
    if (belongs) for (const ownedEvent of turnEvents) ownedEvents.push(ownedEvent)
    return { after, goalId, matches, message, start, end, ownedEvents, openOwned: belongs }
  }
  async function inspectRun(task, run) {
    const agent = ctx.agents.get(run.sessionId)
    if (!agent) return { status: 'interrupted', running: false, summary: '会话尚未恢复，请明确继续' }
    owned(task, run)
    const bound = bounds(agent, run)
    const currentGoal = task.continuous ? ctx.goals.get(agent) : null
    const goal = currentGoal && bound.goalId === currentGoal.id ? currentGoal : null
    const events = task.continuous ? bound.ownedEvents : bound.message ? bound.after.filter(e => e.seq >= bound.message.seq && (!bound.end || e.seq <= bound.end.seq)) : []
    const last = [...events].reverse()
    const summary = textOf(eventMessage(last.find(e => e.type === 'assistant/message'))).slice(0, 3000)
    const todos = last.find(e => e.type === 'todo/write')?.data?.todos || []
    const approvals = new Set()
    for (const event of events) { if (event.type === 'approval/asked') approvals.add(event.data.id); else if (event.type === 'approval/decided') approvals.delete(event.data.id) }
    if (approvals.size) return { goal, summary: summary || '等待你在任务对话中处理原生审批', todos, running: true, status: 'waiting-user' }
    const ownedRunning = bound.openOwned && agent.status === 'running'
    if (goal) return { goal, summary, todos, running: goal.phase === 'complete' ? ownedRunning : agent.status === 'running', status: goal.phase === 'complete' ? (ownedRunning ? 'running' : 'complete') : goal.phase === 'blocked' ? 'blocked' : goal.phase === 'paused' ? 'paused' : goal.activation === 'disarmed' ? 'interrupted' : 'running' }
    if (task.continuous) return { status: 'interrupted', summary: '未找到本次目标，不能自动重复创建', running: agent.status === 'running', todos }
    const ended = bound.end
    if (events.some(e => e.type === 'user/message' && !bound.matches(eventMessage(e)))) return { status: 'interrupted', running: false, summary: '本次执行中有其他输入，请在原聊天核对结果', todos: [] }
    return { status: ended ? (ended.data?.reason?.kind === 'completed' ? 'complete' : ended.data?.reason?.kind === 'aborted' ? 'paused' : 'blocked') : task.enabled === false ? 'paused' : 'running', running: !ended && (agent.status === 'running' || task.enabled !== false), summary, todos }
  }
  async function inspect(task, run) {
    if ((task.archived || task.manualPause || task.status === 'paused') && run.stage === 'accepted' && run.status !== 'unknown' && !['unknown','dispatching'].includes(run.restartRecovery?.status) && !ctx.agents.get(run.sessionId) && typeof rpc === 'function') {
      // Resolve only an existing persisted session through the native read API.
      // Do not use load(): its standalone branch can create a new session.
      await workspace(task)
      await rpc('session.models', { sessionId: run.sessionId })
    }
    const suppressed = task.archived || task.manualPause || task.status === 'paused'
    const agent = ctx.agents.get(run.sessionId)
    const priorOccupancy = occupancyCache.get(run.id)
    let cacheKey
    const identity = JSON.stringify([run.id,run.stage,run.status,run.restartRecovery?.status,run.goal?.id,run.sourceTag,!!run.inSourceSession,!!task.continuous,!!task.enabled,!!task.archived,!!task.manualPause,task.status])
    if (suppressed && agent) {
      owned(task, run)
      const events = eventsOf(agent.session) || [], goal = ctx.goals.get(agent)
      cacheKey = JSON.stringify([events.length, events.at(-1)?.seq, goal?.id, goal?.revision, goal?.phase, goal?.activation, agent.status, !!agent.inbox?.hasPending, run.id, run.stage, run.status, !!run.running, run.restartRecovery?.status, run.goal?.id, run.sourceTag, !!run.inSourceSession, !!task.continuous, !!task.enabled, !!task.archived, !!task.manualPause, task.status])
      const cached = occupancyCache.get(run.id)
      if (cached?.agent === agent && appendedSnapshot(agent.session, events, cached.boundary) && cached.key === cacheKey) {
        occupancyCache.delete(run.id); occupancyCache.set(run.id, cached)
        return structuredClone(cached.view)
      }
      if (cached?.proof && cached.identity === identity && cached.agent === agent && appendedSnapshot(agent.session, events, cached.boundary) && ['idle','running'].includes(agent.status) && (!goal || run.goal?.id && goal.id !== run.goal.id)) {
        let foreignTurn = cached.foreignTurn || false, openTurn = cached.openTurn || false, safe = true
        for (let i=cached.observedLength;i<events.length;i++) {
          const event=events[i]
          if (event.type === 'turn/start') { openTurn=true; foreignTurn=false }
          if (event.type === 'user/message') {
            const source=eventMessage(event)?.source
            if (!openTurn || !source || pluginTag(source) === run.sourceTag || run.goal?.id && source.kind === 'goal' && source.goalId === run.goal.id) { safe=false; break }
            foreignTurn=true
          }
          if (event.type === 'goal/change' && run.goal?.id && event.data?.goal?.id === run.goal.id) { safe=false; break }
          if (event.type === 'tool/result' && !foreignTurn && JSON.stringify(event.data).includes('TOOL_OUTCOME_UNKNOWN')) { safe=false; break }
          if (event.type === 'turn/end') { openTurn=false }
        }
        if (safe && foreignTurn) {
          const updated={...cached,key:cacheKey,observedLength:events.length,boundary:snapshotBoundary(agent.session,events),foreignTurn,openTurn}
          occupancyCache.delete(run.id);occupancyCache.set(run.id,updated)
          return structuredClone(cached.view)
        }
      }
    }
    const view = await inspectRun(task, run)
    if (!suppressed) {
      if (isPeriodic(task) && view.status==='blocked') {
        const bound=bounds(agent,run),approvals=new Set()
        for(const e of eventsOf(agent.session)||[]){if(e.type==='approval/asked')approvals.add(e.data.id);else if(e.type==='approval/decided')approvals.delete(e.data.id)}
        return {...view,periodicSettlement:periodicProof({task,run,goal:ctx.goals.get(agent),agent,events:bound.ownedEvents,approvals:approvals.size})}
      }
      return view
    }
    let stopped = false
    let stoppedProof
    if (agent && run.stage === 'accepted' && run.status !== 'unknown' && !['unknown','dispatching'].includes(run.restartRecovery?.status)) {
      owned(task, run)
      const goal = ctx.goals.get(agent), bound = bounds(agent, run), approvals = new Set()
      for (const event of eventsOf(agent.session) || []) {
        if (event.type === 'approval/asked') approvals.add(event.data.id)
        else if (event.type === 'approval/decided') approvals.delete(event.data.id)
      }
      const runEvents = task.continuous ? bound.ownedEvents : bound.message ? bound.after.filter(event => event.seq >= bound.message.seq && (!bound.end || event.seq <= bound.end.seq)) : []
      const uncertain = runEvents.some(event => event.type === 'tool/result' && JSON.stringify(event.data).includes('TOOL_OUTCOME_UNKNOWN'))
      stopped = agent.status === 'idle' && !agent.inbox?.hasPending && !approvals.size && !uncertain && (!goal || goal.activation === 'disarmed')
      const events = eventsOf(agent.session) || [], previous = priorOccupancy?.proof
      if (stopped) stoppedProof = { agent, ...snapshotBoundary(agent.session,events) }
      else if (previous && previous.agent === agent && appendedSnapshot(agent.session,events,previous) && !uncertain && !bound.openOwned && (!goal || bound.goalId && goal.id !== bound.goalId)) {
        // A later, explicitly unrelated turn must not resurrect this archived
        // run merely because both runs share the same conversation/agent.
        let laterTurn = false, differentInput = false
        for (const event of events) {
          if (!(event.seq > previous.seq)) continue
          if (event.type === 'turn/start') { laterTurn = true; differentInput = false }
          if (laterTurn && event.type === 'user/message') differentInput = !bound.matches(eventMessage(event))
          if (event.type === 'turn/end') { laterTurn = false; differentInput = false }
        }
        if (laterTurn && differentInput) { stopped = true; stoppedProof = previous }
      }
    }
    const result = { ...view, ...(stopped ? { running: false } : {}), occupancyConfirmedStopped: stopped }
    if (agent && cacheKey) {
      const snapshot = structuredClone({ ...result, todos: Array.isArray(result.todos) ? result.todos.slice(0, 100) : [] })
      occupancyCache.delete(run.id)
      occupancyCache.set(run.id, { agent, boundary:snapshotBoundary(agent.session,eventsOf(agent.session)), key: cacheKey, identity, view: snapshot, proof: stoppedProof, observedLength:eventsOf(agent.session).length,foreignTurn:false,openTurn:false })
      while (occupancyCache.size > 128) occupancyCache.delete(occupancyCache.keys().next().value)
    }
    return result
  }
  async function inspectRestart(task,run,context){
    const no=summary=>({status:'interrupted',running:false,resumable:false,summary,todos:[]})
    if(!context?.eligible||!['crash','update-intent'].includes(context.reason)||task.archived||task.manualPause||run.stage!=='accepted'||!run.restartCandidate?.wasEnabled)return no('本次不满足重启恢复条件')
    const agent=await load(task,run),bound=bounds(agent,run)
    const view=await inspect(task,run)
    if(view.status==='complete')return {...view,resumable:false}
    const approvals=new Set()
    for(const e of eventsOf(agent.session)){if(e.type==='approval/asked')approvals.add(e.data.id);else if(e.type==='approval/decided')approvals.delete(e.data.id)}
    if(approvals.size)return {...no('原聊天存在待处理审批'),status:'waiting-user'}
    if(!task.continuous)return no('单次任务中断后需在原聊天核对结果，不自动重放')
    const goal=ctx.goals.get(agent)
    if(!bound.goalId||goal?.id!==bound.goalId||run.goal?.id!==goal.id)return no('本次目标归属不匹配')
    if(bound.after.some(e=>e.type==='goal/change'&&['pause','clear'].includes(e.data?.operation)||e.type==='turn/end'&&e.data?.reason?.kind==='aborted'&&e.data.reason.reason?.kind==='user'))return no('原任务已被手动暂停或停止')
    if(bound.after.some(e=>e.type==='user/message'&&!bound.matches(eventMessage(e))))return no('原聊天已有其他输入，不自动续发旧任务')
    if(bound.after.some(e=>e.type==='tool/result'&&JSON.stringify(e.data).includes('TOOL_OUTCOME_UNKNOWN')))return no('工具结果未知，需先核对产物和回执')
    if(agent.status!=='idle'||agent.inbox?.hasPending)return {...no('原聊天正在工作，等待核对'),running:true,status:'running'}
    if(goal.phase!=='active'||goal.activation!=='disarmed'||!Number.isSafeInteger(goal.roundsStarted)||!Number.isSafeInteger(goal.maxGoalRounds)||goal.roundsStarted>=goal.maxGoalRounds)return no('目标未处于可恢复状态或轮数预算已用完')
    return {...view,status:'interrupted',running:false,resumable:true,goal,summary:view.summary||'可在原目标剩余预算内继续'}
  }
  return {
    inspectRestart,
    async resumeRestart(task,run,context){
      const view=await inspectRestart(task,run,context)
      if(!view.resumable)throw Error(view.summary||'重启恢复检查未通过')
      const agent=owned(task,run),current=ctx.goals.get(agent)
      if(current?.id!==view.goal.id||current.revision!==view.goal.revision||agent.status!=='idle'||agent.inbox?.hasPending)throw Error('目标在恢复前已发生变化')
      const goal=ctx.goals.resume(agent,ref(current));await flush(agent.session)
      return {status:'running',running:true,goal,summary:'已在原目标剩余预算内继续；未重建目标或扩大授权'}
    },
    async canStart(task) {
      const sessionId = task.sourceSessionId || task.executionSessionId
      if (!sessionId) return true
      if (!task.sourceSessionId && task.lastRun?.inSourceSession === false && task.lastRun?.stage === 'claimed' && !ctx.agents.get(sessionId)) return true
      const run = { id: 'availability', sessionId, sourceTag: 'dsh-tasks/availability', inSourceSession: true }
      return idle(await load(task, run))
    },
    async diagnostics(task, run) {
      const agent = ctx.agents.get(run.sessionId), event = [...(eventsOf(agent?.session) || [])].reverse().find(e => e.type === 'assistant/message')
      const result = { live: !!agent, agentStatus: agent?.status || null, sourceTagMatches: run.sourceTag === 'dsh-tasks/' + run.id, cwdMatches: !agent?.session.header?.cwd || path.resolve(agent.session.header.cwd) === path.resolve(task.context.workspacePath), lastAssistantSeq: event?.seq ?? null, lastAssistantDataKeys: Object.keys(event?.data || {}), candidateSummaryLength: textOf(eventMessage(event)).length }
      try { const view = await inspect(task, run); return { ...result, inspectStatus: view.status, occupancyConfirmedStopped: view.occupancyConfirmedStopped === true, inspectRunning: !!view.running, inspectSummaryLength: view.summary?.length || 0 } } catch (error) { return { ...result, inspectError: String(error.message || 'inspect failed').slice(0, 200) } }
    },
    async catalog() {
      const workspaces = (await rpc('workspace.list', {})).items.map(w => ({ workspaceId: w.workspaceId, title: w.title, path: w.path, sessionIds: [...(w.sessionIds || [])] }))
      const permissionPresets = ctx.permissionPresets.names.map(name => ({ name, label: ctx.permissionPresets.optionOf(name).name }))
      const defaultPermissionPreset = permissionPresets.some(p => p.name === 'workspace-write') ? 'workspace-write' : permissionPresets.some(p => p.name === 'read-only') ? 'read-only' : null
      return { workspaces, permissionPresets, defaultPermissionPreset, modelTools: ['automatic_tasks_list', 'automatic_tasks_manage'].filter(name => ctx.tools?.get?.(name)) }
    },
    async validate(task) {
      ctx.permissionPresets.resolve(task.permissionPreset)
      const w = await workspace(task)
      let model = null, agentPreset = null
      if (task.sourceSessionId) {
        if (!(w.sessionIds || []).includes(task.sourceSessionId)) fail('源会话必须属于所选工作区', 403)
        const source = (await rpc('session.list', {})).items.find(s => s.sessionId === task.sourceSessionId && s.origin !== 'subagent')
        if (!source) fail('源会话不存在或不是主会话', 404)
        model = (await rpc('session.models', { sessionId: task.sourceSessionId })).current
        agentPreset = source.agentPreset || null
      }
      return { workspacePath: w.path, model, agentPreset }
    },
    async prepare(task, run) {
      const agent = await load(task, run)
      if (run.inSourceSession) {
        if (!idle(agent)) throw busyError()
        await flush(agent.session)
        return { eventStartSeq: eventsOf(agent.session).at(-1)?.seq ?? 0 }
      }
      await rpc('session.rename', { sessionId: run.sessionId, title: '自动任务 · ' + task.title })
      if (task.context.model) await rpc('session.selectModel', { sessionId: run.sessionId, ...task.context.model })
      ctx.permissionPresets.resolve(task.permissionPreset)
      ctx.permissionPresets.set(agent.session, task.permissionPreset)
      if (ctx.permissionPresets.current(modern ? agent.session : eventsOf(agent.session)) !== task.permissionPreset) fail('任务权限设置未生效', 409)
      await flush(agent.session)
      return { eventStartSeq: eventsOf(agent.session).at(-1)?.seq ?? 0 }
    },
    async dispatch(task, run) {
      const agent = owned(task, run)
      if (run.inSourceSession && !idle(agent)) throw busyError()
      if (eventsOf(agent.session).some(e => taskRecordType(e) === 'automatic-task/start' && e.data?.sourceTag === run.sourceTag)) fail('本次任务已派发或结果未知，不能重复执行', 409)
      appendMarker(agent.session,'start', { runId: run.id, sourceTag: run.sourceTag })
      if (task.continuous) {
        const goal = ctx.goals.create(agent, { objective: `自动任务：${task.title}\n运行标记：${run.sourceTag}\n${goalObjective(task)}`, maxGoalRounds: task.maxGoalRounds })
        appendMarker(agent.session,'goal', { runId: run.id, sourceTag: run.sourceTag, goalId: goal.id })
        await flush(agent.session)
        return { goal, running: true }
      }
      agent.followup(createUserMessage({ content: [{ type: 'text', text: `这是用户已创建的自动任务，本次仅执行一次，继续遵守当前权限和审批边界。\n任务：${task.title}\n${task.objective}` }], source: pluginSource(run.sourceTag,modern) }))
      await flush(agent.session)
      return { running: true }
    },
    currentPermission: session => ctx.permissionPresets.current(modern ? session : eventsOf(session)),
    inspect,
    async prepareNextOccurrence(task,run) {
      const view=await inspect(task,run)
      if(!view.periodicSettlement?.eligible)return{ready:false,reason:view.periodicSettlement?.reason||'旧运行尚未核实停止'}
      const agent=owned(task,run),goal=ctx.goals.get(agent),expected=run.periodicSettlement?.goalRef
      if(!expected||goal?.id!==expected.id||goal?.revision!==expected.revision||agent.status!=='idle'||agent.inbox?.hasPending)return{ready:false,reason:'原目标已变化，请人工核对'}
      const approvals=new Set(),bound=bounds(agent,run)
      for(const e of eventsOf(agent.session)||[]){if(e.type==='approval/asked')approvals.add(e.data.id);else if(e.type==='approval/decided')approvals.delete(e.data.id)}
      const current=periodicProof({task,run,goal,agent,events:bound.ownedEvents,approvals:approvals.size})
      if(!current.eligible)return{ready:false,reason:current.reason}
      ctx.goals.clear(agent,ref(goal));await flush(agent.session)
      occupancyCache.delete(run.id)
      return{ready:true}
    },
    async archive(task, run) {
      if (!task.archived) fail('仅明确归档时可以清理停止目标',409)
      if (run.stage !== 'accepted' || run.status === 'unknown' || ['unknown','dispatching'].includes(run.restartRecovery?.status)) return { cleanup:'unconfirmed' }
      const view=await inspect(task,run),agent=ctx.agents.get(run.sessionId)
      if (!agent || view.occupancyConfirmedStopped !== true || agent.status !== 'idle' || agent.inbox?.hasPending) return { cleanup:'not-stopped' }
      owned(task,run)
      const goal=ctx.goals.get(agent),bound=bounds(agent,run),goalId=bound.goalId,approvals=new Set()
      for(const event of eventsOf(agent.session)||[]) { if(event.type==='approval/asked')approvals.add(event.data.id);else if(event.type==='approval/decided')approvals.delete(event.data.id) }
      const runEvents=task.continuous?bound.ownedEvents:bound.message?bound.after.filter(event=>event.seq>=bound.message.seq&&(!bound.end||event.seq<=bound.end.seq)):[]
      if(approvals.size||runEvents.some(event=>event.type==='tool/result'&&JSON.stringify(event.data).includes('TOOL_OUTCOME_UNKNOWN')))return{cleanup:'unconfirmed'}
      if (goal && goal.id !== goalId) return { running:false,goalCleared:false,cleanup:'different-goal' }
      if (goal && !['blocked','paused'].includes(goal.phase) && goal.activation !== 'disarmed') return { cleanup:'not-stopped' }
      // clear appends a native tombstone under revision CAS; it neither marks
      // the business objective complete nor deletes any historical events.
      const cleared=goal ? ctx.goals.clear(agent,ref(goal)) : null
      await flush(agent.session)
      occupancyCache.delete(run.id)
      return {running:false,goalCleared:!!cleared,...cleared?{clearedGoal:cleared}:{}}
    },
    async pause(task, run) {
      const agent = ctx.agents.get(run.sessionId); if (!agent) return
      owned(task, run)
      const goal = ctx.goals.get(agent)
      const bound = bounds(agent, run)
      const lastUser = [...(eventsOf(agent.session) || [])].reverse().find(e => e.type === 'user/message')
      const safeToPause = agent.status === 'idle' || !agent.inbox?.hasPending && lastUser && bound.matches(eventMessage(lastUser))
      if (task.continuous && goal?.id === bound.goalId && goal?.phase === 'active' && safeToPause) ctx.goals.pause(agent, ref(goal))
      else if (!task.continuous && agent.status === 'running' && bound.message && !bound.end && !agent.inbox?.hasPending && !bound.after.some(e => e.type === 'user/message' && !bound.matches(eventMessage(e)))) agent.cancel({ kind: 'user' }, { keepInbox: true })
      await flush(agent.session)
    },
    async resume(task, run) {
      const agent = await load(task, run)
      if (!task.continuous) {
        const view = await inspect(task, run)
        if (view.status === 'complete') return { running: false }
        fail('单次任务结果需在原会话核对，不能自动重放；请打开该任务对话继续', 409)
      }
      let goal = ctx.goals.get(agent)
      if (!goal) fail('未确认旧目标已创建，不能重复派发；请核对任务对话', 409)
      if (!bounds(agent, run).goalId || goal.id !== bounds(agent, run).goalId) fail('原会话目标已被改变，请在会话中处理', 409)
      if (agent.status !== 'idle' || agent.inbox?.hasPending) fail('原聊天仍在工作，请等待空闲再继续', 409)
      if (goal.phase === 'complete') return { goal, running: false }
      const maxGoalRounds = goal.roundsStarted >= goal.maxGoalRounds ? goal.roundsStarted + task.maxGoalRounds : Math.max(goal.maxGoalRounds, task.maxGoalRounds)
      if (maxGoalRounds !== goal.maxGoalRounds || goalObjective(task) !== goal.objective) goal = ctx.goals.edit(agent, ref(goal), { objective: goalObjective(task), maxGoalRounds })
      goal = ctx.goals.resume(agent, ref(goal)); await flush(agent.session)
      return { goal, running: true }
    },
    async disarm(task, run) {
      const agent = ctx.agents.get(run.sessionId); if (!agent || !task.continuous) return
      owned(task, run)
      const goal = ctx.goals.get(agent)
      if (goal && goal.id === bounds(agent, run).goalId) ctx.goals.disarm(agent)
    }
  }
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0, tooLarge = false; const parts = []
    req.on('data', part => { size += part.length; if (size > 65536) { tooLarge = true; parts.length = 0; reject(Object.assign(new Error('任务内容过大'), { status: 413 })); return }; if (!tooLarge) parts.push(part) })
    req.on('end', () => { if (tooLarge) return; try { resolve(JSON.parse(Buffer.concat(parts).toString('utf8'))) } catch { reject(Object.assign(new Error('无效的JSON'), { status: 400 })) } })
    req.on('error', reject)
  })
}
export function createTasksHandler(service, adapter, trustedHosts = [], authorize = () => undefined) {
  return async (req, res) => {
    const reply = (status, body) => { if (res.headersSent) return; const data = JSON.stringify(body); res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }); res.end(data) }
    const denied=authorize(req)
    if(denied){reply(denied,{ok:false,error:{message:'需要宿主所有者身份'}});return}
    if (!trusted(req, trustedHosts)) { reply(403, { ok: false, error: { message: '请求来源不受信任' } }); return }
    try {
      if (req.method === 'GET') {
        const query = new URL(req.url, 'http://local').searchParams, id = query.get('id')
        const tasks = await service.list(id)
        const diagnostics = id && query.get('diagnostic') === '1' && tasks[0]?.lastRun && adapter.diagnostics ? await adapter.diagnostics(tasks[0], tasks[0].lastRun) : undefined
        reply(200, { ok: true, value: { apiVersion: 2, serviceVersion: service.apiVersion ?? 1, tasks, ...await adapter.catalog(), ...(diagnostics ? { diagnostics } : {}) } }); return
      }
      if (req.method !== 'POST') { reply(405, { ok: false, error: { message: '不支持的请求方法' } }); return }
      if (!/^application\/json\b/i.test(req.headers['content-type'] || '')) { reply(415, { ok: false, error: { message: '需要JSON请求' } }); return }
      reply(200, { ok: true, value: await service.mutate(await readJson(req)) })
    } catch (error) { reply(error.status || 503, { ok: false, error: { code: error.code || 'tasks', message: error.status && error.status < 500 ? error.message : '任务操作未确认，请刷新核对，勿重复派发' } }) }
  }
}
export async function apply(ctx, config = {}) {
  const trustedHosts = config.trustedHosts || []
  if (!Array.isArray(trustedHosts) || trustedHosts.some(host => canonicalTrustedHost(host) === null)) throw Error('tasks trustedHosts must be host authorities')
  const fromHost={resolve:spec=>{for(const c of [process.argv[1]&&!process.argv[1].startsWith('-')?path.resolve(process.argv[1]):null,import.meta.url,'/Applications/DeepSeek Harness.app/Contents/Resources/app.asar/package.json'].filter(Boolean)){try{return createRequire(c).resolve(spec)}catch{}}return createRequire(import.meta.url).resolve(spec)}}
  // Resolve from the running host, not this plugin's dependency tree: the
  // persistence coordinator must see this exact same module singleton Set.
  const sessionModule = await import(pathToFileURL(fromHost.resolve('@deepseek-ai/dsh-session')).href)
  registerTaskEventCompatibility(sessionModule)
  const { createUserMessage } = await import(pathToFileURL(fromHost.resolve('@deepseek-ai/dsh-llm')).href)
  const { defineTool } = await import(pathToFileURL(fromHost.resolve('@deepseek-ai/dsh-tools')).href)
  const hostRpc=createHostRpc(ctx)
  const rpc=(method,payload)=>hostRpc(method,payload,45000)
  const adapter = createNativeAdapter(ctx, { rpc, createUserMessage, sessionModule })
  const service = createTaskService({ dir: taskDataDir(config), adapter, maxActive: config.maxActive ?? 2, startupContext:()=>globalThis[Symbol.for('dsh.recovery.startup')] })
  registerTaskTools(ctx, { service, adapter, defineTool })
  ctx.effect(() => ctx.webServer.register({ kind: 'exact', path: '/m/api/tasks', handler: createTasksHandler(service, adapter, trustedHosts,req=>authorizeHostOwner(ctx,req)) }), 'tasks HTTP')
  ctx.effect(() => () => service.close(), 'tasks shutdown')
  service.start()
}
