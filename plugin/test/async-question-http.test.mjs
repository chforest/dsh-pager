import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import crypto from 'node:crypto'
import { createMobile } from '../server.js'
import { createAsyncQuestions } from '../async-questions.js'

test('async question HTTP binds session, wakes a waiting tool, and admits a late answer only once', async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'dsh-async-http-')),questionDir=path.join(dir,'questions'),calls=[]
 const seed=createAsyncQuestions({dir:questionDir}),late=seed.create({sessionId:'session-test',kind:'clarification',question:'晚到颜色?',options:['蓝','绿'],independentWork:'检查布局',waitMs:0});seed.close()
 const upstream=http.createServer(async(req,res)=>{let raw='';for await(const b of req)raw+=b;const m=JSON.parse(raw);calls.push(m);let result=m.method==='workspace.list'?{ok:true,value:{items:[{path:dir,sessionIds:['session-test','session-other']}]}}:m.method==='session.prompt'?{ok:true,value:{accepted:true}}:{ok:false,error:{message:'unexpected'}};res.end(JSON.stringify({result}))})
 await new Promise(r=>upstream.listen(0,'127.0.0.1',r));const app=createMobile({apiPort:()=>upstream.address().port,pushDir:path.join(dir,'push'),questionDir});const server=http.createServer(app.handle);await new Promise(r=>server.listen(0,'127.0.0.1',r));const base=`http://127.0.0.1:${server.address().port}/m/api/async-questions`
 const post=(suffix,body)=>fetch(base+suffix,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)})
 try{
  assert.equal((await post('/create',{s:'session-test',kind:'approval',question:'授权?',independentWork:'不应开始'})).status,400)
  assert.equal((await fetch(base+'?s=session-missing')).status,404)
  const request=post('/create',{s:'session-test',kind:'clarification',question:'选颜色?',options:['蓝','绿'],independentWork:'检查布局',requestId:crypto.randomUUID()})
  let active;for(let n=0;n<30;n++){const rows=(await(await fetch(base+'?s=session-test')).json()).value.items;active=rows.find(x=>x.status==='waiting');if(active)break;await new Promise(r=>setTimeout(r,10))}assert.ok(active)
  const body={s:'session-test',id:active.id,answer:'蓝',answerId:crypto.randomUUID()}
  assert.equal((await post('',{...body,s:'session-other'})).status,403)
  const saved=await(await post('',body)).json();assert.equal(saved.value.delivery,'not-needed')
  const result=await(await request).json();assert.equal(result.value.answered,true);assert.equal(result.value.answer,'蓝');assert.equal(calls.filter(c=>c.method==='session.prompt').length,0)
  const delayed={s:'session-test',id:late.id,answer:'绿',answerId:crypto.randomUUID()}
  assert.equal((await(await post('',delayed)).json()).value.delivery,'accepted')
  assert.equal((await(await post('',delayed)).json()).value.delivery,'accepted')
  const prompt=calls.filter(c=>c.method==='session.prompt');assert.equal(prompt.length,1);assert.equal(prompt[0].rpcId,delayed.answerId);assert.equal(prompt[0].payload.sessionId,'session-test');assert.match(prompt[0].payload.content[0].text,/不是新的授权/)
 }finally{app.close();server.closeAllConnections();upstream.closeAllConnections();await new Promise(r=>server.close(r));await new Promise(r=>upstream.close(r));fs.rmSync(dir,{recursive:true,force:true})}
})
