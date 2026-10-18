/**
 * Phone client (www/app.js) — the two states that used to leave the composer
 * with no working button, verified against the real page script.
 *
 * app.js is a plain browser IIFE with no build step, so it runs here under a
 * minimal DOM/EventSource stub and hands its internals back through the
 * `?debug` hook (`window.__dsh`). That keeps these tests on the shipped code
 * instead of a reimplementation of it.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'

const APP = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'www', 'app.js'), 'utf8')

// Controlled DOMParser documents: structural whitespace is separate from
// inline source text, as in a real parsed document. Browser acceptance is separate.
const UI_DOCUMENTS = new Map()
function uiShell({ css = 'body { color: black; }', js = 'window.fixture = 1;', content = '', title = 'DSH', marker = true } = {}) {
  const core = '<html><head><title>' + title + '</title><link rel="manifest" href="/m/manifest.webmanifest"><style>' + css + '</style></head><body><div id="' + (marker ? 'app' : 'gateway') + '"><section id="home"><div id="rows"></div></section><section id="chat"><div id="msgs"></div><textarea id="input"></textarea><button id="send"></button></section>' + content + '</div><script>' + js + '</script>'
  const fixture = { core, title, marker, css, js, snapshot: core + '</body></html>', html: '<!doctype html>\n' + core + '\n</body>\n</html>' }
  UI_DOCUMENTS.set(fixture.snapshot, { fixture, tail: '' })
  UI_DOCUMENTS.set(fixture.html, { fixture, tail: '\n' })
  return fixture
}
const UI_BASE = uiShell(), UI_NEW = uiShell({ css: 'body { color: blue; }' })
function parsedShell(source) {
  const { fixture, tail } = UI_DOCUMENTS.get(source) || { fixture: { core: '<html><head></head><body>invalid', title: '', marker: false, css: '', js: '' }, tail: '' }
  const container = (children) => ({ childNodes: children, removeChild(child) { this.childNodes.splice(this.childNodes.indexOf(child), 1) } })
  const body = container(tail ? [{ nodeType: 1 }, { nodeType: 3, nodeValue: tail }] : [{ nodeType: 1 }])
  const head = container([{ nodeType: 1 }]), documentElement = container([head, body])
  head.nodeType = body.nodeType = 1
  Object.defineProperty(documentElement, 'outerHTML', { get: () => fixture.core + body.childNodes.filter(n => n.nodeType === 3).map(n => n.nodeValue).join('') + '</body></html>' })
  return { title: fixture.title, head, body, documentElement,
    querySelectorAll: selector => selector === '#app' && fixture.marker ? [{}] : [],
    querySelector(selector) {
      if (!fixture.marker) return null
      if (selector === 'link[rel="manifest"]') return { getAttribute: name => name === 'href' ? '/m/manifest.webmanifest' : null }
      if (selector === 'head > style') return { textContent: fixture.css }
      if (selector === 'body > script') return { textContent: fixture.js, getAttribute: () => null }
      return ['#app > section#home #rows', '#app > section#chat #msgs', '#app > section#chat textarea#input', '#app > section#chat button#send'].includes(selector) ? {} : null
    },
  }
}
const shellResponse = (fixture = UI_BASE, etag = '"base"', status = 200, type = 'text/html; charset=utf-8') => ({ status,
  headers: { get: name => ({ etag, 'content-type': type })[name.toLowerCase()] ?? null }, text: () => Promise.resolve(fixture.html),
})

/** Just enough element for app.js's rendering and input paths. */
function makeEl(tag = 'div', id = '') {
  const listeners = {}
  const el = {
    tagName: tag.toUpperCase(), id, children: [], childNodes: [], classList: { _s: new Set(), add(...c) { c.forEach((x) => this._s.add(x)) }, remove(...c) { c.forEach((x) => this._s.delete(x)) }, toggle(c, on) { if (on === undefined) this._s.has(c) ? this._s.delete(c) : this._s.add(c); else on ? this._s.add(c) : this._s.delete(c) }, contains(c) { return this._s.has(c) } },
    style: {}, dataset: {}, attributes: {}, hidden: false, disabled: false,
    value: '', textContent: '', placeholder: '', scrollTop: 0, scrollHeight: 0, clientHeight: 0,
    innerHTML: '', outerHTML: '', className: '',
    listeners,
    addEventListener(t, fn, o) { (listeners[t] = listeners[t] || []).push({ fn, o }) },
    removeEventListener() {}, dispatch(t, ev = {}) { (listeners[t] || []).forEach((l) => l.fn(ev)) },
    appendChild(c) { el.children.push(c); el.childNodes.push(c); return c },
    insertBefore(c) { el.children.unshift(c); return c },
    removeChild(c) { el.children = el.children.filter((x) => x !== c); return c },
    remove() {}, setAttribute(k, v) { el.attributes[k] = String(v) }, getAttribute(k) { return el.attributes[k] ?? null },
    querySelector() { return null }, querySelectorAll() { return [] }, closest() { return null },
    contains() { return false }, focus() {}, blur() {}, click() {}, scrollIntoView() {}, getBoundingClientRect() { return { x: 0, y: 0, width: 0, height: 0, top: 0, left: 0, bottom: 0, right: 0 } },
  }
  // The status pill writes into its own last child; every element carries a
  // plain leaf one so a stub never trips the render path.
  el.firstChild = { textContent: '' }
  el.lastChild = { textContent: '' }
  // app.js also assigns handlers (onclick, oninput, …) and reads elements it
  // never declared. Rather than enumerate every one, unknown properties become
  // absorbent stubs: assignable, and callable when app.js expects a method.
  return new Proxy(el, {
    get(t, k) {
      if (k in t || typeof k === 'symbol') return t[k]
      const stub = () => undefined
      stub.textContent = ''; stub.value = ''; stub.hidden = false
      stub.addEventListener = () => {}; stub.classList = t.classList
      stub.style = {}; stub.dataset = {}
      return (t[k] = stub)
    },
    set(t, k, v) { t[k] = v; return true },
  })
}

/**
 * Boot app.js in a page-shaped sandbox.
 * @param {{search?: string}} opts - `?debug` exposes window.__dsh.
 * @returns the sandbox, with `sandbox.window.__dsh` populated.
 */
function bootApp({ search = '?debug', rpcResult = () => ({ ok: true, value: { accepted: true } }), readResult, voiceRequest, agentsResult, loadedHtml = UI_BASE.snapshot, liveHtml, uiResult, appLatestResult, userAgent = 'test', visibility = 'visible', online = true } = {}) {
  const byId = new Map()
  const store = new Map()
  /** Every /m/api/rpc call the page makes, so tests can assert the wire call. */
  const rpcCalls = []
  const readCalls = []
  const uiCalls = [], headCalls = [], uiGetCalls = [], parseCalls = [], appLatestCalls = [], intervals = [], timeouts = new Map()
  let now = Date.now(), timerId = 0, reloads = 0
  class Clock extends Date { constructor(...args) { super(...(args.length ? args : [now])) } static now() { return now } }
  const windowEvents = new Map(), documentEvents = new Map()
  const doc = {
    getElementById(id) { if (!byId.has(id)) byId.set(id, makeEl('div', id)); return byId.get(id) },
    createElement(tag) { return makeEl(tag) },
    querySelector() { return null }, querySelectorAll(selector) { if (selector === '[data-ic]' && liveHtml) doc.documentElement.outerHTML = liveHtml; return [] },
    addEventListener(t, fn) { if (!documentEvents.has(t)) documentEvents.set(t, []); documentEvents.get(t).push(fn) }, removeEventListener() {},
    documentElement: makeEl('html'), head: makeEl('head'), body: makeEl('body'),
    activeElement: null, visibilityState: visibility,
  }
  doc.documentElement.outerHTML = loadedHtml
  const sandbox = {
    document: doc,
    navigator: { userAgent, maxTouchPoints: 0, standalone: false, onLine: online, serviceWorker: { register: () => Promise.resolve({}), addEventListener() {} }, vibrate() {} },
    location: { pathname: '/m/', hash: '', search, href: 'https://example.test/m/' + search, replace() {}, reload() { reloads++ } },
    history: { state: null, pushState() {}, replaceState() {}, go() {}, back() {} },
    localStorage: { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k) },
    matchMedia: () => ({ matches: false, addEventListener() {}, addListener() {} }),
    requestAnimationFrame: (fn) => setTimeout(fn, 0),
    cancelAnimationFrame: (t) => clearTimeout(t),
    // The page keeps a reconnect loop and streaming timers alive; a booted
    // sandbox must be inert or the test run never exits. Frame and reconnect
    // timers are driven explicitly by the test through onFrame.
    setTimeout(fn, ms) { timeouts.set(++timerId, { fn, ms }); return timerId }, clearTimeout(id) { timeouts.delete(id) },
    setInterval(fn, ms) { intervals.push({ fn, ms }); return intervals.length }, clearInterval() {},
    // Startup calls fail fast (keeping the sandbox quiet) while RPC posts are
    // recorded, so a test can assert which method the UI actually sent.
    fetch: (url, opts) => {
      if (voiceRequest && (String(url).startsWith('/m/api/voice') || String(url).startsWith('/voice-mode') || String(url) === '/api/commands/list')) return voiceRequest(String(url), opts)
      if (String(url) === '/m/') {
        const call = { url: String(url), opts }
        uiCalls.push(call); (opts.method === 'HEAD' ? headCalls : uiGetCalls).push(call)
        return Promise.resolve().then(() => uiResult ? uiResult(call) : shellResponse())
      }
      if (String(url) === '/m/api/app/latest') {
        appLatestCalls.push({ url: String(url), opts })
        return Promise.resolve().then(() => appLatestResult ? appLatestResult(appLatestCalls.at(-1)) : { status: 200, json: () => Promise.resolve({ ok: true, value: { versionName: '1.3.2', versionCode: 132 } }) })
      }
      if (String(url) === '/m/api/agents' && agentsResult) return Promise.resolve({ status: 200, json: () => Promise.resolve({ ok: true, value: agentsResult }) })
      if (String(url).indexOf('/m/api/rpc') >= 0 && opts && opts.body) {
        try { rpcCalls.push(JSON.parse(opts.body)) } catch { rpcCalls.push({ raw: opts.body }) }
        return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(rpcResult(rpcCalls.at(-1))), text: () => Promise.resolve('{"ok":true}') })
      }
      if (readResult && String(url).startsWith('/m/api/fs?')) {
        readCalls.push(String(url))
        return Promise.resolve({ status: 200, json: () => Promise.resolve(readResult(String(url))) })
      }
      return Promise.resolve({ ok: false, status: 0, text: () => Promise.resolve(''), json: () => Promise.reject(new Error('offline in tests')) })
    },
    URL: { createObjectURL: () => 'blob:x', revokeObjectURL() {} },
    Image: class { },
    DOMParser: class { parseFromString(source, type) { parseCalls.push({ source, type }); assert.equal(type, 'text/html'); return parsedShell(source) } },
    crypto: { randomUUID: () => '00000000-0000-4000-8000-000000000000', getRandomValues: (a) => a },
    EventSource: class { constructor() { this.readyState = 0 } close() {} addEventListener(type, fn) { if (type === 'mode') queueMicrotask(() => fn({ data: '{"active":null,"ownerTabId":null}' })) } },
    addEventListener(t, fn) { if (!windowEvents.has(t)) windowEvents.set(t, []); windowEvents.get(t).push(fn) }, removeEventListener() {},
    console,
    btoa: value => Buffer.from(value, 'binary').toString('base64'), JSON, Math, Date: Clock, Set, Map, Array, Object, String, Number, Boolean, Promise, Error, RegExp, AbortController, AbortSignal, isNaN, parseInt, parseFloat, encodeURIComponent, decodeURIComponent,
  }
  sandbox.window = sandbox
  sandbox.globalThis = sandbox
  sandbox.self = sandbox
  vm.createContext(sandbox)
  vm.runInContext(APP, sandbox, { filename: 'app.js' })
  sandbox.rpcCalls = rpcCalls
  sandbox.readCalls = readCalls
  sandbox.els = byId
  sandbox.dispatchWindow = (t, event) => (windowEvents.get(t) || []).forEach(fn => fn(event))
  sandbox.dispatchDocument = (t, event) => (documentEvents.get(t) || []).forEach(fn => fn(event))
  sandbox.uiCalls = uiCalls; sandbox.headCalls = headCalls; sandbox.uiGetCalls = uiGetCalls; sandbox.parseCalls = parseCalls; sandbox.appLatestCalls = appLatestCalls
  sandbox.advance = (ms) => { now += ms }
  sandbox.runInterval = (ms) => intervals.filter(timer => timer.ms === ms).forEach(timer => timer.fn())
  sandbox.fireTimeouts = (ms) => { for (const [id, timer] of timeouts) if (timer.ms === ms) { timeouts.delete(id); timer.fn() } }
  sandbox.reloadCount = () => reloads
  return sandbox
}

/** A chat with one queued message, the shape the frame handler builds. */
function chatWithQueue(S, id, running = true) {
  const c = { id, items: [], pending: [], partial: null, lastSeq: -1, firstSeq: -1, hasMore: false, loaded: true, loading: false, err: false, buf: [], open: new Set(), todos: null, todoOpen: false, queue: [], title: '', w: null, model: null, models: null }
  S.chats.set(id, c)
  S.byId[id] = { id, title: 't', at: Date.now(), run: running, w: null }
  if (running) S.run.add(id)
  S.cur = id
  return c
}

function asyncQuestionFixture({ reject = false, deferPost = false } = {}) {
  const page = bootApp(), { S } = page.__dsh, c = chatWithQueue(S, 'clarification-session', false), calls = []
  const question = { id: 'question-1', sessionId: c.id, question: '保存哪种格式？', options: ['MP4', 'MOV'], independentWork: '继续整理已有素材', createdAt: new Date().toISOString(), deadline: new Date(Date.now() - 1000).toISOString(), status: 'deferred' }
  let complete
  const original = page.fetch
  page.fetch = (url, options) => {
    if (!String(url).startsWith('/m/api/async-questions')) return original(url, options)
    calls.push({ url, options })
    if (options.method !== 'POST') return Promise.resolve({ ok: true, status: 200, json: async () => ({ ok: true, value: { items: [question] } }) })
    if (reject) return Promise.reject(new Error('network response unknown'))
    const result = () => { question.status = 'answered'; question.delivery = 'accepted'; question.answer = { id: JSON.parse(options.body).answerId, text: JSON.parse(options.body).answer, at: new Date().toISOString() }; return { ok: true, status: 200, json: async () => ({ ok: true, value: question }) } }
    return deferPost ? new Promise(resolve => { complete = () => resolve(result()) }) : Promise.resolve(result())
  }
  const card = { dataset: { asyncQuestion: question.id } }
  const tap = (selector, dataset = {}) => page.els.get('dock').dispatch('click', { target: { closest: value => value === '[data-async-question]' ? card : value === selector ? { dataset } : null } })
  const type = text => page.els.get('dock').dispatch('input', { target: { closest: value => value === '[data-async-question]' ? card : value === '[data-async-input]' ? { value: text } : null } })
  return { page, S, c, calls, question, tap, type, complete: () => complete() }
}

test('async clarification is a separate dock card with no default submission and keeps native approvals', async () => {
  const v = asyncQuestionFixture(); v.S.asks.set('existing-approval', { id: 'existing-approval', s: v.c.id, title: '原生审批', tool: 'shell' })
  await v.page.__dsh.loadAsyncQuestions(v.c.id)
  assert.match(v.page.els.get('dock').innerHTML, /data-async-question/)
  assert.match(v.page.els.get('dock').innerHTML, /你仍可稍后回答/)
  assert.match(v.page.els.get('dock').innerHTML, /原生审批/)
  assert.equal(v.calls.filter(c => c.options.method === 'POST').length, 0)
  v.tap('[data-async-option]', { asyncOption: '1' })
  assert.equal(v.calls.filter(c => c.options.method === 'POST').length, 0)
  v.tap('[data-async-submit]'); await new Promise(r => setTimeout(r, 10))
  const post = JSON.parse(v.calls.find(c => c.options.method === 'POST').options.body)
  assert.equal(post.answer, 'MOV'); assert.ok(post.answerId)
  assert.doesNotMatch(v.page.els.get('dock').innerHTML, /已答问题|data-async-question/)
  assert.equal(v.S.asks.has('existing-approval'), true)
  assert.equal(v.page.rpcCalls.length, 0)
})

test('clarification answer waits for explicit submit, deduplicates double click and retains per-question draft', async () => {
  const v = asyncQuestionFixture({ deferPost: true }); await v.page.__dsh.loadAsyncQuestions(v.c.id)
  v.type('先做 MP4，之后补 MOV')
  chatWithQueue(v.S, 'other-clarification', false); v.S.cur = v.c.id
  await v.page.__dsh.loadAsyncQuestions(v.c.id)
  assert.match(v.page.els.get('dock').innerHTML, /先做 MP4，之后补 MOV/)
  v.tap('[data-async-submit]'); v.tap('[data-async-submit]')
  assert.equal(v.calls.filter(c => c.options.method === 'POST').length, 1)
  v.complete(); await new Promise(r => setTimeout(r, 10))
  assert.equal(v.question.answer.text, '先做 MP4，之后补 MOV')
  assert.doesNotMatch(v.page.els.get('dock').innerHTML, /\[object Object\]/)
  assert.doesNotMatch(v.page.els.get('dock').innerHTML, /先做 MP4，之后补 MOV|已答问题|data-async-question/)
})

test('unknown clarification submission stays visible and polling never replays it', async () => {
  const v = asyncQuestionFixture({ reject: true }); await v.page.__dsh.loadAsyncQuestions(v.c.id)
  v.type('MP4'); v.tap('[data-async-submit]'); await new Promise(r => setTimeout(r, 10))
  assert.match(v.page.els.get('dock').innerHTML, /回答发送状态待核对/)
  assert.doesNotMatch(v.page.els.get('dock').innerHTML, /data-async-submit/)
  v.S.status = 'online'; v.page.runInterval(5000); await new Promise(r => setTimeout(r, 10))
  v.tap('[data-async-submit]'); v.tap('[data-async-refresh]'); await new Promise(r => setTimeout(r, 10))
  assert.equal(v.calls.filter(c => c.options.method === 'POST').length, 1)
  assert.equal(v.S.asyncDrafts[v.c.id + ':' + v.question.id].delivery, 'unknown')
})

test('pending clarification delivery stays unresolved while not-needed is a confirmed answer', async () => {
  const v = asyncQuestionFixture()
  v.question.status = 'answered'; v.question.answer = { id: 'answer-fixture', text: 'MP4', at: new Date().toISOString() }; v.question.delivery = 'pending'
  await v.page.__dsh.loadAsyncQuestions(v.c.id)
  assert.match(v.page.els.get('dock').innerHTML, /回答发送状态待核对/)
  assert.doesNotMatch(v.page.els.get('dock').innerHTML, /已答问题/)
  v.S.asyncDrafts[v.c.id + ':' + v.question.id] = { text: 'MP4', delivery: 'unknown', answerId: 'retained-id' }
  v.question.delivery = 'not-needed'
  await v.page.__dsh.loadAsyncQuestions(v.c.id)
  assert.doesNotMatch(v.page.els.get('dock').innerHTML, /已答问题|data-async-question/)
  assert.doesNotMatch(v.page.els.get('dock').innerHTML, /回答发送状态待核对/)
})

test('clarification poll refreshes a separate home badge without replacing native approval', async () => {
  const v = asyncQuestionFixture(), session = v.S.byId[v.c.id]
  session.w = 'workspace-fixture'; v.S.sessions = [session]; v.S.booted = true
  v.S.asks.set('approval', { id: 'approval', s: v.c.id, title: '原生审批', tool: 'shell' })
  await v.page.__dsh.loadAsyncQuestions(v.c.id); await new Promise(r => setTimeout(r, 10))
  assert.equal(session.aq, 1)
  assert.match(v.page.els.get('rows').innerHTML, /待补充 1/)
  assert.match(v.page.els.get('rows').innerHTML, /待确认/)
  v.question.status = 'answered'; v.question.delivery = 'not-needed'; v.question.answer = { id: 'a', text: 'MP4', at: new Date().toISOString() }
  await v.page.__dsh.loadAsyncQuestions(v.c.id); await new Promise(r => setTimeout(r, 10))
  assert.equal(session.aq, 0); assert.doesNotMatch(v.page.els.get('rows').innerHTML, /待补充/)
  assert.match(v.page.els.get('rows').innerHTML, /待确认/)
})

test('app.js boots under a bare DOM and exposes the debug hook', () => {
  const sandbox = bootApp()
  assert.ok(sandbox.window.__dsh, '?debug must expose __dsh')
  assert.ok(sandbox.window.__dsh.S, 'debug hook carries the state')
  assert.equal(typeof sandbox.window.__dsh.onFrame, 'function')
  assert.equal(sandbox.window.__dsh.S.cur, null, 'nothing open on a cold start')
})

test('cancelled computer-folder picker in new conversation creates nothing and preserves current draft', async () => {
  const page=bootApp(),c=chatWithQueue(page.__dsh.S,'existing-chat',false);page.els.get('input').value='未发送的现有草稿';
  let choices=0;page.DSHFolderPicker={choose:async()=>{choices++;return null;}};
  page.els.get('fab').onclick();assert.match(page.els.get('sheet').innerHTML,/浏览电脑文件夹/);
  page.els.get('sheet').onclick({target:{closest:selector=>selector==='[data-browse-folder]'?{}:null}});await new Promise(resolve=>setTimeout(resolve,10));
  assert.equal(choices,1);assert.equal(page.__dsh.S.cur,c.id);assert.equal(page.els.get('input').value,'未发送的现有草稿');assert.equal(page.rpcCalls.length,0);
});

test('confirmed computer workspace enters the original session-create flow once without sending a prompt', async () => {
  const page=bootApp({rpcResult:call=>({ok:true,value:call.method==='session.create'?{sessionId:'new-folder-chat'}:{accepted:true}})}),state=page.__dsh.S;
  chatWithQueue(state,'previous-chat',false);page.els.get('input').value='原对话草稿';
  page.DSHFolderPicker={choose:async()=>({id:'folder-workspace',workspaceId:'folder-workspace',title:'资料',path:'D:\\资料'})};
  page.els.get('fab').onclick();const browse={};page.els.get('sheet').onclick({target:{closest:selector=>selector==='[data-browse-folder]'?browse:null}});
  await new Promise(resolve=>setTimeout(resolve,5));assert.equal(page.rpcCalls.length,0,'creation waits for confirmed picker and sheet close');
  page.dispatchWindow('popstate',{state:{v:'home',od:0}});await new Promise(resolve=>setTimeout(resolve,10));
  const creates=page.rpcCalls.filter(call=>call.method==='session.create');assert.equal(creates.length,1);assert.equal(creates[0].payload.workspaceId,'folder-workspace');
  assert.equal(state.cur,'new-folder-chat');assert.equal(state.drafts['previous-chat'],'原对话草稿');assert.equal(page.rpcCalls.some(call=>call.method==='session.prompt'),false);
});

