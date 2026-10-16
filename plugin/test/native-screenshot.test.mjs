import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { createDesktopRegionCapture } from '../native-screenshot.js'

function fixture() {
  const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.kills = 0
  child.kill = () => { child.kills++; queueMicrotask(() => child.emit('close', null)) }
  return child
}
function png() {
  const b = Buffer.alloc(24); b.writeUInt32BE(0x89504e47); b.writeUInt32BE(0x0d0a1a0a, 4); b.writeUInt32BE(2, 16); b.writeUInt32BE(3, 20)
  return { mime: 'image/png', width: 2, height: 3, data: b.toString('base64') }
}
test('capture returns only confirmed bounded PNG and launches a visible winexe without a shell', async () => {
  const child = fixture(); let count = 0
  const capture = createDesktopRegionCapture({ platform: 'win32', ensureExecutable: async () => 'fixture.exe', spawnProcess: (exe, args, options) => {
    count++; assert.equal(exe, 'fixture.exe'); assert.deepEqual(args, ['--capture']); assert.equal(options.windowsHide, false); assert.equal(options.shell, undefined); return child
  } })
  const result = capture(); await Promise.resolve()
  await assert.rejects(capture(), { code: 'screenshot-busy' })
  child.stdout.write(JSON.stringify(png())); child.emit('close', 0)
  assert.deepEqual(await result, png()); assert.equal(count, 1)
})
test('cancel, aborted signal and watchdog clean up without returning screen bytes', async () => {
  const child = fixture(), controller = new AbortController()
  const capture = createDesktopRegionCapture({ platform: 'win32', ensureExecutable: async () => 'fixture', spawnProcess: () => child })
  const running = capture(controller.signal); await Promise.resolve(); controller.abort()
  assert.deepEqual(await running, { cancelled: true }); assert.equal(child.kills, 1)
  assert.deepEqual(await capture(controller.signal), { cancelled: true })
  const timed = fixture(), timeout = createDesktopRegionCapture({ platform: 'win32', ensureExecutable: async () => 'fixture', spawnProcess: () => timed, timeoutMs: 5 })
  assert.deepEqual(await timeout(), { cancelled: true }); assert.equal(timed.kills, 1)
  const escaped = fixture(), explicit = createDesktopRegionCapture({ platform: 'win32', ensureExecutable: async () => 'fixture', spawnProcess: () => escaped })
  const result = explicit(); await Promise.resolve(); escaped.stdout.write('{"cancelled":true}'); escaped.emit('close', 0)
  assert.deepEqual(await result, { cancelled: true })
})
test('invalid native results and non-Windows platforms never become attachments', async () => {
  for (const value of [{ ...png(), width: 999 }, { ...png(), data: 'bad' }, { mime: 'text/plain' }]) {
    const child = fixture(), capture = createDesktopRegionCapture({ platform: 'win32', ensureExecutable: async () => 'fixture', spawnProcess: () => child })
    const result = capture(); await Promise.resolve(); child.stdout.write(JSON.stringify(value)); child.emit('close', 0)
    await assert.rejects(result)
  }
  const capture = createDesktopRegionCapture({ platform: 'linux', ensureExecutable: () => { throw Error('must not run') } })
  await assert.rejects(capture(), { code: 'unsupported' })
})
test('aborting during helper preparation never opens a capture window', async () => {
  let ready, spawned = false
  const controller = new AbortController(), capture = createDesktopRegionCapture({ platform: 'win32', ensureExecutable: () => new Promise(resolve => { ready = resolve }), spawnProcess: () => { spawned = true; return fixture() } })
  const result = capture(controller.signal); controller.abort(); ready('fixture')
  assert.deepEqual(await result, { cancelled: true }); assert.equal(spawned, false)
})

test('diagnostics report only fixed lifecycle markers and never arbitrary stderr content', async () => {
  const child = fixture(), seen = []
  const capture = createDesktopRegionCapture({ platform: 'win32', ensureExecutable: async () => 'fixture', spawnProcess: () => child, diagnostic: line => seen.push(line) })
  const result = capture(); await Promise.resolve()
  child.stderr.write('REGION_CAPTURE:START\nprivate text must not leak\nREGION_CAPTURE:SH'); child.stderr.write('OWN\n')
  child.stdout.write('{"cancelled":true}'); child.emit('close', 0)
  await result
  assert.deepEqual(seen, ['REGION_CAPTURE:START', 'REGION_CAPTURE:SHOWN'])
})

test('split activation failure marker maps to foreground error without leaking unrelated stderr', async () => {
  const child = fixture(), seen = []
  const capture = createDesktopRegionCapture({ platform: 'win32', ensureExecutable: async () => 'fixture', spawnProcess: () => child, diagnostic: line => seen.push(line) })
  const result = capture(); await Promise.resolve()
  child.stderr.write('private path and text\nREGION_CAPTURE:ACTIV'); child.stderr.write('ATION_FAILED\r\nREGION_CAPTURE:ERROR\n')
  child.emit('close', 1)
  await assert.rejects(result, { code: 'screenshot-activation-failed', message: '截图窗未能进入前台，请重试' })
  assert.deepEqual(seen, ['REGION_CAPTURE:ACTIVATION_FAILED', 'REGION_CAPTURE:ERROR'])
})
