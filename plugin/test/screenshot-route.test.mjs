import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createMobile } from '../server.js'

test('public route issues only a local ticket; screenshot bytes require separate loopback service and explicit origin/token',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'dsh-screen-'));let server,count=0,complete
 const app=createMobile({apiPort:()=>server.address().port,pushDir:dir,captureRegion:signal=>{count++;return new Promise(resolve=>{complete=resolve;signal.addEventListener('abort',()=>resolve({cancelled:true}),{once:true})})}})
 server=http.createServer(app.handle);await new Promise(r=>server.listen(0,'127.0.0.1',r));const origin=`http://127.0.0.1:${server.address().port}`
 const headers={'content-type':'application/json',origin,referer:origin+'/'}
 const ticket=(extra={})=>fetch(origin+'/m/api/desktop/screenshot',{method:'POST',headers:{...headers,...extra},body:'{}'})
 try{
  for(const extra of [{referer:'https://public-phone.example/m/'},{origin:'https://evil.example'},{referer:''},{'x-forwarded-for':'1.2.3.4'},{'user-agent':'Android DSHApp/1.5.3'}])assert.equal((await ticket(extra)).status,403)
  const out=await(await ticket()).json();assert.equal(out.ok,true);assert.equal(count,0);assert.equal(out.value.data,undefined)
  const {captureUrl,token}=out.value;assert.equal(new URL(captureUrl).hostname,'127.0.0.1');assert.notEqual(new URL(captureUrl).port,new URL(origin).port)
  assert.equal((await fetch(captureUrl,{method:'POST',headers:{'content-type':'application/json',origin:'https://public-phone.example','x-dsh-capture-token':token},body:'{}'})).status,403)
  assert.equal((await fetch(captureUrl,{method:'POST',headers:{origin},body:'{}'})).status,403);assert.equal(count,0)
  const preflight=await fetch(captureUrl,{method:'OPTIONS',headers:{origin}});assert.equal(preflight.status,204);assert.equal(preflight.headers.get('access-control-allow-origin'),origin)
  const request=fetch(captureUrl,{method:'POST',headers:{...headers,'x-dsh-capture-token':token},body:'{}'})
  while(!complete)await new Promise(r=>setTimeout(r,5))
  assert.equal((await fetch(captureUrl,{method:'POST',headers:{...headers,'x-dsh-capture-token':token},body:'{}'})).status,409)
  complete({cancelled:true});assert.deepEqual((await(await request).json()).value,{cancelled:true});assert.equal(count,1)
 }finally{app.close();server.closeAllConnections();await new Promise(r=>server.close(r));fs.rmSync(dir,{recursive:true,force:true})}
})