function voicePage({ intercept } = {}) {
  const calls = [], tracks = { getSettings: () => ({ echoCancellation: true }), stops: 0, stop() { this.stops++ } }, nodes = []
  const page = bootApp({ voiceRequest: async (url, options) => {
    calls.push({ url, options })
    if (intercept) { const response = intercept(url, options); if (response) return response }
    const value = url.startsWith('/m/api/voice') ? { ok: true, value: url.includes('?') ? { items: [] } : JSON.parse(options.body) } : url.includes('vadOnly=1') ? { isSpeech: true } : url === '/api/commands/list' ? { result: { ok: true, value: [] } } : url.includes('/asr?') ? { text: '这是录音转成的文字。' } : { active: 'voice-test' }
    return { ok: true, json: async () => value }
  } })
  page.navigator.mediaDevices = { getUserMedia: async () => ({ getTracks: () => [tracks] }) }
  page.AudioContext = class {
    sampleRate = 48000
    destination = {}
    resume() { return Promise.resolve() }
    close() { return Promise.resolve() }
    createMediaStreamSource() { return { connect() {}, disconnect() {} } }
    createScriptProcessor() { const node = { connect() {}, disconnect() {}, onaudioprocess: null }; nodes.push(node); return node }
    createGain() { return { gain: { value: 1 }, connect() {} } }
    decodeAudioData() { return Promise.resolve({ duration: 1, sampleRate: 16000, getChannelData: () => new Float32Array(16000) }) }
    createBufferSource() { const n = { connect() {}, start() {}, stop() { if (n.onended) n.onended() } }; players.push(n); return n }
  }
  const players = [], events = {}
  page.atob = value => Buffer.from(value, 'base64').toString('binary')
  page.EventSource = class {
    close() {}
    addEventListener(type, fn) { events[type] = fn; if (type === 'mode') queueMicrotask(() => fn({ data: '{"active":null,"ownerTabId":null}' })) }
  }
  const { S } = page.window.__dsh
  const chat = chatWithQueue(S, 'voice-test', false)
  const start = mode => page.__dsh.startVoice(mode)
  return { page, S, chat, start, calls, tracks, nodes, players, emit(type, data) { events[type]?.({ data: JSON.stringify({ sessionId: 'voice-test', ...data }) }) } }
}

test('voice message stores original PCM WAV before sending and never fills composer', async () => {
  const v = voicePage(); v.start('chat'); await new Promise(r => setTimeout(r, 10))
  v.nodes[0].onaudioprocess({ inputBuffer: { getChannelData: () => new Float32Array(4096).fill(0.25) } })
  v.page.els.get('voiceFinish').onclick(); await new Promise(r => setTimeout(r, 15))
  const post = v.calls.find(c => c.url === '/m/api/voice')
  assert.ok(post)
  const item = JSON.parse(post.options.body), audio = Buffer.from(item.audio, 'base64')
  assert.equal(audio.subarray(0, 4).toString(), 'RIFF')
  assert.equal(audio.readInt16LE(44), 8191, 'the recorded voice, not synthesized transcript')
  assert.equal(item.role, 'user'); assert.equal(item.mime, 'audio/wav')
  assert.equal(v.page.rpcCalls.find(c => c.method === 'session.prompt').rpcId, item.requestId)
  assert.equal(v.page.els.get('input').value, '')
  assert.equal(v.page.els.has('voiceHistory'), false, 'no separate voice history entry')
  v.page.els.get('voiceEnd').onclick()
})

test('failed voice persistence keeps original audio and explicit retry reuses id before one prompt', async () => {
  let failures = 1
  const v = voicePage({ intercept: (url) => url === '/m/api/voice' && failures-- > 0 ? Promise.reject(new Error('offline')) : null })
  v.start('chat'); await new Promise(r => setTimeout(r, 10))
  v.nodes[0].onaudioprocess({ inputBuffer: { getChannelData: () => new Float32Array(4096).fill(0.2) } })
  v.page.els.get('voiceFinish').onclick(); await new Promise(r => setTimeout(r, 10))
  assert.equal(v.page.rpcCalls.filter(c => c.method === 'session.prompt').length, 0)
  assert.equal(v.page.els.get('voiceFinish').textContent, '重试发送')
  v.page.els.get('voiceFinish').onclick(); await new Promise(r => setTimeout(r, 10))
  const posts = v.calls.filter(c => c.url === '/m/api/voice').map(c => c.options.body)
  assert.equal(posts.length, 2); assert.equal(posts[0], posts[1])
  assert.equal(v.page.rpcCalls.filter(c => c.method === 'session.prompt').length, 1)
  v.page.els.get('voiceEnd').onclick()
})

test('assistant audio is persisted with reply linkage and transcript', async () => {
  const v = voicePage(); v.start('chat'); await new Promise(r => setTimeout(r, 10))
  v.page.els.get('voiceFinish').onclick(); await new Promise(r => setTimeout(r, 10))
  v.emit('audio', { audio: 'YQ==', sentenceId: 1 })
  v.emit('audio', { text: '这是语音回复', final: true, sentenceId: 1 })
  await new Promise(r => setTimeout(r, 10))
  const items = v.calls.filter(c => c.url === '/m/api/voice').map(c => JSON.parse(c.options.body))
  assert.equal(items.length, 2); assert.equal(items[1].role, 'assistant')
  assert.equal(items[1].replyTo, items[0].id); assert.equal(items[1].text, '这是语音回复')
  assert.equal(items[1].audio, 'YQ==', 'preserve encoded reply byte for byte without AudioContext conversion')
  v.page.els.get('voiceEnd').onclick()
})

test('failed encoded reply survives hangup and next-turn reset until explicit save retry', async () => {
  for (const action of ['voiceEnd', 'voiceFinish']) {
    let fail = true
    const v = voicePage({ intercept: (url, options) => {
      if (url === '/m/api/voice' && JSON.parse(options.body).role === 'assistant' && fail) return Promise.reject(new Error('offline'))
    } })
    v.start('chat'); await new Promise(r => setTimeout(r, 10))
    v.page.els.get('voiceFinish').onclick(); await new Promise(r => setTimeout(r, 10))
    v.emit('audio', { audio: 'SUQzZmFrZW1wMw==', mime: 'audio/mpeg', sentenceId: 1 })
    v.emit('audio', { text: '未保存的回复', mime: 'audio/mpeg', final: true, sentenceId: 1 })
    await new Promise(r => setTimeout(r, 10))
    assert.equal(v.page.els.get('voiceRetryReplies').hidden, false)
    v.page.els.get(action).onclick(); await new Promise(r => setTimeout(r, 10))
    let posts = v.calls.filter(c => c.url === '/m/api/voice' && JSON.parse(c.options.body).role === 'assistant')
    assert.equal(posts.length, 1, 'no implicit retry on reset or hangup')
    fail = false; v.page.els.get('voiceRetryReplies').onclick(); await new Promise(r => setTimeout(r, 10))
    posts = v.calls.filter(c => c.url === '/m/api/voice' && JSON.parse(c.options.body).role === 'assistant')
    assert.equal(posts.length, 2); assert.equal(posts[0].options.body, posts[1].options.body)
    assert.equal(JSON.parse(posts[1].options.body).mime, 'audio/mpeg')
    assert.equal(v.page.els.get('voiceRetryReplies').hidden, true)
    if (action === 'voiceFinish') v.page.els.get('voiceEnd').onclick()
  }
})

test('inline voice links identical text by request id and replyTo, including unknown orphan', async () => {
  const items = [
    { id: 'u1', role: 'user', requestId: 'rid1', text: '相同问题', durationMs: 1000 },
    { id: 'a1', role: 'assistant', requestId: 'rid1', replyTo: 'u1', text: '相同回答', segmentIds: ['s1', 's2'], durationMs: 2000 },
    { id: 'u2', role: 'user', requestId: 'rid2', text: '相同问题', durationMs: 1000 },
    { id: 'a2', role: 'assistant', requestId: 'rid2', replyTo: 'u2', text: '相同回答', segmentIds: ['s3'], durationMs: 0 },
    { id: 'unknown', role: 'user', requestId: 'unknown-rid', text: '未确认录音', durationMs: 0 }
  ]
  const v = voicePage({ intercept: url => url.startsWith('/m/api/voice?') ? Promise.resolve({ ok: true, json: async () => ({ ok: true, value: { items } }) }) : null })
  v.chat.voiceUnknown = new Set(['unknown-rid'])
  v.chat.items = [{ k: 'u', seq: 1, rid: 'rid1', text: '相同问题' }, { k: 'a', seq: 2, text: '相同回答' }, { k: 'end', seq: 3, reason: 'completed' }, { k: 'u', seq: 4, rid: 'rid2', text: '相同问题' }, { k: 'a', seq: 5, text: '相同回答' }, { k: 'end', seq: 6, reason: 'completed' }]
  await v.page.__dsh.loadVoiceHistory('voice-test')
  const html = v.page.els.get('msgs').innerHTML
  const firstTurn = html.slice(html.indexOf('data-message-seq="2"'), html.indexOf('data-message-seq="5"')), secondTurn = html.slice(html.indexOf('data-message-seq="5"'))
  assert.match(firstTurn, /data-voice-id="a1"/); assert.doesNotMatch(firstTurn, /data-voice-id="a2"/)
  assert.match(secondTurn, /data-voice-id="a2"/); assert.doesNotMatch(secondTurn, /data-voice-id="a1"/)
  assert.equal((html.match(/相同问题/g) || []).length, 2)
  assert.equal((html.match(/相同回答/g) || []).length, 2)
  assert.equal((html.match(/data-voice-id="a1"/g) || []).length, 1)
  assert.match(html, /group=1/); assert.match(html, /发送状态未确认/)
  assert.doesNotMatch(html, /voice-unmatched/)
})

test('inline voice refresh defers repaint during playback and retains paused audio node', async () => {
  let items = [{ id: 'u1', role: 'user', requestId: 'r1', text: '录音', durationMs: 0 }]
  const v = voicePage({ intercept: url => url.startsWith('/m/api/voice?') ? Promise.resolve({ ok: true, json: async () => ({ ok: true, value: { items } }) }) : null })
  v.chat.items = [{ k: 'u', seq: 1, rid: 'r1', text: '录音' }]
  await v.page.__dsh.loadVoiceHistory('voice-test')
  const msgs = v.page.els.get('msgs'), initial = msgs.innerHTML
  const audio = { dataset: { session: 'voice-test', voiceId: 'u1', voiceRevision: '' }, paused: false, ended: false, currentTime: 0.5 }
  msgs.querySelectorAll = selector => selector === 'audio[data-voice-id]' ? [audio] : []
  items = items.concat({ id: 'u2', role: 'user', requestId: 'r2', text: '新录音', durationMs: 0 })
  await v.page.__dsh.loadVoiceHistory('voice-test')
  assert.equal(msgs.innerHTML, initial, 'playing audio never detached')
  assert.equal(v.chat.voiceRepaint, true)
  let kept
  audio.paused = true
  audio.parentNode = { replaceChild(previous) { kept = previous } }
  v.page.__dsh.renderMsgs(v.chat)
  assert.equal(kept, audio); assert.equal(audio.currentTime, 0.5)
  assert.match(msgs.innerHTML, /新录音/)
})

test('older-page voice records stay at the top pagination entry without any bottom players', async () => {
  const v = voicePage()
  v.chat.hasMore = true
  v.chat.items = [{ k: 'u', rid: 'recent', seq: 1, text: '现在的问题' }, { k: 'a', seq: 2, text: '现在的回答' }, { k: 'end', seq: 3, reason: 'completed' }]
  v.chat.voiceItems = [{ id: 'old-user', role: 'user', requestId: 'older-page', text: '较早的真实对话' }, { id: 'old-reply', role: 'assistant', requestId: 'older-page', replyTo: 'old-user', text: '较早回复' }]
  const original = JSON.stringify(v.chat.items.map(({ k, seq, rid, text, reason }) => ({ k, seq, rid, text, reason })))
  v.page.__dsh.renderMsgs(v.chat)
  const msgs = v.page.els.get('msgs'), html = msgs.innerHTML
  assert.doesNotMatch(html, /data-voice-id="old-user"/)
  assert.match(v.page.els.get('older').innerHTML, /2 条语音记录/)
  assert.match(v.page.els.get('older').innerHTML, /data-older/)
  assert.doesNotMatch(html, /发送状态未确认/)
  assert.equal(JSON.stringify(v.chat.items.map(({ k, seq, rid, text, reason }) => ({ k, seq, rid, text, reason }))), original)
  v.chat.hasMore = false
  v.page.__dsh.renderMsgs(v.chat)
  assert.match(msgs.innerHTML, /^<details class="voice-unmatched" data-voice-unmatched>/)
  assert.match(msgs.innerHTML, /较早的真实对话/)
})

test('seven old recordings migrate into their original turns across two history pages', () => {
  const v = voicePage(), turns = index => [{ k: 'u', rid: 'rid-' + index, seq: index * 3, text: '问题' + index }, { k: 'a', seq: index * 3 + 1, text: '回复' + index }, { k: 'end', seq: index * 3 + 2, reason: 'completed' }]
  v.chat.voiceItems = Array.from({ length: 4 }, (_, n) => ({ id: 'u-' + n, role: 'user', requestId: 'rid-' + n, text: '问题' + n })).concat(Array.from({ length: 3 }, (_, n) => ({ id: 'a-' + n, role: 'assistant', requestId: 'rid-' + n, replyTo: 'u-' + n, text: '回复' + n })))
  v.chat.hasMore = true; v.chat.items = turns(9)
  v.page.__dsh.renderMsgs(v.chat)
  assert.match(v.page.els.get('older').innerHTML, /7 条语音记录/)
  assert.doesNotMatch(v.page.els.get('msgs').innerHTML, /data-voice-id=/)
  v.chat.items = turns(3).concat(turns(9)); v.page.__dsh.renderMsgs(v.chat)
  assert.match(v.page.els.get('older').innerHTML, /6 条语音记录/)
  assert.equal((v.page.els.get('msgs').innerHTML.match(/data-voice-id=/g) || []).length, 1)
  v.chat.hasMore = false; v.chat.items = [0, 1, 2, 3, 9].flatMap(turns); v.page.__dsh.renderMsgs(v.chat)
  assert.equal((v.page.els.get('msgs').innerHTML.match(/data-voice-id=/g) || []).length, 7)
  assert.doesNotMatch(v.page.els.get('msgs').innerHTML, /voice-unmatched/)
  assert.equal(v.page.els.get('older').innerHTML, '')
})

test('running reply audio stays beside its matched user before a final text item arrives', () => {
  const v = voicePage()
  v.chat.hasMore = true; v.S.run.add(v.chat.id)
  v.chat.items = [{ k: 'u', seq: 4, rid: 'live-rid', text: '正在问' }]
  v.chat.voiceItems = [{ id: 'live-u', role: 'user', requestId: 'live-rid', text: '正在问' }, { id: 'live-a', role: 'assistant', requestId: 'live-rid', replyTo: 'live-u', text: '回答正在生成' }]
  v.page.__dsh.renderMsgs(v.chat)
  assert.match(v.page.els.get('msgs').innerHTML, /data-voice-id="live-a"/)
  assert.match(v.page.els.get('msgs').innerHTML, /回复文字正在同步/)
  assert.doesNotMatch(v.page.els.get('older').innerHTML, /语音记录/)
})

test('recent explicitly unsent audio remains visible even when older history is unloaded', () => {
  const v = voicePage(); v.chat.hasMore = true
  v.chat.voiceUnknown = new Set(['unknown-rid']); v.chat.voiceNotSent = new Set(['muted-rid'])
  v.chat.voiceItems = [{ id: 'unknown', role: 'user', requestId: 'unknown-rid', text: '刚才发送待核对' }, { id: 'muted', role: 'user', requestId: 'muted-rid', text: '刚才静音取消' }, { id: 'old', role: 'user', requestId: 'old-rid', text: '更早录音' }]
  v.page.__dsh.renderMsgs(v.chat)
  const html = v.page.els.get('msgs').innerHTML
  assert.match(html, /data-voice-id="unknown"/); assert.match(html, /data-voice-id="muted"/)
  assert.doesNotMatch(html, /data-voice-id="old"/)
  assert.match(v.page.els.get('older').innerHTML, /1 条语音记录/)
  assert.match(html, /发送状态未确认/); assert.match(html, /因静音未发送/)
})

test('overlapping history page boundaries do not duplicate native users or voice bubbles', async () => {
  const v = voicePage()
  const user = { k: 'u', seq: 3, rid: 'r3', text: '页边界问题' }
  v.chat.items = [user, { k: 'a', seq: 4, text: '页边界回复' }, { k: 'end', seq: 5, reason: 'completed' }]
  v.chat.firstSeq = 3; v.chat.hasMore = true
  v.chat.voiceItems = [{ id: 'u3', role: 'user', requestId: 'r3', text: '页边界问题' }]
  const original = v.page.fetch
  v.page.fetch = (url, options) => String(url).startsWith('/m/api/history?') ? Promise.resolve({ ok: true, status: 200, json: async () => ({ ok: true, value: { items: [{ k: 'a', seq: 1, text: '较早回复' }, { k: 'end', seq: 2, reason: 'completed' }, user], firstSeq: 1, hasMore: false } }) }) : original(url, options)
  v.page.els.get('scroller').dispatch('click', { target: { closest: selector => selector === '[data-older]' ? {} : null } })
  await new Promise(r => setTimeout(r, 10))
  assert.equal(v.chat.items.filter(item => item.seq === 3).length, 1)
  assert.equal((v.page.els.get('msgs').innerHTML.match(/data-voice-id="u3"/g) || []).length, 1)
})

test('speaker preview exposes server failure beside the player and never selects the voice', async () => {
  const v = voicePage({ intercept: (url) => url === '/voice-mode/speakers' ? Promise.resolve({ ok: true, json: async () => ({ current: 'suyingxue', rate: 1, items: [{ id: 'kokoro:48', name: '女声084', gender: 'F', ready: true }] }) }) : url === '/voice-mode/preview' ? Promise.resolve({ ok: false, json: async () => ({ error: '音色加载失败' }) }) : null })
  v.page.els.get('mic').onclick()
  v.page.els.get('sheet').onclick({ target: { closest: selector => selector === '[data-speaker-settings]' ? {} : null } })
  await new Promise(r => setTimeout(r, 10))
  v.page.els.get('sheet').onclick({ target: { closest: selector => selector === '[data-speaker-preview]' ? { dataset: { speakerPreview: 'kokoro:48' } } : null } })
  await new Promise(r => setTimeout(r, 10))
  assert.match(v.page.els.get('speakerPreview').children[0].children[0].textContent, /试听失败：音色加载失败/)
  assert.equal(v.calls.filter(c => c.url === '/voice-mode/speakers' && c.options.method === 'POST').length, 0)
})

test('slow speaker preview shows preparation beside the clicked row and aborts when hidden', async () => {
  let finishPreview, previewSignal
  const v = voicePage({ intercept: (url, options) => url === '/voice-mode/speakers' ? Promise.resolve({ ok: true, json: async () => ({ current: 'suyingxue', rate: 1, items: [{ id: 'kokoro:48', name: '女声084', gender: 'F', ready: true }] }) }) : url === '/voice-mode/preview' ? (previewSignal = options.signal, new Promise(resolve => { finishPreview = resolve })) : null })
  v.page.els.get('mic').onclick()
  v.page.els.get('sheet').onclick({ target: { closest: selector => selector === '[data-speaker-settings]' ? {} : null } })
  await new Promise(r => setTimeout(r, 10))
  const row = makeEl('div'), button = { dataset: { speakerPreview: 'kokoro:48' }, closest: selector => selector === '.speaker-row' ? row : null }
  v.page.els.get('sheet').onclick({ target: { closest: selector => selector === '[data-speaker-preview]' ? button : null } })
  assert.equal(row.children.length, 1, 'feedback goes next to tapped voice, not below all 13 choices')
  assert.match(row.children[0].children[0].textContent, /正在合成试听/)
  assert.equal(button.disabled, true)
  assert.equal(row.children[0].children[1].hidden, true)
  v.page.document.visibilityState = 'hidden'; v.page.dispatchDocument('visibilitychange')
  assert.equal(previewSignal.aborted, true); assert.equal(button.disabled, false)
  finishPreview({ ok: true, blob: async () => ({}) }); await new Promise(r => setTimeout(r, 10))
  assert.equal(row.children[0].children[1].hidden, true, 'late response cannot start audio')
})

test('call interruption confirms speech and preserves the first samples through cancellation', async () => {
  const v = voicePage(); v.start('call'); await new Promise(r => setTimeout(r, 10))
  v.page.els.get('voiceFinish').onclick(); await new Promise(r => setTimeout(r, 10))
  const feed = () => v.nodes[0].onaudioprocess({ inputBuffer: { getChannelData: () => new Float32Array(4096).fill(0.3) } })
  for (let n = 0; n < 2; n++) { feed(); await new Promise(r => setTimeout(r, 5)) }
  assert.equal(v.calls.filter(c => c.url === '/voice-mode/cancel').length, 0)
  feed(); await new Promise(r => setTimeout(r, 10))
  assert.equal(v.calls.filter(c => c.url === '/voice-mode/cancel').length, 1)
  v.page.els.get('voiceFinish').onclick(); await new Promise(r => setTimeout(r, 10))
  const wavs = v.calls.filter(c => c.url === '/m/api/voice').map(c => JSON.parse(c.options.body))
  assert.ok(Buffer.from(wavs[1].audio, 'base64').readInt16LE(44) > 9000)
  assert.equal(v.page.els.get('callPanel').hidden, false)
  v.page.els.get('callHangup').onclick(); assert.equal(v.tracks.stops, 1)
  assert.equal(v.page.els.get('callPanel').hidden, true)
})

test('hangup reconciles native history when terminal stream frames were missed', async () => {
  const v = voicePage(); v.start('call'); await new Promise(r => setTimeout(r, 10))
  v.page.els.get('voiceFinish').onclick(); await new Promise(r => setTimeout(r, 10))
  const requestId = JSON.parse(v.calls.find(c => c.url === '/m/api/voice').options.body).requestId
  const original = v.page.fetch; let reads = 0
  v.page.fetch = (url, options) => String(url).startsWith('/m/api/history?') ? (++reads, Promise.resolve({ ok: true, status: 200, json: async () => ({ ok: true, value: { items: [{ k: 'u', seq: 1, rid: requestId, text: '通话问题' }, { k: 'a', seq: 2, text: '已结束的通话回复' }, { k: 'end', seq: 3, reason: 'completed' }], partial: null, lastSeq: 3, firstSeq: 1, hasMore: false, run: false } }) })) : original(url, options)
  assert.equal(v.S.run.has('voice-test'), true, 'client still thinks the sent turn is running')
  v.page.els.get('callHangup').onclick(); await new Promise(r => setTimeout(r, 20))
  assert.equal(reads, 1, 'hangup must reconcile the durable transcript')
  assert.equal(v.S.run.has('voice-test'), false)
  assert.match(v.page.els.get('msgs').innerHTML, /已结束的通话回复/)
  assert.equal(v.chat.pending.length, 0, 'durable request rid removes stale pending bubble')
  assert.equal(v.page.rpcCalls.filter(c => c.method === 'session.prompt').length, 1)
})

test('call metadata groups its turns into one transcript locator without repeating text', async () => {
  const v = voicePage(); let serial = 1
  v.page.crypto.randomUUID = () => '00000000-0000-4000-8000-' + String(serial++).padStart(12, '0')
  v.start('call'); await new Promise(r => setTimeout(r, 10))
  v.page.els.get('voiceFinish').onclick(); await new Promise(r => setTimeout(r, 10))
  v.page.els.get('voiceFinish').onclick(); await new Promise(r => setTimeout(r, 10))
  v.page.els.get('voiceFinish').onclick(); await new Promise(r => setTimeout(r, 10))
  const turns = v.calls.filter(c => c.url === '/m/api/voice').map(c => JSON.parse(c.options.body))
  assert.equal(turns.length, 2); assert.equal(turns[0].mode, 'call')
  assert.equal(turns[0].callId, turns[1].callId); assert.equal(turns[0].callStartedAt, turns[1].callStartedAt)
  v.chat.voiceItems = turns
  v.chat.items = turns.flatMap((item, index) => [{ k: 'u', seq: index * 3, rid: item.requestId, text: '通话问题' + index }, { k: 'a', seq: index * 3 + 1, text: '通话回复' + index }, { k: 'end', seq: index * 3 + 2, reason: 'completed' }])
  v.chat.pending = []; v.S.run.delete('voice-test')
  v.page.__dsh.renderMsgs(v.chat)
  const html = v.page.els.get('msgs').innerHTML
  assert.equal((html.match(/data-call-locate=/g) || []).length, 1)
  assert.match(html, /2轮对话/); assert.equal((html.match(/通话问题0/g) || []).length, 1)
  v.page.els.get('callHangup').onclick()
})

