import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import http from 'node:http'
import crypto from 'node:crypto'
import { createMobile } from '../server.js'

function wav() {
  const b = Buffer.alloc(48); b.write('RIFF'); b.writeUInt32LE(40, 4); b.write('WAVEfmt ', 8); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22); b.writeUInt32LE(16000, 24); b.writeUInt32LE(32000, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write('data', 36); b.writeUInt32LE(4, 40); return b.toString('base64')
}
test('voice SSE pushes saved metadata only to its session, preserves trust and cleans subscriptions', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'voice-events-')), workspace = path.join(dir, 'workspace')
  fs.mkdirSync(workspace)
  const upstream = http.createServer(async (req, res) => {
    if (req.method !== 'POST') { res.writeHead(404); res.end(); return }
    let raw = ''; for await (const c of req) raw += c
    const b = JSON.parse(raw)
    const result = { ok: true, value: { items: b.method === 'workspace.list' ? [{ workspaceId: 'w', path: workspace, sessionIds: ['a', 'b'] }, { workspaceId: 'bad', path: path.join(dir, 'missing'), sessionIds: ['badroot'] }] : [] } }
    res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ type: 'server-response', rpcId: b.rpcId, result }))
  })
  await new Promise(r => upstream.listen(0, '127.0.0.1', r))
  const app = createMobile({ apiPort: () => upstream.address().port, pushDir: path.join(dir, 'private'), voiceDir: path.join(dir, 'voices'), questionDir: path.join(dir, 'questions') })
  const server = http.createServer(app.handle); await new Promise(r => server.listen(0, '127.0.0.1', r))
  const base = `http://127.0.0.1:${server.address().port}/m/api/voice`, opened = []
  const open = sid => new Promise((resolve, reject) => {
    const request = http.get(base + '/events?s=' + sid, response => {
      const entry = { request, response, data: '', frames: [], waiters: [], closed: false }
      response.setEncoding('utf8')
      response.on('data', chunk => {
        entry.data += chunk
        let at
        while ((at = entry.data.indexOf('\n\n')) >= 0) {
          const frame = entry.data.slice(0, at); entry.data = entry.data.slice(at + 2)
          entry.frames.push(frame); for (const notify of entry.waiters.splice(0)) notify()
        }
      })
      response.on('close', () => { entry.closed = true })
      response.on('error', () => {})
      opened.push(entry); resolve(entry)
    }); request.on('error', reject)
  })
  const message = { s: 'a', id: crypto.randomUUID(), role: 'assistant', text: '完整回复', mime: 'audio/wav', durationMs: 1, audio: wav(), requestId: crypto.randomUUID(), replyTo: crypto.randomUUID(), mode: 'message' }
  const post = data => fetch(base, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(data) })
  const nextFrame = (entry, predicate) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(Error('SSE frame did not arrive promptly')), 1000)
    const check = () => { if (entry.frames.some(predicate)) { clearTimeout(timer); resolve() } else entry.waiters.push(check) }; check()
  })
  try {
    for (const sid of ['badroot', 'missing', '../bad']) assert.ok((await fetch(base + '/events?s=' + sid)).status >= 400)
    assert.equal((await fetch(base + '/events?s=a', { headers: { origin: 'https://evil.example' } })).status, 403)
    assert.equal((await fetch(base + '/events?s=a', { method: 'HEAD' })).status, 405)
    const a = await open('a'), b = await open('b')
    assert.match(a.response.headers['content-type'], /^text\/event-stream/)
    const response = await post(message); assert.equal(response.status, 200)
    await nextFrame(a, f => f.startsWith('event: voice-saved'))
    const payload = JSON.parse(a.frames.find(f => f.startsWith('event: voice-saved')).split('\ndata: ')[1])
    assert.equal(payload.s, 'a'); assert.equal(payload.item.id, message.id); assert.equal(payload.item.text, message.text)
    assert.equal('audio' in payload.item, false); assert.equal('digest' in payload.item, false)
    assert.equal(b.frames.some(f => f.includes('voice-saved')), false)
    const before = a.frames.filter(f => f.includes('voice-saved')).length
    assert.equal((await post({ ...message, text: '冲突' })).status, 409)
    await new Promise(r => setTimeout(r, 25))
    assert.equal(a.frames.filter(f => f.includes('voice-saved')).length, before)
    // Fill all 16 slots, then disconnect and prove the same session can reopen.
    const peers = []; for (let i = 0; i < 15; i++) peers.push(await open('a'))
    assert.equal((await fetch(base + '/events?s=a')).status, 429)
    for (const peer of peers) { peer.request.destroy(); peer.response.destroy() }
    await new Promise(r => setTimeout(r, 50))
    const again = await open('a'); assert.equal(again.response.statusCode, 200)
    app.close()
    await new Promise(r => setTimeout(r, 30))
    assert.ok([a, b, again].every(peer => peer.closed), 'app.close ends all SSE responses and clears their heartbeat timers')
  } finally {
    app.close(); for (const peer of opened) { peer.request.destroy(); peer.response.destroy() }
    server.closeAllConnections(); upstream.closeAllConnections()
    await Promise.all([new Promise(r => server.close(r)), new Promise(r => upstream.close(r))])
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
