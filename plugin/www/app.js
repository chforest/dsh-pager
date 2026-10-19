'use strict'
/*
 * DSH phone client. Plain DOM, no framework, no build step.
 *
 * Data flow
 *   GET  /m/api/boot     -> workspaces + session list
 *   GET  /m/api/history  -> folded messages for one session (see fold.js)
 *   SSE  /m/api/events   -> live frames for every session (deltas, tool rows,
 *                           run status, approvals, questions, queue, todos)
 *   POST /m/api/rpc      -> prompt / cancel / create / models / rename ...
 *   POST /m/api/respond  -> approval & question answers
 *
 * Every live frame carries the session event seq; a chat drops frames its
 * history page already contained (seq <= lastSeq), so "load history, then keep
 * streaming" never duplicates or loses text.
 */
;(function () {
  var loadedUiSource = document.documentElement.outerHTML
  // ------------------------------------------------------------ utilities
  var $ = function (s) { return document.querySelector(s) }
  var ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return ESC[c] }) }
  function enc(s) { return encodeURIComponent(s) }
  function pad(n) { return (n < 10 ? '0' : '') + n }
  function uuid() {
    if (window.crypto && crypto.randomUUID) return crypto.randomUUID()
    var b = crypto.getRandomValues(new Uint8Array(16))
    b[6] = (b[6] & 15) | 64; b[8] = (b[8] & 63) | 128
    var h = Array.prototype.map.call(b, function (x) { return (x + 256).toString(16).slice(1) }).join('')
    return h.slice(0, 8) + '-' + h.slice(8, 12) + '-' + h.slice(12, 16) + '-' + h.slice(16, 20) + '-' + h.slice(20)
  }
  function buzz(ms) { try { if (navigator.vibrate) navigator.vibrate(ms || 10) } catch (e) {} }
  var TZ = (function () { try { return Intl.DateTimeFormat().resolvedOptions().timeZone } catch (e) { return undefined } })()
  var store = {
    get: function (k, d) { try { var v = localStorage.getItem('dsh.' + k); return v == null ? d : JSON.parse(v) } catch (e) { return d } },
    set: function (k, v) { try { localStorage.setItem('dsh.' + k, JSON.stringify(v)) } catch (e) {} },
  }

  function when(t) {
    var now = new Date(), d = new Date(t), diff = now - d
    if (diff < 60e3) return '刚刚'
    if (diff < 3600e3) return Math.floor(diff / 60e3) + '分钟前'
    var hm = pad(d.getHours()) + ':' + pad(d.getMinutes())
    var day0 = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
    if (t >= day0) return hm
    if (t >= day0 - 864e5) return '昨天 ' + hm
    if (d.getFullYear() === now.getFullYear()) return (d.getMonth() + 1) + '月' + d.getDate() + '日'
    return d.getFullYear() + '/' + (d.getMonth() + 1) + '/' + d.getDate()
  }
  function bucket(t) {
    var now = new Date(), day0 = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
    if (t >= day0) return 1
    if (t >= day0 - 864e5) return 2
    if (t >= day0 - 6 * 864e5) return 3
    return 4
  }
  function dur(ms) {
    var s = Math.round(ms / 1000)
    if (s < 60) return s + '秒'
    var m = Math.floor(s / 60)
    if (m < 60) return m + '分' + (s % 60 ? (s % 60) + '秒' : '')
    return Math.floor(m / 60) + '小时' + (m % 60 ? (m % 60) + '分' : '')
  }

  // ------------------------------------------------------------ icons
  var P = {
    settings: '<path d="M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8zM10 3h4l1 3 3 1 3 3v4l-3 1-1 3-3 3h-4l-1-3-3-1-3-3v-4l3-1 1-3z"/>',
    mic: '<rect x="8" y="2" width="8" height="13" rx="4"/><path d="M5 10v2a7 7 0 0 0 14 0v-2M12 19v3M8 22h8"/>',
    shield: '<path d="M12 3l8 3v6c0 5-8 9-8 9S4 17 4 12V6l8-3z"/><path d="M9 12l2 2 4-4"/>',
    search: '<circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    back: '<path d="M15 18l-6-6 6-6"/>',
    more: '<g fill="currentColor" stroke="none"><circle cx="5" cy="12" r="1.8"/><circle cx="12" cy="12" r="1.8"/><circle cx="19" cy="12" r="1.8"/></g>',
    send: '<path d="M12 19V5M5.5 11.5L12 5l6.5 6.5"/>',
    stop: '<rect x="7" y="7" width="10" height="10" rx="2" fill="currentColor" stroke="none"/>',
    image: '<rect x="3" y="4" width="18" height="16" rx="3"/><circle cx="9" cy="10" r="1.8"/><path d="M21 16l-5.2-5.2a1.5 1.5 0 0 0-2.1 0L5 19.5"/>',
    x: '<path d="M18 6L6 18M6 6l12 12"/>',
    check: '<path d="M20 6L9 17l-5-5"/>',
    chev: '<path d="M9 6l6 6-6 6"/>',
    down: '<path d="M12 5v14M5.5 12.5L12 19l6.5-6.5"/>',
    refresh: '<path d="M20 11a8 8 0 1 0-2.3 5.7M20 4v7h-7"/>',
    execute: '<path d="M4 17l6-5-6-5M12 19h8"/>',
    read: '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5M9 13h6M9 17h4"/>',
    edit: '<path d="M4 20h4L19.5 8.5a2.1 2.1 0 0 0-3-3L5 17v3zM14.5 7.5l3 3"/>',
    web: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18"/>',
    agent: '<rect x="4" y="8" width="16" height="12" rx="3"/><path d="M12 4v4M9 13v1.5M15 13v1.5"/>',
    other: '<path d="M14.7 6.3a4 4 0 0 0-5.4 5.2L4 16.8V20h3.2l5.3-5.3a4 4 0 0 0 5.2-5.4l-2.6 2.6-2.4-.6-.6-2.4z"/>',
    delete: '<path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/>',
    alert: '<path d="M12 3l9.5 17h-19zM12 10v4M12 17.5v.5"/>',
    cpu: '<rect x="6" y="6" width="12" height="12" rx="2"/><path d="M9 2v4M15 2v4M9 18v4M15 18v4M2 9h4M2 15h4M18 9h4M18 15h4"/>',
    folder: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
    copy: '<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"/>',
    pen: '<path d="M4 20h4L19.5 8.5a2.1 2.1 0 0 0-3-3L5 17v3z"/>',
    archive: '<rect x="3" y="4" width="18" height="5" rx="1.5"/><path d="M5 9v9a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V9M10 13h4"/>',
    circle: '<circle cx="12" cy="12" r="8"/>',
    dotc: '<circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="3" fill="currentColor" stroke="none"/>',
    checkc: '<circle cx="12" cy="12" r="9"/><path d="M8 12.5l2.5 2.5L16 9.5"/>',
    xc: '<circle cx="12" cy="12" r="9"/><path d="M15 9l-6 6M9 9l6 6"/>',
    bulb: '<path d="M9 18h6M10 21h4M12 3a6 6 0 0 0-3.5 10.9c.6.5 1 1.2 1 2.1h5c0-.9.4-1.6 1-2.1A6 6 0 0 0 12 3z"/>',
    zap: '<path d="M13 3L5 13.5h6L10 21l8-10.5h-6z"/>',
    steer: '<path d="M12 20V5M6 11l6-6 6 6"/><path d="M4 20h4M16 20h4"/>',
    clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3.5 2"/>',
    stats: '<path d="M5 20V11M12 20V5M19 20v-8"/>',
  }
  function ic(n, cls) { return '<svg class="i' + (cls ? ' ' + cls : '') + '" viewBox="0 0 24 24" aria-hidden="true">' + (P[n] || P.other) + '</svg>' }
  var KI = { execute: 'execute', read: 'read', edit: 'edit', search: 'search', web: 'web', fetch: 'web', agent: 'agent', delete: 'delete', move: 'edit', think: 'bulb', other: 'other' }
  function toolLabel(name) {
    if (!name) return '工具'
    if (/^mcp__chrome__/.test(name)) return '浏览器'
    return ({ pwsh: '终端', bash: '终端', read: '读取文件', read_image: '看图片', write: '写文件', edit: '编辑文件', grep: '搜索', glob: '找文件', web_search: '联网搜索', web_fetch: '打开网页', subagent: '子代理', todo_write: '更新进度' })[name] || name
  }

  // ------------------------------------------------------------ markdown
  // Escape first, then add a closed set of constructs; raw HTML never passes.
  var LI = /^(\s*)([-*+]|\d{1,3}[.)])\s+(.*)$/
  // A relative name is evidence of a file only for familiar file extensions.
  // Directories need an explicit ./ prefix or trailing separator. Uncertain
  // expressions stay text; existence is checked only when the user opens one.
  var FILE_NAME = /\.(?:mp4|m4v|webm|mov|mp3|m4a|aac|wav|ogg|flac|png|jpe?g|gif|webp|bmp|svg|ico|avif|pdf|docx?|xlsx?|pptx?|csv|tsv|txt|md|html?|json|jsonl|ya?ml|toml|xml|srt|vtt|ass|zip|7z|tar|gz|apk|exe|msi|py|js|mjs|cjs|jsx|ts|tsx|css|sql|sh|ps1|bat|cmd|log)$/i
  function localPath(p) {
    p = String(p || '').trim().replace(/^<|>$/g, '').replace(/^`|`$/g, '')
    if (/^file:\/\/\//i.test(p)) p = p.replace(/^file:\/\/\//i, '/')
    else if (/^[a-z][a-z0-9+.-]*:/i.test(p) && !/^[a-z]:[\\/]/i.test(p)) return null
    try { p = decodeURIComponent(p) } catch (e) { return null }
    p = p.replace(/^\/([a-z]:[\\/])/i, '$1').replace(/:\d+(?::\d+)?$/, '')
    if (!p || /[\x00-\x1f<>"|?*]/.test(p) || /^(?:[\\/]{2})/.test(p)) return null
    if (/(^|[\\/])\.\.([\\/]|$)/.test(p)) return null
    if (/\s+-{1,2}\S|\s*(?:&&|\|\||;)|\.(?:py|js|mjs|cjs|ps1|bat|cmd|sh|exe)\s+\S/i.test(p) || /^(?:node|python(?:\d+(?:\.\d+)*)?|pwsh|powershell|bash|sh|npm|npx|ffmpeg|ffprobe)\s/i.test(p)) return null
    if (!/^(?:[a-z]:[\\/]|\/)/i.test(p)) {
      if (/^[^\\/\s]+\.(?:com|cn|net|org|io|ai|gov|edu|co|app|dev|test)(?:[\\/]|$)/i.test(p)) return null
      if (!/^\.[\\/]/.test(p) && !/[\\/]$/.test(p) && !FILE_NAME.test(p)) return null
    }
    return p
  }
  function videoPath(p) { return /\.(mp4|m4v|webm|mov)$/i.test(p) }
  function resultPathKey(p, root) {
    var full = /^[a-z]:[\\/]|^[\\/]/i.test(p) ? p : String(root).replace(/[\\/]+$/, '') + '/' + p.replace(/^\.[\\/]/, '')
    var key = full.replace(/\\/g, '/').replace(/\/+/g, '/').replace(/\/\.(?=\/|$)/g, '').replace(/\/+$/, '')
    return /^[a-z]:\//i.test(key) ? key.toLowerCase() : key
  }
  function pathLink(p, label, ctx, explicit) {
    p = localPath(p)
    if (!ctx || !ctx.root || !p || (!explicit && !/[\\/]/.test(p)) || !inRoot(p, ctx.root)) return null
    var key = resultPathKey(p, ctx.root), previous = ctx.paths.find(function (other) { return resultPathKey(other, ctx.root) === key })
    if (previous) p = previous; else ctx.paths.push(p)
    return '<button class="file-link" ' + (videoPath(p) ? 'data-open-video' : 'data-result-path') + '="' + esc(p) + '">' + esc(label || p) + '</button>'
  }
  function inline(s, ctx) {
    var codes = []
    function token(h) { codes.push(h); return '\u0001' + (codes.length - 1) + '\u0002' }
    s = String(s).replace(/\[([^\]]+)\]\((<[^>\n]+>|[^)\n]+)\)/g, function (all, label, p) {
      var link = pathLink(p, label, ctx, true)
      return link ? token(link) : all
    })
    s = s.replace(/`([^`]+)`/g, function (_, c) { return token(pathLink(c, c, ctx) || '<code>' + esc(c) + '</code>') })
    // Quoted/Markdown paths support spaces; plain URLs and commands stay text.
    s = s.replace(/(^|[\s（(])((?:\/?[a-z]:[\\/]|\.?[\w\u3400-\u9fff-]+[\\/])[^\s<>"'`|，。；！？()]+)(?=$|[\s，。；！？)])/gi, function (all, prefix, p, offset) {
      var before = s.slice(0, offset + prefix.length), after = s.slice(offset + all.length)
      if (/^\s+-{1,2}\S/.test(after) || (/\.(?:py|js|mjs|cjs|ps1|bat|cmd|sh|exe)$/i.test(p) && /^\s+\S/.test(after)) || /(?:^|\s)(?:node|python(?:\d+(?:\.\d+)*)?|pwsh|powershell|bash|sh|npm|npx|ffmpeg|ffprobe)\s+$/i.test(before)) return all
      var link = pathLink(p, p, ctx)
      return link ? prefix + token(link) : all
    })
    s = esc(s)
    s = s.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, function (_, t, u) { return '<a href="' + u + '">' + t + '</a>' })
    s = s.replace(/(^|[\s(（：:，,])(https?:\/\/[^\s<>()（）]+[^\s<>()（）.,;:!?。，；：！？'"])/g, function (_, p, u) { return p + '<a href="' + u + '">' + u + '</a>' })
    s = s.replace(/\*\*(?=\S)([\s\S]*?\S)\*\*/g, '<b>$1</b>')
    s = s.replace(/(^|[^*\w])\*(?=\S)([^*]*?\S)\*(?![*\w])/g, '$1<i>$2</i>')
    s = s.replace(/~~(?=\S)([^~]*?\S)~~/g, '<s>$1</s>')
    return s.replace(/\u0001(\d+)\u0002/g, function (_, n) { return codes[n] })
  }
  function table(rows, ctx) {
    function cells(r) { return r.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map(function (c) { return c.trim() }) }
    var head = cells(rows[0])
    var body = rows.slice(2).map(cells)
    return '<div class="tbl"><table><thead><tr>' + head.map(function (c) { return '<th>' + inline(c, ctx) + '</th>' }).join('') + '</tr></thead><tbody>' +
      body.map(function (r) { return '<tr>' + r.map(function (c) { return '<td>' + inline(c, ctx) + '</td>' }).join('') + '</tr>' }).join('') + '</tbody></table></div>'
  }
  function list(lines, ctx) {
    var html = '', stack = []
    lines.forEach(function (line) {
      var m = LI.exec(line)
      if (!m) { html += '<br>' + inline(line.trim(), ctx); return }
      var ind = m[1].replace(/\t/g, '    ').length, tag = /\d/.test(m[2]) ? 'ol' : 'ul', text = m[3]
      while (stack.length && ind < stack[stack.length - 1].ind) html += '</li></' + stack.pop().tag + '>'
      var top = stack[stack.length - 1]
      if (!top || ind > top.ind) { html += '<' + tag + '><li>'; stack.push({ ind: ind, tag: tag }) } else html += '</li><li>'
      var ck = /^\[( |x|X)\]\s+/.exec(text)
      if (ck) { html += '<span class="ck">' + (ck[1] === ' ' ? '☐' : '☑') + '</span> '; text = text.slice(ck[0].length) }
      html += inline(text, ctx)
    })
    while (stack.length) html += '</li></' + stack.pop().tag + '>'
    return html
  }
  function md(src, ctx) {
    var L = String(src || '').replace(/\r\n?/g, '\n').split('\n'), out = '', para = [], i = 0, m
    function flush() { if (para.length) { out += '<p>' + para.map(function (line) { return inline(line, ctx) }).join('<br>') + '</p>'; para = [] } }
    while (i < L.length) {
      var l = L[i]
      if ((m = /^\s*(`{3,}|~{3,})\s*([^\s`]*)/.exec(l))) {
        flush()
        var fence = m[1], lang = m[2], buf = []
        i++
        while (i < L.length && L[i].trim().indexOf(fence) !== 0) buf.push(L[i++])
        i++
        out += '<pre class="code"><div class="code-h"><span>' + esc(lang || 'code') + '</span><button data-copy>复制</button></div><code>' + esc(buf.join('\n')) + '</code></pre>'
        continue
      }
      if (!l.trim()) { flush(); i++; continue }
      if (/^\s*\|.*\|\s*$/.test(l) && i + 1 < L.length && /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(L[i + 1])) {
        flush()
        var rows = []
        while (i < L.length && /^\s*\|.*\|\s*$/.test(L[i])) rows.push(L[i++])
        out += table(rows, ctx)
        continue
      }
      if ((m = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(l))) { flush(); var n = Math.min(5, m[1].length + 2); out += '<h' + n + '>' + inline(m[2], ctx) + '</h' + n + '>'; i++; continue }
      if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(l)) { flush(); out += '<hr>'; i++; continue }
      if (/^\s*>/.test(l)) {
        flush()
        var q = []
        while (i < L.length && /^\s*>/.test(L[i])) q.push(L[i++].replace(/^\s*>\s?/, ''))
        out += '<blockquote>' + md(q.join('\n'), ctx) + '</blockquote>'
        continue
      }
      if (LI.test(l)) {
        flush()
        var items = []
        while (i < L.length && (LI.test(L[i]) || (items.length && /^\s{2,}\S/.test(L[i])))) items.push(L[i++])
        out += list(items, ctx)
        continue
      }
      para.push(l)
      i++
    }
    flush()
    return out
  }
  function withCursor(html) {
    var k = Math.max(html.lastIndexOf('</p>'), html.lastIndexOf('</li>'))
    return k >= 0 && k > html.length - 16 ? html.slice(0, k) + '<i class="cursor"></i>' + html.slice(k) : html + '<i class="cursor"></i>'
  }

  // ------------------------------------------------------------ api
  // Reload and let the gateway run its own login flow (any gateway, any login
  // URL). A second bounce within 15 s means the gateway keeps refusing: stop.
  function toLogin() {
    var last = 0
    try { last = +sessionStorage.getItem('dsh.relogin') || 0 } catch (e) {}
    if (Date.now() - last < 15000) { setStatus('offline'); toast('需要重新登录网关', 'err'); return }
    try { sessionStorage.setItem('dsh.relogin', String(Date.now())) } catch (e) {}
    location.reload()
  }
  function handle(r) {
    if (r.type === 'opaqueredirect' || r.status === 401) { toLogin(); return Promise.reject(new Error('需要重新登录')) }
    if (r.status === 502 || r.status === 503 || r.status === 504) { setStatus('offline'); return Promise.reject(new Error('家里电脑暂时连不上')) }
    return r.json().then(function (j) {
      if (!j || !j.ok) throw Object.assign(new Error((j && j.error && j.error.message) || '请求失败'), { code: j && j.error && j.error.code })
      return j.value
    }, function () { throw new Error('请求失败 (HTTP ' + r.status + ')') })
  }
  function get(path) { return fetch(path, { cache: 'no-store', redirect: 'manual' }).then(handle) }
  function post(path, body, signal) { return fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), redirect: 'manual', signal: signal }).then(handle) }
  function rpc(method, payload, rpcId) { return post('/m/api/rpc', { method: method, payload: payload, rpcId: rpcId }) }
  // A phone link that dies mid-request leaves fetch pending forever: the answer
  // reaches the host but the promise never settles, so the card stayed on screen
  // and every later tap reported "expired". Cap the wait so the dock can move on
  // instead of hanging on a dead socket.
  function respond(rpcId, result) {
    var signal = typeof AbortSignal !== 'undefined' && AbortSignal.timeout ? AbortSignal.timeout(20000) : undefined
    return post('/m/api/respond', { rpcId: rpcId, result: result }, signal).then(null, function (err) {
      if (err && (err.name === 'TimeoutError' || err.name === 'AbortError')) throw new Error('发送超时，未收到回执')
      throw err
    })
  }
  function imgUrl(s, id) { return '/m/api/img?s=' + enc(s) + '&id=' + enc(id) }

  // ------------------------------------------------------------ state
  var S = {
    ws: [], wsById: {}, sessions: [], byId: {}, blanks: {},
    run: new Set(), asks: new Map(), qs: new Map(), chats: new Map(),
    filter: store.get('filter', 'all'), query: '', cur: null, booted: false, hellos: 0,
    att: [], drafts: store.get('drafts', {}), asyncDrafts: store.get('async-question-drafts', {}), status: 'connecting', uiUpdate: null,
    agents: { mode: 'auto', away: false, sessions: [] },
  }
  var el = {}
  ;['app', 'home', 'chat', 'status', 'chips', 'list', 'rows', 'ptr', 'fab', 'searchBox', 'q', 'cTitle', 'cSub', 'scroller', 'older', 'msgs', 'tail',
    'toBottom', 'dock', 'inputWrap', 'inputSuggestion', 'input', 'send', 'attach', 'quick', 'file', 'thumbs', 'sheetWrap', 'sheet', 'viewer', 'toast', 'head',
    'fv', 'fvBody', 'fvTitle', 'fvSub', 'fvAct', 'permission', 'mic', 'voiceBar', 'voiceState', 'voiceCaption', 'voiceFinish', 'voiceEnd', 'callPanel', 'callState', 'callClock', 'callCaption', 'callMute', 'callHangup', 'callInterrupt', 'voiceRetryReplies', 'holdTalk', 'voiceKeyboard', 'holdHint'].forEach(function (id) { el[id] = document.getElementById(id) })

  // Context suggestions are separate from the draft until explicitly accepted.
  var suggestion = { seen: new Set(), key: null, text: '', timer: null, controller: null, generation: 0, composing: false, placeholder: null }
  function hideSuggestion() {
    suggestion.generation++; clearTimeout(suggestion.timer); suggestion.timer = null
    if (suggestion.controller) suggestion.controller.abort(); suggestion.controller = null
    suggestion.key = null; suggestion.text = ''; el.inputSuggestion.hidden = true; el.inputSuggestion.textContent = ''; el.inputSuggestion.title = ''
    if (suggestion.placeholder !== null) { el.input.placeholder = suggestion.placeholder; suggestion.placeholder = null }
  }
  function suggestionKey() {
    var sid = S.cur, c = sid && S.chats.get(sid)
    if (!c || !c.loaded || isAgent(sid) || document.visibilityState !== 'visible' || el.input.value || S.att.length || isRunning(sid) || voice || voiceStarting || holdMode || holdGesture || suggestion.composing || pendingCount(sid) || (c.pending || []).length || c.partial || (c.queue || []).length) return null
    if ((c.asyncQuestions || []).some(function (q) { return q.status === 'waiting' || q.status === 'deferred' || (q.status === 'answered' && q.delivery !== 'accepted' && q.delivery !== 'not-needed') })) return null
    var end = -1, answer = null
    c.items.forEach(function (item, i) { if (item.k === 'end') end = i })
    if (end < 0 || c.items[end].reason !== 'completed' || c.items.slice(end + 1).some(function (item) { return item.k === 'u' || item.k === 'a' || item.k === 't' })) return null
    for (var i = end - 1; i >= 0 && c.items[i].k !== 'end' && c.items[i].k !== 'u'; i--) if (c.items[i].k === 'a' && c.items[i].text) { answer = c.items[i]; break }
    return answer ? sid + ':' + c.items[end].seq + ':' + answer.seq : null
  }
  function syncSuggestion() {
    var key = suggestionKey()
    if (suggestion.key === key) return
    hideSuggestion()
    if (!key || suggestion.seen.has(key)) return
    suggestion.key = key
    var generation = suggestion.generation, sid = S.cur
    suggestion.timer = setTimeout(function () {
      suggestion.timer = null
      if (suggestionKey() !== key || generation !== suggestion.generation) return
      var controller = new AbortController(); suggestion.controller = controller; suggestion.seen.add(key)
      fetch('/m/api/suggestions', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sessionId: sid }), signal: controller.signal, redirect: 'manual' }).then(handle).then(function (value) {
        if (generation !== suggestion.generation || suggestionKey() !== key) return
        suggestion.controller = null
        if (!value || typeof value.text !== 'string' || !value.text.trim()) return
        suggestion.text = value.text; suggestion.placeholder = el.input.placeholder; el.input.placeholder = ''; el.inputSuggestion.textContent = value.text; el.inputSuggestion.title = value.text; el.inputSuggestion.hidden = false
      }).catch(function () {})
    }, 1000)
  }
  function acceptSuggestion() {
    if (!suggestion.text || suggestion.key !== suggestionKey()) { hideSuggestion(); return false }
    var text = suggestion.text; hideSuggestion(); el.input.value = text; saveDraft(); autosize(); syncSend(); el.input.focus(); return true
  }

  function chatState(id) {
    return { id: id, items: [], pending: [], partial: null, lastSeq: -1, firstSeq: -1, hasMore: false, loaded: false, loading: false, err: false,
      buf: [], open: new Set(), processOpen: new Set(), resultOpen: new Set(), todos: null, todoOpen: false, queue: [], title: '', w: null, model: null, models: null }
  }
  // Auto titles occasionally arrive as Markdown ("**Session Title:** x").
  function cleanTitle(t) { return String(t || '').replace(/\*\*|__|`/g, '').replace(/^\s*(session\s*)?title\s*[:：]\s*/i, '').trim() }
  function wsOf(id) { var s = S.byId[id], c = S.chats.get(id); return (s && s.w) || (c && c.w) || null }
  function wsTitle(w) { return w ? (S.wsById[w] ? S.wsById[w].title : '') : '未归类' }
  // Claude Code / Codex sessions on the same PC: ids "agent:<src>:<session>".
  function isAgent(id) { return typeof id === 'string' && id.indexOf('agent:') === 0 }
  function agentOf(id) { var a = S.agents.sessions; for (var i = 0; i < a.length; i++) if (a[i].id === id) return a[i]; return null }
  function isRunning(id) { var a = isAgent(id) && agentOf(id); return S.run.has(id) || Boolean(a && a.run) }
  function pendingCount(id) {
    var n = 0
    S.asks.forEach(function (a) { if (a.s === id) n++ })
    S.qs.forEach(function (q) { if (q.s === id) n++ })
    return n
  }

  // ------------------------------------------------------------ status / toast
  function setStatus(st) {
    S.status = st
    el.status.className = 'status ' + st
    el.status.lastChild.textContent = { online: '已连接', connecting: '连接中', offline: '电脑离线' }[st]
    if (S.cur) renderHead()
  }
  var toastT = 0
  function toast(msg, kind) {
    el.toast.textContent = msg
    el.toast.className = 'toast on' + (kind ? ' ' + kind : '')
    clearTimeout(toastT)
    // Errors can carry a next step to read: keep them up longer, by length.
    toastT = setTimeout(function () { el.toast.className = 'toast' }, kind === 'err' ? Math.min(9000, 2600 + String(msg).length * 45) : 2600)
  }
  function copy(text) {
    function fallback() {
      var t = document.createElement('textarea')
      t.value = text; t.style.position = 'fixed'; t.style.opacity = '0'
      document.body.appendChild(t); t.select()
      try { document.execCommand('copy'); toast('已复制') } catch (e) { toast('复制失败', 'err') }
      t.remove()
    }
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(function () { toast('已复制') }, fallback)
    else fallback()
  }

  // ------------------------------------------------------------ home
  function sortedWorkspaces() {
    var last = {}
    S.sessions.forEach(function (s) { if (s.w) last[s.w] = Math.max(last[s.w] || 0, s.at) })
    return S.ws.slice().sort(function (a, b) { return (last[b.id] || 0) - (last[a.id] || 0) })
  }
  function renderChips() {
    var h = '<button class="chip' + (S.filter === 'all' ? ' on' : '') + '" data-f="all">全部</button>'
    sortedWorkspaces().forEach(function (w) { h += '<button class="chip' + (S.filter === w.id ? ' on' : '') + '" data-f="' + esc(w.id) + '">' + esc(w.title) + '</button>' })
    if (S.sessions.some(function (s) { return !s.w })) h += '<button class="chip' + (S.filter === 'none' ? ' on' : '') + '" data-f="none">未归类</button>'
    el.chips.innerHTML = h
  }
  function rowHtml(s) {
    var tag = pendingCount(s.id) ? '<span class="tag ask">待确认</span>' : isRunning(s.id) ? '<span class="tag run"><i></i>运行中</span>' : ''
    if (Number.isFinite(s.aq) && s.aq > 0) tag += '<span class="tag async-pending">待补充 ' + Math.floor(s.aq) + '</span>'
    return '<button class="row" data-open="' + esc(s.id) + '"><div class="mid"><div class="t' + (s.title ? '' : ' none') + '">' + esc(s.title || '未命名对话') +
      '</div><div class="m">' + tag + '<span>' + esc(wsTitle(s.w)) + '</span></div></div><span class="when">' + when(s.at) + '</span></button>'
  }
  var MODE_SHORT = { auto: '自动', phone: '手机', pc: '电脑' }
  var MODE_NAME = { auto: '自动', phone: '总是先问手机', pc: '只在电脑上确认' }
  var MODE_TXT = {
    auto: '电脑锁屏或 3 分钟没人操作时发到手机，一回到电脑就交还电脑',
    phone: '先发到手机；20 分钟没回应再交给电脑',
    pc: '不发到手机，只在电脑上弹确认框',
  }
  function agentRowHtml(a) {
    var tag = pendingCount(a.id) ? '<span class="tag ask">待确认</span>' : a.run ? '<span class="tag run"><i></i>运行中</span>' : ''
    return '<button class="row" data-open="' + esc(a.id) + '"><span class="fic">' + ic('execute', 's') + '</span><div class="mid"><div class="t' + (a.title ? '' : ' none') + '">' + esc(a.title || a.project || a.name) +
      '</div><div class="m">' + tag + '<span>' + esc(a.name + (a.project ? ' · ' + a.project : '')) + '</span></div></div><span class="when">' + when(a.at) + '</span></button>'
  }
  function agentsHtml() {
    if (S.filter !== 'all' || S.query || !S.agents.sessions.length) return ''
    return '<div class="sec sec-row">Claude Code / Codex<button class="secbtn" data-mode>确认发到：' + esc(MODE_SHORT[S.agents.mode] || S.agents.mode) + ic('chev', 's') + '</button></div>' +
      '<div class="grp agents">' + S.agents.sessions.slice(0, 6).map(agentRowHtml).join('') + '</div>'
  }
  function loadAgents() {
    return get('/m/api/agents').then(function (v) {
      S.agents = v
      if (v.enabled === false) {
        S.chats.forEach(function (c, id) { if (isAgent(id)) S.chats.delete(id) })
        S.asks.forEach(function (a, id) { if (isAgent(a.s)) S.asks.delete(id) })
        S.qs.forEach(function (q, id) { if (isAgent(q.s)) S.qs.delete(id) })
        if (isAgent(S.cur)) closeChat()
      }
      scheduleHome()
      if (S.cur && isAgent(S.cur)) { renderHead(); syncSend() }
    }, function () {})
  }
  var agentsT = 0
  function scheduleAgents() {
    clearTimeout(agentsT)
    agentsT = setTimeout(function () {
      loadAgents()
      var c = S.cur && isAgent(S.cur) && S.chats.get(S.cur)
      if (c && c.loaded && !c.loading) loadHistory(c)
    }, 250)
  }
  function modeSheet() {
    var cur = S.agents.mode
    openSheet('<div class="sh-h">Claude Code / Codex 的确认请求<small>它们要你允许某个操作时，发到哪里</small></div><div class="sh-b">' + ['auto', 'phone', 'pc'].map(function (m) {
      return '<button class="opt-row' + (m === cur ? ' on' : '') + '" data-m="' + m + '"><span class="ico">' + ic(m === 'pc' ? 'cpu' : 'alert', 's') + '</span><span class="mid"><b>' + MODE_NAME[m] + '</b><small>' + MODE_TXT[m] + '</small></span>' + (m === cur ? ic('check', 'chk') : '') + '</button>'
    }).join('') + '</div>')
    el.sheet.onclick = function (e) {
      var b = e.target.closest('[data-m]')
      if (!b) return
      post('/m/api/agents/mode', { mode: b.dataset.m }).then(function (v) { S.agents.mode = v.mode; buzz(); closeOverlay(); scheduleHome() }, function (err) { toast(err.message, 'err') })
    }
  }
  function renderHome() {
    renderChips()
    if (!S.booted) { el.rows.innerHTML = new Array(7).join('<div class="sk"></div>'); return }
    var list = S.sessions.filter(function (s) {
      // "全部" mirrors the desktop sidebar: only sessions that belong to a
      // workspace. Leftover ungrouped logs live under the "未归类" chip.
      if (S.filter === 'none' ? s.w : S.filter === 'all' ? !s.w : s.w !== S.filter) return false
      if (!S.query) return true
      var q = S.query.toLowerCase()
      return (s.title || '').toLowerCase().indexOf(q) >= 0 || wsTitle(s.w).toLowerCase().indexOf(q) >= 0
    }).sort(function (a, b) { return b.at - a.at })
    var h = ''
    if (S.uiUpdate) h += '<button class="alert upd" data-ui-update>' + ic('refresh') + '<span>界面有更新，点这里更新</span>' + ic('chev', 's') + '</button>'
    if (S.appUpdate) {
      h += S.appUpdate.self
        ? '<button class="alert upd" data-update>' + ic('down') + '<span>App 安装包有新版本 ' + esc(S.appUpdate.versionName) + '，点这里更新</span>' + ic('chev', 's') + '</button>'
        : '<div class="alert upd">' + ic('down') + '<span>App 安装包可以升级到 ' + esc(S.appUpdate.versionName) + '：这一次需要在电脑上安装，之后就能在手机上直接更新</span></div>'
    }
    var waiting = S.asks.size + S.qs.size
    if (waiting) {
      var first = (S.asks.values().next().value || S.qs.values().next().value).s
      h += '<button class="alert" data-open="' + esc(first) + '">' + ic('alert') + '<span>' + waiting + ' 个操作等你确认</span>' + ic('chev', 's') + '</button>'
    }
    h += agentsHtml()
    var groups = [['进行中', []], ['今天', []], ['昨天', []], ['最近 7 天', []], ['更早', []]]
    list.forEach(function (s) { groups[isRunning(s.id) || pendingCount(s.id) ? 0 : bucket(s.at)][1].push(s) })
    groups.forEach(function (g) { if (g[1].length) h += '<div class="sec">' + g[0] + '</div><div class="grp">' + g[1].map(rowHtml).join('') + '</div>' })
    if (!list.length) h += '<div class="empty"><b>' + (S.query ? '没有匹配的对话' : '这里还没有对话') + '</b>' + (S.query ? '' : '点右下角 + 开始') + '</div>'
    el.rows.innerHTML = h
  }
  var homeRaf = 0
  function scheduleHome() {
    if (homeRaf) return
    homeRaf = requestAnimationFrame(function () { homeRaf = 0; renderHome() })
  }
  // The last list is kept on the phone so a cold launch paints instantly;
  // the network copy replaces it a moment later.
  function loadBoot() {
    return get('/m/api/boot').then(function (v) {
      store.set('boot', v)
      applyBoot(v)
    })
  }
  function applyBoot(v) {
    S.ws = v.workspaces
    S.wsById = {}
    v.workspaces.forEach(function (w) { S.wsById[w.id] = w })
    S.blanks = v.blanks || {}
    S.dshVersion = v.dshVersion || ''
    var local = S.byId
    S.sessions = v.sessions
    S.byId = {}
    S.run = new Set()
    v.sessions.forEach(function (s) {
      s.title = cleanTitle(s.title)
      S.byId[s.id] = s
      if (s.run) S.run.add(s.id)
      if (!s.title && local[s.id] && local[s.id].title) s.title = local[s.id].title
    })
    if (S.filter !== 'all' && S.filter !== 'none' && !S.wsById[S.filter]) S.filter = 'all'
    S.booted = true
    renderHome()
    if (S.cur) { renderHead(); syncSend() }
  }
  var bootT = 0
  function scheduleBoot() { clearTimeout(bootT); bootT = setTimeout(function () { loadBoot().catch(function () {}) }, 500) }

  function setRun(id, on) {
    if (on) S.run.add(id); else S.run.delete(id)
    var s = S.byId[id]
    if (s) { s.run = on; s.at = Date.now() }
    else scheduleBoot() // a new (formerly blank) session just started: it now belongs in the list
    scheduleHome()
    if (id === S.cur) {
      if (voice && voice.sid === id && voice.waiting) {
        if (on) voice.responseSeen = true
        el.voiceFinish.textContent = on ? '打断并说' : '继续说'
        maybeResumeVoice(voice); syncHoldUi()
      }
      var c = S.chats.get(id)
      if (c && !on) c.partial = null
      renderHead(); syncSend(); drawDock()
      if (c) draw(c)
    }
  }
  function setTitle(id, t) {
    t = cleanTitle(t)
    if (!t) return
    var s = S.byId[id], c = S.chats.get(id)
    if (s) s.title = t
    if (c) c.title = t
    scheduleHome()
    if (id === S.cur) renderHead()
  }
  function touch(id) { var s = S.byId[id]; if (s) { s.at = Date.now(); scheduleHome() } }

  // ------------------------------------------------------------ navigation
  function show(view) { el.app.classList.toggle('in-chat', view === 'chat') }
  var attachmentGeneration = 0
  function pauseChatVoice() { cancelVoicePress(); stopVoiceQueue(); el.msgs.querySelectorAll('audio[data-voice-id]').forEach(function (audio) { audio.pause() }) }
  function clearAttachments() { attachmentGeneration++; S.att.forEach(function (item) { URL.revokeObjectURL(item.url) }); S.att = [] }
  function openChat(id, fromPop) {
    hideSuggestion()
    if (isAgent(id) && S.agents.enabled === false) { toast('当前仅同步 DSH 自己的项目'); return }
    if (!id) return
    var switched = S.cur !== id
    if (switched) { if (holdGesture) cancelHold(); holdMode = null; syncHoldUi(); pauseChatVoice(); clearAttachments() }
    if (voice && voice.sid !== id) stopVoice()
    if (S.cur && S.cur !== id) saveDraft()
    S.cur = id
    var c = S.chats.get(id)
    if (!c) { c = chatState(id); S.chats.set(id, c) }
    if (!fromPop) history.pushState({ v: 'chat', s: id }, '', '#' + enc(id))
    show('chat')
    var ag = isAgent(id)
    el.input.value = S.drafts[id] || ''
    el.input.placeholder = ag ? '继续这个会话（电脑在后台运行）' : '发消息给 DSH'
    el.attach.hidden = ag
    el.mic.hidden = ag || Boolean(voice)
    autosize()
    drawThumbs()
    renderHead()
    renderMsgs(c, true)
    drawDock()
    syncSend()
    if (!c.loaded && !c.loading) loadHistory(c)
    if (!ag) { loadAsyncQuestions(id); loadVoiceHistory(id); loadModel(c); loadPermissions(c).catch(function () {}) }
    syncHoldUi()
  }
  function closeChat() {
    hideSuggestion()
    if (holdGesture) cancelHold(); holdMode = null; syncHoldUi()
    pauseChatVoice(); clearAttachments()
    stopVoice()
    saveDraft()
    if (S.cur && !S.byId[S.cur]) scheduleBoot()
    S.cur = null
    show('home')
    el.dock.innerHTML = ''
    renderHome()
  }
  function saveDraft() {
    if (!S.cur) return
    var v = el.input.value
    if (v) S.drafts[S.cur] = v; else delete S.drafts[S.cur]
    store.set('drafts', S.drafts)
  }

  // Overlays (sheet, image viewer, file viewer levels) form a stack; each owns
  // one history entry, tagged with its depth, so Android back closes exactly
  // one level and history.go(-n) closes several.
  var overlays = [], closing = null
  function pushOverlay(kind, onClose) {
    overlays.push({ kind: kind, onClose: onClose })
    history.pushState(Object.assign({}, history.state, { o: kind, od: overlays.length }), '')
  }
  function hasOverlay(kind) { return overlays.some(function (o) { return o.kind === kind }) }
  function closeOverlay() {
    if (!overlays.length) return Promise.resolve()
    return new Promise(function (res) { closing = res; history.back() })
  }
  function closeAllOverlays() {
    if (!overlays.length) return Promise.resolve()
    return new Promise(function (res) { closing = res; history.go(-overlays.length) })
  }
  window.addEventListener('popstate', function (e) {
    var st = e.state || {}
    if (overlays.length > (st.od || 0)) {
      while (overlays.length > (st.od || 0)) overlays.pop().onClose()
      if (closing) { var done = closing; closing = null; done() }
      return
    }
    if (st.v === 'chat' && st.s) openChat(st.s, true)
    else if (S.cur) closeChat()
  })

  function openSheet(html) {
    voiceContextKey = null
    stopVoicePreview()
    el.sheet.onclick = null
    el.sheet.innerHTML = html
    el.sheetWrap.hidden = false
    requestAnimationFrame(function () { requestAnimationFrame(function () { el.sheetWrap.classList.add('on') }) })
    pushOverlay('sheet', function () {
      stopVoicePreview(); speakerView++
      el.sheetWrap.classList.remove('on')
      setTimeout(function () { if (!hasOverlay('sheet')) { el.sheetWrap.hidden = true; el.sheet.innerHTML = '' } }, 340)
    })
  }
  function view(src) {
    el.viewer.firstElementChild.src = src
    el.viewer.hidden = false
    pushOverlay('viewer', function () { el.viewer.hidden = true; el.viewer.firstElementChild.removeAttribute('src') })
  }

  // ------------------------------------------------------------ result viewer
  // One full-screen page per level: a tool call's full detail, a folder, a
  // file. Each level is an overlay, so back walks up the way the user came.
  var fv = []
  function fsize(n) { return n < 1024 ? n + ' B' : n < 1048576 ? (n / 1024).toFixed(1) + ' KB' : (n / 1048576).toFixed(1) + ' MB' }
  function baseName(p) { var s = String(p || '').replace(/[\\/]+$/, ''); return s.slice(Math.max(s.lastIndexOf('/'), s.lastIndexOf('\\')) + 1) || s }
  function dirName(rel) { var i = String(rel || '').lastIndexOf('/'); return i < 0 ? '' : rel.slice(0, i) }
  function rawUrl(s, rel) { return '/m/api/raw?s=' + enc(s) + '&path=' + enc(rel) }
  var fullVideo = null, nativeVideo = null
  function videoHtml(s, p, cls, messageSeq) {
    var nativeActions = /DSHApp\//.test(navigator.userAgent) && APP_CODE >= 14
    return '<div class="video-box" data-video-box><video class="' + cls + '" aria-label="播放 ' + esc(baseName(p)) + '" data-artifact="' + esc(p) + '" data-session="' + esc(s) + '"' + (messageSeq == null ? '' : ' data-message-seq="' + esc(messageSeq) + '"') + ' data-quality="preview" controls' + (nativeActions ? '' : ' controlslist="nodownload nofullscreen"') + ' playsinline preload="none" src="' + esc(rawUrl(s, p)) + '"></video>' +
      '<div class="video-options"><span class="video-note">流畅预览</span><button data-video-retry hidden>重试预览</button><button data-video-quality>切换原画</button>' + (nativeActions ? '' : '<button data-video-fullscreen>全屏</button><button data-video-download>下载原视频</button>') + '</div><p class="video-download-state" role="status" hidden></p></div>'
  }
  var videoDownloads = new Map()
  function paintVideoDownload(job) {
    var button = job.button, box = button.closest('[data-video-box]'), note = box && box.querySelector('.video-download-state')
    button.disabled = job.status === 'checking' || job.status === 'requesting' || job.status === 'queued'
    button.textContent = job.status === 'checking' ? '检查原视频…' : job.status === 'queued' ? '下载已排队' : job.status === 'error' ? '重试下载原视频' : '下载原视频'
    if (note) { note.hidden = false; note.textContent = job.message }
  }
  function downloadVideo(button) {
    var box = button.closest('[data-video-box]'), video = box && box.querySelector('video')
    if (!video) return
    if (/DSHApp\//.test(navigator.userAgent) && APP_CODE < 14) {
      openSheet('<div class="sh-h">需要更新 App</div><div class="sh-b"><p>请升级到 DSH 1.5.3，再保存原视频到手机。</p><button class="btn pri" data-download-update>检查并更新 App</button></div>')
      el.sheet.onclick = function (event) { if (event.target.closest('[data-download-update]')) location.href = 'dshapp://update' }; return
    }
    var key = video.dataset.session + '\n' + video.dataset.artifact, existing = videoDownloads.get(key)
    if (existing && ['checking', 'requesting', 'queued'].indexOf(existing.status) >= 0) { existing.button = button; paintVideoDownload(existing); return }
    var original = rawUrl(video.dataset.session, video.dataset.artifact) + '&download=1', origin = String(location.href).match(/^https?:\/\/[^/]+/), controller = new AbortController()
    var job = { id: uuid(), key: key, button: button, status: 'checking', message: '正在检查原视频是否可下载…', controller: controller }
    videoDownloads.set(key, job); paintVideoDownload(job)
    job.timer = setTimeout(function () { controller.abort() }, 15000)
    fetch(original, { method: 'HEAD', cache: 'no-store', redirect: 'error', signal: controller.signal }).then(function (response) {
      if (!response.ok) throw new Error('无法读取原视频（' + response.status + '）')
      clearTimeout(job.timer)
      if (/DSHApp\//.test(navigator.userAgent)) {
        if (!origin) throw new Error('无法确定下载服务器')
        job.status = 'requesting'; job.message = '正在交给手机保存原视频…'; paintVideoDownload(job)
        job.timer = setTimeout(function () { if (job.status === 'requesting') { job.status = 'error'; job.message = '尚未收到下载确认，请先查看手机通知，避免重复下载'; paintVideoDownload(job) } }, 20000)
        location.href = 'dshapp://download?url=' + enc(origin[0] + original) + '&name=' + enc(baseName(video.dataset.artifact)) + '&requestId=' + enc(job.id)
      } else {
        var link = document.createElement('a'); link.href = original; link.download = baseName(video.dataset.artifact); document.body.appendChild(link); link.click(); link.remove()
        job.status = 'requested'; job.message = '已请求浏览器下载原视频，请查看浏览器下载列表'; paintVideoDownload(job)
      }
    }).catch(function (error) { clearTimeout(job.timer); job.status = 'error'; job.message = error.name === 'AbortError' ? '原视频检查超时，请检查连接后重试' : error.message; paintVideoDownload(job); toast(job.message, 'err') })
  }
  window.dshDownloadResult = function (result) {
    if (!result || ['queued', 'complete', 'error'].indexOf(result.status) < 0) return
    var job = Array.from(videoDownloads.values()).find(function (item) { return item.id === result.requestId })
    if (!job) { if (/DSHApp\//.test(navigator.userAgent) && APP_CODE >= 14) toast(result.message || (result.status === 'queued' ? '已加入下载队列，尚未完成' : result.status === 'complete' ? '原视频已保存到手机系统下载目录' : '下载失败，请查看手机下载通知'), result.status === 'error' ? 'err' : undefined); return }
    if (job.status === 'complete') return
    clearTimeout(job.timer); job.status = result.status
    job.message = result.message || (result.status === 'queued' ? '已加入下载队列，尚未完成，可在手机通知中查看' : result.status === 'complete' ? '原视频已保存到手机系统下载目录' : '下载失败，请查看手机下载通知后重试')
    paintVideoDownload(job)
  }
  function closeFullscreenVideo() { if (fullVideo && !fullVideo.closing) { fullVideo.closing = true; closeOverlay() } }
  function fullscreenVideo(button) {
    var box = button.closest('[data-video-box]'), v = box && box.querySelector('video')
    if (!v) return
    if (fullVideo) { if (fullVideo.v === v) closeFullscreenVideo(); return }
    var entry = fullVideo = { v: v, box: box, native: false, redraw: false }
    v._fullscreen = true; box.classList.add('video-expanded'); button.textContent = '退出全屏'
    pushOverlay('video', function () {
      fullVideo = null; box.classList.remove('video-expanded'); button.textContent = '全屏'
      if (document.fullscreenElement === box && typeof document.exitFullscreen === 'function') Promise.resolve(document.exitFullscreen()).catch(function () {})
      var c = S.chats.get(v.dataset.session)
      if (entry.redraw && c && S.cur === c.id) renderMsgs(c, false, true)
      v._fullscreen = false
    })
    // Keep the installed-app button usable in older shells without native
    // fullscreen support; browsers can additionally hide their chrome.
    if (!/DSHApp\//.test(navigator.userAgent) && document.fullscreenEnabled !== false && typeof box.requestFullscreen === 'function') {
      try {
        Promise.resolve(box.requestFullscreen()).then(function () {
          if (fullVideo === entry) entry.native = document.fullscreenElement === box
          else if (document.fullscreenElement === box && typeof document.exitFullscreen === 'function') Promise.resolve(document.exitFullscreen()).catch(function () {})
        }, function () {})
      } catch (e) {} // CSS viewport expansion remains usable when denied.
    }
  }
  document.addEventListener('fullscreenchange', function () {
    var current = document.fullscreenElement
    if (nativeVideo && current !== nativeVideo.v) {
      var entry = nativeVideo, c = S.chats.get(entry.v.dataset.session)
      nativeVideo = null
      // Retain even a paused zero-position player through the deferred repaint.
      if (entry.redraw && c && S.cur === c.id) renderMsgs(c, false, true)
      if (!fullVideo || fullVideo.v !== entry.v) entry.v._fullscreen = false
    }
    // The native controls enter fullscreen directly on <video>, bypassing our
    // separate button and its CSS overlay. Never detach that live video either.
    if (!nativeVideo && current && current.tagName === 'VIDEO' && current.dataset.artifact) {
      nativeVideo = { v: current, redraw: false }; current._fullscreen = true
    }
    if (!fullVideo) return
    if (document.fullscreenElement === fullVideo.box) fullVideo.native = true
    else if (fullVideo.native) closeFullscreenVideo()
  })
  window.addEventListener('keydown', function (e) { if (e.key === 'Escape') { if (suggestion.key) suggestion.seen.add(suggestion.key); hideSuggestion(); closeFullscreenVideo() } })
  function videoNote(v, text) { var n = v.closest('[data-video-box]').querySelector('.video-note'); if (n) n.textContent = text }
  function videoState(v) {
    var box = v.closest('[data-video-box]'), original = v.dataset.quality === 'original'
    var quality = box.querySelector('[data-video-quality]'), retry = box.querySelector('[data-video-retry]')
    if (quality) quality.textContent = original ? '切换流畅' : '切换原画'
    if (retry) { retry.hidden = !v._previewError || original; retry.disabled = !!v._preparing }
    videoNote(v, v._preparing ? '正在准备流畅预览…' : v._previewError ? '预览暂不能播放，请重试预览或切换原画' : original ? '原画' : '流畅预览')
  }
  function videoPosition(v) { return v._positionPending ? v._resumePosition || 0 : v.currentTime || 0 }
  function loadVideo(v, url, generation, position) {
    v._resumePosition = position; v._positionPending = true
    v.addEventListener('loadedmetadata', function () {
      if (!v.isConnected || generation !== (v._generation || 0)) return
      if (position && v.duration) v.currentTime = Math.min(position, v.duration)
      v._positionPending = false
    }, { once: true })
    v.src = url; v.load()
    v.play().catch(function () {
      if (v.isConnected && generation === (v._generation || 0) && !v._previewError && !v.error) videoNote(v, '准备好了，点播放继续')
    })
  }
  function preparePreview(v) {
    if (!v || !v.isConnected || v.dataset.quality === 'original') return
    if (v._preparing) { v.pause(); return }
    var attempts = 0, generation = (v._generation || 0) + 1
    v.pause(); v._generation = generation; v._preparing = true; v._previewError = false; v.dataset.previewReady = ''
    videoState(v)
    function check() {
      if (!v.isConnected || generation !== (v._generation || 0)) return
      get('/m/api/video?s=' + enc(v.dataset.session) + '&path=' + enc(v.dataset.artifact)).then(function (r) {
        if (!v.isConnected || generation !== (v._generation || 0)) return
        if (r.state === 'preparing' && attempts++ < 600) { setTimeout(check, 1000); return }
        v._preparing = false
        if (r.state !== 'ready') { v.dataset.quality = 'original'; r.url = r.original }
        else v.dataset.previewReady = '1'
        videoState(v)
        if (r.state !== 'ready') videoNote(v, '流畅预览暂不可用，正在播放原画')
        loadVideo(v, r.url, generation, videoPosition(v))
      }, function (err) {
        if (!v.isConnected || generation !== (v._generation || 0)) return
        v._preparing = false
        if (err.code === 'not-found') {
          v.dataset.quality = 'original'; videoState(v); videoNote(v, '正在播放原画')
          loadVideo(v, rawUrl(v.dataset.session, v.dataset.artifact), generation, videoPosition(v))
        } else { v._previewError = true; videoState(v) }
      })
    }
    check()
  }
  function wireVideos(container) {
    container.querySelectorAll('video[data-artifact]').forEach(function (v) {
      videoState(v)
      var download = videoDownloads.get(v.dataset.session + '\n' + v.dataset.artifact), downloadButton = v.closest('[data-video-box]').querySelector('[data-video-download]')
      if (download && downloadButton) { download.button = downloadButton; paintVideoDownload(download) }
      v.onerror = function () {
        v._generation = (v._generation || 0) + 1; v._preparing = false
        v._previewError = v.dataset.quality !== 'original'; v.dataset.previewReady = ''; videoState(v)
        if (!v._previewError) videoNote(v, '原画暂不能播放，可切换流畅预览')
      }
      v.onplay = function () {
        if (v.dataset.quality === 'original' || v.dataset.previewReady === '1') return
        if (v._previewError) { v.pause(); return }
        preparePreview(v)
      }
    })
  }
  function switchVideo(button) {
    var box = button.closest('[data-video-box]'), v = box && box.querySelector('video'), position = v && videoPosition(v)
    if (!v) return
    v.pause(); v._generation = (v._generation || 0) + 1; v._preparing = false; v._previewError = false
    v.dataset.quality = v.dataset.quality === 'original' ? 'preview' : 'original'
    v.dataset.previewReady = ''; videoState(v)
    if (v.dataset.quality === 'preview') preparePreview(v)
    else loadVideo(v, rawUrl(v.dataset.session, v.dataset.artifact), v._generation, position)
  }
  function fvOpen(en) {
    fv.push(en)
    el.fv.hidden = false
    requestAnimationFrame(function () { requestAnimationFrame(function () { el.fv.classList.add('on') }) })
    pushOverlay('fv', function () {
      el.fvBody.querySelectorAll('video,audio').forEach(function (m) { m.pause() })
      fv.pop()
      if (fv.length) { fvShow(); return }
      el.fv.classList.remove('on')
      setTimeout(function () { if (!fv.length) { el.fv.hidden = true; el.fvBody.innerHTML = '' } }, 320)
    })
    fvShow()
  }
  function fvShow() {
    var en = fv[fv.length - 1]
    el.fvTitle.textContent = en.title || ''
    el.fvSub.textContent = en.sub || ''
    el.fvAct.hidden = true
    el.fvBody.scrollTop = 0
    if (en.data) { fvPaint(en); return }
    el.fvBody.innerHTML = '<div class="spin"></div>'
    var url = en.kind === 'call'
      ? '/m/api/call?s=' + enc(en.s) + '&id=' + enc(en.id) + '&seq=' + en.seq + (en.rseq ? '&rseq=' + en.rseq : '')
      : '/m/api/fs?s=' + enc(en.s) + '&path=' + enc(en.path || '')
    get(url).then(function (v) {
      if (en.folderFor && v.kind !== 'dir') {
        en.folderFor = false; en.highlight = v.name; en.path = dirName(v.rel); en.title = baseName(en.path) || '工作区'; en.data = null
        if (fv[fv.length - 1] === en) fvShow()
        return
      }
      en.data = v
      if (fv[fv.length - 1] === en) fvPaint(en)
    }, function (e) {
      if (fv[fv.length - 1] === en) el.fvBody.innerHTML = '<div class="empty"><b>打不开</b>' + esc(e.message) + '</div>'
    })
  }
  // Chips only for files the viewer can open: relative paths, or absolute
  // ones under the session's workspace (the server enforces the same rule).
  function wsRoot(sid) { var ag = isAgent(sid) && agentOf(sid), w = wsOf(sid); return (ag && ag.cwd) || (w && S.wsById[w] ? S.wsById[w].path : '') }
  function normP(p) { return String(p).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase() }
  function inRoot(p, root) {
    if (!/^([a-zA-Z]:[\\/]|[\\/])/.test(p)) return true
    var a = normP(p), r = normP(root)
    return Boolean(r) && (a === r || a.indexOf(r + '/') === 0)
  }
  function chipsHtml(paths, root) {
    return (paths || []).filter(function (p) { return inRoot(p, root) }).map(function (p) {
      return '<button data-fp="' + esc(p) + '">' + ic('read', 's') + '<span>' + esc(baseName(p)) + '</span></button>'
    }).join('')
  }
  function fvPaint(en) {
    var d = en.data, h = ''
    if (en.kind === 'call') {
      el.fvSub.textContent = toolLabel(d.name) + (d.done ? (d.err ? ' · 失败' : ' · 完成') : ' · 进行中')
      var chips = chipsHtml(d.paths, wsRoot(en.s))
      if (chips) h += '<div class="tacts fvchips">' + chips + '</div>'
      if (d.diffs && d.diffs.length) d.diffs.forEach(function (x) { h += diffHtml(x) })
      else if (d.input) h += '<div class="fvsec">内容</div><pre class="fvtext">' + esc(d.input) + '</pre>'
      if (d.out) h += '<div class="fvsec">' + (d.err ? '出错信息' : '结果') + '</div><pre class="fvtext' + (d.err ? ' bad' : '') + '">' + esc(d.out) + '</pre>'
      if (d.cut) h += '<div class="fvnote">内容过长，只显示开头和结尾</div>'
      if (d.out || d.input) { el.fvAct.hidden = false; el.fvAct.onclick = function () { copy(d.out || d.input) } }
    } else if (d.kind === 'dir') {
      el.fvSub.textContent = d.rel ? '/' + d.rel : '工作区根目录'
      h += d.entries.length ? '<div class="grp fl">' + d.entries.map(function (x) {
        var media = /\.(png|jpe?g|gif|webp|bmp|svg|ico|avif|mp4|m4v|webm|mov|mp3|m4a|aac|wav|ogg|flac)$/i.test(x.name)
        return '<button class="row' + (en.highlight === x.name ? ' selected' : '') + '" data-fe="' + esc(x.name) + '" data-dir="' + (x.dir ? 1 : '') + '"><span class="fic' + (x.dir ? ' d' : '') + '">' + ic(x.dir ? 'folder' : media ? 'image' : 'read', 's') + '</span><div class="mid"><div class="t">' + esc(x.name) +
          '</div><div class="m">' + (x.dir ? '文件夹' : fsize(x.size)) + ' · ' + when(x.at) + '</div></div>' + (x.dir ? ic('chev', 's') : '') + '</button>'
      }).join('') + '</div>' : '<div class="empty"><b>空文件夹</b></div>'
      if (d.more) h += '<div class="fvnote">文件太多，只列出前 500 个</div>'
    } else {
      el.fvSub.textContent = fsize(d.size) + ' · ' + when(d.at) + (d.enc && d.enc !== 'utf-8' ? ' · ' + d.enc.toUpperCase() : '')
      h += '<div class="tacts fvchips"><button data-fdir="' + esc(dirName(d.rel)) + '">' + ic('folder', 's') + '<span>所在文件夹</span></button></div>'
      if (d.kind === 'media') {
        var u = rawUrl(en.s, d.rel)
        if (/^image\//.test(d.type)) h += '<img class="fvimg" src="' + esc(u) + '" alt="">'
        else if (/^video\//.test(d.type)) h += videoHtml(en.s, d.rel, 'fvmedia')
        else h += '<audio class="fvmedia" controls preload="metadata" src="' + esc(u) + '"></audio>'
      } else if (d.kind === 'binary') {
        h += '<div class="empty"><b>无法预览</b>这是二进制文件（' + fsize(d.size) + '）</div>'
      } else {
        var isMd = /\.(md|markdown)$/i.test(d.name)
        if (isMd) h += '<div class="seg"><button class="' + (en.src ? '' : 'on') + '" data-mdv="0">预览</button><button class="' + (en.src ? 'on' : '') + '" data-mdv="1">源码</button></div>'
        h += isMd && !en.src ? '<div class="md fvmd">' + md(d.text) + '</div>' : '<pre class="fvtext">' + esc(d.text) + '</pre>'
        if (d.truncated) h += '<div class="fvnote">文件较大，只显示前 1 MB</div>'
        el.fvAct.hidden = false
        el.fvAct.onclick = function () { copy(d.text) }
      }
    }
    el.fvBody.innerHTML = h
    wireVideos(el.fvBody)
    if (en.autoplay) {
      en.autoplay = false
      var movie = el.fvBody.querySelector('video')
      if (movie) movie.play().catch(function () {})
    }
  }

  // Line diff for the edit card: LCS over lines, unchanged runs folded to 3
  // lines of context. Big inputs fall back to "all old, then all new".
  function lineDiff(a, b) {
    var n = a.length, m = b.length, out = []
    if (n * m > 4e6) {
      a.forEach(function (s) { out.push(['-', s]) })
      b.forEach(function (s) { out.push(['+', s]) })
      return out
    }
    var w = m + 1, L = new Uint32Array((n + 1) * w)
    for (var i = n - 1; i >= 0; i--) for (var j = m - 1; j >= 0; j--) L[i * w + j] = a[i] === b[j] ? L[(i + 1) * w + j + 1] + 1 : Math.max(L[(i + 1) * w + j], L[i * w + j + 1])
    i = 0; j = 0
    while (i < n && j < m) {
      if (a[i] === b[j]) { out.push([' ', a[i]]); i++; j++ }
      else if (L[(i + 1) * w + j] >= L[i * w + j + 1]) out.push(['-', a[i++]])
      else out.push(['+', b[j++]])
    }
    while (i < n) out.push(['-', a[i++]])
    while (j < m) out.push(['+', b[j++]])
    return out
  }
  function diffHtml(x) {
    var a = x.oldText == null ? [] : String(x.oldText).replace(/\r\n/g, '\n').split('\n')
    var b = x.newText == null ? [] : String(x.newText).replace(/\r\n/g, '\n').split('\n')
    var rows = lineDiff(a, b), keep = new Array(rows.length), adds = 0, dels = 0
    rows.forEach(function (r, k) {
      if (r[0] === '+') adds++
      if (r[0] === '-') dels++
      if (r[0] !== ' ') for (var q = Math.max(0, k - 3); q <= Math.min(rows.length - 1, k + 3); q++) keep[q] = true
    })
    var h = '', skipped = []
    function line(r) { h += '<span class="l ' + (r[0] === '+' ? 'add' : r[0] === '-' ? 'del' : 'ctx') + '" data-m="' + r[0] + '">' + (esc(r[1]) || ' ') + '</span>' }
    // Fold only runs worth folding; a marker for one or two lines costs more than it saves.
    function flushSkip() {
      if (skipped.length >= 4) h += '<span class="l skip">⋯ ' + skipped.length + ' 行未改动 ⋯</span>'
      else skipped.forEach(line)
      skipped = []
    }
    rows.forEach(function (r, k) {
      if (!keep[k] && rows.length > 12) { skipped.push(r); return }
      flushSkip()
      line(r)
    })
    flushSkip()
    var tag = x.oldText == null ? '新建' : x.newText == null ? '删除' : '修改'
    return '<div class="diff"><button class="dh" data-fp="' + esc(x.path || '') + '"><b>' + tag + '</b><span>' + esc(x.path || '') + '</span><em class="ok">+' + adds + '</em><em class="bad">−' + dels + '</em></button><pre>' + h + '</pre></div>'
  }

  // ------------------------------------------------------------ chat: data
  function loadHistory(c) {
    c.loading = true
    c.err = false
    c.buf = []
    if (c.id === S.cur) renderMsgs(c)
    return get((isAgent(c.id) ? '/m/api/agents/history?s=' : '/m/api/history?s=') + enc(c.id) + '&n=40').then(function (v) {
      c.items = v.items
      var delivered = new Set(c.items.filter(function (item) { return item.k === 'u' && item.rid }).map(function (item) { return item.rid }))
      c.pending = c.pending.filter(function (item) { return !item.rid || !delivered.has(item.rid) })
      c.partial = v.partial
      c.lastSeq = v.lastSeq
      c.firstSeq = v.firstSeq
      c.hasMore = v.hasMore
      if (v.todos) c.todos = v.todos
      if (v.title) setTitle(c.id, v.title)
      pruneQueue(c)
      // The history page carries the session's own run flag, so a `run` frame
      // missed while the stream was down corrects itself on every load. Only
      // the response's own value is used: falsy includes undefined, and
      // trusting that would clear a run the phone had just observed locally.
      if (typeof v.run === 'boolean') setRun(c.id, v.run)
      c.loaded = true
    }, function (e) {
      c.err = true
      if (c.id === S.cur) toast(e.message, 'err')
    }).then(function () {
      c.loading = false
      var buf = c.buf
      c.buf = []
      buf.forEach(function (f) { apply(c, f) })
      if (c.id === S.cur) { renderMsgs(c, true); drawDock() }
    })
  }
  function loadOlder(c) {
    if (c.olderLoading || !c.hasMore) return
    c.olderLoading = true
    renderMsgs(c, false, true)
    get('/m/api/history?s=' + enc(c.id) + '&n=40&before=' + c.firstSeq).then(function (v) {
      var h0 = el.scroller.scrollHeight, t0 = el.scroller.scrollTop
      var seen = new Set(c.items.map(function (item) { return item.seq }).filter(Number.isFinite))
      c.items = v.items.filter(function (item) { if (!Number.isFinite(item.seq)) return true; if (seen.has(item.seq)) return false; seen.add(item.seq); return true }).concat(c.items)
      if (v.firstSeq >= 0) c.firstSeq = v.firstSeq
      c.hasMore = v.hasMore
      c.olderLoading = false
      renderMsgs(c, false, true)
      if (S.cur === c.id) el.scroller.scrollTop = t0 + (el.scroller.scrollHeight - h0)
    }, function (e) {
      c.olderLoading = false
      renderMsgs(c, false, true)
      toast(e.message, 'err')
    })
  }
  function loadModel(c) {
    if (c.models || c.modelLoading) return
    c.modelLoading = true
    rpc('session.models', { sessionId: c.id }).then(function (v) {
      c.models = v
      c.model = v.current
      if (c.id === S.cur) renderHead()
    }, function () {}).then(function () { c.modelLoading = false })
  }
  function modelName(c) {
    var cur = c.model
    if (!cur) return ''
    var name = cur.model, eff = cur.reasoningEffort
    ;(c.models ? c.models.groups : []).forEach(function (g) {
      if (g.id !== cur.provider) return
      g.models.forEach(function (m) {
        if (m.id !== cur.model) return
        name = m.name
        if (eff && m.reasoning) m.reasoning.efforts.forEach(function (e) { if (e.id === eff) eff = EFF[e.id] || e.name })
      })
    })
    return name + (eff ? ' · ' + (EFF[eff] || eff) : '')
  }
  var EFF = { off: '不思考', low: '低', medium: '中', high: '高', max: '最大' }

  // Voice is always tied to the current session and an explicit tap. Android
  // asks for RECORD_AUDIO only then; backgrounding or leaving releases it.
  var holdMode = null, holdGesture = null
  var voice = null, voiceStarting = false, voiceCleanup = Promise.resolve(), pendingVoiceReplies = new Map()
  function syncHoldUi() {
    syncSuggestion()
    if (!el.holdTalk) return
    var enabled = !!holdMode, held = !!holdGesture
    el.holdTalk.hidden = !enabled; el.voiceKeyboard.hidden = !enabled; el.holdHint.hidden = !enabled
    el.input.hidden = enabled; el.inputWrap.hidden = enabled; el.send.hidden = enabled; el.mic.hidden = enabled || !!voice || Boolean(S.cur && isAgent(S.cur))
    var busy = voice && (voice.finishing || voice.failedSave || (voice.waiting && (!voice.turnDone || isRunning(voice.sid) || voice.playing || voice.audioPending || voice.ttsBusy)))
    el.holdTalk.disabled = !held && (!!busy || voiceStarting)
    el.holdTalk.classList.toggle('holding', held); el.holdTalk.classList.toggle('cancel', held && holdGesture.cancelled)
    el.holdTalk.textContent = held ? (holdGesture.cancelled ? '松开取消' : voice && voice.ready ? (holdMode === 'draft' ? '松开转文字' : '松开发送') : '正在开启麦克风…') : busy ? 'DSH 正在回复…' : '按住说话'
    el.holdHint.textContent = held ? '向上滑动取消' : holdMode === 'draft' ? '松开后转成文字，确认后再发送' : '松开发送语音，上滑取消'
    if (voice && voice.held) { el.voiceBar.hidden = !voice.failedSave; if (voice.failedSave) el.voiceEnd.hidden = false }
  }
  function chooseHoldMode(mode) { holdMode = mode === 'chat' ? mode : null; syncHoldUi() }
  function restoreHoldDraft(gesture) {
    if (gesture.mode !== 'draft') return
    if (gesture.base) S.drafts[gesture.sid] = gesture.base; else delete S.drafts[gesture.sid]
    store.set('drafts', S.drafts)
    if (S.cur === gesture.sid) { el.input.value = gesture.base; autosize(); syncSend() }
  }
  function cancelHold(message, notifyHost) {
    var gesture = holdGesture; if (!gesture) return
    holdGesture = null
    if (voice && voice === gesture.voice) { voice.draftFinalized = true; stopVoice(undefined, notifyHost) }
    restoreHoldDraft(gesture); syncHoldUi(); if (message) toast(message)
  }
  function beginHold(event) {
    if (!holdMode || holdGesture || (event.button != null && event.button !== 0)) return
    if (event.preventDefault) event.preventDefault()
    if (voiceStarting || (voice && (voice.finishing || voice.failedSave || (voice.waiting && !voice.turnDone) || isRunning(voice.sid) || voice.playing || voice.audioPending))) return
    if (voice) stopVoice()
    var gesture = { pointerId: event.pointerId, startY: event.clientY || 0, sid: S.cur, base: el.input.value, mode: holdMode, cancelled: false }
    holdGesture = gesture; startVoice(holdMode)
    if (!voice) { holdGesture = null; syncHoldUi(); return }
    gesture.voice = voice; voice.held = true; holdGesture = gesture
    try { if (event.pointerId != null && el.holdTalk.setPointerCapture) el.holdTalk.setPointerCapture(event.pointerId) } catch (e) {}
    syncHoldUi()
  }
  function releaseHold(cancelled, automatic) {
    var gesture = holdGesture; if (!gesture) return
    if (cancelled || gesture.cancelled || !voice || voice !== gesture.voice || !voice.ready || voice.total < 0.5) { cancelHold(cancelled || gesture.cancelled ? '本次录音已取消' : '录音太短，请按住说话后再松开'); return }
    holdGesture = null
    if (gesture.mode === 'draft') holdMode = null
    releaseVoiceCapture(voice); finishVoice(); syncHoldUi()
  }
  function leaveHoldMode() {
    if (holdGesture) cancelHold('本次录音已取消')
    holdMode = null
    // Submitted messages continue receiving their reply; unsent capture exits.
    if (voice && !voice.finishing) { voice.draftFinalized = true; stopVoice() } else if (voice) voice.exitToKeyboard = true
    syncHoldUi(); el.input.focus()
  }
  function voiceFetch(route, options) {
    var controller = new AbortController(), timer = setTimeout(function () { controller.abort() }, 90000)
    options.signal = controller.signal
    return fetch(route, options).then(function (response) {
      if (response.status === 401) throw new Error('连接登录已失效，请重新登录后再试')
      if (response.status === 404) throw new Error('电脑端尚未启用语音服务，请检查语音插件')
      return response.json().catch(function () { throw new Error('语音服务尚未就绪，请稍后重试或检查电脑端语音插件') }).then(function (value) { if (!response.ok) throw new Error(typeof value.error === 'string' ? value.error : value.error && value.error.message || '语音服务暂不可用'); return value })
    }).then(function (value) { clearTimeout(timer); return value }, function (error) { clearTimeout(timer); throw error })
  }
  function voiceJson(route, body) {
    return voiceFetch(route, { method: body ? 'POST' : 'GET', headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined })
  }
  function voiceWav(parts) {
    var count = parts.reduce(function (n, p) { return n + p.length }, 0), bytes = new Uint8Array(44 + count * 2), view = new DataView(bytes.buffer)
    function word(at, text) { for (var i = 0; i < text.length; i++) bytes[at + i] = text.charCodeAt(i) }
    word(0, 'RIFF'); view.setUint32(4, 36 + count * 2, true); word(8, 'WAVEfmt '); view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true); view.setUint32(24, 16000, true); view.setUint32(28, 32000, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true); word(36, 'data'); view.setUint32(40, count * 2, true)
    var at = 44; parts.forEach(function (p) { for (var i = 0; i < p.length; i++) { var f = Math.max(-1, Math.min(1, p[i])); view.setInt16(at, f < 0 ? f * 32768 : f * 32767, true); at += 2 } })
    var raw = ''; for (var j = 0; j < bytes.length; j += 8192) raw += String.fromCharCode.apply(null, bytes.subarray(j, j + 8192))
    return btoa(raw)
  }
  function mergeConfirmedVoice(sid, item) {
    var c = S.chats.get(sid)
    if (!c || !item || !item.id || !item.role) return false
    var previous = (c.voiceItems || []).find(function (entry) { return entry.id === item.id })
    if (previous && JSON.stringify(previous) === JSON.stringify(item)) return true
    c.voiceRevision = (c.voiceRevision || 0) + 1
    c.voiceItems = (c.voiceItems || []).filter(function (entry) { return entry.id !== item.id }).concat(item).sort(function (a, b) { return String(a.createdAt || '').localeCompare(String(b.createdAt || '')) || String(a.id).localeCompare(String(b.id)) })
    c.voiceSignature = JSON.stringify(c.voiceItems)
    if (S.cur === sid) renderMsgs(c, false, true)
    return true
  }
  function storeVoice(sid, item) {
    return voiceJson('/m/api/voice', Object.assign({ s: sid }, item)).then(function (out) {
      if (!out.ok) throw new Error(out.error || '语音保存失败')
      var c = S.chats.get(sid), saved = out.value
      if (item.mode === 'message' && mergeConfirmedVoice(sid, saved)) Promise.resolve(c && c.voiceLoading).then(function () { loadVoiceHistory(sid) })
      else loadVoiceHistory(sid)
      return saved
    })
  }
  function loadVoiceHistory(sid) {
    if (!sid || isAgent(sid)) return
    var owner = S.chats.get(sid), revision = owner && (owner.voiceRevision || 0)
    if (owner && owner.voiceLoading) return owner.voiceLoading
    var request = voiceJson('/m/api/voice?s=' + enc(sid)).then(function (out) {
      var c = S.chats.get(sid)
      if (!c || !out.ok || (c.voiceRevision || 0) !== revision) return
      var items = out.value.items || [], signature = JSON.stringify(items)
      if (c.voiceSignature === signature) return
      c.voiceSignature = signature; c.voiceItems = items
      if (sid === S.cur) renderMsgs(c, false, true)
    }).catch(function () {})
    if (owner) { owner.voiceLoading = request; request.then(function () { if (owner.voiceLoading === request) owner.voiceLoading = null }) }
    return request
  }
  function voiceMenuKey(item) { return item.role === 'assistant' && item.replyTo ? 'reply:' + item.replyTo : item.id }
  function voiceBubbleHtml(c, item, text, status) {
    var segments = item.segmentIds || [], revision = segments.join(','), grouped = segments.length > 0
    var url = item.url && item.url.indexOf('/m/api/voice/audio?') === 0 ? item.url : '/m/api/voice/audio?s=' + enc(c.id) + '&id=' + enc(item.id) + (grouped ? '&group=1' : '')
    return '<div class="voice-bubble"' + (item.callId ? ' data-call-id="' + esc(item.callId) + '"' : '') + '><audio hidden preload="none" data-voice-id="' + esc(item.id) + '" data-voice-revision="' + esc(revision) + '" data-session="' + esc(c.id) + '" src="' + esc(url) + '"></audio><button class="voice-play" data-voice-play="' + esc(item.id) + '" data-voice-menu="' + esc(voiceMenuKey(item)) + '" aria-label="播放语音" aria-pressed="false"><span class="voice-play-state" aria-hidden="true">▷</span><span class="voice-wave" aria-hidden="true"><i></i><i></i><i></i><i></i><i></i></span><span>' + (item.durationMs ? Math.max(1, Math.round(item.durationMs / 1000)) + '″' : '语音') + '</span></button>' + (status ? '<small class="voice-delivery">' + esc(status) + '</small>' : '') + (text ? voiceTextHtml(c, item, '<div class="voice-transcript">' + esc(text) + '</div>') : '') + '</div>'
  }
  function voiceTextHtml(c, item, body) { var key = voiceMenuKey(item); return '<div class="voice-text" data-voice-transcript="' + esc(key) + '"' + (c.voiceTextOpen && c.voiceTextOpen.has(key) ? '' : ' hidden') + '>' + body + '</div>' }
  function pendingVoiceHtml(c, owner) {
    c.voicePendingReply = true
    return '<div class="voice-bubble voice-pending"><button class="voice-play" data-voice-menu="reply:' + esc(owner.id) + '" aria-label="正在生成语音，长按可查看文字"><span class="spin s"></span><span>正在生成语音…</span></button></div>'
  }
  var voiceQueue = null, voicePress = null, voiceContextKey = null, voiceClickSuppressed = new Map()
  function stopVoiceQueue() { voiceQueue = null }
  function advanceVoiceQueue(ended) {
    var queue = voiceQueue
    if (!queue || queue.sid !== S.cur || queue.items[queue.index] !== ended) return
    queue.index++
    if (queue.index >= queue.items.length) { stopVoiceQueue(); return }
    var next = queue.items[queue.index]
    if (next.isConnected === false) { stopVoiceQueue(); return }
    next.play().catch(function () { if (voiceQueue === queue) { stopVoiceQueue(); toast('连续播放已停止，这条语音暂时无法播放') } })
  }
  function cancelVoicePress() { if (voicePress) clearTimeout(voicePress.timer); voicePress = null }
  function openVoiceMessageMenu(button) {
    var c = S.chats.get(S.cur), key = button.dataset.voiceMenu, sid = S.cur
    if (!c || !key) return
    if (voiceContextKey === key && hasOverlay('sheet')) return
    cancelVoicePress(); voiceClickSuppressed.set(key, Date.now() + 1000)
    var audio = button.closest('.voice-bubble')?.querySelector('audio[data-voice-id]'), expanded = c.voiceTextOpen && c.voiceTextOpen.has(key)
    var textExists = Array.from(el.msgs.querySelectorAll('[data-voice-transcript]')).some(function (node) { return node.dataset.voiceTranscript === key })
    openSheet('<div class="sh-h">语音消息</div><div class="sh-b">' + (textExists ? '<button class="opt-row" data-voice-action="text">' + (expanded ? '隐藏文字' : '转文字') + '</button>' : '') + (audio ? '<button class="opt-row" data-voice-action="play">' + (!audio.paused && !audio.ended ? '暂停' : '播放') + '</button><button class="opt-row" data-voice-action="queue">' + (voiceQueue ? '停止连续播放' : '连续播放') + '</button>' : '<p class="voice-pending-hint">语音生成中，文字可先查看。</p>') + '<button class="opt-row" data-voice-action="device">播放设备</button></div>')
    voiceContextKey = key
    el.sheet.onclick = function (event) {
      var action = event.target.closest('[data-voice-action]'); if (!action || S.cur !== sid) return
      var kind = action.dataset.voiceAction
      if (kind === 'device') { toast('使用当前系统扬声器或耳机输出，可在手机系统中调整'); return }
      if (kind === 'text') {
        if (!c.voiceTextOpen) c.voiceTextOpen = new Set()
        if (c.voiceTextOpen.has(key)) c.voiceTextOpen.delete(key); else c.voiceTextOpen.add(key)
        el.msgs.querySelectorAll('[data-voice-transcript]').forEach(function (node) { if (node.dataset.voiceTranscript === key) node.hidden = !c.voiceTextOpen.has(key) })
      } else if (kind === 'play' && audio) playVoiceBubble(button)
      else if (kind === 'queue' && audio) {
        if (voiceQueue) pauseChatVoice()
        else {
          var items = Array.from(el.msgs.querySelectorAll('audio[data-voice-id]')).filter(function (item) { return item.dataset.session === sid && !item.closest('.voice-orphan') }), index = items.indexOf(audio)
          if (index >= 0 && prepareHistoryVoice()) { pauseChatVoice(); voiceQueue = { sid: sid, items: items.slice(index), index: 0 }; audio.play().catch(function () { stopVoiceQueue(); toast('连续播放未开始，这条语音暂时无法播放') }) }
        }
      }
      closeOverlay()
    }
  }
  function paintVoicePlayback(audio) {
    var box = audio.closest && audio.closest('.voice-bubble'), button = box && box.querySelector('[data-voice-play]')
    if (!button) return
    var playing = !audio.paused && !audio.ended
    button.setAttribute('aria-pressed', String(playing)); button.setAttribute('aria-label', playing ? '暂停语音' : '播放语音'); button.classList.toggle('playing', playing)
    var icon = button.querySelector('.voice-play-state'); if (icon) icon.textContent = playing ? 'Ⅱ' : '▷'
  }
  function prepareHistoryVoice() {
    if (voice && voice.mode === 'call') { toast('通话中暂不播放历史语音，请先挂断'); return false }
    if (holdGesture) { toast('请先结束当前录音'); return false }
    if (voice && voice.conversation && voice.waiting) stopVoice('已切换到语音回放')
    stopVoicePreview(); return true
  }
  function playVoiceBubble(button) {
    if (!prepareHistoryVoice()) return
    stopVoiceQueue()
    var box = button.closest('.voice-bubble'), audio = box && box.querySelector('audio[data-voice-id]')
    if (!audio) return
    if (!audio.paused && !audio.ended) { audio.pause(); paintVoicePlayback(audio); return }
    stopVoicePreview()
    if (voice && voice.playing) stopVoice('已切换到语音回放')
    el.msgs.querySelectorAll('audio[data-voice-id]').forEach(function (other) { if (other !== audio) other.pause() })
    audio.play().then(function () { paintVoicePlayback(audio) }, function () { toast('语音暂时无法播放，请检查连接后重试'); paintVoicePlayback(audio) })
  }

  function syncReplyRetry() {
    var failed = Array.from(pendingVoiceReplies.values()).filter(function (entry) { return entry.failed })
    el.voiceRetryReplies.hidden = !failed.length
    el.voiceRetryReplies.textContent = '重试保存回复 · ' + failed.length
  }
  function persistVoiceReply(entry) {
    if (entry.saving) return entry.saving
    entry.failed = false; syncReplyRetry()
    entry.saving = storeVoice(entry.sid, entry.body).then(function () {
      pendingVoiceReplies.delete(entry.body.id); syncReplyRetry()
    }, function (error) { entry.failed = true; entry.saving = null; syncReplyRetry(); throw error })
    return entry.saving
  }
  function replyDuration(audio, mime) {
    if (mime !== 'audio/wav') return 0
    try { var raw = atob(audio), bytes = new Uint8Array(raw.length); for (var i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i); var view = new DataView(bytes.buffer); return raw.slice(0, 4) === 'RIFF' && raw.length >= 44 && view.getUint32(28, true) ? Math.round((raw.length - 44) / view.getUint32(28, true) * 1000) : 0 } catch (e) { return 0 }
  }
  function saveVoiceReplies(v, keyOnly) {
    var writes = []
    Object.keys(v.replyAudio || {}).forEach(function (key) {
      var item = v.replyAudio[key]
      if (keyOnly != null && String(keyOnly) !== key) return
      if (item.queued) return
      item.queued = true
      // The host emits one complete encoded file per data frame, then text.
      // Keep the exact WAV/MP3 bytes; no AudioContext or lossy re-encoding is
      // needed to save it. Future multiple complete chunks get separate rows.
      item.parts.forEach(function (part, index) {
        var body = { id: index === 0 ? item.id : uuid(), role: 'assistant', text: v.captions[key] || '', mime: part.mime, audio: part.audio, durationMs: part.durationMs || replyDuration(part.audio, part.mime), requestId: item.requestId, replyTo: item.replyTo, mode: v.mode === 'call' ? 'call' : 'message' }
        if (v.callId) { body.callId = v.callId; body.callStartedAt = v.callStartedAt }
        var entry = { sid: v.sid, body: body, failed: false, saving: null }
        pendingVoiceReplies.set(body.id, entry); writes.push(persistVoiceReply(entry))
      })
    })
    return Promise.all(writes)
  }
  // Native AEC removes our speaker reference. A rolling pre-roll survives the
  // asynchronous VAD/cancel handshake, so interruption does not eat first words.
  function detectBarge(v, pcm, rms) {
    v.barge.push(pcm); v.bargeCount += pcm.length
    while (!v.interrupting && v.bargeCount > 24000 && v.barge.length > 1) v.bargeCount -= v.barge.shift().length
    if (v.interrupting || v.detectBusy || v.muted || v.autoBarge === false) return
    // A raised, persistent residual floor during speaker output is usually echo.
    if (!v.echoFloor) v.echoFloor = 0.006
    if (rms < v.echoFloor * 2) v.echoFloor = v.echoFloor * 0.95 + rms * 0.05
    if (rms < Math.max(0.018, v.echoFloor * 2.8)) { v.detectPositive = 0; return }
    var generation = v.playGeneration, detectGeneration = v.detectGeneration || 0, samples = new Float32Array(v.bargeCount), at = 0
    v.barge.forEach(function (p) { samples.set(p, at); at += p.length })
    v.detectBusy = true
    voiceFetch('/voice-mode/asr?sessionId=' + enc(v.sid) + '&epoch=' + v.epoch + '&offset=0&manual=1&vadOnly=1', { method: 'POST', headers: { 'content-type': 'application/octet-stream' }, body: samples.buffer }).then(function (out) {
      if (voice !== v || v.muted || detectGeneration !== (v.detectGeneration || 0) || generation !== v.playGeneration || !v.waiting) return
      v.detectPositive = out.isSpeech === true ? v.detectPositive + 1 : 0
      if (v.detectPositive < 3) return
      v.interrupting = true
      if (v.player) { try { v.player.stop() } catch (e) {} }
      // Keep all frames arriving until cancellation completes, including pre-roll.
      var prefix = v.barge
      continueVoice(v, false, prefix)
    }).catch(function () { if (voice === v) stopVoice('通话连接中断，已停止录音') }).then(function () { v.detectBusy = false })
  }
  function voiceHint(v, text) {
    if (voice !== v) return
    if (v.held) {
      if (text.indexOf('说完发送') >= 0) text = '录音中 · 松开发送，上滑取消'
      else if (text.indexOf('继续说') >= 0) text = '按住说话发送下一条语音'
    }
    el.voiceState.textContent = text; el.callState.textContent = text; syncHoldUi()
  }
  function voiceDraft(v, text, final) {
    if (voice !== v || !text) return
    if (v.conversation) { if (S.cur === v.sid) { el.voiceCaption.textContent = '我：' + text; el.callCaption.textContent = '我：' + text } return }
    // A pending final response belongs to the originating draft even after
    // navigation. Never write it into the newly selected conversation.
    var current = S.cur === v.sid, draft = current ? el.input.value : (S.drafts[v.sid] || '')
    if (draft !== v.preview) v.edited = true
    if (v.edited && !final) return
    var base = v.edited ? draft : v.base
    if (v.edited && v.renderedTranscript && text.indexOf(v.renderedTranscript) === 0) text = text.slice(v.renderedTranscript.length).replace(/^\s+/, '')
    if (v.edited && !text) return
    var value = (base ? base.replace(/\s+$/, '') + '\n' : '') + text
    if (!v.edited) v.renderedTranscript = text
    v.preview = value; S.drafts[v.sid] = value; store.set('drafts', S.drafts)
    if (current) { el.input.value = value; autosize(); syncSend() }
  }
  function releaseVoiceCapture(v) {
    if (voice === v) el.mic.classList.remove('recording')
    if (v.processor) { v.processor.onaudioprocess = null; v.processor.disconnect(); v.processor = null }
    if (v.source) { v.source.disconnect(); v.source = null }
    if (v.stream) { v.stream.getTracks().forEach(function (t) { t.stop() }); v.stream = null }
  }
  function finishDictation(v) {
    if (v.finishPromise) return v.finishPromise
    v.finishing = true; el.voiceFinish.disabled = true; voiceHint(v, '正在保留最后一句…')
    releaseVoiceCapture(v)
    // Drain queued partial ASR before sending the buffered tail exactly once.
    v.finishPromise = flushVoice(v, true).then(function (out) {
      if (voice !== v) return
      v.draftFinalized = true
      stopVoice(out && out.text ? '录音已结束，文字已保留，确认后发送' : '录音已结束，已保留识别到的文字')
    }).catch(function () { if (voice === v) { v.draftFinalized = true; stopVoice('录音已结束，末尾识别未完成；已保留现有文字，请检查') } })
    return v.finishPromise
  }
  function stopVoice(message, notifyHost) {
    var v = voice
    if (!v) return
    if (holdGesture && holdGesture.voice === v) { cancelHold(message || '本次录音已取消', notifyHost); return }
    if (v.mode === 'draft' && v.ready && !v.draftFinalized && notifyHost !== false) return finishDictation(v)
    voice = null
    clearTimeout(v.idle); clearTimeout(v.segmentTimer); clearTimeout(v.resumeTimer)
    clearTimeout(v.modeTimer); clearInterval(v.clockTimer); el.callPanel.hidden = true
    if (v.rejectMode) { v.rejectMode(new Error('语音已退出')); v.rejectMode = null }
    if (v.sse) v.sse.close()
    releaseVoiceCapture(v)
    if (v.player) { try { v.player.stop() } catch (e) {} }
    var savedReplies = saveVoiceReplies(v).catch(function () { toast('回复音频未保存，请勿关闭页面') })
    if (v.mode === 'call' && v.activated) {
      var chat = S.chats.get(v.sid)
      if (chat && !chat.loading) loadHistory(chat)
      savedReplies.then(function () { return loadVoiceHistory(v.sid) }).then(function () { if (S.cur === v.sid) toBottom() })
      if (!v.waiting && v.hadSpeech) toast('本段尚未发送的录音已取消')
    }
    if (v.ctx) v.ctx.close().catch(function () {})
    el.mic.classList.remove('recording'); el.mic.setAttribute('aria-label', '语音'); el.mic.hidden = Boolean(S.cur && isAgent(S.cur)); el.voiceBar.hidden = true; syncSend(); syncHoldUi()
    if (v.activated && notifyHost !== false) voiceCleanup = voiceJson('/voice-mode/toggle', { sessionId: v.sid, on: false, tabId: v.tab }).catch(function () {})
    if (message) toast(message)
  }
  function voiceIdle(v) {
    clearTimeout(v.idle)
    v.idle = setTimeout(function () { if (voice === v) stopVoice('语音已因长时间无操作退出') }, 300000)
  }
  function callStage(v, name) { if (v.mode === 'call') { if (!v.callTiming) v.callTiming = { epoch: v.epoch }; v.callTiming[name] = Date.now() } }
  function queueVoicePcm(v, samples, final) {
    if (final) callStage(v, 'finalQueuedAt')
    var epoch = v.epoch, offset = v.sent
    v.sent += samples.length
    v.chain = v.chain.then(function () {
      if (voice !== v || epoch !== v.epoch) return null
      if (final) callStage(v, 'finalStartedAt')
      var url = '/voice-mode/asr?sessionId=' + enc(v.sid) + '&epoch=' + epoch + '&offset=' + offset + '&manual=1' + (final ? '&final=1' : '')
      return voiceFetch(url, { method: 'POST', headers: { 'content-type': 'application/octet-stream' }, body: samples.buffer }).then(function (out) {
          if (final && epoch === v.epoch) callStage(v, 'finalReadyAt')
          if (out.loading) throw new Error('识别模型还在准备，请稍后重试')
          if (voice === v && (S.cur === v.sid || v.mode === 'draft') && epoch === v.epoch) { v.text = out.text || ''; voiceDraft(v, v.text, final) }
          return out
      })
    })
    return v.chain
  }
  function flushVoice(v, final) {
    var samples = new Float32Array(v.count), at = 0
    v.parts.forEach(function (p) { samples.set(p, at); at += p.length })
    v.parts = []; v.count = 0
    var epoch = v.epoch, callPartial = v.mode === 'call' && !final
    if (callPartial) v.callPartialPending = true
    var request = queueVoicePcm(v, samples, final)
    if (!callPartial) return request
    return request.then(function (out) { if (v.epoch === epoch) v.callPartialPending = false; return out }, function (error) { if (v.epoch === epoch) v.callPartialPending = false; throw error })
  }
  // Both host synthesis and local playback must drain. A quiet gap between
  // two synthesized sentences is not permission to reopen the microphone.
  function maybeResumeVoice(v) {
    clearTimeout(v.resumeTimer)
    if (voice !== v || v.mode !== 'call' || !v.waiting || !v.responseSeen || !v.turnDone || v.ttsBusy || v.audioPending || v.playing || v.finishing || isRunning(v.sid)) return
    v.resumeTimer = setTimeout(function () {
      if (voice !== v || !v.waiting || !v.turnDone || v.ttsBusy || v.audioPending || v.playing || v.finishing || isRunning(v.sid)) return
      if (el.input.value.trim() || S.att.length) { stopVoice('通话已暂停，请先处理草稿'); return }
      continueVoice(v, true)
    }, v.autoBarge ? 250 : 600)
  }
  function finishVoice() {
    var v = voice
    if (!v || !v.ready || v.finishing) return
    if (v.mode === 'draft') return finishDictation(v)
    if (v.waiting) { continueVoice(v); return }
    if (v.failedSave && v.pendingVoice) { v.finishing = true; el.voiceFinish.disabled = true; submitVoiceMessage(v); return }
    callStage(v, 'endpointAt')
    v.finishing = true; el.voiceFinish.disabled = true; voiceHint(v, v.conversation ? '正在发送语音…' : '正在转成文字…')
    flushVoice(v, true).then(function (out) {
      if (voice !== v) return
      var text = out && out.text && out.text.trim()
      if (!text) { stopVoice('没有识别到清晰语音，请重试'); return }
      if (!v.conversation) { stopVoice(v.edited ? '文字已追加到草稿，请检查后发送' : '已转成文字，可以修改后发送'); return }
      v.pendingVoice = { id: uuid(), role: 'user', text: text, mime: 'audio/wav', audio: voiceWav(v.recorded), durationMs: Math.round(v.total * 1000), requestId: uuid() }
      v.pendingVoice.mode = v.mode === 'call' ? 'call' : 'message'
      if (v.callId) { v.pendingVoice.callId = v.callId; v.pendingVoice.callStartedAt = v.callStartedAt }
      return submitVoiceMessage(v)
    }).catch(function (err) { if (voice === v) stopVoice('语音未完成：' + err.message) }).then(function () {
      if (voice === v) { v.finishing = false; el.voiceFinish.disabled = false; maybeResumeVoice(v) }
    })
  }
  function submitVoiceMessage(v) {
    var item = v.pendingVoice, submitGeneration = v.submitGeneration || 0
    callStage(v, 'storeStartedAt')
    return storeVoice(v.sid, item).then(function () {
      if (voice !== v || S.cur !== v.sid) return
      if (v.mode === 'call' && (v.muted || submitGeneration !== (v.submitGeneration || 0))) {
        var chat = S.chats.get(v.sid); if (chat) { if (!chat.voiceNotSent) chat.voiceNotSent = new Set(); chat.voiceNotSent.add(item.requestId) }
        v.pendingVoice = null; v.failedSave = false; v.epoch++; v.sent = 0; v.parts = []; v.count = 0; v.recorded = []; v.preRoll = []; v.preRollCount = 0; v.total = 0; v.text = ''; v.hadSpeech = false; v.quiet = 0; v.chain = Promise.resolve()
        voiceHint(v, v.muted ? '麦克风已静音，本段未发送' : '正在听，本段录音因静音未发送'); if (chat) draw(chat); return
      }
      callStage(v, 'storedAt')
      v.failedSave = false; el.callInterrupt.textContent = '打断并说'; v.pendingVoice = null; v.replyTo = item.id; v.requestId = item.requestId; v.waiting = true; v.responseSeen = false; v.turnDone = false; v.modelSpeech = false
      voiceHint(v, '正在等待 DSH 回复…'); el.voiceFinish.textContent = '继续说'
      callStage(v, 'promptSubmittedAt')
      send({ voice: true, mode: v.mode === 'call' ? 'call' : 'message', text: item.text, rid: item.requestId })
    }).catch(function (error) {
      if (voice !== v) return
      v.failedSave = true; voiceHint(v, '语音未发送，原声暂存在此页面：' + error.message); el.voiceFinish.textContent = '重试发送'; el.callInterrupt.textContent = '重试发送'
    }).then(function () { if (voice === v) { v.finishing = false; el.voiceFinish.disabled = false; if (v.exitToKeyboard) stopVoice(); else syncHoldUi() } })
  }
  function continueVoice(v, automatic, prefix) {
    if (voice !== v || v.finishing) return
    v.finishing = true; el.voiceFinish.disabled = true
    if (automatic && isRunning(v.sid)) { v.finishing = false; el.voiceFinish.disabled = false; return }
    saveVoiceReplies(v).catch(function () { toast('部分回复音频尚未保存') })
    var cancel = !automatic && isRunning(v.sid) ? rpc('session.cancel', { sessionId: v.sid }) : Promise.resolve()
    cancel.then(function () { return voiceJson('/voice-mode/cancel', { sessionId: v.sid }) }).then(function () {
      if (voice !== v) return
      if (v.player) { try { v.player.stop() } catch (e) {} }
      v.playGeneration++; v.replyAudio = {}; v.playing = false; v.playChain = Promise.resolve(); v.audioPending = 0; v.ttsBusy = false; v.responseSeen = false; v.captions = {}; v.currentSentence = null
      v.epoch++; v.callPartialPending = false; v.callTiming = null; v.preRoll = []; v.preRollCount = 0; v.sent = 0; v.parts = prefix ? prefix.slice() : []; v.interrupting = false; v.count = v.parts.reduce(function (n, p) { return n + p.length }, 0); v.recorded = v.parts.slice(); v.total = v.count / 16000; v.hadSpeech = !!prefix; v.quiet = 0; v.barge = []; v.bargeCount = 0; v.detectPositive = 0; v.chain = Promise.resolve()
      v.base = el.input.value; v.preview = v.base; v.text = ''; v.edited = false; v.waiting = false
      voiceHint(v, v.mode === 'call' ? '通话中 · 正在听，停顿后自动发送' : '录音中 · 点“说完发送”发送语音消息'); el.voiceFinish.textContent = '说完发送'; voiceIdle(v)
    }).catch(function (err) { if (voice === v) stopVoice('暂时无法继续：' + err.message) }).then(function () { if (voice === v) { v.finishing = false; el.voiceFinish.disabled = false } })
  }
  function voiceAudio(v, frame) {
    if (voice !== v || !v.conversation || !v.waiting || frame.sessionId !== v.sid) return
    if (frame.text) {
      v.captions[frame.sentenceId] = frame.text
      if (v.currentSentence === frame.sentenceId) el.voiceCaption.textContent = 'DSH：' + frame.text; el.callCaption.textContent = 'DSH：' + frame.text
    }
    if (!frame.audio) { if (frame.final) saveVoiceReplies(v, frame.sentenceId).catch(function () { voiceHint(v, '回复音频保存失败，请保留页面') }); return }
    var receipt = v.replyAudio[frame.sentenceId] || (v.replyAudio[frame.sentenceId] = { id: uuid(), parts: [], replyTo: v.replyTo, requestId: v.requestId })
    receipt.parts.push({ audio: frame.audio, mime: frame.mime || 'audio/wav', durationMs: frame.durationMs || 0 })
    v.audioPending++; clearTimeout(v.resumeTimer)
    var generation = v.playGeneration
    v.playChain = v.playChain.then(function () {
      if (voice !== v || generation !== v.playGeneration) return
      var raw = atob(frame.audio), bytes = new Uint8Array(raw.length)
      for (var i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i)
      return v.ctx.decodeAudioData(bytes.buffer).then(function (buffer) {
        if (voice !== v || generation !== v.playGeneration) return
        return new Promise(function (resolve) {
          var player = v.ctx.createBufferSource(); v.player = player; v.playing = true
          v.currentSentence = frame.sentenceId
          el.voiceCaption.textContent = 'DSH：' + (v.captions[frame.sentenceId] || '正在说话…'); el.callCaption.textContent = el.voiceCaption.textContent
          player.buffer = buffer; player.connect(v.ctx.destination)
          voiceHint(v, v.mode === 'call' ? (v.autoBarge ? 'DSH 正在说话 · 直接开口可打断' : 'DSH 正在说话 · 点“打断并说”接话') : 'DSH 正在回复语音 · 文字同步显示'); voiceIdle(v)
          el.voiceFinish.textContent = '打断并说'
          player.onended = function () { if (generation === v.playGeneration) { v.playing = false; if (v.player === player) v.player = null } resolve() }
          player.start()
        })
      })
    }).catch(function () { voiceHint(v, '朗读失败，可查看文字或继续说') }).then(function () {
      if (voice !== v || generation !== v.playGeneration) return
      v.audioPending = Math.max(0, v.audioPending - 1)
      if (!v.audioPending) { voiceHint(v, v.mode === 'call' ? '通话中 · 等待回复结束' : '点“继续说”发送下一条语音'); maybeResumeVoice(v) }
    })
  }
  function startVoice(mode) {
    var conversation = mode !== 'draft'
    pauseChatVoice(); stopVoicePreview()
    var sid = S.cur, Audio = window.AudioContext || window.webkitAudioContext
    if (!sid || isAgent(sid) || voice) return
    if (voiceStarting) { toast('上一次录音正在收尾，请稍候'); return }
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia || !Audio) { toast('当前环境不支持录音，请更新 App 或使用 HTTPS 浏览器', 'err'); return }
    if (conversation && (el.input.value.trim() || S.att.length)) { toast('请先处理输入框草稿或已添加的图片；也可以先用录音转文字'); return }
    var v = { sid: sid, tab: uuid(), mode: mode, conversation: conversation, audioPending: 0, ttsBusy: false, responseSeen: false, ctx: new Audio(), epoch: 1, sent: 0, parts: [], count: 0, total: 0, quiet: 0, hadSpeech: false, text: '', base: el.input.value, preview: el.input.value, chain: Promise.resolve(), playChain: Promise.resolve(), playGeneration: 0 }
    if (mode === 'call') { v.callId = uuid(); v.callStartedAt = new Date().toISOString() }
    v.preRoll = []; v.preRollCount = 0; v.recorded = []; v.replyAudio = {}; v.barge = []; v.bargeCount = 0; v.detectPositive = 0; v.captions = {}; el.voiceCaption.textContent = ''; el.voiceCaption.hidden = !conversation; el.voiceEnd.hidden = !conversation; el.voiceBar.classList.toggle('dictation', !conversation); el.mic.setAttribute('aria-label', conversation ? '退出语音' : '结束录音')
    voice = v; voiceStarting = true; el.callPanel.hidden = mode !== 'call'; el.callCaption.textContent = ''; el.callClock.textContent = '00:00'; el.callMute.textContent = '静音'; el.callInterrupt.textContent = '打断并说'; v.startedAt = Date.now(); if (mode === 'call') v.clockTimer = setInterval(function () { var n = Math.floor((Date.now() - v.startedAt) / 1000); el.callClock.textContent = String(Math.floor(n / 60)).padStart(2, '0') + ':' + String(n % 60).padStart(2, '0') }, 1000); v.ctx.resume().catch(function () {})
    el.mic.hidden = true; el.voiceBar.hidden = mode === 'call'; el.voiceFinish.disabled = true; el.voiceFinish.textContent = conversation ? '说完发送' : '结束录音'; voiceHint(v, '正在申请麦克风…'); syncSend()
    voiceCleanup.then(function () { return navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }, video: false }) }).then(function (stream) {
      if (voice !== v) { stream.getTracks().forEach(function (t) { t.stop() }); return null }
      v.stream = stream
      stream.getTracks().forEach(function (track) { track.enabled = !v.muted })
      var track = stream.getAudioTracks ? stream.getAudioTracks()[0] : stream.getTracks()[0], settings = track && track.getSettings ? track.getSettings() : {}; v.autoBarge = settings.echoCancellation === true
      if (mode === 'call' && !v.autoBarge) toast('此设备未确认回声消除，请用“打断并说”接话')
      // Resolve a cold session through the native command inventory, not a
      // model prompt; this attaches the voice session without billing a turn.
      return rpc('commands/list', { args: { agentId: sid } }).then(function () {
        if (voice !== v) return null
        v.sse = new EventSource('/voice-mode/stream?tabId=' + enc(v.tab))
        var baseline = new Promise(function (resolve, reject) {
          v.rejectMode = reject
          v.modeTimer = setTimeout(function () { reject(new Error('语音回传连接超时，请重试')) }, 15000)
          v.sse.addEventListener('mode', function (event) {
            var f = JSON.parse(event.data)
            if (!v.modeSeen) { v.modeSeen = true; v.rejectMode = null; clearTimeout(v.modeTimer); resolve(); return }
            if (v.activated && (f.active !== sid || (f.ownerTabId && f.ownerTabId !== v.tab))) stopVoice('语音已在另一设备切换或结束', false)
          })
        })
        v.sse.onerror = function () {
          if (voice !== v) return
          stopVoice('语音连接断开，录音已停止，已保存的语音可在记录中回放')
          voiceJson('/voice-mode').then(function (status) {
            if (!voice && status.connections >= status.connectionLimit) toast('语音连接已满，请关闭不用的 DSH 窗口后重试')
          }).catch(function () {})
        }
        v.sse.addEventListener('audio', function (event) { voiceAudio(v, JSON.parse(event.data)) })
        v.sse.addEventListener('tts-state', function (event) {
          var f = JSON.parse(event.data)
          if (voice !== v || f.sessionId !== v.sid) return
          v.ttsBusy = f.busy; maybeResumeVoice(v); syncHoldUi()
        })
        v.sse.addEventListener('turn', function (event) {
          var f = JSON.parse(event.data)
          if (voice !== v || !v.waiting || f.sessionId !== v.sid) return
          if (f.state === 'agent-speaking') { v.modelSpeech = true; v.turnDone = false }
          if (f.state === 'listening' && v.modelSpeech) { v.turnDone = true; maybeResumeVoice(v); syncHoldUi() }
        })
        v.sse.addEventListener('tts-error', function () { voiceHint(v, '朗读暂不可用，请查看文字回复') })
        // Drain the initial mode snapshot before activation, so a delayed
        // baseline cannot be mistaken for another device ending our recording.
        return baseline.then(function () { if (voice !== v) return null; return voiceJson('/voice-mode/toggle', { sessionId: sid, on: true, tabId: v.tab, lang: 'zh', mode: mode === 'call' ? 'call' : mode === 'chat' ? 'message' : 'draft' }) })
      })
    }).then(function (result) {
      if (!result) return
      v.activated = true
      if (voice !== v || S.cur !== sid) return voiceJson('/voice-mode/toggle', { sessionId: sid, on: false, tabId: v.tab }).catch(function () {})
      v.source = v.ctx.createMediaStreamSource(v.stream); v.processor = v.ctx.createScriptProcessor(4096, 1, 1)
      var silent = v.ctx.createGain(); silent.gain.value = 0
      v.source.connect(v.processor); v.processor.connect(silent); silent.connect(v.ctx.destination)
      v.ready = true; el.voiceFinish.disabled = false; el.mic.classList.add('recording'); voiceIdle(v)
      voiceHint(v, mode === 'call' ? (v.muted ? '麦克风已静音' : '通话中 · 正在听，停顿后自动发送') : conversation ? '录音中 · 点“说完发送”发送语音消息' : '正在听…')
      v.processor.onaudioprocess = function (event) {
        if (voice !== v || v.failedSave || v.muted || (v.finishing && !v.interrupting)) return
        var src = event.inputBuffer.getChannelData(0), ratio = v.ctx.sampleRate / 16000, count = Math.floor(src.length / ratio), pcm = new Float32Array(count), energy = 0
        for (var i = 0; i < count; i++) { var pos = i * ratio, a = Math.floor(pos), b = Math.min(a + 1, src.length - 1); pcm[i] = src[a] + (src[b] - src[a]) * (pos - a); energy += pcm[i] * pcm[i] }
        if (v.waiting || v.playing || v.interrupting) { if (v.mode === 'call') detectBarge(v, pcm, Math.sqrt(energy / Math.max(1, count))); return }
        var seconds = count / 16000, talking = Math.sqrt(energy / Math.max(1, count)) > 0.012
        if (v.mode === 'call' && !v.hadSpeech) {
          if (!talking) {
            // Before the user starts a turn, silence is not an utterance. Keep
            // only 250 ms so a quiet leading consonant can precede the first
            // above-threshold frame without accumulating or uploading idle time.
            v.preRoll.push(pcm); v.preRollCount += count
            while (v.preRollCount > 4000) {
              var excess = v.preRollCount - 4000, first = v.preRoll[0]
              if (first.length <= excess) { v.preRoll.shift(); v.preRollCount -= first.length }
              else { v.preRoll[0] = first.subarray(excess); v.preRollCount -= excess }
            }
            return
          }
          v.preRoll.forEach(function (part) { v.parts.push(part); v.recorded.push(part) })
          v.count += v.preRollCount; v.total += v.preRollCount / 16000
          v.preRoll = []; v.preRollCount = 0
        }
        if (talking) { callStage(v, 'lastSpeechAt'); v.hadSpeech = true; v.quiet = 0; voiceIdle(v) } else v.quiet += seconds
        v.recorded.push(pcm); v.parts.push(pcm); v.count += count; v.total += seconds
        if ((v.mode === 'call' && v.hadSpeech && v.quiet > 0.9) || v.total > 55) { if (v.held && holdGesture) releaseHold(false, true); else finishVoice(); return }
        if (v.count >= 16000 && (v.mode !== 'call' || !v.callPartialPending)) flushVoice(v, false).catch(function (err) { if (voice === v) stopVoice('录音识别中断：' + err.message) })
      }
    }).catch(function (err) { if (voice === v) stopVoice(err.name === 'NotAllowedError' ? '麦克风未授权。安卓请更新 App，并在首次录音时允许麦克风。' : '无法开启语音：' + err.message) }).then(function () { voiceStarting = false; syncHoldUi() })
  }
  var voicePreview = null, speakerView = 0
  function stopVoicePreview() {
    if (!voicePreview) return
    clearTimeout(voicePreview.timer); voicePreview.controller.abort(); voicePreview.audio.pause(); voicePreview.audio.remove()
    if (voicePreview.box) voicePreview.box.remove()
    if (voicePreview.button) voicePreview.button.disabled = false
    if (voicePreview.url) URL.revokeObjectURL(voicePreview.url)
    voicePreview = null
  }
  function speakerSettings() {
    var generation = ++speakerView, config, busy = false
    el.sheet.innerHTML = '<div class="sh-h">声音设置</div><div class="sh-b" id="speakerChoices">正在读取声音…</div>'
    function paint() {
      if (generation !== speakerView) return
      el.sheet.innerHTML = '<div class="sh-h">声音设置</div><div class="sh-b speaker-options">' + config.items.map(function (item) { return '<div class="speaker-row"><button data-speaker="' + esc(item.id) + '"' + (!item.ready || busy ? ' disabled' : '') + ' aria-pressed="' + (config.current === item.id) + '"><b>' + esc(item.name) + '</b><small>' + (item.gender === 'F' ? '女声' : '男声') + (config.current === item.id ? ' · 当前声音' : '') + (item.latencyHint ? ' · ' + esc(item.latencyHint) : '') + (!item.ready ? ' · 暂不可用' : '') + '</small></button><button class="link" data-speaker-preview="' + esc(item.id) + '"' + (!item.ready ? ' disabled' : '') + '>试听</button></div>' }).join('') + '<div id="speakerPreview"></div></div>'
    }
    voiceJson('/voice-mode/speakers').then(function (out) { if (generation !== speakerView) return; config = out; paint() }, function (error) { if (generation === speakerView) el.sheet.innerHTML = '<div class="sh-h">声音设置</div><p>' + esc(error.message) + '</p>' })
    el.sheet.onclick = function (event) {
      if (!config || generation !== speakerView) return
      var preview = event.target.closest('[data-speaker-preview]'), select = event.target.closest('[data-speaker]'), id = preview ? preview.dataset.speakerPreview : select && select.dataset.speaker
      if (!id || !config.items.some(function (item) { return item.id === id && item.ready })) return
      if (preview) {
        stopVoicePreview()
        var audio = document.createElement('audio'), controller = new AbortController(), current = { audio: audio, controller: controller, url: null }
        voicePreview = current; audio.controls = true; audio.hidden = true
        var previewBox = document.createElement('div'), previewStatus = document.createElement('p'), row = typeof preview.closest === 'function' ? preview.closest('.speaker-row') : null
        previewBox.className = 'speaker-preview-inline'; previewStatus.className = 'speaker-preview-status'; previewStatus.setAttribute('role', 'status'); previewStatus.textContent = '正在合成试听…模型首次准备较慢，请稍候'
        current.box = previewBox; current.button = preview; preview.disabled = true
        previewBox.appendChild(previewStatus); previewBox.appendChild(audio); (row || document.getElementById('speakerPreview')).appendChild(previewBox); previewBox.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
        current.timer = setTimeout(function () { if (voicePreview === current) { controller.abort(); preview.disabled = false; previewStatus.textContent = '试听等待较久，已停止本次等待，可再次点试听重试' } }, 180000)
        fetch('/voice-mode/preview', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ voice: id, rate: config.rate }), signal: controller.signal }).then(function (response) { if (!response.ok) return response.json().catch(function () { return {} }).then(function (error) { throw new Error(error.error || '试听暂不可用') }); return response.blob() }).then(function (blob) {
          if (voicePreview !== current || generation !== speakerView) return
          clearTimeout(current.timer); preview.disabled = false; current.url = URL.createObjectURL(blob); audio.src = current.url; audio.hidden = false; previewStatus.textContent = '试听已准备好'; return audio.play().catch(function () { previewStatus.textContent = '请点下方播放器试听' })
        }).catch(function (error) { clearTimeout(current.timer); preview.disabled = false; if (voicePreview === current && error.name !== 'AbortError') { previewStatus.textContent = '试听失败：' + error.message + '，可再次点试听重试'; toast(error.message) } })
        return
      }
      if (busy) return
      busy = true; stopVoicePreview(); paint()
      voiceJson('/voice-mode/speakers', { voice: id }).then(function (out) { if (!out.ok) throw new Error(out.error || '声音设置失败'); config.current = out.voice; config.rate = out.rate; toast('声音已切换') }).catch(function (error) { toast(error.message) }).then(function () { busy = false; paint() })
    }
  }
  function voiceMenu() {
    if (voice) { stopVoice('已退出语音，识别文字保留在输入框'); return }
    openSheet('<div class="sh-h">语音</div><div class="sh-b"><button class="opt-row" data-voice="draft"><span class="mid"><b>录音转文字</b><small>点击开始说话，转成文字后手动发送</small></span></button><button class="opt-row" data-voice="chat"><span class="mid"><b>语音消息</b><small>按住说话，松开发送，上滑取消</small></span></button><button class="opt-row" data-voice="call"><span class="mid"><b>实时语音通话</b><small>接通后直接聊天，可开口打断，带实时字幕</small></span></button><div class="voice-settings-divider"></div><button class="opt-row" data-speaker-settings><span class="mid"><b>声音设置</b><small>选择声音或试听</small></span></button></div>')
    el.sheet.onclick = function (event) { if (event.target.closest('[data-speaker-settings]')) { speakerSettings(); return } var b = event.target.closest('[data-voice]'); if (!b) return; closeOverlay(); if (b.dataset.voice === 'chat') chooseHoldMode('chat'); else { holdMode = null; syncHoldUi(); startVoice(b.dataset.voice) } }
  }

  var PERMISSIONS = {
    'read-only': ['只读', 'Read Only', '仅查看文件，不修改'],
    'workspace-write': ['工作区写入', 'Workspace Write', '可修改当前项目，越界操作需审批'],
    'danger-full-access': ['完全访问', 'Full access', '可访问工作区外的文件，执行时不再请求审批'],
  }
  function renderPermission(c) {
    if (c.id !== S.cur) return
    el.permission.hidden = isAgent(c.id)
    el.permission.disabled = Boolean(c.permissionBusy)
    var value = c.permissions && c.permissions.currentValue
    el.permission.innerHTML = ic('shield', 's') + esc(c.permissionBusy ? '切换中…' : (PERMISSIONS[value] || [value === 'custom' ? '自定义权限' : '权限设置'])[0]) + ic('down', 's')
  }
  function loadPermissions(c) {
    var revision = c.permissionRevision || 0
    return rpc('session.permissions', { sessionId: c.id }).then(function (v) {
      if ((c.permissionRevision || 0) === revision) c.permissions = v
      renderPermission(c)
      return c.permissions
    })
  }
  function permissionSheet() {
    var c = S.chats.get(S.cur)
    if (!c || isAgent(c.id) || c.permissionBusy) return
    openSheet('<div class="sh-h">会话权限</div><div class="sh-b" id="permissionOptions">正在读取…</div>')
    var box = document.getElementById('permissionOptions')
    function paint() {
      if (!hasOverlay('sheet') || document.getElementById('permissionOptions') !== box) return
      box.innerHTML = c.permissions.options.filter(function (o) { return PERMISSIONS[o.value] }).map(function (o) {
        var labels = PERMISSIONS[o.value], active = c.permissions.currentValue === o.value
        return '<button class="opt-row' + (active ? ' permission-active' : '') + '" data-permission="' + esc(o.value) + '" aria-pressed="' + active + '"' + (c.permissionBusy ? ' disabled' : '') + '><span class="ico">' + ic('shield', 's') + '</span><span class="mid"><b>' + labels[0] + ' · ' + labels[1] + '</b><small>' + labels[2] + '</small></span>' + (active ? ic('check', 's') : '') + '</button>'
      }).join('')
    }
    c.paintPermissions = paint
    loadPermissions(c).then(paint, function (err) { box.textContent = err.message })
    el.sheet.onclick = function (e) {
      var b = e.target.closest('[data-permission]')
      if (!b || c.permissionBusy || !c.permissions) return
      var preset = b.dataset.permission
      if (!PERMISSIONS[preset] || !c.permissions.options.some(function (o) { return o.value === preset })) return
      if (preset === c.permissions.currentValue) { closeOverlay(); return }
      var full = preset === 'danger-full-access'
      if (full && !window.confirm('启用完全访问？\n\nDSH 将能修改工作区外的文件、执行命令，并且不再请求操作审批。仅对当前会话生效。')) return
      c.permissionBusy = true
      paint(); renderPermission(c)
      rpc('session.selectPermission', { sessionId: c.id, preset: preset, confirmFullAccess: full }).then(function (v) {
        c.permissions = v; c.permissionRevision = (c.permissionRevision || 0) + 1
        if (c.id === S.cur && document.getElementById('permissionOptions') === box) closeOverlay()
        toast('已切换为' + PERMISSIONS[v.currentValue][0]); buzz()
      }, function (err) {
        toast(err.message + '；请重新打开权限菜单核对状态', 'err')
        return loadPermissions(c).catch(function () { c.permissions = null })
      }).then(function () { c.permissionBusy = false; renderPermission(c); if (c.permissions) paint() })
    }
  }

  // ------------------------------------------------------------ chat: live frames
  function onFrame(f) {
    switch (f.t) {
      case 'p': return
      case 'voiceSaved': {
        if (!f.s || f.s !== S.cur || isAgent(f.s) || !f.item) return
        var owner = S.chats.get(f.s); if (!owner) return
        if (f.item.mode === 'message' && !f.item.callId) mergeConfirmedVoice(f.s, f.item)
        else Promise.resolve(owner.voiceLoading).then(function () { if (S.cur === f.s) loadVoiceHistory(f.s) })
        return
      }
      case 'hello':
        S.hellos++
        setStatus('online')
        S.asks.clear()
        S.qs.clear()
        // The host only sends nonempty queue baselines on reconnect.
        S.chats.forEach(function (c) { c.queue = [] })
        drawDock()
        if (S.hellos > 1) resync()
        loadAgents()
        scheduleHome()
        return
      case 'run': return setRun(f.s, f.on)
      case 'list': return scheduleBoot()
      case 'agents': return scheduleAgents()
      case 'title': return setTitle(f.s, f.title)
      case 'permissions': {
        var pc = S.chats.get(f.s)
        if (pc) { pc.permissions = f.value; pc.permissionRevision = (pc.permissionRevision || 0) + 1; renderPermission(pc); if (pc.paintPermissions && pc.permissions) pc.paintPermissions() }
        return
      }
      case 'ask': S.asks.set(f.id, f); buzz(30); return onPending(f.s)
      case 'askDone': { var a = S.asks.get(f.id); S.asks.delete(f.id); return onPending((a && a.s) || f.s) }
      case 'q': S.qs.set(f.rpc, f); buzz(30); return onPending(f.s)
      case 'qDone': { var q = S.qs.get(f.rpc); S.qs.delete(f.rpc); return onPending((q && q.s) || f.s) }
      case 'queue': {
        // Inbox snapshots are independent of history loading and can arrive
        // for a conversation before it has ever been opened on this phone.
        var queuedChat = S.chats.get(f.s)
        if (!queuedChat) { queuedChat = chatState(f.s); S.chats.set(f.s, queuedChat) }
        apply(queuedChat, f)
        return
      }
      case 'agentErr': if (f.s === S.cur) toast(f.msg || '运行出错', 'err'); return
      case 'err': return
    }
    var c = S.chats.get(f.s)
    if (!c) return
    if (c.loading) { c.buf.push(f); return }
    if (!c.loaded) return
    apply(c, f)
  }
  function onPending(s) {
    scheduleHome()
    if (s === S.cur) drawDock()
  }
  function ensurePartial(c) { return c.partial || (c.partial = { text: '', think: false, tool: null }) }
  function fresh(c, seq) {
    if (seq <= c.lastSeq) return false
    c.lastSeq = seq
    return true
  }
  function apply(c, f) {
    switch (f.t) {
      case 'd': {
        var add = ''
        f.p.forEach(function (x) { if (x[0] > c.lastSeq) { add += x[1]; c.lastSeq = x[0] } })
        if (add) { var p = ensurePartial(c); p.text += add; p.tool = null; drawPartial(c) }
        return
      }
      case 'think': if (fresh(c, f.seq)) { ensurePartial(c).think = true; drawPartial(c) } return
      case 'tooling': if (fresh(c, f.seq)) { ensurePartial(c).tool = f.name; drawPartial(c) } return
      case 'step': if (fresh(c, f.seq)) { c.partial = null; drawPartial(c) } return
      case 'turn': if (fresh(c, f.seq)) { S.run.add(c.id); drawPartial(c) } return
      case 'final':
        if (!fresh(c, f.seq)) return
        c.partial = null
        if (f.it) c.items.push(f.it)
        draw(c)
        return
      case 'item': {
        var it = f.it
        if (!it || !fresh(c, it.seq)) return
        if (it.k === 'u') {
          var i = -1
          c.pending.forEach(function (p, j) { if (i < 0 && p.rid && p.rid === it.rid) i = j })
          if (i >= 0) c.pending.splice(i, 1)
          touch(c.id)
        }
        if (it.k === 'end') { c.partial = null; touch(c.id); loadVoiceHistory(c.id) }
        c.items.push(it)
        pruneQueue(c)
        draw(c)
        return
      }
      case 'result': {
        if (!fresh(c, f.seq)) return
        for (var k = c.items.length - 1; k >= 0; k--) {
          var t = c.items[k]
          if (t.k === 't' && t.id === f.id) {
            t.done = true; t.err = f.err; t.out = f.out; t.rseq = f.seq
            if (f.more) t.more = true
            if (f.paths) t.paths = (t.paths || []).concat(f.paths.filter(function (p) { return !t.paths || t.paths.indexOf(p) < 0 }))
            break
          }
        }
        draw(c)
        return
      }
      case 'todo': c.todos = f.todos; if (c.id === S.cur) drawDock(); return
      case 'queue': {
        var prevWait = {}
        ;(c.queue || []).forEach(function (x) { if (x.id && x.waitAck) prevWait[x.id] = true })
        c.queue = (f.items || []).map(function (x) { return x.id && prevWait[x.id] ? Object.assign({}, x, { waitAck: true }) : x })
        pruneQueue(c)
        if (c.id === S.cur) drawDock()
        return
      }
    }
  }
  function resync() {
    loadBoot().catch(function () {})
    S.chats.forEach(function (c) {
      if (c.id === S.cur) { loadHistory(c); if (!isAgent(c.id)) { loadVoiceHistory(c.id); loadPermissions(c).catch(function () {}) } }
      else { c.loaded = false; c.partial = null }
    })
  }

  // ------------------------------------------------------------ chat: rendering
  function nearBottom() { var s = el.scroller; return s.scrollHeight - s.scrollTop - s.clientHeight < 90 }
  function toBottom() { el.scroller.scrollTop = el.scroller.scrollHeight }
  var msgRaf = 0, tailRaf = 0
  function draw(c) {
    if (c.id !== S.cur || msgRaf) return
    msgRaf = requestAnimationFrame(function () { msgRaf = 0; renderMsgs(c) })
  }
  function drawPartial(c) {
    if (c.id !== S.cur || tailRaf) return
    tailRaf = requestAnimationFrame(function () {
      tailRaf = 0
      var stick = nearBottom()
      drawTail(c)
      if (stick) toBottom()
    })
  }
  function renderHead() {
    var c = S.chats.get(S.cur)
    if (!c) return
    renderPermission(c)
    var s = S.byId[c.id], ag = isAgent(c.id) && agentOf(c.id)
    el.cTitle.textContent = (ag && (ag.title || ag.project)) || (s && s.title) || c.title || (isAgent(c.id) ? '外部会话' : '新对话')
    var sub = ''
    if (S.status !== 'online') sub += (S.status === 'offline' ? '电脑离线' : '连接中…') + ' · '
    else if (isRunning(c.id)) sub += '<span class="live"><span class="spin s"></span>运行中</span> · '
    if (isAgent(c.id)) sub += esc(ag ? ag.name + (ag.project ? ' · ' + ag.project : '') : '')
    else sub += esc(wsTitle(wsOf(c.id)))
    if (c.model && !isAgent(c.id)) sub += ' · ' + esc(modelName(c))
    if (s && s.cx >= 70) sub += ' · <span class="warn">上下文 ' + s.cx + '%</span>'
    el.cSub.innerHTML = sub
  }
  function userHtml(c, it, audioItem) {
    var imgs = (it.imgs || []).map(function (im) {
      return '<img loading="lazy" data-view src="' + esc(im.url || imgUrl(c.id, im.id)) + '" alt="">'
    }).join('')
    return '<div class="u' + (it.pending ? ' pending' : '') + '">' + (imgs ? '<div class="imgs">' + imgs + '</div>' : '') + (audioItem ? '<div class="voice-user">' + voiceBubbleHtml(c, audioItem, it.text || audioItem.text, it.pending ? '正在确认发送…' : '') + '</div>' : it.text ? '<div class="bub">' + esc(it.text) + '</div>' : '') + '</div>'
  }
  function resultExcerpt(text) {
    var first = text.trim().split(/\n\s*\n/)[0].replace(/\[([^\]]+)\]\((?:<[^>]*>|[^)]*)\)/g, '$1')
      .replace(/^\s*(?:#{1,6}\s+|[-*+]\s+|\d+[.)]\s+)/gm, '').replace(/[`*_]/g, '').replace(/\s+/g, ' ').trim()
    var chars = Array.from(first)
    return chars.slice(0, 120).join('') + (chars.length > 120 ? '…' : '')
  }
  function asstHtml(it, c, resultOnly, completed, audioItem, voiceOwner) {
    var h = '<div class="a" data-message-seq="' + esc(it.seq) + '">'
    var pendingVoice = !audioItem && voiceOwner && voiceOwner.mode === 'message'
    if (audioItem) h += voiceBubbleHtml(c, audioItem, '', '')
    else if (pendingVoice) h += pendingVoiceHtml(c, voiceOwner)
    if (it.think && !resultOnly) {
      h += '<button class="think" data-think="' + it.seq + '">' + ic('bulb', 's') + '思考过程' + ic(it._t ? 'down' : 'chev', 's') + '</button>'
      if (it._t) h += '<div class="think-body">' + esc(it.think) + '</div>'
    }
    if (it.text) {
      var root = wsRoot(c.id)
      if (!it._h || it._root !== root) {
        var ctx = { root: root, paths: [] }
        it._h = md(it.text, ctx); it._paths = ctx.paths; it._root = root
      }
      var folded = resultOnly && completed && (it.text.length > 600 || it.text.split('\n').length > 12)
      if (audioItem || pendingVoice) h += voiceTextHtml(c, audioItem || { role: 'assistant', replyTo: voiceOwner.id }, '<div class="md">' + it._h + '</div>')
      else if (folded) {
        var opened = c.resultOpen && c.resultOpen.has(it.seq)
        h += '<div class="result-excerpt"' + (opened ? ' hidden' : '') + '>' + esc(resultExcerpt(it.text)) + '</div><details class="result-details" data-result-details="' + it.seq + '"' + (opened ? ' open' : '') + '><summary>查看完整结果</summary><div class="md">' + it._h + '</div></details>'
      } else h += '<div class="md">' + it._h + '</div>'
      if (resultOnly) h += (it._paths || []).filter(videoPath).map(function (p) {
        return '<div class="artifact"><div class="artifact-head"><b>' + esc(baseName(p)) + '</b><button data-result-path="' + esc(p) + '">' + ic('folder', 's') + '所在文件夹</button></div>' +
          videoHtml(c.id, p, 'artifact-video', it.seq) + '</div>'
      }).join('')
      if (folded) h += (it._paths || []).filter(function (p) { return !videoPath(p) }).map(function (p) {
        return '<div class="artifact artifact-file"><div class="artifact-head"><b>' + esc(baseName(p)) + '</b><button data-result-path="' + esc(p) + '">' + ic('folder', 's') + '所在文件夹</button></div></div>'
      }).join('')
      if (it._fin && !audioItem && !pendingVoice) h += '<div class="acts"><button data-copymsg="' + it.seq + '">' + ic('copy', 's') + '复制</button></div>'
    }
    return h + '</div>'
  }
  function processHtml(c, items, final, running) {
    var detail = items.filter(function (it) { return it !== final && (it.k === 't' || it.k === 'a') })
    if (final && final.think) detail.push({ k: 'a', seq: final.seq, think: final.think, _t: final._t })
    if (!detail.length) return ''
    var key = items[0].seq, opened = c.processOpen && c.processOpen.has(key), h = ''
    if (opened) {
      var group = []
      function flush() { if (group.length) { h += toolsHtml(c, group); group = [] } }
      detail.forEach(function (it) { if (it.k === 't') group.push(it); else { flush(); h += asstHtml(it, c, false) } })
      flush()
    }
    return '<div class="process' + (opened ? ' o' : '') + '"><button class="process-toggle" data-process="' + key + '" aria-expanded="' + Boolean(opened) + '">' +
      (running ? '<span class="spin s"></span>' : ic('checkc', 's')) + '<span>' + (opened ? '收起过程' : '查看过程') + '</span>' + ic('chev', 's') + '</button>' + (opened ? '<div class="process-body">' + h + '</div>' : '') + '</div>'
  }
  function toolRow(t) {
    var st = t.err ? ic('xc', 's st bad') : t.done ? ic('checkc', 's st') : t._spin ? '<span class="spin s"></span>' : ''
    var body = ''
    if (t._o) {
      if (t.detail && t.detail !== t.title) body += '<pre>' + esc(t.detail) + '</pre>'
      if (t.out) body += '<pre class="out' + (t.err ? ' bad' : '') + '">' + esc(t.out) + '</pre>'
      var acts = (t.more ? '<button data-full="' + esc(t.id) + '">' + ic('read', 's') + '<span>完整内容</span></button>' : '') + chipsHtml(t.paths, wsRoot(S.cur))
      if (acts) body += '<div class="tacts">' + acts + '</div>'
    }
    return '<div class="tr' + (t._o ? ' o' : '') + '"><button class="trh" data-tool="' + esc(t.id) + '">' + ic(KI[t.kind] || 'other', 's') + '<span>' + esc(t.title) + '</span>' + st + '</button>' + body + '</div>'
  }
  function toolsHtml(c, arr) {
    if (arr.length === 1) return '<div class="tools single">' + toolRow(arr[0]) + '</div>'
    var key = arr[0].seq, open = c.open.has(key)
    var kinds = [], errs = 0, spin = false
    arr.forEach(function (t) {
      var k = KI[t.kind] || 'other'
      if (kinds.indexOf(k) < 0 && kinds.length < 4) kinds.push(k)
      if (t.err) errs++
      if (t._spin) spin = true
    })
    var last = arr[arr.length - 1]
    return '<div class="tools' + (open ? ' o' : '') + '"><button class="tg" data-group="' + key + '"><span class="kinds">' + kinds.map(function (k) { return ic(k, 's') }).join('') +
      '</span><span class="n">' + arr.length + ' 个操作</span>' + (errs ? '<span class="bad">' + errs + ' 失败</span>' : '') +
      '<span class="last">' + (open ? '' : esc(last.title)) + '</span>' + (spin ? '<span class="spin s"></span>' : '') + ic('chev', 's chev') + '</button>' +
      (open ? arr.map(toolRow).join('') : '') + '</div>'
  }
  var END = { completed: '完成', interrupted: '已中断', aborted: '已停止', cancelled: '已停止', error: '出错', failed: '出错' }
  function endHtml(it) {
    var bad = it.reason === 'error' || it.reason === 'failed'
    return '<div class="end' + (bad ? ' bad' : '') + '">' + esc(END[it.reason] || it.reason) + (it.ms ? ' · ' + dur(it.ms) : '') + '</div>'
  }
  function renderMsgs(c, jump, keep) {
    if (c.id === S.cur) syncSuggestion()
    if (c.id !== S.cur) return
    // Detaching a fullscreen element exits native fullscreen and interrupts
    // WebView playback. Receive frames normally and paint once after exit.
    var fullscreen = fullVideo || nativeVideo
    if (fullscreen && fullscreen.v.dataset.session === c.id && fullscreen.v.getAttribute('data-message-seq') != null) { fullscreen.redraw = true; return }
    var activeVoice = Array.prototype.find.call(el.msgs.querySelectorAll('audio[data-voice-id]'), function (audio) { return audio.dataset.session === c.id && !audio.paused && !audio.ended })
    if (activeVoice) { c.voiceRepaint = true; drawTail(c); return }
    c.voiceRepaint = false
    var stick = jump || (!keep && nearBottom())
    if (!c.loaded) {
      el.older.innerHTML = ''
      el.msgs.innerHTML = c.err && !c.loading ? '<div class="hint"><b>加载失败</b><button class="link" data-retry>重试</button></div>' : '<div class="spin"></div>'
      el.tail.innerHTML = ''
      return
    }
    el.older.innerHTML = c.hasMore ? '<button data-older>' + (c.olderLoading ? '加载中…' : '查看更早的消息') + '</button>' : ''
    var running = isRunning(c.id), lastEnd = -1
    c.items.forEach(function (it, i) { if (it.k === 'end') lastEnd = i })
    c.items.forEach(function (it, i) { if (it.k === 't') it._spin = running && !it.done && i > lastEnd })
    // One expandable process per turn. The last text answer is the result;
    // live commentary and tool output never create a wall above it.
    c.voicePendingReply = false
    var h = '', turn = [], turnVoice = null, usedVoice = new Set(), voiceItems = c.voiceItems || []
    var callGroups = new Map(), shownCalls = new Set()
    voiceItems.forEach(function (item) { if (item.mode !== 'call' || !item.callId || item.role !== 'user') return; var group = callGroups.get(item.callId) || { id: item.callId, start: item.callStartedAt, rounds: 0, lastRequest: null }; group.rounds++; group.lastRequest = item.requestId; callGroups.set(item.callId, group) })
    function callSummary(item) {
      var group = item && item.callId && callGroups.get(item.callId)
      if (!group || shownCalls.has(group.id) || item.requestId !== group.lastRequest) return ''
      shownCalls.add(group.id)
      var active = voice && voice.callId === group.id, time = group.start ? new Date(group.start).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }) : ''
      return '<button class="call-record" data-call-locate="' + esc(group.id) + '"><b>' + (active ? '语音通话中' : '语音通话记录') + '</b><span>' + esc(time) + ' 开始 · ' + group.rounds + '轮对话</span><small>查看本次通话</small></button>'
    }
    function userVoice(it) { return it.rid && voiceItems.find(function (item) { return item.role === 'user' && item.requestId === it.rid }) }
    function replyVoice() { return turnVoice && voiceItems.find(function (item) { return item.role === 'assistant' && !usedVoice.has(item.id) && item.replyTo === turnVoice.id && item.requestId === turnVoice.requestId }) }
    function appendUser(it) { var item = userVoice(it); if (item) usedVoice.add(item.id); h += userHtml(c, it, item); return item }
    function flush(done) {
      if (!turn.length && !replyVoice()) return
      var final = null, end = null
      turn.forEach(function (it) { if (it.k === 'a') { it._fin = false; if (it.text) final = it } else if (it.k === 'end') end = it })
      if (!done) final = null
      if (final) final._fin = true
      var reply = replyVoice()
      if (final) { if (reply) usedVoice.add(reply.id); h += asstHtml(final, c, true, end && end.reason === 'completed', reply, turnVoice) }
      else if (reply) { usedVoice.add(reply.id); h += '<div class="a voice-awaiting">' + voiceBubbleHtml(c, reply, done ? reply.text : '', done ? '语音回复' : '回复文字正在同步…') + '</div>' }
      h += processHtml(c, turn, final, !done)
      if (end && (end.reason !== 'completed' || turn.some(function (item) { return item.k === 't' }))) h += endHtml(end)
      if (done) h += callSummary(turnVoice)
      turn = []
    }
    c.items.forEach(function (it) {
      if (it.k === 'u') { flush(true); turnVoice = appendUser(it) }
      else { turn.push(it); if (it.k === 'end') flush(true) }
    })
    flush(!running)
    c.pending.forEach(function (p) { turnVoice = appendUser(p); flush(false) })
    var unmatchedVoice = '', unmatchedCount = 0, deferredVoiceCount = 0
    voiceItems.forEach(function (item) {
      if (usedVoice.has(item.id)) return
      var recentUnsent = (c.voiceNotSent && c.voiceNotSent.has(item.requestId)) || (c.voiceUnknown && c.voiceUnknown.has(item.requestId))
      if (c.hasMore && !recentUnsent) { deferredVoiceCount++; return }
      var status = c.voiceNotSent && c.voiceNotSent.has(item.requestId) ? '录音已保存，本段因静音未发送' : c.voiceUnknown && c.voiceUnknown.has(item.requestId) ? '发送状态未确认；请先核对对话，不会自动重发' : c.hasMore ? '更早的语音，当前消息页尚未加载对应回合' : '已保存的语音，尚未关联当前对话回合'
      var orphan = '<div class="' + (item.role === 'user' ? 'u' : 'a') + ' voice-orphan">' + voiceBubbleHtml(c, item, item.text, status) + '</div>'
      if (item.role === 'user') orphan += callSummary(item)
      if (recentUnsent) h += orphan
      else { unmatchedVoice += orphan; unmatchedCount++ }
    })
    if (deferredVoiceCount) el.older.innerHTML += '<p class="voice-history-pending">' + deferredVoiceCount + ' 条语音记录待定位，加载更早消息后自动归位</p>'
    if (unmatchedCount) h = '<details class="voice-unmatched" data-voice-unmatched' + (c.voiceUnmatchedOpen ? ' open' : '') + '><summary>未关联的语音记录 · ' + unmatchedCount + '</summary><p>全部消息已加载；这些原始录音仍未关联到对话回合，展开可回放。</p>' + unmatchedVoice + '</details>' + h
    if (!h && isAgent(c.id)) { var ag = agentOf(c.id); h = '<div class="hint"><b>' + esc(ag ? ag.project || ag.name : '外部会话') + '</b>这个会话的记录会出现在这里，也可以从手机继续它</div>' }
    if (!h) h = '<div class="hint"><b>' + esc(wsTitle(wsOf(c.id))) + '</b>发一条消息开始</div>'
    var playing = Array.prototype.filter.call(el.msgs.querySelectorAll('video[data-artifact]'), function (v) { return v._fullscreen || v._preparing || v._previewError || !v.paused || v.currentTime > 0 })
    var savedVoice = Array.prototype.slice.call(el.msgs.querySelectorAll('audio[data-voice-id]'))
    el.msgs.innerHTML = h
    el.msgs.querySelectorAll('audio[data-voice-id]').forEach(function (audio) {
      var previous = savedVoice.find(function (old) { return old.dataset.session === c.id && old.dataset.voiceId === audio.dataset.voiceId && old.dataset.voiceRevision === audio.dataset.voiceRevision })
      if (previous) { audio.parentNode.replaceChild(previous, audio); audio = previous }
      paintVoicePlayback(audio)
      audio.onplay = function () { el.msgs.querySelectorAll('audio[data-voice-id]').forEach(function (other) { if (other !== audio) other.pause() }); paintVoicePlayback(audio) }
      audio.onpause = function () { paintVoicePlayback(audio); if (c.voiceRepaint && S.cur === c.id) renderMsgs(c, false, true) }
      audio.onended = function () { paintVoicePlayback(audio); advanceVoiceQueue(audio); if (c.voiceRepaint && S.cur === c.id) renderMsgs(c, false, true) }
      audio.onerror = function () { stopVoiceQueue(); loadVoiceHistory(c.id); toast('语音暂不可播放，已刷新记录，请重新点播放') }
    })
    el.msgs.querySelectorAll('video[data-artifact]').forEach(function (v) {
      var index = playing.findIndex(function (old) { return old.getAttribute('data-message-seq') === v.getAttribute('data-message-seq') && old.getAttribute('data-session') === v.getAttribute('data-session') && old.getAttribute('data-artifact') === v.getAttribute('data-artifact') })
      if (index >= 0) { var previous = playing.splice(index, 1)[0]; v.parentNode.replaceChild(previous, v) }
    })
    wireVideos(el.msgs)
    drawTail(c)
    if (stick) toBottom()
    el.toBottom.hidden = nearBottom()
  }
  function lastToolSpinning(c) {
    for (var i = c.items.length - 1; i >= 0; i--) { var it = c.items[i]; if (it.k === 't') return Boolean(it._spin); if (it.k !== 'end') return false }
    return false
  }
  function drawTail(c) {
    var p = c.partial, h = ''
    if (p && p.tool) h = '<div class="typing"><span class="spin s"></span>正在' + esc(toolLabel(p.tool)) + '…</div>'
    else if (p && p.think) h = '<div class="typing"><span class="dots"><i></i><i></i><i></i></span>思考中</div>'
    else if (isRunning(c.id) && c.loaded) h = '<div class="typing"><span class="spin s"></span>运行中…</div>'
    el.tail.innerHTML = h
  }

  // ------------------------------------------------------------ dock
  function askHtml(c, a) {
    var t = null
    if (a.call) for (var i = c.items.length - 1; i >= 0; i--) if (c.items[i].k === 't' && c.items[i].id === a.call) { t = c.items[i]; break }
    var title = a.title || (t && t.title) || toolLabel(a.tool)
    var detail = a.detail || (t && t.detail) || ''
    return '<div class="card ask"><div class="ch"><i class="dotw"></i>需要你确认<span class="x">' + esc(toolLabel(a.tool)) + '</span></div>' +
      '<div class="ct">' + esc(title) + '</div>' + (a.why ? '<div class="cw">' + esc(a.why) + '</div>' : '') +
      (detail && detail !== title ? '<pre>' + esc(detail) + '</pre>' : '') +
      '<div class="btns"><button class="btn danger" data-deny="' + esc(a.id) + '">拒绝</button>' +
      (a.remember ? '<button class="btn" data-remember="' + esc(a.id) + '">允许并记住</button>' : '') +
      '<button class="btn pri" data-allow="' + esc(a.id) + '">' + ic('check', 's') + '允许</button></div>' +
      (a.remember ? '<div class="cw">"允许并记住"：这个会话里同类操作不再询问</div>' : '') + '</div>'
  }
  function qHtml(q) {
    var sel = q._sel || (q._sel = {}), custom = q._custom || (q._custom = {})
    var plan = null
    var body = (q.qs || []).map(function (it, ii) {
      if (it.intent && it.intent.kind === 'plan-review') plan = it.intent
      var chosen = sel[it.id] || []
      var opts = (it.options || []).map(function (o, oi) {
        return '<button class="opt' + (chosen.indexOf(o.label) >= 0 ? ' on' : '') + '" data-qo="' + ii + ':' + oi + '">' + esc(o.label) + (o.description ? '<small>' + esc(o.description) + '</small>' : '') + '</button>'
      }).join('')
      return '<div class="qq">' + (it.header ? '<div class="qh">' + esc(it.header) + '</div>' : '') + '<div class="qt">' + esc(it.question) + '</div>' +
        (it.detail ? '<div class="qd">' + esc(it.detail) + '</div>' : '') + (opts ? '<div class="opts">' + opts + '</div>' : '') +
        '<input class="qin" data-qi="' + ii + '" placeholder="' + (opts ? '或者自己写…' : '输入回答…') + '" value="' + esc(custom[it.id] || '') + '"></div>'
    }).join('')
    return '<div class="card" data-q="' + esc(q.rpc) + '"><div class="ch q"><i class="dotw"></i>DSH 在问你</div>' + body +
      '<div class="btns"><button class="btn" data-qcancel>取消</button><button class="btn pri" data-qsubmit>' + esc(plan ? plan.approve || '批准' : '提交') + '</button></div></div>'
  }
  function todoHtml(c) {
    var t = c.todos, done = 0, cur = null
    t.forEach(function (x) { if (x.status === 'completed') done++; else if (!cur || (x.status === 'in_progress' && cur.status !== 'in_progress')) cur = x })
    if (done === t.length && !isRunning(c.id)) return ''
    if (!c.todoOpen) {
      return '<button class="pill" data-todo>' + ic(done === t.length ? 'checkc' : 'dotc', 's') + '<b>进度 ' + done + '/' + t.length + '</b><span>' + esc(cur ? cur.content : '全部完成') +
        '</span><span class="bar-p"><i style="width:' + Math.round((done / t.length) * 100) + '%"></i></span></button>'
    }
    return '<div class="card todos" data-todo>' + t.map(function (x) {
      return '<div class="todo ' + esc(x.status) + '">' + ic(x.status === 'completed' ? 'checkc' : x.status === 'in_progress' ? 'dotc' : 'circle', 's') + '<span>' + esc(x.content) + '</span></div>'
    }).join('') + '</div>'
  }
  function asyncDraftKey(sid, id) { return sid + ':' + id }
  function asyncDraft(sid, id) { var key = asyncDraftKey(sid, id); return S.asyncDrafts[key] || (S.asyncDrafts[key] = { text: '' }) }
  function saveAsyncDrafts() { store.set('async-question-drafts', S.asyncDrafts) }
  function loadAsyncQuestions(sid) {
    var c = S.chats.get(sid)
    if (!c || isAgent(sid) || c.asyncLoading) return Promise.resolve()
    c.asyncLoading = true
    return get('/m/api/async-questions?s=' + enc(sid)).then(function (value) {
      c.asyncQuestions = value.items || []
      var needsAnswer = c.asyncQuestions.filter(function (q) { return q.status === 'waiting' || q.status === 'deferred' || (q.status === 'answered' && q.delivery !== 'accepted' && q.delivery !== 'not-needed') }).length
      if (S.byId[sid] && S.byId[sid].aq !== needsAnswer) { S.byId[sid].aq = needsAnswer; scheduleHome() }
      c.asyncQuestions.forEach(function (q) { if (q.status === 'answered' && (q.delivery === 'accepted' || q.delivery === 'not-needed')) delete S.asyncDrafts[asyncDraftKey(sid, q.id)] })
      saveAsyncDrafts(); if (S.cur === sid) drawDock()
    }).catch(function () {}).then(function () { c.asyncLoading = false })
  }
  function asyncQuestionHtml(c) {
    var waiting = ''
    ;(c.asyncQuestions || []).forEach(function (q) {
      var draft = asyncDraft(c.id, q.id), uncertain = q.delivery === 'unknown' || q.delivery === 'pending' || (q.status === 'answered' && q.delivery !== 'accepted' && q.delivery !== 'not-needed') || draft.delivery === 'unknown' || draft.delivery === 'sending'
      if (!uncertain && (q.status === 'answered' || draft.delivery === 'accepted')) return
      if (q.status !== 'waiting' && q.status !== 'deferred' && !uncertain) return
      var busy = c.asyncSubmitting === q.id, deadline = new Date(q.deadline).getTime(), remaining = Math.max(0, Math.ceil((deadline - Date.now()) / 1000)), elapsed = q.status === 'deferred' || remaining === 0
      var hint = elapsed ? '等待时间已到，可继续独立完成的工作不受影响；你仍可稍后回答。' : '可稍后回答' + (Number.isFinite(remaining) ? ' · 等待 ' + remaining + ' 秒后继续独立工作' : '')
      waiting += '<div class="card async-question" data-async-question="' + esc(q.id) + '"><div class="ch">需要你补充的信息</div><div class="ct">' + esc(q.question) + '</div>'
      if (q.independentWork) waiting += '<p class="async-independent">可继续：' + esc(q.independentWork) + '</p>'
      if (uncertain) {
        waiting += '<p class="async-answer">' + esc(draft.text || (q.answer && q.answer.text) || '') + '</p><p class="cw">' + (busy ? '正在提交回答…' : '回答发送状态待核对；不会自动重投。') + '</p><button class="link" data-async-refresh>刷新状态</button></div>'; return
      }
      waiting += '<p class="async-hint">' + esc(hint) + '</p><div class="opts">' + (q.options || []).map(function (option, index) { return '<button class="opt' + (draft.text === option ? ' on' : '') + '" data-async-option="' + index + '">' + esc(option) + '</button>' }).join('') + '</div><textarea class="qin" data-async-input maxlength="8000" placeholder="选择一项，或在这里回答">' + esc(draft.text) + '</textarea><div class="btns"><button class="btn pri" data-async-submit>提交回答</button></div></div>'
    })
    return waiting
  }
  function submitAsyncAnswer(c, q) {
    var draft = asyncDraft(c.id, q.id), answer = draft.text.trim()
    if (c.asyncSubmitting || draft.delivery === 'sending' || draft.delivery === 'unknown' || draft.delivery === 'accepted' || q.delivery === 'unknown' || q.delivery === 'pending') return
    if (!answer) { toast('请先选择或填写回答'); return }
    draft.answerId = draft.answerId || uuid(); draft.delivery = 'sending'; saveAsyncDrafts(); c.asyncSubmitting = q.id; drawDock()
    post('/m/api/async-questions', { s: c.id, id: q.id, answer: answer, answerId: draft.answerId }).then(function (value) {
      draft.delivery = value && value.status === 'answered' && (value.delivery === 'accepted' || value.delivery === 'not-needed') ? 'accepted' : 'unknown'; saveAsyncDrafts()
      toast(draft.delivery === 'unknown' ? '回答已保存，发送状态待核对' : value.delivery === 'accepted' ? '回答已进入原会话，等待后续处理' : '回答已提交')
    }).catch(function () { draft.delivery = 'unknown'; saveAsyncDrafts(); toast('发送状态待核对，请刷新确认，不会自动重投') }).then(function () { c.asyncSubmitting = null; if (S.cur === c.id) drawDock(); loadAsyncQuestions(c.id) })
  }
  var dockDirty = false
  // A queued message leaves the inbox as soon as DSH delivers it into the
  // session. When it lands while the phone's stream is down, the queue frame
  // that removed it is gone and the dock would keep a phantom "排队中" row
  // forever (seen 2026-10-04: the message had been answered, the row did not
  // clear). Match the host message id, not source.rpcId: those are different
  // UUIDs. rpcId remains the correlation key for local "sending" bubbles.
  function pruneQueue(c) {
    if (!c.queue || !c.queue.length) return
    var sent = {}
    c.items.forEach(function (it) { if (it.k === 'u' && it.messageId) sent[it.messageId] = true })
    var kept = c.queue.filter(function (x) { return !x.id || !sent[x.id] })
    if (kept.length !== c.queue.length) {
      c.queue = kept
      if (c.id === S.cur) drawDock()
    }
  }
  function drawDock() {
    syncSuggestion()
    var c = S.cur && S.chats.get(S.cur)
    if (!c) { el.dock.innerHTML = ''; return }
    // Hold re-renders only while the user is typing into a dock input; a
    // focused button must not block its own selection state from painting.
    var ae = document.activeElement
    if (ae && el.dock.contains(ae) && (ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA')) { dockDirty = true; return }
    dockDirty = false
    var h = ''
    S.asks.forEach(function (a) { if (a.s === c.id) h += askHtml(c, a) })
    S.qs.forEach(function (q) { if (q.s === c.id) h += qHtml(q) })
    h += asyncQuestionHtml(c)
    ;(c.queue || []).forEach(function (x) {
      var busy = c.queueBusy && c.queueBusy[x.id], disabled = busy ? ' disabled' : ''
      var stale = x.place === 'steering' && !isRunning(c.id)
      var running = isRunning(c.id)
      var statusText = busy ? '处理中…' : stale ? '本轮已结束，未送达' : x.place === 'steering' ? '已引导 · 等待接收插话' : x.waitAck ? '排队中 · 等待本轮完成' : running ? '排队中 · 可修改 / 引导 / 等待' : '排队中'
      h += '<div class="qitem"><span>' + esc(x.text || '图片') + '</span><em>' + statusText + '</em>'
      if (x.id && (x.place !== 'steering' || stale)) h += '<div class="qactions">'
        + '<button data-qedit="' + esc(x.id) + '" aria-label="编辑消息"' + disabled + '>' + ic('edit', 's') + '修改</button>'
        + (running && x.place !== 'steering' ? '<button data-steer="' + esc(x.id) + '" aria-label="插话发送"' + disabled + '>' + ic('steer', 's') + '引导</button>' : '')
        + (running && x.place !== 'steering' ? '<button data-qwait="' + esc(x.id) + '" class="' + (x.waitAck ? 'on' : '') + '" aria-label="等待本轮完成"' + disabled + '>' + ic('clock', 's') + (x.waitAck ? '已选等待' : '等待') + '</button>' : '')
        + '<button data-unqueue="' + esc(x.id) + '" aria-label="删除排队消息"' + disabled + '>' + ic('delete', 's') + '删除</button>'
        + '</div>'
      h += '</div>'
    })
    // The PC dock's "steer all": every still-pending row, in FIFO order.
    if (isRunning(c.id) && (c.queue || []).filter(function (x) { return x.id && x.place !== 'steering' }).length > 1) {
      h += '<div class="qitem qall"><span>把排队的都引导插话</span><button data-steerall="1" aria-label="全部插队">' + ic('steer', 's') + '</button></div>'
    }
    if (c.todos && c.todos.length) h += todoHtml(c)
    el.dock.innerHTML = h
  }

  // ------------------------------------------------------------ composer
  function autosize() {
    el.input.style.height = 'auto'
    el.input.style.height = Math.min(150, el.input.scrollHeight) + 'px'
  }
  function syncSend() {
    syncSuggestion()
    if (voice && voice.sid === S.cur && voice.mode === 'draft') {
      el.send.className = 'send'; el.send.innerHTML = ic('send'); el.send.disabled = true; el.send.setAttribute('aria-label', '请先结束录音，再发送文字'); return
    }
    if (S.cur && isAgent(S.cur)) {
      // No stop button: a turn running on the PC is stopped there.
      el.send.className = 'send'
      el.send.innerHTML = ic('send')
      el.send.disabled = !el.input.value.trim() || isRunning(S.cur)
      el.send.setAttribute('aria-label', '发送')
      return
    }
    var has = el.input.value.trim() || S.att.length
    if (S.cur && isRunning(S.cur) && !has) {
      el.send.className = 'send stop'
      el.send.innerHTML = ic('stop')
      el.send.disabled = false
      el.send.setAttribute('aria-label', '停止')
    } else {
      el.send.className = 'send'
      el.send.innerHTML = ic('send')
      el.send.disabled = !has
      el.send.setAttribute('aria-label', '发送')
    }
  }
  function drawThumbs() {
    el.thumbs.hidden = !S.att.length
    el.thumbs.innerHTML = S.att.map(function (a, i) { return '<div class="th"><img src="' + esc(a.url) + '" alt=""><button data-rm="' + i + '" aria-label="移除">' + ic('x') + '</button></div>' }).join('')
  }
  function prepImage(file) {
    return new Promise(function (res, rej) {
      var url = URL.createObjectURL(file), img = new Image()
      img.onload = function () {
        var k = Math.min(1, 2048 / Math.max(img.naturalWidth, img.naturalHeight))
        var w = Math.round(img.naturalWidth * k), h = Math.round(img.naturalHeight * k)
        var cv = document.createElement('canvas')
        cv.width = w; cv.height = h
        var g = cv.getContext('2d')
        g.fillStyle = '#fff'; g.fillRect(0, 0, w, h); g.drawImage(img, 0, 0, w, h)
        var data = cv.toDataURL('image/jpeg', 0.86)
        res({ url: url, b64: data.slice(data.indexOf(',') + 1), type: 'image/jpeg', name: String(file.name || 'photo').replace(/\.\w+$/, '') + '.jpg' })
      }
      img.onerror = function () { URL.revokeObjectURL(url); rej(new Error('无法读取图片')) }
      img.src = url
    })
  }
  function sendAgent(c) {
    var text = el.input.value.trim()
    if (!text || isRunning(c.id)) return
    el.send.disabled = true
    buzz(8)
    post('/m/api/agents/prompt', { s: c.id, text: text }).then(function () {
      el.input.value = ''
      delete S.drafts[c.id]
      store.set('drafts', S.drafts)
      autosize()
      toast('已发到电脑，后台开始运行')
      loadAgents()
      setTimeout(function () { if (S.cur === c.id) loadHistory(c) }, 3000)
    }, function (e) { syncSend(); toast('没发出去：' + e.message, 'err') })
  }
  function send(voiceSend) {
    if (voice && voice.sid === S.cur && voice.mode === 'draft') { toast('请先结束录音，保留最后一句后再发送'); return }
    var c = S.cur && S.chats.get(S.cur)
    if (!c) return
    if (isAgent(c.id)) { sendAgent(c); return }
    var directVoice = voiceSend && voiceSend.voice === true
    var text = directVoice ? voiceSend.text : el.input.value.trim(), att = directVoice ? [] : S.att
    if (!text && !att.length) return
    var rid = directVoice ? voiceSend.rid : uuid(), content = []
    att.forEach(function (a) { content.push({ type: 'image', mediaType: a.type, data: a.b64, name: a.name }) })
    if (text) content.push({ type: 'text', text: text })
    var busy = isRunning(c.id)
    var pend = { k: 'u', rid: rid, text: text, imgs: att.map(function (a) { return { url: a.url } }), pending: true }
    if (!busy) { c.pending.push(pend); renderMsgs(c, true) }
    if (!directVoice) {
    el.input.value = ''
    delete S.drafts[c.id]
    store.set('drafts', S.drafts)
    S.att = []
    drawThumbs(); autosize(); syncSend()
    }
    buzz(8)
    var send = function (mode) { return rpc('session.prompt', { sessionId: c.id, mode: mode, content: content, clientTimeZone: TZ }, rid) }
    // When busy, queue first (except live voice call) so the user gets the 3 choices in the dock: 修改 / 引导 / 等待.
    var useSteer = busy && directVoice && voiceSend.mode === 'call'
    ;(useSteer ? send('steer').catch(function (e) { if (/steer/i.test(e && e.message || '')) return send('queue'); throw e }) : send('queue')).then(function (v) {
      if (v && v.command) {
        c.pending = c.pending.filter(function (p) { return p !== pend })
        draw(c)
        toast(v.command.text || '命令已执行')
      } else if (!busy) {
        setRun(c.id, true)
        touch(c.id)
      } else if (!useSteer) {
        toast('已加入待发栏：可选择「修改」「引导」或「等待」')
      }
    }, function (e) {
      c.pending = c.pending.filter(function (p) { return p !== pend })
      draw(c)
      if (!directVoice && !el.input.value) { el.input.value = text; autosize(); syncSend() }
      if (directVoice) { if (!c.voiceUnknown) c.voiceUnknown = new Set(); c.voiceUnknown.add(rid); draw(c) }
      if (voice && voice.sid === c.id && voice.waiting) stopVoice('发送结果未确认，语音已停止；请核对对话后再发送')
      toast('没发出去：' + e.message, 'err')
    })
  }
  function queueItem(c, id) { return (c.queue || []).find(function (x) { return x.id === id }) }
  // The host owns the queue. A click is not delivery, and an unavailable
  // steering window must not hide a message that is still waiting there.
  function updateQueued(c, itemId, action) {
    var row = queueItem(c, itemId)
    if (!row) { toast('这条消息已被接收或删除'); return Promise.resolve(false) }
    var pending = c.queueBusy || (c.queueBusy = {})
    if (pending[itemId]) return Promise.resolve(false)
    pending[itemId] = true
    if (c.id === S.cur) drawDock()
    return rpc('session.updateQueue', { sessionId: c.id, itemId: itemId, action: action }).then(function (v) {
      if (!v || v.accepted !== true) throw new Error('电脑未确认操作，请刷新后核对')
      var current = queueItem(c, itemId)
      if (action.kind === 'remove') dismissQueued(c, itemId)
      else if (current && action.kind === 'steer') current.place = 'steering'
      else if (current && action.kind === 'edit' && current.editText === row.editText) {
        current.editText = action.content[0].text
        current.text = current.editText
      }
      toast(action.kind === 'steer' ? '已请求插话，等待当前步骤结束后接收' : action.kind === 'edit' ? '消息已修改' : '排队消息已删除')
      return true
    }).catch(function (err) {
      if (err.code === 'queue-item-not-found') {
        dismissQueued(c, itemId)
        toast('这条消息已被接收或删除，请查看对话')
      } else if (err.code === 'steer-unavailable') toast('当前步骤暂不能插话，消息仍在排队', 'err')
      else toast('操作未完成：' + err.message + '；请核对队列后再试', 'err')
      return false
    }).finally(function () {
      delete pending[itemId]
      if (c.id === S.cur) drawDock()
    })
  }
  function steer(c, itemId) {
    var row = queueItem(c, itemId)
    if (!row || row.place === 'steering' || !isRunning(c.id)) return Promise.resolve(false)
    buzz(8)
    return updateQueued(c, itemId, { kind: 'steer' })
  }
  function editQueued(c, itemId) {
    var row = queueItem(c, itemId)
    if (!row || (c.queueBusy && c.queueBusy[itemId])) return
    if (typeof row.editText !== 'string') {
      toast(row.editText === null ? '含附件的消息暂不能编辑，可删除后重新发送' : '电脑端手机插件需更新后才能安全编辑完整消息', 'err')
      return
    }
    openSheet('<div class="sh-h">编辑排队消息</div><div class="sh-in"><textarea id="qe" class="queue-editor" aria-label="消息内容"></textarea><div class="btns"><button class="btn" data-x>取消</button><button class="btn pri" data-qsave>保存修改</button></div></div>')
    var inp = document.getElementById('qe'), saving = false, originalText = row.editText
    var editor = overlays[overlays.length - 1]
    inp.value = originalText
    setTimeout(function () { inp.focus() }, 360)
    el.sheet.onclick = function (e) {
      if (e.target.closest('[data-x]')) { if (!saving) closeOverlay(); return }
      var button = e.target.closest('[data-qsave]')
      if (!button || saving) return
      if (!inp.value.trim()) { toast('消息不能为空', 'err'); return }
      var current = queueItem(c, itemId)
      if (!current || current.editText !== originalText) { toast('消息已在电脑端变化，请重新打开编辑', 'err'); return }
      saving = true; button.disabled = true
      updateQueued(c, itemId, { kind: 'edit', content: [{ type: 'text', text: inp.value }] }).then(function (ok) {
        saving = false; button.disabled = false
        if (ok && overlays[overlays.length - 1] === editor) closeOverlay()
      })
    }
  }
  // The queue/run frames that would retire this row may be the ones we missed.
  function dismissQueued(c, itemId) {
    var kept = (c.queue || []).filter(function (x) { return x.id !== itemId })
    if (kept.length !== (c.queue || []).length) {
      c.queue = kept
      if (c.id === S.cur) drawDock()
    }
  }
  function stop() {
    var id = S.cur
    buzz(12)
    rpc('session.cancel', { sessionId: id }).then(function () { toast('已停止') }, function (e) { toast(e.message, 'err') })
  }

  // ------------------------------------------------------------ sheets
  function newSheet() {
    var pre = S.filter !== 'all' && S.filter !== 'none' ? S.filter : null
    openSheet('<div class="sh-h">新对话<small>选择在哪个工作区里干活</small></div><div class="sh-b">' + sortedWorkspaces().map(function (w) {
      return '<button class="opt-row' + (w.id === pre ? ' on' : '') + '" data-w="' + esc(w.id) + '"><span class="ico">' + ic('folder', 's') + '</span><span class="mid"><b>' + esc(w.title) + '</b><small>' + esc(w.path) + '</small></span>' + ic('chev', 's') + '</button>'
    }).join('') + '<button class="opt-row" data-browse-folder><span class="ico">' + ic('folder', 's') + '</span><span class="mid"><b>浏览电脑文件夹</b><small>选择电脑上的文件夹作为工作区</small></span>' + ic('chev', 's') + '</button></div>')
    var owner = overlays[overlays.length - 1], browsing = false
    el.sheet.onclick = function (e) {
      var browse = e.target.closest('[data-browse-folder]')
      if (browse) {
        if (browsing) return
        if (!window.DSHFolderPicker) { toast('文件夹选择器尚未加载，请刷新页面'); return }
        browsing = true; browse.disabled = true
        window.DSHFolderPicker.choose().then(function (workspace) {
          if (!workspace) return
          var item = { id: workspace.workspaceId || workspace.id, title: workspace.title || workspace.name || workspace.path, path: workspace.path }
          if (!S.wsById[item.id]) S.ws.push(item)
          S.wsById[item.id] = item
          if (overlays.indexOf(owner) < 0) { toast('工作区已添加，可在新对话中选择'); return }
          closeOverlay().then(function () { startChat(item.id) })
        }).catch(function (error) { toast(error.message, 'err') }).then(function () { browsing = false; browse.disabled = false })
        return
      }
      var b = e.target.closest('[data-w]')
      if (!b || b.disabled) return
      b.disabled = true
      closeOverlay().then(function () { startChat(b.dataset.w) })
    }
  }
  function startChat(wid) {
    var reuse = S.blanks[wid]
    var p = reuse ? Promise.resolve({ sessionId: reuse }) : rpc('session.create', { workspaceId: wid })
    if (reuse) delete S.blanks[wid]
    p.then(function (v) {
      var c = chatState(v.sessionId)
      c.loaded = true
      c.w = wid
      S.chats.set(c.id, c)
      openChat(c.id)
      if (S.share) { fillShare(c.id, S.share); S.share = null }
      else setTimeout(function () { el.input.focus() }, 380)
    }, function (e) { toast('创建失败：' + e.message, 'err') })
  }
  function modelSheet() {
    var c = S.chats.get(S.cur)
    if (!c) return
    openSheet('<div class="sh-h">模型</div><div class="sh-b" id="mb"><div class="spin"></div></div>')
    var box = document.getElementById('mb')
    function paint() {
      var cur = c.model || {}, h = ''
      c.models.groups.forEach(function (g) {
        h += '<div class="sh-sec">' + esc(g.name) + '</div>'
        g.models.forEach(function (m) {
          var on = cur.provider === g.id && cur.model === m.id
          h += '<button class="opt-row' + (on ? ' on' : '') + '" data-p="' + esc(g.id) + '" data-m="' + esc(m.id) + '"><span class="ico">' + ic('cpu', 's') + '</span><span class="mid"><b>' + esc(m.name) + '</b>' +
            (m.description ? '<small>' + esc(m.description) + '</small>' : '') + '</span>' + (on ? ic('check', 'chk') : '') + '</button>'
          if (on && m.reasoning && m.reasoning.efforts.length) {
            var eff = cur.reasoningEffort || m.reasoning.defaultEffort
            h += '<div class="efforts">' + m.reasoning.efforts.map(function (e) { return '<button class="chip' + (eff === e.id ? ' on' : '') + '" data-e="' + esc(e.id) + '">' + esc(EFF[e.id] || e.name) + '</button>' }).join('') + '</div>'
          }
        })
      })
      ;(c.models.failures || []).forEach(function (f) { h += '<div class="sh-sec">' + esc(f.name) + ' · 暂不可用</div>' })
      box.innerHTML = h
    }
    rpc('session.models', { sessionId: c.id }).then(function (v) { c.models = v; c.model = v.current; renderHead(); paint() }, function (e) { box.innerHTML = '<div class="empty">' + esc(e.message) + '</div>' })
    el.sheet.onclick = function (e) {
      var b = e.target.closest('[data-m],[data-e]')
      if (!b || !c.models) return
      var cur = c.model || {}, sel
      if (b.dataset.e) sel = { provider: cur.provider, model: cur.model, reasoningEffort: b.dataset.e }
      else {
        var g = c.models.groups.filter(function (x) { return x.id === b.dataset.p })[0]
        var m = g && g.models.filter(function (x) { return x.id === b.dataset.m })[0]
        if (!m) return
        sel = { provider: g.id, model: m.id }
        if (m.reasoning) {
          var keep = m.reasoning.efforts.some(function (x) { return x.id === cur.reasoningEffort }) ? cur.reasoningEffort : m.reasoning.defaultEffort
          if (keep) sel.reasoningEffort = keep
        }
      }
      rpc('session.selectModel', Object.assign({ sessionId: c.id }, sel)).then(function (r) { c.model = r.selected; buzz(); paint(); renderHead() }, function (err) { toast(err.message, 'err') })
    }
  }
  function agentMoreSheet(c) {
    var ag = agentOf(c.id)
    openSheet('<div class="sh-h">' + esc(el.cTitle.textContent) + '<small>' + esc(ag ? ag.cwd || '' : '') + '</small></div><div class="sh-b">' +
      '<button class="opt-row" data-a="files"><span class="ico">' + ic('folder', 's') + '</span><span class="mid"><b>项目文件</b><small>' + esc(ag ? ag.project : '') + '</small></span>' + ic('chev', 's') + '</button>' +
      '<button class="opt-row" data-a="mode"><span class="ico">' + ic('alert', 's') + '</span><span class="mid"><b>确认请求发到哪里</b><small>' + esc(MODE_NAME[S.agents.mode] || '') + '</small></span>' + ic('chev', 's') + '</button></div>')
    el.sheet.onclick = function (e) {
      var b = e.target.closest('[data-a]')
      if (!b) return
      closeOverlay().then(function () {
        if (b.dataset.a === 'files') fvOpen({ kind: 'path', s: c.id, path: '', title: (ag && ag.project) || '项目' })
        else modeSheet()
      })
    }
  }
  function moreSheet() {
    var c = S.chats.get(S.cur)
    if (!c) return
    if (isAgent(c.id)) { agentMoreSheet(c); return }
    openSheet('<div class="sh-h">' + esc(el.cTitle.textContent) + '</div><div class="sh-b">' +
      '<button class="opt-row" data-a="model"><span class="ico">' + ic('cpu', 's') + '</span><span class="mid"><b>切换模型</b><small>' + esc(modelName(c) || '当前模型') + '</small></span>' + ic('chev', 's') + '</button>' +
      '<button class="opt-row" data-a="files"><span class="ico">' + ic('folder', 's') + '</span><span class="mid"><b>工作区文件</b><small>' + esc(wsTitle(wsOf(c.id))) + '</small></span>' + ic('chev', 's') + '</button>' +
      '<button class="opt-row" data-a="tasks"><span class="ico">' + ic('stats', 's') + '</span><span class="mid"><b>自动任务</b><small>定时执行、目标计划与进度</small></span>' + ic('chev', 's') + '</button>' +
      '<button class="opt-row" data-a="usage"><span class="ico">' + ic('stats', 's') + '</span><span class="mid"><b>用量</b><small>token、缓存命中、上下文占用、耗时</small></span>' + ic('chev', 's') + '</button>' +
      '<button class="opt-row" data-a="settings"><span class="ico">' + ic('settings', 's') + '</span><span class="mid"><b>设置</b><small>声音、通知、连接与界面更新</small></span>' + ic('chev', 's') + '</button>' +
      '<button class="opt-row" data-a="rename"><span class="ico">' + ic('pen', 's') + '</span><span class="mid"><b>重命名</b></span></button>' +
      '<button class="opt-row danger" data-a="archive"><span class="ico">' + ic('archive', 's') + '</span><span class="mid"><b>归档对话</b><small>从列表隐藏，记录仍保存在电脑上</small></span></button></div>')
    el.sheet.onclick = function (e) {
      var b = e.target.closest('[data-a]')
      if (!b) return
      var a = b.dataset.a
      if (a === 'tasks') {
        if (voice || voiceStarting || holdGesture) { toast('请先结束当前语音，再打开自动任务'); return }
        if (S.att.length) { toast('请先发送或移除已添加的图片，避免丢失附件'); return }
        saveDraft(); location.href = '/m/tasks.html?s=' + enc(c.id); return
      }
      if (a === 'settings') { settingsSheet(); return }
      if (a === 'archive' && !b.dataset.sure) { b.dataset.sure = '1'; b.querySelector('b').textContent = '再点一次确认归档'; buzz(); return }
      closeOverlay().then(function () {
        if (a === 'model') modelSheet()
        else if (a === 'files') fvOpen({ kind: 'path', s: c.id, path: '', title: wsTitle(wsOf(c.id)) || '工作区' })
        else if (a === 'rename') renameSheet()
        else if (a === 'usage') usageSheet(c)
        else if (a === 'archive') archive(c.id)
      })
    }
  }
  function renameSheet() {
    var c = S.chats.get(S.cur)
    if (!c) return
    openSheet('<div class="sh-h">重命名</div><div class="sh-in"><input id="rn" maxlength="80" enterkeyhint="done" value="' + esc(el.cTitle.textContent) + '"><div class="btns"><button class="btn" data-x>取消</button><button class="btn pri" data-ok>保存</button></div></div>')
    var inp = document.getElementById('rn')
    setTimeout(function () { inp.focus(); inp.select() }, 360)
    function save() {
      var t = inp.value.trim()
      if (!t) return
      rpc('session.rename', { sessionId: c.id, title: t }).then(function (r) { setTitle(c.id, r.title); closeOverlay() }, function (e) { toast(e.message, 'err') })
    }
    inp.onkeydown = function (e) { if (e.key === 'Enter') save() }
    el.sheet.onclick = function (e) {
      if (e.target.closest('[data-x]')) closeOverlay()
      else if (e.target.closest('[data-ok]')) save()
    }
  }
  // ------------------------------------------------------------ quick commands
  // Short prompts kept on the PC (commands.json) and shared by every phone. A tap
  // only fills the composer: the user still reads it and presses send.
  var cmdCache = null
  function loadCmds() {
    if (cmdCache && Date.now() - cmdCache.at < 60000) return Promise.resolve(cmdCache.v)
    return get('/m/api/commands').then(function (v) { cmdCache = { at: Date.now(), v: v }; return v })
  }
  function quickSheet() {
    var v = null, edit = false
    openSheet('<div class="sh-h">快捷指令<small>存在电脑上，所有手机共用；点一条填进输入框</small></div><div class="sh-b" id="qc"><div class="spin"></div></div>')
    var box = document.getElementById('qc')
    function row(c) {
      var inner = '<span class="ico">' + ic('zap', 's') + '</span><span class="mid"><b>' + esc(c.label) + '</b><small>' + esc(c.text) + '</small></span>'
      return edit
        ? '<div class="opt-row">' + inner + '<button class="ib del" data-del="' + esc(c.id) + '" aria-label="删除 ' + esc(c.label) + '">' + ic('delete', 's') + '</button></div>'
        : '<button class="opt-row" data-cmd="' + esc(c.id) + '">' + inner + '</button>'
    }
    function paint() {
      var h = v.note ? '<div class="qc-note">' + esc(v.note) + '</div>' : ''
      if (!v.items.length) h += '<div class="qc-note">还没有快捷指令，点下面添加。</div>'
      h += v.items.map(row).join('')
      h += edit
        ? '<div class="sh-sec">添加一条</div><div class="sh-in"><input id="qcL" maxlength="16" placeholder="名称，例如：跑测试" enterkeyhint="next">' +
          '<textarea id="qcT" maxlength="2000" rows="3" placeholder="要发给它的话"></textarea>' +
          '<div class="btns"><button class="btn" data-done>完成</button><button class="btn pri" data-add>添加</button></div></div>'
        : '<div class="sh-in"><div class="btns"><button class="btn" data-edit>管理指令</button></div></div>'
      box.innerHTML = h
    }
    function save(items) {
      return post('/m/api/commands', { items: items }).then(function (r) { v = r; cmdCache = { at: Date.now(), v: r }; paint(); buzz() }, function (e) { toast(e.message, 'err') })
    }
    loadCmds().then(function (r) { v = r; paint() }, function (e) { box.innerHTML = '<div class="qc-note">' + esc(e.message) + '</div>' })
    el.sheet.onclick = function (e) {
      if (!v) return
      var b
      if ((b = e.target.closest('[data-cmd]'))) {
        var c = v.items.filter(function (x) { return x.id === b.dataset.cmd })[0]
        if (!c) return
        var cur = el.input.value.replace(/\s+$/, '')
        el.input.value = cur ? cur + '\n' + c.text : c.text
        autosize(); syncSend(); saveDraft()
        closeOverlay()
        setTimeout(function () { el.input.focus() }, 360)
      } else if (e.target.closest('[data-edit]')) { edit = true; paint() }
      else if (e.target.closest('[data-done]')) { edit = false; paint() }
      else if ((b = e.target.closest('[data-del]'))) { save(v.items.filter(function (x) { return x.id !== b.dataset.del })) }
      else if (e.target.closest('[data-add]')) {
        var label = document.getElementById('qcL').value.trim(), text = document.getElementById('qcT').value.trim()
        if (!label || !text) { toast('名称和内容都要填'); return }
        save(v.items.concat([{ label: label, text: text }]))
      }
    }
  }
  // ------------------------------------------------------------ usage
  // DSH keeps per-session totals (tokens, time, context pressure); the plugin reads them from
  // session.list. They are cumulative per session, so "last 7 days" means sessions active then.
  function fmtTok(n) {
    n = n || 0
    if (n < 1000) return String(n)
    if (n < 1e6) return (n / 1e3).toFixed(n < 1e4 ? 1 : 0).replace(/\.0$/, '') + 'K'
    return (n / 1e6).toFixed(2).replace(/\.?0+$/, '') + 'M'
  }
  function hitRate(u) { var t = (u.cacheRead || 0) + (u.in || 0); return t ? Math.round((u.cacheRead || 0) / t * 100) : null }
  function usageBrief(u) {
    var p = ['输出 ' + fmtTok(u.out)], h = hitRate(u)
    if (h !== null) p.push('缓存命中 ' + h + '%')
    if (u.ctxPct !== undefined) p.push('上下文 ' + u.ctxPct + '%')
    return p.join(' · ')
  }
  function kv(pairs) {
    return '<div class="kv">' + pairs.map(function (p) { return '<div><span>' + esc(p[0]) + '</span><b>' + esc(p[1]) + '</b></div>' }).join('') + '</div>'
  }
  function tokenPairs(u) {
    var h = hitRate(u), r = [['输入（未命中缓存）', fmtTok(u.in)], ['缓存命中', fmtTok(u.cacheRead) + (h !== null ? '（' + h + '%）' : '')], ['输出', fmtTok(u.out)]]
    if (u.cacheWrite) r.push(['缓存写入', fmtTok(u.cacheWrite)])
    return r
  }
  function usageSheet(c) {
    openSheet('<div class="sh-h">用量<small>这个会话累计，数据来自 DSH</small></div><div class="sh-b" id="us"><div class="spin"></div></div>')
    var box = document.getElementById('us')
    get('/m/api/usage?s=' + enc(c.id)).then(function (v) {
      var u = v.sessions[0] && v.sessions[0].u
      if (!u) { box.innerHTML = '<div class="qc-note">这个会话还没有用量数据。</div>'; return }
      var r = u.out !== undefined ? tokenPairs(u) : []
      if (u.ctxPct !== undefined) r.push(['上下文', u.ctxPct + '%（' + fmtTok(u.ctx) + ' / ' + fmtTok(u.window) + '）'])
      if (u.turns !== undefined) r.push(['回合 / 步数', u.turns + ' / ' + u.steps])
      if (u.llmMs) r.push(['模型耗时', dur(u.llmMs)])
      if (u.toolMs) r.push(['工具耗时（含等你确认）', dur(u.toolMs)])
      if (u.ttftMs) r.push(['平均首字', (u.ttftMs / 1000).toFixed(1) + ' 秒'])
      if (u.tps) r.push(['输出速度', u.tps + ' token/秒'])
      box.innerHTML = kv(r) + (u.ctxPct >= 70 ? '<div class="qc-note">上下文快满了：再聊下去模型会开始压缩或遗忘前面的内容，可以考虑开个新对话。</div>' : '')
    }, function (e) { box.innerHTML = '<div class="qc-note">' + esc(e.message) + '</div>' })
  }
  function weekSheet() {
    openSheet('<div class="sh-h">最近 7 天用量<small>这 7 天里有活动的会话，按会话累计；数据来自 DSH</small></div><div class="sh-b" id="us"><div class="spin"></div></div>')
    var box = document.getElementById('us')
    get('/m/api/usage?days=7').then(function (v) {
      var t = v.totals
      var h = kv([['会话 / 回合', t.sessions + ' / ' + t.turns]].concat(tokenPairs(t), [['模型耗时', dur(t.llmMs)]]))
      if (v.sessions.length) {
        h += '<div class="sh-sec">用得最多的会话</div>' + v.sessions.slice(0, 10).map(function (s) {
          return '<button class="opt-row" data-open="' + esc(s.id) + '"><span class="mid"><b>' + esc(s.title || '未命名对话') + '</b><small>' + esc(usageBrief(s.u)) + '</small></span>' + ic('chev', 's') + '</button>'
        }).join('')
      }
      box.innerHTML = h
    }, function (e) { box.innerHTML = '<div class="qc-note">' + esc(e.message) + '</div>' })
    el.sheet.onclick = function (e) {
      var b = e.target.closest('[data-open]')
      if (b) closeAllOverlays().then(function () { openChat(b.dataset.open) })
    }
  }
  function archive(id) {
    rpc('workspace.archiveSession', { sessionId: id }).then(function () {
      S.sessions = S.sessions.filter(function (s) { return s.id !== id })
      delete S.byId[id]
      toast('已归档')
      if (S.cur === id) history.back()
    }, function (e) { toast(e.message, 'err') })
  }

  // ------------------------------------------------------------ events (SSE)
  var es = null, lastBeat = 0, retry = 0, retryT = 0
  function connect() {
    clearTimeout(retryT)
    if (es) { es.close(); es = null }
    setStatus('connecting')
    var src = new EventSource('/m/api/events')
    es = src
    lastBeat = Date.now()
    src.onmessage = function (m) {
      if (es !== src) return
      lastBeat = Date.now()
      var f
      try { f = JSON.parse(m.data) } catch (e) { return }
      if (f.t === 'hello') retry = 0
      try { onFrame(f) } catch (e) { console.error(e) }
    }
    src.onerror = function () {
      if (es !== src) return
      if (src.readyState === 2) { es = null; setStatus('offline'); reconnectLater() } else setStatus('connecting')
    }
  }
  function reconnectLater() {
    retry = Math.min(retry + 1, 5)
    fetch('/m/api/ping', { redirect: 'manual', cache: 'no-store' }).then(function (r) {
      if (r.type === 'opaqueredirect' || r.status === 401) toLogin()
    }, function () {})
    retryT = setTimeout(connect, 1000 * Math.min(15, Math.pow(2, retry)))
  }
  setInterval(function () {
    if (document.visibilityState === 'visible' && es && Date.now() - lastBeat > 40000) connect()
    if (document.visibilityState === 'visible' && S.cur && S.status === 'online') loadVoiceHistory(S.cur)
  }, 10000)
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState !== 'visible') { saveDraft(); return }
    checkUpdates()
    if (!es || Date.now() - lastBeat > 25000) connect()
    else scheduleHome()
  })

  // ------------------------------------------------------------ wiring
  document.querySelectorAll('[data-ic]').forEach(function (n) { n.innerHTML = ic(n.dataset.ic) })
  el.status.lastChild.textContent = '连接中'

  el.rows.addEventListener('click', function (e) {
    if (e.target.closest('[data-mode]')) { modeSheet(); return }
    if (e.target.closest('[data-ui-update]')) { reloadUi(); return }
    if (e.target.closest('[data-update]')) { buzz(); location.href = 'dshapp://update'; return }
    var b = e.target.closest('[data-open]')
    if (b) openChat(b.dataset.open)
  })
  el.chips.addEventListener('click', function (e) {
    var b = e.target.closest('[data-f]')
    if (!b) return
    S.filter = b.dataset.f
    store.set('filter', S.filter)
    renderHome()
    el.list.scrollTop = 0
  })
  // Connection sheet: where this client points, reconnect, and (inside the
  // Android shell) switch to another server.
  var IN_APP = /DSHApp\//.test(navigator.userAgent)
  function reloadUi() {
    if (S.att.length) { toast('请先发送或移除已添加的图片，再更新界面', 'err'); return }
    var busy = false
    S.chats.forEach(function (c) { if (c.queueBusy && Object.keys(c.queueBusy).length) busy = true })
    if (busy) { toast('消息操作正在处理中，请稍后更新界面', 'err'); return }
    saveDraft()
    history.replaceState(history.state, '', location.pathname + (S.cur ? '#' + enc(S.cur) : ''))
    location.reload()
  }

  // Web Push for the installed web app (iPhone: "Add to Home Screen", iOS
  // 16.4+). The Android app has native notifications and skips all of this.
  var STANDALONE = navigator.standalone === true || Boolean(window.matchMedia && matchMedia('(display-mode: standalone)').matches)
  var IOS = /iP(hone|ad|od)/.test(navigator.userAgent) || (/Macintosh/.test(navigator.userAgent) && navigator.maxTouchPoints > 1)
  if (!IN_APP && 'serviceWorker' in navigator) {
    navigator.serviceWorker.register('/m/sw.js', { scope: '/m/' }).catch(function () {})
    navigator.serviceWorker.addEventListener('message', function (e) { if (e.data && e.data.t === 'open') window.dshOpen(e.data.s) })
  }
  function swReady() {
    return Promise.race([navigator.serviceWorker.ready, new Promise(function (_, rej) { setTimeout(function () { rej(new Error('后台服务没有启动')) }, 5000) })])
  }
  function pushState() {
    if (IN_APP) return Promise.resolve({ state: 'app' })
    if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) return Promise.resolve({ state: IOS && !STANDALONE ? 'install' : 'unsupported' })
    if (Notification.permission === 'denied') return Promise.resolve({ state: 'denied' })
    return swReady().then(function (r) { return r.pushManager.getSubscription() }).then(function (sub) { return { state: sub ? 'on' : 'off', sub: sub } }, function () { return { state: 'unsupported' } })
  }
  function b64uBytes(s) {
    var b = atob(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4)), a = new Uint8Array(b.length)
    for (var i = 0; i < b.length; i++) a[i] = b.charCodeAt(i)
    return a
  }
  function deviceLabel() { var u = navigator.userAgent; return /iPhone/.test(u) ? 'iPhone' : /iPad/.test(u) || IOS ? 'iPad' : /Android/.test(u) ? 'Android 浏览器' : '电脑浏览器' }
  function enablePush() {
    // requestPermission comes first, still inside the tap: iOS only asks from a user gesture.
    return Notification.requestPermission().then(function (perm) {
      if (perm !== 'granted') throw new Error(perm === 'denied' ? '通知权限被拒绝了，请在系统设置里允许' : '没有允许通知')
      return Promise.all([swReady(), get('/m/api/push/key')])
    }).then(function (x) {
      return x[0].pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64uBytes(x[1].publicKey) })
    }).then(function (sub) {
      return post('/m/api/push/subscribe', { subscription: sub.toJSON(), label: deviceLabel() })
    })
  }
  function pushRows(st) {
    function row(a, icon, title, sub, chev) {
      return '<button class="opt-row"' + (a ? ' data-a="' + a + '"' : ' disabled') + '><span class="ico">' + ic(icon, 's') + '</span><span class="mid"><b>' + title + '</b><small>' + sub + '</small></span>' + (chev ? ic('chev', 's') : '') + '</button>'
    }
    switch (st.state) {
      case 'install': return row('', 'alert', '锁屏提醒', '在 Safari 点“分享”→“添加到主屏幕”，从主屏幕打开后在这里开启')
      case 'unsupported': return row('', 'alert', '锁屏提醒', '这个浏览器不支持网页推送')
      case 'denied': return row('', 'alert', '锁屏提醒', '通知权限被拒绝了，请在系统设置里允许 DSH 通知')
      case 'off': return row('push-on', 'alert', '开启锁屏提醒', '完成、出错、需要你确认时通知你', true)
      case 'on': return row('push-test', 'checkc', '锁屏提醒已开启', '点这里发一条测试推送') + row('push-off', 'x', '关闭锁屏提醒', '这台设备不再收到推送')
      default: return ''
    }
  }
  function settingsSheet() {
    openSheet('<div class="sh-h">设置<small>' + esc(location.host) + '</small></div><div class="sh-b">' +
      '<button class="opt-row" data-a="speakers"><span class="ico">' + ic('mic', 's') + '</span><span class="mid"><b>声音设置</b><small>选择声音、试听语音回复</small></span>' + ic('chev', 's') + '</button>' +
      (S.cur && S.chats.has(S.cur) ? '<button class="opt-row" data-a="model"><span class="ico">' + ic('cpu', 's') + '</span><span class="mid"><b>当前对话模型</b><small>模型和推理等级</small></span>' + ic('chev', 's') + '</button>' : '<div class="opt-row"><span class="ico">' + ic('cpu', 's') + '</span><span class="mid"><b>对话模型</b><small>进入对话后，点击顶部模型名称进行设置</small></span></div>') +
      '<button class="opt-row" data-a="reload"><span class="ico">' + ic('refresh', 's') + '</span><span class="mid"><b>更新界面并重连</b><small>' +
      ({ online: '当前已连接', connecting: '正在连接…', offline: '电脑暂时连不上' })[S.status] + '</small></span></button>' +
      (IN_APP ? '<button class="opt-row" data-a="server"><span class="ico">' + ic('web', 's') + '</span><span class="mid"><b>切换服务器</b><small>换一台电脑，或换一个访问地址</small></span>' + ic('chev', 's') + '</button>' : '') +
      '<button class="opt-row" data-a="usage"><span class="ico">' + ic('stats', 's') + '</span><span class="mid"><b>最近 7 天用量</b><small>token、缓存命中，用得最多的会话</small></span>' + ic('chev', 's') + '</button>' +
      (IN_APP ? '<div class="opt-row"><span class="ico">' + ic('alert', 's') + '</span><span class="mid"><b>通知权限</b><small>在设备系统设置 → 应用 → DSH → 通知中管理</small></span></div>' : '') +
      '<div class="opt-row"><span class="ico">' + ic('cpu', 's') + '</span><span class="mid"><b>DSH 版本</b><small>' + esc(S.dshVersion || '未知（请点“更新界面并重连”）') + '</small></span></div>' +
      '<div id="pushRows"></div></div>')
    var cur = { state: 'app' }
    function paintPush() {
      pushState().then(function (st) {
        cur = st
        var box = document.getElementById('pushRows')
        if (box) box.innerHTML = pushRows(st)
      })
    }
    paintPush()
    el.sheet.onclick = function (e) {
      var b = e.target.closest('[data-a]')
      if (!b || b.disabled) return
      var a = b.dataset.a
      if (a === 'speakers') { speakerSettings(); return }
      if (a === 'model') { modelSheet(); return }
      if (a === 'server') { location.href = 'dshapp://setup'; return }
      if (a === 'usage') { closeOverlay().then(weekSheet); return }
      if (a === 'push-on') {
        b.disabled = true
        enablePush().then(function () { toast('已开启锁屏提醒'); buzz(); paintPush() }, function (err) { b.disabled = false; toast(err.message, 'err') })
        return
      }
      if (a === 'push-test' && cur.sub) {
        post('/m/api/push/test', { endpoint: cur.sub.endpoint }).then(function (v) {
          toast(v.status >= 200 && v.status < 300 ? '已发出，几秒内锁屏应该收到' : '推送服务返回 ' + v.status, v.status >= 300 ? 'err' : '')
        }, function (err) { toast(err.message, 'err') })
        return
      }
      if (a === 'push-off' && cur.sub) {
        var sub = cur.sub
        post('/m/api/push/unsubscribe', { endpoint: sub.endpoint }).catch(function () {}).then(function () { return sub.unsubscribe() }).then(function () { toast('已关闭锁屏提醒'); paintPush() }, function (err) { toast(err.message, 'err') })
        return
      }
      reloadUi()
    }
  }
  el.status.onclick = settingsSheet
  document.getElementById('btnSettings').onclick = settingsSheet
  document.getElementById('btnSearch').onclick = function () { el.searchBox.hidden = false; el.q.focus() }
  document.getElementById('qClose').onclick = function () { el.q.value = ''; S.query = ''; el.searchBox.hidden = true; renderHome() }
  el.q.oninput = function () { S.query = el.q.value.trim(); renderHome() }
  el.fab.onclick = newSheet
  document.getElementById('back').onclick = function () { history.back() }
  el.head.onclick = modelSheet
  el.permission.onclick = permissionSheet
  el.holdTalk.onpointerdown = beginHold
  el.holdTalk.onpointermove = function (event) { if (!holdGesture || event.pointerId !== holdGesture.pointerId) return; holdGesture.cancelled = holdGesture.startY - event.clientY > 60; syncHoldUi() }
  el.holdTalk.onpointerup = function (event) { if (holdGesture && event.pointerId === holdGesture.pointerId) releaseHold(false) }
  el.holdTalk.onpointercancel = el.holdTalk.onlostpointercapture = function (event) { if (holdGesture && event.pointerId === holdGesture.pointerId) releaseHold(true) }
  el.holdTalk.oncontextmenu = function (event) { event.preventDefault() }
  el.holdTalk.onkeydown = function (event) { if ((event.key === ' ' || event.key === 'Enter') && !event.repeat) beginHold({ pointerId: 'keyboard', preventDefault: function () { event.preventDefault() } }) }
  el.holdTalk.onkeyup = function (event) { if (event.key === ' ' || event.key === 'Enter') { event.preventDefault(); releaseHold(false) } }
  el.voiceKeyboard.onclick = leaveHoldMode
  el.mic.onclick = voiceMenu
  el.voiceFinish.onclick = finishVoice
  el.voiceEnd.onclick = function () { stopVoice('已退出语音') }
  el.callInterrupt.onclick = function () { if (voice && voice.failedSave) finishVoice(); else if (voice) continueVoice(voice) }
  el.callHangup.onclick = function () { stopVoice('通话已结束') }
  el.callMute.onclick = function () { var v = voice; if (!v || v.mode !== 'call') return; v.muted = !v.muted; v.submitGeneration = (v.submitGeneration || 0) + 1; v.detectGeneration = (v.detectGeneration || 0) + 1; if (v.stream) v.stream.getTracks().forEach(function (t) { t.enabled = !v.muted }); v.barge = []; v.bargeCount = 0; v.detectPositive = 0; el.callMute.textContent = v.muted ? '取消静音' : '静音'; el.callMute.setAttribute('aria-pressed', String(v.muted)); voiceHint(v, v.muted ? '麦克风已静音' : '通话中 · 正在听') }
  el.voiceRetryReplies.onclick = function () { Promise.all(Array.from(pendingVoiceReplies.values()).filter(function (entry) { return entry.failed }).map(persistVoiceReply)).then(function () { toast('回复语音已保存') }, function () { toast('仍未保存，请保持页面并稍后重试') }) }
  document.addEventListener('visibilitychange', function () { if (document.visibilityState === 'hidden') { stopVoice(); stopVoicePreview() } })
  window.addEventListener('pagehide', function () { stopVoice(); stopVoicePreview() })
  document.getElementById('more').onclick = moreSheet
  el.sheetWrap.firstElementChild.onclick = function () { closeOverlay() }
  el.viewer.onclick = function () { closeOverlay() }
  document.getElementById('fvBack').onclick = function () { history.back() }
  el.fvBody.addEventListener('click', function (e) {
    var en = fv[fv.length - 1], b
    if (!en) return
    if ((b = e.target.closest('[data-voice-play]'))) { if ((voiceClickSuppressed.get(b.dataset.voiceMenu) || 0) > Date.now()) { if (e.preventDefault) e.preventDefault(); return } playVoiceBubble(b); return }
    if ((b = e.target.closest('[data-video-download]'))) { downloadVideo(b); return }
    if ((b = e.target.closest('[data-video-fullscreen]'))) { fullscreenVideo(b); return }
    if ((b = e.target.closest('[data-video-retry]'))) { preparePreview(b.closest('[data-video-box]').querySelector('video')); return }
    if ((b = e.target.closest('[data-video-quality]'))) { switchVideo(b); return }
    if ((b = e.target.closest('a[href]'))) { e.preventDefault(); window.open(b.href, '_blank', 'noopener'); return }
    if ((b = e.target.closest('[data-fe]'))) {
      fvOpen({ kind: 'path', s: en.s, path: (en.data.rel ? en.data.rel + '/' : '') + b.dataset.fe, title: b.dataset.fe })
      return
    }
    if ((b = e.target.closest('[data-fp]'))) { if (b.dataset.fp) fvOpen({ kind: 'path', s: en.s, path: b.dataset.fp, title: baseName(b.dataset.fp) }); return }
    if ((b = e.target.closest('[data-fdir]'))) { fvOpen({ kind: 'path', s: en.s, path: b.dataset.fdir, title: baseName(b.dataset.fdir) || '工作区' }); return }
    if ((b = e.target.closest('[data-mdv]'))) { en.src = b.dataset.mdv === '1'; fvPaint(en); return }
    if ((b = e.target.closest('[data-copy]'))) { copy(b.closest('pre').querySelector('code').textContent); return }
    if ((b = e.target.closest('.fvimg'))) view(b.src)
  })

  // pull to refresh (home list)
  ;(function () {
    var y0 = null, dy = 0, busy = false
    el.list.addEventListener('touchstart', function (e) { y0 = el.list.scrollTop <= 0 && !busy ? e.touches[0].clientY : null; dy = 0 }, { passive: true })
    el.list.addEventListener('touchmove', function (e) {
      if (y0 == null) return
      dy = Math.max(0, e.touches[0].clientY - y0)
      el.ptr.style.height = Math.min(72, dy * 0.45) + 'px'
      el.ptr.firstElementChild.style.transform = 'rotate(' + dy * 1.6 + 'deg)'
    }, { passive: true })
    el.list.addEventListener('touchend', function () {
      if (y0 == null) return
      y0 = null
      function done() { busy = false; el.ptr.classList.remove('go'); el.ptr.style.transition = 'height .25s'; el.ptr.style.height = '0'; setTimeout(function () { el.ptr.style.transition = '' }, 260) }
      if (dy * 0.45 >= 56) {
        busy = true
        el.ptr.classList.add('go')
        el.ptr.style.height = '48px'
        buzz()
        if (!es) connect()
        loadBoot().then(done, function (e) { toast(e.message, 'err'); done() })
      } else done()
    })
  })()

  // Native details toggles its existing DOM; saving its state must not rebuild
  // message/video nodes. Capture is needed because toggle does not bubble.
  el.msgs.addEventListener('toggle', function (e) {
    var d = e.target, c = S.chats.get(S.cur)
    if (!c || d.tagName !== 'DETAILS') return
    if (d.dataset.voiceTranscript != null) { if (!c.voiceTextOpen) c.voiceTextOpen = new Set(); if (d.open) c.voiceTextOpen.add(d.dataset.voiceTranscript); else c.voiceTextOpen.delete(d.dataset.voiceTranscript); return }
    if (d.dataset.voiceUnmatched != null) { c.voiceUnmatchedOpen = d.open; return }
    if (d.dataset.resultDetails == null) return
    if (d.previousElementSibling && d.previousElementSibling.classList.contains('result-excerpt')) d.previousElementSibling.hidden = d.open
    if (!c.resultOpen) c.resultOpen = new Set()
    var key = +d.dataset.resultDetails
    if (d.open) c.resultOpen.add(key); else c.resultOpen.delete(key)
  }, true)
  el.scroller.addEventListener('pointerdown', function (event) {
    var button = event.target.closest('[data-voice-menu]'); if (!button || (event.button != null && event.button !== 0)) return
    cancelVoicePress()
    var press = { pointerId: event.pointerId, x: event.clientX, y: event.clientY, sid: S.cur, button: button }
    voicePress = press; press.timer = setTimeout(function () { if (voicePress === press && S.cur === press.sid && button.isConnected !== false) openVoiceMessageMenu(button) }, 450)
  })
  el.scroller.addEventListener('pointermove', function (event) { if (voicePress && event.pointerId === voicePress.pointerId && Math.hypot(event.clientX - voicePress.x, event.clientY - voicePress.y) > 12) cancelVoicePress() })
  ;['pointerup', 'pointercancel', 'lostpointercapture'].forEach(function (type) { el.scroller.addEventListener(type, cancelVoicePress) })
  el.scroller.addEventListener('scroll', function () { cancelVoicePress(); stopVoiceQueue() }, { passive: true })
  el.scroller.addEventListener('contextmenu', function (event) { var button = event.target.closest('[data-voice-menu]'); if (button) { event.preventDefault(); openVoiceMessageMenu(button) } })
  el.scroller.addEventListener('click', function (e) {
    var c = S.chats.get(S.cur), b
    if (!c) return
    if ((b = e.target.closest('[data-voice-play]'))) { if ((voiceClickSuppressed.get(b.dataset.voiceMenu) || 0) > Date.now()) { if (e.preventDefault) e.preventDefault(); return } playVoiceBubble(b); return }
    if ((b = e.target.closest('[data-video-download]'))) { downloadVideo(b); return }
    if ((b = e.target.closest('[data-video-fullscreen]'))) { fullscreenVideo(b); return }
    if ((b = e.target.closest('[data-video-retry]'))) { preparePreview(b.closest('[data-video-box]').querySelector('video')); return }
    if ((b = e.target.closest('[data-video-quality]'))) { switchVideo(b); return }
    if ((b = e.target.closest('[data-result-path]'))) { fvOpen({ kind: 'path', s: c.id, path: b.dataset.resultPath, folderFor: true, title: '所在文件夹' }); return }
    if ((b = e.target.closest('[data-open-video]'))) {
      var owner = b.closest('[data-message-seq]')
      var movie = owner && Array.prototype.find.call(el.msgs.querySelectorAll('video[data-artifact]'), function (v) { return v.getAttribute('data-message-seq') === owner.dataset.messageSeq && v.getAttribute('data-session') === c.id && v.getAttribute('data-artifact') === b.dataset.openVideo })
      if (movie) { movie.scrollIntoView({ block: 'center' }); if (movie._previewError && movie.dataset.quality !== 'original') preparePreview(movie); else movie.play().catch(function () { toast('请点视频播放按钮', 'err') }) }
      else fvOpen({ kind: 'path', s: c.id, path: b.dataset.openVideo, autoplay: true, title: baseName(b.dataset.openVideo) })
      return
    }
    if ((b = e.target.closest('[data-process]'))) {
      var pk = +b.dataset.process
      if (!c.processOpen) c.processOpen = new Set()
      if (c.processOpen.has(pk)) c.processOpen.delete(pk); else c.processOpen.add(pk)
      renderMsgs(c, false, true)
      return
    }
    if ((b = e.target.closest('a[href]'))) { e.preventDefault(); window.open(b.href, '_blank', 'noopener'); return }
    if ((b = e.target.closest('[data-full]'))) {
      for (var n = c.items.length - 1; n >= 0; n--) {
        var ft = c.items[n]
        if (ft.k === 't' && ft.id === b.dataset.full) { fvOpen({ kind: 'call', s: c.id, id: ft.id, seq: ft.seq, rseq: ft.rseq, title: ft.title }); break }
      }
      return
    }
    if ((b = e.target.closest('[data-fp]'))) { fvOpen({ kind: 'path', s: c.id, path: b.dataset.fp, title: baseName(b.dataset.fp) }); return }
    if ((b = e.target.closest('[data-group]'))) { var k = +b.dataset.group; if (c.open.has(k)) c.open.delete(k); else c.open.add(k); renderMsgs(c, false, true); return }
    if ((b = e.target.closest('[data-tool]'))) {
      for (var i = c.items.length - 1; i >= 0; i--) if (c.items[i].k === 't' && c.items[i].id === b.dataset.tool) { c.items[i]._o = !c.items[i]._o; break }
      renderMsgs(c, false, true)
      return
    }
    if ((b = e.target.closest('[data-think]'))) { c.items.forEach(function (it) { if (it.seq === +b.dataset.think) it._t = !it._t }); renderMsgs(c, false, true); return }
    if ((b = e.target.closest('[data-copy]'))) { copy(b.closest('pre').querySelector('code').textContent); return }
    if ((b = e.target.closest('[data-copymsg]'))) { c.items.forEach(function (it) { if (it.seq === +b.dataset.copymsg) copy(it.text) }); return }
    if ((b = e.target.closest('[data-older]'))) { loadOlder(c); return }
    if ((b = e.target.closest('[data-call-locate]'))) { var callStart = el.msgs.querySelector('[data-call-id="' + b.dataset.callLocate + '"]'); if (callStart) callStart.scrollIntoView({ behavior: 'smooth', block: 'center' }); return }
    if ((b = e.target.closest('[data-retry]'))) { loadHistory(c); return }
    if ((b = e.target.closest('img[data-view]'))) { view(b.src); return }
  })
  el.scroller.addEventListener('scroll', function () { el.toBottom.hidden = nearBottom() }, { passive: true })
  el.toBottom.onclick = function () { el.scroller.scrollTo({ top: el.scroller.scrollHeight, behavior: 'smooth' }) }
  window.addEventListener('resize', function () { if (S.cur && nearBottom()) toBottom() })

  // Take the question card down as soon as it is sent: the host may already have
  // the answer while the phone's link drops, and a card that outlives its own
  // submission turns every retry into "expired". The selections ride on `q`, so
  // a send that certainly failed puts the card back with the user's choices.
  // A transport failure gets one silent retry: the answer RPC is idempotent, and
  // a card whose question the host has already settled cannot be answered at all.
  function settleQuestion(q, result) {
    if (q._sending) return
    q._sending = true
    S.qs.delete(q.rpc); drawDock(); scheduleHome()
    function send(tries) {
      respond(q.rpc, result).then(function () {
        buzz()
      }, function (err) {
        var message = (err && err.message) || '发送失败'
        if (/已失效|已提交|已经处理|not.?pending|unknown rpc/i.test(message)) { toast('这条问题已经处理过了'); return }
        if (tries > 0 && /连不上|超时|HTTP 5|upstream|timeout/i.test(message)) {
          setTimeout(function () { send(tries - 1) }, 800)
          return
        }
        q._sending = false
        S.qs.set(q.rpc, q); drawDock(); scheduleHome()
        toast(message + '，可以重新提交', 'err')
      })
    }
    send(1)
  }

  el.dock.addEventListener('click', function (e) {
    var c = S.chats.get(S.cur), b
    if (!c) return
    var asyncCard = e.target.closest('[data-async-question]')
    if (asyncCard) {
      var asyncQuestion = (c.asyncQuestions || []).find(function (item) { return item.id === asyncCard.dataset.asyncQuestion }); if (!asyncQuestion) return
      if (e.target.closest('[data-async-refresh]')) { loadAsyncQuestions(c.id); return }
      var asyncValue = asyncDraft(c.id, asyncQuestion.id)
      if (asyncValue.delivery || asyncQuestion.delivery === 'unknown' || asyncQuestion.delivery === 'pending') return
      if ((b = e.target.closest('[data-async-option]'))) { var option = (asyncQuestion.options || [])[+b.dataset.asyncOption]; if (option != null) { asyncValue.text = option; saveAsyncDrafts(); drawDock() } return }
      if (e.target.closest('[data-async-submit]')) submitAsyncAnswer(c, asyncQuestion)
      return
    }
    if ((b = e.target.closest('[data-allow],[data-deny],[data-remember]'))) {
      var id = b.dataset.allow || b.dataset.deny || b.dataset.remember, a = S.asks.get(id)
      if (!a) return
      var outcome = b.dataset.deny ? 'rejected' : 'allowed-once'
      b.parentNode.querySelectorAll('button').forEach(function (x) { x.disabled = true })
      buzz(outcome === 'allowed-once' ? 15 : 8)
      var value = { sessionId: a.s, approvalId: a.id, outcome: outcome }
      if (b.dataset.remember) value.remember = true
      respond(a.rpc, { ok: true, value: value }).then(function (r) {
        S.asks.delete(id)
        drawDock(); scheduleHome()
        if (!r.accepted && r.reason !== 'not-pending') toast('没有生效：' + r.reason, 'err')
      }, function (err) { drawDock(); toast(err.message, 'err') })
      return
    }
    var card = e.target.closest('[data-q]')
    if (card) {
      var q = S.qs.get(card.dataset.q)
      if (!q) return
      if ((b = e.target.closest('[data-qo]'))) {
        var ix = b.dataset.qo.split(':'), item = q.qs[+ix[0]], opt = item.options[+ix[1]], cur = q._sel[item.id] || []
        if (item.multiSelect) q._sel[item.id] = cur.indexOf(opt.label) >= 0 ? cur.filter(function (x) { return x !== opt.label }) : cur.concat(opt.label)
        else q._sel[item.id] = [opt.label]
        buzz(6)
        drawDock()
        return
      }
      if (e.target.closest('[data-qcancel]')) {
        settleQuestion(q, { ok: false, error: { code: 'cancelled', message: 'the user closed this question request', details: {} } })
        return
      }
      if (e.target.closest('[data-qsubmit]')) {
        var missing = false
        var answers = q.qs.map(function (it) {
          var selected = q._sel[it.id] || [], custom = (q._custom[it.id] || '').trim()
          if (!selected.length && !custom) missing = true
          var ans = { id: it.id, selected: selected }
          if (custom) ans.custom = custom
          return ans
        })
        if (missing) { toast('每个问题都需要回答'); return }
        settleQuestion(q, { ok: true, value: { sessionId: q.s, answer: { answers: answers } } })
        return
      }
      return
    }
    if ((b = e.target.closest('[data-steer]'))) {
      steer(c, b.dataset.steer)
      return
    }
    if ((b = e.target.closest('[data-steerall]'))) {
      // Same strict-steer operation as the per-row button, FIFO order.
      // The snapshot can still list a row the host already steered inside a
      // closing turn; each duplicate is a silent no-op, never an error.
      var pending = (c.queue || []).filter(function (x) { return x.id && x.place !== 'steering' })
      pending.reduce(function (p, x) { return p.then(function (ok) { return ok === false ? false : steer(c, x.id) }) }, Promise.resolve(true))
      return
    }
    if ((b = e.target.closest('[data-qedit]'))) { editQueued(c, b.dataset.qedit); return }
    if ((b = e.target.closest('[data-qwait]'))) {
      var row = queueItem(c, b.dataset.qwait)
      if (row) { row.waitAck = true; buzz(8); drawDock(); toast('已设为等待：当前回合结束后自动发送') }
      return
    }
    if ((b = e.target.closest('[data-unqueue]'))) {
      updateQueued(c, b.dataset.unqueue, { kind: 'remove' })
      return
    }
    if (e.target.closest('[data-todo]')) { c.todoOpen = !c.todoOpen; drawDock() }
  })
  el.dock.addEventListener('input', function (e) {
    var aq = e.target.closest('[data-async-question]'), ai = e.target.closest('[data-async-input]')
    if (aq && ai && S.cur) { var draft = asyncDraft(S.cur, aq.dataset.asyncQuestion); if (!draft.delivery) { draft.text = ai.value; saveAsyncDrafts() } return }
    var inp = e.target.closest('[data-qi]'), card = e.target.closest('[data-q]')
    if (!inp || !card) return
    var q = S.qs.get(card.dataset.q)
    if (q) q._custom[q.qs[+inp.dataset.qi].id] = inp.value
  })
  el.dock.addEventListener('focusout', function () { setTimeout(function () { if (dockDirty && !el.dock.contains(document.activeElement)) drawDock() }, 0) })

  el.inputSuggestion.onclick = acceptSuggestion
  el.input.addEventListener('compositionstart', function () { suggestion.composing = true; hideSuggestion() })
  el.input.addEventListener('compositionend', function () { suggestion.composing = false; syncSuggestion() })
  el.input.addEventListener('keydown', function (event) {
    if (event.key === 'Escape') { if (suggestion.key) suggestion.seen.add(suggestion.key); hideSuggestion() }
    if (event.key === 'Tab' && !event.shiftKey && !event.ctrlKey && !event.altKey && !event.metaKey && !event.isComposing && !suggestion.composing && document.activeElement === el.input && acceptSuggestion()) event.preventDefault()
  })
  document.addEventListener('visibilitychange', function () { if (document.visibilityState !== 'visible') hideSuggestion(); else syncSuggestion() })
  el.input.addEventListener('input', function () { hideSuggestion(); autosize(); syncSend() })
  el.send.onclick = function () { if (el.send.classList.contains('stop')) stop(); else send() }
  el.attach.onclick = function () { el.file.click() }
  el.quick.onclick = quickSheet
  el.file.onchange = function () {
    var sid = S.cur, generation = attachmentGeneration, attachments = S.att
    var files = Array.prototype.slice.call(el.file.files || [], 0, Math.max(0, 6 - S.att.length))
    el.file.value = ''
    Promise.all(files.map(function (f) { return prepImage(f).catch(function () { toast('有图片读取失败', 'err'); return null }) })).then(function (list) {
      list.forEach(function (a) { if (!a) return; if (sid !== S.cur || generation !== attachmentGeneration || attachments !== S.att || S.att.length >= 6) { URL.revokeObjectURL(a.url); return } S.att.push(a) })
      drawThumbs(); syncSend()
    })
  }
  el.thumbs.addEventListener('click', function (e) {
    var b = e.target.closest('[data-rm]')
    if (!b) return
    var removed = S.att.splice(+b.dataset.rm, 1); removed.forEach(function (item) { URL.revokeObjectURL(item.url) })
    drawThumbs(); syncSend()
  })

  setInterval(function () { if (document.visibilityState === 'visible' && S.cur && S.status === 'online') loadAsyncQuestions(S.cur) }, 5000)

  setInterval(function () {
    checkUpdates()
    if (!S.cur && document.visibilityState === 'visible') scheduleHome()
  }, 60000)
  window.addEventListener('online', checkUpdates)

  // ------------------------------------------------------------ Android shell hooks
  // In-app update: the shell reports "DSHApp/<version>+<code>" (1.3.0+); older shells
  // cannot update themselves and only get a hint.
  var APP_CODE = +((/DSHApp\/[\d.]+\+(\d+)/.exec(navigator.userAgent) || [])[1] || 0)
  function checkAppUpdate(signal) {
    return fetch('/m/api/app/latest', { cache: 'no-store', redirect: 'manual', signal: signal }).then(function (r) {
      if (r.status !== 200 || signal.aborted) return
      return r.json().then(function (j) {
        var v = j && j.ok && j.value
        if (!signal.aborted && v && (APP_CODE ? v.versionCode > APP_CODE : true)) {
          S.appUpdate = { versionName: v.versionName, self: APP_CODE > 0 }; scheduleHome()
        }
      })
    })
  }
  function uiHtml(source) {
    try {
      var d = new DOMParser().parseFromString(source, 'text/html')
      var manifest = d.querySelector('link[rel="manifest"]'), style = d.querySelector('head > style'), script = d.querySelector('body > script')
      if (d.title !== 'DSH' || !manifest || manifest.getAttribute('href') !== '/m/manifest.webmanifest' || d.querySelectorAll('#app').length !== 1 ||
        !d.querySelector('#app > section#home #rows') || !d.querySelector('#app > section#chat #msgs') ||
        !d.querySelector('#app > section#chat textarea#input') || !d.querySelector('#app > section#chat button#send') ||
        !style || !style.textContent.trim() || !script || script.getAttribute('src') || !script.textContent.trim()) return null
      // The inline script runs before the parser consumes the body tail. Only
      // structural whitespace is normalized; script/style/textarea text stays exact.
      ;[d.documentElement, d.head, d.body].forEach(function (node) {
        Array.prototype.slice.call(node.childNodes).forEach(function (child) {
          if (child.nodeType === 3 && !child.nodeValue.trim()) node.removeChild(child)
        })
      })
      return d.documentElement.outerHTML
    } catch (e) { return null }
  }
  var loadedUiHtml = uiHtml(loadedUiSource), seenUiEtag = null, uiChecked = false
  var updateAt = -Infinity, updateFlight = null
  function uiResponse(r) {
    return r.status === 200 && !r.redirected && r.type !== 'opaqueredirect' && /^text\/html(?:\s*;|$)/i.test(r.headers.get('Content-Type') || '')
  }
  function checkUiUpdate(signal) {
    function compareHtml() {
      return fetch('/m/', { method: 'GET', cache: 'no-store', redirect: 'manual', signal: signal }).then(function (r) {
        if (signal.aborted || !uiResponse(r)) return
        return r.text().then(function (source) {
          if (signal.aborted) return
          var html = uiHtml(source)
          if (!html) return
          seenUiEtag = r.headers.get('ETag')
          var next = html === loadedUiHtml ? null : true
          if (S.uiUpdate !== next) { S.uiUpdate = next; scheduleHome() }
        })
      })
    }
    if (!uiChecked) { uiChecked = true; return compareHtml() }
    return fetch('/m/', { method: 'HEAD', cache: 'no-store', redirect: 'manual', signal: signal }).then(function (r) {
      if (signal.aborted || !uiResponse(r)) return
      var etag = r.headers.get('ETag')
      if (!etag || etag !== seenUiEtag) return compareHtml()
    })
  }
  function checkUpdates() {
    if (document.visibilityState !== 'visible' || navigator.onLine === false) return
    if (updateFlight) return updateFlight
    if (Date.now() - updateAt < 60000 || (!loadedUiHtml && !IN_APP)) return
    updateAt = Date.now()
    var controller = new AbortController(), checks = []
    var timer = setTimeout(function () { controller.abort() }, 8000)
    // Update probes stay outside handle(): login/gateway failures must not reload a playing page.
    if (loadedUiHtml) checks.push(checkUiUpdate(controller.signal))
    if (IN_APP) checks.push(checkAppUpdate(controller.signal))
    updateFlight = Promise.all(checks.map(function (check) { return check.catch(function () {}) })).then(function () {
      clearTimeout(timer); updateFlight = null
    })
    return updateFlight
  }
  window.dshToast = function (msg, kind) { toast(msg, kind) }
  window.dshStopVoice = function () { stopVoice() }

  // "Share to DSH" from another app: pick the conversation, then review in the composer.
  function b64Blob(b64, type) {
    var bin = atob(b64), a = new Uint8Array(bin.length)
    for (var i = 0; i < bin.length; i++) a[i] = bin.charCodeAt(i)
    return new Blob([a], { type: type })
  }
  function fillShare(id, share) {
    el.input.value = share.text
    S.att = isAgent(id) ? [] : share.imgs.slice(0, 6)
    drawThumbs(); autosize(); syncSend()
    if (isAgent(id) && share.imgs.length) toast('Claude Code / Codex 会话只能发文字，图片没带上')
    setTimeout(function () { el.input.focus() }, 380)
  }
  window.dshShare = function (p) {
    if (!p) return
    var share = {
      text: [p.subject, p.text].filter(Boolean).join('\n').trim(),
      imgs: (p.images || []).slice(0, 6).map(function (im) { return { url: URL.createObjectURL(b64Blob(im.b64, im.type || 'image/jpeg')), b64: im.b64, type: im.type || 'image/jpeg', name: im.name || 'shared.jpg' } }),
    }
    var dsh = S.sessions.slice().sort(function (a, b) { return b.at - a.at }).slice(0, 6)
    var ags = S.agents.sessions.slice(0, 3)
    var what = (share.imgs.length ? share.imgs.length + ' 张图片' : '') + (share.text ? (share.imgs.length ? ' · ' : '') + share.text.slice(0, 40) : '')
    closeAllOverlays().then(function () {
      openSheet('<div class="sh-h">分享到 DSH<small>' + esc(what || '内容') + '</small></div><div class="sh-b">' +
        '<button class="opt-row" data-new><span class="ico">' + ic('plus', 's') + '</span><span class="mid"><b>新对话</b><small>选一个工作区</small></span>' + ic('chev', 's') + '</button>' +
        dsh.map(function (s) { return '<button class="opt-row" data-sid="' + esc(s.id) + '"><span class="ico">' + ic('folder', 's') + '</span><span class="mid"><b>' + esc(s.title || '未命名对话') + '</b><small>' + esc(wsTitle(s.w)) + '</small></span></button>' }).join('') +
        ags.map(function (a) { return '<button class="opt-row" data-sid="' + esc(a.id) + '"><span class="ico">' + ic('execute', 's') + '</span><span class="mid"><b>' + esc(a.title || a.project || a.name) + '</b><small>' + esc(a.name + (a.project ? ' · ' + a.project : '')) + '</small></span></button>' }).join('') +
        '</div>')
      el.sheet.onclick = function (e) {
        var b = e.target.closest('[data-sid],[data-new]')
        if (!b) return
        closeOverlay().then(function () {
          if (b.dataset.sid) { openChat(b.dataset.sid); fillShare(b.dataset.sid, share) }
          else { S.share = share; newSheet() }
        })
      }
    })
  }

  // ------------------------------------------------------------ boot
  // The Android shell calls this when a notification is tapped.
  window.dshOpen = function (id) {
    if (!id) return
    if (overlays.length) closeAllOverlays().then(function () { openChat(id) })
    else if (S.cur !== id) openChat(id)
  }
  // /m/?debug exposes the frame entry point for UI checks with synthetic frames.
  if (/[?&]debug\b/.test(location.search)) window.__dsh = { syncSuggestion: syncSuggestion, acceptSuggestion: acceptSuggestion, S: S, onFrame: onFrame, loadVoiceHistory: loadVoiceHistory, renderMsgs: renderMsgs, loadAsyncQuestions: loadAsyncQuestions, startVoice: startVoice, getVoiceTiming: function () { return voice && voice.callTiming ? Object.assign({}, voice.callTiming) : null } }
  var deep = decodeURIComponent((location.hash || '').slice(1))
  history.replaceState({ v: 'home' }, '', location.pathname)
  var cached = store.get('boot', null)
  if (cached && cached.sessions) { try { applyBoot(cached); S.run = new Set() } catch (e) {} }
  renderHome()
  loadBoot().then(function () { if (deep && (S.byId[deep] || isAgent(deep))) openChat(deep) }, function (e) { toast(e.message, 'err') })
  checkUpdates()
  connect()
})()