test('unconfirmed AEC retains the longer echo tail before automatic continuation', async () => {
  const v = voicePage(); v.tracks.getSettings = () => ({ echoCancellation: false })
  v.start('call'); await new Promise(r => setTimeout(r, 10))
  v.page.els.get('voiceFinish').onclick(); await new Promise(r => setTimeout(r, 10))
  v.emit('turn', { state: 'agent-speaking' }); v.emit('turn', { state: 'listening' })
  v.page.__dsh.onFrame({ t: 'run', s: 'voice-test', on: false })
  v.page.fireTimeouts(250); await new Promise(r => setTimeout(r, 5))
  assert.equal(v.calls.filter(c => c.url === '/voice-mode/cancel').length, 0)
  v.page.fireTimeouts(600); await new Promise(r => setTimeout(r, 10))
  assert.equal(v.calls.filter(c => c.url === '/voice-mode/cancel').length, 1)
  v.page.els.get('callHangup').onclick()
})

test('mute and hangup reject late VAD and never submit a new turn', async () => {
  for (const action of ['callMute', 'callHangup']) {
    let resolveDetect
    const v = voicePage({ intercept: url => url.includes('vadOnly=1') ? new Promise(resolve => { resolveDetect = resolve }) : null })
    v.start('call'); await new Promise(r => setTimeout(r, 10))
    v.page.els.get('voiceFinish').onclick(); await new Promise(r => setTimeout(r, 10))
    v.nodes[0].onaudioprocess({ inputBuffer: { getChannelData: () => new Float32Array(4096).fill(0.3) } })
    v.page.els.get(action).onclick()
    resolveDetect({ ok: true, json: async () => ({ isSpeech: true }) }); await new Promise(r => setTimeout(r, 10))
    assert.equal(v.calls.filter(c => c.url === '/voice-mode/cancel').length, 0)
    assert.equal(v.page.rpcCalls.filter(c => c.method === 'session.prompt').length, 1)
    if (action === 'callMute') { assert.equal(v.tracks.enabled, false); v.page.els.get('callHangup').onclick() }
  }
})

test('speaker settings reads choices without changing voice until an explicit selection', async () => {
  const v = voicePage({ intercept: (url, options) => url === '/voice-mode/speakers' ? Promise.resolve({ ok: true, json: async () => options.method === 'POST' ? { ok: true, voice: 'gunian', rate: 1 } : { engine: 'vits', current: 'suyingxue', rate: 1, items: [{ id: 'suyingxue', name: '素映雪', gender: 'F', ready: true, latencyHint: '响应较快' }, { id: 'kokoro:48', name: '中文女声084', gender: 'F', ready: true, latencyHint: '合成较慢，适合语音消息' }, { id: 'gunian', name: '顾念', gender: 'M', ready: true }] } }) : null })
  v.page.els.get('mic').onclick()
  assert.equal((v.page.els.get('sheet').innerHTML.match(/data-voice=/g) || []).length, 3)
  v.page.els.get('sheet').onclick({ target: { closest: selector => selector === '[data-speaker-settings]' ? {} : null } })
  await new Promise(r => setTimeout(r, 10))
  assert.match(v.page.els.get('sheet').innerHTML, /素映雪/)
  assert.match(v.page.els.get('sheet').innerHTML, /speaker-options/)
  assert.match(v.page.els.get('sheet').innerHTML, /合成较慢，适合语音消息/)
  assert.match(v.page.els.get('sheet').innerHTML, /响应较快/)
  assert.equal(v.calls.filter(c => c.url === '/voice-mode/speakers' && c.options.method === 'POST').length, 0)
  v.page.els.get('sheet').onclick({ target: { closest: selector => selector === '[data-speaker]' ? { dataset: { speaker: 'gunian' } } : null } })
  await new Promise(r => setTimeout(r, 10))
  assert.deepEqual(JSON.parse(v.calls.find(c => c.url === '/voice-mode/speakers' && c.options.method === 'POST').options.body), { voice: 'gunian' })
})

test('three modes separate manual messages from silence-triggered live calls', async () => {
  for (const mode of ['draft', 'chat', 'call']) {
    const v = voicePage(); v.start(mode); await new Promise(r => setTimeout(r, 10))
    const toggle = v.calls.find(c => c.url === '/voice-mode/toggle' && JSON.parse(c.options.body).on)
    assert.equal(JSON.parse(toggle.options.body).mode, mode === 'chat' ? 'message' : mode)
    const feed = level => v.nodes[0].onaudioprocess({ inputBuffer: { getChannelData: () => new Float32Array(4096).fill(level) } })
    feed(0.1)
    for (let i = 0; i < 20; i++) feed(0)
    await new Promise(r => setTimeout(r, 10))
    assert.equal(v.page.rpcCalls.filter(c => c.method === 'session.prompt').length, mode === 'call' ? 1 : 0, mode)
    v.page.els.get('voiceEnd').onclick()
  }
})

function holdUi(v, mode) {
  v.page.els.get('mic').onclick()
  v.page.els.get('sheet').onclick({ target: { closest: selector => selector === '[data-voice]' ? { dataset: { voice: mode } } : null } })
  const button = v.page.els.get('holdTalk'), event = { pointerId: 7, button: 0, clientY: 200, preventDefault() {} }
  return { button, down() { button.onpointerdown(event) }, up() { button.onpointerup(event) }, cancel() { button.onpointercancel(event) }, move(y) { button.onpointermove({ ...event, clientY: y }) }, feed(n = 8) { for (let i = 0; i < n; i++) v.nodes.at(-1).onaudioprocess?.({ inputBuffer: { getChannelData: () => new Float32Array(4096).fill(0.1) } }) } }
}

test('voice message menu does not record until pressed; release sends one original voice', async () => {
  for (const mode of ['chat']) {
    const v = voicePage(), hold = holdUi(v, mode)
    assert.equal(v.nodes.length, 0)
    assert.equal(v.page.els.get('mic').hidden, true)
    assert.equal(hold.button.textContent, '按住说话')
    hold.down(); await new Promise(r => setTimeout(r, 10)); hold.feed(); hold.up(); hold.up()
    await new Promise(r => setTimeout(r, 15))
    assert.equal(v.page.rpcCalls.filter(c => c.method === 'session.prompt').length, mode === 'chat' ? 1 : 0)
    assert.equal(v.tracks.stops, 1)
    assert.equal(v.page.els.get('mic').classList.contains('recording'), false, 'released capture must not still advertise recording')
    assert.doesNotMatch(v.page.els.get('voiceState').textContent, /点“继续说”|说完发送/)
    if (mode === 'draft') { assert.equal(v.page.els.get('input').hidden, false); assert.match(v.page.els.get('input').value, /录音转成/); assert.equal(hold.button.hidden, true) }
    else { const item = JSON.parse(v.calls.find(c => c.url === '/m/api/voice').options.body); assert.ok(Buffer.from(item.audio, 'base64').length > 44); v.page.dshStopVoice() }
  }
})

test('voice message swipe, pointercancel, lost capture and background cancel without sending', async () => {
  for (const action of ['swipe', 'cancel', 'lost', 'background']) {
    const v = voicePage();
    const hold = holdUi(v, 'chat'); hold.down(); await new Promise(r => setTimeout(r, 10)); hold.feed(14)
    await new Promise(r => setTimeout(r, 5))
    if (action === 'swipe') { hold.move(100); assert.equal(hold.button.textContent, '松开取消'); hold.up() }
    if (action === 'cancel') hold.cancel()
    if (action === 'lost') hold.button.onlostpointercapture({ pointerId: 7 })
    if (action === 'background') { v.page.document.visibilityState = 'hidden'; v.page.dispatchDocument('visibilitychange') }
    await new Promise(r => setTimeout(r, 10))
    assert.equal(v.page.els.get('input').value, '', action)
    assert.equal(v.page.rpcCalls.filter(call => call.method !== 'commands/list').length, 0, action)
    assert.equal(v.calls.filter(c => c.url.includes('final=1')).length, 0, action)
    assert.equal(v.tracks.stops, 1, action)
  }
})

test('release before microphone permission and short press discard audio; late permission is released', async () => {
  const v = voicePage(); let grant
  v.page.navigator.mediaDevices.getUserMedia = () => new Promise(resolve => { grant = resolve })
  const hold = holdUi(v, 'chat'); hold.down(); await new Promise(r => setTimeout(r, 5)); hold.up()
  grant({ getTracks: () => [v.tracks] }); await new Promise(r => setTimeout(r, 10))
  assert.equal(v.tracks.stops, 1); assert.equal(v.page.rpcCalls.filter(call => call.method !== 'commands/list').length, 0)
  const short = voicePage(), shortHold = holdUi(short, 'chat'); shortHold.down(); await new Promise(r => setTimeout(r, 10)); shortHold.feed(2); shortHold.up()
  await new Promise(r => setTimeout(r, 10)); assert.equal(short.page.rpcCalls.filter(call => call.method !== 'commands/list').length, 0); assert.equal(short.calls.some(c => c.url === '/m/api/voice'), false)
})

test('hold recording limit finishes once and later pointerup cannot submit twice', async () => {
  const v = voicePage(), hold = holdUi(v, 'chat'); hold.down(); await new Promise(r => setTimeout(r, 10))
  for (let n = 0; n < 650 && v.nodes[0].onaudioprocess; n++) hold.feed(1)
  hold.up(); await new Promise(r => setTimeout(r, 40))
  assert.equal(v.calls.filter(c => c.url.includes('final=1')).length, 1)
  assert.equal(v.page.rpcCalls.filter(c => c.method === 'session.prompt').length, 1)
  v.page.dshStopVoice()
})

test('hold voice message waits for reply completion, then accepts another held message', async () => {
  const v = voicePage(), hold = holdUi(v, 'chat'); hold.down(); await new Promise(r => setTimeout(r, 10)); hold.feed(); hold.up()
  await new Promise(r => setTimeout(r, 10)); assert.equal(hold.button.disabled, true)
  v.emit('turn', { state: 'agent-speaking' }); v.page.__dsh.onFrame({ t: 'run', s: v.chat.id, on: false })
  assert.equal(hold.button.disabled, true, 'model end alone cannot cut off pending speech')
  v.emit('turn', { state: 'listening' }); v.emit('tts-state', { busy: false })
  assert.equal(hold.button.disabled, false)
  hold.down(); await new Promise(r => setTimeout(r, 10)); hold.feed(); hold.up(); await new Promise(r => setTimeout(r, 10))
  assert.equal(v.page.rpcCalls.filter(c => c.method === 'session.prompt').length, 2)
  v.page.els.get('voiceKeyboard').onclick()
  assert.equal(v.page.els.get('input').hidden, false); assert.equal(v.page.els.get('mic').hidden, false)
})

test('voice bubble keeps encoded media hidden behind a waveform button and expandable text', () => {
  const v = voicePage()
  v.chat.items = [{ k: 'u', seq: 1, rid: 'r1', text: '我的转写' }, { k: 'a', seq: 2, text: '回复转写' }, { k: 'end', seq: 3, reason: 'completed' }]
  v.chat.voiceItems = [{ id: 'u1', role: 'user', requestId: 'r1', text: '我的转写', durationMs: 2400 }, { id: 'a1', role: 'assistant', requestId: 'r1', replyTo: 'u1', text: '回复转写', durationMs: 3600 }]
  v.page.__dsh.renderMsgs(v.chat)
  const html = v.page.els.get('msgs').innerHTML
  assert.equal((html.match(/<audio hidden/g) || []).length, 2)
  assert.doesNotMatch(html, /<audio[^>]* controls/)
  assert.equal((html.match(/data-voice-play=/g) || []).length, 2)
  assert.match(html, /data-voice-transcript="u1" hidden>/)
  assert.match(html, /data-voice-transcript="reply:u1" hidden>/)
})

test('custom voice play buttons play or pause only one message at a time', async () => {
  const v = voicePage(), audios = [], buttons = []
  for (let index = 0; index < 2; index++) {
    const button = makeEl('button'), icon = { textContent: '' }
    const audio = { paused: true, ended: false, play() { this.paused = false; return Promise.resolve() }, pause() { this.paused = true }, closest() { return box } }
    const box = { querySelector: selector => selector === 'audio[data-voice-id]' ? audio : selector === '[data-voice-play]' ? button : null }
    button.closest = () => box; button.querySelector = () => icon
    audios.push(audio); buttons.push(button)
  }
  v.page.els.get('msgs').querySelectorAll = selector => selector === 'audio[data-voice-id]' ? audios : []
  const tap = button => v.page.els.get('scroller').dispatch('click', { target: { closest: selector => selector === '[data-voice-play]' ? button : null } })
  tap(buttons[0]); await new Promise(r => setTimeout(r, 5)); assert.equal(audios[0].paused, false)
  tap(buttons[1]); await new Promise(r => setTimeout(r, 5)); assert.equal(audios[0].paused, true); assert.equal(audios[1].paused, false)
  tap(buttons[1]); assert.equal(audios[1].paused, true)
})

test('message reply hides its native final text until menu reveal even before TTS arrives', () => {
  const v = voicePage()
  v.chat.items = [{ k: 'u', seq: 1, rid: 'r1', text: '语音提问' }, { k: 'a', seq: 2, text: '完整回复不能提前铺满屏幕。' }, { k: 'end', seq: 3, reason: 'completed' }]
  v.chat.voiceItems = [{ id: 'u1', role: 'user', requestId: 'r1', mode: 'message', text: '语音提问' }]
  v.page.__dsh.renderMsgs(v.chat)
  let html = v.page.els.get('msgs').innerHTML
  assert.match(html, /正在生成语音/)
  assert.match(html, /data-voice-transcript="reply:u1" hidden><div class="md"><p>完整回复/)
  assert.doesNotMatch(html, /<summary>文字/)
  v.chat.voiceTextOpen = new Set(['reply:u1'])
  v.chat.voiceItems.push({ id: 'a1', role: 'assistant', requestId: 'r1', replyTo: 'u1', mode: 'message', text: '完整回复不能提前铺满屏幕。' })
  v.page.__dsh.renderMsgs(v.chat); html = v.page.els.get('msgs').innerHTML
  assert.doesNotMatch(html, /正在生成语音/)
  assert.match(html, /data-voice-transcript="reply:u1"><div/)
  v.chat.voiceItems = [v.chat.voiceItems[0]]; v.chat.voiceItems[0].mode = 'call'
  v.page.__dsh.renderMsgs(v.chat)
  assert.doesNotMatch(v.page.els.get('msgs').innerHTML, /正在生成语音/)
})

test('user voice uses its compact container while ordinary text keeps the original bubble', () => {
  const v = voicePage()
  v.chat.items = [{ k: 'u', seq: 1, rid: 'audio-request', text: '语音转写' }, { k: 'u', seq: 2, rid: 'text-request', text: '普通文字' }]
  v.chat.voiceItems = [{ id: 'audio', role: 'user', mode: 'message', requestId: 'audio-request', text: '语音转写', durationMs: 2200 }]
  v.page.__dsh.renderMsgs(v.chat)
  const html = v.page.els.get('msgs').innerHTML
  assert.match(html, /class="voice-user"><div class="voice-bubble"/)
  assert.doesNotMatch(html, /class="bub"><div class="voice-bubble"/)
  assert.match(html, /class="bub">普通文字<\/div>/)
})

function voiceMenuFixture() {
  const v = voicePage(), audios = [], buttons = [], texts = []
  for (let index = 0; index < 2; index++) {
    const id = 'voice-' + index, button = makeEl('button'), icon = { textContent: '' }
    button.dataset.voiceMenu = id; button.dataset.voicePlay = id; button.isConnected = true
    const audio = { dataset: { session: v.chat.id, voiceId: id, voiceRevision: '' }, paused: true, ended: false, isConnected: true, playCalls: 0,
      play() { this.playCalls++; this.paused = false; this.ended = false; this.onplay?.(); return Promise.resolve() },
      pause() { const wasPlaying = !this.paused; this.paused = true; if (wasPlaying) this.onpause?.() },
      closest(selector) { return selector === '.voice-bubble' ? box : null }, parentNode: { replaceChild() {} } }
    const box = { querySelector: selector => selector === 'audio[data-voice-id]' ? audio : selector === '[data-voice-play]' ? button : null }
    button.closest = selector => selector === '.voice-bubble' ? box : null; button.querySelector = () => icon
    audios.push(audio); buttons.push(button); texts.push({ dataset: { voiceTranscript: id }, hidden: true })
  }
  v.page.els.get('msgs').querySelectorAll = selector => selector === 'audio[data-voice-id]' ? audios : selector === '[data-voice-transcript]' ? texts : []
  v.page.__dsh.renderMsgs(v.chat)
  const target = button => ({ closest: selector => selector === '[data-voice-menu]' || selector === '[data-voice-play]' ? button : null })
  const pointer = (type, button = buttons[0], extra = {}) => v.page.els.get('scroller').dispatch(type, { target: target(button), pointerId: 1, clientX: 20, clientY: 40, button: 0, preventDefault() {}, ...extra })
  const menu = (button = buttons[0]) => pointer('contextmenu', button)
  const action = value => { v.page.els.get('sheet').onclick({ target: { closest: selector => selector === '[data-voice-action]' ? { dataset: { voiceAction: value } } : null } }); if (value !== 'device') v.page.dispatchWindow('popstate', { state: { v: 'chat', s: v.chat.id, od: 0 } }) }
  return { ...v, audios, buttons, texts, pointer, menu, action }
}

test('voice long press reveals menu, suppresses click, and text toggles without rebuilding players', () => {
  const v = voiceMenuFixture()
  v.pointer('pointerdown'); v.page.fireTimeouts(450)
  assert.match(v.page.els.get('sheet').innerHTML, /转文字/)
  v.pointer('click'); assert.equal(v.audios[0].playCalls, 0)
  v.action('text'); assert.equal(v.texts[0].hidden, false)
  v.menu(); assert.match(v.page.els.get('sheet').innerHTML, /隐藏文字/)
  v.action('text'); assert.equal(v.texts[0].hidden, true)
})

test('moving, scrolling, pointer cancel and early release cannot open a voice menu', () => {
  for (const cancel of ['pointermove', 'scroll', 'pointercancel', 'pointerup']) {
    const v = voiceMenuFixture(), before = v.page.els.get('sheet').innerHTML
    v.pointer('pointerdown'); v.pointer(cancel, v.buttons[0], { clientY: 80 }); v.page.fireTimeouts(450)
    assert.equal(v.page.els.get('sheet').innerHTML, before, cancel)
    assert.equal(v.audios[0].playCalls, 0)
  }
})

test('continuous playback snapshots loaded order and stops on scroll or playback error', async () => {
  for (const stop of ['none', 'scroll', 'error']) {
    const v = voiceMenuFixture(); v.menu(); v.action('queue')
    assert.equal(v.audios[0].playCalls, 1)
    const extra = { dataset: { session: v.chat.id }, paused: true, playCalls: 0, pause() {}, play() { this.playCalls++; return Promise.resolve() } }
    v.audios.push(extra)
    if (stop === 'scroll') v.pointer('scroll')
    if (stop === 'error') v.audios[0].onerror()
    v.audios[0].paused = true; v.audios[0].ended = true; v.audios[0].onended(); await new Promise(r => setTimeout(r, 5))
    assert.equal(v.audios[1].playCalls, stop === 'none' ? 1 : 0, stop)
    if (stop === 'none') { v.audios[1].paused = true; v.audios[1].ended = true; v.audios[1].onended() }
    assert.equal(extra.playCalls, 0, 'newly loaded media is not silently added')
  }
})

test('message POST confirmation renders immediately and an older in-flight GET cannot erase it', async () => {
  const reads = []; let saved
  const v = voicePage({ intercept: (url, options) => {
    if (url.startsWith('/m/api/voice?')) return new Promise(resolve => reads.push(resolve))
    if (url === '/m/api/voice') { saved = { ...JSON.parse(options.body), createdAt: '2026-10-13T00:00:00Z' }; return Promise.resolve({ ok: true, json: async () => ({ ok: true, value: saved }) }) }
  } })
  const oldGet = v.page.__dsh.loadVoiceHistory(v.chat.id)
  v.start('chat'); await new Promise(r => setTimeout(r, 10)); v.page.els.get('voiceFinish').onclick(); await new Promise(r => setTimeout(r, 10))
  assert.equal(v.chat.voiceItems.length, 1)
  assert.match(v.page.els.get('msgs').innerHTML, /data-voice-play=/)
  reads.shift()({ ok: true, json: async () => ({ ok: true, value: { items: [] } }) }); await oldGet; await new Promise(r => setTimeout(r, 5))
  assert.equal(v.chat.voiceItems.length, 1)
  reads.shift()({ ok: true, json: async () => ({ ok: true, value: { items: [saved] } }) })
  await new Promise(r => setTimeout(r, 5)); v.page.dshStopVoice()
})

test('history playback stops message auto playback but cannot interrupt an active phone call', async () => {
  for (const mode of ['chat', 'call']) {
    const v = voiceMenuFixture(); v.start(mode); await new Promise(r => setTimeout(r, 10))
    v.page.els.get('voiceFinish').onclick(); await new Promise(r => setTimeout(r, 10))
    v.emit('audio', { audio: 'YQ==', sentenceId: 0 }); await new Promise(r => setTimeout(r, 10))
    v.pointer('click')
    await new Promise(r => setTimeout(r, 5))
    assert.equal(v.audios[0].playCalls, mode === 'chat' ? 1 : 0)
    if (mode === 'call') { assert.match(v.page.els.get('toast').textContent, /请先挂断/); v.page.dshStopVoice() }
    else assert.equal(v.tracks.stops, 1)
  }
})

function metadataStreamFixture() {
  const page = bootApp(), streams = [], c = chatWithQueue(page.__dsh.S, 'metadata-session', false)
  let items = [], reads = 0
  const original = page.fetch
  page.fetch = (url, options) => String(url).startsWith('/m/api/voice?') ? (++reads, Promise.resolve({ ok: true, status: 200, json: async () => ({ ok: true, value: { items } }) })) : original(url, options)
  page.EventSource = class {
    constructor(url) { this.url = url; this.closed = 0; this.handlers = {}; streams.push(this) }
    close() { this.closed++ }
    addEventListener(name, fn) { this.handlers[name] = fn }
    emit(s, item) { this.handlers['voice-saved']?.({ data: JSON.stringify({ s, item }) }) }
  }
  page.__dsh.S.cur = null; page.dshOpen(c.id)
  return { page, c, streams, setItems(value) { items = value }, reads: () => reads }
}

