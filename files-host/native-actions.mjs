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
function execMac(cmd,args,{signal,spawnFn=spawn,timeoutMs=120000}={}){
 return new Promise((resolve,reject)=>{
  if(signal?.aborted){reject(fail(499,'操作已取消'));return}
  let child,timer,stdout='',stderr='',settled=false
  const finish=(err,val)=>{if(settled)return;settled=true;clearTimeout(timer);signal?.removeEventListener('abort',abort);errorCleanup();err?reject(err):resolve(val)}
  const errorCleanup=()=>{child?.stdout?.destroy?.();child?.stderr?.destroy?.()}
  const abort=()=>{child?.kill();finish(fail(499,'操作已取消'))}
  try{child=spawnFn(cmd,args,{shell:false,stdio:['ignore','pipe','pipe']})}catch{finish(fail(503,'无法启动 macOS 文件操作'));return}
  child.on('error',()=>finish(fail(503,'无法启动 macOS 文件操作')))
  child.stdout.on('data',d=>{stdout+=d.toString('utf8')})
  child.stderr.on('data',d=>{stderr+=d.toString('utf8')})
  child.on('close',code=>finish(null,{code,stdout:stdout.trim(),stderr:stderr.trim()}))
  timer=setTimeout(()=>{child?.kill();finish(fail(504,'文件操作超时'))},timeoutMs)
  signal?.addEventListener('abort',abort,{once:true})
 })
}
export async function runMacAction(payload,{signal,spawnFn=spawn,timeoutMs=120000}={}){
 signal?.throwIfAborted()
 const target=payload.path
 if(payload.action==='open'){
  const {code}=await execMac('/usr/bin/open',[target],{signal,spawnFn,timeoutMs})
  if(code!==0)throw fail(503,'无法使用系统默认程序打开文件')
  return{launched:true,action:'open'}
 }
 if(payload.action==='reveal'){
  const {code}=await execMac('/usr/bin/open',['-R',target],{signal,spawnFn,timeoutMs})
  if(code!==0)throw fail(503,'无法在访达 (Finder) 中显示文件')
  return{launched:true,action:'reveal'}
 }
 if(payload.action==='notepad'){
  const {code}=await execMac('/usr/bin/open',['-a','TextEdit',target],{signal,spawnFn,timeoutMs})
  if(code!==0)throw fail(503,'无法使用文本编辑 (TextEdit) 打开文件')
  return{launched:true,action:'notepad'}
 }
 if(payload.action==='vscode'){
  const exe=payload.executable||'/Applications/Visual Studio Code.app'
  const args=exe.endsWith('.app')?['-a',exe,target]:[target]
  const cmd=exe.endsWith('.app')?'/usr/bin/open':exe
  const {code}=await execMac(cmd,args,{signal,spawnFn,timeoutMs})
  if(code!==0)throw fail(503,'无法使用 VS Code 打开文件')
  return{launched:true,action:'vscode'}
 }
 if(payload.action==='open-with'){
  const script=[
   'on run argv',
   'set f to item 1 of argv',
   'try',
   'set appRef to choose application with prompt "选择用于打开此文件的应用程序"',
   'set appPath to POSIX path of (appRef as alias)',
   'do shell script "/usr/bin/open -a " & quoted form of appPath & " " & quoted form of f',
   'return "LAUNCHED"',
   'on error number -128',
   'return "CANCELLED"',
   'end try',
   'end run'
  ].join('\n')
  const {code,stdout}=await execMac('/usr/bin/osascript',['-e',script,target],{signal,spawnFn,timeoutMs})
  if(stdout==='CANCELLED')return{cancelled:true}
  if(code!==0||stdout!=='LAUNCHED')throw fail(503,'未能通过所选程序打开文件')
  return{launched:true,action:'open-with'}
 }
 if(payload.action==='save-as'){
  const script=[
   'on run argv',
   'set defaultName to item 1 of argv',
   'try',
   'set dest to choose file name with prompt "另存为" default name defaultName',
   'return POSIX path of dest',
   'on error number -128',
   'return "CANCELLED"',
   'end try',
   'end run'
  ].join('\n')
  const {code,stdout}=await execMac('/usr/bin/osascript',['-e',script,path.basename(target)],{signal,spawnFn,timeoutMs})
  if(stdout==='CANCELLED')return{cancelled:true}
  if(code!==0||!stdout||!path.isAbsolute(stdout))throw fail(503,'另存为路径未确认')
  await fs.copyFile(target,stdout)
  const info=await fs.stat(stdout)
  return{saved:true,path:stdout,size:info.size}
 }
 throw fail(400,'不支持的文件操作')
}
export function createFileActions({apiPort,playerPath,codePath,fetcher=fetch,authorizeRequest=()=>undefined,stat=fs.stat,realpath=fs.realpath,runHelper,videoOpener,platform=process.platform,env=process.env,now=Date.now}={}){
 const effectiveHelper=runHelper||(platform==='darwin'?runMacAction:runWindowsAction)
 const video=videoOpener||createVideoOpener({apiPort,playerPath,fetcher,stat,platform})
 const active=new Map(),recent=new Map()
 async function vscodePath(){
  if(platform==='darwin'){
   const macChoices=[codePath,env.DSH_VSCODE_PATH,'/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code','/opt/homebrew/bin/code','/usr/local/bin/code','/Applications/Cursor.app/Contents/Resources/app/bin/cursor'].filter(Boolean)
   for(const file of macChoices){if(!path.isAbsolute(file))continue;try{if((await stat(file)).isFile())return file}catch{}}
   return null
  }
  const choices=[codePath,env.DSH_VSCODE_PATH,env.LOCALAPPDATA&&path.join(env.LOCALAPPDATA,'Programs','Microsoft VS Code','Code.exe'),env.ProgramFiles&&path.join(env.ProgramFiles,'Microsoft VS Code','Code.exe')].filter(Boolean)
  for(const file of choices){if(!path.isAbsolute(file)||path.extname(file).toLowerCase()!=='.exe')continue;try{if((await stat(file)).isFile())return file}catch{}}
  return null
 }
 async function capabilities(){const vscodeFound=!!(await vscodePath());const supported=platform==='win32'||platform==='darwin';return{supported,vscodeFound,availableActions:supported?['open','notepad','open-with','save-as','reveal',...(vscodeFound?['vscode']:[])]:[],systemOpenExtensions:[...OPEN_EXT],textExtensions:[...TEXT_EXT],receipts:'launched 表示已交给系统或程序，不代表文件已成功显示'}}
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
  if(body.action==='notepad'&&!TEXT_EXT.has(path.extname(absolute).toLowerCase()))throw fail(415,'记事本/文本编辑仅支持文本文件')
  if(body.action==='open'&&String(file.type||'').startsWith('video/')){const value=await video.open({sessionId:body.sessionId,path:body.path},signal);return{launched:value.opened===true,action:'open',player:value.player||'AgentPlay',pid:value.pid}}
  let executable
  if(body.action==='vscode'){executable=await vscodePath();if(!executable)throw fail(503,'未安装或未配置 VS Code')}
  signal?.throwIfAborted()
  return effectiveHelper({action:body.action,path:absolute,...(executable?{executable}:{})},{signal})
 }
 async function execute(body,signal){validateAction(body);if(body.action==='capabilities')return capabilities();if(platform!=='win32'&&platform!=='darwin')throw fail(403,'仅支持桌面本机 (Windows / macOS)');
  const key=JSON.stringify([body.sessionId,body.path,body.action]);if(active.has(key))return active.get(key);const previous=recent.get(key);if(previous&&now()-previous.at<2500)return previous.value
  const promise=perform(body,signal);active.set(key,promise);try{const value=await promise;if(!value.cancelled){recent.set(key,{at:now(),value});if(recent.size>100)recent.delete(recent.keys().next().value)}return value}finally{active.delete(key)}
 }
 async function handler(req,res){const controller=new AbortController(),abort=()=>controller.abort(),close=()=>{if(!res.writableEnded)abort()};req.on('aborted',abort);res.on('close',close);const reply=(status,value)=>{if(res.destroyed||res.writableEnded)return;res.writeHead(status,{'content-type':'application/json; charset=utf-8','cache-control':'no-store'});res.end(JSON.stringify(value))};try{const rejection=authorizeRequest(req);if(rejection)throw fail(typeof rejection==='number'?rejection:403,'本机文件操作需要已认证的所有者会话');assertLocalDesktop(req,platform);if(req.method!=='POST')throw fail(405,'仅支持 POST');if(!/^application\/json\b/i.test(req.headers['content-type']||''))throw fail(415,'需要 JSON 参数');if(Number(req.headers['content-length'])>8192)throw fail(413,'请求过大');let bytes=0,parts=[];for await(const part of req){bytes+=part.length;if(bytes>8192)throw fail(413,'请求过大');parts.push(part)}let body;try{body=JSON.parse(Buffer.concat(parts).toString('utf8'))}catch{throw fail(400,'JSON 参数无效')}reply(200,{ok:true,value:await execute(body,controller.signal)})}catch(error){reply(error.status||500,{ok:false,error:{code:'file-action-failed',message:error.status?error.message:'文件操作未确认，请核对后再试'}})}finally{req.off('aborted',abort);res.off('close',close)}}
 return{handler,execute,capabilities}
}
