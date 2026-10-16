import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { createAsyncQuestions } from '../async-questions.js'

const input = (extra = {}) => ({ sessionId: 'session-a', question: '需要哪种格式？', options: ['横屏', '竖屏'], independentWork: '先检查源文件', kind: 'clarification', waitMs: 1000, ...extra })
function setup(t, extra = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'async-question-'))
  const store = createAsyncQuestions({ dir, ...extra })
  t.after(() => { store.close(); fs.rmSync(dir, { recursive: true, force: true }) })
  return { store, dir }
}
test('active waiter receives one answer without late prompt and creation is idempotent', async t => {
  let calls = 0
  const { store } = setup(t, { deliver: async () => { calls++; return { status: 'accepted' } } })
  const request = input({ requestId: crypto.randomUUID() }), record = store.create(request)
  assert.deepEqual(store.create(request), record)
  assert.ok(Number.isFinite(Date.parse(record.deadline))); assert.equal(record.status, 'waiting')
  assert.throws(() => store.create({ ...request, question: '不同' }), { status: 409 })
  const waiting = store.wait(record.id), answerId = crypto.randomUUID()
  const result = await store.answer(record.sessionId, record.id, { answer: '横屏', answerId })
  assert.equal(result.delivery, 'not-needed')
  assert.equal((await waiting).answer, '横屏'); assert.equal(calls, 0)
  assert.deepEqual(await store.answer(record.sessionId, record.id, { answer: '横屏', answerId }), result)
})
test('timeout is deferred not agreement, retained and answered later exactly once', async t => {
  let calls = 0
  const { store, dir } = setup(t, { deliver: async record => {
    calls++; assert.equal(JSON.parse(fs.readFileSync(path.join(dir, record.id + '.json'))).delivery, 'pending')
    return { status: 'accepted' }
  } })
  const r = store.create(input({ waitMs: 5 })), outcome = await store.wait(r.id)
  assert.equal(outcome.status, 'deferred'); assert.equal(outcome.answered, false); assert.match(outcome.message, /不是同意/)
  assert.equal((await store.list(r.sessionId))[0].status, 'deferred')
  const answer = { answer: '竖屏', answerId: crypto.randomUUID() }
  const saved = await store.answer(r.sessionId, r.id, answer)
  assert.equal(saved.delivery, 'accepted'); await store.answer(r.sessionId, r.id, answer); assert.equal(calls, 1)
  const repeatWait = await store.wait(r.id)
  assert.equal(repeatWait.status, 'already-delivered'); assert.equal(repeatWait.answered, false)
})
test('absent waiter and concurrent answer retries use one persisted delivery', async t => {
  let complete, calls = 0
  const { store } = setup(t, { deliver: () => { calls++; return new Promise(resolve => { complete = resolve }) } })
  const r = store.create(input()), answer = { answer: '自由填写也允许', answerId: crypto.randomUUID() }
  const first = store.answer(r.sessionId, r.id, answer)
  await Promise.resolve()
  const second = await store.answer(r.sessionId, r.id, answer)
  assert.equal(second.delivery, 'pending'); assert.equal(calls, 1)
  assert.equal((await store.wait(r.id)).status, 'already-delivered')
  complete({ status: 'accepted' }); assert.equal((await first).delivery, 'accepted')
  await assert.rejects(store.answer(r.sessionId, r.id, { answer: '别的', answerId: answer.answerId }), { status: 409 })
  await assert.rejects(store.answer('session-other', r.id, answer), { status: 403 })
})
test('deadline race and cancellation do not double deliver or erase the question', async t => {
  let time = 1000, calls = 0
  const { store } = setup(t, { now: () => time, deliver: async () => { calls++; return { status: 'accepted' } } })
  const r = store.create(input({ waitMs: 100 })), waiting = store.wait(r.id)
  time = 1100
  await store.answer(r.sessionId, r.id, { answer: '迟到', answerId: crypto.randomUUID() })
  assert.equal((await waiting).status, 'deferred'); assert.equal(calls, 1)
  const next = store.create(input()), controller = new AbortController(), cancelled = store.wait(next.id, { signal: controller.signal })
  controller.abort(); await assert.rejects(cancelled, { name: 'AbortError' })
  assert.equal((await store.list(next.sessionId)).find(x => x.id === next.id).status, 'deferred')
  const last = store.create(input()), closing = store.wait(last.id)
  store.close(); await assert.rejects(closing, { name: 'AbortError' })
})
test('unknown transport and restart retain answers without automatic replay', async t => {
  let calls = 0
  const { store, dir } = setup(t, { deliveryTimeoutMs: 5, deliver: () => { calls++; return new Promise(() => {}) } })
  const r = store.create(input()), answer = { answer: '回答', answerId: crypto.randomUUID() }
  const result = await store.answer(r.sessionId, r.id, answer); assert.equal(result.delivery, 'unknown')
  store.close()
  const reopened = createAsyncQuestions({ dir, deliver: async () => { calls++; return { status: 'accepted' } } })
  assert.equal((await reopened.answer(r.sessionId, r.id, answer)).delivery, 'unknown'); assert.equal(calls, 1)
  reopened.close()
  // Simulate crash after write-before-delivery, before its final receipt.
  const file = path.join(dir, r.id + '.json'), raw = JSON.parse(fs.readFileSync(file))
  raw.delivery = 'pending'; fs.writeFileSync(file, JSON.stringify(raw))
  const crashed = createAsyncQuestions({ dir, deliver: async () => { calls++; return { status: 'accepted' } } })
  assert.equal((await crashed.answer(r.sessionId, r.id, answer)).delivery, 'unknown'); assert.equal(calls, 1); crashed.close()
})
test('scope and input bounds reject approvals, unsafe ids and blank answers without deleting pending records', async t => {
  const { store } = setup(t, { maxRecords: 1 })
  for (const change of [{ kind: 'approval' }, { sessionId: '../escape' }, { question: '' }, { options: [null] }, { waitMs: -1 }, { requestId: 'not-uuid' }]) assert.throws(() => store.create(input(change)), { status: 400 })
  const r = store.create(input())
  assert.throws(() => store.create(input()), { status: 507 })
  await assert.rejects(store.answer(r.sessionId, r.id, { answer: '', answerId: crypto.randomUUID() }), { status: 400 })
  assert.equal((await store.list(r.sessionId)).length, 1)
  assert.deepEqual(await store.list('different'), [])
})
