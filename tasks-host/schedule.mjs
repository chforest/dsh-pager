const fail = message => { throw Object.assign(new Error(message), { status: 400, code: 'invalid-schedule' }) }
const DAY = 86400000, OFFSET = 8 * 3600000
export function normalizeSchedule(value = { kind: 'manual' }, now = Date.now(), allowPast = false) {
  if (!value || typeof value !== 'object' || !['manual', 'once', 'interval', 'daily'].includes(value.kind)) fail('请选择有效的执行时间')
  const timeZone = value.timeZone || 'Asia/Shanghai'
  if (timeZone !== 'Asia/Shanghai') fail('当前任务时间使用 Asia/Shanghai')
  const result = { kind: value.kind, timeZone }
  if (value.kind === 'once') {
    if (typeof value.at !== 'string' || !/^[1-9]\d{3}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(value.at) || value.at.endsWith('-00:00') || !Number.isFinite(Date.parse(value.at))) fail('请提供带时区的完整日期时间')
    const [year, month, day] = value.at.slice(0, 10).split('-').map(Number), check = new Date(Date.UTC(year, month - 1, day))
    if (check.getUTCFullYear() !== year || check.getUTCMonth() !== month - 1 || check.getUTCDate() !== day) fail('日期不存在')
    if (!allowPast && Date.parse(value.at) <= now) fail('执行时间必须晚于现在')
    result.at = new Date(value.at).toISOString()
  }
  if (value.kind === 'interval') {
    if (!Number.isSafeInteger(value.seconds) || value.seconds < 300 || value.seconds > 31536000) fail('周期为300秒至365天之间的整数秒')
    result.seconds = value.seconds
  }
  if (value.kind === 'daily') {
    if (typeof value.time !== 'string' || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value.time)) fail('每日时间格式为 HH:mm')
    const days = value.days ?? [0, 1, 2, 3, 4, 5, 6]
    if (!Array.isArray(days) || !days.length || days.length > 7 || days.some(d => !Number.isInteger(d) || d < 0 || d > 6)) fail('请选择有效的星期')
    result.time = value.time; result.days = [...new Set(days)].sort()
  }
  return result
}
function dailyAt(schedule, now, direction) {
  const local = new Date(now + OFFSET), midnight = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate()) - OFFSET
  const [hour, minute] = schedule.time.split(':').map(Number)
  for (let i = 0; i <= 7; i++) {
    const at = midnight + direction * i * DAY + hour * 3600000 + minute * 60000
    const weekday = new Date(at + OFFSET).getUTCDay()
    if (schedule.days.includes(weekday) && (direction > 0 ? at > now : at <= now)) return at
  }
  fail('无法计算下次执行时间')
}
export function nextRun(schedule, now = Date.now()) {
  if (schedule.kind === 'manual') return null
  if (schedule.kind === 'once') return Date.parse(schedule.at) > now ? schedule.at : null
  if (schedule.kind === 'interval') return new Date(now + schedule.seconds * 1000).toISOString()
  return new Date(dailyAt(schedule, now, 1)).toISOString()
}
export function dueOccurrence(schedule, nextRunAt, now) {
  if (!nextRunAt || Date.parse(nextRunAt) > now || schedule.kind === 'manual') return null
  let at = Date.parse(nextRunAt), next = null
  if (schedule.kind === 'interval') { const interval = schedule.seconds * 1000; at += Math.floor((now - at) / interval) * interval; next = new Date(at + interval).toISOString() }
  if (schedule.kind === 'daily') { at = Math.max(at, dailyAt(schedule, now, -1)); next = new Date(dailyAt(schedule, now, 1)).toISOString() }
  return { scheduledAt: new Date(at).toISOString(), nextRunAt: next }
}