test('voiceSaved uses the existing frame stream with precise session ownership and reconnect reconciliation', async () => {
  const v = metadataStreamFixture(); await new Promise(r => setTimeout(r, 10))
  assert.equal(v.streams.length, 0, 'opening a chat must not allocate a second metadata EventSource')
  const emit = (s, item) => v.page.__dsh.onFrame({ t: 'voiceSaved', s, item })
  const item = { id: 'confirmed-sse', role: 'user', mode: 'message', requestId: 'r1', text: '已保存的原声', createdAt: '2026-10-13T00:00:00Z' }
  emit(v.c.id, item); assert.equal(v.c.voiceItems[0].id, item.id)
  emit('wrong-session', { ...item, id: 'wrong' }); assert.equal(v.c.voiceItems.length, 1)
  v.page.dshOpen('another-metadata'); emit(v.c.id, { ...item, id: 'late' }); assert.equal(v.c.voiceItems.length, 1)
  await new Promise(r => setTimeout(r, 5)); const before = v.reads()
  v.page.__dsh.S.hellos = 1; v.page.__dsh.onFrame({ t: 'hello' }); await new Promise(r => setTimeout(r, 10))
  assert.ok(v.reads() > before)
  assert.equal(v.streams.some(stream => stream.url.startsWith('/m/api/voice/events')), false)
})

test('call metadata events fetch the grouped history instead of exposing raw speech segments', async () => {
  const v = metadataStreamFixture(); await new Promise(r => setTimeout(r, 10))
  v.setItems([{ id: 'grouped-call', role: 'assistant', mode: 'call', segmentIds: ['part1', 'part2'], text: '连续的回复' }])
  const before = v.reads()
  v.page.__dsh.onFrame({ t: 'voiceSaved', s: v.c.id, item: { id: 'part2', role: 'assistant', mode: 'call', callId: 'call-a' } })
  await new Promise(r => setTimeout(r, 10))
  assert.ok(v.reads() > before); assert.equal(v.c.voiceItems[0].id, 'grouped-call')
  assert.equal(v.c.voiceItems.length, 1)
})

test('live call waits for model end, synthesis drain, audio playback and echo tail before listening again', async () => {
  const v = voicePage(); v.start('call'); await new Promise(r => setTimeout(r, 10))
  v.page.els.get('voiceFinish').onclick(); await new Promise(r => setTimeout(r, 10))
  v.emit('turn', { state: 'agent-speaking' }); v.emit('tts-state', { busy: true })
  v.emit('audio', { audio: 'YQ==', sentenceId: 0 }); await new Promise(r => setTimeout(r, 10))
  v.emit('audio', { audio: '', text: '你好，我在听。', final: true, sentenceId: 0 })
  assert.equal(v.page.els.get('voiceCaption').textContent, 'DSH：你好，我在听。')
  v.page.window.__dsh.onFrame({ t: 'run', s: 'voice-test', on: false })
  v.emit('turn', { state: 'listening' })
  const cancels = () => v.calls.filter(c => c.url === '/voice-mode/cancel').length
  v.page.fireTimeouts(250); await new Promise(r => setTimeout(r, 5)); assert.equal(cancels(), 0)
  v.emit('tts-state', { busy: false }); v.page.fireTimeouts(250)
  await new Promise(r => setTimeout(r, 5)); assert.equal(cancels(), 0, 'audio still playing')
  v.players[0].onended(); await new Promise(r => setTimeout(r, 5))
  assert.equal(cancels(), 0, 'echo tail')
  v.page.fireTimeouts(250); await new Promise(r => setTimeout(r, 10))
  assert.equal(cancels(), 1)
  assert.match(v.page.els.get('voiceState').textContent, /正在听/)
  assert.equal(v.page.rpcCalls.filter(c => c.method === 'session.prompt').length, 1, 'resuming never sends another prompt')
  v.page.els.get('voiceEnd').onclick()
})

test('manual voice messages never auto-resume and ending a call cancels its delayed resume', async () => {
  for (const mode of ['chat', 'call']) {
    const v = voicePage(); v.start(mode); await new Promise(r => setTimeout(r, 10))
    v.page.els.get('voiceFinish').onclick(); await new Promise(r => setTimeout(r, 10))
    v.emit('turn', { state: 'agent-speaking' }); v.emit('turn', { state: 'listening' })
    v.page.window.__dsh.onFrame({ t: 'run', s: 'voice-test', on: false })
    if (mode === 'call') v.page.els.get('voiceEnd').onclick()
    v.page.fireTimeouts(600); await new Promise(r => setTimeout(r, 10))
    assert.equal(v.calls.filter(c => c.url === '/voice-mode/cancel').length, 0)
    if (mode === 'chat') v.page.els.get('voiceEnd').onclick()
  }
})
test('voice dictation appends to draft without sending a model prompt and releases the microphone', async () => {
  const { page, start, calls, tracks, nodes } = voicePage()
  page.els.get('input').value = '原有草稿'
  start('draft'); await new Promise(r => setTimeout(r, 10))
  assert.equal(nodes.length, 1)
  page.els.get('voiceFinish').onclick(); await new Promise(r => setTimeout(r, 10))
  assert.equal(page.els.get('input').value, '原有草稿\n这是录音转成的文字。')
  assert.equal(page.rpcCalls.filter(c => c.method === 'session.prompt').length, 0)
  assert.equal(tracks.stops, 1)
  assert.ok(calls.some(c => c.url.includes('final=1')))
})

test('dictation mic finish drains pending partial and tail once without duplicate caption or automatic send', async () => {
  let resolvePartial
  const v = voicePage({ intercept: url => url.includes('/asr?') && !url.includes('final=1') ? new Promise(resolve => { resolvePartial = resolve }) : url.includes('final=1') ? Promise.resolve({ ok: true, json: async () => ({ text: '前半句和最后一句' }) }) : null })
  v.start('draft'); await new Promise(r => setTimeout(r, 10))
  for (let n = 0; n < 12; n++) v.nodes[0].onaudioprocess({ inputBuffer: { getChannelData: () => new Float32Array(4096).fill(0.1) } })
  await new Promise(r => setTimeout(r, 5))
  assert.equal(v.page.els.get('voiceCaption').hidden, true); assert.equal(v.page.els.get('voiceEnd').hidden, true)
  assert.equal(v.page.els.get('voiceFinish').textContent, '结束录音')
  v.page.els.get('mic').onclick(); v.page.els.get('mic').onclick()
  assert.equal(v.tracks.stops, 1, 'capture stops immediately while finalization drains')
  resolvePartial({ ok: true, json: async () => ({ text: '前半句' }) }); await new Promise(r => setTimeout(r, 15))
  assert.equal(v.page.els.get('input').value, '前半句和最后一句')
  assert.equal(v.page.els.get('voiceCaption').textContent, '')
  assert.equal(v.calls.filter(c => c.url.includes('final=1')).length, 1)
  assert.equal(v.page.rpcCalls.filter(c => c.method === 'session.prompt').length, 0)
})

test('dictation disables send until final ASR is retained and direct handler cannot send a partial', async () => {
  let finish
  const v = voicePage({ intercept: url => url.includes('/asr?') ? url.includes('final=1') ? new Promise(resolve => { finish = resolve }) : Promise.resolve({ ok: true, json: async () => ({ text: '半句话' }) }) : null })
  v.start('draft'); await new Promise(r => setTimeout(r, 10))
  assert.equal(v.page.els.get('send').disabled, true)
  for (let n = 0; n < 12; n++) v.nodes[0].onaudioprocess({ inputBuffer: { getChannelData: () => new Float32Array(4096).fill(0.1) } })
  await new Promise(r => setTimeout(r, 10))
  assert.equal(v.page.els.get('input').value, '半句话')
  assert.equal(v.page.els.get('send').disabled, true)
  v.page.els.get('send').onclick()
  assert.equal(v.page.rpcCalls.filter(c => c.method === 'session.prompt').length, 0)
  assert.equal(v.page.els.get('input').value, '半句话')
  v.page.els.get('voiceFinish').onclick(); await new Promise(r => setTimeout(r, 5))
  assert.equal(v.page.els.get('send').disabled, true)
  v.page.els.get('send').onclick()
  finish({ ok: true, json: async () => ({ text: '半句话以及完整末尾' }) }); await new Promise(r => setTimeout(r, 10))
  assert.equal(v.page.els.get('send').disabled, false)
  assert.equal(v.page.els.get('input').value, '半句话以及完整末尾')
  assert.equal(v.page.rpcCalls.filter(c => c.method === 'session.prompt').length, 0)
})

test('dictation final response after navigation updates only its originating draft', async () => {
  let resolveFinal
  const v = voicePage({ intercept: url => url.includes('final=1') ? new Promise(resolve => { resolveFinal = resolve }) : null })
  v.start('draft'); await new Promise(r => setTimeout(r, 10))
  v.page.els.get('voiceFinish').onclick(); await new Promise(r => setTimeout(r, 5))
  chatWithQueue(v.S, 'another-chat', false); v.page.els.get('input').value = '新对话的草稿'
  resolveFinal({ ok: true, json: async () => ({ text: '原对话最后一句' }) }); await new Promise(r => setTimeout(r, 10))
  assert.equal(v.S.drafts['voice-test'], '原对话最后一句')
  assert.equal(v.page.els.get('input').value, '新对话的草稿')
  assert.equal(v.page.rpcCalls.filter(c => c.method === 'session.prompt').length, 0)
})

test('editing a partial dictation keeps the edit and appends only the unshown final suffix', async () => {
  const v = voicePage({ intercept: url => url.includes('/asr?') ? Promise.resolve({ ok: true, json: async () => ({ text: url.includes('final=1') ? '前半句最后几个字' : '前半句' }) }) : null })
  v.start('draft'); await new Promise(r => setTimeout(r, 10))
  for (let n = 0; n < 12; n++) v.nodes[0].onaudioprocess({ inputBuffer: { getChannelData: () => new Float32Array(4096).fill(0.1) } })
  await new Promise(r => setTimeout(r, 10))
  assert.equal(v.page.els.get('input').value, '前半句')
  v.page.els.get('input').value = '用户改过的前半句'
  v.page.els.get('voiceFinish').onclick(); await new Promise(r => setTimeout(r, 10))
  assert.equal(v.page.els.get('input').value, '用户改过的前半句\n最后几个字')
})

function imageFixture() {
  const page = bootApp(), { S } = page.__dsh, images = [], revoked = []
  chatWithQueue(S, 'photo-a', false)
  let serial = 0
  page.URL.createObjectURL = () => 'blob:photo-' + (++serial)
  page.URL.revokeObjectURL = url => revoked.push(url)
  page.Image = class { constructor() { this.naturalWidth = 100; this.naturalHeight = 100; images.push(this) } }
  const create = page.document.createElement
  page.document.createElement = tag => tag === 'canvas' ? { getContext: () => ({ fillRect() {}, drawImage() {} }), toDataURL: () => 'data:image/jpeg;base64,YQ==' } : create(tag)
  const select = count => { page.els.get('file').files = Array.from({ length: count }, (_, index) => ({ name: 'picture' + index + '.jpg' })); page.els.get('file').onchange() }
  return { page, S, images, revoked, select }
}

test('late image preparation cannot cross conversations even when returning to the original chat', async () => {
  const { page, S, images, revoked, select } = imageFixture()
  select(1)
  page.dispatchWindow('popstate', { state: { v: 'chat', s: 'photo-b' } })
  page.dispatchWindow('popstate', { state: { v: 'chat', s: 'photo-a' } })
  images[0].onload(); await new Promise(r => setTimeout(r, 10))
  assert.equal(S.att.length, 0); assert.deepEqual(revoked, ['blob:photo-1'])
})

test('overlapping image batches respect the final six-image limit and revoke overflow', async () => {
  const { S, images, revoked, select } = imageFixture()
  select(6); select(6)
  images.forEach(image => image.onload()); await new Promise(r => setTimeout(r, 10))
  assert.equal(S.att.length, 6); assert.equal(revoked.length, 6)
  assert.equal(new Set(S.att.map(image => image.url)).size, 6)
})

test('navigating away pauses chat voice replay without resending or deleting messages', () => {
  const page = bootApp(), c = chatWithQueue(page.__dsh.S, 'voice-a', false)
  const audio = { dataset: { session: c.id }, paused: false, ended: false, pause() { this.paused = true } }
  page.els.get('msgs').querySelectorAll = selector => selector === 'audio[data-voice-id]' ? [audio] : []
  page.dispatchWindow('popstate', { state: {} })
  assert.equal(audio.paused, true); assert.equal(page.__dsh.S.cur, null)
  assert.equal(page.__dsh.S.chats.has(c.id), true)
})

test('call mute before microphone grant is safe and applies to the granted track', async () => {
  const v = voicePage(); let grant
  v.page.navigator.mediaDevices.getUserMedia = () => new Promise(resolve => { grant = resolve })
  v.start('call'); await new Promise(r => setTimeout(r, 5))
  assert.doesNotThrow(() => v.page.els.get('callMute').onclick())
  grant({ getTracks: () => [v.tracks] }); await new Promise(r => setTimeout(r, 10))
  assert.equal(v.tracks.enabled, false); assert.match(v.page.els.get('callState').textContent, /静音/)
  v.page.els.get('callHangup').onclick()
})

test('call mute during original-audio persistence prevents delayed prompt submission', async () => {
  let save
  const v = voicePage({ intercept: url => url === '/m/api/voice' ? new Promise(resolve => { save = resolve }) : null })
  v.start('call'); await new Promise(r => setTimeout(r, 10))
  v.page.els.get('voiceFinish').onclick(); await new Promise(r => setTimeout(r, 10))
  v.page.els.get('callMute').onclick(); v.page.els.get('callMute').onclick()
  save({ ok: true, json: async () => ({ ok: true, value: {} }) }); await new Promise(r => setTimeout(r, 10))
  assert.equal(v.page.rpcCalls.filter(c => c.method === 'session.prompt').length, 0, 'unmuting cannot revive the cancelled turn')
  assert.match(v.page.els.get('callState').textContent, /未发送/)
  v.page.els.get('callHangup').onclick()
})

test('call coalesces unsent PCM behind one slow partial ASR without queuing redundant decodes', async () => {
  const requests = [], waiting = []
  const v = voicePage({ intercept: (url, options) => url.includes('/asr?') ? new Promise(resolve => { requests.push({ url, samples: new Float32Array(options.body).length }); waiting.push(resolve) }) : null })
  v.start('call'); await new Promise(r => setTimeout(r, 10))
  const feed = level => v.nodes[0].onaudioprocess({ inputBuffer: { getChannelData: () => new Float32Array(4096).fill(level) } })
  for (let n = 0; n < 48; n++) feed(0.1)
  for (let n = 0; n < 11; n++) feed(0)
  await new Promise(r => setTimeout(r, 5))
  assert.equal(requests.length, 1, 'the first partial is still in flight')
  // Deterministic simulated transport/ASR cost: 200 ms per response after
  // the endpoint. This does not measure the real model, network or device.
  for (let n = 0; n < 8 && waiting.length; n++) { v.page.advance(200); waiting.shift()({ ok: true, json: async () => ({ text: '固定测试语句' }) }); await new Promise(r => setTimeout(r, 5)) }
  assert.equal(requests.length, 2, 'one in-flight partial plus one final, not a backlog of obsolete partial decodes')
  assert.match(requests[1].url, /final=1/)
  assert.equal(+new URL(requests[1].url, 'https://fixture').searchParams.get('offset'), requests[0].samples)
  assert.equal(requests.reduce((n, r) => n + r.samples, 0), 59 * Math.floor(4096 / 3), 'every PCM sample reaches ASR exactly once')
  assert.equal(v.page.rpcCalls.filter(c => c.method === 'session.prompt').length, 1)
  const timing = v.page.__dsh.getVoiceTiming()
  assert.equal(timing.promptSubmittedAt - timing.endpointAt, 400, 'two simulated 200 ms ASR responses; real-world savings are not asserted')
  assert.equal(timing.finalStartedAt - timing.finalQueuedAt, 200)
  assert.ok(timing.promptSubmittedAt >= timing.storedAt)
  v.page.dshStopVoice()
})

test('call idle silence sends no ASR; a 250ms preroll precedes two seconds of speech exactly once', async () => {
  const requests = []
  const v = voicePage({ intercept: (url, options) => url.includes('/asr?') ? (requests.push({ url, pcm: new Float32Array(options.body) }), Promise.resolve({ ok: true, json: async () => ({ text: '固定两秒语句' }) })) : null })
  v.start('call'); await new Promise(r => setTimeout(r, 10))
  const feed = level => v.nodes[0].onaudioprocess({ inputBuffer: { getChannelData: () => new Float32Array(4096).fill(level) } })
  for (let n = 0; n < 118; n++) feed(0)
  await new Promise(r => setTimeout(r, 5)); assert.equal(requests.length, 0, 'ten seconds waiting for speech must not enter ASR')
  assert.equal(v.page.rpcCalls.filter(call => call.method !== 'commands/list').length, 0)
  feed(0.005) // quiet leading consonant retained by the pre-roll
  for (let n = 0; n < 24; n++) feed(0.1)
  for (let n = 0; n < 11; n++) feed(0)
  await new Promise(r => setTimeout(r, 20))
  const posted = JSON.parse(v.calls.find(call => call.url === '/m/api/voice').options.body), wav = Buffer.from(posted.audio, 'base64')
  const samples = (wav.length - 44) / 2, block = Math.floor(4096 / 3)
  assert.equal(samples, 4000 + (24 + 11) * block)
  assert.equal(posted.durationMs, Math.round(samples / 16))
  assert.ok(posted.durationMs < 3500)
  assert.equal(wav.readInt16LE(44 + 3999 * 2), Math.trunc(0.005 * 32767), 'quiet leading sound was not discarded')
  assert.equal(wav.readInt16LE(44 + 4000 * 2), Math.trunc(0.1 * 32767))
  assert.equal(wav.readInt16LE(wav.length - 2), 0, 'tail retained')
  let offset = 0
  for (const request of requests) { assert.equal(+new URL(request.url, 'https://fixture').searchParams.get('offset'), offset); offset += request.pcm.length }
  assert.equal(offset, samples); assert.equal(requests.filter(request => request.url.includes('final=1')).length, 1)
  assert.equal(v.page.rpcCalls.filter(call => call.method === 'session.prompt').length, 1)
  v.page.dshStopVoice()
})

test('call idle beyond recording limit still cannot manufacture an utterance', async () => {
  const v = voicePage(); v.start('call'); await new Promise(r => setTimeout(r, 10))
  for (let n = 0; n < 720; n++) v.nodes[0].onaudioprocess({ inputBuffer: { getChannelData: () => new Float32Array(4096) } })
  await new Promise(r => setTimeout(r, 10))
  assert.equal(v.calls.filter(call => call.url.includes('/asr?')).length, 0)
  assert.equal(v.calls.filter(call => call.url === '/m/api/voice').length, 0)
  assert.equal(v.page.rpcCalls.filter(call => call.method === 'session.prompt').length, 0)
  v.page.dshStopVoice()
})

test('starting a new call turn clears the previous pre-roll rather than attaching stale quiet audio', async () => {
  const v = voicePage(); v.start('call'); await new Promise(r => setTimeout(r, 10))
  const feed = level => v.nodes[0].onaudioprocess({ inputBuffer: { getChannelData: () => new Float32Array(4096).fill(level) } })
  for (let n = 0; n < 10; n++) feed(0.005)
  v.page.els.get('callInterrupt').onclick(); await new Promise(r => setTimeout(r, 10))
  for (let n = 0; n < 24; n++) feed(0.1)
  for (let n = 0; n < 11; n++) feed(0)
  await new Promise(r => setTimeout(r, 20))
  const posted = JSON.parse(v.calls.find(call => call.url === '/m/api/voice').options.body), wav = Buffer.from(posted.audio, 'base64')
  assert.equal((wav.length - 44) / 2, 35 * Math.floor(4096 / 3))
  assert.equal(wav.readInt16LE(44), Math.trunc(0.1 * 32767))
  v.page.dshStopVoice()
})

test('old epoch partial completion cannot unlock a newer partial; cancelling final never submits', async () => {
  const requests = [], waiting = []
  const v = voicePage({ intercept: (url, options) => url.includes('/asr?') ? new Promise(resolve => { requests.push({ url, bytes: options.body.byteLength }); waiting.push(resolve) }) : null })
  v.start('call'); await new Promise(r => setTimeout(r, 10))
  const feed = n => { for (let i = 0; i < n; i++) v.nodes[0].onaudioprocess({ inputBuffer: { getChannelData: () => new Float32Array(4096).fill(0.1) } }) }
  feed(12); await new Promise(r => setTimeout(r, 5))
  v.page.els.get('callInterrupt').onclick(); await new Promise(r => setTimeout(r, 10))
  feed(12); await new Promise(r => setTimeout(r, 5))
  assert.equal(requests.length, 2)
  assert.notEqual(new URL(requests[0].url, 'https://fixture').searchParams.get('epoch'), new URL(requests[1].url, 'https://fixture').searchParams.get('epoch'))
  waiting.shift()({ ok: true, json: async () => ({ text: '旧轮结果不得混入' }) }); await new Promise(r => setTimeout(r, 5))
  feed(12); await new Promise(r => setTimeout(r, 5)); assert.equal(requests.length, 2, 'new epoch remains busy')
  v.page.els.get('voiceFinish').onclick()
  waiting.shift()({ ok: true, json: async () => ({ text: '新轮半句' }) }); await new Promise(r => setTimeout(r, 5))
  assert.equal(requests.length, 3); assert.match(requests[2].url, /final=1/)
  v.page.els.get('callHangup').onclick()
  waiting.shift()({ ok: true, json: async () => ({ text: '新轮整句' }) }); await new Promise(r => setTimeout(r, 10))
  assert.equal(v.page.rpcCalls.filter(c => c.method === 'session.prompt').length, 0)
  assert.equal(v.calls.filter(c => c.url === '/m/api/voice').length, 0)
})
test('voice does not overwrite edits and backgrounding releases capture', async () => {
  const { page, start, tracks } = voicePage()
  start('draft'); await new Promise(r => setTimeout(r, 10))
  page.els.get('input').value = '用户刚刚改过的内容'
  page.els.get('voiceFinish').onclick(); await new Promise(r => setTimeout(r, 10))
  assert.equal(page.els.get('input').value, '用户刚刚改过的内容\n这是录音转成的文字。')
  assert.equal(tracks.stops, 1)
})
test('voice conversation sends once only after a final transcript; an early exit releases a late microphone grant', async () => {
  const first = voicePage()
  first.start('chat'); await new Promise(r => setTimeout(r, 10))
  first.page.els.get('voiceFinish').onclick(); first.page.els.get('voiceFinish').onclick()
  await new Promise(r => setTimeout(r, 10))
  assert.equal(first.page.rpcCalls.filter(c => c.method === 'session.prompt').length, 1)
  first.page.document.visibilityState = 'hidden'; first.page.dispatchDocument('visibilitychange')
  assert.equal(first.tracks.stops, 1)
  const second = voicePage()
  let allow
  second.page.navigator.mediaDevices.getUserMedia = () => new Promise(r => { allow = r })
  second.start('draft'); await new Promise(r => setTimeout(r, 5))
  second.page.els.get('voiceEnd').onclick()
  allow({ getTracks: () => [second.tracks] }); await new Promise(r => setTimeout(r, 10))
  assert.equal(second.tracks.stops, 1)
  assert.equal(second.calls.some(c => c.url === '/voice-mode/toggle'), false)
})

