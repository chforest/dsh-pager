import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import http from 'node:http'
import crypto from 'node:crypto'
import { createVoiceStore, MAX_AUDIO } from '../voice-store.js'
import { createMobile, normalizeHtmlNewlines } from '../server.js'

function wav() {
  const b = Buffer.alloc(48); b.write('RIFF'); b.writeUInt32LE(40, 4); b.write('WAVEfmt ', 8); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22); b.writeUInt32LE(16000, 24); b.writeUInt32LE(32000, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write('data', 36); b.writeUInt32LE(4, 40); return b
}
const message = () => ({ s: 'session-test', id: crypto.randomUUID(), role: 'user', text: '你好', mime: 'audio/wav', durationMs: 1000, audio: wav().toString('base64'), requestId: crypto.randomUUID() })
test('immutable audio survives reopen, is isolated by session, rejects id reuse and unsafe input', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'voice-store-'))
  try {
    const store = createVoiceStore({ dir }), m = message(), one = store.put(m)
    assert.equal(store.has(m.s), true)
    assert.equal(store.has('not-created'), false)
    assert.equal(fs.existsSync(path.join(dir, 'not-created')), false)
    assert.deepEqual(store.put(m), one)
    assert.deepEqual(createVoiceStore({ dir }).list(m.s), [one])
    assert.deepEqual(store.audio(m.s, m.id).bytes, wav())
    assert.deepEqual(store.list('other'), [])
    assert.throws(() => store.audio('other', m.id), { status: 404 })
    assert.throws(() => store.put({ ...m, text: '不同内容' }), { status: 409 })
    for (const changed of [{ s: '../escape' }, { id: '../x' }, { mime: 'text/html' }, { audio: Buffer.from('<html>').toString('base64') }, { audio: '!!!!' }, { durationMs: -1 }, { role: 'system' }, { replyTo: '../x' }]) assert.throws(() => store.put({ ...message(), ...changed }))
    assert.throws(() => store.put({ ...message(), audio: 'A'.repeat(MAX_AUDIO * 4 / 3 + 4) }), { status: 413 })
    assert.throws(() => createVoiceStore({ dir, totalLimit: 1 }).put(message()), { status: 507 })
    assert.equal(fs.readdirSync(path.join(dir, m.s)).length, 1)
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})

