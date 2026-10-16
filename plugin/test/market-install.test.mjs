import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createInstaller } from '../../market-host/index.js'

test('replayed and restarted installation requests never dispatch twice, including unknown results', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'market-ops-'))
  const id = 'a0000000-0000-4000-8000-000000000000', id2 = 'b0000000-0000-4000-8000-000000000000', url = 'https://github.com/example/plugin'
  let calls = 0
  const first = createInstaller({ dir, port: () => 1, send: async () => { calls++; throw new Error('lost receipt') } })
  try {
    await Promise.all([first.start(id, url), first.start(id, url)])
    await first.settle()
    assert.equal(calls, 1)
    assert.equal(first.read(id).state, 'unknown')
    const restarted = createInstaller({ dir, port: () => 1, send: async () => { calls++; return { status: 200, body: { ok: true } } } })
    assert.equal((await restarted.start(id, url)).state, 'unknown')
    assert.equal(calls, 1)
    await assert.rejects(restarted.start(id, 'https://github.com/other/plugin'), /不一致/)
    await restarted.start(id2, url); await restarted.settle()
    assert.equal(restarted.read(id2).receipt.body.ok, true)
    await restarted.start(id2, url)
    assert.equal(calls, 2)
    await assert.rejects(restarted.start('../bad', url), /编号/)
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})
