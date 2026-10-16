import fs from 'node:fs/promises';
import {spawn} from 'node:child_process';
import path from 'node:path';
export const DEFAULT_PLAYER=process.env.DSH_VIDEO_PLAYER_PATH||(process.env.ProgramFiles?path.join(process.env.ProgramFiles,'ai-player','AgentPlay','AgentPlay.exe'):'');
const fail=(status,message)=>Object.assign(new Error(message),{status});
export function assertLocalDesktop(req,platform=process.platform){
  if(platform!=='win32')throw fail(403,'仅支持这台 Windows 电脑');
  const headers=req.headers||{},peer=req.socket?.remoteAddress;
  if(!['127.0.0.1','::1','::ffff:127.0.0.1'].includes(peer)||Object.keys(headers).some(key=>key==='forwarded'||key.startsWith('x-forwarded-')||key==='x-real-ip')||/Android|iPhone|iPad|DSHApp/i.test(headers['user-agent']||''))throw fail(403,'请在这台电脑的 DSH 桌面打开视频');
  try{const origin=new URL(headers.origin),page=new URL(headers.referer);if(!['http:','https:'].includes(origin.protocol)||!['localhost','127.0.0.1','[::1]'].includes(origin.hostname)||origin.host!==headers.host||origin.username||origin.password||page.origin!==origin.origin||page.pathname!=='/'||headers['sec-fetch-site']==='cross-site')throw Error();}catch{throw fail(403,'请从本机 DSH 对话页面打开视频');}
}
export function createVideoOpener({apiPort,playerPath=DEFAULT_PLAYER,fetcher=fetch,stat=fs.stat,launch=spawn,platform=process.platform,now=Date.now}={}){
  const requests=new Map(),opened=new Map();
  async function perform(body,signal){
    signal?.throwIfAborted();
    if(!playerPath||!path.isAbsolute(playerPath))throw fail(503,'请配置本机播放器绝对路径 playerPath 或 DSH_VIDEO_PLAYER_PATH');
    const response=await fetcher(`http://127.0.0.1:${apiPort()}/m/api/fs?s=${encodeURIComponent(body.sessionId)}&path=${encodeURIComponent(body.path)}`,{redirect:'error',signal:signal?AbortSignal.any([signal,AbortSignal.timeout(15000)]):AbortSignal.timeout(15000)});
    const out=await response.json();if(!response.ok||!out.ok)throw fail(response.status||400,out.error?.message||'视频路径校验失败');
    const file=out.value;
    if(file?.kind!=='media'||!String(file.type||'').startsWith('video/')||typeof file.absolutePath!=='string'||!file.absolutePath)throw fail(415,'仅允许打开工作区中的视频文件');
    if(!(await stat(file.absolutePath)).isFile())throw fail(404,'视频文件不存在');
    if(!(await stat(playerPath)).isFile())throw fail(503,'指定的 AgentPlay 播放器不存在');
    signal?.throwIfAborted();
    const old=opened.get(file.absolutePath);if(old&&now()-old.at<2500)return old.promise;
    const promise=new Promise((resolve,reject)=>{
      let child;try{child=launch(playerPath,[file.absolutePath],{shell:false,windowsHide:false,detached:true,stdio:'ignore'});}catch(error){reject(error);return;}
      child.once('error',error=>reject(fail(503,'AgentPlay 启动失败：'+error.message)));
      child.once('spawn',()=>{child.unref();resolve({opened:true,pid:child.pid,player:'AgentPlay',path:file.absolutePath});});
    });
    opened.set(file.absolutePath,{at:now(),promise});
    try{return await promise;}catch(error){opened.delete(file.absolutePath);throw error;}
  }
  async function open(body,signal){
    if(platform!=='win32')throw fail(403,'仅支持 Windows 本机');
    if(!body||Object.keys(body).some(key=>!['sessionId','path'].includes(key))||typeof body.sessionId!=='string'||!/^session-[A-Za-z0-9-]+$/.test(body.sessionId)||typeof body.path!=='string'||!body.path||body.path.length>4096||body.path.includes('\0'))throw fail(400,'视频参数无效');
    const key=body.sessionId+'\0'+body.path;if(requests.has(key))return requests.get(key);
    const promise=perform(body,signal);requests.set(key,promise);try{return await promise;}finally{requests.delete(key);}
  }
  async function handler(req,res){
    const controller=new AbortController();const abort=()=>controller.abort();const close=()=>{if(!res.writableEnded)abort();};req.on('aborted',abort);res.on('close',close);
    const reply=(status,value)=>{if(res.destroyed||res.writableEnded)return;res.writeHead(status,{'content-type':'application/json; charset=utf-8','cache-control':'no-store'});res.end(JSON.stringify(value));};
    try{
      assertLocalDesktop(req,platform);if(req.method!=='POST')throw fail(405,'仅支持 POST');
      if(!String(req.headers['content-type']||'').toLowerCase().startsWith('application/json'))throw fail(415,'需要 JSON 参数');
      if(Number(req.headers['content-length'])>8192)throw fail(413,'请求过大');
      let length=0;const chunks=[];for await(const chunk of req){length+=chunk.length;if(length>8192)throw fail(413,'请求过大');chunks.push(chunk);}
      let body;try{body=JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{throw fail(400,'JSON 参数无效');}
      reply(200,{ok:true,value:await open(body,controller.signal)});
    }catch(error){reply(error.status||500,{ok:false,error:{code:'local-video-open-failed',message:error.message||'本地视频打开失败'}});}
    finally{req.off('aborted',abort);res.off('close',close);}
  }
  return{open,handler};
}
