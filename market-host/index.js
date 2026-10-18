import fs from 'node:fs'
import path from 'node:path'
import http from 'node:http'
import { fileURLToPath } from 'node:url'
import { trusted } from '../plugin/server.js'
import {authorizeHostOwner,createHostFetch} from '../plugin/host-http.mjs'

export const name = 'mobile-market'
export const inject = ['webServer','connection']
const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
function postOnce(port, url) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ url })
    const req = http.request({ hostname: '127.0.0.1', port, path: '/dsh-market/install', method: 'POST', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } }, res => {
      let size = 0, raw = ''
      res.on('data', c => { size += c.length; if (size > 4 * 1024 * 1024) { res.destroy(); reject(new Error('installation receipt too large')); return } raw += c })
      res.on('error', reject)
      res.on('end', () => { try { resolve({ status: res.statusCode, body: JSON.parse(raw) }) } catch { reject(new Error('invalid installation receipt')) } })
    })
    req.on('error', reject); req.setTimeout(300000, () => req.destroy(new Error('installation receipt timeout'))); req.end(body)
  })
}
export function createInstaller({ dir, port, send = postOnce }) {
  fs.mkdirSync(dir, { recursive: true })
  const pending = new Map()
  const file = id => path.join(dir, id + '.json')
  function read(id) {
    if (!ID.test(id)) throw Object.assign(new Error('无效的安装编号'), { status: 400 })
    try {
      const value = JSON.parse(fs.readFileSync(file(id), 'utf8'))
      return value.state === 'running' && !pending.has(id) ? { ...value, state: 'unknown', error: '服务重载后没有最终回执，请在电脑端核对' } : value
    } catch (e) { if (e.code === 'ENOENT') throw Object.assign(new Error('找不到安装记录，请在电脑端核对'), { status: 404 }); throw e }
  }
  async function start(id, source) {
    if (!ID.test(id)) throw Object.assign(new Error('无效的安装编号'), { status: 400 })
    let url
    try { url = new URL(source) } catch { throw Object.assign(new Error('无效的插件来源'), { status: 400 }) }
    if (url.protocol !== 'https:' || url.hostname !== 'github.com' || url.username || url.password || source.length > 2048) throw Object.assign(new Error('仅接受市场中的 GitHub 插件来源'), { status: 400 })
    const record = { id, url: source, state: 'running', at: new Date().toISOString() }
    try { fs.writeFileSync(file(id), JSON.stringify(record), { flag: 'wx' }) }
    catch (error) {
      if (error.code !== 'EEXIST') throw error
      const previous = read(id)
      if (previous.url !== source) throw Object.assign(new Error('安装编号与插件来源不一致'), { status: 409 })
      return previous
    }
    const task = Promise.resolve().then(() => send(port(), source)).then(receipt => ({ ...record, state: 'done', receipt }), error => ({ ...record, state: 'unknown', error: error.message })).then(result => {
      const tmp = file(id) + '.tmp'
      fs.writeFileSync(tmp, JSON.stringify(result)); fs.renameSync(tmp, file(id)); return result
    }).finally(() => pending.delete(id))
    // Do not cancel an admitted install when the browser leaves. On process
    // restart a surviving running record is only queried, NEVER re-dispatched.
    pending.set(id, task)
    task.catch(() => {})
    return record
  }
  return { start, read, settle: async () => Promise.allSettled([...pending.values()]) }
}
export function apply(ctx, config) {
  const hostFetch=createHostFetch(ctx)
  const installer = createInstaller({ dir: config?.dir || fileURLToPath(new URL('./receipts/', import.meta.url)), port: () => ctx.webServer.port,send:async(port,url)=>{
    const response=await hostFetch(`http://127.0.0.1:${port}/dsh-market/install`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({url}),signal:AbortSignal.timeout(300000)})
    return{status:response.status,body:await response.json()}
  } })
  const respond = (res, status, body) => { res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }); res.end(JSON.stringify(body)) }
  ctx.effect(() => ctx.webServer.register({ kind: 'exact', path: '/m/market-install', handler: async (req, res) => {
    if (!trusted(req, config?.trustedHosts || [])) return respond(res, 403, { error: '请求来源不可信' })
    const denied=authorizeHostOwner(ctx,req);if(denied)return respond(res,denied,{error:'需要已登录的本机所有者会话'})
    try {
      if (req.method === 'GET') return respond(res, 200, installer.read(new URL(req.url, 'http://localhost').searchParams.get('id') || ''))
      if (req.method !== 'POST') return respond(res, 405, { error: '仅支持 GET / POST' })
      if (!/^application\/json\b/.test(req.headers['content-type'] || '')) return respond(res, 415, { error: '需要 JSON 请求' })
      let raw = ''; for await (const chunk of req) { raw += chunk; if (raw.length > 8192) return respond(res, 413, { error: '请求过大' }) }
      const body = JSON.parse(raw)
      return respond(res, 202, await installer.start(body.id, body.url))
    } catch (error) { respond(res, error.status || 500, { error: error.message }) }
  } }), 'mobile market: durable idempotent installation receipts')
}
