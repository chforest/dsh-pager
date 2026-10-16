import { test } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createMobile } from '../server.js'

test('permission API uses native commands, validates targets and confirmation, and reads back actual state', async () => {
  let current = 'workspace-write', failure = false, calls = []
  const selection = () => ({ currentValue: current, options: ['read-only', 'workspace-write', 'danger-full-access'].map(value => ({ value, name: value })) })
  const upstream = http.createServer(async (req, res) => {
    let raw = ''; for await (const part of req) raw += part
    const body = JSON.parse(raw); calls.push(body)
    let result
    if (body.method === 'session.list') result = { ok: true, value: { items: [{ sessionId: 's1', projections: { values: { permissions: selection() } } }] } }
    else if (body.method === 'commands/execute') {
      assert.deepEqual(Object.keys(body.payload), ['args'])
      assert.equal(body.payload.args.agentId, 's1')
      assert.deepEqual(body.payload.args.images, [])
      if (!failure) current = body.payload.args.line.slice('/permission '.length)
      result = { ok: true, value: { commandId: 'cmd-1', result: failure ? { kind: 'error', text: 'host refused' } : { kind: 'success' } } }
    } else result = { ok: false, error: { message: 'unexpected call' } }
    res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ type: 'server-response', rpcId: body.rpcId, result }))
  })
  await new Promise(r => upstream.listen(0, '127.0.0.1', r))
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pager-permission-'))
  const mobile = createMobile({ apiPort: () => upstream.address().port, pushDir: dir })
  const server = http.createServer(mobile.handle)
  await new Promise(r => server.listen(0, '127.0.0.1', r))
  const call = async (method, payload = {}, extra = {}) => {
    const r = await fetch(`http://127.0.0.1:${server.address().port}/m/api/rpc`, { method: 'POST', headers: { 'content-type': 'application/json', ...extra }, body: JSON.stringify({ method, payload }) })
    return { status: r.status, body: await r.json() }
  }
  try {
    assert.equal((await call('session.permissions', { sessionId: 's1' })).body.value.currentValue, current)
    for (const payload of [{ sessionId: 's1', preset: 'custom' }, { sessionId: 's1', preset: 'read-only\n/clear' }, { sessionId: 's1', preset: 'danger-full-access' }, { sessionId: 'missing', preset: 'read-only' }]) {
      const result = await call('session.selectPermission', payload)
      assert.ok(result.status >= 400)
    }
    assert.equal(calls.filter(c => c.method === 'commands/execute').length, 0)
    assert.equal((await call('session.selectPermission', { sessionId: 's1', preset: 'read-only' })).body.value.currentValue, 'read-only')
    assert.equal((await call('session.selectPermission', { sessionId: 's1', preset: 'danger-full-access', confirmFullAccess: true })).body.value.currentValue, 'danger-full-access')
    const count = calls.length
    assert.equal((await call('host.openPath', { path: 'D:\\' })).status, 400)
    assert.equal(calls.length, count, 'native folder API never enters phone whitelist')
    failure = true
    const rejected = await call('session.selectPermission', { sessionId: 's1', preset: 'workspace-write' })
    assert.equal(rejected.status, 409)
    assert.match(rejected.body.error.message, /host refused/)
    assert.equal(current, 'danger-full-access')
    assert.ok(calls.every(c => c.method !== 'session.prompt'), 'no model call or message is sent')
    const forbidden = await fetch(`http://127.0.0.1:${server.address().port}/m/api/rpc`, { method: 'POST', headers: { 'content-type': 'application/json', origin: 'https://evil.example' }, body: JSON.stringify({ method: 'session.selectPermission', payload: { sessionId: 's1', preset: 'read-only' } }) })
    assert.equal(forbidden.status, 403)
  } finally {
    mobile.close(); await Promise.all([new Promise(r => server.close(r)), new Promise(r => upstream.close(r))]); fs.rmSync(dir, { recursive: true, force: true })
  }
})
