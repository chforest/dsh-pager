import {test} from 'node:test'
import assert from 'node:assert/strict'
import {EventEmitter} from 'node:events'
import {PassThrough} from 'node:stream'
import {spawnSync} from 'node:child_process'
import {createScreenshotRecognizer,recognizeScreenshot,normalizeOcrLine} from '../screenshot-ocr.js'
const bytes=Buffer.alloc(33);Buffer.from('89504e470d0a1a0a','hex').copy(bytes);bytes.writeUInt32BE(13,8);bytes.write('IHDR',12);bytes.writeUInt32BE(100,16);bytes.writeUInt32BE(50,20)
const image={mime:'image/png',data:bytes.toString('base64'),width:100,height:50}
function mock(reply){let killed=0,input='';return {get killed(){return killed},get input(){return input},spawnProcess(exe,args,options){assert.equal(options.shell,false);assert.equal(options.windowsHide,true);assert.ok(args.includes('-File'));const c=new EventEmitter();c.stdin=new PassThrough();c.stdout=new PassThrough();c.stderr=new PassThrough();c.kill=()=>{killed++};c.stdin.on('data',x=>input+=x);c.stdin.on('finish',()=>{if(reply)queueMicrotask(()=>{c.stdout.write(JSON.stringify(reply));c.emit('close',0)})});return c}}}
test('reject mismatched PNG before spawning',async()=>{const rec=createScreenshotRecognizer({platform:'win32',spawnProcess:()=>assert.fail()});await assert.rejects(rec({...image,width:99}),{code:'ocr-invalid-image'});await assert.rejects(rec({...image,mime:'image/jpeg'}),{code:'ocr-invalid-image'})})
test('stdin image and structured text only, no image in process arguments',async()=>{const m=mock({ok:true,value:{text:'hello',lines:[{text:'hello'}],width:100,height:50}});const r=await createScreenshotRecognizer({platform:'win32',spawnProcess:m.spawnProcess})(image);assert.equal(r.text,'hello');assert.equal(JSON.parse(m.input).data,image.data)})
test('missing installed language has explicit error',async()=>{const m=mock({ok:false,error:{code:'ocr-no-language'}});await assert.rejects(createScreenshotRecognizer({platform:'win32',spawnProcess:m.spawnProcess})(image),{code:'ocr-no-language'})})
test('timeout and abort kill child without returning image data',async()=>{const m=mock();await assert.rejects(createScreenshotRecognizer({platform:'win32',timeoutMs:10,spawnProcess:m.spawnProcess})(image),{code:'ocr-timeout'});assert.equal(m.killed,1);const a=new AbortController(),n=mock();const p=createScreenshotRecognizer({platform:'win32',spawnProcess:n.spawnProcess})(image,{signal:a.signal});a.abort();await assert.rejects(p,{code:'ocr-cancelled'});assert.equal(n.killed,1)})
test('output cap stops child',async()=>{const m=mock({ok:true,value:{text:'large'}});await assert.rejects(createScreenshotRecognizer({platform:'win32',spawnProcess:m.spawnProcess,maxOutput:2})(image),{code:'ocr-output-limit'});assert.equal(m.killed,1)})
test('Windows real OCR reads generated nonprivate English and Chinese PNG entirely in memory',{skip:process.platform!=='win32'||process.env.DSH_TEST_WINDOWS_OCR!=='1'},async()=>{
 const code=`Add-Type -AssemblyName System.Drawing;$b=New-Object Drawing.Bitmap(1000,240);$g=[Drawing.Graphics]::FromImage($b);$g.Clear([Drawing.Color]::White);$f=New-Object Drawing.Font('Microsoft YaHei',32);$g.DrawString('HELLO DSH 2026',$f,[Drawing.Brushes]::Black,20,20);$g.DrawString(([char]0x4e2d).ToString()+([char]0x6587)+([char]0x6d4b)+([char]0x8bd5),$f,[Drawing.Brushes]::Black,20,110);$s=New-Object IO.MemoryStream;$b.Save($s,[Drawing.Imaging.ImageFormat]::Png);[Console]::Write([Convert]::ToBase64String($s.ToArray()));$g.Dispose();$b.Dispose();$f.Dispose();$s.Dispose()`
 const p=spawnSync('C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe',['-NoProfile','-NonInteractive','-Command',code],{encoding:'utf8',windowsHide:true,timeout:15000});assert.equal(p.status,0,p.stderr)
 const r=await recognizeScreenshot({mime:'image/png',data:p.stdout,width:1000,height:240});assert.match(r.text,/HELLO\s+DSH\s+2026/i);assert.match(r.text,/中文测试/);assert.ok(r.lines.length>=2);assert.ok(r.lines[0].words[0].width>0)
})
test('Windows decoder rejects PNG-looking but corrupt payload',{skip:process.platform!=='win32'||process.env.DSH_TEST_WINDOWS_OCR!=='1'},async()=>{await assert.rejects(recognizeScreenshot(image),{code:'ocr-failed'})})
const word=(text,x,width=20,y=0)=>({text,x,y,width,height:20})
test('coordinate normalization joins tight Han but preserves English and mixed boundaries',()=>{
 const words=[word('中',0),word('文',23),word('HELLO',48,60),word('DSH',113,40),word('测',160),word('试',184)]
 const line={text:'中 文 HELLO DSH 测 试',words};const before=JSON.stringify(words)
 assert.equal(normalizeOcrLine(line),'中文 HELLO DSH 测试');assert.equal(JSON.stringify(words),before)
})
test('large column gaps and different rows remain separated',()=>{
 assert.equal(normalizeOcrLine({text:'姓 名   地 址',words:[word('姓',0),word('名',24),word('地',120),word('址',144)]}),'姓名   地址')
 assert.equal(normalizeOcrLine({text:'中 文',words:[word('中',0),word('文',22,20,40)]}),'中 文')
})
test('missing or nonmatching coordinates do not guess whitespace',()=>{
 assert.equal(normalizeOcrLine({text:'中 文',words:[{text:'中'},{text:'文'}]}),'中 文')
 assert.equal(normalizeOcrLine({text:'中 文',words:[word('中',0),word('错',22)]}),'中 文')
})

