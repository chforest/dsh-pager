import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const SESSION = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/
const PENDING_MESSAGE = '用户尚未回答，不是同意；仅继续独立工作'
const copy = value => JSON.parse(JSON.stringify(value))
const fail = (message, status = 400) => { throw Object.assign(new Error(message), { status, code: 'async-question' }) }
const uuid = value => { if (typeof value !== 'string' || !UUID.test(value)) fail('无效的问题或回答编号'); return value.toLowerCase() }
const text = (value, max, label) => { if (typeof value !== 'string' || !value.trim() || value.length > max) fail(label + '不能为空或过长'); return value.trim() }

/** Local clarification inbox only. No deadline, option or silence grants approval.
 * deliver must return {status:'accepted'} only after an independently confirmed
 * host acceptance. Rejected/unknown transports are retained, never replayed.
 */
export function createAsyncQuestions({ dir, deliver, maxRecords = 1000, maxBytes = 16 * 1024 * 1024, deliveryTimeoutMs = 30000, now = () => Date.now() } = {}) {
  if (!dir || typeof dir !== 'string') fail('缺少问题存储目录')
  const root = path.resolve(dir), records = new Map(), waiters = new Map()
  const canon = p => (process.platform === 'darwin' ? path.resolve(p).replace(/^\/(var|tmp|etc)(?=\/|$)/, '/private/$1') : path.resolve(p)).toLowerCase()
  let closed = false
  fs.mkdirSync(root, { recursive: true, mode: 0o700 })
  if (fs.lstatSync(root).isSymbolicLink() || fs.realpathSync(root).toLowerCase() !== canon(root)) fail('问题目录不能使用链接', 403)
  const names = fs.readdirSync(root).filter(n => n.endsWith('.json'))
  if (names.length > maxRecords) fail('问题存储条数已满', 507)
  let total = 0
  for (const name of names) {
    if (!UUID.test(name.slice(0, -5))) fail('问题存储文件异常', 409)
    const file = path.join(root, name), st = fs.lstatSync(file)
    if (!st.isFile() || st.isSymbolicLink() || st.size > 64 * 1024 || (total += st.size) > maxBytes) fail('问题存储文件异常或超限', 507)
    const r = JSON.parse(fs.readFileSync(file, 'utf8'))
    if (r.id !== name.slice(0, -5) || !SESSION.test(r.sessionId) || r.kind !== 'clarification') fail('问题存储记录异常', 409)
    records.set(r.id, r)
  }
  function persist(record) {
    const bytes = Buffer.from(JSON.stringify(record)), old = records.get(record.id)
    if (!old && records.size >= maxRecords) fail('问题存储条数已满；已有问题不会被自动删除', 507)
    const size = [...records.values()].reduce((n, r) => n + Buffer.byteLength(JSON.stringify(r)), 0) - (old ? Buffer.byteLength(JSON.stringify(old)) : 0) + bytes.length
    if (bytes.length > 64 * 1024 || size > maxBytes) fail('问题存储空间已满；已有问题不会被自动删除', 507)
    const dest = path.join(root, record.id + '.json'), temp = path.join(root, '.' + crypto.randomUUID() + '.tmp')
    try {
      const fd = fs.openSync(temp, 'wx', 0o600)
      try { fs.writeFileSync(fd, bytes); fs.fsyncSync(fd) } finally { fs.closeSync(fd) }
      fs.renameSync(temp, dest)
      records.set(record.id, record)
    } finally { if (fs.existsSync(temp)) fs.unlinkSync(temp) }
  }
  // Any in-flight transport lost on restart is uncertain, never safe to replay.
  for (const r of [...records.values()]) {
    if (r.delivery === 'pending') persist({ ...r, delivery: 'unknown', deliveryReason: 'restart-during-delivery' })
    else if (r.status === 'waiting') persist({ ...r, status: 'deferred' })
  }
  const get = id => { const r = records.get(uuid(id)); if (!r) fail('找不到该问题', 404); return r }
  const pendingResult = id => ({ status: 'deferred', answered: false, message: PENDING_MESSAGE, questionId: id })
  const answeredResult = r => ({ status: 'answered', answered: true, answer: r.answer.text, answerId: r.answer.id, questionId: r.id, delivery: r.delivery })
  function finish(id, result, error) {
    const w = waiters.get(id)
    if (!w) return
    waiters.delete(id); clearTimeout(w.timer); w.signal?.removeEventListener('abort', w.abort)
    if (error) w.reject(error); else w.resolve(result)
  }
  function defer(id) {
    const r = get(id)
    if (!r.answer && r.status !== 'deferred') persist({ ...r, status: 'deferred' })
    finish(id, r.answer ? answeredResult(r) : pendingResult(id))
  }
  function cancel(id) {
    const r = get(id)
    let error = Object.assign(new Error('澄清等待已取消，问题仍保留待答'), { name: 'AbortError' })
    try { if (!r.answer && r.status !== 'deferred') persist({ ...r, status: 'deferred' }) } catch (failure) { error = failure }
    finish(id, null, error)
  }
  return {
    create(input) {
      if (closed) fail('问题服务已关闭', 503)
      if (!input || input.kind !== 'clarification') fail('这里只接受澄清问题，不能代替授权确认')
      const { sessionId } = input
      if (typeof sessionId !== 'string' || !SESSION.test(sessionId)) fail('无效的会话编号')
      const question = text(input.question, 4000, '问题')
      if (!Array.isArray(input.options) || input.options.length > 8) fail('选项必须是最多八项的列表')
      const options = input.options.map(v => text(v, 500, '选项'))
      if (input.independentWork != null && (typeof input.independentWork !== 'string' || input.independentWork.length > 6000)) fail('独立工作说明格式错误或过长')
      const independentWork = input.independentWork?.trim() || ''
      const waitMs = input.waitMs ?? 60000
      if (!Number.isInteger(waitMs) || waitMs < 0 || waitMs > 600000) fail('等待时间必须为0至600000毫秒')
      const requestId = input.requestId == null ? null : uuid(input.requestId)
      const payload = { sessionId, question, options, independentWork, kind: 'clarification', waitMs, requestId }
      const digest = crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex')
      if (requestId) {
        const existing = [...records.values()].find(r => r.sessionId === sessionId && r.requestId === requestId)
        if (existing) { if (existing.digest !== digest) fail('同一请求编号内容不一致', 409); return copy(existing) }
      }
      const id = crypto.randomUUID(), timestamp = now()
      const record = { ...payload, id, questionId: id, digest, status: 'waiting', createdAt: new Date(timestamp).toISOString(), deadline: new Date(timestamp + waitMs).toISOString(), answer: null, delivery: 'not-needed' }
      persist(record); return copy(record)
    },
    async list(sessionId) {
      const all = [...records.values()].filter(r => r.sessionId === sessionId)
      for (const r of all) if (r.status === 'waiting' && now() >= Date.parse(r.deadline)) defer(r.id)
      const current = [...records.values()].filter(r => r.sessionId === sessionId).sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id))
      // Keep every unanswered item discoverable; cap only answered history.
      return [...current.filter(r => !r.answer), ...current.filter(r => r.answer).slice(0, 50)].map(copy)
    },
    wait(id, { signal } = {}) {
      const r = get(id)
      if (r.answer) return Promise.resolve(r.delivery === 'not-needed' ? answeredResult(r) : { status: 'already-delivered', answered: false, questionId: r.id, delivery: r.delivery, message: '回答已记录并走迟到投递流程；不要再次发送，投递状态以delivery为准' })
      if (closed || signal?.aborted) { cancel(r.id); return Promise.reject(Object.assign(new Error('澄清等待已取消，问题仍保留待答'), { name: 'AbortError' })) }
      if (r.status === 'deferred' || now() >= Date.parse(r.deadline)) { defer(r.id); return Promise.resolve(pendingResult(r.id)) }
      if (waiters.has(r.id)) fail('该问题已经有等待者', 409)
      return new Promise((resolve, reject) => {
        const abort = () => cancel(r.id)
        const timer = setTimeout(() => { try { defer(r.id) } catch (error) { finish(r.id, null, error) } }, Math.max(0, Date.parse(r.deadline) - now()))
        waiters.set(r.id, { resolve, reject, timer, signal, abort })
        signal?.addEventListener('abort', abort, { once: true })
      })
    },
    async answer(sessionId, id, input) {
      if (closed) fail('问题服务已关闭', 503)
      const r = get(id)
      if (r.sessionId !== sessionId) fail('问题不属于该会话', 403)
      const answerId = uuid(input?.answerId), answer = text(input?.answer, 8000, '回答')
      if (r.answer) {
        if (r.answer.id !== answerId || r.answer.text !== answer) fail('该问题已收到不同回答，请显式发起新的澄清', 409)
        return copy(r)
      }
      const inTime = waiters.has(r.id) && r.status === 'waiting' && now() < Date.parse(r.deadline)
      const answered = { ...r, status: 'answered', answer: { id: answerId, text: answer, at: new Date(now()).toISOString() }, delivery: inTime ? 'not-needed' : 'pending' }
      // Persist before either waking a tool or causing a late model continuation.
      persist(answered)
      if (inTime) { finish(r.id, answeredResult(answered)); return copy(answered) }
      finish(r.id, pendingResult(r.id))
      let delivery, deliveryTimer
      try {
        if (typeof deliver !== 'function') throw new Error('no dispatcher')
        const result = await Promise.race([
          Promise.resolve().then(() => deliver(copy(answered), answer, answerId)),
          new Promise((resolve, reject) => { deliveryTimer = setTimeout(() => reject(new Error('delivery timeout')), deliveryTimeoutMs) })
        ])
        delivery = result?.status === 'accepted' ? 'accepted' : 'unknown'
      } catch { delivery = 'unknown' }
      finally { clearTimeout(deliveryTimer) }
      const final = { ...answered, delivery }
      persist(final); return copy(final)
    },
    close() { closed = true; for (const id of [...waiters.keys()]) cancel(id) }
  }
}
