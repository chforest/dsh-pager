import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { createNativeAdapter, createTasksHandler, goalObjective } from './index.js'

test('native adapter prepares owned session/model/permissions/durability before native goal; pause and bounded resume use CAS', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'native-task-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const agents = new Map(), goals = new Map(), calls = []
  const ctx = {
    agents: { get: id => agents.get(id) },
    permissionPresets: { names: ['read-only', 'workspace-write', 'danger-full-access'], resolve: name => { assert.ok(['read-only', 'workspace-write', 'danger-full-access'].includes(name)); return {} }, optionOf: name => ({ name }), current: events => events.at(-1)?.preset, set: (session, name) => { calls.push('permissions:' + name); session.events.push({ preset: name }) } },
    sessions: { flush: async () => { calls.push('flush'); return true } },
    goals: {
      get: agent => goals.get(agent.id),
      create: (agent, args) => { calls.push('goal-create'); const g = { id: 'g', revision: 1, phase: 'active', activation: 'armed', roundsStarted: 0, ...args }; goals.set(agent.id, g); return g },
      pause: (agent, ref) => { assert.equal(ref.revision, goals.get(agent.id).revision); calls.push('goal-pause'); Object.assign(goals.get(agent.id), { phase: 'paused', activation: 'disarmed', revision: ref.revision + 1 }) },
      edit: (agent, ref, fields) => { assert.equal(ref.revision, goals.get(agent.id).revision); const g = { ...goals.get(agent.id), ...fields, revision: ref.revision + 1 }; goals.set(agent.id, g); return g },
      resume: (agent, ref) => { assert.equal(ref.revision, goals.get(agent.id).revision); calls.push('goal-resume'); Object.assign(goals.get(agent.id), { phase: 'active', activation: 'armed', revision: ref.revision + 1 }); return goals.get(agent.id) },
      disarm: agent => { calls.push('disarm'); goals.get(agent.id).activation = 'disarmed' }
    }
  }
  const rpc = async (method, payload) => {
    calls.push(method)
    if (method === 'workspace.list') return { items: [{ workspaceId: 'w', path: dir, title: '测试工作区', sessionIds: ['source'] }] }
    if (method === 'session.list') return { items: [{ sessionId: 'source', agentPreset: 'preset-a' }] }
    if (method === 'session.models') return { current: { provider: 'fixture', model: 'unchanged', reasoningEffort: 'high' } }
    if (method === 'session.create') {
      assert.equal(payload.agentPreset, 'preset-a')
      if (!agents.has(payload.sessionId)) agents.set(payload.sessionId, { id: payload.sessionId, status: 'idle', session: { header: { cwd: dir }, events: [], append(type,data) { const event={seq:this.events.length+1,type,data};this.events.push(event);return event } }, followup: message => calls.push(message), cancel: () => calls.push('cancel-owned') })
      return { sessionId: payload.sessionId }
    }
    if (method === 'session.selectModel') { assert.deepEqual(payload, { sessionId: 'run-session', provider: 'fixture', model: 'unchanged', reasoningEffort: 'high' }); return { selected: payload } }
    if (method === 'session.rename') { assert.equal(payload.sessionId, 'run-session'); assert.match(payload.title, /^自动任务 · /); return { title: payload.title } }
    throw Error('Unexpected ' + method)
  }
  const adapter = createNativeAdapter(ctx, { rpc, createUserMessage: value => ({ id: 'message-id', role: 'user', ...value }) })
  const task = { id: 'task', title: '测试', objective: '目标', workspaceId: 'w', sourceSessionId: 'source', permissionPreset: 'workspace-write', maxGoalRounds: 8, continuous: true }
  task.context = await adapter.validate(task)
  const run = { id: 'run', sessionId: 'run-session', sourceTag: 'dsh-tasks/run' }
  await adapter.prepare(task, run); assert.equal(calls.at(-1), 'flush'); assert.equal(calls.includes('goal-create'), false)
  const receipt = await adapter.dispatch(task, run); run.goal = receipt.goal
  assert.ok(receipt.goal.objective.endsWith(goalObjective(task))); assert.equal(task.objective, '目标')
  assert.ok(calls.indexOf('permissions:workspace-write') < calls.indexOf('goal-create'))
  await adapter.pause(task, run); assert.equal(goals.get(run.sessionId).phase, 'paused')
  goals.get(run.sessionId).roundsStarted = 8
  await adapter.resume(task, run); assert.equal(goals.get(run.sessionId).maxGoalRounds, 16)
  const agent = agents.get(run.sessionId)
  agent.session.append('turn/start', {turn:1})
  agent.session.append('user/message', {source:{kind:'goal',goalId:run.goal.id},content:[]})
  agent.session.append('approval/asked', { id: 'approval' })
  assert.equal((await adapter.inspect(task, run)).status, 'waiting-user')
  agent.session.append('approval/decided', { id: 'approval', outcome: 'denied' })
  goals.get(run.sessionId).phase = 'complete'
  agent.status = 'running'
  assert.equal((await adapter.inspect(task, run)).status, 'running', 'goal completion waits for final closing turn')
  agent.session.append('assistant/message', { message: { role: 'assistant', content: [{ type: 'text', text: '已完成且已验证' }] } })
  agent.session.append('turn/end', {turn:1,reason:{kind:'completed'}})
  agent.status = 'idle'
  const completed = await adapter.inspect(task, run); assert.equal(completed.status, 'complete'); assert.equal(completed.summary, '已完成且已验证')
  const one = { ...task, continuous: false }; const singleRun={...run,id:'single',sourceTag:'dsh-tasks/single',goal:null}; await adapter.dispatch(one, singleRun)
  assert.equal(calls.find(c => typeof c === 'object')?.source?.kind, 'plugin')
  agent.session.append('turn/start', {turn:2})
  agent.session.append('user/message', { message: { role: 'user', source: { kind: 'plugin', plugin: singleRun.sourceTag }, content: [{ type: 'text', text: '单次fixture' }] } })
  agent.session.append('assistant/message', { message: { role: 'assistant', content: [{ type: 'text', text: '单次总结' }] } })
  const end = agent.session.append('turn/end', { turn:2,reason: { kind: 'completed' } })
  const single = await adapter.inspect(one, singleRun); assert.equal(single.status, 'complete'); assert.equal(single.summary, '单次总结')
  end.data.reason.kind = 'aborted'; assert.equal((await adapter.inspect(one, singleRun)).status, 'paused')
  end.data.reason.kind = 'error'; assert.equal((await adapter.inspect(one, singleRun)).status, 'blocked')
  end.data.reason.kind = 'max-tokens'; assert.equal((await adapter.inspect(one, singleRun)).status, 'blocked')
  ctx.sessions.flush = async () => false
  await assert.rejects(adapter.prepare(task, run), /持久化/)
  await assert.rejects(adapter.validate({ ...task, sourceSessionId: 'unrelated' }), { status: 403 })
})

