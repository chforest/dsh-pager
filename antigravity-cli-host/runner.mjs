import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import {spawn} from 'node:child_process';
export function resolveCli(env=process.env,platform=process.platform){
 const explicit=env.DSH_ANTIGRAVITY_CLI_PATH;if(explicit)return path.resolve(explicit);
 const binary=platform==='win32'?'agy.exe':'agy';
 for(const dir of (env.PATH||env.Path||'').split(path.delimiter)){if(!dir||!path.isAbsolute(dir))continue;const candidate=path.join(dir,binary);try{if(fs.statSync(candidate).isFile())return candidate}catch{}}
 return '';
}
export const EXE=resolveCli();
export function safeEnv(original=process.env){const env={...original};for(const key of Object.keys(env))if(/^(GEMINI_API_KEY|GOOGLE_API_KEY|GOOGLE_GENAI_USE_VERTEXAI|GOOGLE_APPLICATION_CREDENTIALS|GOOGLE_CLOUD_PROJECT|GOOGLE_CLOUD_PROJECT_ID|GOOGLE_CLOUD_LOCATION|GEMINI_CLI_AUTH_OVERRIDE)$/i.test(key))delete env[key];return env}
export function checkSettings(file=path.join(os.homedir(),'.gemini','antigravity-cli','settings.json')){
 if(!fs.existsSync(file))return {ok:true,mode:'official-default-review'};
 try{const s=JSON.parse(fs.readFileSync(file,'utf8'));if(s.toolPermission&&!['strict','request-review'].includes(s.toolPermission))return{ok:false,reason:'CLI工具权限不是审核模式'};
 if((s.permissions?.allow||[]).length||Object.keys(s.mcpServers||{}).length||Object.keys(s.hooks||{}).length)return{ok:false,reason:'CLI全局允许规则、MCP或钩子需要先隔离核验'};
 return{ok:true,mode:s.toolPermission||'official-default-review'};}catch{return{ok:false,reason:'CLI设置无法安全读取'}}
}
export function createRunner({root,spawnFn=spawn,settingsCheck=checkSettings,exe=EXE,timeoutMs=90000}={}){
 fs.mkdirSync(root,{recursive:true});let busy=false;const results=new Map();
 const status=()=>({installed:fs.existsSync(exe),backend:'Google official Antigravity CLI',legacyGeminiCli:'individual-subscription-unsupported',authentication:'requires-official-login-and-live-verification',policy:settingsCheck(),busy,mode:'plan',automaticApiFallback:false});
 return{status,async ask({prompt,requestId,signal}){
 if(typeof prompt!=='string'||!prompt.trim()||prompt.length>12000)return{ok:false,code:'INVALID_PROMPT'};
 if(!/^[a-f0-9]{64}$/.test(requestId||''))return{ok:false,code:'INVALID_REQUEST_ID'};
 const digest=crypto.createHash('sha256').update(prompt).digest('hex'),receipt=path.join(root,requestId+'.json');
 if(results.has(requestId))return results.get(requestId).digest===digest?results.get(requestId).result:{ok:false,code:'REQUEST_CONFLICT'};
 if(fs.existsSync(receipt)){const old=JSON.parse(fs.readFileSync(receipt,'utf8'));return{ok:false,code:old.digest===digest?'ALREADY_ATTEMPTED':'REQUEST_CONFLICT',outcome:old.status,retry:false}}
 if(signal?.aborted)return{ok:false,code:'CANCELLED'};
 if(busy)return{ok:false,code:'BUSY'};
 const policy=settingsCheck();if(!policy.ok)return{ok:false,code:'POLICY_REVIEW_REQUIRED',message:policy.reason};
 if(!fs.existsSync(exe))return{ok:false,code:'CLI_NOT_INSTALLED'};
 busy=true;const cwd=path.join(root,'work',requestId);fs.mkdirSync(cwd,{recursive:true});
 fs.writeFileSync(receipt,JSON.stringify({requestId,digest,status:'dispatching',at:new Date().toISOString()}),{flag:'wx'});
 let result;
 try{result=await new Promise(resolve=>{
  let child,stdout='',stderr='',settled=false,timer;
  const finish=value=>{if(settled)return;settled=true;clearTimeout(timer);signal?.removeEventListener('abort',abort);resolve(value)};
  const abort=()=>{child?.kill();finish({ok:false,code:'CANCELLED',outcome:'unknown',retry:false})};
  try{child=spawnFn(exe,['--mode','plan','--disable-slash-commands','--print-timeout','75s','--output-format','json','-p',prompt],{cwd,env:safeEnv(),shell:false,windowsHide:true,stdio:['ignore','pipe','pipe']})}catch{finish({ok:false,code:'SPAWN_FAILED',retry:false});return}
  signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted){abort();return}
  timer=setTimeout(()=>{child.kill();finish({ok:false,code:'TIMEOUT',outcome:'unknown',retry:false})},timeoutMs);
  child.stdout.on('data',chunk=>{stdout+=chunk;if(Buffer.byteLength(stdout)>256000){child.kill();finish({ok:false,code:'OUTPUT_LIMIT',outcome:'unknown',retry:false})}});
  child.stderr.on('data',chunk=>{stderr=(stderr+chunk).slice(-8000)});
  child.on('error',()=>finish({ok:false,code:'SPAWN_FAILED',retry:false}));
  child.on('close',code=>{if(settled)return;
   if(code!==0){const auth=/not logged in|authentication required|sign.in|authenticate|oauth/i.test(stderr);finish({ok:false,code:auth?'LOGIN_REQUIRED':'CLI_FAILED',exitCode:code,retry:false,message:auth?'请在官方 Antigravity CLI 完成登录；不会改用API Key。':'官方CLI未确认成功；请查看CLI窗口，不能据此重放操作。'});return}
   try{const data=JSON.parse(stdout);if(data.error||data.status==='ERROR'){finish({ok:false,code:'CLI_REPORTED_ERROR',retry:false});return}finish({ok:true,backend:'official-antigravity-cli',result:data,scope:'仅本次明确输入；plan模式，未自动导出DSH聊天',requestId})}catch{finish({ok:false,code:'INVALID_OUTPUT',outcome:'unknown',retry:false})}
  });
 });}finally{busy=false}
 fs.writeFileSync(receipt,JSON.stringify({requestId,digest,status:result.ok?'completed':result.outcome||result.code,at:new Date().toISOString()}));results.set(requestId,{digest,result});if(results.size>32)results.delete(results.keys().next().value);return result;
 }}
}