test('HTTP voice API validates trust and real workspace, persists/replays byte ranges without model calls', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'voice-http-')), calls = [], sessionIds = ['session-test', 'other']
  const upstream = http.createServer(async (req, res) => {
    if (req.method !== 'POST') { res.writeHead(404); res.end(); return }
    let raw = ''; for await (const part of req) raw += part
    const b = JSON.parse(raw); calls.push(b.method)
    const result = b.method === 'workspace.list' ? { ok: true, value: { items: [{ workspaceId: 'w', path: dir, sessionIds }] } } : b.method === 'session.list' ? { ok: true, value: { items: sessionIds.map(sessionId => ({ sessionId, blank: true, running: false, updatedAt: Date.now() })) } } : { ok: false, error: { message: 'unexpected call' } }
    res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ type: 'server-response', rpcId: b.rpcId, result }))
  })
  await new Promise(r => upstream.listen(0, '127.0.0.1', r))
  const mobile = createMobile({ apiPort: () => upstream.address().port, pushDir: path.join(dir, 'push'), voiceDir: path.join(dir, 'voices') })
  const server = http.createServer(mobile.handle); await new Promise(r => server.listen(0, '127.0.0.1', r))
  const base = `http://127.0.0.1:${server.address().port}/m/api/voice`, m = message()
  const post = (body, extra = {}) => fetch(base, { method: 'POST', headers: { 'content-type': 'application/json', ...extra }, body: JSON.stringify(body) })
  try {
    assert.equal((await post(m, { origin: 'https://evil.example' })).status, 403)
    assert.equal((await post({ ...m, s: 'missing' })).status, 404)
    assert.equal((await post({ ...m, s: '../escape' })).status, 400)
    const saved = await (await post(m)).json(); assert.equal(saved.ok, true)
    assert.equal((await post(m)).status, 200)
    assert.equal((await post({ ...m, durationMs: 2000 })).status, 409)
    const listed = await (await fetch(base + '?s=session-test')).json(); assert.equal(listed.value.items.length, 1)
    assert.equal('audio' in listed.value.items[0], false)
    const url = base + `/audio?s=${m.s}&id=${m.id}`
    const full = await fetch(url); assert.equal(full.headers.get('content-type'), 'audio/wav'); assert.deepEqual(Buffer.from(await full.arrayBuffer()), wav())
    const range = await fetch(url, { headers: { range: 'bytes=0-3' } }); assert.equal(range.status, 206); assert.equal(await range.text(), 'RIFF')
    assert.equal((await fetch(url, { headers: { range: 'bytes=100-200' } })).status, 416)
    assert.equal((await fetch(url.replace('session-test', 'other'))).status, 404)
    assert.equal((await fetch(url, { method: 'HEAD' })).headers.get('content-length'), '48')
    const first = { ...message(), role: 'assistant', replyTo: m.id, requestId: m.requestId, text: '你好，' }
    const second = { ...first, id: crypto.randomUUID(), text: '继续说。' }
    await post(first); await post(second)
    const withReply = await (await fetch(base + '?s=session-test')).json()
    const reply = withReply.value.items.find(r => r.role === 'assistant')
    assert.equal(reply.segmentIds.length, 2)
    const grouped = new URL(reply.url, base)
    const joined = Buffer.from(await (await fetch(grouped)).arrayBuffer())
    assert.equal(joined.length, 52); assert.equal(joined.readUInt32LE(40), 8)
    assert.equal(joined.readUInt32LE(4), joined.length - 8)
    const seek = await fetch(grouped, { headers: { range: 'bytes=44-51' } })
    assert.equal(seek.status, 206); assert.equal(seek.headers.get('content-range'), 'bytes 44-51/52')
    assert.deepEqual(Buffer.from(await seek.arrayBuffer()), Buffer.alloc(8))
    await post({ ...first, id: crypto.randomUUID(), text: '新增。' })
    assert.equal((await fetch(grouped)).status, 409, 'old revision cannot silently play a different group')
    const boot = await (await fetch(base.replace('/voice', '/boot'))).json()
    assert.deepEqual(boot.value.sessions.map(s => s.id), ['session-test'], 'saved voice keeps a natively blank chat visible')
    assert.equal(boot.value.blanks.w, 'other', 'only an actually empty chat is reusable')
    const shell = await fetch(base.replace('/api/voice', '/'))
    const html = await shell.text(), script = /<script>([\s\S]*?)<\/script>/.exec(html)[1]
    const browserHash = crypto.createHash('sha256').update(script.replace(/\r\n?/g, '\n')).digest('base64')
    assert.ok(shell.headers.get('content-security-policy').includes(`'sha256-${browserHash}'`), 'served script hash matches HTML parser newline normalization')
    sessionIds.push('just-created')
    assert.equal((await post({ ...message(), s: 'just-created' })).status, 200, 'new sessions are not hidden by the workspace cache')
    sessionIds.splice(sessionIds.indexOf('just-created'), 1)
    assert.equal((await fetch(base + '?s=just-created')).status, 404, 'removed sessions cannot replay stored audio through stale cache')
    assert.ok(calls.every(c => ['workspace.list', 'session.list'].includes(c)), 'no prompt or paid model request')
  } finally {
    mobile.close(); server.closeAllConnections(); upstream.closeAllConnections()
    await Promise.all([new Promise(r => server.close(r)), new Promise(r => upstream.close(r))])
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('CSP normalization treats CRLF and bare CR exactly like the HTML parser', () => {
  const windowsScript = 'const a = 1;\r\nconst b = 2;\rconst c = 3;\n'
  assert.equal(normalizeHtmlNewlines(windowsScript), 'const a = 1;\nconst b = 2;\nconst c = 3;\n')
  const hash = value => crypto.createHash('sha256').update(value).digest('base64')
  assert.equal(hash(normalizeHtmlNewlines(windowsScript)), hash(windowsScript.replace(/\r\n?/g, '\n')))
  assert.notEqual(hash(windowsScript), hash(normalizeHtmlNewlines(windowsScript)))
})

test('assistant aggregation isolates turns and users, preserves originals and rejects incompatible WAV', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'voice-group-'))
  try {
    const store = createVoiceStore({ dir }), user = message(), a = { ...message(), role: 'assistant', replyTo: user.id, requestId: user.requestId, text: '甲', durationMs: 10 }
    store.put(user); store.put(a)
    const b = { ...a, id: crypto.randomUUID(), text: '乙', durationMs: 20 }; store.put(b)
    store.put({ ...a, id: crypto.randomUUID(), requestId: 'different-turn', text: '另一轮' })
    store.put({ ...a, id: crypto.randomUUID(), role: 'user', text: '不能合并用户' })
    const items = store.list(user.s), item = items.find(r => r.segmentIds?.length === 2)
    assert.equal(items.length, 4); assert.equal(item.durationMs, 30)
    assert.equal(item.text, item.segmentIds[0] === a.id ? '甲乙' : '乙甲')
    const original = store.audio(user.s, a.id).bytes
    const merged = store.audio(user.s, item.id, { group: true }).bytes
    assert.deepEqual(original, wav()); assert.equal(merged.readUInt32LE(40), 8)
    assert.equal(merged.readUInt32LE(40) / merged.readUInt32LE(28), 8 / 32000, 'WAV header has actual aggregate duration')
    const incompatible = wav(); incompatible.writeUInt32LE(8000, 24); incompatible.writeUInt32LE(16000, 28)
    store.put({ ...a, id: crypto.randomUUID(), audio: incompatible.toString('base64') })
    assert.throws(() => store.audio(user.s, a.id, { group: true }), { status: 415 })
    assert.deepEqual(store.audio(user.s, a.id).bytes, original, 'originals remain unchanged after grouping failure')
    assert.throws(() => store.audio(user.s, user.id, { group: true }), { status: 400 })
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})

