import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { createTaskService } from './service.mjs'
import { normalizeSchedule, nextRun, dueOccurrence } from './schedule.mjs'
const BASE = Date.parse('2026-10-13T00:00:00.000Z')
const definition = (schedule = { kind: 'manual' }) => ({ title: '测试任务', objective: '只使用fixture测试', workspaceId: 'w', permissionPreset: 'workspace-write', maxGoalRounds: 8, continuous: true, schedule })
function setup(t, overrides = {}, options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-tasks-')), events = [], views = new Map(); let clock = BASE
  const adapter = { validate: async () => ({ workspacePath: dir, model: null, agentPreset: null }), prepare: async (task, run) => { assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'tasks.json'))).tasks.find(x => x.id === task.id).lastRun.stage, 'claimed'); events.push(['prepare', run.sessionId]) }, dispatch: async (task, run) => { events.push(['dispatch', run.sessionId]); return { goal: { id: 'goal-' + run.id, revision: 1, phase: 'active', maxGoalRounds: 8, roundsStarted: 0, activation: 'armed' } } }, inspect: async (task, run) => views.get(task.id) || { status: 'running', running: true, goal: run.goal }, pause: async (task, run) => events.push(['pause', run.sessionId]), resume: async (task, run) => { events.push(['resume', run.sessionId]); return { goal: { ...run.goal, revision: 2, phase: 'active' } } }, disarm: async (task, run) => events.push(['disarm', run.sessionId]), ...overrides }
  const service = createTaskService({ dir, adapter, now: () => clock, ...options })
  t.after(async () => { await service.close(); fs.rmSync(dir, { recursive: true, force: true }) })
  return { service, dir, events, adapter, views, time: value => { clock = value } }
}
test('schedule dates use China civil days and skip missed intervals instead of backlog', () => {
  const daily = normalizeSchedule({ kind: 'daily', time: '09:00', days: [2], timeZone: 'Asia/Shanghai' }, BASE)
  assert.equal(nextRun(daily, BASE), '2026-10-13T01:00:00.000Z')
  assert.equal(nextRun(daily, Date.parse('2026-10-13T01:00:00Z')), '2026-10-20T01:00:00.000Z')
  assert.deepEqual(dueOccurrence({ kind: 'interval', seconds: 300 }, new Date(BASE + 300000).toISOString(), BASE + 1000000), { scheduledAt: new Date(BASE + 900000).toISOString(), nextRunAt: new Date(BASE + 1200000).toISOString() })
  assert.throws(() => normalizeSchedule({ kind: 'interval', seconds: 1 }, BASE))
  assert.throws(() => normalizeSchedule({ kind: 'once', at: '2026-10-13T08:00:00' }, BASE))
})
test('create and run request ids are persisted idempotently and replay original receipt', async t => {
  const f = setup(t), request = { action: 'create', task: definition(), requestId: crypto.randomUUID() }
  const task = await f.service.mutate(request)
  assert.deepEqual(await f.service.mutate(request), task)
  await assert.rejects(f.service.mutate({ ...request, task: { ...request.task, title: 'different' } }), { status: 409 })
  const run = { action: 'run', id: task.id, requestId: crypto.randomUUID() }, receipt = await f.service.mutate(run)
  await f.service.drain()
  assert.deepEqual(await f.service.mutate(run), receipt)
  assert.equal(f.events.filter(x => x[0] === 'dispatch').length, 1)
  assert.notEqual(receipt.lastRun.sessionId, task.sourceSessionId)
})
test('duplicate scheduler ticks cannot re-enter and concurrency cap excludes a third run', async t => {
  const f = setup(t)
  for (let i = 0; i < 3; i++) await f.service.mutate({ action: 'create', task: definition({ kind: 'interval', seconds: 300 }) })
  f.time(BASE + 1000000); await Promise.all([f.service.tick(), f.service.tick()]); await f.service.drain()
  assert.equal(f.events.filter(x => x[0] === 'dispatch').length, 2)
  const rows = await f.service.list(); assert.equal(rows.filter(x => x.lastRun).length, 2)
  assert.equal(rows.find(x => x.lastRun).lastRun.occurrence, new Date(BASE + 900000).toISOString())
})
test('prepare or permission failure never dispatches and disables further automatic execution', async t => {
  const f = setup(t, { prepare: async () => { throw Error('permission not applied') } })
  const task = await f.service.mutate({ action: 'create', task: definition() })
  await f.service.mutate({ action: 'run', id: task.id }); await f.service.drain()
  const [saved] = await f.service.list(task.id)
  assert.equal(saved.lastRun.stage, 'prepare-failed'); assert.equal(saved.enabled, false)
  assert.equal(f.events.some(x => x[0] === 'dispatch'), false)
})
test('unknown dispatch never auto-replays, even after restart or explicit run retry', async t => {
  const f = setup(t, { dispatch: async () => { throw Error('lost receipt') } })
  const task = await f.service.mutate({ action: 'create', task: definition({ kind: 'interval', seconds: 300 }) })
  f.time(BASE + 300000); await f.service.tick(); await f.service.drain()
  assert.equal((await f.service.list(task.id))[0].status, 'unknown')
  await assert.rejects(f.service.mutate({ action: 'run', id: task.id }), { status: 409 })
  const reopened = createTaskService({ dir: f.dir, adapter: f.adapter, now: () => BASE + 900000 })
  await reopened.tick(); assert.equal((await reopened.list(task.id))[0].lastRun.status, 'interrupted'); await reopened.close()
})
test('unconfirmed dispatch occupies a global slot until explicit reconciliation', async t => {
  const f = setup(t, { dispatch: async () => { throw Error('acceptance uncertain') } }, { maxActive: 1 })
  const first = await f.service.mutate({ action: 'create', task: definition() })
  const second = await f.service.mutate({ action: 'create', task: definition() })
  await f.service.mutate({ action: 'run', id: first.id }); await f.service.drain()
  await assert.rejects(f.service.mutate({ action: 'run', id: second.id }), { status: 409 })
  assert.equal((await f.service.list(first.id))[0].status, 'unknown')
})
test('slow inspect is shared by concurrent ticks and list reads without piling up', async t => {
  let release, inspections = 0
  const f = setup(t, { inspect: () => { inspections++; return new Promise(resolve => { release = resolve }) } })
  const task = await f.service.mutate({ action: 'create', task: definition() })
  await f.service.mutate({ action: 'run', id: task.id }); await f.service.drain()
  const first = f.service.tick(), second = f.service.tick(), listing = f.service.list()
  assert.equal(first, second); assert.equal(inspections, 1)
  release({ status: 'running', running: true }); await Promise.all([first, second, listing])
  assert.equal(inspections, 1)
})
test('changing workspace without an explicit source clears inherited source before strict validation', async t => {
  const checked = []
  const f = setup(t, { validate: async task => {
    checked.push({ workspace: task.workspaceId, source: task.sourceSessionId })
    if (task.workspaceId === 'new' && task.sourceSessionId) throw Object.assign(Error('wrong workspace'), { status: 403 })
    return { workspacePath: 'fixture-' + task.workspaceId, model: null, agentPreset: null }
  } })
  const task = await f.service.mutate({ action: 'create', task: { ...definition(), sourceSessionId: 'old-source' } })
  const changed = await f.service.mutate({ action: 'update', id: task.id, task: { workspaceId: 'new', revision: task.revision } })
  assert.equal(changed.sourceSessionId, null)
  assert.deepEqual(checked.at(-1), { workspace: 'new', source: null })
  await assert.rejects(f.service.mutate({ action: 'update', id: task.id, task: { workspaceId: 'new', sourceSessionId: 'old-source' } }), { status: 403 })
})
test('completion backfill preserves first finish time and never revisits an already complete summary', async t => {
  let inspections = 0
  const f = setup(t, { inspect: async () => { inspections++; return { status: 'complete', running: false, summary: inspections === 1 ? '首次任务结果' : '后来无关对话' } } })
  const task = await f.service.mutate({ action: 'create', task: definition() })
  await f.service.mutate({ action: 'run', id: task.id }); await f.service.drain()
  f.time(BASE + 1000)
  const [complete] = await f.service.list(task.id)
  f.time(BASE + 200000); await f.service.tick()
  const [unchanged] = await f.service.list(task.id)
  assert.equal(unchanged.lastRun.finishedAt, complete.lastRun.finishedAt)
  assert.equal(unchanged.lastRun.summary, '首次任务结果'); assert.equal(inspections, 1)
  // A historical missing summary can be backfilled once, without redating it.
  await f.service.close()
  const file = path.join(f.dir, 'tasks.json'), stored = JSON.parse(fs.readFileSync(file, 'utf8'))
  stored.tasks[0].lastRun.summary = ''; fs.writeFileSync(file, JSON.stringify(stored))
  const reopened = createTaskService({ dir: f.dir, adapter: f.adapter, now: () => BASE + 300000 })
  const [backfilled] = await reopened.list(task.id)
  assert.equal(backfilled.lastRun.finishedAt, complete.lastRun.finishedAt)
  assert.equal(backfilled.lastRun.summary, '后来无关对话')
  await reopened.list(task.id); assert.equal(inspections, 2)
  await reopened.close()
})
test('claim snapshot survives crash as interrupted and requires explicit continuation', async t => {
  let release
  const f = setup(t, { prepare: () => new Promise(resolve => { release = resolve }) })
  const task = await f.service.mutate({ action: 'create', task: definition() })
  await f.service.mutate({ action: 'run', id: task.id })
  const copyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tasks-restart-')); fs.copyFileSync(path.join(f.dir, 'tasks.json'), path.join(copyDir, 'tasks.json'))
  const reopened = createTaskService({ dir: copyDir, adapter: f.adapter, now: () => BASE })
  const [row] = await reopened.list(task.id); assert.equal(row.status, 'interrupted'); assert.equal(row.enabled, false)
  await reopened.tick(); assert.equal(f.events.some(x => x[0] === 'dispatch'), false)
  await reopened.close(); fs.rmSync(copyDir, { recursive: true, force: true }); release(); await f.service.drain()
})
test('pause/resume/archive only address owned run, completion comes from goal snapshot', async t => {
  const f = setup(t), task = await f.service.mutate({ action: 'create', task: definition() })
  await f.service.mutate({ action: 'run', id: task.id }); await f.service.drain()
  const [running] = await f.service.list(task.id)
  await f.service.mutate({ action: 'pause', id: task.id }); assert.deepEqual(f.events.at(-1), ['pause', running.lastRun.sessionId])
  await f.service.mutate({ action: 'resume', id: task.id }); assert.deepEqual(f.events.at(-1), ['resume', running.lastRun.sessionId])
  f.views.set(task.id, { status: 'waiting-user', running: true }); assert.equal((await f.service.list(task.id))[0].status, 'waiting-user')
  f.views.set(task.id, { status: 'complete', running: false, goal: { ...running.lastRun.goal, phase: 'complete' }, summary: 'verified fixture', todos: [{ status: 'completed', content: 'step' }] })
  const [done] = await f.service.list(task.id); assert.equal(done.status, 'complete'); assert.equal(done.lastRun.summary, 'verified fixture')
  await f.service.mutate({ action: 'archive', id: task.id }); assert.equal((await f.service.list(task.id))[0].archived, true)
  await f.service.mutate({ action: 'archive', id: task.id, task: { archived: false } }); assert.equal((await f.service.list(task.id))[0].archived, false)
  await assert.rejects(f.service.mutate({ action: 'update', id: task.id, task: { title: 'stale', revision: 1 } }), { status: 409 })
})

