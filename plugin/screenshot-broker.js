import http from 'node:http'
import crypto from 'node:crypto'
import { captureDesktopRegion } from './native-screenshot.js?visible-v5'
import { recognizeScreenshot } from './screenshot-ocr.js?spacing-v2'

// All image operations remain on the private loopback listener. The public
// mobile route returns a ticket only, never screenshot pixels or OCR results.
export function createScreenshotBroker({ dshPort, captureRegion = captureDesktopRegion, recognize = recognizeScreenshot, translate }) {
 const token=crypto.randomBytes(32).toString('hex'),routes=new Set(['/capture','/ocr','/translate'])
 let server,starting,active,closed=false
 const translationTimes=[]
 function allowedOrigin(raw){try{const u=new URL(raw);return u.protocol==='http:'&&['127.0.0.1','localhost','[::1]'].includes(u.hostname)&&Number(u.port||80)===Number(dshPort())&&u.origin===raw}catch{return false}}
 function finish(res,status,value,origin){if(res.destroyed||res.writableEnded)return;res.writeHead(status,{'content-type':'application/json','cache-control':'no-store',...(origin?{'access-control-allow-origin':origin,'vary':'Origin'}:{})});res.end(JSON.stringify(value))}
 const handler=async(req,res)=>{
  const origin=req.headers.origin,route=req.url
  if(!allowedOrigin(origin)||!routes.has(route))return finish(res,403,{ok:false,error:{message:'只能在本机 DSH 中处理截图'}})
  if(req.method==='OPTIONS'){res.writeHead(204,{'access-control-allow-origin':origin,'access-control-allow-methods':'POST','access-control-allow-headers':'content-type,x-dsh-capture-token','access-control-allow-private-network':'true','vary':'Origin'});return res.end()}
  const supplied=Buffer.from(String(req.headers['x-dsh-capture-token']||'')),expected=Buffer.from(token)
  if(req.method!=='POST'||supplied.length!==expected.length||!crypto.timingSafeEqual(supplied,expected))return finish(res,403,{ok:false,error:{message:'截图请求无效'}},origin)
  if(active)return finish(res,409,{ok:false,error:{message:'正在处理上一次截图，请稍候'}},origin)
  if(closed)return finish(res,409,{ok:false,error:{message:'截图服务已关闭'}},origin)
  if(route!=='/capture'&&!/^application\/json\b/i.test(req.headers['content-type']||''))return finish(res,415,{ok:false,error:{message:'请求格式不正确'}},origin)
  const limit=route==='/ocr'?46*1024*1024:route==='/translate'?64*1024:4096
  if(Number(req.headers['content-length'])>limit)return finish(res,413,{ok:false,error:{message:'内容过大，请缩小截图或分段处理文字'}},origin)
  const controller=new AbortController();active=controller
  const abort=()=>{if(!res.writableEnded)controller.abort()};res.on('close',abort)
  try{
   let bytes=0;const chunks=[]
   for await(const chunk of req){bytes+=chunk.length;if(bytes>limit){finish(res,413,{ok:false,error:{message:'内容过大，请缩小截图或分段处理文字'}},origin);return}chunks.push(chunk)}
   controller.signal.throwIfAborted()
   let body={};try{body=JSON.parse(Buffer.concat(chunks).toString('utf8')||'{}')}catch{finish(res,400,{ok:false,error:{message:'请求内容不是有效JSON'}},origin);return}
   if(!body||typeof body!=='object'||Array.isArray(body)){finish(res,400,{ok:false,error:{message:'请求内容无效'}},origin);return}
   let value
   if(route==='/capture')value=await captureRegion(controller.signal)
   else if(route==='/ocr')value=await recognize(body.image,{signal:controller.signal})
   else{
    if(typeof translate!=='function'){finish(res,503,{ok:false,error:{message:'翻译服务尚未就绪，请刷新DSH'}},origin);return}
    const now=Date.now();while(translationTimes.length&&translationTimes[0]<now-60000)translationTimes.shift()
    if(translationTimes.length>=10){finish(res,429,{ok:false,error:{message:'翻译请求较频繁，请稍后再试'}},origin);return}
    translationTimes.push(now);value=await translate({text:body.text,target:body.target,sessionId:body.sessionId},{signal:controller.signal})
   }
   if(!controller.signal.aborted)finish(res,200,{ok:true,value},origin)
  }catch(e){const known=e.status||String(e.code||'').startsWith('ocr-');finish(res,e.status||500,{ok:false,error:{message:known?e.message:e.name==='TimeoutError'?'处理超时，请稍后重试':'截图处理未完成，请重试'}},origin)}
  finally{res.off('close',abort);if(active===controller)active=null}
 }
 return{
  async connection(){if(closed)throw Error('截图服务已关闭');if(!starting)starting=new Promise((resolve,reject)=>{server=http.createServer(handler);server.once('error',reject);server.listen(0,'127.0.0.1',()=>{server.unref();resolve()})});await starting;if(closed)throw Error('截图服务已关闭');return{captureUrl:`http://127.0.0.1:${server.address().port}/capture`,token}},
  close(){closed=true;active?.abort();server?.closeAllConnections();server?.close()}
 }
}
