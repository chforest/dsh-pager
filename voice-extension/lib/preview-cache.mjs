import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'

// Only fixed public preview phrases enter this cache, never user conversations.
export function createPreviewCache({ dir, maxBytes = 8 * 1024 * 1024, maxEntries = 64, maxPending = 8, maxItemBytes = 1024 * 1024 } = {}) {
  const cache = new Map(), pending = new Map()
  let bytes = 0
  const hash = b => crypto.createHash('sha256').update(b).digest('hex')
  function remember(key, value) {
    if (!Buffer.isBuffer(value) || value.length === 0) throw new Error('preview produced empty audio')
    if (value.length > maxItemBytes || value.length > maxBytes) return value
    while (cache.size && (cache.size >= maxEntries || bytes + value.length > maxBytes)) {
      const first = cache.keys().next().value; bytes -= cache.get(first).length; cache.delete(first)
    }
    cache.set(key, value); bytes += value.length; return value
  }
  function load(key) {
    if (!dir) return null
    try {
      const file = path.join(dir, key + '.json'), st = fs.lstatSync(file)
      if (!st.isFile() || st.isSymbolicLink() || st.size > maxItemBytes * 4 / 3 + 1024) return null
      const record = JSON.parse(fs.readFileSync(file, 'utf8')), audio = Buffer.from(record.audio, 'base64')
      if (record.key !== key || !audio.length || audio.length > maxItemBytes || hash(audio) !== record.sha256) return null
      return remember(key, audio)
    } catch { return null }
  }
  function save(key, value) {
    if (!dir || value.length > maxItemBytes) return
    let temp
    try {
      fs.mkdirSync(dir, { recursive: true })
      const files = fs.readdirSync(dir).filter(n => /^[a-f0-9]{64}\.json$/.test(n))
      // Disk is append-only and bounded; a full cache simply stops persisting.
      if (files.length >= maxEntries) return
      let total = 0
      for (const n of files) total += fs.lstatSync(path.join(dir, n)).size
      const record = JSON.stringify({ key, sha256: hash(value), audio: value.toString('base64') })
      if (total + Buffer.byteLength(record) > maxBytes * 4 / 3 + maxEntries * 1024) return
      temp = path.join(dir, '.' + crypto.randomUUID() + '.tmp')
      fs.writeFileSync(temp, record, { flag: 'wx', mode: 0o600 })
      fs.linkSync(temp, path.join(dir, key + '.json'))
    } catch { /* A read-only/full cache never prevents playback. */ }
    finally { if (temp) try { fs.unlinkSync(temp) } catch {} }
  }
  return {
    async get(identity, generate) {
      const key = hash(JSON.stringify(identity))
      if (cache.has(key)) { const value = cache.get(key); cache.delete(key); cache.set(key, value); return value }
      if (pending.has(key)) return pending.get(key)
      const disk = load(key); if (disk) return disk
      if (pending.size >= maxPending) throw new Error('preview engine busy; try again later')
      const promise = Promise.resolve().then(generate).then(value => { remember(key, value); save(key, value); return value }).finally(() => pending.delete(key))
      pending.set(key, promise); return promise
    },
    clear() { cache.clear(); bytes = 0 },
    stats() { return { entries: cache.size, bytes, pending: pending.size } }
  }
}
