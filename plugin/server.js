/**
 * dsh-mobile HTTP surface, mounted at /m on the DSH web server.
 *
 *   GET  /m/                 phone app shell (index.html with CSS/JS inlined)
 *   GET  /m/<asset>          other files under www/
 *   GET  /m/api/boot         workspaces + compact session list (one round trip)
 *   GET  /m/api/history      folded history page (see fold.js; ~1% of raw size)
 *   GET  /m/api/events       SSE: compact live frames bridged from DSH's two
 *                            WebSocket downlinks, text deltas coalesced
 *   GET  /m/api/img          one session image attachment, immutable-cached
 *   GET  /m/api/call         one tool call unclipped (?s=&id=&seq=&rseq=)
 *   GET  /m/api/fs           a directory listing or a file's text, inside the
 *                            session's workspace only (?s=&path=; see files.js)
 *   GET  /m/api/raw          an image / video / audio file of that workspace,
 *                            with Range support
 *   POST /m/api/rpc          allowlisted DSH unary call {method, payload}
 *                            plus session.permissions / session.selectPermission
 *   POST /m/api/desktop/workspace  local native folder picker, then workspace.create
 *   POST /m/api/respond      approval / question answer {rpcId, result}
 *   GET  /m/api/push/key     Web Push: this server's public key + device count
 *   POST /m/api/push/subscribe | unsubscribe | test
 *                            register the installed web app (iPhone) for the
 *                            same notices the Android app gets (see push.js)
 *   POST /m/api/agents/hook  Claude Code / Codex hook events (tools/pager-hook.mjs;
 *                            token from ~/.dsh-pager/hook.json; see agents.js)
 *   GET  /m/api/agents       their recent sessions (hooks + session files of the last
 *                            7 days), pending approvals, routing mode
 *   GET  /m/api/agents/history   one session as chat items, folded from its session
 *                            file (transcripts.js), which is then watched for changes
 *   POST /m/api/agents/prompt    continue a session from the phone {s, text}
 *   POST /m/api/agents/mode  auto | phone | pc
 *   GET  /m/api/app/latest   the Android app build this PC offers (version, SHA-256),
 *   GET  /m/api/app/apk      and the APK itself: the app updates itself from here
 *   GET  /m/api/usage        token / time usage from DSH's session projections: one session
 *                            (?s=) or every session active in the last ?days= (default 7)
 *   GET  /m/api/commands     quick commands (short prompts kept on this PC, see commands.js)
 *   POST /m/api/commands     replace the list {items: [{id?, label, text}]}
 *
 * This module talks to DSH only through its public loopback wire protocol
 * (POST /api/<method>, WS /api/events.mux|host), exactly like DSH's own web
 * client. It never imports DSH internals, so it runs unchanged both inside the
 * DSH process (index.js) and as a standalone dev server (dev.mjs).
 *
 * Trust: /m/api/* applies the same DNS-rebinding / cross-site fence DSH uses
 * for /api (loopback or `trustedHosts` Host, same-origin Origin, no cross-site
 * Fetch metadata). It is not authentication: remote access must come through
 * a VPN or an authenticating gateway (see docs/remote-access.md).
 *
 * Log lines are ASCII on purpose: DSH's stdout is appended by PowerShell,
 * which mangles mixed encodings.
 */

import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { foldHistory, foldUser, foldAssistant, foldCall, foldResult, foldQueue, fullCall, resultCallId, foldUsage } from './fold.js'
import { NotifyHub } from './notify.js'
import { confine, describe as describeFile, parseRange, MEDIA } from './files.js?absolute-path-v1'
import { createVideoPreviews } from './video.js'
import { WebPush, noticePayload, defaultDir } from './push.js'
import { spawn } from 'node:child_process'
import { AgentHub, SOURCES, resolveBins } from './agents.js'
import { createPresence } from './presence.js'
import { foldFile, recentFiles, headMeta } from './transcripts.js'
import * as quick from './commands.js'
import { pickDesktopDirectory } from './native-folder.js'
import { captureDesktopRegion } from './native-screenshot.js?visible-v5'
import { createScreenshotBroker } from './screenshot-broker.js?text-tools-v2'
import { createVoiceStore, voiceSession, MAX_AUDIO } from './voice-store.js?voice-messages-20261012-v6'
import { createRemoteFolders } from './remote-folders.js?drive-cache-v2'
import { createAsyncQuestions } from './async-questions.js?async-v1'

const PLUGIN_DIR = path.dirname(fileURLToPath(import.meta.url))

/** Version of the DSH host running this plugin (walks up from its entry script), or null. */
const DSH_VERSION = (() => {
  try {
    let dir = path.dirname(fs.realpathSync(process.argv[1] || ''))
    for (let i = 0; i < 6; i++) {
      const f = path.join(dir, 'package.json')
      if (fs.existsSync(f)) {
        const p = JSON.parse(fs.readFileSync(f, 'utf8'))
        if (p.name === '@deepseek-ai/dsh' && typeof p.version === 'string') return p.version
      }
      const up = path.dirname(dir)
      if (up === dir) break
      dir = up
    }
  } catch {}
  return null
})()
const WWW = path.join(PLUGIN_DIR, 'www')

/** The only DSH methods a phone may invoke through /m/api/rpc. */
const RPC_ALLOW = new Set([
  'session.create', 'session.prompt', 'session.cancel', 'session.models', 'session.selectModel',
  'session.rename', 'session.search', 'session.updateQueue', 'workspace.archiveSession', 'commands/list',
])
const PERMISSION_PRESETS = new Set(['read-only', 'workspace-write', 'danger-full-access'])

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
}

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]'])
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function normalizeHtmlNewlines(text) { return text.replace(/\r\n?/g, '\n') }

/**
 * Canonical form of one `trustedHosts` entry, or null when it is not a bare
 * `host` / `host:port` authority. Mirrors DSH's assertTrustedAuthority: an
 * entry that URL parsing would silently rewrite (`user@host`, `host/path`, a
 * dangling colon, a zero-padded port, unbracketed IPv6) is a typo that would
 * change what it grants, so it is refused. `:80` and `:443` count as explicit.
 * @param {unknown} entry
 */
export function canonicalTrustedHost(entry) {
  if (typeof entry !== 'string') return null
  let url
  try { url = new URL(`http://${entry}`) } catch { return null }
  const port = url.port !== '' ? url.port : new URL(`https://${entry}`).port
  const canon = port === '' ? url.hostname : `${url.hostname}:${port}`
  return canon === entry.toLowerCase() ? canon : null
}

/**
 * Same fence as DSH's isTrustedApiRequest: the Host must be loopback or one of
 * the deployment's `trustedHosts` (exact `host:port`, or a port-less `host`
 * matching any port), and any browser Origin must be same-host.
 * @param {import('node:http').IncomingMessage} req
 * @param {string[]} [trustedHosts]
 */
export function trusted(req, trustedHosts = []) {
  const host = req.headers.host
  if (!host) return false
  let hostUrl
  try { hostUrl = new URL(`http://${host}`) } catch { return false }
  const listed = trustedHosts.some((entry) => {
    const canon = canonicalTrustedHost(entry)
    if (canon === null) return false
    const e = new URL(`http://${canon}`)
    return canon === e.hostname ? e.hostname === hostUrl.hostname : e.host === hostUrl.host
  })
  if (!LOOPBACK.has(hostUrl.hostname) && !listed) return false
  if (req.headers['sec-fetch-site'] === 'cross-site') return false
  const origin = req.headers.origin
  if (origin === undefined) return true
  try { return new URL(origin).host === hostUrl.host } catch { return false }
}

function acceptsGzip(req) {
  return /\bgzip\b/.test(req.headers['accept-encoding'] || '')
}

/**
 * Sign-in page for hosts whose DSH carries browser-session authentication
 * (0.2.x). The pager's owner gate reads the same cookie DSH mints from its
 * `?token=` launch URL, so a device that has never seen that URL (notably the
 * Android app's WebView, which has no address bar) needs a place to paste it.
 *
 * The form never validates a token itself: it fetches the pasted token from
 * DSH's own `/` (same origin) and lets DSH mint the session cookie, then enters
 * the app. Only a 200 after that redirect confirms the token was accepted.
 */
