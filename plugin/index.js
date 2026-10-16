/**
 * dsh-pager — the phone app's home inside DSH.
 *
 * Mounts one prefix route, /m, on DSH's own web server. Everything the phone
 * needs is served there (see server.js), so whatever already carries DSH's
 * web UI to a remote browser (a VPN, an authenticating gateway) carries this
 * too, with no change to DSH's bind address or source.
 *
 * Remove the `mobile` row from cordis.patch.yml (or this package) and DSH is
 * exactly as before. The desktop UI at / gains only a local native-folder
 * shortcut; its existing layout and directory-browser capability are retained.
 *
 * @module dsh-pager
 */

import { createMobile } from './server.js?suggestions-v1'
import fs from 'node:fs'
import crypto from 'node:crypto'
import path from 'node:path'
import {createRequire} from 'node:module'
import {pathToFileURL} from 'node:url'
import {createScreenshotTranslator} from './screenshot-translate.js'
import {createSuggestions,contextFromAgent} from './suggestions.js'

/** Stable plugin name (Cordis convention). */
export const name = 'mobile'

/** Needs the web server for route registration and its bound port. */
export const inject = ['webServer','llm','agents']

/**
 * Injected into DSH's own page at `/`: the iPhone / iPad home-screen web app
 * lands there after a gateway login that redirects to `/`, and has no address
 * bar to get back to /m/. Only that app moves: `navigator.standalone` exists on
 * Apple devices alone, and a touch screen rules out a Mac's web apps. It must
 * NOT be `display-mode: standalone`: DSH installs as a desktop app too, and its
 * window on the PC would be sent to the phone UI (it was, 2026-09-24).
 */
export const STANDALONE_TO_M = "(function(){try{if(location.pathname==='/'&&navigator.standalone===true&&navigator.maxTouchPoints>0)location.replace('/m/')}catch(e){}})()"

/**
 * @param ctx - Cordis context carrying the injected `webServer`.
 * @param config - optional `{ trustedHosts: string[] }` from the cordis.patch.yml row:
 *   the non-loopback authorities (e.g. a VPN address `100.64.0.5:8080`) this
 *   deployment serves /m on. Mirror what you give DSH's own `connection` row.
 */
export async function apply(ctx, config) {
  const trustedHosts = (config && config.trustedHosts) ?? []
  if (!Array.isArray(trustedHosts)) throw new Error('dsh-pager: trustedHosts must be a list of host[:port] strings')
  const fromHost=createRequire(path.resolve(process.argv[1]))
  const {createUserMessage}=await import(pathToFileURL(fromHost.resolve('@deepseek-ai/dsh-llm')).href)
  const modelForSession=async(sessionId,signal)=>{
    const response=await fetch(`http://127.0.0.1:${ctx.webServer.port}/api/session.models`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({type:'client-request',rpcId:crypto.randomUUID(),method:'session.models',payload:{sessionId}}),signal})
    const result=await response.json();if(!response.ok||!result.result?.ok)throw Object.assign(new Error('无法读取当前聊天模型，请重新打开对话'),{status:409});return result.result.value
  }
  const screenshotTranslate=createScreenshotTranslator({llm:ctx.llm,createUserMessage,modelForSession})
  const suggestions=createSuggestions({llm:ctx.llm,createUserMessage,modelForSession,loadContext:async(sessionId)=>{if(!ctx.agents.get(sessionId))await modelForSession(sessionId);return contextFromAgent(ctx.agents.get(sessionId))}})
  ctx.effect(()=>()=>suggestions.close(),'input suggestions close')
  const mobile = createMobile({
    screenshotTranslate,
    suggestionProvider:suggestions.get,
    apiPort: () => ctx.webServer.port,
    log: (msg) => process.stdout.write(`[dsh-pager] ${msg}\n`),
    trustedHosts,
    pushDir: (config && config.pushDir) || undefined,
    appApk: (config && config.appApk) || undefined,
    externalAgents: config && config.externalAgents !== undefined ? config.externalAgents : false,
    previewDir: config && config.previewDir,
    voiceDir: config && config.voiceDir,
    questionDir: config && config.questionDir,
    ffmpeg: config && config.ffmpeg,
  })
  ctx.effect(() => ctx.webServer.register({ kind: 'prefix', path: '/m', handler: mobile.handle }), 'dsh-mobile: /m route')
  ctx.effect(() => () => mobile.close(), 'dsh-mobile: live streams')
  ctx.on('webserver/index-inject', (table) => {
    table.push({ kind: 'script', placement: 'head', text: STANDALONE_TO_M })
    table.push({ kind: 'script', placement: 'head', text: fs.readFileSync(new URL('./www/desktop.js', import.meta.url), 'utf8') })
  })
}