test('optional call metadata preserves legacy digest and isolates message/call groups', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'voice-mode-'))
  try {
    const store = createVoiceStore({ dir }), legacy = message(), saved = store.put(legacy)
    const expected = { id: legacy.id, role: legacy.role, text: legacy.text, mime: legacy.mime, durationMs: legacy.durationMs, requestId: legacy.requestId, replyTo: null, audio: legacy.audio }
    const disk = JSON.parse(fs.readFileSync(path.join(dir, legacy.s, legacy.id + '.json'), 'utf8'))
    assert.equal(disk.digest, crypto.createHash('sha256').update(JSON.stringify(expected)).digest('hex'))
    assert.equal('mode' in disk, false); assert.equal('callId' in disk, false)
    assert.deepEqual(store.put(legacy), saved)
    const base = { ...message(), role: 'assistant', replyTo: legacy.id, requestId: legacy.requestId }
    const call = { ...base, mode: 'call', callId: crypto.randomUUID(), callStartedAt: '2026-10-12T12:34:56.000Z' }
    store.put(call); store.put({ ...call, id: crypto.randomUUID() })
    store.put({ ...base, id: crypto.randomUUID(), mode: 'message' })
    store.put({ ...call, id: crypto.randomUUID(), callId: crypto.randomUUID() })
    store.put({ ...call, id: crypto.randomUUID(), callStartedAt: '2026-10-12T12:35:56.000Z' })
    const rows = store.list(legacy.s), group = rows.find(r => r.segmentIds?.length === 2)
    assert.equal(rows.length, 5); assert.equal(group.mode, 'call'); assert.equal(group.callId, call.callId); assert.equal(group.callStartedAt, call.callStartedAt)
    assert.equal(store.audio(legacy.s, group.id, { group: true }).bytes.readUInt32LE(40), 8)
    assert.equal(store.put({ ...message(), mode: 'call' }).mode, 'call')
    for (const extra of [{ mode: 'other' }, { mode: null }, { mode: 'message', callId: call.callId }, { callId: call.callId }, { mode: 'call', callId: call.callId }, { mode: 'call', callStartedAt: call.callStartedAt }, { mode: 'call', callId: call.callId, callStartedAt: '2026-02-30T00:00:00.000Z' }, { mode: 'call', callId: '../bad', callStartedAt: call.callStartedAt }]) assert.throws(() => store.put({ ...message(), ...extra }), { status: 400 })
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})

test('multi-megabyte base64 uses bounded linear validation and preserves original bytes', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'voice-large-'))
  try {
    const store = createVoiceStore({ dir }), m = message(), bytes = Buffer.concat([wav(), Buffer.alloc(2 * 1024 * 1024)])
    bytes.writeUInt32LE(bytes.length - 8, 4); bytes.writeUInt32LE(bytes.length - 44, 40)
    store.put({ ...m, audio: bytes.toString('base64') })
    assert.deepEqual(store.audio(m.s, m.id).bytes, bytes)
    assert.throws(() => store.put({ ...message(), audio: bytes.toString('base64').slice(0, -4) + '====' }), { status: 400 })
    assert.throws(() => createVoiceStore({ dir, itemLimit: 1 }).put(message()), { status: 507 })
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})
