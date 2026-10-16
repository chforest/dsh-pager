import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import crypto from 'node:crypto'
import http from 'node:http'
import { createRemoteFolders } from '../remote-folders.js'
import { createMobile } from '../server.js'

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'remote-folder-'))
  for (const name of ['中文 空格', '另一个', '.dsh', '.ssh', '.aws', 'secrets']) fs.mkdirSync(path.join(dir, name))
  fs.writeFileSync(path.join(dir, '不应读取.txt'), 'private fixture content')
  fs.symlinkSync(path.join(dir, '中文 空格'), path.join(dir, '安全入口'), 'junction')
  fs.symlinkSync(path.join(dir, '.dsh'), path.join(dir, '敏感入口'), 'junction')
  const workspaces = [], calls = []
  const rpc = async (method, payload) => {
    calls.push({ method, payload })
    if (method === 'workspace.list') return { items: workspaces }
    if (method === 'workspace.create') {
      const w = { workspaceId: 'w-' + workspaces.length, title: path.basename(payload.path), path: payload.path, sessionIds: [] }
      workspaces.push(w); return { workspace: w, created: true }
    }
    throw Error('unexpected RPC')
  }
  const options = { rpc, driveCandidates: [dir], localDrive: async root => root[0].toUpperCase() !== 'Z' }
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  return { dir, rpc, calls, workspaces, options }
}
test('folder root is a bounded directory-only picker; private names and junction targets stay hidden', async t => {
  const f = fixture(t), folders = createRemoteFolders(f.options)
  const root = await folders.list()
  assert.equal(root.path, null); assert.deepEqual(root.entries, []); assert.equal(root.roots.length, 1)
  assert.equal(f.calls.some(c => c.method !== 'workspace.list'), false)
  const level = await folders.list(f.dir)
  assert.deepEqual(level.entries.map(e => e.name).sort(), ['中文 空格', '另一个', '安全入口'].sort())
  assert.equal(level.entries.find(e => e.name === '安全入口').path, await fs.promises.realpath(path.join(f.dir, '中文 空格')))
  assert.equal(level.parent, path.dirname(level.path))
  assert.equal((await createRemoteFolders({ ...f.options, maxEntries: 1 }).list(f.dir)).truncated, true)
  for (const p of ['\\server\share', '\\?\C:\Windows', 'C:relative', 'C:\name:stream', 'C:\null\0path', path.join(f.dir, '.dsh'), path.join(f.dir, '敏感入口'), path.join(f.dir, '不应读取.txt'), 'Z:\network']) await assert.rejects(folders.safeDirectory(p))
})
test('network junction is rejected before following its target', async t => {
  const f = fixture(t), folders = createRemoteFolders(f.options), nativeReadlink = fs.promises.readlink
  fs.promises.readlink = async p => path.basename(p) === '安全入口' ? '\\server\private-share' : nativeReadlink(p)
  try { await assert.rejects(folders.safeDirectory(path.join(f.dir, '安全入口')), { status: 403 }) }
  finally { fs.promises.readlink = nativeReadlink }
})
test('workspace confirmation is serial and canonical-idempotent, with no sessions or model requests', async t => {
  const f = fixture(t), folders = createRemoteFolders(f.options), requestId = crypto.randomUUID(), selected = path.join(f.dir, '中文 空格')
  const first = await folders.add({ path: selected, requestId })
  assert.equal(first.created, true); assert.equal(first.workspace.id, first.workspace.workspaceId)
  assert.deepEqual(await folders.add({ path: selected, requestId }), first)
  const alias = await folders.add({ path: path.join(f.dir, '安全入口') }); assert.equal(alias.created, false); assert.equal(alias.workspace.id, first.workspace.id)
  await assert.rejects(folders.add({ path: path.join(f.dir, '另一个'), requestId }), { status: 409 })
  const second = path.join(f.dir, '另一个')
  const both = await Promise.all([folders.add({ path: second }), folders.add({ path: second })])
  assert.equal(both[0].workspace.id, both[1].workspace.id)
  assert.equal(f.calls.filter(c => c.method === 'workspace.create').length, 2)
  assert.equal((await folders.list()).workspaces.length, 2)
  assert.ok(f.calls.every(c => ['workspace.list', 'workspace.create'].includes(c.method)))
})
test('unknown registration does not replay; native list can later reconcile it', async t => {
  const f = fixture(t); let writes = 0
  const folders = createRemoteFolders({ ...f.options, rpc: async (method, payload) => { if (method === 'workspace.create') { writes++; throw Error('lost receipt') }; return f.rpc(method, payload) } })
  const input = { path: path.join(f.dir, '中文 空格'), requestId: crypto.randomUUID() }
  await assert.rejects(folders.add(input), { status: 409 }); await assert.rejects(folders.add(input), { status: 409 }); assert.equal(writes, 1)
  await assert.rejects(folders.add({ ...input, requestId: crypto.randomUUID() }), { status: 409, code: 'outcome_unknown' }); assert.equal(writes, 1)
  f.workspaces.push({ workspaceId: 'late-id', title: 'late', path: input.path })
  const reconciled = await folders.add(input); assert.equal(reconciled.workspace.id, 'late-id'); assert.equal(writes, 1)
})
test('drive enumeration timeout keeps last success and first failure is explicit and retryable', async t => {
  const f = fixture(t); let clock = 0, calls = 0, broken = false
  const exec = (_exe, _args, _options, callback) => { calls++; queueMicrotask(() => callback(broken ? Error('timeout') : null, broken ? '' : f.dir[0] + ':3\n')) }
  f.workspaces.push({ workspaceId: 'existing', title: 'fixture', path: path.join(f.dir, '中文 空格') })
  const folders = createRemoteFolders({ rpc: f.rpc, driveCandidates: [f.dir], execFileImpl: exec, now: () => clock })
  const first = await folders.list(); assert.equal(first.roots.length, 1); assert.equal(first.workspaces.length, 1)
  clock = 31000; broken = true
  const retained = await folders.list(); assert.equal(retained.roots.length, 1); assert.equal(retained.workspaces.length, 1); assert.equal(calls, 2)
  const newInstance = createRemoteFolders({ rpc: f.rpc, driveCandidates: [f.dir], execFileImpl: exec, now: () => clock })
  await assert.rejects(newInstance.list(), { status: 503, code: 'folders' })
  broken = false
  const recovered = await newInstance.list(); assert.equal(recovered.roots.length, 1); assert.equal(recovered.workspaces.length, 1)
})
test('real folders HTTP endpoints retain trust and do not expose workspace.create via generic RPC', async t => {
  const f = fixture(t)
  const upstream = http.createServer(async (req, res) => {
    if (req.method !== 'POST') { res.writeHead(404); res.end(); return }
    let raw = ''; for await (const chunk of req) raw += chunk
    const b = JSON.parse(raw), value = await f.rpc(b.method, b.payload)
    res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ type: 'server-response', rpcId: b.rpcId, result: { ok: true, value } }))
  })
  await new Promise(r => upstream.listen(0, '127.0.0.1', r))
  const app = createMobile({ apiPort: () => upstream.address().port, pushDir: path.join(f.dir, 'private-data'), remoteFolderOptions: { driveCandidates: [f.dir], localDrive: f.options.localDrive } })
  const server = http.createServer(app.handle); await new Promise(r => server.listen(0, '127.0.0.1', r))
  const base = `http://127.0.0.1:${server.address().port}/m/api/`
  try {
    const first = await fetch(base + 'folders'); assert.equal(first.status, 200); assert.equal((await first.json()).value.path, null)
    assert.equal((await fetch(base + 'folders', { headers: { origin: 'https://evil.example' } })).status, 403)
    assert.equal((await fetch(base + 'folders?path=' + encodeURIComponent('\\server\share'))).status, 400)
    const r = await fetch(base + 'folders/workspace', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path: path.join(f.dir, '中文 空格'), requestId: crypto.randomUUID() }) })
    assert.equal(r.status, 200); assert.equal((await r.json()).value.workspace.workspaceId, 'w-0')
    const denied = await fetch(base + 'rpc', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ method: 'workspace.create', payload: { path: f.dir } }) })
    assert.equal(denied.status, 400)
  } finally { app.close(); server.closeAllConnections(); upstream.closeAllConnections(); await Promise.all([new Promise(r => server.close(r)), new Promise(r => upstream.close(r))]) }
})