const LOGIN_HTML = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="theme-color" content="#f5f6f8">
<title>登录 · DSH 寻呼机</title>
<style>
:root{color-scheme:light dark}
*{box-sizing:border-box}
body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#f5f6f8;color:#1b1d21;font:16px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;padding:24px}
@media(prefers-color-scheme:dark){body{background:#111315;color:#e9ecef}textarea{border-color:#333a42!important}.tip{color:#7c8591!important}}
main{width:100%;max-width:420px}
h1{font-size:20px;margin:0 0 8px}
p{color:#6a7280;margin:0 0 16px;font-size:14px}
code{font-size:13px}
textarea{width:100%;min-height:88px;padding:12px;border-radius:12px;border:1px solid #cfd5dd;background:transparent;color:inherit;font:14px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;resize:vertical}
button{margin-top:14px;width:100%;padding:14px;border:0;border-radius:12px;background:#2f6fed;color:#fff;font-size:16px;font-weight:600}
button:disabled{opacity:.6}
.msg{margin-top:12px;font-size:14px;color:#b23b3b;min-height:20px}
.tip{margin-top:22px;font-size:12px;color:#8a929e;line-height:1.6}
</style>
</head>
<body>
<main>
<h1>DSH 寻呼机</h1>
<p>粘贴电脑上 <code>dsh web</code> 打印的登录链接，或只粘贴其中的 token。</p>
<textarea id="v" autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false" placeholder="http://…:3080/?token=…"></textarea>
<button id="go">登录</button>
<div class="msg" id="msg"></div>
<div class="tip">登录一次可用 30 天。链接每次 DSH 重启都会变，在运行 dsh web 的终端里能找到。</div>
</main>
<script>
(function () {
  var v = document.getElementById('v'), go = document.getElementById('go'), msg = document.getElementById('msg')
  function token(text) {
    text = String(text || '').trim()
    if (!text) return ''
    try { var u = new URL(text); var t = u.searchParams.get('token'); if (t) return t.trim() } catch (e) {}
    var m = text.match(/[?&]token=([^&\\s#]+)/)
    if (m) { try { return decodeURIComponent(m[1]) } catch (e) { return m[1] } }
    if (/^[A-Za-z0-9_-]{20,}$/.test(text)) return text
    return ''
  }
  function fail(t) { go.disabled = false; msg.textContent = t }
  function login() {
    var t = token(v.value)
    if (!t) return fail('没有找到 token，请粘贴完整链接')
    go.disabled = true; msg.textContent = '正在登录…'
    fetch('/?token=' + encodeURIComponent(t), { cache: 'no-store', redirect: 'follow', credentials: 'same-origin' })
      .then(function (r) {
        if (r.ok) { location.replace('/m/'); return }
        fail(r.status === 401 ? '链接无效或已过期，请用终端里最新打印的那条' : '登录失败：HTTP ' + r.status)
      }, function (e) { fail('登录失败：' + ((e && e.message) || e)) })
  }
  go.addEventListener('click', login)
  v.addEventListener('keydown', function (e) { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) login() })
  v.focus()
})()
</script>
</body>
</html>
`

function json(req, res, status, obj) {
  let body = Buffer.from(JSON.stringify(obj))
  const headers = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }
  if (body.length > 1024 && acceptsGzip(req)) {
    body = zlib.gzipSync(body, { level: 6 })
    headers['content-encoding'] = 'gzip'
    headers.vary = 'accept-encoding'
  }
  headers['content-length'] = body.length
  res.writeHead(status, headers)
  res.end(body)
}

function readJson(req, limit) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', (c) => {
      size += c.length
      if (size > limit) { reject(Object.assign(new Error('body too large'), { status: 413 })); req.destroy(); return }
      chunks.push(c)
    })
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')) } catch { reject(Object.assign(new Error('bad json'), { status: 400 })) }
    })
    req.on('error', reject)
  })
}

/**
 * @param {{ apiPort: () => number, servePort?: () => number, log?: (msg: string) => void, trustedHosts?: string[], pushDir?: string, appApk?: string, transcripts?: { claudeDir?: string, codexDir?: string }, spawnAgent?: typeof spawn }} opts
 *   servePort: where /m itself is served, when that is not DSH's port (dev.mjs); hooks post there.
 *   appApk: the APK offered for in-app updates (build.sh writes <apk>.json beside it); default
 *   android/out/DSH.apk, then the newest android/out/dsh-pager-v*.apk of this repo.
 *   transcripts / spawnAgent: where Claude Code / Codex session files live and how a phone turn
 *   starts one of them; only the demo (demo/fake-dsh.mjs) replaces the real ones.
 * @returns {{ handle: (req, res) => Promise<void>, close: () => void }}
 */
export function createMobile({ apiPort, apiHost: apiHostOption, servePort = apiPort, log = () => {}, trustedHosts = [], pushDir, appApk, externalAgents = false, previewDir, voiceDir, questionDir, remoteFolderOptions, ffmpeg, transcripts = {}, spawnAgent = spawn, pickDirectory = pickDesktopDirectory, captureRegion = captureDesktopRegion, screenshotTranslate, screenshotRecognize, suggestionProvider, hostRpc, authorizeRequest, nativeStreams, nativeRespond }) {
  if (typeof externalAgents !== 'boolean') throw new Error('externalAgents must be a boolean')
  // Fail the load loudly, as DSH does, rather than 403 every phone request later.
  const badHost = trustedHosts.find((h) => canonicalTrustedHost(h) === null)
  if (badHost !== undefined) throw new Error(`dsh-pager: trustedHosts entry ${JSON.stringify(badHost)} is not a bare host[:port] authority`)
  const bridges = new Set()
  const voiceWatchers = new Map()
  let voiceWatcherCount = 0, voiceStopped = false
  function subscribeVoice(sid, req, res) {
    if (voiceStopped) throw Object.assign(new Error('语音事件服务已关闭'), { status: 503 })
    let watchers = voiceWatchers.get(sid)
    if (voiceWatcherCount >= 64 || (watchers && watchers.size >= 16)) throw Object.assign(new Error('语音事件连接过多，请关闭重复页面'), { status: 429, code: 'voice-storage' })
    if (!watchers) { watchers = new Set(); voiceWatchers.set(sid, watchers) }
    let timer, ended = false
    const watcher = { send, close }
    function close() {
      if (ended) return
      ended = true; clearInterval(timer)
      watchers.delete(watcher); voiceWatcherCount--
      if (!watchers.size) voiceWatchers.delete(sid)
      req.off('close', close); res.off('close', close); res.off('error', close)
      if (!res.writableEnded) res.end()
    }
    function send(frame) {
      if (ended) return
      try { if (!res.write(frame)) { close(); res.destroy() } } catch { close() }
    }
    watchers.add(watcher); voiceWatcherCount++
    res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'private, no-cache, no-transform', 'x-accel-buffering': 'no' })
    req.on('close', close); res.on('close', close); res.on('error', close)
    timer = setInterval(() => send(': heartbeat\n\n'), 15000)
    timer.unref?.()
    send('retry: 2000\n: connected\n\n')
  }
  function voiceSaved(s, item) {
    const frame = 'event: voice-saved\ndata: ' + JSON.stringify({ s, item }) + '\n\n'
    for (const watcher of voiceWatchers.get(s) || []) watcher.send(frame)
    // Phones already consume this authenticated bridge; reuse its connection
    // instead of spending another HTTP/1 SSE slot for the same notification.
    for (const bridge of bridges) bridge.send({ t: 'voiceSaved', s, item })
  }
  const permissionWrites = new Set()
  let folderPick = null
  const screenshots = createScreenshotBroker({ dshPort: servePort, captureRegion, translate: screenshotTranslate, ...(screenshotRecognize ? { recognize: screenshotRecognize } : {}) })
  let shell = null
  const previews = createVideoPreviews({ dir: previewDir || path.join(PLUGIN_DIR, '.cache', 'video'), ffmpeg, log })

  // DSH binds one concrete interface (`dsh web --host …`), so 127.0.0.1 is not
  // always listening; follow the configured bind address for internal calls.
  const apiHost = () => {
    const host = typeof apiHostOption === 'function' ? apiHostOption() : '127.0.0.1'
    const value = typeof host === 'string' && host ? host : '127.0.0.1'
    return value.includes(':') && !value.startsWith('[') ? `[${value}]` : value
  }
  const base = () => `http://${apiHost()}:${apiPort()}`

  // Always-on watcher behind /m/api/notify. Started shortly after load (DSH may
  // still be binding its port) so notices are buffered even before a phone connects.
  const hub = new NotifyHub({ wsBase: () => `ws://${apiHost()}:${apiPort()}`, listSessions: () => value('session.list', {}), log, nativeStreams })
  const hubTimer = setTimeout(() => hub.start(), 3000)
  hubTimer.unref?.()

  // Installed web apps (iPhone) get the same notices through Web Push.
  const dataDir = pushDir || defaultDir()
  const voices = createVoiceStore({ dir: voiceDir || path.resolve(PLUGIN_DIR, '../../语音与浏览器/messages') })
  const remoteFolders = createRemoteFolders({ ...remoteFolderOptions, rpc: value })
  const asyncQuestions = createAsyncQuestions({
    dir: questionDir || path.join(dataDir, 'async-questions'),
    deliver: async (record, answer, answerId) => {
      await rootOf(record.sessionId, true)
      const text = '用户补充回答了此前的澄清问题（不是新的授权）：\n问题编号：' + record.id + '\n原问题：' + record.question + '\n用户回答：' + answer + '\n请结合当前进度调整后续工作，勿重复已经完成的动作。'
      // Queue admission is host-owned. Never replay an ambiguous response.
      const out = await dsh('session.prompt', { sessionId: record.sessionId, mode: 'queue', content: [{ type: 'text', text }] }, 20000, answerId)
      if (!out.ok || out.value?.accepted !== true) throw new Error(out.error?.message || '未确认回答已被会话接收')
      return { status: 'accepted' }
    },
  })
  const push = new WebPush({ dir: dataDir, log })
  hub.onNotice((ev) => {
    const n = noticePayload(ev)
    if (n && push.list().length) push.broadcast(n.payload, n).catch((err) => log(`push failed: ${err && err.message}`))
  })

  // Claude Code / Codex on this PC: their hooks post here (see agents.js).
  const presence = createPresence({ log })
  const agents = new AgentHub({
    notify: { ask: (a) => hub.externalAsk(a), askDone: (id, o) => hub.externalAskDone(id, o), emit: (ev) => hub.emit(ev) },
    presence, dir: dataDir, log,
  })
  // tools/pager-hook.mjs reads where to post and the shared token from here.
  let hookToken = ''
  function writeHookConfig() {
    const file = path.join(dataDir, 'hook.json')
    try { hookToken = JSON.parse(fs.readFileSync(file, 'utf8')).token || '' } catch {}
    if (!/^[0-9a-f]{64}$/.test(hookToken)) hookToken = crypto.randomBytes(32).toString('hex')
    try {
      fs.mkdirSync(dataDir, { recursive: true })
      fs.writeFileSync(file, JSON.stringify({ url: `http://${apiHost()}:${servePort()}/m/api/agents/hook`, token: hookToken }, null, 1), { mode: 0o600 })
    } catch (err) { log(`agents: cannot write hook.json: ${err.message}`) }
  }
  const hookTimer = setTimeout(writeHookConfig, 3000)
  hookTimer.unref?.()

  // Sessions found on disk (before the hooks were installed, or after a restart
  // emptied the hub). Rescanned at most every 15 s; each file refolded only when it changed.
  const diskMeta = new Map()
  let diskList = null
  const baseName = (p) => String(p || '').split(/[\\/]/).filter(Boolean).pop() || ''
  function diskSessions() {
    if (diskList && Date.now() - diskList.at < 15000) return diskList.v
    const v = recentFiles({ days: 7, max: 30, ...transcripts }).map((f) => {
      let m = diskMeta.get(f.file)
      if (!m || m.size !== f.size || m.mtime !== f.at) {
        m = { size: f.size, mtime: f.at, title: '', cwd: '' }
        // Folder and first prompt from the head; Claude Code's own titles are rewritten near the end.
        try { const h = headMeta(f.file, f.src); m.cwd = h.cwd; m.title = h.title } catch {}
        if (f.src === 'claude') { try { const x = foldFile(f.file, f.src, 256 * 1024); m.title = x.title || m.title; m.cwd = m.cwd || x.cwd } catch {} }
        diskMeta.set(f.file, m)
      }
      return { id: `agent:${f.src}:${f.id}`, src: f.src, sid: f.id, name: SOURCES[f.src], project: baseName(m.cwd), cwd: m.cwd, title: m.title, at: f.at, run: false, asks: 0, file: f.file }
    })
    diskList = { at: Date.now(), v }
    return v
  }
  /** Everything known about one agent session: hub state first, disk as fallback. */
  function agentInfo(key) {
    const live = agents.get(key)
    const disk = diskSessions().find((x) => x.id === key)
    if (!live && !disk) return null
    const [, src, sid] = /^agent:([a-z]+):(.+)$/.exec(key) || []
    return { key, src, sid, cwd: (live && live.cwd) || (disk && disk.cwd) || '', file: (live && live.transcript) || (disk && disk.file) || '', title: (live && live.title) || (disk && disk.title) || '' }
  }
  function agentSessions() {
    if (!externalAgents) return []
    const disk = new Map(diskSessions().map((x) => [x.id, x]))
    // A session the hooks only saw ask for permission (e.g. after a restart) has no title yet; its file does.
    const live = agents.list().map((x) => { const d = disk.get(x.id); return d ? { ...x, title: x.title || d.title, cwd: x.cwd || d.cwd, project: x.project || d.project } : x })
    const seen = new Set(live.map((x) => x.id))
    return live.concat([...disk.values()].filter((x) => !seen.has(x.id)).map(({ file, sid, ...x }) => x)).sort((a, b) => b.at - a.at).slice(0, 30)
  }
  // Session files a phone is looking at: a change means "refetch" (debounced), for 10 minutes after the last look.
  const watched = new Map()
  function watchFile(file) {
    const w = watched.get(file)
    if (w) { w.until = Date.now() + 600000; return }
    if (watched.size >= 8) {
      const oldest = [...watched.entries()].sort((a, b) => a[1].until - b[1].until)[0]
      oldest[1].w.close()
      watched.delete(oldest[0])
    }
    let t = null
    try {
      const fw = fs.watch(file, () => { clearTimeout(t); t = setTimeout(() => agents.emit('change'), 1500) })
      fw.on('error', () => { fw.close(); watched.delete(file) })
      watched.set(file, { w: fw, until: Date.now() + 600000 })
    } catch {}
  }
  const watchSweep = setInterval(() => { for (const [f, w] of watched) if (w.until < Date.now()) { w.w.close(); watched.delete(f) } }, 60000)
  watchSweep.unref()
  const bins = resolveBins()
  function hookCaller(req) {
    const got = Buffer.from(String(req.headers['x-pager-token'] || ''))
    const want = Buffer.from(hookToken)
    // Relayed phone traffic also arrives from 127.0.0.1: the token is the gate, and browsers (Origin) never are callers.
    return want.length === 64 && got.length === want.length && crypto.timingSafeEqual(got, want) && !req.headers.origin
  }

  async function dsh(method, payload, timeoutMs = 30000, rpcId = crypto.randomUUID()) {
    if (hostRpc) { try { return { ok: true, value: await hostRpc(method, payload, timeoutMs, rpcId) } } catch (e) { return { ok: false, error: { code: e.code || "host-error", message: e.message } } } }
    const res = await fetch(`${base()}/api/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'client-request', rpcId, method, payload }),
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (!res.ok) throw Object.assign(new Error(`DSH ${method} HTTP ${res.status}`), { status: 502, code: `http-${res.status}` })
    return (await res.json()).result
  }

  async function value(method, payload, timeoutMs) {
    const r = await dsh(method, payload, timeoutMs)
    if (!r || !r.ok) throw Object.assign(new Error((r && r.error && r.error.message) || `${method} failed`), { status: 502, code: r && r.error && r.error.code })
    return r.value
  }

  // ---- static -------------------------------------------------------------

  /** index.html with app.css/app.js inlined; rebuilt only when a file changes. */
  function buildShell() {
    const files = ['index.html', 'folder-picker.css', 'app.css', 'folder-picker.js', 'app.js'].map((f) => path.join(WWW, f))
    const key = files.map((f) => { const s = fs.statSync(f); return `${s.mtimeMs}:${s.size}` }).join('|')
    if (shell && shell.key === key) return shell
    // HTML parsers normalize CRLF before CSP hashes are checked. Normalize
    // before hashing too, including when a Windows editor rewrites app.js.
    const [html, pickerCss, appCss, pickerJs, appJs] = files.map((f) => normalizeHtmlNewlines(fs.readFileSync(f, 'utf8')))
    const css = `${pickerCss}\n${appCss}`
    const js = `${pickerJs}\n;\n${appJs}`
    const jsHash = crypto.createHash('sha256').update(js).digest('base64')
    // Replacement functions, not strings: app.js contains `$` sequences that
    // String.replace would otherwise interpret as substitution patterns.
    const out = html.replace('<!--CSS-->', () => `<style>${css}</style>`).replace('<!--JS-->', () => `<script>${js}</script>`)
    const raw = Buffer.from(out)
    shell = {
      key,
      raw,
      gz: zlib.gzipSync(raw, { level: 9 }),
      etag: `"${crypto.createHash('sha1').update(raw).digest('base64url')}"`,
      csp: `default-src 'self'; script-src 'sha256-${jsHash}'; worker-src 'self'; media-src 'self' blob:; manifest-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'`,
    }
    return shell
  }

  function serveShell(req, res) {
    const s = buildShell()
    const headers = { etag: s.etag, 'cache-control': 'no-cache', 'content-security-policy': s.csp, vary: 'accept-encoding', 'referrer-policy': 'no-referrer' }
    if (req.headers['if-none-match'] === s.etag) { res.writeHead(304, headers); res.end(); return }
    const gz = acceptsGzip(req)
    const body = gz ? s.gz : s.raw
    res.writeHead(200, { ...headers, 'content-type': MIME['.html'], 'content-length': body.length, ...(gz ? { 'content-encoding': 'gzip' } : {}) })
    res.end(req.method === 'HEAD' ? undefined : body)
  }

  function serveAsset(rel, req, res) {
    const file = path.resolve(WWW, rel)
    const type = MIME[path.extname(file).toLowerCase()]
    if (!file.startsWith(WWW + path.sep) || !type || /(^|[\\/])app\.(js|css)$/.test(rel)) { res.writeHead(404); res.end(); return }
    fs.readFile(file, (err, buf) => {
      if (err) { res.writeHead(404); res.end(); return }
      // The service worker and manifest must update with the plugin, not a day later.
      const fresh = /^(sw\.js|manifest\.webmanifest|tasks\.(html|css|js)|folder-picker\.(css|js))$/.test(rel)
      const taskPolicy = rel === 'tasks.html' ? { 'content-security-policy': "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'self'; base-uri 'none'; form-action 'self'" } : {}
      res.writeHead(200, { 'content-type': type, 'content-length': buf.length, 'cache-control': fresh ? 'no-cache' : 'public, max-age=86400', ...taskPolicy })
      res.end(buf)
    })
  }

  // ---- api ----------------------------------------------------------------

  async function permissions(sessionId) {
    if (typeof sessionId !== 'string' || !sessionId) throw Object.assign(new Error('missing sessionId'), { status: 400 })
    const list = await value('session.list', {})
    const session = list.items.find(s => s.sessionId === sessionId && s.origin !== 'subagent')
    if (!session) throw Object.assign(new Error('找不到这个 DSH 对话'), { status: 404 })
    const exact = nativeStreams ? await value('session.projections', { sessionId }) : null
    const rawSelection = exact?.values?.permissions || session.projections?.values?.permissions
    const selection = nativeStreams && rawSelection ? { ...(await value('permissions/catalog', {})), ...rawSelection } : rawSelection
    if (!selection || !Array.isArray(selection.options)) throw Object.assign(new Error('这个对话暂不支持权限切换'), { status: 409 })
    return selection
  }

  async function selectPermission(payload) {
    const { sessionId, preset } = payload
    if (!PERMISSION_PRESETS.has(preset)) throw Object.assign(new Error('无效的权限模式'), { status: 400 })
    if (permissionWrites.has(sessionId)) throw Object.assign(new Error('正在切换权限，请稍候'), { status: 409 })
    permissionWrites.add(sessionId)
    try {
      const before = await permissions(sessionId)
      if (!before.options.some(o => o.value === preset)) throw Object.assign(new Error('当前电脑不支持这个权限模式'), { status: 409 })
      if (before.currentValue === preset) return before
      if (preset === 'danger-full-access' && payload.confirmFullAccess !== true) throw Object.assign(new Error('请先确认启用完全访问'), { status: 400 })
      // The native picker invokes commands/execute, never a model prompt.
      const result = await value('commands/execute', { args: { agentId: sessionId, line: '/permission ' + preset, images: [] } })
      if (result?.result?.kind !== 'success') throw Object.assign(new Error(result?.result?.text || '电脑未执行权限切换'), { status: 409 })
      const after = await permissions(sessionId)
      if (after.currentValue !== preset) throw Object.assign(new Error('权限状态已变化，请重新查看后再操作'), { status: 409 })
      return after
    } finally { permissionWrites.delete(sessionId) }
  }

  async function boot() {
    const timed = (m) => { const t = Date.now(); return value(m, {}).then((v) => v, (e) => { log(`boot ${m} failed after ${Date.now() - t}ms: ${e.message}`); throw e }) }
    const [ws, sl] = await Promise.all([timed('workspace.list'), timed('session.list')])
    const archived = new Set(ws.archivedSessionIds || [])
    const owner = new Map()
    for (const w of ws.items) for (const id of w.sessionIds) owner.set(id, w.workspaceId)
    const sessions = []
    const blanks = {}
    for (const s of sl.items) {
      if (s.origin === 'subagent' || archived.has(s.sessionId)) continue
      const w = owner.get(s.sessionId) || null
      const questions = w ? await asyncQuestions.list(s.sessionId) : []
      const aq = questions.filter(q => !q.answer || !['accepted', 'not-needed'].includes(q.delivery)).length
      if (s.blank && !voices.has(s.sessionId) && !questions.length) { if (w && !blanks[w] && !s.running) blanks[w] = s.sessionId; continue }
      const v = (s.projections && s.projections.values) || {}
      const row = { id: s.sessionId, title: typeof v.title === 'string' ? v.title : '', at: s.updatedAt, run: s.running, w }
      if (aq) row.aq = aq
      // Context-window use, only when it starts to matter: the chat header warns from 70%.
      const u = foldUsage(v)
      if (u && u.ctxPct >= 50) row.cx = u.ctxPct
      sessions.push(row)
    }
    return {
      workspaces: ws.items.map((w) => ({ id: w.workspaceId, title: w.title, path: w.path })),
      sessions,
      blanks,
      dshVersion: DSH_VERSION,
    }
  }

  /** Usage from DSH's own per-session projections (cumulative per session, not per day). */
  async function usage(url) {
    const only = url.searchParams.get('s')
    const days = Math.min(90, Math.max(1, Number(url.searchParams.get('days')) || 7))
    const [ws, sl] = await Promise.all([value('workspace.list', {}), value('session.list', {})])
    const archived = new Set(ws.archivedSessionIds || [])
    const owner = new Map()
    for (const w of ws.items) for (const id of w.sessionIds) owner.set(id, w.workspaceId)
    const since = Date.now() - days * 864e5
    const totals = { in: 0, out: 0, cacheRead: 0, cacheWrite: 0, turns: 0, llmMs: 0, sessions: 0 }
    const rows = []
    for (const s of sl.items) {
      if (s.origin === 'subagent') continue
      if (only ? s.sessionId !== only : s.blank || archived.has(s.sessionId) || !(s.updatedAt >= since)) continue
      const v = (s.projections && s.projections.values) || {}
      const u = foldUsage(v)
      if (!u) continue
      rows.push({ id: s.sessionId, title: typeof v.title === 'string' ? v.title : '', w: owner.get(s.sessionId) || null, at: s.updatedAt, u })
      for (const k of ['in', 'out', 'cacheRead', 'cacheWrite', 'turns', 'llmMs']) totals[k] += u[k] || 0
      totals.sessions++
    }
    const size = (u) => (u.in || 0) + (u.out || 0) + (u.cacheRead || 0) + (u.cacheWrite || 0)
    rows.sort((a, b) => size(b.u) - size(a.u))
    return { days, totals, sessions: rows.slice(0, 30) }
  }

  async function history(url) {
    const sessionId = url.searchParams.get('s')
    if (!sessionId) throw Object.assign(new Error('missing s'), { status: 400, code: 'bad-request' })
    const before = url.searchParams.get('before')
    const n = Math.min(100, Math.max(1, Number(url.searchParams.get('n')) || 30))
    const payload = { sessionId, maxMessages: n }
    if (before !== null && before !== '') payload.beforeSeq = Number(before)
    const v = await value('session.history', payload, 90000)
    // history has no running field in DSH 0.1.1-rc.2; only list carries it.
    // Keep history usable when that separate status read is unavailable.
    let run
    try {
      const sl = await value('session.list', {})
      const s = sl.items.find((x) => x.sessionId === sessionId)
      if (s && typeof s.running === 'boolean') run = s.running
    } catch { log('history: session run state unavailable') }
    const f = foldHistory(v.events, run)
    const pv = (v.projections && v.projections.values) || {}
    return { ...f, run, hasMore: Boolean(v.hasMore), title: f.title || (typeof pv.title === 'string' ? pv.title : undefined) }
  }

  // ---- app self-update -------------------------------------------------------

  /** The APK to offer and its build.sh metadata, or null when there is none. */
  function appBuild() {
    let files = appApk ? [appApk] : []
    if (!appApk) {
      const out = path.join(PLUGIN_DIR, '..', 'android', 'out')
      let pub = []
      try { pub = fs.readdirSync(out).filter((f) => /^dsh-pager-v[\d.]+\.apk$/.test(f)).map((f) => path.join(out, f)) } catch {}
      files = [path.join(out, 'DSH.apk'), ...pub.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)]
    }
    for (const f of files) {
      try {
        const meta = JSON.parse(fs.readFileSync(f + '.json', 'utf8'))
        if (Number.isInteger(meta.versionCode) && /^[0-9a-f]{64}$/.test(meta.sha256)) return { file: f, ...meta }
      } catch {}
    }
    return null
  }

  // ---- result viewer --------------------------------------------------------

  let wsCache = null
  async function rootOf(sessionId, fresh = false) {
    if (!sessionId) throw Object.assign(new Error('missing s'), { status: 400, code: 'bad-request' })
    if (sessionId.startsWith('agent:')) {
      if (!externalAgents) throw Object.assign(new Error('当前仅同步 DSH 自己的项目'), { status: 403, code: 'external-agents-disabled' })
      const s = agentInfo(sessionId)
      if (!s || !s.cwd) throw Object.assign(new Error('不知道这个会话的项目目录'), { status: 404, code: 'no-workspace' })
      return s.cwd
    }
    if (fresh || !wsCache || Date.now() - wsCache.at > 10000) wsCache = { at: Date.now(), v: await value('workspace.list', {}) }
    const w = wsCache.v.items.find((x) => (x.sessionIds || []).includes(sessionId))
    if (!w || !w.path) throw Object.assign(new Error('这个对话不属于任何工作区，没有可查看的文件'), { status: 404, code: 'no-workspace' })
    return w.path
  }

  /** One tool call with its full input, diff and output: the page ending at its result holds both. */
  async function callDetail(url) {
    const sessionId = url.searchParams.get('s')
    const id = url.searchParams.get('id')
    const seq = Number(url.searchParams.get('seq'))
    const rseqRaw = url.searchParams.get('rseq')
    const rseq = rseqRaw ? Number(rseqRaw) : NaN
    if (!sessionId || !id || !Number.isFinite(seq)) throw Object.assign(new Error('missing s/id/seq'), { status: 400, code: 'bad-request' })
    const end = Number.isFinite(rseq) && rseq > seq ? rseq : seq
    for (const maxMessages of [1, 4]) {
      const v = await value('session.history', { sessionId, maxMessages, beforeSeq: end + 1 }, 90000)
      let call = null
      let result = null
      for (const entry of v.events) {
        const e = entry && entry.event
        if (!e) continue
        if (e.type === 'tool/call' && e.data && e.data.callId === id) call = entry
        else if (e.type === 'tool/result' && resultCallId(e) === id) result = entry
      }
      if (call) return fullCall(call, result)
    }
    throw Object.assign(new Error('找不到这次操作的记录'), { status: 404, code: 'not-found' })
  }

  async function raw(url, req, res) {
    const download = url.searchParams.get('download') === '1'
    let { real, stat } = await confine(await rootOf(url.searchParams.get('s')), url.searchParams.get('path'))
    let type = MEDIA[path.extname(real).toLowerCase()]
    if (!stat.isFile() || !type) throw Object.assign(new Error('这种文件不能直接打开'), { status: 415, code: 'unsupported' })
    if (!download && url.searchParams.get('quality') === 'preview' && type.startsWith('video/')) {
      const p = previews.request(real, stat)
      if (p.state !== 'ready') throw Object.assign(new Error('流畅预览正在准备'), { status: 409, code: 'preview-not-ready' })
      real = p.file; stat = await fs.promises.stat(real); type = 'video/mp4'
    }
    const headers = {
      'content-type': type, 'accept-ranges': 'bytes', 'cache-control': 'private, no-cache',
      'x-content-type-options': 'nosniff',
      // An SVG opened directly must not run script.
      'content-security-policy': "default-src 'none'; img-src 'self' data:; media-src 'self'; style-src 'unsafe-inline'; sandbox",
      'content-disposition': `${download ? 'attachment' : 'inline'}; filename*=UTF-8''${encodeURIComponent(path.basename(real)).replace(/[!'()*]/g, c => '%' + c.charCodeAt(0).toString(16).toUpperCase())}`,
    }
    const range = parseRange(req.headers.range, stat.size)
    if (range === false) { res.writeHead(416, { ...headers, 'content-range': `bytes */${stat.size}` }); res.end(); return }
    const { start, end } = range || { start: 0, end: stat.size - 1 }
    const length = stat.size ? end - start + 1 : 0
    res.writeHead(range ? 206 : 200, { ...headers, 'content-length': length, ...(range ? { 'content-range': `bytes ${start}-${end}/${stat.size}` } : {}) })
    if (req.method === 'HEAD' || !length) { res.end(); return }
    const stream = fs.createReadStream(real, { start, end })
    stream.on('error', () => res.destroy())
    req.on('close', () => stream.destroy())
    stream.pipe(res)
  }

  async function image(url, req, res) {
    const v = await value('session.attachment', { sessionId: url.searchParams.get('s'), attachmentId: url.searchParams.get('id') }, 60000)
    const buf = Buffer.from(v.data, 'base64')
    res.writeHead(200, { 'content-type': v.attachment.mediaType, 'content-length': buf.length, 'cache-control': 'private, max-age=31536000, immutable' })
    res.end(buf)
  }

  async function respond(body) {
    if (nativeRespond) return nativeRespond(body)
    if (typeof body.rpcId !== 'string' || !body.result || typeof body.result.ok !== 'boolean') throw Object.assign(new Error('bad respond body'), { status: 400 })
    const res = await fetch(`${base()}/api/respond`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'client-response', rpcId: body.rpcId, result: body.result }),
      signal: AbortSignal.timeout(30000),
    })
    if (!res.ok) {
      // A 4xx from DSH is about this answer (unknown rpcId, already settled),
      // not about the computer being offline. Keep the status and the host's
      // own wording so the phone can stop saying "家里电脑暂时连不上" for an
      // answer the host already has.
      let detail = ''
      try { const payload = await res.json(); detail = (payload && payload.error && payload.error.message) || '' } catch {}
      const status = res.status >= 400 && res.status < 500 ? res.status : 502
      throw Object.assign(new Error(detail || `respond HTTP ${res.status}`), { status })
    }
    return res.json()
  }

  async function api(route, url, req, res) {
    const isPost = req.method === 'POST'
    if (isPost && !/^application\/json\b/.test(req.headers['content-type'] || '')) return json(req, res, 415, { ok: false, error: { code: 'bad-content-type', message: 'application/json required' } })
    try {
      if (route === 'suggestions') {
        if (!isPost) return json(req,res,405,{ok:false,error:{message:'POST required'}})
        const body=await readJson(req,2048),sid=body.sessionId||body.session
        if(typeof sid!=='string'||!/^session-[a-zA-Z0-9-]{1,160}$/.test(sid))return json(req,res,400,{ok:false,error:{message:'无效会话'}})
        await rootOf(sid)
        if(typeof suggestionProvider!=='function')return json(req,res,200,{ok:true,value:{text:'',revision:''}})
        const controller=new AbortController(),abort=()=>{if(!res.writableEnded)controller.abort()};res.on('close',abort)
        try{const result=await suggestionProvider(sid,controller.signal);if(!res.destroyed)return json(req,res,200,{ok:true,value:result})}finally{res.off('close',abort)}
        return
      }
      if (route === 'folders' || route === 'folders/workspace') {
        if (route === 'folders' && req.method === 'GET') return json(req, res, 200, { ok: true, value: await remoteFolders.list(url.searchParams.get('path')) })
        if (route === 'folders/workspace' && isPost) return json(req, res, 200, { ok: true, value: await remoteFolders.add(await readJson(req, 8192)) })
        return json(req, res, 405, { ok: false, error: { code: 'method-not-allowed', message: '不支持的文件夹操作' } })
      }
      if (route === 'async-questions' || route === 'async-questions/create') {
        if (!['GET', 'POST'].includes(req.method)) return json(req, res, 405, { ok: false, error: { code: 'method-not-allowed', message: 'unsupported method' } })
        const body = isPost ? await readJson(req, 32768) : null
        const sid = isPost ? body.s : url.searchParams.get('s')
        if (typeof sid !== 'string' || !sid.startsWith('session-')) throw Object.assign(new Error('仅支持当前 DSH 会话'), { status: 400 })
        await rootOf(sid, true)
        if (route.endsWith('/create')) {
          if (!isPost) return json(req, res, 405, { ok: false, error: { message: 'POST required' } })
          if (body.kind !== 'clarification') throw Object.assign(new Error('审批与必要确认不能设置超时继续'), { status: 400 })
          if (typeof body.independentWork !== 'string' || !body.independentWork.trim()) throw Object.assign(new Error('必须说明不依赖答案也能继续的工作'), { status: 400 })
          const record = await asyncQuestions.create({ sessionId: sid, kind: 'clarification', question: body.question, options: body.options || [], independentWork: body.independentWork, waitMs: 60000, requestId: body.requestId })
          const abort = new AbortController()
          const cancelled = () => { if (!res.writableEnded) abort.abort() }
          res.on('close', cancelled)
          try { return json(req, res, 200, { ok: true, value: await asyncQuestions.wait(record.id, { signal: abort.signal }) }) }
          finally { res.off('close', cancelled) }
        }
        if (!isPost) return json(req, res, 200, { ok: true, value: { items: await asyncQuestions.list(sid) } })
        return json(req, res, 200, { ok: true, value: await asyncQuestions.answer(sid, body.id, { answer: body.answer, answerId: body.answerId }) })
      }
      if (route === 'voice' || route === 'voice/audio' || route === 'voice/events') {
        if (route === 'voice/events' && req.method !== 'GET') return json(req, res, 405, { ok: false, error: { code: 'method-not-allowed', message: 'voice events require GET' } })
        if (!['GET', 'HEAD', 'POST'].includes(req.method) || (route === 'voice/audio' && isPost)) return json(req, res, 405, { ok: false, error: { code: 'method-not-allowed', message: 'unsupported voice method' } })
        const body = isPost ? await readJson(req, MAX_AUDIO * 4 / 3 + 200000) : null
        const s = voiceSession(isPost ? body?.s : url.searchParams.get('s'))
        const workspace = await rootOf(s, true)
        if (!(await fs.promises.stat(workspace)).isDirectory()) throw Object.assign(new Error('对话工作区不存在'), { status: 404 })
        if (route === 'voice/events') { await fs.promises.access(workspace, fs.constants.R_OK); return subscribeVoice(s, req, res) }
        if (route === 'voice' && isPost) {
          const item = voices.put(body)
          voiceSaved(s, item)
          return json(req, res, 200, { ok: true, value: item })
        }
        if (route === 'voice') return json(req, res, 200, { ok: true, value: { items: voices.list(s) } })
        const { mime, bytes } = voices.audio(s, url.searchParams.get('id'), { group: url.searchParams.get('group') === '1', rev: url.searchParams.get('rev') })
        const headers = { 'content-type': mime, 'cache-control': 'private, no-store', 'accept-ranges': 'bytes', 'x-content-type-options': 'nosniff' }
        const range = parseRange(req.headers.range, bytes.length)
        if (range === false) { res.writeHead(416, { ...headers, 'content-range': `bytes */${bytes.length}` }); res.end(); return }
        const { start, end } = range || { start: 0, end: bytes.length - 1 }
        res.writeHead(range ? 206 : 200, { ...headers, 'content-length': end - start + 1, ...(range ? { 'content-range': `bytes ${start}-${end}/${bytes.length}` } : {}) })
        res.end(req.method === 'HEAD' ? undefined : bytes.subarray(start, end + 1)); return
      }
      if (!externalAgents && route.startsWith('agents/') && route !== 'agents/hook') return json(req, res, 403, { ok: false, error: { code: 'external-agents-disabled', message: '当前仅同步 DSH 自己的项目' } })
      if (route === 'ping' && !isPost) return json(req, res, 200, { ok: true, t: Date.now() })
      if (route === 'desktop/screenshot' && isPost) {
        // The phone relay rewrites Host/Origin. Require the untouched browser
        // Referer as well, so a remote /m page cannot open the PC capture UI.
        const localPeer = ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress)
        let localPage = false
        try {
          const origin = new URL(req.headers.origin), page = new URL(req.headers.referer)
          localPage = LOOPBACK.has(origin.hostname) && origin.host === req.headers.host && page.origin === origin.origin && page.pathname === '/' && /^https?:$/.test(origin.protocol)
        } catch {}
        if (!localPeer || !localPage || !trusted(req) || req.headers['x-forwarded-for'] || req.headers.forwarded || /Android|iPhone|iPad|DSHApp/i.test(req.headers['user-agent'] || '')) return json(req, res, 403, { ok: false, error: { code: 'local-only', message: '请在这台电脑的 DSH 对话中点击截图' } })
        await readJson(req, 4096)
        return json(req, res, 200, { ok: true, value: await screenshots.connection() })
      }
      if (route === 'desktop/workspace' && isPost) {
        const localPeer = ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress)
        if (!localPeer || !trusted(req) || req.headers['x-forwarded-for'] || req.headers.forwarded) return json(req, res, 403, { ok: false, error: { code: 'local-only', message: '请在电脑上的 DSH App 中选择文件夹' } })
        if (folderPick) return json(req, res, 409, { ok: false, error: { code: 'picker-busy', message: '文件夹选择窗口已打开' } })
        const controller = new AbortController()
        folderPick = controller
        const abort = () => { if (!res.writableEnded) controller.abort() }
        res.on('close', abort)
        try {
          const selected = await pickDirectory(controller.signal)
          if (controller.signal.aborted) return
          if (selected === null) return json(req, res, 200, { ok: true, value: { cancelled: true } })
          // Only the OS chooser supplies a path. Request bodies cannot inject one.
          if (typeof selected !== 'string' || !path.isAbsolute(selected) || !(await fs.promises.stat(selected)).isDirectory()) throw new Error('请选择存在的文件夹')
          const workspace = await value('workspace.create', { path: selected })
          return json(req, res, 200, { ok: true, value: workspace })
        } finally { res.removeListener('close', abort); folderPick = null }
      }
      if (route === 'boot' && !isPost) return json(req, res, 200, { ok: true, value: await boot() })
      if (route === 'history' && !isPost) return json(req, res, 200, { ok: true, value: await history(url) })
      if (route === 'img' && !isPost) return await image(url, req, res)
      if (route === 'call' && !isPost) return json(req, res, 200, { ok: true, value: await callDetail(url) })
      if (route === 'fs' && !isPost) return json(req, res, 200, { ok: true, value: await describeFile(await rootOf(url.searchParams.get('s')), url.searchParams.get('path')) })
      if (route === 'raw' && !isPost) return await raw(url, req, res)
      if (route === 'video' && !isPost) {
        const { real, stat } = await confine(await rootOf(url.searchParams.get('s')), url.searchParams.get('path'))
        if (!stat.isFile() || !((MEDIA[path.extname(real).toLowerCase()] || '').startsWith('video/'))) throw Object.assign(new Error('不是视频文件'), { status: 415, code: 'unsupported' })
        const original = '/m/api/raw?' + new URLSearchParams({ s: url.searchParams.get('s'), path: url.searchParams.get('path') })
        const p = stat.size < 2 * 1024 * 1024 && path.extname(real).toLowerCase() === '.mp4' ? { state: 'ready', original: true } : previews.request(real, stat)
        return json(req, res, 200, { ok: true, value: { state: p.state, url: original + (p.original ? '' : '&quality=preview'), original } })
      }
      if (route === 'events' && !isPost) return events(req, res)
      if (route === 'notify' && !isPost) {
        const since = url.searchParams.get('since')
        return hub.subscribe(req, res, { since: since === null ? undefined : Number(since), epoch: url.searchParams.get('epoch') || undefined, hb: Number(url.searchParams.get('hb')) || 120 })
      }
      if (route === 'rpc' && isPost) {
        const body = await readJson(req, 48 * 1024 * 1024)
        if (body.method === 'session.permissions') return json(req, res, 200, { ok: true, value: await permissions(body.payload?.sessionId) })
        if (body.method === 'session.selectPermission') return json(req, res, 200, { ok: true, value: await selectPermission(body.payload || {}) })
        if (!RPC_ALLOW.has(body.method)) return json(req, res, 400, { ok: false, error: { code: 'method-not-allowed', message: String(body.method) } })
        // A caller-minted rpcId comes back as user/message source.rpcId, which is
        // how the phone reconciles its optimistic "sending" bubble.
        const rpcId = typeof body.rpcId === 'string' && UUID.test(body.rpcId) ? body.rpcId : undefined
        if (body.method === 'session.prompt' && body.payload) hub.markPhone(body.payload.sessionId)
        return json(req, res, 200, await dsh(body.method, body.payload || {}, body.method === 'session.prompt' ? 180000 : 45000, rpcId))
      }
      if (route === 'respond' && isPost) {
        const body = await readJson(req, 1024 * 1024)
        if (typeof body.rpcId === 'string' && body.rpcId.startsWith('agent:')) {
          if (!externalAgents) return json(req, res, 403, { ok: false, error: { code: 'external-agents-disabled', message: '外部 Agent 不接入多端' } })
          const v = (body.result && body.result.value) || {}
          return json(req, res, 200, { ok: true, value: agents.decide(v.approvalId || body.rpcId.slice(6), v.outcome, { remember: Boolean(v.remember) }) })
        }
        return json(req, res, 200, { ok: true, value: await respond(body) })
      }
      if (route === 'agents/hook' && isPost) {
        if (!hookCaller(req)) return json(req, res, 403, { ok: false, error: { code: 'forbidden', message: 'bad hook token' } })
        const ev = await readJson(req, 16 * 1024 * 1024)
        if (!externalAgents) return json(req, res, 200, {}) // No opinion: the desktop tool handles its own approvals.
        // A held PermissionRequest answers when the phone does; the tool closing the hook cancels it.
        req.socket.setTimeout(0)
        const ac = new AbortController()
        res.on('close', () => { if (!res.writableEnded) ac.abort() })
        const answer = await agents.handle(url.searchParams.get('src'), ev, { signal: ac.signal })
        if (!res.destroyed) json(req, res, 200, answer)
        return
      }
      if (route === 'agents' && !isPost) {
        if (!externalAgents) return json(req, res, 200, { ok: true, value: { enabled: false, mode: 'pc', away: false, sessions: [], asks: [] } })
        const pc = presence.get()
        return json(req, res, 200, { ok: true, value: { enabled: true, mode: agents.settings.mode, away: agents.away(), pc: pc && { idleMs: pc.idleMs, locked: pc.locked }, sessions: agentSessions(), asks: agents.asks() } })
      }
      if (route === 'agents/history' && !isPost) {
        const key = url.searchParams.get('s') || ''
        const info = agentInfo(key)
        if (!info) throw Object.assign(new Error('找不到这个会话'), { status: 404, code: 'not-found' })
        let items
        let title = info.title
        let truncated = false
        if (info.file) {
          const f = foldFile(info.file, info.src)
          items = f.items
          title = f.title || title
          truncated = f.truncated
          watchFile(info.file)
        } else items = (agents.get(key) || { timeline: [] }).timeline.map((it) => ({ ...it }))
        return json(req, res, 200, { ok: true, value: { items, partial: null, firstSeq: items.length ? items[0].seq : -1, lastSeq: items.length ? items[items.length - 1].seq : -1, hasMore: false, truncated, title } })
      }
      if (route === 'agents/prompt' && isPost) {
        const b = await readJson(req, 64 * 1024)
        const info = agentInfo(b.s || '')
        if (!info) throw Object.assign(new Error('找不到这个会话'), { status: 404, code: 'not-found' })
        return json(req, res, 200, { ok: true, value: agents.prompt(info, b.text, { spawnImpl: spawnAgent, bins }) })
      }
      if ((route === 'app/latest' || route === 'app/apk') && !isPost) {
        const b = appBuild()
        if (!b) throw Object.assign(new Error('这台电脑上没有可用的 App 安装包'), { status: 404, code: 'no-apk' })
        if (route === 'app/latest') return json(req, res, 200, { ok: true, value: { versionCode: b.versionCode, versionName: b.versionName, sha256: b.sha256, size: b.size } })
        const st = fs.statSync(b.file)
        res.writeHead(200, { 'content-type': 'application/vnd.android.package-archive', 'content-length': st.size, 'cache-control': 'no-store', 'content-disposition': `attachment; filename="${path.basename(b.file)}"` })
        fs.createReadStream(b.file).on('error', () => res.destroy()).pipe(res)
        return
      }
      if (route === 'usage' && !isPost) return json(req, res, 200, { ok: true, value: await usage(url) })
      if (route === 'commands' && !isPost) return json(req, res, 200, { ok: true, value: quick.load(dataDir) })
      if (route === 'commands' && isPost) return json(req, res, 200, { ok: true, value: quick.save(dataDir, (await readJson(req, 128 * 1024)).items) })
      if (route === 'agents/mode' && isPost) { agents.setMode((await readJson(req, 4096)).mode); return json(req, res, 200, { ok: true, value: { mode: agents.settings.mode } }) }
      if (route === 'push/key' && !isPost) return json(req, res, 200, { ok: true, value: { publicKey: push.publicKey(), devices: push.list().length } })
      if (route === 'push/subscribe' && isPost) {
        const b = await readJson(req, 16 * 1024)
        return json(req, res, 200, { ok: true, value: { devices: push.subscribe(b.subscription, b.label) } })
      }
      if (route === 'push/unsubscribe' && isPost) return json(req, res, 200, { ok: true, value: { removed: push.unsubscribe((await readJson(req, 16 * 1024)).endpoint) } })
      if (route === 'push/test' && isPost) {
        const { endpoint } = await readJson(req, 16 * 1024)
        const sub = push.list().find((x) => x.endpoint === endpoint)
        if (!sub) throw Object.assign(new Error('这台设备还没开启推送'), { status: 404, code: 'not-subscribed' })
        const status = await push.sendTo(sub, { title: 'DSH 推送测试', body: '收到这条，说明锁屏提醒已经可以用了', tag: 'test' }, { urgency: 'high', ttl: 600 })
        return json(req, res, 200, { ok: true, value: { status } })
      }
      return json(req, res, 404, { ok: false, error: { code: 'not-found', message: route } })
    } catch (err) {
      if (route === 'folders' || route === 'folders/workspace') {
        const known = ['folders', 'outcome_unknown'].includes(err.code)
        return json(req, res, err.status && err.status < 500 ? err.status : 503, { ok: false, error: { code: known ? err.code : 'folders', message: known ? err.message : '电脑文件夹暂时不可用，请稍后刷新' } })
      }
      if (route === 'voice' || route === 'voice/audio' || route === 'voice/events') {
        const known = err.code === 'voice-storage' || err.code === 'no-workspace' || err.status === 413 || err.status === 400
        const status = known ? (err.status || 400) : (err.code === 'ENOENT' ? 404 : 503)
        return json(req, res, status, { ok: false, error: { code: 'voice-storage', message: known ? err.message : (status === 404 ? '对话工作区或语音不存在' : '语音存储暂时不可用，请稍后重试') } })
      }
      const status = err.status || 502
      if (status >= 500) log(`api ${route} failed: ${err.message}`)
      if (!res.headersSent) json(req, res, status, { ok: false, error: { code: err.code || (err.name === 'TimeoutError' ? 'timeout' : 'upstream'), message: err.message } })
      else res.end()
    }
  }

  function events(req, res) {
    res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache, no-transform', 'x-accel-buffering': 'no' })
    res.write('retry: 2000\n\n')
    const b = new Bridge(res, `ws://${apiHost()}:${apiPort()}`, log, () => bridges.delete(b), externalAgents ? agents : null, nativeStreams)
    bridges.add(b)
    req.on('close', () => b.close())
  }

  function serveLogin(req, res) {
    res.writeHead(200, {
      'content-type': MIME['.html'],
      'cache-control': 'no-store',
      'referrer-policy': 'no-referrer',
      'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; form-action 'self'",
    })
    res.end(req.method === 'HEAD' ? undefined : LOGIN_HTML)
  }

  async function handle(req, res) {
    try {
      const url = new URL(req.url || '/', 'http://local')
      const p = url.pathname
      // Public by design: the sign-in page only forwards a pasted token to DSH's
      // own token exchange, which decides whether it is valid.
      if (p === '/m/login') {
        if (authorizeRequest && (await authorizeRequest(req))?.ok) {
          res.writeHead(302, { location: '/m/', 'cache-control': 'no-store' }); res.end(); return
        }
        return serveLogin(req, res)
      }
      if (authorizeRequest) {
        const admission = await authorizeRequest(req)
        if (!admission?.ok) {
          // A browser navigation gets the sign-in page (the phone app has no
          // address bar to paste DSH's ?token= URL into); API calls keep JSON.
          const navigation = (p === '/m' || p === '/m/' || p === '/m/index.html')
            && /text\/html/i.test(req.headers.accept || '')
            && (req.method === 'GET' || req.method === 'HEAD')
          if (navigation) {
            res.writeHead(302, { location: '/m/login', 'cache-control': 'no-store' }); res.end(); return
          }
          return json(req, res, admission?.status || 403, { ok: false, error: { code: 'unauthorized', message: '需要登录已授权的 DSH 账号' } })
        }
      }
      if (p === '/m') { res.writeHead(308, { location: '/m/' + url.search }); res.end(); return }
      if (p === '/m/' || p === '/m/index.html') return serveShell(req, res)
      if (p.startsWith('/m/api/')) {
        if (!trusted(req, trustedHosts)) return json(req, res, 403, { ok: false, error: { code: 'forbidden', message: 'untrusted request' } })
        return await api(p.slice(7), url, req, res)
      }
      return serveAsset(decodeURIComponent(p.slice(3)), req, res)
    } catch (err) {
      log(`handler error: ${err && err.message}`)
      if (!res.headersSent) { res.writeHead(500); res.end() } else res.end()
    }
  }

  function close() {
    voiceStopped = true
    for (const watchers of [...voiceWatchers.values()]) for (const watcher of [...watchers]) watcher.close()
    screenshots.close()
    asyncQuestions.close()
    if (folderPick) folderPick.abort()
    previews.close()
    clearTimeout(hubTimer)
    clearTimeout(hookTimer)
    clearInterval(watchSweep)
    for (const w of watched.values()) w.w.close()
    agents.close()
    presence.close()
    hub.stop()
    for (const b of [...bridges]) b.close()
  }

  return { handle, close }
}

/**
 * One phone connection: DSH mux + host WebSockets in, compact SSE frames out.
 *
 * Text deltas are buffered per session and flushed every ~90 ms as
 * [seq, text] pairs (a raw chunk frame is ~250 bytes for a few characters);
 * the per-part seq lets the phone drop exactly the parts its history page
 * already contained. Any non-delta frame for a session flushes that
 * session's buffer first, so ordering is preserved.
 *
 * Upstream loss ends the SSE response; the phone's EventSource reconnects,
 * and the fresh mux replays still-pending approvals/questions.
 */
class Bridge {
  constructor(res, wsBase, log, onClose, agents, nativeStreams) {
    this.res = res
    this.log = log
    this.onClose = onClose
    this.agents = agents
    this.closed = false
    this.pending = new Map()
    this.timer = null
    this.toolSeen = new Map()
    this.turnAt = new Map()
    this.calls = new Map()
    // hello first: the phone clears pending approvals/questions on hello, and the
    // native subscription below replays still-pending ones synchronously.
    this.send({ t: 'hello', at: Date.now() })
    this.sockets = nativeStreams ? [] : [
      this.open(`${wsBase}/api/events.mux`, (env) => this.onMux(env)),
      this.open(`${wsBase}/api/events.host`, (env) => this.onHost(env)),
    ]
    if (nativeStreams) this.nativeDispose = nativeStreams({ onMux: env => this.onMux(env), onHost: env => this.onHost(env), onError: () => this.close() })
    // A data frame, not an SSE comment: EventSource hides comments from script,
    // and the phone's stall watchdog needs to see the heartbeat.
    this.ping = setInterval(() => this.send({ t: 'p' }), 15000)
    // Claude Code / Codex: their approvals use the same ask frames; anything else just says "refetch".
    if (agents) {
      const askFrame = (a) => ({ t: 'ask', s: a.s, rpc: a.rpc, id: a.id, tool: a.tool, title: a.what, detail: a.detail, why: a.title, remember: a.remember })
      this.onAgentAsk = (a) => this.send(askFrame(a))
      this.onAgentDone = (d) => this.send({ t: 'askDone', s: d.s, id: d.id, outcome: d.outcome })
      this.onAgentChange = () => {
        if (this.agentT) return
        this.agentT = setTimeout(() => { this.agentT = null; this.send({ t: 'agents' }) }, 300)
      }
      this.onAgentFail = (f) => this.send({ t: 'agentErr', s: f.s, msg: f.msg })
      agents.on('ask', this.onAgentAsk)
      agents.on('askDone', this.onAgentDone)
      agents.on('change', this.onAgentChange)
      agents.on('fail', this.onAgentFail)
      for (const a of agents.asks()) this.send(askFrame(a))
    }
  }

  open(url, onEnvelope) {
    const ws = new WebSocket(url)
    ws.onmessage = (ev) => {
      try { onEnvelope(JSON.parse(ev.data)) } catch (err) { this.log(`bridge frame error: ${err && err.message}`) }
    }
    ws.onerror = () => {}
    ws.onclose = () => this.close()
    return ws
  }

  write(s) {
    if (this.closed) return
    try { this.res.write(s) } catch { this.close() }
  }

  send(obj) {
    this.write(`data: ${JSON.stringify(obj)}\n\n`)
  }

  delta(s, seq, text) {
    let q = this.pending.get(s)
    if (!q) this.pending.set(s, (q = []))
    q.push([seq, text])
    if (!this.timer) this.timer = setTimeout(() => { this.timer = null; for (const id of [...this.pending.keys()]) this.flush(id) }, 90)
  }

  flush(s) {
    const q = this.pending.get(s)
    if (!q) return
    this.pending.delete(s)
    if (q.length) this.send({ t: 'd', s, p: q })
  }

  remember(item) {
    this.calls.set(item.id, { title: item.title, detail: item.detail })
    if (this.calls.size > 200) this.calls.delete(this.calls.keys().next().value)
  }

  onMux(env) {
    const f = env && env.payload
    if (!f) return
    const s = f.sessionId
    switch (f.type) {
      case 'session/event': return this.onEvent(s, f.event, f.view)
      case 'approval/requested':
        this.flush(s)
        return this.send({ t: 'ask', s, rpc: env.rpcId, id: f.approvalId, tool: f.toolName, call: f.callId, why: f.reason, ...(this.calls.get(f.callId) || {}) })
      case 'approval/resolved': return this.send({ t: 'askDone', s, id: f.approvalId, outcome: f.outcome })
      case 'question/requested': this.flush(s); return this.send({ t: 'q', s, rpc: env.rpcId, qs: f.questions })
      case 'question/resolved': return this.send({ t: 'qDone', s, rpc: f.questionRpcId, outcome: f.outcome })
      case 'session/queue': return this.send({ t: 'queue', s, items: foldQueue(f.items) })
      case 'session/projection':
        if (f.key === 'title' && typeof f.value === 'string') this.send({ t: 'title', s, title: f.value })
        if (f.key === 'permissions') this.send({ t: 'permissions', s, value: f.value })
        if (f.key === 'todos') this.send({ t: 'todo', s, todos: f.value })
        return
      case 'stream/error': return this.send({ t: 'err', msg: f.error && f.error.message })
    }
  }

  onEvent(s, e, view) {
    if (!e) return
    switch (e.type) {
      case 'assistant/chunk': {
        const c = e.data && e.data.chunk
        if (!c) return
        if (c.type === 'text-delta') return this.delta(s, e.seq, c.text)
        if (c.type === 'block-start' && c.blockType === 'reasoning') { this.flush(s); return this.send({ t: 'think', s, seq: e.seq }) }
        if (c.type === 'tool-call-delta' && c.name && c.id) {
          let seen = this.toolSeen.get(s)
          if (!seen) this.toolSeen.set(s, (seen = new Set()))
          if (seen.has(c.id)) return
          seen.add(c.id)
          this.flush(s)
          return this.send({ t: 'tooling', s, seq: e.seq, name: c.name })
        }
        return
      }
      case 'user/message': {
        const it = foldUser(e)
        if (!it) return
        this.flush(s)
        return this.send({ t: 'item', s, it })
      }
      case 'assistant/message': this.flush(s); return this.send({ t: 'final', s, seq: e.seq, it: foldAssistant(e) })
      case 'step/start': this.flush(s); return this.send({ t: 'step', s, seq: e.seq })
      case 'tool/call': {
        if (e.data && e.data.name === 'todo_write') return
        this.flush(s)
        const it = foldCall(e, view)
        this.remember(it)
        return this.send({ t: 'item', s, it })
      }
      case 'tool/result': this.flush(s); return this.send({ t: 'result', s, seq: e.seq, ...foldResult(e, view) })
      case 'turn/start': this.turnAt.set(s, e.time); return this.send({ t: 'turn', s, seq: e.seq })
      case 'turn/end': {
        this.flush(s)
        this.toolSeen.delete(s)
        const at = this.turnAt.get(s)
        this.turnAt.delete(s)
        return this.send({ t: 'item', s, it: { k: 'end', seq: e.seq, reason: (e.data && e.data.reason && e.data.reason.kind) || 'completed', ms: at !== undefined ? e.time - at : undefined } })
      }
      case 'session/title': return this.send({ t: 'title', s, title: e.data && e.data.title })
      case 'todo/write': return this.send({ t: 'todo', s, todos: e.data && e.data.todos })
    }
  }

  onHost(env) {
    const f = env && env.payload
    if (!f) return
    switch (f.type) {
      case 'host/session-status': return this.send({ t: 'run', s: f.sessionId, on: f.running })
      case 'host/agent-error': return this.send({ t: 'agentErr', s: f.sessionId, msg: f.message })
      case 'host/session-added':
      case 'host/session-removed':
      case 'host/workspace-changed':
      case 'host/workspace-removed':
      case 'host/workspace-order-changed':
      case 'host/archived-sessions-changed':
        return this.send({ t: 'list' })
    }
  }

  close() {
    if (this.closed) return
    this.closed = true
    clearInterval(this.ping)
    clearTimeout(this.timer)
    clearTimeout(this.agentT)
    if (this.agents) {
      this.agents.off('ask', this.onAgentAsk)
      this.agents.off('askDone', this.onAgentDone)
      this.agents.off('change', this.onAgentChange)
      this.agents.off('fail', this.onAgentFail)
    }
    this.nativeDispose?.()
    for (const ws of this.sockets) { try { ws.close() } catch {} }
    try { this.res.end() } catch {}
    this.onClose()
  }
}
