import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'

const source = fileURLToPath(new URL('./screenshot/RegionCapture.cs', import.meta.url))
const MAX_OUTPUT = 45 * 1024 * 1024
const error = (message, code = 'screenshot-failed') => Object.assign(new Error(message), { code })

export async function ensureScreenshotExecutable() {
  if (process.platform === 'darwin') return '/usr/sbin/screencapture'
  if (process.platform !== 'win32') throw error('截图仅支持 Windows 或 macOS 本地桌面', 'unsupported')
  const hash = crypto.createHash('sha256').update('winexe-visible-v2\n').update(fs.readFileSync(source)).digest('hex').slice(0, 20)
  const dir = fileURLToPath(new URL('./.cache/screenshot/', import.meta.url))
  fs.mkdirSync(dir, { recursive: true })
  const exe = path.join(dir, 'region-' + hash + '.exe')
  if (fs.existsSync(exe)) return exe
  const compiler = path.join(process.env.SystemRoot || 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe')
  if (!fs.existsSync(compiler)) throw error('系统缺少 .NET Framework 截图组件', 'unsupported')
  const temp = path.join(dir, 'build-' + crypto.randomUUID() + '.exe')
  try {
    await new Promise((resolve, reject) => {
      const child = spawn(compiler, ['/nologo', '/target:winexe', '/optimize+', '/reference:System.Drawing.dll', '/reference:System.Windows.Forms.dll', '/out:' + temp, source], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
      const timer = setTimeout(() => { child.kill(); reject(error('截图组件编译超时')) }, 20000)
      child.stdout.resume(); child.stderr.resume()
      child.once('error', e => { clearTimeout(timer); reject(e) })
      child.once('close', code => { clearTimeout(timer); code === 0 ? resolve() : reject(error('无法编译系统截图组件')) })
    })
    try { fs.linkSync(temp, exe) } catch (e) { if (e.code !== 'EEXIST') throw e }
    return exe
  } finally { if (fs.existsSync(temp)) fs.unlinkSync(temp) }
}

export function createDesktopRegionCapture({ spawnProcess = spawn, ensureExecutable = ensureScreenshotExecutable, platform = process.platform, timeoutMs = 100000, diagnostic = message => process.stderr.write('[dsh-screenshot] ' + message + '\n') } = {}) {
  let busy = false
  return async function captureDesktopRegion(signal) {
    if (signal?.aborted) return { cancelled: true }
    if (platform !== 'win32' && platform !== 'darwin') throw error('截图仅支持 Windows 或 macOS 本地桌面', 'unsupported')
    if (busy) throw error('截图窗口已经打开', 'screenshot-busy')
    busy = true
    try {
      if (platform === 'darwin') {
        const tempPng = path.join(os.tmpdir(), `dsh-screencapture-${crypto.randomUUID()}.png`)
        try {
          return await new Promise((resolve, reject) => {
            let child, done = false, timer
            const finish = (err, value) => {
              if (done) return; done = true; clearTimeout(timer); signal?.removeEventListener('abort', abort)
              if (err) reject(err); else resolve(value)
            }
            const abort = () => { child?.kill(); finish(null, { cancelled: true }) }
            try { child = spawnProcess('/usr/sbin/screencapture', ['-i', '-x', tempPng], { stdio: ['ignore', 'pipe', 'pipe'] }) } catch (e) { finish(e); return }
            timer = setTimeout(abort, Math.min(120000, Math.max(1, timeoutMs)))
            signal?.addEventListener('abort', abort, { once: true })
            if (signal?.aborted) { abort(); return }
            child.once('error', e => finish(e))
            child.once('close', code => {
              if (done) return
              if (code !== 0 || !fs.existsSync(tempPng)) {
                finish(null, { cancelled: true })
                return
              }
              try {
                const data = fs.readFileSync(tempPng)
                if (data.length > 32 * 1024 * 1024 || data.length < 24 || data.readUInt32BE(0) !== 0x89504e47 || data.readUInt32BE(4) !== 0x0d0a1a0a) throw error('截图PNG校验失败')
                const width = data.readUInt32BE(16)
                const height = data.readUInt32BE(20)
                finish(null, { mime: 'image/png', data: data.toString('base64'), width, height })
              } catch (e) { finish(e) }
            })
          })
        } finally {
          try { if (fs.existsSync(tempPng)) fs.unlinkSync(tempPng) } catch {}
        }
      }
      const exe = await ensureExecutable()
      if (signal?.aborted) return { cancelled: true }
      return await new Promise((resolve, reject) => {
        let child, done = false, size = 0, timer, activationFailed = false
        const chunks = []
        const finish = (err, value) => {
          if (done) return; done = true; clearTimeout(timer); signal?.removeEventListener('abort', abort)
          if (err) reject(err); else resolve(value)
        }
        const abort = () => { child?.kill(); finish(null, { cancelled: true }) }
        try { child = spawnProcess(exe, ['--capture'], { windowsHide: false, stdio: ['ignore', 'pipe', 'pipe'] }) } catch (e) { finish(e); return }
        timer = setTimeout(abort, Math.min(120000, Math.max(1, timeoutMs)))
        signal?.addEventListener('abort', abort, { once: true })
        if (signal?.aborted) { abort(); return }
        let stderrTail = ''
        child.stderr.on('data', chunk => {
          stderrTail = (stderrTail + String(chunk)).slice(-2048)
          const lines = stderrTail.split(/\r?\n/); stderrTail = lines.pop() || ''
          for (const line of lines) {
            if (line === 'REGION_CAPTURE:ACTIVATION_FAILED') activationFailed = true
            if (/^REGION_CAPTURE:(START|FROZEN|SHOWN|CONFIRMED|CANCELLED|ERROR|ACTIVATION_FAILED)$/.test(line)) diagnostic(line)
          }
        })
        child.stdout.on('data', chunk => {
          if (done) return
          size += chunk.length
          if (size > MAX_OUTPUT) { child.kill(); finish(error('截图过大，请缩小选择范围')); return }
          chunks.push(chunk)
        })
        child.once('error', e => finish(e))
        child.once('close', code => {
          if (done) return
          if (stderrTail === 'REGION_CAPTURE:ACTIVATION_FAILED') activationFailed = true
          if (code !== 0) { finish(activationFailed ? error('截图窗未能进入前台，请重试', 'screenshot-activation-failed') : error('无法截取本地桌面，请确认未锁屏或远程连接')); return }
          try {
            const result = JSON.parse(Buffer.concat(chunks).toString('utf8'))
            if (result.cancelled === true) { finish(null, { cancelled: true }); return }
            if (result.mime !== 'image/png' || !Number.isInteger(result.width) || !Number.isInteger(result.height) || result.width < 2 || result.height < 2 || result.width * result.height > 80000000 || typeof result.data !== 'string') throw error('截图组件返回无效内容')
            const data = Buffer.from(result.data, 'base64')
            if (data.length > 32 * 1024 * 1024 || data.length < 24 || data.toString('base64') !== result.data || data.readUInt32BE(0) !== 0x89504e47 || data.readUInt32BE(4) !== 0x0d0a1a0a || data.readUInt32BE(16) !== result.width || data.readUInt32BE(20) !== result.height) throw error('截图PNG校验失败')
            finish(null, { mime: result.mime, data: result.data, width: result.width, height: result.height })
          } catch (e) { finish(e) }
        })
      })
    } finally { busy = false }
  }
}
export const captureDesktopRegion = createDesktopRegionCapture()
