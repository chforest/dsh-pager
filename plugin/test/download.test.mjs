import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import http from 'node:http'
import { createMobile } from '../server.js'

test('authenticated raw download serves original bytes and Unicode filename despite preview hint, with HEAD and Range', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-download-')), workspace = path.join(dir, 'workspace')
  fs.mkdirSync(workspace)
  const name = "成片 (原画)'最终.mp4", bytes = Buffer.from('fixture-original-video-bytes'), calls = []
  fs.writeFileSync(path.join(workspace, name), bytes)
  fs.writeFileSync(path.join(dir, 'outside.mp4'), 'outside-workspace')
  fs.writeFileSync(path.join(workspace, 'password.mp4'), 'private-fixture')
  const upstream = http.createServer(async (req, res) => {
    let raw = ''; for await (const part of req) raw += part
    const b = JSON.parse(raw); calls.push(b.method)
    const result = b.method === 'workspace.list' ? { ok: true, value: { items: [{ workspaceId: 'w', path: workspace, sessionIds: ['session-download'] }] } } : { ok: false, error: { message: 'unexpected method' } }
    res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ type: 'server-response', rpcId: b.rpcId, result }))
  })
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve))
  const app = createMobile({ apiPort: () => upstream.address().port, pushDir: path.join(dir, 'push'), previewDir: path.join(dir, 'preview'), ffmpeg: path.join(dir, 'encoder-must-not-run') })
  const server = http.createServer(app.handle)
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${server.address().port}/m/api/raw?`
  const url = (file = name, extra = {}) => base + new URLSearchParams({ s: 'session-download', path: file, download: '1', quality: 'preview', ...extra })
  try {
    const response = await fetch(url())
    assert.equal(response.status, 200)
    const disposition = response.headers.get('content-disposition')
    assert.match(disposition, /^attachment; filename\*=UTF-8''/)
    assert.equal(decodeURIComponent(disposition.split("UTF-8''")[1]), name)
    assert.ok(disposition.includes('%27') && disposition.includes('%28'))
    assert.equal(response.headers.get('content-type'), 'video/mp4')
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytes)
    assert.equal(fs.existsSync(path.join(dir, 'preview')), false, 'download never creates or requests a transcoded preview')
    const head = await fetch(url(), { method: 'HEAD' })
    assert.equal(head.status, 200); assert.equal(head.headers.get('content-length'), String(bytes.length)); assert.equal((await head.arrayBuffer()).byteLength, 0)
    const range = await fetch(url(), { headers: { range: 'bytes=8-15' } })
    assert.equal(range.status, 206); assert.equal(range.headers.get('content-range'), `bytes 8-15/${bytes.length}`)
    assert.deepEqual(Buffer.from(await range.arrayBuffer()), bytes.subarray(8, 16))
    assert.match(range.headers.get('content-disposition'), /^attachment/)
    assert.equal((await fetch(url(), { headers: { range: 'bytes=1000-' } })).status, 416)
    assert.equal((await fetch(url('../outside.mp4'))).status, 403)
    assert.equal((await fetch(url('password.mp4'))).status, 403)
    assert.equal((await fetch(url(), { headers: { origin: 'https://untrusted.example' } })).status, 403)
    assert.equal((await fetch(url(name, { s: 'missing' }))).status, 404)
    const inline = await fetch(url(name, { download: '0', quality: 'original' }))
    assert.match(inline.headers.get('content-disposition'), /^inline/); await inline.arrayBuffer()
    assert.ok(calls.every(method => method === 'workspace.list'))
  } finally {
    app.close(); server.closeAllConnections(); upstream.closeAllConnections()
    await Promise.all([new Promise(resolve => server.close(resolve)), new Promise(resolve => upstream.close(resolve))])
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