test('permission picker reads the session, confirms full access and sends only a preset change', async () => {
  let currentValue = 'workspace-write'
  const values = () => ({ currentValue, options: ['read-only', 'workspace-write', 'danger-full-access'].map(value => ({ value, name: value })) })
  const page = bootApp({ rpcResult: call => {
    if (call.method === 'session.selectPermission') currentValue = call.payload.preset
    return { ok: true, value: values() }
  } })
  const { S, onFrame } = page.window.__dsh
  const c = chatWithQueue(S, 'permission-session', false)
  onFrame({ t: 'permissions', s: c.id, value: values() })
  assert.match(page.els.get('permission').innerHTML, /工作区写入/)
  page.els.get('permission').onclick()
  await new Promise(r => setTimeout(r, 10))
  assert.match(page.els.get('permissionOptions').innerHTML, /Read Only/)
  assert.match(page.els.get('permissionOptions').innerHTML, /Full access/)
  const click = preset => page.els.get('sheet').onclick({ target: { closest: () => ({ dataset: { permission: preset } }) } })
  page.confirm = () => false
  click('danger-full-access')
  assert.equal(page.rpcCalls.filter(c => c.method === 'session.selectPermission').length, 0)
  page.confirm = () => true
  click('danger-full-access'); click('read-only')
  await new Promise(r => setTimeout(r, 10))
  const writes = page.rpcCalls.filter(c => c.method === 'session.selectPermission')
  assert.equal(writes.length, 1, 'double tap cannot issue a second write')
  assert.deepEqual(writes[0].payload, { sessionId: c.id, preset: 'danger-full-access', confirmFullAccess: true })
  assert.equal(c.permissions.currentValue, 'danger-full-access')
  assert.equal(page.rpcCalls.some(c => c.method === 'session.prompt'), false)
  onFrame({ t: 'permissions', s: c.id, value: { ...values(), currentValue: 'read-only' } })
  assert.match(page.els.get('permission').innerHTML, /只读/)
})

test('a late permissions read cannot overwrite a newer desktop projection', async () => {
  let done
  const response = new Promise(r => { done = r })
  const page = bootApp({ rpcResult: () => response })
  const { S, onFrame } = page.window.__dsh
  const c = chatWithQueue(S, 'permission-race', false)
  page.els.get('permission').onclick()
  onFrame({ t: 'permissions', s: c.id, value: { currentValue: 'read-only', options: [] } })
  done({ ok: true, value: { currentValue: 'danger-full-access', options: [] } })
  await new Promise(r => setTimeout(r, 10))
  assert.equal(c.permissions.currentValue, 'read-only')
})

test('a delivered message retires the queue row that produced it', () => {
  const { S, onFrame } = bootApp().window.__dsh
  const id = 'session-1'
  const c = chatWithQueue(S, id)

  // The phone missed the frame that removed the item, so the row is still here.
  onFrame({ t: 'queue', s: id, items: [{ id: 'm1', place: 'queue', text: '我说的开源项目，不是指开源模型，明白吗？' }] })
  assert.equal(c.queue.length, 1, 'queue frame lands')

  // The request RPC id and the host-generated message id are different.
  onFrame({ t: 'item', s: id, it: { k: 'u', seq: 10, rid: 'request-1', messageId: 'm1', text: '我说的开源项目，不是指开源模型，明白吗？' } })
  assert.deepEqual(c.queue, [], 'the phantom 排队中 row must clear')
})

test('an unrelated queue item is not retired by someone else’s message', () => {
  const { S, onFrame } = bootApp().window.__dsh
  const id = 'session-2'
  const c = chatWithQueue(S, id)
  onFrame({ t: 'queue', s: id, items: [{ id: 'm1', place: 'queue', text: '第一条' }, { id: 'm2', place: 'queue', text: '第二条' }] })
  onFrame({ t: 'item', s: id, it: { k: 'u', seq: 10, rid: 'request-2', messageId: 'm1', text: '第一条' } })
  assert.deepEqual(c.queue.map((x) => x.id), ['m2'], 'only the delivered one goes')
})

test('a queue item with no id is kept (older DSH payloads)', () => {
  const { S, onFrame } = bootApp().window.__dsh
  const id = 'session-3'
  const c = chatWithQueue(S, id)
  onFrame({ t: 'queue', s: id, items: [{ place: 'queue', text: '没有 id' }] })
  onFrame({ t: 'item', s: id, it: { k: 'u', seq: 10, rid: 'whatever', text: 'x' } })
  assert.equal(c.queue.length, 1, 'without an id there is nothing to match on')
})

test('foldHistory stamps the session run state on every end item', async () => {
  const { foldHistory } = await import('../fold.js')
  const entries = [
    { event: { seq: 1, type: 'turn/start', time: 100 } },
    { event: { seq: 2, type: 'turn/end', time: 200, data: { reason: { kind: 'completed' } } } },
  ]
  assert.equal(foldHistory(entries, false).items.at(-1).st, false, 'finished turn')
  assert.equal(foldHistory(entries, true).items.at(-1).st, true, 'a later turn is still running')
  assert.equal(foldHistory(entries).items.at(-1).st, undefined, 'unknown when the caller has no state')
})

// ---------------------------------------------------------------- queue-jump

test('a queued row offers queue-jump while the session is running', () => {
  const sandbox = bootApp()
  const { S, onFrame } = sandbox.window.__dsh
  chatWithQueue(S, 'session-q1')
  onFrame({ t: 'queue', s: 'session-q1', items: [{ id: 'm1', place: 'queue', text: '是要给整个DSH用' }] })
  const html = sandbox.els.get('dock').innerHTML
  assert.match(html, /data-steer="m1"/, 'the row must carry a 插队 button')
  assert.match(html, /data-unqueue="m1"/, 'and still the dismiss button')
  assert.match(html, /插话发送/, 'the button is labelled for assistive tech')
  assert.match(html, /排队中/, 'still shown as queued until the host confirms')
})

test('no queue-jump when the session is idle: there is no turn to steer into', () => {
  const sandbox = bootApp()
  const { S, onFrame } = sandbox.window.__dsh
  chatWithQueue(S, 'session-q2', false)
  onFrame({ t: 'queue', s: 'session-q2', items: [{ id: 'm1', place: 'queue', text: '等待中的消息' }] })
  const html = sandbox.els.get('dock').innerHTML
  assert.doesNotMatch(html, /data-steer/, 'an idle session has nothing to steer into')
  assert.match(html, /data-unqueue="m1"/, 'dismiss stays available')
})

test('“steer all” appears only when more than one row can be steered', () => {
  const sandbox = bootApp()
  const { S, onFrame } = sandbox.window.__dsh
  chatWithQueue(S, 'session-q3')
  onFrame({ t: 'queue', s: 'session-q3', items: [{ id: 'm1', place: 'queue', text: '第一条' }] })
  assert.doesNotMatch(sandbox.els.get('dock').innerHTML, /data-steerall/, 'one row needs no bulk action')
  onFrame({ t: 'queue', s: 'session-q3', items: [{ id: 'm1', place: 'queue', text: '第一条' }, { id: 'm2', place: 'queue', text: '第二条' }] })
  assert.match(sandbox.els.get('dock').innerHTML, /data-steerall/, 'two rows offer the bulk action')
})

test('tapping 插队 sends the host’s strict steer action for that row', async () => {
  const sandbox = bootApp()
  const { S, onFrame } = sandbox.window.__dsh
  const c = chatWithQueue(S, 'session-q4')
  onFrame({ t: 'queue', s: 'session-q4', items: [{ id: 'm1', place: 'queue', text: '是要给整个DSH用' }] })

  sandbox.els.get('dock').dispatch('click', { target: { closest: (sel) => (sel === '[data-steer]' ? { dataset: { steer: 'm1' } } : null) } })
  await new Promise((r) => setImmediate(r))

  const call = sandbox.rpcCalls.find((r) => r.method === 'session.updateQueue')
  assert.ok(call, 'the click must reach the host')
  assert.equal(call.payload.itemId, 'm1')
  assert.equal(call.payload.sessionId, 'session-q4')
  assert.deepEqual(call.payload.action, { kind: 'steer' }, 'steer, not remove')
  assert.equal(c.queue[0].place, 'steering', 'the accepted request waits for actual delivery')
})

test('steer-all steers every still-pending row in FIFO order', async () => {
  const sandbox = bootApp()
  const { S, onFrame } = sandbox.window.__dsh
  chatWithQueue(S, 'session-q5')
  onFrame({ t: 'queue', s: 'session-q5', items: [{ id: 'm1', place: 'queue', text: '甲' }, { id: 'm2', place: 'queue', text: '乙' }, { id: 'm3', place: 'queue', text: '丙' }] })

  sandbox.els.get('dock').dispatch('click', { target: { closest: (sel) => (sel === '[data-steerall]' ? {} : null) } })
  await new Promise((r) => setImmediate(r))

  const ids = sandbox.rpcCalls.filter((r) => r.method === 'session.updateQueue' && r.payload.action.kind === 'steer').map((r) => r.payload.itemId)
  assert.deepEqual(ids, ['m1', 'm2', 'm3'], 'every row, oldest first')
})

test('a steering row does not offer duplicate steering', () => {
  const sandbox = bootApp()
  const { S, onFrame } = sandbox.window.__dsh
  chatWithQueue(S, 'session-q6')
  onFrame({ t: 'queue', s: 'session-q6', items: [{ id: 'm1', place: 'steering', text: '已经在插了' }] })
  const html = sandbox.els.get('dock').innerHTML
  assert.doesNotMatch(html, /data-steer="m1"/, 'the host already accepted steering')
  assert.match(html, /等待接收插话/, 'accepted steering is not claimed as delivered')
})

function tapQueue(sandbox, attr, id) {
  sandbox.els.get('dock').dispatch('click', { target: { closest: (sel) => sel === '[data-' + attr + ']' ? { dataset: { [attr]: id } } : null } })
}

test('queued messages expose edit, delete and steer actions', () => {
  const s = bootApp(), { S, onFrame } = s.window.__dsh
  chatWithQueue(S, 'actions')
  onFrame({ t: 'queue', s: 'actions', items: [{ id: 'm1', place: 'queued', text: '修改这条消息' }] })
  const html = s.els.get('dock').innerHTML
  assert.match(html, /data-qedit="m1"/)
  assert.match(html, /data-unqueue="m1"/)
  assert.match(html, /data-steer="m1"/)
})

test('steering rejection preserves the queued message and shows a useful error', async () => {
  const s = bootApp({ rpcResult: () => ({ ok: false, error: { code: 'steer-unavailable', message: 'No running turn' } }) })
  const { S, onFrame } = s.window.__dsh, c = chatWithQueue(S, 'rejected')
  onFrame({ t: 'queue', s: c.id, items: [{ id: 'm1', place: 'queued', text: '不能弄丢' }] })
  tapQueue(s, 'steer', 'm1')
  await new Promise(r => setImmediate(r))
  assert.equal(c.queue[0]?.text, '不能弄丢')
  assert.match(s.els.get('toast').textContent, /插话|运行/)
})

test('a pending request keeps its row visible and blocks double taps', async () => {
  let settle
  const s = bootApp({ rpcResult: () => new Promise(r => { settle = r }) })
  const { S, onFrame } = s.window.__dsh, c = chatWithQueue(S, 'pending')
  onFrame({ t: 'queue', s: c.id, items: [{ id: 'm1', place: 'queued', text: '只发一次' }] })
  tapQueue(s, 'steer', 'm1'); tapQueue(s, 'steer', 'm1')
  await new Promise(r => setImmediate(r))
  assert.equal(c.queue.length, 1)
  assert.equal(s.rpcCalls.length, 1)
  settle({ ok: true, value: { accepted: true } })
  await new Promise(r => setImmediate(r))
})

test('deletion is reconciled from a successful host response without an SSE frame', async () => {
  const s = bootApp(), { S, onFrame } = s.window.__dsh, c = chatWithQueue(S, 'remove')
  onFrame({ t: 'queue', s: c.id, items: [{ id: 'm1', place: 'queued', text: '撤回' }] })
  tapQueue(s, 'unqueue', 'm1')
  await new Promise(r => setImmediate(r))
  assert.equal(c.queue.length, 0)
  assert.equal(s.rpcCalls[0].payload.action.kind, 'remove')
})

test('editing sends the complete text, including characters beyond the preview limit', async () => {
  const s = bootApp(), { S, onFrame } = s.window.__dsh, c = chatWithQueue(S, 'edit')
  const full = '长消息'.repeat(150) + '\n尾部不能丢'
  onFrame({ t: 'queue', s: c.id, items: [{ id: 'm1', place: 'queued', text: full.slice(0, 300), editText: full }] })
  tapQueue(s, 'qedit', 'm1')
  const input = s.els.get('qe')
  assert.equal(input.value, full)
  input.value = full + '\n补充'
  const button = { disabled: false }
  s.els.get('sheet').onclick({ target: { closest: sel => sel === '[data-qsave]' ? button : null } })
  await new Promise(r => setImmediate(r))
  assert.deepEqual(s.rpcCalls[0].payload.action, { kind: 'edit', content: [{ type: 'text', text: full + '\n补充' }] })
  assert.equal(c.queue[0].editText, full + '\n补充')
})

test('attachment or legacy clipped rows are never replaced with their preview text', () => {
  for (const editText of [null, undefined]) {
    const s = bootApp(), { S, onFrame } = s.window.__dsh, c = chatWithQueue(S, 'attachments')
    onFrame({ t: 'queue', s: c.id, items: [{ id: 'm1', place: 'queued', text: '带图的消息', editText }] })
    tapQueue(s, 'qedit', 'm1')
    assert.equal(s.rpcCalls.length, 0)
    assert.match(s.els.get('toast').textContent, /附件|插件/)
  }
})

test('a desktop edit during phone editing is not overwritten silently', async () => {
  const s = bootApp(), { S, onFrame } = s.window.__dsh, c = chatWithQueue(S, 'conflict')
  onFrame({ t: 'queue', s: c.id, items: [{ id: 'm1', place: 'queued', text: '原文', editText: '原文' }] })
  tapQueue(s, 'qedit', 'm1')
  onFrame({ t: 'queue', s: c.id, items: [{ id: 'm1', place: 'queued', text: '电脑已改', editText: '电脑已改' }] })
  s.els.get('qe').value = '手机改稿'
  s.els.get('sheet').onclick({ target: { closest: sel => sel === '[data-qsave]' ? { disabled: false } : null } })
  assert.equal(s.rpcCalls.length, 0)
  assert.equal(c.queue[0].editText, '电脑已改')
})

test('forbidden and network failures preserve the row and remain visible', async () => {
  for (const code of ['forbidden', 'network-error']) {
    const s = bootApp({ rpcResult: () => ({ ok: false, error: { code, message: code } }) })
    const { S, onFrame } = s.window.__dsh, c = chatWithQueue(S, 'failure')
    onFrame({ t: 'queue', s: c.id, items: [{ id: 'm1', place: 'queued', text: '保留' }] })
    tapQueue(s, 'unqueue', 'm1')
    await new Promise(r => setImmediate(r))
    assert.equal(c.queue.length, 1)
    assert.match(s.els.get('toast').textContent, /操作未完成/)
  }
})

test('reconnection clears obsolete queue rows even when the host sends no empty baseline', () => {
  const s = bootApp(), { S, onFrame } = s.window.__dsh, c = chatWithQueue(S, 'reconnect')
  onFrame({ t: 'queue', s: c.id, items: [{ id: 'old', place: 'queued', text: '电脑已删除' }] })
  onFrame({ t: 'hello' })
  assert.equal(c.queue.length, 0)
})

test('queue baselines arrive before history and for chats that have never been opened', () => {
  const s = bootApp(), { S, onFrame } = s.window.__dsh
  onFrame({ t: 'queue', s: 'unopened', items: [{ id: 'm1', place: 'queued', text: '先到的队列', editText: '先到的队列' }] })
  assert.equal(S.chats.get('unopened')?.queue[0].id, 'm1')
  S.chats.get('unopened').loading = true
  onFrame({ t: 'queue', s: 'unopened', items: [] })
  assert.equal(S.chats.get('unopened').queue.length, 0)
})

test('a late edit receipt cannot dismiss a newer editor', async () => {
  let settle, back = 0
  const s = bootApp({ rpcResult: () => new Promise(r => { settle = r }) })
  s.history.back = () => { back++ }
  const { S, onFrame } = s.window.__dsh, c = chatWithQueue(S, 'edit-owner')
  onFrame({ t: 'queue', s: c.id, items: ['m1', 'm2'].map(id => ({ id, place: 'queued', text: id, editText: id })) })
  tapQueue(s, 'qedit', 'm1'); s.els.get('qe').value = 'A的修改'
  s.els.get('sheet').onclick({ target: { closest: sel => sel === '[data-qsave]' ? {} : null } })
  await new Promise(r => setImmediate(r))
  tapQueue(s, 'qedit', 'm2'); s.els.get('qe').value = 'B未保存的草稿'
  settle({ ok: true, value: { accepted: true } })
  await new Promise(r => setImmediate(r))
  assert.equal(back, 0)
  assert.equal(s.els.get('qe').value, 'B未保存的草稿')
})

function resultChat(s, id = 'results', running = false) {
  const { S } = s.window.__dsh, c = chatWithQueue(S, id, running)
  c.w = 'w-results'; S.byId[id].w = c.w
  S.wsById[c.w] = { path: 'D:\\视频项目', title: '视频项目' }
  return c
}
function tapResult(s, selector, dataset) {
  s.els.get('scroller').dispatch('click', { target: { closest: sel => sel === selector ? { dataset } : null }, preventDefault() {} })
}
const rendered = () => new Promise(r => setTimeout(r, 10))

const latestResponse = () => ({ status: 200, json: () => Promise.resolve({ ok: true, value: { versionName: '1.4.0', versionCode: 140 } }) })
const tapUiUpdate = s => s.els.get('rows').dispatch('click', { target: { closest: selector => selector === '[data-ui-update]' ? {} : null } })

for (const [kind, remote] of [['CSS', UI_NEW], ['JS', uiShell({ js: 'window.fixture = 2;' })], ['HTML', uiShell({ content: '<aside>new content</aside>' })]]) {
  test(`existing-server ${kind} changes are discovered without a revision meta or custom header`, async () => {
    const s = bootApp({ uiResult: () => shellResponse(remote, '"new"') })
    s.window.__dsh.S.booted = true
    await rendered()
    assert.equal(s.uiGetCalls.length, 1)
    assert.equal(s.headCalls.length, 0, 'startup compares HTML before using HEAD shortcuts')
    assert.equal(s.uiGetCalls[0].opts.method, 'GET')
    assert.equal(s.uiGetCalls[0].opts.cache, 'no-store')
    assert.equal(s.uiGetCalls[0].opts.redirect, 'manual')
    assert.equal(s.window.__dsh.S.uiUpdate, true)
    assert.match(s.els.get('rows').innerHTML, /界面有更新，点这里更新/)
    assert.equal(s.appLatestCalls.length, 0)
    assert.equal(s.reloadCount(), 0)
  })
}

test('HTML comparison normalizes parser-tail whitespace and keeps the pre-mutation loaded snapshot', async () => {
  const live = uiShell({ content: '<p>runtime conversation DOM</p>' })
  const s = bootApp({ liveHtml: live.snapshot })
  await rendered()
  assert.equal(s.uiGetCalls.length, 1)
  assert.ok(!s.window.__dsh.S.uiUpdate, 'identical shell with parser-added tail whitespace is not an update')
  assert.equal(s.document.documentElement.outerHTML, live.snapshot)
  assert.ok(s.parseCalls.some(call => call.source === UI_BASE.snapshot), 'normalization uses the snapshot captured before page mutations')
  assert.ok(!s.parseCalls.some(call => call.source === live.snapshot), 'runtime DOM must never become the loaded baseline')
})

test('unchanged ETag costs only HEAD and changed ETag compares GET HTML using the GET response ETag', async () => {
  let etag = '"base"'
  const s = bootApp({ uiResult: ({ opts }) => shellResponse(UI_BASE, opts.method === 'GET' && etag === '"head-B"' ? '"get-C"' : etag) })
  await rendered()
  s.advance(60000); s.runInterval(60000); await rendered()
  assert.equal(s.headCalls.length, 1); assert.equal(s.uiGetCalls.length, 1)
  etag = '"head-B"'; s.advance(60000); s.dispatchWindow('online'); await rendered()
  assert.equal(s.uiGetCalls.length, 2)
  assert.ok(!s.window.__dsh.S.uiUpdate, 'ETag alone does not prove different normalized HTML')
  etag = '"get-C"'; s.advance(60000); s.dispatchWindow('online'); await rendered()
  assert.equal(s.headCalls.length, 3); assert.equal(s.uiGetCalls.length, 2, 'remember the GET ETag, not the earlier HEAD ETag')
})

test('login, gateway, wrong MIME and invalid shell responses neither raise nor clear UI reminders', async () => {
  const invalid = [shellResponse(UI_NEW, '"bad"', 401), { status: 0, type: 'opaqueredirect' }, shellResponse(UI_NEW, '"bad"', 503),
    shellResponse(UI_NEW, '"bad"', 200, 'text/plain'), shellResponse(uiShell({ title: 'Login' }), '"bad"'), shellResponse(uiShell({ marker: false }), '"bad"')]
  for (const reply of invalid) {
    const s = bootApp({ uiResult: () => reply })
    await rendered(); assert.ok(!s.window.__dsh.S.uiUpdate); assert.equal(s.reloadCount(), 0)
  }
  let reply = shellResponse(UI_NEW, '"new"')
  const s = bootApp({ uiResult: () => reply })
  await rendered()
  const toast = s.els.get('toast').textContent, status = s.window.__dsh.S.status
  for (const failure of invalid) {
    reply = failure; s.advance(60000); s.dispatchWindow('online'); await rendered()
    assert.equal(s.window.__dsh.S.uiUpdate, true)
    assert.equal(s.els.get('toast').textContent, toast); assert.equal(s.window.__dsh.S.status, status); assert.equal(s.reloadCount(), 0)
  }
  reply = shellResponse(UI_BASE, '"bad"'); s.advance(60000); s.dispatchWindow('online'); await rendered()
  assert.equal(s.window.__dsh.S.uiUpdate, null, 'failed GETs did not commit the observed HEAD ETag; the same ETag can be retried')
})

test('UI and APK failures recover together and keep distinct home actions', async () => {
  let fail = true
  const s = bootApp({ userAgent: 'DSHApp/1.3.2+132', uiResult: () => fail ? Promise.reject(new Error('offline')) : shellResponse(UI_NEW, '"new"'),
    appLatestResult: () => fail ? Promise.reject(new Error('offline')) : latestResponse() })
  s.window.__dsh.S.booted = true
  await rendered()
  assert.equal(s.uiGetCalls.length, 1); assert.equal(s.appLatestCalls.length, 1)
  fail = false; s.advance(60000); s.dispatchWindow('online'); await rendered()
  assert.equal(s.uiGetCalls.length, 2); assert.equal(s.appLatestCalls.length, 2)
  assert.equal(s.window.__dsh.S.uiUpdate, true)
  assert.equal(s.window.__dsh.S.appUpdate.versionName, '1.4.0')
  assert.match(s.els.get('rows').innerHTML, /界面有更新，点这里更新/)
  assert.match(s.els.get('rows').innerHTML, /App 安装包有新版本/)
  assert.equal(s.reloadCount(), 0); assert.ok(!s.location.href.startsWith('dshapp:'))
})

test('HTML probes share in-flight work across lifecycle events and one 60 second throttle', async () => {
  let first
  const s = bootApp({ uiResult: ({ opts }) => opts.method === 'GET' ? new Promise(resolve => { first = resolve }) : shellResponse() })
  await rendered(); s.advance(120000)
  s.dispatchWindow('online'); s.dispatchDocument('visibilitychange'); s.runInterval(60000)
  assert.equal(s.uiCalls.length, 1, 'a slow request crossing the throttle window still cannot overlap')
  first(shellResponse()); await rendered()
  s.dispatchWindow('online'); s.dispatchDocument('visibilitychange'); s.runInterval(60000); await rendered()
  assert.equal(s.uiCalls.length, 2)
  s.advance(59999); s.dispatchWindow('online'); s.runInterval(60000); assert.equal(s.uiCalls.length, 2)
  s.advance(1); s.runInterval(60000); await rendered()
  assert.equal(s.uiCalls.length, 3); assert.equal(s.uiGetCalls.length, 1)
})