test('scheduled task keeps source conversation and waits for it without consuming occurrence', async t => {
  let ready = false;
  const f = setup(t, { canStart: async () => ready });
  const task = await f.service.mutate({action:'create', task:{...definition({kind:'interval', seconds:300}),sourceSessionId:'session-original'}});
  f.time(BASE+300000); await f.service.tick(); await f.service.drain();
  assert.equal(f.events.length,0);
  assert.equal((await f.service.list(task.id))[0].nextRunAt,new Date(BASE+300000).toISOString());
  ready=true; await f.service.tick(); await f.service.drain();
  const row=(await f.service.list(task.id))[0];
  assert.equal(row.lastRun.sessionId,'session-original');
  assert.equal(row.lastRun.inSourceSession,true);
});

test('two due plans sharing a conversation cannot execute together', async t => {
  const f=setup(t,{canStart:async()=>true});
  for(let i=0;i<2;i++) await f.service.mutate({action:'create',task:{...definition({kind:'interval',seconds:300}),sourceSessionId:'session-original'}});
  f.time(BASE+300000);await f.service.tick();await f.service.drain();
  assert.equal(f.events.filter(e=>e[0]==='dispatch').length,1);
});

test('standalone task creates a conversation once and reuses it on later runs', async t => {
  const f=setup(t);const task=await f.service.mutate({action:'create',task:definition()});
  await f.service.mutate({action:'run',id:task.id});await f.service.drain();
  const first=(await f.service.list(task.id))[0].lastRun;
  assert.equal(first.inSourceSession,false);
  f.views.set(task.id,{status:'complete',running:false,summary:'done'});await f.service.list();
  await f.service.mutate({action:'run',id:task.id});await f.service.drain();
  const second=(await f.service.list(task.id))[0].lastRun;
  assert.equal(second.sessionId,first.sessionId);assert.equal(second.inSourceSession,true);
});

