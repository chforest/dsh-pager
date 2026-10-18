import fs from 'node:fs/promises'
import path from 'node:path'
import {spawn} from 'node:child_process'
import {StringDecoder} from 'node:string_decoder'
import {assertLocalDesktop,createVideoOpener} from './native-video.mjs'
import {ensureFileActionExecutable} from './native-action-helper.mjs'
const fail=(status,message)=>Object.assign(Error(message),{status})
const ACTIONS=new Set(['open','vscode','notepad','open-with','save-as','reveal','capabilities'])
const TEXT_EXT=new Set('.txt .md .markdown .json .jsonl .csv .tsv .log .yaml .yml .xml .ini .toml .conf .css .html .htm'.split(' '))
const OPEN_EXT=new Set('.txt .md .json .csv .tsv .html .htm .pdf .docx .xlsx .pptx .odt .ods .odp .jpg .jpeg .png .webp .gif .bmp .tif .tiff .mp4 .mov .mkv .avi .webm .m4v .mp3 .wav .ogg .flac .m4a .aac'.split(' '))
export function maySystemOpen(file){return OPEN_EXT.has(path.extname(file).toLowerCase())}
export function validateAction(body){
 if(!body||typeof body!=='object'||Array.isArray(body)||Object.keys(body).some(k=>!['sessionId','path','action'].includes(k))||!ACTIONS.has(body.action))throw fail(400,'文件操作参数无效')
 if(body.action==='capabilities')return body
 if(typeof body.sessionId!=='string'||!/^session-[A-Za-z0-9-]+$/.test(body.sessionId)||typeof body.path!=='string'||!body.path||body.path.length>4096||/[\x00-\x1f]/.test(body.path))throw fail(400,'会话或路径无效')
 return body
}
export async function runWindowsAction(payload,{signal,spawnFn=spawn,ensureExecutable=ensureFileActionExecutable,timeoutMs=120000}={}){
 signal?.throwIfAborted()
 const exe=await ensureExecutable()
 signal?.throwIfAborted()
 return new Promise((resolve,reject)=>{
  if(signal?.aborted){reject(fail(499,'操作已取消'));return}
  let child,timer,output='',diagnostic='',stderrTail='',settled=false
  const decoder=new StringDecoder('utf8')
  const finish=(error,value)=>{if(settled)return;settled=true;clearTimeout(timer);signal?.removeEventListener('abort',abort);child?.stdout?.destroy?.();child?.stderr?.destroy?.();child?.stdin?.destroy?.();child?.unref?.();error?reject(error):resolve(value)}
  const receipt=value=>{
   if(!value||value.ok!==true||Object.keys(value).some(k=>!['ok','launched','saved','cancelled','path','size'].includes(k)))return null
   if(value.cancelled===true&&value.saved!==true&&value.launched!==true&&!Object.hasOwn(value,'path')&&!Object.hasOwn(value,'size'))return{cancelled:true}
   if(payload.action==='save-as'&&value.saved===true&&value.cancelled!==true&&value.launched!==true&&typeof value.path==='string'&&path.isAbsolute(value.path)&&Number.isSafeInteger(value.size)&&value.size>=0)return{saved:true,path:value.path,size:value.size}
   if(payload.action!=='save-as'&&value.launched===true&&value.cancelled!==true&&value.saved!==true&&!Object.hasOwn(value,'path')&&!Object.hasOwn(value,'size'))return{launched:true,action:payload.action}
   return null
  }
  const abort=()=>{child?.kill();finish(fail(499,'操作已取消；如已交给外部程序，请核对结果，不要自动重试'))}
  // Explicitly requested GUI: WinExe has no console, and SW_HIDE must not hide its first window.
  try{child=spawnFn(exe,[],{shell:false,windowsHide:false,stdio:['pipe','pipe','pipe']})}catch{finish(fail(503,'无法启动文件操作'));return}
  child.on('error',()=>finish(fail(503,'无法启动文件操作')))
  child.stdout.on('data',part=>{if(settled)return;output+=decoder.write(Buffer.isBuffer(part)?part:Buffer.from(part));if(Buffer.byteLength(output)>16384){child.kill();finish(fail(503,'文件操作返回异常'));return}let value;try{value=JSON.parse(output.replace(/^\uFEFF/,''))}catch{return}const accepted=receipt(value);if(accepted)finish(null,accepted);else finish(fail(503,'文件操作结果未确认；请核对后再试'+diagnostic))})
  child.stderr.on('data',part=>{stderrTail=(stderrTail+part.toString('utf8')).slice(-1024);const match=stderrTail.match(/(?:^|\r?\n)FILE_ACTION_ERROR type=([A-Za-z][A-Za-z0-9]{0,80}) hresult=(-?\d{1,11})(?:\r?\n|$)/);if(match)diagnostic=` (${match[1]}, HRESULT ${match[2]})`})
  child.on('close',()=>{if(!settled)finish(fail(503,'文件操作结果未确认；请核对后再试'+diagnostic))})
  timer=setTimeout(()=>{child.kill();finish(fail(504,'文件操作超时，结果未确认；请勿自动重试'))},timeoutMs)
  signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted){abort();return}
  child.stdin.on('error',()=>finish(fail(503,'文件操作请求未确认')))
  child.stdin.end(JSON.stringify(payload))
 })
}
export function createFileActions({apiPort,playerPath,codePath,fetcher=fetch,stat=fs.stat,realpath=fs.realpath,runHelper=runWindowsAction,videoOpener,platform=process.platform,env=process.env,now=Date.now}={}){
 const video=videoOpener||createVideoOpener({apiPort,playerPath,fetcher,stat,platform})
 const active=new Map(),recent=new Map()
 async function vscodePath(){const choices=[codePath,env.DSH_VSCODE_PATH,env.LOCALAPPDATA&&path.join(env.LOCALAPPDATA,'Programs','Microsoft VS Code','Code.exe'),env.ProgramFiles&&path.join(env.ProgramFiles,'Microsoft VS Code','Code.exe')].filter(Boolean);for(const file of choices){if(!path.isAbsolute(file)||path.extname(file).toLowerCase()!=='.exe')continue;try{if((await stat(file)).isFile())return file}catch{}}return null}
 async function capabilities(){const vscodeFound=!!(await vscodePath());return{supported:platform==='win32',vscodeFound,availableActions:platform==='win32'?['open','notepad','open-with','save-as','reveal',...(vscodeFound?['vscode']:[])]:[],systemOpenExtensions:[...OPEN_EXT],textExtensions:[...TEXT_EXT],receipts:'launched 表示已交给系统或程序，不代表文件已成功显示'} }
 async function perform(body,signal){
  signal?.throwIfAborted()
  const response=await fetcher(`http://127.0.0.1:${apiPort()}/m/api/fs?s=${encodeURIComponent(body.sessionId)}&path=${encodeURIComponent(body.path)}`,{redirect:'error',signal:signal?AbortSignal.any([signal,AbortSignal.timeout(15000)]):AbortSignal.timeout(15000)})
  const out=await response.json();if(!response.ok||!out.ok)throw fail(response.status||403,out.error?.message||'文件路径校验失败')
  const file=out.value,absolute=file?.absolutePath
  if(typeof absolute!=='string'||!path.isAbsolute(absolute)||/[\x00-\x1f]/.test(absolute))throw fail(403,'未获得安全的真实路径')
  const info=await stat(absolute);if(!info.isFile()&&!(['open','reveal'].includes(body.action)&&info.isDirectory()))throw fail(415,'此操作需要普通文件')
  if(path.resolve(await realpath(absolute)).toLowerCase()!==path.resolve(absolute).toLowerCase())throw fail(403,'文件路径发生变化，请刷新后重试')
  signal?.throwIfAborted()
  if(info.isFile()&&['open','open-with'].includes(body.action)&&!maySystemOpen(absolute))throw fail(415,'此文件类型不能直接执行；可用 VS Code 查看或另存为')
  if(body.action==='notepad'&&!TEXT_EXT.has(path.extname(absolute).toLowerCase()))throw fail(415,'记事本仅支持文本文件')
  if(body.action==='open'&&String(file.type||'').startsWith('video/')){const value=await video.open({sessionId:body.sessionId,path:body.path},signal);return{launched:value.opened===true,action:'open',player:'AgentPlay',pid:value.pid}}
  let executable
  if(body.action==='vscode'){executable=await vscodePath();if(!executable)throw fail(503,'未安装或未配置 VS Code')}
  signal?.throwIfAborted()
  return runHelper({action:body.action,path:absolute,...(executable?{executable}:{})},{signal})
 }
 async function execute(body,signal){validateAction(body);if(body.action==='capabilities')return capabilities();if(platform!=='win32')throw fail(403,'仅支持 Windows 本机');
  const key=JSON.stringify([body.sessionId,body.path,body.action]);if(active.has(key))return active.get(key);const previous=recent.get(key);if(previous&&now()-previous.at<2500)return previous.value
  const promise=perform(body,signal);active.set(key,promise);try{const value=await promise;if(!value.cancelled){recent.set(key,{at:now(),value});if(recent.size>100)recent.delete(recent.keys().next().value)}return value}finally{active.delete(key)}
 }
 async function handler(req,res){const controller=new AbortController(),abort=()=>controller.abort(),close=()=>{if(!res.writableEnded)abort()};req.on('aborted',abort);res.on('close',close);const reply=(status,value)=>{if(res.destroyed||res.writableEnded)return;res.writeHead(status,{'content-type':'application/json; charset=utf-8','cache-control':'no-store'});res.end(JSON.stringify(value))};try{assertLocalDesktop(req,platform);if(req.method!=='POST')throw fail(405,'仅支持 POST');if(!/^application\/json\b/i.test(req.headers['content-type']||''))throw fail(415,'需要 JSON 参数');if(Number(req.headers['content-length'])>8192)throw fail(413,'请求过大');let bytes=0,parts=[];for await(const part of req){bytes+=part.length;if(bytes>8192)throw fail(413,'请求过大');parts.push(part)}let body;try{body=JSON.parse(Buffer.concat(parts).toString('utf8'))}catch{throw fail(400,'JSON 参数无效')}reply(200,{ok:true,value:await execute(body,controller.signal)})}catch(error){reply(error.status||500,{ok:false,error:{code:'file-action-failed',message:error.status?error.message:'文件操作未确认，请核对后再试'}})}finally{req.off('aborted',abort);res.off('close',close)}}
 return{handler,execute,capabilities}
}
