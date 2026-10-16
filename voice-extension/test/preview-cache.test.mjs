import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createPreviewCache } from '../lib/preview-cache.mjs'

test('preview coalesces simultaneous requests and persists fixed samples across restart', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'preview-cache-'))
  try {
    const cache = createPreviewCache({ dir }); let calls = 0, done
    const generate = () => { calls++; return new Promise(resolve => { done = resolve }) }
    const key = ['v1', 'kokoro', 'int8', '48', 1, '你好']
    const first = cache.get(key, generate), second = cache.get(key, generate)
    await Promise.resolve(); assert.equal(calls, 1); done(Buffer.from('audio'))
    assert.deepEqual(await first, await second)
    assert.equal((await cache.get(key, generate)).toString(), 'audio'); assert.equal(calls, 1)
    const fresh = createPreviewCache({ dir })
    assert.equal((await fresh.get(key, () => { throw new Error('must not synthesize') })).toString(), 'audio')
    assert.equal(fs.readdirSync(dir).length, 1)
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})

test('failed and empty previews are not cached; rate/voice changes have different keys', async () => {
  const cache = createPreviewCache(); let count = 0
  await assert.rejects(cache.get(['voice', 1], async () => { count++; throw Error('not ready') }))
  await assert.rejects(cache.get(['voice', 1], async () => Buffer.alloc(0)))
  await cache.get(['voice', 1], async () => { count++; return Buffer.from('one') })
  await cache.get(['voice', 2], async () => { count++; return Buffer.from('two') })
  assert.equal(count, 3); assert.equal(cache.stats().pending, 0)
})

test('memory, disk and concurrent generations have explicit bounds', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'preview-bounds-'))
  try {
    const cache = createPreviewCache({ dir, maxBytes: 8, maxEntries: 2, maxItemBytes: 8, maxPending: 1 })
    await cache.get('a', async () => Buffer.from('aaaa'))
    await cache.get('b', async () => Buffer.from('bbbb'))
    await cache.get('c', async () => Buffer.from('cccc'))
    assert.equal(cache.stats().entries, 2); assert.equal(cache.stats().bytes, 8)
    assert.equal(fs.readdirSync(dir).length, 2)
    let done
    const work = cache.get('new', () => new Promise(resolve => { done = resolve }))
    await Promise.resolve()
    await assert.rejects(cache.get('different', async () => Buffer.from('x')), /busy/)
    done(Buffer.from('ok')); await work
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})