test('HTML and APK update checks wait while hidden or offline and resume visibly online', async () => {
  for (const initial of [{ visibility: 'hidden' }, { online: false }]) {
    const s = bootApp({ ...initial, userAgent: 'DSHApp/1.3.2+132', uiResult: () => shellResponse(UI_NEW, '"new"') })
    await rendered(); s.dispatchWindow('online'); s.runInterval(60000); await rendered()
    assert.equal(s.uiCalls.length, 0); assert.equal(s.appLatestCalls.length, 0)
    s.document.visibilityState = 'visible'; s.navigator.onLine = true
    s.dispatchDocument('visibilitychange'); await rendered()
    assert.equal(s.uiGetCalls.length, 1); assert.equal(s.appLatestCalls.length, 1)
  }
})

test('rollback to the fixed loaded HTML clears the reminder but errors retain it and unchanged state does not repaint', async () => {
  let reply = shellResponse(UI_NEW, '"new"')
  const s = bootApp({ uiResult: () => reply }); const S = s.window.__dsh.S
  S.booted = true; await rendered(); assert.equal(S.uiUpdate, true)
  reply = shellResponse(UI_BASE, '"rollback"'); s.advance(60000); s.dispatchWindow('online'); await rendered()
  assert.equal(S.uiUpdate, null); assert.ok(!s.els.get('rows').innerHTML.includes('data-ui-update'))
  let html = s.els.get('rows').innerHTML, writes = 0
  Object.defineProperty(s.els.get('rows'), 'innerHTML', { configurable: true, get: () => html, set(value) { html = value; writes++ } })
  s.advance(60000); s.dispatchWindow('online'); await rendered(); assert.equal(writes, 0)
  reply = shellResponse(UI_NEW, '"new-again"'); s.advance(60000); s.dispatchWindow('online'); await rendered()
  assert.equal(S.uiUpdate, true, 'the baseline was not replaced by a previously fetched new shell'); assert.equal(writes, 1)
  s.advance(60000); s.dispatchWindow('online'); await rendered(); assert.equal(writes, 1); assert.equal(s.reloadCount(), 0)
})

test('the home UI update action reuses draft, pending queue and unsent-image reload protection', async () => {
  const s = bootApp({ uiResult: () => shellResponse(UI_NEW, '"new"') }), c = resultChat(s)
  const S = s.window.__dsh.S, replaces = []
  s.history.replaceState = (...args) => replaces.push(args)
  s.els.get('input').value = '返回首页前未发送的草稿'; s.dispatchWindow('popstate', { state: { v: 'home' } })
  S.booted = true; await rendered(); assert.equal(S.cur, null); assert.equal(S.drafts[c.id], '返回首页前未发送的草稿')
  c.queueBusy = { m1: true }; tapUiUpdate(s); assert.equal(s.reloadCount(), 0); assert.match(s.els.get('toast').textContent, /处理中/)
  c.queueBusy = {}; S.att = [{}]; tapUiUpdate(s); assert.equal(s.reloadCount(), 0); assert.match(s.els.get('toast').textContent, /图片/)
  S.att = []; tapUiUpdate(s); assert.equal(s.reloadCount(), 1)
  assert.equal(S.drafts[c.id], '返回首页前未发送的草稿'); assert.equal(replaces.at(-1)[2], '/m/')
})

test('a changed HTML response during playback leaves the actual message player and conversation untouched', async () => {
  let reply
  const s = bootApp({ uiResult: () => new Promise(resolve => { reply = resolve }) }), c = resultChat(s), dom = installVideoDom(s)
  twoVideoTurns(s, c, s.window.__dsh.onFrame); await rendered()
  const v = dom.videos()[1]
  v.currentTime = 8.3; v.paused = false; v._fullscreen = true; v.src = '/unchanged-player'; v.dataset.quality = 'original'
  assert.equal(typeof reply, 'function', 'the initial HTML comparison requested the existing resource')
  reply(shellResponse(UI_NEW, '"new"')); await rendered()
  assert.equal(s.window.__dsh.S.uiUpdate, true); assert.equal(dom.videos()[1], v)
  assert.equal(v.currentTime, 8.3); assert.equal(v.paused, false); assert.equal(v._fullscreen, true)
  assert.equal(v.src, '/unchanged-player'); assert.equal(v.dataset.quality, 'original'); assert.equal(v.playCalls, 0)
  assert.equal(s.window.__dsh.S.cur, c.id); assert.equal(s.reloadCount(), 0)
})

test('a timed out HTML probe releases its gate for the next bounded check', async () => {
  let attempts = 0
  const s = bootApp({ uiResult: ({ opts }) => ++attempts === 1
    ? new Promise((resolve, reject) => opts.signal.addEventListener('abort', () => reject(new Error('aborted')))) : shellResponse(UI_NEW, '"new"') })
  await rendered(); assert.equal(s.uiGetCalls.length, 1)
  s.fireTimeouts(8000); await rendered(); assert.equal(s.uiGetCalls[0].opts.signal.aborted, true)
  s.advance(60000); s.dispatchWindow('online'); await rendered()
  assert.equal(s.uiGetCalls.length, 2); assert.equal(s.window.__dsh.S.uiUpdate, true); assert.equal(s.reloadCount(), 0)
})

test('missing ETag keeps comparison available instead of becoming an update marker', async () => {
  let remote = UI_BASE
  const s = bootApp({ uiResult: () => shellResponse(remote, null) })
  await rendered(); assert.ok(!s.window.__dsh.S.uiUpdate)
  remote = UI_NEW; s.advance(60000); s.dispatchWindow('online'); await rendered()
  assert.equal(s.headCalls.length, 1); assert.equal(s.uiGetCalls.length, 2)
  assert.equal(s.window.__dsh.S.uiUpdate, true)
})

test('completed turns show the final result and keep commentary and tools behind one process', async () => {
  const s = bootApp(), c = resultChat(s), { onFrame } = s.window.__dsh
  for (const it of [
    { k: 'u', seq: 1, text: '切好视频' },
    { k: 'a', seq: 2, text: '正在分析镜头', think: '内部思考内容' },
    { k: 't', seq: 3, id: 'cut', title: 'ffmpeg 运行细节', detail: '处理日志', done: true },
    { k: 'a', seq: 4, text: '三条切片已完成', think: '最终思考内容' },
    { k: 'end', seq: 5, reason: 'completed' },
  ]) onFrame({ t: 'item', s: c.id, it })
  await rendered()
  let html = s.els.get('msgs').innerHTML
  assert.match(html, /三条切片已完成/)
  assert.equal((html.match(/data-process=/g) || []).length, 1)
  for (const hidden of ['正在分析镜头', 'ffmpeg 运行细节', '内部思考内容', '最终思考内容']) assert.ok(!html.includes(hidden), hidden)
  tapResult(s, '[data-process]', { process: '2' })
  html = s.els.get('msgs').innerHTML
  assert.match(html, /正在分析镜头/)
  assert.match(html, /ffmpeg 运行细节/)
  assert.match(html, /aria-expanded="true"/)
  tapResult(s, '[data-process]', { process: '2' })
  assert.ok(!s.els.get('msgs').innerHTML.includes('正在分析镜头'))
})

test('a long completed result folds details but keeps videos and file cards outside', async () => {
  const s = bootApp(), c = resultChat(s), { onFrame } = s.window.__dsh
  const text = '成片已完成 <检查>。\n\n' + '详细检查说明'.repeat(105) + '\n\n' +
    '[成片](<D:/视频项目/交付/成片 01.mp4>)\n' +
    '[同一成片](<D:/视频项目/交付/成片 01.mp4>)\n' +
    '`D:\\视频项目\\交付\\说明.md`\n`D:\\别的项目\\外部.md`'
  onFrame({ t: 'item', s: c.id, it: { k: 'a', seq: 1, text } })
  onFrame({ t: 'item', s: c.id, it: { k: 'end', seq: 2, reason: 'completed' } })
  await rendered()
  const html = s.els.get('msgs').innerHTML
  assert.match(html, /class="result-excerpt">成片已完成 &lt;检查&gt;。<\/div>/)
  assert.match(html, /<details class="result-details" data-result-details="1"><summary>查看完整结果<\/summary>/)
  assert.match(html.slice(html.indexOf('<details'), html.indexOf('</details>')), /详细检查说明/)
  const visibleCards = html.slice(html.indexOf('</details>') + '</details>'.length)
  assert.equal((visibleCards.match(/<video /g) || []).length, 1, 'deduplicated existing path registry')
  assert.match(visibleCards, /data-result-path="D:\\视频项目\\交付\\说明.md"/)
  assert.ok(!visibleCards.includes('别的项目'))
  assert.equal(s.rpcCalls.length, 0)
})

test('line-heavy completed results fold; short, failed and interrupted answers stay open', async () => {
  for (const [reason, text, folded] of [
    ['completed', Array.from({ length: 13 }, (_, i) => '检查项 ' + i).join('\n'), true],
    ['completed', '两条视频已完成。', false],
    ['failed', '错误细节'.repeat(160), false],
    ['interrupted', '未完成事项'.repeat(160), false],
  ]) {
    const s = bootApp(), c = resultChat(s), { onFrame } = s.window.__dsh
    onFrame({ t: 'item', s: c.id, it: { k: 'a', seq: 1, text } })
    onFrame({ t: 'item', s: c.id, it: { k: 'end', seq: 2, reason } })
    await rendered()
    assert.equal(s.els.get('msgs').innerHTML.includes('data-result-details'), folded, reason)
  }
})

test('native result toggle saves state without rendering and copying still returns all text', async () => {
  const s = bootApp(), c = resultChat(s), { onFrame } = s.window.__dsh
  const text = '切片已完成。\n\n' + '完整内容'.repeat(160)
  for (const it of [
    { k: 'a', seq: 1, text: '处理过程' },
    { k: 'a', seq: 2, text },
    { k: 'end', seq: 3, reason: 'completed' },
  ]) onFrame({ t: 'item', s: c.id, it })
  await rendered()
  const msgs = s.els.get('msgs'), toggle = msgs.listeners.toggle[0]
  assert.equal(toggle.o, true, 'native toggle is captured')
  const untouched = msgs.innerHTML
  msgs.dispatch('toggle', { target: { tagName: 'DETAILS', dataset: { resultDetails: '2' }, open: true } })
  assert.equal(msgs.innerHTML, untouched, 'toggle must not replace the DOM containing players')
  assert.ok(c.resultOpen.has(2))
  tapResult(s, '[data-process]', { process: '1' })
  assert.match(msgs.innerHTML, /data-result-details="2" open>/, 'unrelated redraw restores expansion')
  const expanded = msgs.innerHTML
  msgs.dispatch('toggle', { target: { tagName: 'DETAILS', dataset: { resultDetails: '2' }, open: false } })
  assert.equal(msgs.innerHTML, expanded)
  assert.ok(!c.resultOpen.has(2))
  tapResult(s, '[data-process]', { process: '1' })
  assert.match(msgs.innerHTML, /data-result-details="2">/)
  let copied
  s.navigator.clipboard = { writeText: value => { copied = value; return Promise.resolve() } }
  tapResult(s, '[data-copymsg]', { copymsg: '2' })
  assert.equal(copied, text)
})

test('a live turn keeps streamed commentary compact while approval stays visible', async () => {
  const s = bootApp(), c = resultChat(s, 'live-result', true), { onFrame } = s.window.__dsh
  onFrame({ t: 'd', s: c.id, p: [[1, '不要让我读这段流式分析']] })
  onFrame({ t: 'ask', s: c.id, id: 'confirm', title: '需要用户确认', detail: '保留这项确认' })
  await rendered()
  assert.ok(!s.els.get('tail').innerHTML.includes('不要让我读'))
  assert.match(s.els.get('tail').innerHTML, /运行中/)
  assert.match(s.els.get('dock').innerHTML, /保留这项确认/)
})

test('local video links produce an inline player; Windows, spaces and file URI resolve safely', async () => {
  const s = bootApp(), c = resultChat(s), { onFrame } = s.window.__dsh
  const text = '[成片](<D:/视频项目/交付/成片 01.mp4>)\n' +
    '`D:\\视频项目\\交付\\说明.md`\n' +
    '[切片](file:///D:/视频项目/交付/切片%2002.mp4)\n' +
    '文件 D:\\视频项目\\交付\\审片.html\n' +
    'https://example.com/video.mp4\n' +
    '`D:\\别的项目\\外部.mp4`\n' +
    '[bad](javascript:alert(1)) <img onerror=alert(1)>\n' +
    '`../outside.mp4`'
  onFrame({ t: 'item', s: c.id, it: { k: 'a', seq: 1, text } })
  onFrame({ t: 'item', s: c.id, it: { k: 'end', seq: 2, reason: 'completed' } })
  await rendered()
  const html = s.els.get('msgs').innerHTML
  assert.equal((html.match(/<video /g) || []).length, 2)
  assert.match(html, /preload="none"/)
  assert.match(html, /data-open-video="D:\/视频项目\/交付\/成片 01.mp4"/)
  assert.match(html, /data-result-path="D:\\视频项目\\交付\\说明.md"/)
  assert.match(html, /data-result-path="D:\\视频项目\\交付\\审片.html"/)
  assert.match(html, /href="https:\/\/example.com\/video.mp4"/)
  assert.ok(!html.includes('data-open-video="D:\\别的项目'))
  assert.ok(!html.includes('data-open-video="../'))
  assert.ok(!html.includes('<img onerror='))
  assert.ok(!html.includes('href="javascript:'))
})

test('a file path opens its parent folder and highlights the delivered file', async () => {
  const s = bootApp({ readResult: url => {
    const p = new URL(url, 'http://test').searchParams.get('path')
    return { ok: true, value: p === '交付/说明.md'
      ? { kind: 'text', rel: '交付/说明.md', name: '说明.md', text: '文件内容', size: 8, at: 0 }
      : { kind: 'dir', rel: '交付', entries: [{ name: '说明.md', dir: false, size: 8, at: 0 }] } }
  } }), c = resultChat(s)
  tapResult(s, '[data-result-path]', { resultPath: '交付/说明.md' })
  await rendered()
  assert.equal(s.readCalls.length, 2)
  assert.equal(new URL(s.readCalls[1], 'http://test').searchParams.get('path'), '交付')
  assert.match(s.els.get('fvBody').innerHTML, /class="row selected"/)
  assert.equal(s.els.get('fvTitle').textContent, '交付')
  assert.ok(!s.els.get('fvBody').innerHTML.includes('文件内容'))
})

test('result paths reject commands, domains and slash prose while keeping explicit files and directories', async () => {
  const s = bootApp(), c = resultChat(s), { onFrame } = s.window.__dsh
  const noise = ['begin.py --help', 'cp.kuaishou.com', 'cp.kuaishou.com/upload.mp4', 'acquire',
    'acquire/preflight.py/原生检查', '下载/预览', '3/≤3', '≤3', '3', '不存在假文本', 'python tools/preflight.py',
    'D:/视频项目/tools/preflight.py acquire', 'tools/preflight.py acquire']
  const text = '这是路径识别检查。\n\n' + noise.map(x => '`' + x + '`').join('\n') + '\n' +
    '普通文本 acquire/preflight.py/原生检查\n普通命令 python tools/preflight.py\n相对命令 tools/begin.py --help\n无参数名命令 tools/preflight.py acquire\n' +
    '[相对文件](delivery/说明.md)\n[目录](delivery/)\n[证据目录](evidence/Bjoint/)\n[明确目录](./Bjoint)\n' +
    '[安装包](delivery/DSH.apk)\n[文档](delivery/审片.pdf)\n' +
    '[中文视频](<D:/视频项目/交付/真实 成片.mp4>)\n' +
    '[工作区外](<D:/别的项目/不可访问.mp4>)\n' +
    '[bad](javascript:alert(1)) <img onerror=alert(1)>'
  onFrame({ t: 'item', s: c.id, it: { k: 'a', seq: 1, text } })
  onFrame({ t: 'item', s: c.id, it: { k: 'end', seq: 2, reason: 'completed' } })
  await rendered()
  const html = s.els.get('msgs').innerHTML
  const paths = [...html.matchAll(/data-(?:result-path|open-video|artifact)="([^"]+)"/g)].map(m => m[1])
  assert.deepEqual([...new Set(paths)].sort(), ['delivery/说明.md', 'delivery/', 'evidence/Bjoint/', './Bjoint', 'delivery/DSH.apk', 'delivery/审片.pdf', 'D:/视频项目/交付/真实 成片.mp4'].sort())
  for (const n of noise) assert.ok(html.includes(n), 'unrecognized expressions remain text: ' + n)
  assert.ok(!html.includes('<img onerror='))
  assert.ok(!html.includes('href="javascript:'))
  assert.equal(s.readCalls.length, 0, 'recognition does not probe filesystem per log token')
  assert.equal(s.rpcCalls.length, 0)
})

test('one message deduplicates Windows slash, case and workspace-relative video paths', async () => {
  const s = bootApp(), c = resultChat(s), { onFrame } = s.window.__dsh
  const text = '[A](<D:/视频项目/交付/成片 01.mp4>)\n' +
    '[B](<d:\\视频项目\\交付\\成片 01.MP4>)\n' +
    '[C](<交付/成片 01.mp4>)\n[同一文件](<./交付/成片 01.mp4>)\n' +
    '[说明一](<D:/视频项目/交付/说明.md>)\n[说明二](<交付\\说明.MD>)\n\n' + '详细说明'.repeat(160)
  onFrame({ t: 'item', s: c.id, it: { k: 'a', seq: 1, text } })
  onFrame({ t: 'item', s: c.id, it: { k: 'end', seq: 2, reason: 'completed' } })
  await rendered()
  const html = s.els.get('msgs').innerHTML
  assert.equal((html.match(/<video /g) || []).length, 1)
  assert.equal((html.match(/class="artifact artifact-file"/g) || []).length, 1)
  const links = [...html.matchAll(/data-open-video="([^"]+)"/g)].map(m => m[1])
  assert.deepEqual([...new Set(links)], ['D:/视频项目/交付/成片 01.mp4'], 'all aliases target the first registered player')
})

test('POSIX result path deduplication preserves case-sensitive filenames', async () => {
  const s = bootApp(), c = resultChat(s), { S, onFrame } = s.window.__dsh
  S.wsById[c.w].path = '/workspace/video'
  const text = '[大写文件](/workspace/video/delivery/A.mp4)\n' +
    '[小写文件](delivery/a.mp4)\n[大写别名](./delivery/A.mp4)'
  onFrame({ t: 'item', s: c.id, it: { k: 'a', seq: 1, text } })
  onFrame({ t: 'item', s: c.id, it: { k: 'end', seq: 2, reason: 'completed' } })
  await rendered()
  const html = s.els.get('msgs').innerHTML
  assert.equal((html.match(/<video /g) || []).length, 2)
  const links = [...html.matchAll(/data-open-video="([^"]+)"/g)].map(m => m[1])
  assert.deepEqual([...new Set(links)], ['/workspace/video/delivery/A.mp4', 'delivery/a.mp4'])
})

test('a code basename is text beside the delivered absolute path, not a second root file', async () => {
  const s = bootApp(), c = resultChat(s), { onFrame } = s.window.__dsh
  const text = '成片 `clip-B-craft-answer-v4.mp4`\n' +
    '[成片路径](<D:/视频项目/_验收/delivery/clip-B-craft-answer-v4.mp4>)\n' +
    '`py.exe` 和 `manifest.json` 只是文件名说明。\n\n' + '详细说明'.repeat(160)
  onFrame({ t: 'item', s: c.id, it: { k: 'a', seq: 1, text } })
  onFrame({ t: 'item', s: c.id, it: { k: 'end', seq: 2, reason: 'completed' } })
  await rendered()
  const html = s.els.get('msgs').innerHTML
  assert.match(html, /<code>clip-B-craft-answer-v4.mp4<\/code>/)
  assert.match(html, /<code>py.exe<\/code>/)
  assert.match(html, /<code>manifest.json<\/code>/)
  assert.equal((html.match(/<video /g) || []).length, 1)
  assert.equal((html.match(/class="artifact artifact-file"/g) || []).length, 0)
  assert.equal(s.readCalls.length, 0)
})

test('explicit Markdown root filenames work and same basenames in distinct paths stay distinct', async () => {
  const s = bootApp(), c = resultChat(s), { onFrame } = s.window.__dsh
  const text = '[根内目标](clip.mp4)\n[另一目录](delivery/clip.mp4)\n' +
    '[同一根内目标](<D:/视频项目/clip.mp4>)\n[说明](report.json)'
  onFrame({ t: 'item', s: c.id, it: { k: 'a', seq: 1, text } })
  onFrame({ t: 'item', s: c.id, it: { k: 'end', seq: 2, reason: 'completed' } })
  await rendered()
  const html = s.els.get('msgs').innerHTML
  assert.equal((html.match(/<video /g) || []).length, 2)
  assert.match(html, /data-open-video="clip.mp4"/)
  assert.match(html, /data-open-video="delivery\/clip.mp4"/)
  assert.match(html, /data-result-path="report.json"/)
})

test('explicit directory clicks remain supported and missing paths are only checked on demand', async () => {
  const s = bootApp({ readResult: url => {
    const p = new URL(url, 'http://test').searchParams.get('path')
    return p === 'delivery/'
      ? { ok: true, value: { kind: 'dir', rel: 'delivery', entries: [] } }
      : { ok: false, error: { message: '文件不存在' } }
  } }), c = resultChat(s), { onFrame } = s.window.__dsh
  onFrame({ t: 'item', s: c.id, it: { k: 'a', seq: 1, text: '[目录](delivery/)\n[未核验文件](delivery/missing.md)' } })
  onFrame({ t: 'item', s: c.id, it: { k: 'end', seq: 2, reason: 'completed' } })
  await rendered()
  assert.equal(s.readCalls.length, 0)
  tapResult(s, '[data-result-path]', { resultPath: 'delivery/' })
  await rendered()
  assert.match(s.els.get('fvBody').innerHTML, /空文件夹/)
  tapResult(s, '[data-result-path]', { resultPath: 'delivery/missing.md' })
  await rendered()
  assert.match(s.els.get('fvBody').innerHTML, /打不开/)
  assert.match(s.els.get('fvBody').innerHTML, /文件不存在/)
  assert.equal(s.readCalls.length, 2)
})

test('updating the UI preserves the text draft and current conversation', () => {
  const s = bootApp(), c = resultChat(s), replaces = []
  let reloads = 0
  s.location.reload = () => reloads++
  s.history.replaceState = (...args) => replaces.push(args)
  s.els.get('input').value = '尚未发送的文字'
  s.els.get('status').onclick()
  assert.match(s.els.get('sheet').innerHTML, /更新界面并重连/)
  s.els.get('sheet').onclick({ target: { closest: sel => sel === '[data-a]' ? { dataset: { a: 'reload' } } : null } })
  assert.equal(reloads, 1)
  assert.equal(s.window.__dsh.S.drafts[c.id], '尚未发送的文字')
  assert.equal(replaces.at(-1)[2], '/m/#results')
})