test('busy race before dispatch waits with same run and never marks unknown', async t => {
  let busy=true;
  const f=setup(t,{canStart:async()=>true,prepare:async()=>{if(busy)throw Object.assign(Error('busy'),{code:'SOURCE_BUSY',notDispatched:true});return{eventStartSeq:12}}});
  const task=await f.service.mutate({action:'create',task:{...definition(),sourceSessionId:'session-original'}});
  await f.service.mutate({action:'run',id:task.id});await f.service.drain();
  const first=(await f.service.list(task.id))[0];assert.equal(first.enabled,true);assert.equal(first.lastRun.status,'waiting-idle');
  busy=false;await f.service.tick();await f.service.drain();
  const second=(await f.service.list(task.id))[0];assert.equal(second.lastRun.id,first.lastRun.id);assert.equal(second.lastRun.eventStartSeq,12);assert.equal(f.events.filter(x=>x[0]==='dispatch').length,1);
});

test('unavailable source does not stop an unrelated due task', async t => {
 const f=setup(t,{canStart:async task=>{if(task.sourceSessionId==='missing')throw Error('missing source');return true}});
 for(const sourceSessionId of ['missing','valid'])await f.service.mutate({action:'create',task:{...definition({kind:'interval',seconds:300}),sourceSessionId}});
 f.time(BASE+300000);await f.service.tick();await f.service.drain();
 const rows=await f.service.list();assert.equal(rows.find(t=>t.sourceSessionId==='missing').enabled,false);assert.equal(rows.find(t=>t.sourceSessionId==='valid').lastRun.sessionId,'valid');
});
