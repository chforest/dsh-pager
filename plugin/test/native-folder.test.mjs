import { test } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import vm from 'node:vm'
import { createMobile } from '../server.js'

test('desktop picker adds only OS-selected directories; cancellation, double tap, errors and remote requests are contained', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pager-native-'))
  let choose = async () => dir, picks = 0, calls = []
  const upstream = http.createServer(async (req, res) => {
    let raw = ''; for await (const data of req) raw += data
    const body = JSON.parse(raw); calls.push(body)
    assert.equal(body.method, 'workspace.create')
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify({ type: 'server-response', rpcId: body.rpcId, result: { ok: true, value: { created: true, workspace: { workspaceId: 'w1', path: body.payload.path, title: 'test' } } } }))
  })
  await new Promise(r => upstream.listen(0, '127.0.0.1', r))
  const mobile = createMobile({ apiPort: () => upstream.address().port, pushDir: dir, trustedHosts: ['pc.example'], pickDirectory: signal => { picks++; return choose(signal) } })
  const server = http.createServer(mobile.handle)
  await new Promise(r => server.listen(0, '127.0.0.1', r))
  const call = (headers = {}, body = {}) => new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port: server.address().port, path: '/m/api/desktop/workspace', method: 'POST', headers: { 'content-type': 'application/json', ...headers } }, res => {
      let raw = ''; res.on('data', data => { raw += data }); res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(raw) }))
    })
    req.on('error', reject); req.end(JSON.stringify(body))
  })
  try {
    assert.equal((await call({}, { path: 'C:\\untrusted.exe' })).body.value.workspace.path, dir)
    assert.deepEqual(calls[0].payload, { path: dir })
    choose = async () => null
    assert.equal((await call()).body.value.cancelled, true)
    assert.equal(calls.length, 1)
    for (const headers of [{ host: 'pc.example' }, { 'x-forwarded-for': '10.0.0.2' }, { origin: 'https://evil.example' }, { 'sec-fetch-site': 'cross-site' }]) assert.equal((await call(headers)).status, 403, JSON.stringify(headers))
    assert.equal(picks, 2)
    let finish
    choose = () => new Promise(r => { finish = r })
    const first = call()
    while (!finish) await new Promise(r => setTimeout(r, 5))
    assert.equal((await call()).status, 409)
    finish(null); await first
    choose = async () => { throw new Error('picker unavailable') }
    assert.equal((await call()).body.ok, false)
    choose = async () => dir
    assert.equal((await call()).body.ok, true, 'failed dialog releases single-flight guard')
    choose = async () => path.join(dir, 'missing')
    assert.equal((await call()).body.ok, false)
    assert.equal(calls.length, 2, 'invalid directory never becomes a workspace')
  } finally {
    mobile.close(); await Promise.all([new Promise(r => server.close(r)), new Promise(r => upstream.close(r))]); fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('desktop injection is absent on phones and remote hosts', () => {
  const code = fs.readFileSync(new URL('../www/desktop.js', import.meta.url), 'utf8')
  for (const [hostname, pathname, userAgent, standalone] of [['pc.example', '/', 'Windows', false], ['127.0.0.1', '/m/', 'Windows', false], ['127.0.0.1', '/', 'Android DSHApp', false], ['127.0.0.1', '/', 'Macintosh', true]]) {
    vm.runInNewContext(code, { location: { hostname, pathname }, navigator: { userAgent, standalone } })
  }
})