test('UI update waits for pending message operations and unsent images', () => {
  const s = bootApp(), c = resultChat(s)
  let reloads = 0
  s.location.reload = () => reloads++
  s.els.get('status').onclick()
  const update = () => s.els.get('sheet').onclick({ target: { closest: sel => sel === '[data-a]' ? { dataset: { a: 'reload' } } : null } })
  c.queueBusy = { message: true }; update()
  assert.equal(reloads, 0)
  assert.match(s.els.get('toast').textContent, /处理中/)
  c.queueBusy = {}; s.window.__dsh.S.att = [{}]; update()
  assert.equal(reloads, 0)
  assert.match(s.els.get('toast').textContent, /图片/)
})

test('DSH-only mode clears stale external records and prompts while preserving native ones', async () => {
  const s = bootApp({ agentsResult: { enabled: false, mode: 'pc', sessions: [], asks: [] } })
  const { S, onFrame } = s.window.__dsh
  const external = chatWithQueue(S, 'agent:codex:old')
  external.items = [{ k: 'a', seq: 1, text: 'old external record' }]
  S.chats.set('native', { id: 'native' })
  S.asks.set('external', { s: external.id }); S.asks.set('native', { s: 'native' })
  onFrame({ t: 'hello' })
  await new Promise(r => setImmediate(r))
  assert.equal(S.agents.enabled, false)
  assert.equal(S.chats.has(external.id), false)
  assert.equal(S.chats.has('native'), true)
  assert.equal(S.cur, null)
})

function downloadFixture(userAgent = 'browser', status = 200) {
  const page = bootApp({ userAgent }), c = chatWithQueue(page.__dsh.S, 'download-session', false), calls = [], links = []
  const fetch = page.fetch
  page.fetch = (url, options) => String(url).startsWith('/m/api/raw?') ? (calls.push({ url, options }), Promise.resolve({ ok: status === 200, status })) : fetch(url, options)
  const create = page.document.createElement
  page.document.createElement = tag => { const element = create(tag); if (tag === 'a') element.click = () => links.push({ href: element.href, download: element.download }); return element }
  const note = { hidden: true, textContent: '' }, video = { dataset: { session: c.id, artifact: '成片/完整视频.mp4', quality: 'preview' }, src: '/m/api/raw?quality=preview' }
  const box = { querySelector: selector => selector === 'video' ? video : selector === '.video-download-state' ? note : null }
  const button = { closest: selector => selector === '[data-video-box]' ? box : null }
  return { page, calls, links, note, button, tap() { page.els.get('scroller').dispatch('click', { target: { closest: selector => selector === '[data-video-download]' ? button : null } }) } }
}

test('browser video download always requests attachment original instead of active preview', async () => {
  const v = downloadFixture(); v.tap(); await new Promise(r => setTimeout(r, 10))
  assert.equal(v.calls[0].options.method, 'HEAD'); assert.match(v.calls[0].url, /download=1/)
  assert.doesNotMatch(v.calls[0].url, /quality=preview/)
  assert.equal(v.links.length, 1); assert.equal(v.links[0].href, v.calls[0].url)
  assert.equal(v.links[0].download, '完整视频.mp4')
  assert.match(v.note.textContent, /已请求浏览器下载/); assert.doesNotMatch(v.note.textContent, /完成/)
})

test('Android download waits for native queue and completion receipts and prevents double dispatch', async () => {
  const v = downloadFixture('DSHApp/1.5.3+14'); v.tap(); v.tap(); await new Promise(r => setTimeout(r, 10))
  assert.equal(v.calls.length, 1); assert.equal(v.links.length, 0)
  const bridge = new URL(v.page.location.href), requestId = bridge.searchParams.get('requestId')
  assert.equal(bridge.protocol, 'dshapp:'); assert.equal(bridge.hostname, 'download')
  assert.match(bridge.searchParams.get('url'), /^https:\/\/example.test\/m\/api\/raw\?/)
  assert.match(bridge.searchParams.get('url'), /download=1/)
  v.page.dshDownloadResult({ requestId, status: 'queued' })
  assert.equal(v.button.disabled, true); assert.match(v.note.textContent, /尚未完成/)
  v.page.dshDownloadResult({ requestId, status: 'complete' })
  assert.equal(v.button.disabled, false); assert.match(v.note.textContent, /已保存/)
  v.page.dshDownloadResult({ requestId, status: 'queued' })
  assert.match(v.note.textContent, /已保存/, 'late queue callback cannot downgrade completion')
})

test('old Android download offers explicit APK update without navigating or fetching video', () => {
  const v = downloadFixture('DSHApp/1.5.2+13'); v.tap()
  assert.equal(v.calls.length, 0); assert.match(v.page.els.get('sheet').innerHTML, /data-download-update/)
  assert.doesNotMatch(v.page.location.href, /^dshapp:/)
  v.page.els.get('sheet').onclick({ target: { closest: () => ({}) } })
  assert.equal(v.page.location.href, 'dshapp://update')
})

test('video download preflight errors stay visible and do not start a download', async () => {
  const v = downloadFixture('browser', 403); v.tap(); await new Promise(r => setTimeout(r, 10))
  assert.equal(v.links.length, 0); assert.match(v.note.textContent, /403/)
  assert.equal(v.button.disabled, false); assert.equal(v.button.textContent, '重试下载原视频')
})

test('installed App uses only native download/fullscreen while browser and old App retain one fallback', () => {
  for (const [userAgent, native] of [['DSHApp/1.5.3+14', true], ['DSHApp/1.5.2+13', false], ['browser', false]]) {
    const page = bootApp({ userAgent }), c = resultChat(page)
    c.items = [{ k: 'a', seq: 1, text: '[成片](成片.mp4)' }, { k: 'end', seq: 2, reason: 'completed' }]
    page.__dsh.renderMsgs(c)
    const html = page.els.get('msgs').innerHTML
    assert.match(html, /<video[^>]* controls/)
    assert.equal(html.includes('data-video-download'), !native, userAgent)
    assert.equal(html.includes('data-video-fullscreen'), !native, userAgent)
    assert.equal(html.includes('controlslist="nodownload nofullscreen"'), !native, userAgent)
    assert.match(html, /data-video-quality/)
  }
})

test('native player download receipts show toast without an external download button job', () => {
  const page = bootApp({ userAgent: 'DSHApp/1.5.3+14' })
  page.dshDownloadResult({ requestId: 'native-download', status: 'queued', message: '正在下载原视频，请查看通知' })
  assert.equal(page.els.get('toast').textContent, '正在下载原视频，请查看通知')
  page.dshDownloadResult({ requestId: 'native-download', status: 'complete', message: '原视频已保存到 Downloads/DSH' })
  assert.equal(page.els.get('toast').textContent, '原视频已保存到 Downloads/DSH')
  page.dshDownloadResult({ requestId: 'native-download', status: 'unsupported', message: '应忽略' })
  assert.equal(page.els.get('toast').textContent, '原视频已保存到 Downloads/DSH')
})

test('active voice exposes one finish surface and restores microphone entry after ending', async () => {
  for (const mode of ['draft', 'chat', 'call']) {
    const v = voicePage(); v.start(mode); await new Promise(r => setTimeout(r, 10))
    assert.equal(v.page.els.get('mic').hidden, true, mode)
    assert.equal(v.page.els.get('voiceBar').hidden, mode === 'call', mode)
    assert.equal(v.page.els.get('voiceEnd').hidden, mode === 'draft', mode)
    if (mode === 'draft') assert.equal(v.page.els.get('voiceFinish').textContent, '结束录音')
    if (mode === 'chat') assert.equal(v.page.els.get('voiceFinish').textContent, '说完发送')
    if (mode === 'call') assert.equal(v.page.els.get('callPanel').hidden, false)
    v.page.dshStopVoice(); await new Promise(r => setTimeout(r, 10))
    assert.equal(v.page.els.get('mic').hidden, false, mode)
    assert.equal(v.page.els.get('voiceBar').hidden, true, mode)
  }
})

