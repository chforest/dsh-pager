import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { normalizeSchedule, nextRun, dueOccurrence } from './schedule.mjs'
const clone = x => JSON.parse(JSON.stringify(x))
const fail = (message, status = 400, code = 'tasks') => { throw Object.assign(new Error(message), { status, code }) }
const uuid = x => typeof x === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(x)
const active = r => r && (['claimed', 'waiting-idle', 'dispatching', 'running', 'pausing', 'waiting-user', 'unknown'].includes(r.status) || (r.status === 'interrupted' && ['dispatching', 'accepted'].includes(r.stage)) || r.running)
const recoverable = r => r && ['interrupted', 'unknown', 'paused', 'blocked'].includes(r.status) && !(r.status==='blocked'&&r.periodicSettlement?.status==='blocked-terminal'&&!['clearing','unknown'].includes(r.nextOccurrencePreparation?.status))

export function createTaskService({ dir, adapter, now = () => Date.now(), maxActive = 2, maxTasks = 200, startupContext }) {
  if (!dir || !adapter) fail('任务服务配置不完整')
  if (!Number.isInteger(maxActive) || maxActive < 1 || maxActive > 4) fail('并行任务上限必须为1至4')
  const root = path.resolve(dir), file = path.join(root, 'tasks.json')
  const canon = p => (process.platform === 'darwin' ? path.resolve(p).replace(/^\/(var|tmp|etc)(?=\/|$)/, '/private/$1') : path.resolve(p)).toLowerCase()
  fs.mkdirSync(root, { recursive: true, mode: 0o700 })
  if (fs.lstatSync(root).isSymbolicLink() || fs.realpathSync(root).toLowerCase() !== canon(root)) fail('任务目录不能使用链接', 403)
  let state = { version: 1, tasks: [], requests: [] }, chain = Promise.resolve(), timer = null, closing = false
  const launches = new Set()
  const completedInspections = new Set()
  const stoppedOccupancy = new Set()
  const suppressed = task => task.archived || task.manualPause || task.status === 'paused'
  const occupies = task => active(task.lastRun) && !(suppressed(task) && stoppedOccupancy.has(task.lastRun.id))
  let tickInFlight = null, refreshInFlight = null, restartInFlight = null
  if (fs.existsSync(file)) {
    if (fs.lstatSync(file).isSymbolicLink() || fs.statSync(file).size > 8 * 1024 * 1024) fail('任务存储异常', 409)
    state = JSON.parse(fs.readFileSync(file, 'utf8'))
    if (state.version !== 1 || !Array.isArray(state.tasks) || !Array.isArray(state.requests) || state.tasks.length > maxTasks) fail('任务存储格式不正确', 409)
  }
  function save() {
    const data = Buffer.from(JSON.stringify(state))
    if (data.length > 8 * 1024 * 1024) fail('任务存储已满', 507)
    const temp = path.join(root, crypto.randomUUID() + '.tmp')
    try { const fd = fs.openSync(temp, 'wx', 0o600); try { fs.writeFileSync(fd, data); fs.fsyncSync(fd) } finally { fs.closeSync(fd) }; fs.renameSync(temp, file) }
    finally { if (fs.existsSync(temp)) fs.unlinkSync(temp) }
  }
  function snapshotRestart(task, source) {
    const run = task.lastRun
    if (!run) return
    const previous = run.restartCandidate
    if (run.status === 'interrupted' && previous?.sourceBootId === state.runtimeBootId && !task.manualPause && !task.archived) return
    run.restartCandidate = { sourceBootId: state.runtimeBootId || null, wasEnabled: task.enabled === true && !task.archived && !task.manualPause && run.stage === 'accepted' && !['paused','unknown','blocked'].includes(run.status), source, observedAt: new Date(now()).toISOString() }
  }
  for (const task of state.tasks) if (task.lastRun?.nextOccurrencePreparation?.status === 'clearing') {
    task.lastRun.nextOccurrencePreparation.status='unknown';task.lastRun.settlementBlockedReason='重启前旧目标清理结果未确认，需人工核对，不自动重试';task.enabled=false;task.status=task.archived?'archived':'blocked'
  }
  for (const task of state.tasks) if (active(task.lastRun) && !task.archived && task.status !== 'paused' && !task.manualPause) {
    snapshotRestart(task, 'startup')
    task.enabled = false; task.status = 'interrupted'; task.lastRun.status = 'interrupted'; task.lastRun.running = false
    task.lastRun.summary = '服务重启后等待启动条件及原会话结果核对；未知派发不会重发'
  }
  if (state.tasks.length) save()
  const locked = fn => { const result = chain.then(fn); chain = result.catch(() => {}); return result }
  const find = id => { const task = state.tasks.find(t => t.id === id); if (!task) fail('找不到任务', 404); return task }
  const countActive = () => state.tasks.filter(occupies).length
  function validate(input, previous) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) fail('任务内容不正确')
    const x = { ...previous, ...input }
    if (previous && input.workspaceId !== undefined && input.workspaceId !== previous.workspaceId && !Object.hasOwn(input, 'sourceSessionId')) x.sourceSessionId = null
    for (const [key, max] of [['title', 120], ['objective', 12000], ['workspaceId', 200]]) if (typeof x[key] !== 'string' || !x[key].trim() || x[key].length > max) fail('请填写有效的任务标题、目标和工作区')
    const maxGoalRounds = x.maxGoalRounds ?? 8
    if (!Number.isSafeInteger(maxGoalRounds) || maxGoalRounds < 1 || maxGoalRounds > 100) fail('推进轮数须为1至100')
    if (x.continuous !== undefined && typeof x.continuous !== 'boolean') fail('持续推进参数不正确')
    if (x.sourceSessionId != null && (typeof x.sourceSessionId !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(x.sourceSessionId))) fail('源会话编号不正确')
    return { title: x.title.trim(), objective: x.objective.trim(), workspaceId: x.workspaceId, sourceSessionId: x.sourceSessionId || null, permissionPreset: x.permissionPreset || 'workspace-write', maxGoalRounds, continuous: x.continuous !== false, schedule: normalizeSchedule(x.schedule, now(), !!previous && JSON.stringify(x.schedule) === JSON.stringify(previous.schedule)) }
  }
  const targetSession = task => task.sourceSessionId || task.executionSessionId
  const sourceOccupied = task => !!targetSession(task) && state.tasks.some(other => other.id !== task.id && occupies(other) && other.lastRun.sessionId === targetSession(task))
  async function canStart(task) { return !sourceOccupied(task) && (!adapter.canStart || await adapter.canStart(clone(task))) }
  async function scheduledReady(task) {
    try { return await canStart(task) } catch (error) {
      task.enabled = false; task.status = 'blocked'; task.error = String(error.message || '原聊天暂不可用').slice(0, 300); save(); return false
    }
  }
  function claim(task, occurrence) {
    if (active(task.lastRun)) fail('该任务正在运行，不重复启动', 409)
    if (recoverable(task.lastRun)) fail('先继续或核对上次任务，不重放未知结果', 409)
    if (sourceOccupied(task)) fail('原聊天中已有自动任务，请稍后', 409)
    if (countActive() >= maxActive) fail('其他自动任务正在运行，请稍后', 409)
    if(task.pendingBlockedContext){task.previousBlockedReason=clone(task.pendingBlockedContext);delete task.pendingBlockedContext}
    else if(task.lastRun?.periodicSettlement?.status!=='blocked-terminal')delete task.previousBlockedReason
    if (task.lastRun) task.runs = [...(task.runs || []), task.lastRun].slice(-20)
    const id = crypto.randomUUID(), existingSession = targetSession(task)
    task.executionSessionId = existingSession || 'session-' + crypto.randomUUID()
    task.lastRun = { id, sessionId: task.executionSessionId, inSourceSession: !!existingSession, sourceTag: 'dsh-tasks/' + id, occurrence, status: 'claimed', stage: 'claimed', goal: null, summary: '', todos: [], startedAt: new Date(now()).toISOString(), finishedAt: null, running: false }
    task.status = 'running'; task.updatedAt = new Date(now()).toISOString(); save()
    return { task: clone(task), run: clone(task.lastRun) }
  }
  function kick(job) {
    const promise = launch(job).catch(() => {})
    launches.add(promise); promise.finally(() => launches.delete(promise))
  }
  async function launch({ task: definition, run }) {
    let dispatch = false
    try {
      const prepared = await adapter.prepare(definition, run)
      if (Number.isSafeInteger(prepared?.eventStartSeq)) run.eventStartSeq = prepared.eventStartSeq
      const proceed = await locked(() => {
        const task = find(definition.id)
        if (closing || task.archived || !task.enabled || task.lastRun?.id !== run.id || task.lastRun.status === 'paused') return false
        if (Number.isSafeInteger(run.eventStartSeq)) task.lastRun.eventStartSeq = run.eventStartSeq
        task.lastRun.stage = 'dispatching'; task.lastRun.status = 'dispatching'; save(); return true
      })
      if (!proceed) return
      dispatch = true
      const receipt = await adapter.dispatch(definition, run)
      await locked(() => {
        const task = find(definition.id); if (task.lastRun?.id !== run.id) return
        task.lastRun.stage = 'accepted'; task.lastRun.goal = receipt?.goal || null
        if (task.enabled && !task.archived) task.lastRun.status = 'running'
        task.lastRun.running = receipt?.running !== false; save()
      })
    } catch (error) {
      await locked(() => {
        const task = find(definition.id); if (task.lastRun?.id !== run.id) return
        if (error.code === 'SOURCE_BUSY' && error.notDispatched === true) {
          task.status = 'waiting-idle'; task.lastRun.status = 'waiting-idle'; task.lastRun.stage = 'claimed'; task.lastRun.running = false; task.lastRun.summary = '等待原聊天空闲后执行'; save(); return
        }
        task.enabled = false; task.status = dispatch ? 'unknown' : 'blocked'
        task.lastRun.status = task.status; task.lastRun.running = false
        task.lastRun.summary = dispatch ? '派发结果未确认，请核对会话后继续；不会自动重发' : '准备未完成：' + String(error.message || '启动失败').slice(0, 300)
        if (!dispatch) task.lastRun.stage = 'prepare-failed'
        save()
      })
    }
  }
  async function refreshOnce() {
    for (const original of [...state.tasks]) {
      const run = original.lastRun
      if (run && suppressed(original) && active(run)) {
        // Resource occupancy is not the task result: preserve the archived or
        // paused record, and never resume/replay it to reconcile a stale slot.
        let view
        try { view = await adapter.inspect(clone(original), clone(run)) } catch {}
        await locked(() => {
          const task = find(original.id)
          if (task.lastRun?.id !== run.id) return
          const unknown = run.status === 'unknown' || run.stage === 'dispatching' || ['unknown','dispatching'].includes(run.restartRecovery?.status)
          if (suppressed(task) && !unknown && view?.occupancyConfirmedStopped === true && view.running === false) stoppedOccupancy.add(run.id)
          else stoppedOccupancy.delete(run.id)
        })
        continue
      }
      if (!run || run.stage !== 'accepted' || (!['running', 'paused', 'pausing', 'waiting-user'].includes(run.status) && !(run.status === 'complete' && (run.running || ((!run.summary || !run.finishedAt) && !completedInspections.has(run.id)))))) continue
      let view
      try { view = await adapter.inspect(clone(original), clone(run)) } catch { continue }
      await locked(() => {
        const task = find(original.id); if (task.lastRun?.id !== run.id) return
        Object.assign(task.lastRun, { running: !!view.running, goal: view.goal || task.lastRun.goal, summary: String(view.summary || task.lastRun.summary || '').slice(0, 3000), todos: Array.isArray(view.todos) ? view.todos.slice(0, 100) : task.lastRun.todos })
        if (view.status === 'complete') {
          if (!view.running) { completedInspections.add(run.id); if (completedInspections.size > 1024) completedInspections.delete(completedInspections.values().next().value) }
          task.lastRun.status = 'complete'; task.lastRun.finishedAt ||= new Date(now()).toISOString()
          task.status = task.archived ? 'archived' : task.enabled && task.nextRunAt ? 'scheduled' : 'complete'
        } else if (view.status === 'waiting-user') {
          task.lastRun.status = 'waiting-user'; task.status = 'waiting-user'
        } else if (view.status === 'running' && task.enabled && !task.archived) {
          task.lastRun.status = 'running'; task.status = 'running'
        } else if (['blocked', 'paused', 'interrupted'].includes(view.status)) {
          if(view.status==='blocked'&&view.running&&['daily','interval'].includes(task.schedule?.kind)&&task.enabled&&!task.manualPause&&!task.archived){task.lastRun.status='running';task.status='running'}
          else if(view.status==='blocked'&&view.periodicSettlement?.eligible===true&&view.running===false&&task.enabled&&!task.manualPause&&!task.archived&&['daily','interval'].includes(task.schedule?.kind)){
            task.lastRun.status='blocked';task.lastRun.finishedAt ||= new Date(now()).toISOString();task.lastRun.periodicSettlement={...view.periodicSettlement,status:'blocked-terminal'};task.status='scheduled'
            if(!task.nextRunAt||Date.parse(task.nextRunAt)<=now())task.nextRunAt=nextRun(task.schedule,now())
          }else{task.lastRun.status = view.status; task.status = task.archived ? 'archived' : view.status; task.enabled = false;if(view.periodicSettlement?.reason)task.lastRun.settlementBlockedReason=view.periodicSettlement.reason}
        }
        save()
      })
    }
  }
  function refresh() {
    if (!refreshInFlight) refreshInFlight = refreshOnce().finally(() => { refreshInFlight = null })
    return refreshInFlight
  }
  async function recoverRestartOnce(context) {
    if (closing || !context?.bootId) return { inspected: 0, resumed: 0, reason: 'startup-context-unavailable' }
    const report = { inspected: 0, resumed: 0, completed: 0, waiting: 0, unknown: 0, reason: context.reason }
    const candidates = await locked(() => {
      if (state.runtimeBootId === context.bootId) { report.reason = 'same-boot'; return [] }
      const previous = state.runtimeBootId
      const eligible = context.eligible === true && ['crash','update-intent'].includes(context.reason) && previous && previous === context.previousBootId && (context.reason !== 'update-intent' || context.intentExpiresAt == null || context.intentExpiresAt > now())
      state.runtimeBootId = context.bootId
      const rows = eligible ? state.tasks.filter(task => !task.archived && !task.manualPause && task.status !== 'paused' && task.lastRun?.stage === 'accepted' && task.lastRun.restartCandidate?.wasEnabled && task.lastRun.restartCandidate.sourceBootId === previous && !['dispatching','unknown'].includes(task.lastRun.restartRecovery?.status)).map(clone) : []
      if (!eligible) report.reason = context.reason === 'same-boot' ? 'same-boot' : 'not-authorized-for-recovery'
      save(); return rows
    })
    for (const original of candidates) {
      if (closing) break
      let view
      try {
        if (typeof adapter.inspectRestart !== 'function') { report.waiting++; continue }
        view = await adapter.inspectRestart(clone(original), clone(original.lastRun), context)
        report.inspected++
      } catch (error) {
        await locked(() => { const task=find(original.id); if(task.lastRun?.id===original.lastRun.id&&!task.manualPause&&!task.archived){task.lastRun.summary='恢复检查未完成：'+String(error.message||'请核对原会话').slice(0,240);save()} })
        report.waiting++; continue
      }
      const job = await locked(() => {
        const task=find(original.id),run=task.lastRun
        if(closing||run?.id!==original.lastRun.id||task.manualPause||task.archived||task.status==='paused'||task.revision!==original.revision)return null
        Object.assign(run,{goal:view.goal||run.goal,summary:String(view.summary||run.summary||'').slice(0,3000),todos:Array.isArray(view.todos)?view.todos.slice(0,100):run.todos,running:!!view.running})
        if(view.status==='complete'&&!view.running){run.status='complete';run.finishedAt ||= new Date(now()).toISOString();task.enabled=true;task.status=task.nextRunAt?'scheduled':'complete';run.restartRecovery={bootId:context.bootId,status:'complete',checkedAt:new Date(now()).toISOString()};report.completed++;save();return null}
        if(view.status==='waiting-user'||view.running){run.status=view.status==='waiting-user'?'waiting-user':'running';task.status=run.status;task.enabled=true;run.restartRecovery={bootId:context.bootId,status:'observed-active',checkedAt:new Date(now()).toISOString()};report.waiting++;save();return null}
        const occupied = state.tasks.filter(row=>row.id!==task.id&&(row.lastRun?.running||row.lastRun?.stage==='dispatching'||['dispatching','unknown'].includes(row.lastRun?.restartRecovery?.status)))
        if(view.resumable!==true||typeof adapter.resumeRestart!=='function'||occupied.length>=maxActive||occupied.some(row=>row.lastRun.sessionId===run.sessionId)){run.status='interrupted';task.status='interrupted';task.enabled=false;report.waiting++;save();return null}
        run.restartRecovery={bootId:context.bootId,attemptId:crypto.randomUUID(),status:'dispatching',startedAt:new Date(now()).toISOString(),reason:context.reason};save()
        return {task:clone(task),run:clone(run)}
      })
      if(!job)continue
      try {
        const receipt=await adapter.resumeRestart(job.task,job.run,{...context,attemptId:job.run.restartRecovery.attemptId})
        await locked(async()=>{
          const task=find(job.task.id),run=task.lastRun
          if(run?.id!==job.run.id||run.restartRecovery?.attemptId!==job.run.restartRecovery.attemptId)return
          if(task.manualPause||task.archived){await adapter.pause(clone(task),clone(run));run.restartRecovery.status='paused-by-user';run.running=false;save();return}
          if(!receipt||!['running','waiting-user','complete'].includes(receipt.status))throw Error('恢复操作未返回确定状态')
          run.restartRecovery.status='accepted';run.running=!!receipt.running;run.goal=receipt.goal||run.goal;run.summary=String(receipt.summary||run.summary||'').slice(0,3000);run.status=receipt.status;task.enabled=true;task.status=receipt.status==='complete'&&task.nextRunAt?'scheduled':receipt.status
          if(receipt.status==='complete'&&!receipt.running)run.finishedAt ||= new Date(now()).toISOString()
          report.resumed++;save()
        })
      }catch(error){
        await locked(()=>{const task=find(job.task.id),run=task.lastRun;if(run?.id!==job.run.id||run.restartRecovery?.attemptId!==job.run.restartRecovery.attemptId)return;run.restartRecovery.status='unknown';task.enabled=false;if(!task.manualPause&&!task.archived){task.status='unknown';run.status='unknown'}run.running=false;run.summary='恢复结果未确认，先核对原会话，不自动再次续发';save()});report.unknown++
      }
    }
    return report
  }
  function recoverRestart(context = typeof startupContext === 'function' ? startupContext() : startupContext) {
    if (!restartInFlight) restartInFlight = recoverRestartOnce(context).finally(() => { restartInFlight = null })
    return restartInFlight
  }
  async function tickOnce() {
    if (closing) return
    await recoverRestart()
    await refresh()
    const jobs = await locked(async () => {
      const jobs = []
      for (const task of state.tasks) {
        if (task.enabled && !task.archived && task.lastRun?.status === 'waiting-idle') {
          if (await scheduledReady(task)) { task.lastRun.status = 'claimed'; task.status = 'running'; save(); jobs.push({ task: clone(task), run: clone(task.lastRun) }) }
          continue
        }
        if (!task.enabled || task.archived || active(task.lastRun) || recoverable(task.lastRun) || countActive() >= maxActive) continue
        const occurrence = dueOccurrence(task.schedule, task.nextRunAt, now())
        if (!occurrence) continue
        let ready=true
        const predecessors=state.tasks.filter(previous=>(previous.enabled||['clearing','unknown'].includes(previous.lastRun?.nextOccurrencePreparation?.status))&&!previous.archived&&!previous.manualPause&&previous.lastRun?.periodicSettlement?.status==='blocked-terminal'&&(previous.id===task.id||targetSession(task)&&targetSession(previous)===targetSession(task)))
        for(const previous of predecessors){
          const old=previous.lastRun
          if(old.nextOccurrencePreparation?.status==='ready')continue
          if(typeof adapter.prepareNextOccurrence!=='function'||['clearing','unknown'].includes(old.nextOccurrencePreparation?.status)){ready=false;task.enabled=false;task.status='blocked';task.error='原聊天旧目标清理结果未确认';save();break}
          old.nextOccurrencePreparation={status:'clearing',forTaskId:task.id,occurrence:occurrence.scheduledAt,at:new Date(now()).toISOString()};save()
          try{
            const result=await adapter.prepareNextOccurrence(clone(previous),clone(old))
            if(!result?.ready){old.nextOccurrencePreparation={status:'waiting',reason:result?.reason||'旧目标未清理'};previous.enabled=false;previous.status='blocked';task.enabled=false;task.status='blocked';ready=false;save();break}
            old.nextOccurrencePreparation={status:'ready',forTaskId:task.id,occurrence:occurrence.scheduledAt};task.pendingBlockedContext=clone(old.periodicSettlement.blockedReason);save()
          }catch{old.nextOccurrencePreparation={status:'unknown'};previous.enabled=false;previous.status='blocked';task.enabled=false;task.status='blocked';ready=false;save();break}
        }
        if(!ready)continue
        if (!await scheduledReady(task)) { if (task.enabled && task.status !== 'waiting-idle') { task.status = 'waiting-idle'; save() }; continue }
        task.nextRunAt = occurrence.nextRunAt
        jobs.push(claim(task, occurrence.scheduledAt))
      }
      return jobs
    })
    jobs.forEach(kick)
  }
  function tick() {
    if (!tickInFlight) tickInFlight = tickOnce().finally(() => { tickInFlight = null })
    return tickInFlight
  }
  async function mutate(request) {
    if (closing) fail('任务服务正在关闭', 503)
    const { action, id, task: input, requestId } = request || {}
    if (!['create', 'update', 'pause', 'resume', 'run', 'archive'].includes(action)) fail('不支持的任务操作')
    if (requestId !== undefined && !uuid(requestId)) fail('无效的操作编号')
    const digest = crypto.createHash('sha256').update(JSON.stringify({ action, id, task: input })).digest('hex')
    let job
    const result = await locked(async () => {
      const oldRequest = requestId && state.requests.find(r => r.id === requestId)
      if (oldRequest) { if (oldRequest.digest !== digest) fail('同一操作编号内容不一致', 409); return clone(oldRequest.result || find(oldRequest.taskId)) }
      let task
      if (action === 'create') {
        if (state.tasks.length >= maxTasks) fail('任务数量已满，请复用已有任务', 507)
        const definition = validate(input)
        const context = await adapter.validate(definition)
        task = { ...definition, context, id: crypto.randomUUID(), revision: 1, enabled: true, archived: false, status: definition.schedule.kind === 'manual' ? 'idle' : 'scheduled', nextRunAt: nextRun(definition.schedule, now()), lastRun: null, runs: [], createdAt: new Date(now()).toISOString(), updatedAt: new Date(now()).toISOString() }
        state.tasks.push(task)
      } else {
        if (!uuid(id)) fail('无效的任务编号')
        task = find(id)
        if (input?.revision !== undefined && input.revision !== task.revision) fail('任务已被其他页面修改，请刷新', 409)
        if (action === 'update') {
          if (active(task.lastRun)) fail('先暂停当前任务再修改', 409)
          const definition = validate(input, task), context = await adapter.validate(definition)
          const scheduleChanged = JSON.stringify(definition.schedule) !== JSON.stringify(task.schedule)
          if (definition.workspaceId !== task.workspaceId || definition.sourceSessionId !== task.sourceSessionId) delete task.executionSessionId
          Object.assign(task, definition, { context }); if (scheduleChanged) task.nextRunAt = nextRun(task.schedule, now())
        } else if (action === 'run') {
          if (task.archived) fail('先恢复已归档任务', 409)
          if (!await canStart(task)) fail('原聊天正在执行或已有未完成目标，请稍后再运行', 409)
          task.enabled = true; job = claim(task, 'manual:' + crypto.randomUUID())
        } else if (action === 'pause' || (action === 'archive' && input?.archived !== false)) {
          task.enabled = false; task.archived = action === 'archive' || task.archived; task.manualPause = true
          save() // Persist manual intent before an asynchronous pause can race a crash.
          if (task.lastRun && !['complete'].includes(task.lastRun.status)) {
            const unknown = task.lastRun.status === 'unknown' || task.lastRun.stage === 'dispatching' || ['unknown','dispatching'].includes(task.lastRun.restartRecovery?.status)
            if (!unknown && task.lastRun.stage === 'accepted') await adapter.pause(clone(task), clone(task.lastRun))
            if (action === 'archive' && typeof adapter.archive === 'function') {
              const receipt = await adapter.archive(clone(task), clone(task.lastRun))
              if (!unknown && receipt?.running === false) { task.lastRun.running=false; task.lastRun.archiveCleanup={goalCleared:receipt.goalCleared===true,checkedAt:new Date(now()).toISOString(),...(receipt.clearedGoal?{clearedGoal:receipt.clearedGoal}:{})} }
            }
            if (!unknown) task.lastRun.status = 'paused'
          }
          task.status = task.archived ? 'archived' : 'paused'
        } else if (action === 'archive') {
          task.archived = false; task.enabled = false; task.status = 'paused'
        } else if (action === 'resume') {
          if (task.archived) fail('先恢复已归档任务', 409)
          if (countActive() >= maxActive && !active(task.lastRun)) fail('自动任务并行数已满', 409)
          if (recoverable(task.lastRun)) {
            if (task.lastRun.stage === 'claimed' || task.lastRun.stage === 'prepare-failed') {
              task.lastRun.status = 'claimed'; task.enabled = true; job = { task: clone(task), run: clone(task.lastRun) }
            } else {
              const receipt = await adapter.resume(clone(task), clone(task.lastRun))
              task.lastRun.goal = receipt?.goal || task.lastRun.goal; task.lastRun.status = 'running'; task.lastRun.stage = 'accepted'; task.lastRun.running = receipt?.running !== false
            }
          }
          task.manualPause = false; if(task.lastRun){delete task.lastRun.restartCandidate;delete task.lastRun.restartRecovery}
          task.enabled = true; task.status = active(task.lastRun) ? 'running' : 'scheduled'
          if (!task.nextRunAt && task.schedule.kind !== 'manual') task.nextRunAt = nextRun(task.schedule, now())
        }
        task.revision++; task.updatedAt = new Date(now()).toISOString()
      }
      if (requestId) {
        state.requests = [...state.requests, { id: requestId, digest, taskId: task.id, result: clone(task) }].slice(-64)
        while (state.requests.length > 1 && Buffer.byteLength(JSON.stringify(state.requests)) > 1024 * 1024) state.requests.shift()
      }
      save(); return clone(task)
    })
    if (job) kick(job)
    return result
  }
  return {
    apiVersion: 5,
    mutate, tick, recoverRestart,
    async list(id) { await refresh(); return clone(id ? [find(id)] : state.tasks) },
    start() { if (!timer && !closing) { timer = setInterval(() => void tick().catch(() => {}), 1000); timer.unref?.() } },
    async drain() { await Promise.allSettled([...launches]); await chain },
    async close() {
      closing = true; clearInterval(timer); timer = null
      await Promise.allSettled([...launches, ...(restartInFlight ? [restartInFlight] : [])])
      await locked(async () => {
        for (const task of state.tasks) if (active(task.lastRun) && !task.manualPause && !task.archived && task.status !== 'paused') {
          snapshotRestart(task, 'close')
          await adapter.disarm?.(clone(task), clone(task.lastRun))
          task.enabled = false; task.status = 'interrupted'; task.lastRun.status = 'interrupted'; task.lastRun.running = false
        }
        save()
      })
    }
  }
}