test('real HTTP tasks route enforces same origin, JSON boundary and exposes expected catalog contract', async () => {
  let writes = 0
  const service = { list: async () => [{ id: 'fixture', status: 'idle' }], mutate: async value => { writes++; return { id: 'fixture', title: value.task.title } } }
  const adapter = { catalog: async () => ({ workspaces: [{ workspaceId: 'w', path: 'fixture', title: '测试' }], permissionPresets: [{ name: 'workspace-write', label: '工作区写入' }], defaultPermissionPreset: 'workspace-write' }) }
  const server = http.createServer(createTasksHandler(service, adapter)); await new Promise(r => server.listen(0, '127.0.0.1', r))
  const url = `http://127.0.0.1:${server.address().port}/m/api/tasks`
  try {
    const get = await fetch(url), data = await get.json(); assert.equal(data.ok, true); assert.equal(data.value.tasks.length, 1); assert.equal(data.value.defaultPermissionPreset, 'workspace-write')
    assert.equal(get.headers.get('cache-control'), 'no-store')
    assert.equal((await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', origin: 'https://evil.example' }, body: '{}' })).status, 403)
    assert.equal((await fetch(url, { method: 'POST', body: '{}' })).status, 415)
    assert.equal((await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{' })).status, 400)
    const post = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'create', task: { title: 'fixture' } }) }); assert.equal((await post.json()).value.title, 'fixture'); assert.equal(writes, 1)
    assert.equal((await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ long: 'x'.repeat(70000) }) })).status, 413)
    assert.equal(writes, 1)
  } finally { server.closeAllConnections(); await new Promise(r => server.close(r)) }
})