// Small adapter around the existing makeEl stub, scoped to this regression.
// It only models video DOM movement. No browser, media, network or real data.
function installVideoDom(s, targetId = 'msgs') {
  const msgs = s.els.get(targetId)
  let html = '', slots = []
  const attrValue = x => x.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
  Object.defineProperty(msgs, 'innerHTML', { configurable: true, get: () => html, set(value) {
    html = value
    slots.forEach(box => box.children.forEach(v => { v.isConnected = false }))
    slots = [...value.matchAll(/<video\b([^>]*)>/g)].map((m, index) => {
      const v = makeEl('video'), attributes = {}
      for (const a of m[1].matchAll(/([\w-]+)="([^"]*)"/g)) attributes[a[1]] = attrValue(a[2])
      v.attributes = attributes
      for (const [k, value] of Object.entries(attributes)) if (k.startsWith('data-')) v.dataset[k.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = value
      v.paused = true; v.currentTime = 0; v.isConnected = true; v._fullscreen = false; v._preparing = false; v._previewError = false; v._positionPending = false; v._resumePosition = 0; v.error = null; v._generation = 0; v.playCalls = 0; v.duration = 60
      v.play = () => { v.playCalls++; v.paused = false; return Promise.resolve() }
      v.pause = () => { v.paused = true }
      v.load = () => { v.error = null; v.currentTime = 0 }
      const note = { textContent: '' }, qualityButton = { textContent: '' }, retryButton = { hidden: true, disabled: false }, fullscreenButton = { textContent: '全屏' }
      const box = {
        slot: index, children: [v], classList: makeEl().classList,
        querySelector(selector) { return selector === 'video' ? this.children[0] || null : selector === '.video-note' ? note : selector === '[data-video-quality]' ? qualityButton : selector === '[data-video-retry]' ? retryButton : selector === '[data-video-fullscreen]' ? fullscreenButton : null },
        removeChild(child) { this.children.splice(this.children.indexOf(child), 1); child.parentNode = null },
        replaceChild(old, current) {
          if (old.parentNode) old.parentNode.removeChild(old)
          const at = this.children.indexOf(current)
          assert.notEqual(at, -1, 'placeholder is still in destination')
          this.children[at] = old; current.parentNode = null; old.parentNode = this; old.isConnected = true
        },
      }
      qualityButton.closest = retryButton.closest = fullscreenButton.closest = selector => selector === '[data-video-box]' ? box : null
      v.parentNode = box
      v.closest = selector => selector === '[data-video-box]' ? v.parentNode : null
      return box
    })
  } })
  msgs.querySelectorAll = selector => selector === 'video[data-artifact]' ? slots.flatMap(box => box.children) : []
  msgs.querySelector = selector => selector === 'video' ? slots[0]?.children[0] || null : null
  return { get slots() { return slots }, videos: () => slots.flatMap(box => box.children) }
}

function twoVideoTurns(s, c, onFrame) {
  const text = '[交付视频](<D:/视频项目/delivery/shared.mp4>)'
  for (const it of [
    { k: 'u', seq: 1, text: '第一轮' }, { k: 'a', seq: 2, text: '第一轮过程 ' + text },
    { k: 'a', seq: 3, text }, { k: 'end', seq: 4, reason: 'completed' },
    { k: 'u', seq: 5, text: '第二轮' }, { k: 'a', seq: 6, text: '第二轮过程' },
    { k: 'a', seq: 7, text }, { k: 'end', seq: 8, reason: 'completed' },
  ]) onFrame({ t: 'item', s: c.id, it })
}

for (const firstProgress of [false, true]) for (const secondPaused of [false, true]) {
  test(`history reuse retains the second video's slot (firstProgress=${firstProgress}, secondPaused=${secondPaused})`, async () => {
    const s = bootApp(), c = resultChat(s), { onFrame } = s.window.__dsh, dom = installVideoDom(s)
    twoVideoTurns(s, c, onFrame)
    await rendered()
    assert.equal(dom.videos().length, 2)
    const [first, second] = dom.videos()
    if (firstProgress) { first.currentTime = 4.4; first.dataset.quality = 'preview' }
    second.currentTime = 12.3; second.paused = secondPaused; second.dataset.quality = 'original'
    tapResult(s, '[data-process]', { process: '2' }) // real renderMsgs, no copied implementation
    assert.equal(dom.videos().length, 2, 'each historical result still owns a video')
    assert.equal(dom.slots[1].children[0], second, 'the second result retains its own player node')
    assert.notEqual(dom.slots[0].children[0], second, 'second player never replaces the first result')
    assert.equal(second.currentTime, 12.3)
    assert.equal(second.paused, secondPaused)
    assert.equal(second.dataset.quality, 'original')
    if (firstProgress) assert.equal(dom.slots[0].children[0], first, 'first result retains its progressed node too')
  })
}

test('a paused preview-preparing player at time zero survives a real message render', async () => {
  const s = bootApp(), c = resultChat(s), { onFrame } = s.window.__dsh, dom = installVideoDom(s)
  twoVideoTurns(s, c, onFrame); await rendered()
  const second = dom.videos()[1]
  second._preparing = true; second._generation = 9; second.currentTime = 0; second.paused = true
  tapResult(s, '[data-process]', { process: '2' })
  assert.equal(dom.videos().length, 2)
  assert.equal(dom.slots[1].children[0], second)
  assert.equal(second._preparing, true)
  assert.equal(second._generation, 9)
  assert.equal(second.currentTime, 0)
})

function tapVideoInMessage(s, seq) {
  const owner = { dataset: { messageSeq: String(seq) } }
  const button = { dataset: { openVideo: 'D:/视频项目/delivery/shared.mp4' }, closest: selector => selector === '[data-message-seq]' ? owner : null }
  s.els.get('scroller').dispatch('click', { target: { closest: selector => selector === '[data-open-video]' ? button : null }, preventDefault() {} })
}

test('a video link plays its own completed message player rather than the first historical match', async () => {
  const s = bootApp(), c = resultChat(s), { onFrame } = s.window.__dsh, dom = installVideoDom(s)
  twoVideoTurns(s, c, onFrame); await rendered()
  const [first, second] = dom.videos()
  tapVideoInMessage(s, 7)
  assert.equal(first.playCalls, 0)
  assert.equal(second.playCalls, 1)
})

test('a process link with no player of its own uses the existing file viewer', async () => {
  const s = bootApp({ readResult: () => ({ ok: true, value: { kind: 'media', type: 'video/mp4', rel: 'delivery/shared.mp4', name: 'shared.mp4', size: 20, at: 0 } }) })
  const c = resultChat(s), { onFrame } = s.window.__dsh, dom = installVideoDom(s)
  twoVideoTurns(s, c, onFrame); await rendered()
  tapResult(s, '[data-process]', { process: '2' })
  tapVideoInMessage(s, 2); await rendered()
  assert.ok(dom.videos().every(v => v.playCalls === 0))
  assert.equal(s.readCalls.length, 1)
  assert.equal(new URL(s.readCalls[0], 'http://test').searchParams.get('path'), 'D:/视频项目/delivery/shared.mp4')
})

function previewApi(s) {
  const original = s.fetch, calls = [], pending = []
  s.fetch = (url, opts) => {
    if (!String(url).startsWith('/m/api/video?')) return original(url, opts)
    calls.push(String(url))
    return new Promise((resolve, reject) => pending.push({ resolve, reject }))
  }
  return {
    calls,
    reply(value) { assert.ok(pending.length, 'there is a pending preview request'); pending.shift().resolve({ status: 200, json: () => Promise.resolve({ ok: true, value }) }) },
    fail(code) { assert.ok(pending.length, 'there is a pending preview request'); pending.shift().reject(Object.assign(new Error(code), { code })) },
  }
}
function tapVideoControl(s, box, selector, targetId = 'scroller') {
  const button = box.querySelector(selector)
  s.els.get(targetId).dispatch('click', { target: { closest: wanted => wanted === selector ? button : null }, preventDefault() {} })
}
async function previewChat() {
  const s = bootApp(), c = resultChat(s), dom = installVideoDom(s), api = previewApi(s)
  twoVideoTurns(s, c, s.window.__dsh.onFrame); await rendered()
  return { s, c, dom, api, v: dom.videos()[1], box: dom.slots[1] }
}

test('an expired preview retries only on explicit intent and keeps its position across a second load error', async () => {
  const { s, dom, api, v, box } = await previewChat()
  v.dataset.previewReady = '1'; v.currentTime = 8.2
  v.error = { code: 4 }; v.paused = true; v.onerror()
  v.play = () => { v.playCalls++; return v.error ? Promise.reject(new Error('NotSupportedError without onplay')) : Promise.resolve() }
  assert.equal(api.calls.length, 0, 'MediaError itself makes no API request')
  tapVideoControl(s, box, '[data-video-retry]')
  tapVideoControl(s, box, '[data-video-retry]')
  assert.equal(api.calls.length, 1, 'explicit retry works even if native play never emits onplay, and duplicate clicks merge')
  api.reply({ state: 'ready', url: '/synthetic-expired-preview', original: '/synthetic-original' }); await rendered()
  assert.equal(v.currentTime, 0, 'loading a replacement resets native position before metadata')
  v.error = { code: 4 }; v.onerror()
  tapVideoControl(s, box, '[data-video-retry]')
  assert.equal(api.calls.length, 2, 'another retry is an explicit user action')
  api.reply({ state: 'ready', url: '/synthetic-repaired-preview', original: '/synthetic-original' }); await rendered()
  v.dispatch('loadedmetadata')
  assert.equal(v.currentTime, 8.2, 'desired position survives load -> zero -> MediaError before metadata')
  assert.equal(box.querySelector('[data-video-retry]').hidden, true)
  assert.equal(dom.videos()[1], v)
})

test('the file viewer has the same explicit preview retry without relying on native onplay', async () => {
  const s = bootApp({ readResult: () => ({ ok: true, value: { kind: 'media', type: 'video/mp4', rel: 'delivery/shared.mp4', name: 'shared.mp4', size: 20, at: 0 } }) })
  const c = resultChat(s), dom = installVideoDom(s), viewer = installVideoDom(s, 'fvBody'), api = previewApi(s)
  twoVideoTurns(s, c, s.window.__dsh.onFrame); await rendered()
  tapVideoInMessage(s, 2); await rendered()
  const v = viewer.videos()[0], box = viewer.slots[0]
  assert.ok(v, 'the actual file viewer renders a player')
  v.dataset.previewReady = '1'; v.currentTime = 6.4; v.error = { code: 4 }; v.onerror()
  v.play = () => { v.playCalls++; return v.error ? Promise.reject(new Error('NotSupportedError without onplay')) : Promise.resolve() }
  assert.equal(api.calls.length, 0)
  assert.equal(box.querySelector('[data-video-retry]').hidden, false)
  tapVideoControl(s, box, '[data-video-retry]', 'fvBody')
  tapVideoControl(s, box, '[data-video-retry]', 'fvBody')
  assert.equal(api.calls.length, 1)
  api.reply({ state: 'ready', url: '/synthetic-ready-preview', original: '/synthetic-original' }); await rendered()
  v.dispatch('loadedmetadata')
  assert.equal(v.currentTime, 6.4)
  assert.equal(box.querySelector('[data-video-retry]').hidden, true)
  assert.ok(dom.videos().every(movie => movie.playCalls === 0), 'viewer retry does not touch historical chat players')
})

test('a failed paused preview at time zero retains its node and retry UI through message rendering', async () => {
  const { s, dom, api, v } = await previewChat()
  v.dataset.previewReady = '1'; v.currentTime = 0; v.paused = true; v.error = { code: 4 }; v.onerror()
  assert.equal(api.calls.length, 0)
  v.onplay()
  assert.equal(api.calls.length, 0, 'an error does not create an implicit retry loop')
  tapResult(s, '[data-process]', { process: '2' })
  assert.equal(dom.slots[1].children[0], v, 'the failed zero-position node is still owned by its message')
  const box = dom.slots[1]
  assert.equal(box.querySelector('[data-video-retry]').hidden, false)
  assert.match(box.querySelector('.video-note').textContent, /暂不能播放.*重试预览/)
  assert.equal(api.calls.length, 0, 're-rendering does not prepare a video')
  tapVideoInMessage(s, 7)
  assert.equal(api.calls.length, 1, 'its explicit delivery link can also request a retry')
})

test('a late preview API reply cannot change the user-selected original mode', async () => {
  const { s, api, v, box } = await previewChat()
  v.currentTime = 9.1; v.onplay()
  assert.equal(api.calls.length, 1)
  tapVideoControl(s, box, '[data-video-quality]')
  const originalSrc = v.src
  api.reply({ state: 'ready', url: '/obsolete-preview-response', original: '/synthetic-original' }); await rendered()
  assert.equal(v.dataset.quality, 'original')
  assert.equal(v.src, originalSrc)
  assert.equal(box.querySelector('.video-note').textContent, '原画')
  assert.equal(box.querySelector('[data-video-retry]').hidden, true)
})

test('late metadata and play rejection preserve current mode and honest MediaError UI', async () => {
  const { s, api, v, box } = await previewChat()
  const playRejections = []
  v.play = () => new Promise((resolve, reject) => playRejections.push(reject))
  v.currentTime = 8.2; v.onplay()
  api.reply({ state: 'ready', url: '/synthetic-expired-preview', original: '/synthetic-original' }); await rendered()
  const staleMetadata = v.listeners.loadedmetadata[0].fn
  v.error = { code: 4 }; v.onerror()
  playRejections.shift()(new Error('MediaError rejects after error event')); await rendered()
  assert.match(box.querySelector('.video-note').textContent, /暂不能播放.*重试预览/)
  assert.equal(box.querySelector('[data-video-retry]').hidden, false)
  assert.equal(api.calls.length, 1, 'error and late play rejection do not retry')
  tapVideoControl(s, box, '[data-video-quality]')
  const originalMetadata = v.listeners.loadedmetadata.at(-1).fn
  tapVideoControl(s, box, '[data-video-quality]')
  assert.equal(api.calls.length, 2, 'switching back to preview prepares directly')
  v.currentTime = 2.5
  staleMetadata(); originalMetadata()
  playRejections.shift()(new Error('old original play rejects after next mode')); await rendered()
  assert.equal(v.currentTime, 2.5, 'metadata from obsolete sources cannot seek the new mode')
  assert.equal(box.querySelector('.video-note').textContent, '正在准备流畅预览…', 'old play.catch cannot replace the current preparation note')
  api.reply({ state: 'ready', url: '/synthetic-new-preview', original: '/synthetic-original' }); await rendered()
  v.listeners.loadedmetadata.at(-1).fn()
  assert.equal(v.currentTime, 8.2, 'current metadata restores the intended position')
})

test('normal first play and preview mode switch prepare once while unavailable remains an original fallback', async () => {
  const { s, api, v, box } = await previewChat()
  assert.equal(box.querySelector('[data-video-retry]').hidden, true, 'healthy players do not expose retry')
  v.currentTime = 5.7; v.onplay(); v.onplay()
  assert.equal(api.calls.length, 1)
  api.reply({ state: 'ready', url: '/synthetic-first-preview', original: '/synthetic-original' }); await rendered()
  v.dispatch('loadedmetadata')
  assert.equal(v.currentTime, 5.7)
  v.onplay(); assert.equal(api.calls.length, 1, 'a ready preview does not prepare again')
  tapVideoControl(s, box, '[data-video-quality]')
  v.listeners.loadedmetadata.at(-1).fn()
  tapVideoControl(s, box, '[data-video-quality]')
  assert.equal(api.calls.length, 2, 'switching to preview does not require a new native onplay')
  api.reply({ state: 'unavailable', original: '/synthetic-original-only' }); await rendered()
  assert.equal(v.dataset.quality, 'original')
  assert.equal(v.src, '/synthetic-original-only')
  assert.equal(box.querySelector('[data-video-retry]').hidden, true)
  v.onplay(); assert.equal(api.calls.length, 2, 'unavailable does not automatically requeue an encoder')
})

test('preview request failures wait for explicit retry and not-found still falls back to original', async () => {
  const { s, api, v, box } = await previewChat()
  v.onplay(); api.fail('offline'); await rendered()
  assert.equal(box.querySelector('[data-video-retry]').hidden, false)
  assert.match(box.querySelector('.video-note').textContent, /暂不能播放.*重试预览/)
  v.onplay(); assert.equal(api.calls.length, 1)
  tapVideoControl(s, box, '[data-video-retry]')
  assert.equal(api.calls.length, 2)
  api.fail('not-found'); await rendered()
  assert.equal(v.dataset.quality, 'original')
  assert.match(v.src, /^\/m\/api\/raw\?s=results&path=/)
  assert.equal(box.querySelector('[data-video-retry]').hidden, true)
  v.onplay(); assert.equal(api.calls.length, 2)
})

for (const seekPositions of [[6], [6, 0]]) test(`preview preparation keeps the user's latest seek (${seekPositions.join(' -> ')})`, async () => {
  const { api, v } = await previewChat()
  v.currentTime = 3; v.onplay()
  assert.equal(api.calls.length, 1)
  for (const position of seekPositions) v.currentTime = position
  api.reply({ state: 'ready', url: '/synthetic-seek-preview', original: '/synthetic-original' }); await rendered()
  v.dispatch('loadedmetadata')
  assert.equal(v.currentTime, seekPositions.at(-1), 'preparation leaves the source seekable and captures the latest position when loading')
})

function fullscreenHistory(s, c) {
  const states = [{ v: 'chat', s: c.id }]
  s.history.state = states[0]
  s.history.pushState = state => { states.push(state); s.history.state = state }
  s.history.back = () => { if (states.length > 1) states.pop(); s.history.state = states.at(-1); s.dispatchWindow('popstate', { state: s.history.state }) }
  return states
}

test('explicit fullscreen preserves the active player and native exit closes exactly its overlay', async () => {
  const { s, c, dom, v, box } = await previewChat(), history = fullscreenHistory(s, c)
  let requests = 0
  s.document.fullscreenEnabled = true
  box.requestFullscreen = () => { requests++; s.document.fullscreenElement = box; s.dispatchDocument('fullscreenchange', {}); return Promise.resolve() }
  s.document.exitFullscreen = () => { s.document.fullscreenElement = null; s.dispatchDocument('fullscreenchange', {}); return Promise.resolve() }
  v.currentTime = 7.3; v.paused = false; v.dataset.quality = 'original'
  const source = v.src
  tapVideoControl(s, box, '[data-video-fullscreen]')
  await rendered()
  assert.match(s.els.get('msgs').innerHTML, /data-video-fullscreen/)
  assert.equal(requests, 1)
  assert.equal(history.length, 2)
  assert.equal(box.querySelector('[data-video-fullscreen]').textContent, '退出全屏')
  assert.equal(dom.videos()[1], v)
  assert.equal(v.currentTime, 7.3)
  assert.equal(v.paused, false)
  assert.equal(v.dataset.quality, 'original')
  assert.equal(v.src, source)
  assert.equal(v.playCalls, 0, 'enlarging never restarts the player')
  s.document.fullscreenElement = null; s.dispatchDocument('fullscreenchange', {})
  assert.equal(history.length, 1, 'native Escape/exit removes only the fullscreen history entry')
  assert.equal(s.window.__dsh.S.cur, c.id)
  assert.equal(box.querySelector('[data-video-fullscreen]').textContent, '全屏')
  assert.equal(v.currentTime, 7.3)
})

for (const mode of ['unsupported', 'denied', 'installed-webview']) test(`fullscreen fallback keeps a paused zero-position player and receives frames (${mode})`, async () => {
  const { s, c, dom, v, box } = await previewChat(), history = fullscreenHistory(s, c)
  let requests = 0
  if (mode !== 'unsupported') box.requestFullscreen = () => { requests++; return Promise.reject(new Error('fullscreen denied')) }
  if (mode === 'installed-webview') s.navigator.userAgent = 'Android DSHApp/1.3.2+10302'
  v.currentTime = 0; v.paused = true
  tapVideoControl(s, box, '[data-video-fullscreen]'); await rendered()
  assert.equal(requests, mode === 'denied' ? 1 : 0)
  assert.equal(history.length, 2)
  assert.equal(box.classList.contains('video-expanded'), true, 'viewport expansion remains usable without native fullscreen')
  tapResult(s, '[data-process]', { process: '2' })
  s.window.__dsh.onFrame({ t: 'item', s: c.id, it: { k: 'a', seq: 9, text: '全屏期间的新结果' } })
  s.window.__dsh.onFrame({ t: 'item', s: c.id, it: { k: 'end', seq: 10, reason: 'completed' } }); await rendered()
  assert.equal(dom.videos()[1], v, 'frames must never detach the expanded player')
  assert.ok(c.items.some(it => it.text === '全屏期间的新结果'), 'state still receives the actual frame')
  assert.doesNotMatch(s.els.get('msgs').innerHTML, /全屏期间的新结果/, 'only message DOM rebuilding is deferred')
  s.history.back()
  assert.equal(history.length, 1)
  assert.equal(s.window.__dsh.S.cur, c.id)
  assert.equal(box.classList.contains('video-expanded'), false)
  assert.match(s.els.get('msgs').innerHTML, /全屏期间的新结果/, 'exit paints the received result')
  assert.equal(dom.videos()[1], v, 'exit restores even a paused player at zero to its own message')
  assert.equal(v.currentTime, 0)
  assert.equal(v.paused, true)
  assert.equal(v.playCalls, 0)
})

test('file viewer fullscreen exit and Escape preserve the viewer before its own back level', async () => {
  const s = bootApp({ readResult: () => ({ ok: true, value: { kind: 'media', type: 'video/mp4', rel: 'delivery/shared.mp4', name: 'shared.mp4', size: 20, at: 0 } }) })
  const c = resultChat(s), history = fullscreenHistory(s, c), dom = installVideoDom(s), viewer = installVideoDom(s, 'fvBody')
  twoVideoTurns(s, c, s.window.__dsh.onFrame); await rendered()
  tapVideoInMessage(s, 2); await rendered()
  const v = viewer.videos()[0], box = viewer.slots[0]
  v.currentTime = 4.6; v.paused = true
  assert.equal(history.length, 2)
  tapVideoControl(s, box, '[data-video-fullscreen]', 'fvBody')
  assert.equal(history.length, 3)
  tapVideoControl(s, box, '[data-video-fullscreen]', 'fvBody')
  assert.equal(history.length, 2, 'exit button only closes the fullscreen layer')
  assert.equal(s.els.get('fv').hidden, false)
  assert.equal(viewer.videos()[0], v)
  assert.equal(v.currentTime, 4.6)
  tapVideoControl(s, box, '[data-video-fullscreen]', 'fvBody')
  s.dispatchWindow('keydown', { key: 'Escape' })
  assert.equal(history.length, 2, 'Escape leaves the viewer open too')
  assert.equal(v.currentTime, 4.6)
  assert.equal(v.paused, true)
  s.history.back()
  assert.equal(history.length, 1)
  assert.equal(s.window.__dsh.S.cur, c.id)
  assert.ok(dom.videos().every(movie => movie.playCalls === 0), 'viewer fullscreen never plays a historical message')
})

test('a late fullscreen request cannot reopen an exited overlay', async () => {
  const { s, c, v, box } = await previewChat(), history = fullscreenHistory(s, c)
  let finish, exits = 0
  box.requestFullscreen = () => new Promise(resolve => { finish = resolve })
  s.document.exitFullscreen = () => { exits++; s.document.fullscreenElement = null; return Promise.resolve() }
  v.currentTime = 3.2; v.paused = true
  tapVideoControl(s, box, '[data-video-fullscreen]')
  tapVideoControl(s, box, '[data-video-fullscreen]')
  assert.equal(history.length, 1)
  s.document.fullscreenElement = box; finish(); await rendered()
  assert.equal(exits, 1, 'obsolete successful API request is exited rather than reviving the overlay')
  assert.equal(history.length, 1)
  assert.equal(box.classList.contains('video-expanded'), false)
  assert.equal(box.querySelector('[data-video-fullscreen]').textContent, '全屏')
  assert.equal(v.currentTime, 3.2)
  assert.equal(v.playCalls, 0)
})

test('fullscreen repeated exit intents wait for one asynchronous popstate', async () => {
  const { s, c, box } = await previewChat(), history = fullscreenHistory(s, c)
  let backRequests = 0
  s.history.back = () => { backRequests++ } // browser popstate arrives later
  tapVideoControl(s, box, '[data-video-fullscreen]')
  tapVideoControl(s, box, '[data-video-fullscreen]')
  s.dispatchWindow('keydown', { key: 'Escape' })
  tapVideoControl(s, box, '[data-video-fullscreen]')
  assert.equal(backRequests, 1, 'repeated button/Escape exits cannot retreat to the parent layer')
  history.pop(); s.history.state = history.at(-1); s.dispatchWindow('popstate', { state: s.history.state })
  assert.equal(box.classList.contains('video-expanded'), false)
  assert.equal(s.window.__dsh.S.cur, c.id)
  tapVideoControl(s, box, '[data-video-fullscreen]')
  tapVideoControl(s, box, '[data-video-fullscreen]')
  assert.equal(backRequests, 2, 'a later fullscreen entry gets its own close intent')
})

// Regression cases for the real app.js's native fullscreenchange seam.
// These are DOM/event contract tests. They do not verify Android's icon or host.

for (const pausedAtZero of [false, true]) test(`native controls fullscreen keeps the same connected message player (pausedAtZero=${pausedAtZero})`, async () => {
  const { s, c, dom, v, box } = await previewChat(), history = fullscreenHistory(s, c)
  s.navigator.userAgent = 'Android DSHApp/1.3.2+10302'
  v.currentTime = pausedAtZero ? 0 : 12.3
  v.paused = pausedAtZero
  v.dataset.quality = 'original'
  const source = v.src
  let connected = true, detaches = 0
  Object.defineProperty(v, 'isConnected', { configurable: true, get: () => connected, set(value) { connected = value; if (!value) detaches++ } })

  // Native video controls make the video the fullscreen element, rather than
  // clicking our separate [data-video-fullscreen] button or expanding its box.
  s.document.fullscreenElement = v
  s.dispatchDocument('fullscreenchange', { target: v })
  assert.equal(history.length, 1, 'native fullscreen does not create a second frontend back level')
  s.window.__dsh.onFrame({ t: 'item', s: c.id, it: { k: 'a', seq: 9, text: 'native fullscreen received frame' } })
  s.window.__dsh.onFrame({ t: 'item', s: c.id, it: { k: 'end', seq: 10, reason: 'completed' } })
  await rendered()

  assert.ok(c.items.some(it => it.text === 'native fullscreen received frame'), 'stream state keeps receiving actual frames')
  assert.equal(detaches, 0, 'message repaint must not detach a native fullscreen video even temporarily')
  assert.equal(dom.slots[1], box, 'the fullscreen player box is kept in its existing message')
  assert.equal(dom.videos()[1], v)
  assert.equal(v.currentTime, pausedAtZero ? 0 : 12.3)
  assert.equal(v.paused, pausedAtZero)
  assert.equal(v.src, source)
  assert.equal(v.playCalls, 0)
  assert.doesNotMatch(s.els.get('msgs').innerHTML, /native fullscreen received frame/, 'paint waits for fullscreen exit')

  // Android's native Back is expected to dismiss the host and cause this event.
  // Exercising that native callback and actual hardware Back is a separate test.
  s.document.fullscreenElement = null
  s.dispatchDocument('fullscreenchange', { target: v })
  await rendered()
  assert.match(s.els.get('msgs').innerHTML, /native fullscreen received frame/)
  assert.equal(dom.videos()[1], v, 'exit retains even a paused player at zero')
  assert.equal(v.currentTime, pausedAtZero ? 0 : 12.3)
  assert.equal(v.paused, pausedAtZero)
  assert.equal(v.playCalls, 0)
  assert.equal(history.length, 1, 'native exit leaves the current chat and its back level intact')
  assert.equal(s.window.__dsh.S.cur, c.id)
})

test('installed custom fullscreen switching session never reuses another session video', async () => {
  const { s, c, dom, v, box } = await previewChat(), states = fullscreenHistory(s, c)
  s.history.go = delta => {
    assert.ok(delta < 0)
    states.splice(Math.max(1, states.length + delta))
    s.history.state = states.at(-1)
    s.dispatchWindow('popstate', { state: s.history.state })
  }
  s.navigator.userAgent = 'Android DSHApp/1.3.2+10302'
  v.currentTime = 12.3; v.paused = false
  tapVideoControl(s, box, '[data-video-fullscreen]')
  const other = resultChat(s, 'other-results')
  // resultChat populates a new state and selects it; restore the actual old
  // selection so that dshOpen, rather than the fixture setup, performs the switch.
  s.window.__dsh.S.cur = c.id
  twoVideoTurns(s, other, s.window.__dsh.onFrame)
  s.window.dshOpen(other.id)
  await rendered()
  assert.equal(s.window.__dsh.S.cur, other.id)
  assert.equal(box.classList.contains('video-expanded'), false)
  assert.equal(v._fullscreen, false)
  assert.equal(s.history.state.od, undefined, 'fullscreen overlay is closed before the new chat is pushed')
  assert.equal(dom.videos().length, 2)
  assert.ok(dom.videos().every(movie => movie !== v && movie.dataset.session === other.id), 'same paths and message sequences cannot import the old session player')
  assert.ok(dom.videos().every(movie => movie.currentTime === 0 && movie.playCalls === 0))
})

test('native fullscreen exit after session switch cannot repaint or import the previous video', async () => {
  const { s, c, dom, v } = await previewChat()
  s.navigator.userAgent = 'Android DSHApp/1.3.2+10302'
  const other = resultChat(s, 'other-results')
  s.window.__dsh.S.cur = c.id
  twoVideoTurns(s, other, s.window.__dsh.onFrame)
  v.currentTime = 12.3; v.paused = false
  s.document.fullscreenElement = v
  s.dispatchDocument('fullscreenchange', { target: v })
  s.window.__dsh.onFrame({ t: 'item', s: c.id, it: { k: 'a', seq: 9, text: 'old fullscreen pending result' } })
  await rendered()
  s.window.dshOpen(other.id)
  await rendered()
  // The native host's exit event may arrive after the session navigation.
  s.document.fullscreenElement = null
  s.dispatchDocument('fullscreenchange', { target: v })
  await rendered()
  assert.equal(s.window.__dsh.S.cur, other.id)
  assert.equal(v._fullscreen, false, 'the old native fullscreen state is released')
  assert.ok(dom.videos().every(movie => movie !== v && movie.dataset.session === other.id))
  assert.ok(dom.videos().every(movie => movie.currentTime === 0 && movie.playCalls === 0))
  assert.doesNotMatch(s.els.get('msgs').innerHTML, /old fullscreen pending result/, 'late exit does not paint the previous chat into the new one')
})


test('dictation menu click starts recording without hold and never sends before manual send', async () => {
  const v = voicePage(); v.page.els.get('input').value = '原草稿';
  const ui = holdUi(v, 'draft');
  await new Promise(r => setTimeout(r, 15));
  assert.equal(v.nodes.length, 1);
  assert.equal(ui.button.hidden, true);
  assert.equal(v.page.els.get('input').hidden, false);
  assert.equal(v.page.els.get('voiceFinish').textContent, '结束录音');
  ui.feed(14);
  await new Promise(r => setTimeout(r, 15));
  assert.match(v.page.els.get('input').value, /^原草稿/);
  assert.equal(v.page.rpcCalls.filter(c => c.method === 'session.prompt').length, 0);
  v.page.els.get('voiceFinish').onclick();
  await new Promise(r => setTimeout(r, 20));
  assert.match(v.page.els.get('input').value, /录音转成/);
  assert.equal(v.tracks.stops, 1);
  assert.equal(v.page.rpcCalls.filter(c => c.method === 'session.prompt').length, 0);
  assert.equal(v.calls.some(c => c.url === '/m/api/voice'), false);
  assert.equal(v.page.els.get('voiceBar').hidden, true);
});
function suggestionFixture(){
 const page=bootApp(),c=chatWithQueue(page.__dsh.S,'suggestion-session',false),calls=[]
 c.items=[{k:'u',seq:1,text:'test'},{k:'a',seq:2,text:'done'},{k:'end',seq:3,reason:'completed'}]
 let finish
 page.fetch=(url,opts)=>{if(url!=='/m/api/suggestions')return Promise.reject(Error('offline'));calls.push(opts);return new Promise(r=>{finish=value=>r({status:200,json:async()=>({ok:true,value})})})}
 return {page,c,calls,finish:async(value={text:'下一步建议',revision:'r1'})=>{finish(value);for(let i=0;i<8;i++)await Promise.resolve()}}
}
test('suggestion is grey separate text, explicit acceptance saves draft without sending',async()=>{
 const f=suggestionFixture(),{page}=f;page.__dsh.syncSuggestion();assert.equal(f.calls.length,0);page.fireTimeouts(1000);await f.finish()
 assert.equal(page.els.get('input').value,'');assert.equal(page.els.get('inputSuggestion').textContent,'下一步建议');assert.equal(page.els.get('inputSuggestion').hidden,false)
 page.els.get('inputSuggestion').onclick();assert.equal(page.els.get('input').value,'下一步建议');assert.equal(page.__dsh.S.drafts[f.c.id],'下一步建议');assert.equal(page.rpcCalls.length,0)
})
test('typed draft aborts request and late response cannot overwrite or show',async()=>{
 const f=suggestionFixture();f.page.__dsh.syncSuggestion();f.page.fireTimeouts(1000);const input=f.page.els.get('input');input.value='自己写的';input.dispatch('input');assert.equal(f.calls[0].signal.aborted,true);await f.finish();assert.equal(input.value,'自己写的');assert.equal(f.page.els.get('inputSuggestion').hidden,true)
 input.value='';input.dispatch('input');f.page.fireTimeouts(1000);assert.equal(f.calls.length,1)
})
test('suggestion Tab only accepts focused noncomposing input; Escape dismisses same turn',async()=>{
 const f=suggestionFixture(),p=f.page,input=p.els.get('input');p.__dsh.syncSuggestion();p.fireTimeouts(1000);await f.finish();let prevented=0
 input.dispatch('keydown',{key:'Tab',preventDefault(){prevented++}});assert.equal(prevented,0)
 p.document.activeElement=input;input.dispatch('keydown',{key:'Tab',isComposing:true,preventDefault(){prevented++}});assert.equal(prevented,0)
 input.dispatch('keydown',{key:'Tab',preventDefault(){prevented++}});assert.equal(prevented,1);assert.equal(input.value,'下一步建议')
 const g=suggestionFixture();g.page.__dsh.syncSuggestion();g.page.els.get('input').dispatch('keydown',{key:'Escape'});g.page.__dsh.syncSuggestion();g.page.fireTimeouts(1000);assert.equal(g.calls.length,0)
})
test('approval, attachment, IME, running and hidden page suppress suggestions',()=>{
 for(const guard of ['approval','attachment','ime','running','hidden']){const f=suggestionFixture(),p=f.page
 if(guard==='approval')p.__dsh.S.asks.set('x',{s:f.c.id});if(guard==='attachment')p.__dsh.S.att.push({});if(guard==='ime')p.els.get('input').dispatch('compositionstart');if(guard==='running')p.__dsh.S.run.add(f.c.id);if(guard==='hidden')p.document.visibilityState='hidden'
 p.__dsh.syncSuggestion();p.fireTimeouts(1000);assert.equal(f.calls.length,0,guard)}
})
test('session switch and hidden page discard late suggestions; new completed turn permits new request',async()=>{
 const f=suggestionFixture(),p=f.page;p.__dsh.syncSuggestion();p.fireTimeouts(1000);p.__dsh.S.cur='another';p.__dsh.syncSuggestion();await f.finish();assert.equal(p.els.get('inputSuggestion').hidden,true)
 p.__dsh.S.cur=f.c.id;f.c.items.push({k:'u',seq:4},{k:'a',seq:5,text:'next'},{k:'end',seq:6,reason:'completed'});p.__dsh.syncSuggestion();p.fireTimeouts(1000);assert.equal(f.calls.length,2)
 p.document.visibilityState='hidden';p.dispatchDocument('visibilitychange');assert.equal(f.calls[1].signal.aborted,true);await f.finish();assert.equal(p.els.get('inputSuggestion').hidden,true)
})
test('failed suggestion request is attempted once per completed turn',async()=>{
 const f=suggestionFixture();f.page.fetch=()=>{f.calls.push(1);return Promise.reject(Error('offline'))};f.page.__dsh.syncSuggestion();f.page.fireTimeouts(1000);for(let i=0;i<8;i++)await Promise.resolve()
 f.page.__dsh.syncSuggestion();f.page.fireTimeouts(1000);assert.equal(f.calls.length,1);assert.equal(f.page.els.get('inputSuggestion').hidden,true)
})
test('inside-input suggestion suppresses placeholder then restores original on accept and dismiss',async()=>{
 for(const action of ['accept','dismiss']){const f=suggestionFixture(),p=f.page,input=p.els.get('input');input.placeholder='发消息给 DSH';p.__dsh.syncSuggestion();p.fireTimeouts(1000);await f.finish();assert.equal(input.placeholder,'');assert.equal(input.value,'')
 if(action==='accept')p.__dsh.acceptSuggestion();else p.dispatchWindow('keydown',{key:'Escape'})
 assert.equal(input.placeholder,'发消息给 DSH');assert.equal(p.els.get('inputSuggestion').hidden,true)}
})
test('suggestion wrapper uses textarea sizing and hides with hold UI',()=>{
 const html=fs.readFileSync(new URL('../www/index.html',import.meta.url),'utf8'),css=fs.readFileSync(new URL('../www/app.css',import.meta.url),'utf8')
 assert.match(html,/<div id="inputWrap"[^>]*><textarea id="input"[\s\S]*?<button id="inputSuggestion"[\s\S]*?<\/div>/)
 assert.match(css,/\.input-wrap\[hidden\]\{display:none\}/);assert.match(APP,/el\.input\.hidden = enabled; el\.inputWrap\.hidden = enabled/)
})
test('busy send queues message into dock with 3 choices (修改 / 引导 / 等待) and preserves wait choice across SSE updates',async()=>{
 const page=bootApp(),{S,onFrame}=page.__dsh
 const c=chatWithQueue(S,'s-busy-3way',true)
 const input=page.els.get('input')
 input.value='先别急，我补充一句'
 input.dispatch('input')
 page.els.get('send').onclick()
 await new Promise(r=>setTimeout(r,10))
 assert.equal(page.rpcCalls[0].method,'session.prompt')
 assert.equal(page.rpcCalls[0].payload.mode,'queue')
 onFrame({t:'queue',s:'s-busy-3way',items:[{id:'q1',text:'先别急，我补充一句',editText:'先别急，我补充一句',place:'queue'}]})
 const html1=page.els.get('dock').innerHTML
 assert.match(html1,/data-qedit="q1"[^>]*>[\s\S]*?修改<\/button>/)
 assert.match(html1,/data-steer="q1"[^>]*>[\s\S]*?引导<\/button>/)
 assert.match(html1,/data-qwait="q1"[^>]*>[\s\S]*?等待<\/button>/)
 page.els.get('dock').dispatch('click',{target:{closest:sel=>sel==='[data-qwait]'?{dataset:{qwait:'q1'}}:null}})
 assert.match(page.els.get('dock').innerHTML,/已选等待/)
 onFrame({t:'queue',s:'s-busy-3way',items:[{id:'q1',text:'先别急，我补充一句',editText:'先别急，我补充一句',place:'queue'}]})
 assert.match(page.els.get('dock').innerHTML,/已选等待/)
})

