import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import http from 'node:http'
import { createMobile } from '../server.js'

test('fs API adds canonical absolute paths for every kind without weakening workspace or secret fences', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fs-absolute-')), workspace = path.join(dir, '中文 工作区')
  fs.mkdirSync(workspace); fs.mkdirSync(path.join(workspace, '子 目录'))
  fs.writeFileSync(path.join(workspace, '说明 文档.txt'), '测试内容')
  fs.writeFileSync(path.join(workspace, '图片 测试.png'), Buffer.from([137, 80, 78, 71]))
  fs.writeFileSync(path.join(workspace, '二进制 文件.bin'), Buffer.from([0, 1, 2, 3]))
  fs.writeFileSync(path.join(workspace, 'password.txt'), 'fixture')
  fs.writeFileSync(path.join(workspace, 'looks-normal.txt'), '-----BEGIN '+'PRIVATE KEY-----\nfixture')
  fs.writeFileSync(path.join(dir, 'outside.txt'), 'outside')
  fs.symlinkSync(path.join(workspace, '子 目录'), path.join(workspace, '目录 别名'), 'junction')
  const calls = []
  const upstream = http.createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk
    const b = JSON.parse(raw); calls.push(b.method)
    const result = b.method === 'workspace.list' ? { ok: true, value: { items: [{ path: workspace, workspaceId: 'w', sessionIds: ['s1'] }] } } : { ok: false, error: { message: 'unexpected request' } }
    res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ type: 'server-response', rpcId: b.rpcId, result }))
  })
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve))
  const app = createMobile({ apiPort: () => upstream.address().port, pushDir: path.join(dir, 'private'), voiceDir: path.join(dir, 'voice'), questionsDir: path.join(dir, 'questions') })
  const server = http.createServer(app.handle); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${server.address().port}/m/api/fs?`
  const get = (p, s = 's1', headers = {}) => fetch(base + new URLSearchParams({ s, path: p }), { headers })
  try {
    for (const [file, kind] of [['.', 'dir'], ['子 目录', 'dir'], ['图片 测试.png', 'media'], ['说明 文档.txt', 'text'], ['二进制 文件.bin', 'binary']]) {
      const response = await get(file), body = await response.json()
      assert.equal(response.status, 200); assert.equal(body.value.kind, kind)
      assert.equal(body.value.absolutePath, await fs.promises.realpath(path.join(workspace, file)))
      assert.equal(typeof body.value.rel, 'string')
      if (kind === 'text') assert.equal(body.value.text, '测试内容')
      if (kind === 'media') assert.equal(body.value.type, 'image/png')
    }
    const alias = await (await get('目录 别名')).json()
    assert.equal(alias.value.absolutePath, await fs.promises.realpath(path.join(workspace, '子 目录')))
    assert.notEqual(alias.value.absolutePath, path.join(workspace, '目录 别名'), 'must return resolved file path, never client spelling')
    for (const p of ['../outside.txt', path.join(dir, 'outside.txt'), 'password.txt', 'looks-normal.txt']) {
      const r = await get(p); assert.equal(r.status, 403); assert.equal('value' in await r.json(), false)
    }
    assert.equal((await get('.', 'missing')).status, 404)
    assert.equal((await get('.', 's1', { origin: 'https://evil.example' })).status, 403)
    assert.ok(calls.every(method => method === 'workspace.list'))
  } finally {
    app.close(); server.closeAllConnections(); upstream.closeAllConnections()
    await Promise.all([new Promise(resolve => server.close(resolve)), new Promise(resolve => upstream.close(resolve))])
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
