import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'

export const MAX_AUDIO = 12 * 1024 * 1024
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const SID = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/
const fail = (message, status = 400) => { throw Object.assign(new Error(message), { status, code: 'voice-storage' }) }
const order = (a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id)
const groupKey = r => r.role === 'assistant' && r.replyTo && r.requestId ? JSON.stringify([r.replyTo, r.requestId, r.mode ?? null, r.callId ?? null, r.callStartedAt ?? null]) : null
const revision = records => crypto.createHash('sha256').update(JSON.stringify(records.map(r => [r.id, r.digest]))).digest('hex').slice(0, 24)

function mergePcmWav(records) {
  let format = null
  const chunks = []
  for (const r of records) {
    const bytes = Buffer.from(r.audio, 'base64')
    if (r.mime !== 'audio/wav' || !isAudio(bytes, r.mime)) fail('这组语音不是可合并的 WAV，请播放原始分段', 415)
    let current = null
    const data = []
    for (let p = 12; p + 8 <= bytes.length;) {
      const size = bytes.readUInt32LE(p + 4), kind = bytes.toString('ascii', p, p + 4)
      if (kind === 'fmt ') current = bytes.subarray(p + 8, p + 8 + size)
      if (kind === 'data') data.push(bytes.subarray(p + 8, p + 8 + size))
      p += 8 + size + (size % 2)
    }
    if (!current || current.readUInt16LE(0) !== 1 || current.length < 16) fail('这组语音不是 PCM WAV，请播放原始分段', 415)
    const channels = current.readUInt16LE(2), rate = current.readUInt32LE(4), byteRate = current.readUInt32LE(8), align = current.readUInt16LE(12), bits = current.readUInt16LE(14)
    if (!align || bits % 8 || align !== channels * bits / 8 || byteRate !== rate * align || data.some(c => c.length % align)) fail('这组 WAV 音频参数异常，无法连续播放', 415)
    if (format && !format.equals(current.subarray(0, 16))) fail('这组语音的采样率、声道或位深不一致，无法合并', 415)
    format = current.subarray(0, 16); chunks.push(...data)
  }
  const dataLength = chunks.reduce((n, b) => n + b.length, 0), pad = dataLength % 2
  const header = Buffer.alloc(44)
  header.write('RIFF'); header.writeUInt32LE(36 + dataLength + pad, 4); header.write('WAVEfmt ', 8); header.writeUInt32LE(16, 16); format.copy(header, 20); header.write('data', 36); header.writeUInt32LE(dataLength, 40)
  return Buffer.concat([header, ...chunks, Buffer.alloc(pad)])
}
export function voiceSession(s) { if (typeof s !== 'string' || !SID.test(s)) fail('无效的对话编号'); return s }
function uuid(id) { if (typeof id !== 'string' || !UUID.test(id)) fail('无效的语音编号'); return id.toLowerCase() }
function isAudio(b, mime) {
  if (mime === 'audio/wav') {
    if (b.length < 44 || b.toString('ascii', 0, 4) !== 'RIFF' || b.toString('ascii', 8, 12) !== 'WAVE' || b.readUInt32LE(4) + 8 !== b.length) return false
    let format = false, data = false
    for (let p = 12; p + 8 <= b.length;) {
      const kind = b.toString('ascii', p, p + 4), size = b.readUInt32LE(p + 4), end = p + 8 + size
      if (end > b.length) return false
      if (kind === 'fmt ') format = size >= 16 && b.readUInt16LE(p + 10) > 0 && b.readUInt32LE(p + 12) > 0
      if (kind === 'data') data = size > 0
      p = end + (size % 2)
    }
    return format && data
  }
  if (mime === 'audio/ogg') return b.length >= 27 && b.toString('ascii', 0, 4) === 'OggS' && (b.includes(Buffer.from('OpusHead')) || b.includes(Buffer.from('vorbis')))
  if (mime === 'audio/webm') return b.length >= 32 && b.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3])) && b.subarray(0, 4096).includes(Buffer.from('webm')) && b.includes(Buffer.from('A_OPUS'))
  if (mime === 'audio/mpeg') {
    let p = 0
    if (b.length >= 10 && b.toString('ascii', 0, 3) === 'ID3') {
      if ([b[6], b[7], b[8], b[9]].some(x => x & 128)) return false
      p = 10 + b[6] * 2097152 + b[7] * 16384 + b[8] * 128 + b[9] + ((b[5] & 16) ? 10 : 0)
    }
    return p + 4 <= b.length && b[p] === 255 && (b[p + 1] & 0xe0) === 0xe0 && (b[p + 1] & 6) !== 0 && (b[p + 2] & 0xf0) !== 0xf0 && (b[p + 2] & 12) !== 12
  }
  return false
}
// A single immutable JSON envelope keeps audio and metadata atomic across crashes.
// No model request is made here. Limits reject new messages, never delete old audio.
export function createVoiceStore({ dir, sessionLimit = 256 * 1024 * 1024, totalLimit = 2 * 1024 * 1024 * 1024, itemLimit = 1000 } = {}) {
  const root = path.resolve(dir)
  const canon = p => (process.platform === 'darwin' ? path.resolve(p).replace(/^\/(var|tmp|etc)(?=\/|$)/, '/private/$1') : path.resolve(p)).toLowerCase()
  function safeDir(p) {
    fs.mkdirSync(p, { recursive: true })
    if (fs.lstatSync(p).isSymbolicLink() || fs.realpathSync(p).toLowerCase() !== canon(p)) fail('语音目录不能使用链接', 403)
  }
  function folder(s) { safeDir(root); const p = path.join(root, voiceSession(s)); safeDir(p); return p }
  function read(file) {
    const st = fs.lstatSync(file)
    if (!st.isFile() || st.isSymbolicLink() || st.size > MAX_AUDIO * 4 / 3 + 100000) fail('语音文件异常', 409)
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  }
  function publicItem(record, s) { const { audio, digest, ...item } = record; return { ...item, url: '/m/api/voice/audio?' + new URLSearchParams({ s, id: item.id }) } }
  function records(s) {
    const p = folder(s), names = fs.readdirSync(p).filter(n => UUID.test(n.slice(0, -5)) && n.endsWith('.json'))
    if (names.length > itemLimit) fail('语音条数超出上限', 507)
    return names.map(n => read(path.join(p, n))).sort(order)
  }
  function list(s) {
    const all = records(s), groups = new Map(), output = []
    for (const record of all) {
      const key = groupKey(record)
      if (!key) { output.push(publicItem(record, s)); continue }
      if (!groups.has(key)) { const group = []; groups.set(key, group); output.push(group) }
      groups.get(key).push(record)
    }
    return output.map(group => {
      if (!Array.isArray(group)) return group
      const item = publicItem(group[0], s), segmentIds = group.map(r => r.id)
      if (group.length === 1) return { ...item, segmentIds }
      return { ...item, text: group.map(r => r.text).join(''), durationMs: group.reduce((sum, r) => sum + r.durationMs, 0), segmentIds,
        url: '/m/api/voice/audio?' + new URLSearchParams({ s, id: item.id, group: '1', rev: revision(group) }) }
    })
  }
  function has(s) {
    if (typeof s !== 'string' || !SID.test(s)) return false
    const p = path.join(root, s)
    try {
      if (fs.realpathSync(p).toLowerCase() !== canon(p)) return false
      return fs.readdirSync(p, { withFileTypes: true }).some(e => e.isFile() && !e.isSymbolicLink() && e.name.endsWith('.json') && UUID.test(e.name.slice(0, -5)))
    } catch { return false }
  }
  function put(body) {
    if (!body || typeof body !== 'object' || Array.isArray(body)) fail('语音信息不完整')
    const s = voiceSession(body.s), id = uuid(body.id)
    if (!['user', 'assistant'].includes(body.role) || typeof body.text !== 'string' || body.text.length > 32000 || !Number.isFinite(body.durationMs) || body.durationMs < 0 || body.durationMs > 600000) fail('语音信息不完整')
    if (typeof body.audio !== 'string' || body.audio.length > MAX_AUDIO * 4 / 3) fail('语音超过 12 MB', 413)
    if (body.audio.length % 4 !== 0 || /[^A-Za-z0-9+/=]/.test(body.audio)) fail('无效的音频编码')
    const bytes = Buffer.from(body.audio, 'base64')
    if (bytes.toString('base64') !== body.audio) fail('无效的音频编码')
    if (!isAudio(bytes, body.mime)) fail('音频格式与内容不匹配', 415)
    const requestId = body.requestId == null ? null : body.requestId
    if (requestId !== null && (typeof requestId !== 'string' || !/^[a-zA-Z0-9_-]{1,160}$/.test(requestId))) fail('无效的请求编号')
    const replyTo = body.replyTo == null ? null : uuid(body.replyTo)
    const content = { id, role: body.role, text: body.text, mime: body.mime, durationMs: body.durationMs, requestId, replyTo, audio: body.audio }
    // Keep the exact old digest shape when optional metadata is absent.
    if (body.mode !== undefined) {
      if (!['message', 'call'].includes(body.mode)) fail('无效的语音模式')
      content.mode = body.mode
    }
    if (body.callId !== undefined || body.callStartedAt !== undefined) {
      if (body.mode !== 'call') fail('只有语音通话可以携带通话信息')
      content.callId = uuid(body.callId)
      const stamp = body.callStartedAt
      if (typeof stamp !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(stamp) || !Number.isFinite(Date.parse(stamp)) || new Date(stamp).toISOString() !== stamp) fail('无效的通话开始时间')
      content.callStartedAt = stamp
    }
    const digest = crypto.createHash('sha256').update(JSON.stringify(content)).digest('hex')
    const p = folder(s), file = path.join(p, id + '.json')
    const existing = () => { const old = read(file); if (old.digest !== digest) fail('同一语音编号的内容不一致', 409); return publicItem(old, s) }
    if (fs.existsSync(file)) return existing()
    const record = { ...content, digest, createdAt: new Date().toISOString() }, data = JSON.stringify(record)
    let total = 0, sessionBytes = 0, count = 0, allCount = 0
    for (const name of fs.readdirSync(root)) {
      const sp = path.join(root, name), st = fs.lstatSync(sp)
      if (!st.isDirectory() || st.isSymbolicLink()) continue
      for (const entry of fs.readdirSync(sp)) {
        const f = fs.lstatSync(path.join(sp, entry))
        if (f.isSymbolicLink()) fail('语音目录存在异常链接', 403)
        if (!f.isFile()) continue
        total += f.size
        if (++allCount > 10000) fail('语音存储条数已满', 507)
        if (name === s) { sessionBytes += f.size; count++ }
      }
    }
    const size = Buffer.byteLength(data)
    if (count >= itemLimit || sessionBytes + size > sessionLimit || total + size > totalLimit) fail('语音存储空间已满，请联系电脑端管理', 507)
    const temp = path.join(p, '.' + crypto.randomUUID() + '.tmp')
    try {
      const fd = fs.openSync(temp, 'wx', 0o600)
      try { fs.writeFileSync(fd, data); fs.fsyncSync(fd) } finally { fs.closeSync(fd) }
      try { fs.linkSync(temp, file) } catch (e) { if (e.code === 'EEXIST') return existing(); throw e }
    } finally { if (fs.existsSync(temp)) fs.unlinkSync(temp) }
    return publicItem(record, s)
  }
  function audio(s, id, { group = false, rev } = {}) {
    const file = path.join(folder(s), uuid(id) + '.json')
    if (!fs.existsSync(file)) fail('找不到这条语音', 404)
    const record = read(file)
    if (group) {
      const key = groupKey(record)
      if (!key) fail('这条语音不属于助手回复组', 400)
      const members = records(s).filter(r => groupKey(r) === key)
      if (rev && rev !== revision(members)) fail('语音内容已更新，请刷新后重新播放', 409)
      return { mime: 'audio/wav', bytes: mergePcmWav(members) }
    }
    return { mime: record.mime, bytes: Buffer.from(record.audio, 'base64') }
  }
  return { list, has, put, audio }
}
