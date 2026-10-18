import {spawn,execFileSync} from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import {fileURLToPath} from 'node:url'
const script=fileURLToPath(new URL('./screenshot/RecognizeText.ps1',import.meta.url))
const macSwift=fileURLToPath(new URL('./screenshot/RecognizeText.swift',import.meta.url))
const macBin=fileURLToPath(new URL('./screenshot/RecognizeTextMac',import.meta.url))
const macCacheBin=fileURLToPath(new URL('./.cache/screenshot/RecognizeTextMac',import.meta.url))
const fail=(code,message)=>Object.assign(new Error(message),{code})
function ensureMacOcrExecutable(){
 if(fs.existsSync(macBin))return macBin
 if(fs.existsSync(macCacheBin))return macCacheBin
 fs.mkdirSync(path.dirname(macCacheBin),{recursive:true})
 execFileSync('/usr/bin/swiftc',['-O',macSwift,'-o',macCacheBin],{stdio:'ignore',timeout:60000})
 return macCacheBin
}
// Only remove OCR-inserted whitespace supported by adjacent, same-row Han
// bounding boxes. Keep original spacing when coordinates/text do not align.
export function normalizeOcrLine(line){
 const words=line.words
 if(!Array.isArray(words)||words.length<2)return line.text
 let cursor=0,output='',previous=null
 for(const word of words){
  if(typeof word?.text!=='string'||!word.text)return line.text
  const at=line.text.indexOf(word.text,cursor)
  if(at<0)return line.text
  let separator=line.text.slice(cursor,at)
  if(previous&&/^\s+$/u.test(separator)&&/\p{Script=Han}$/u.test(previous.text)&&/^\p{Script=Han}/u.test(word.text)){
   const valid=[previous,word].every(w=>[w.x,w.y,w.width,w.height].every(Number.isFinite)&&w.width>0&&w.height>0)
   if(valid){
    const glyph=Math.min(previous.width/[...previous.text].length,word.width/[...word.text].length)
    const gap=word.x-(previous.x+previous.width)
    const sameRow=Math.abs(word.y+word.height/2-previous.y-previous.height/2)<=Math.min(word.height,previous.height)*0.4
    if(sameRow&&gap>=-glyph*0.2&&gap<=glyph*0.6)separator=''
   }
  }
  output+=separator+word.text;cursor=at+word.text.length;previous=word
 }
 return output+line.text.slice(cursor)
}
function validate(image){
 if(image?.mime!=='image/png'||typeof image.data!=='string'||image.data.length>44739244||!Number.isInteger(image.width)||!Number.isInteger(image.height)||image.width<1||image.height<1||image.width>10000||image.height>10000||image.width*image.height>40000000)throw fail('ocr-invalid-image','截图格式或尺寸不支持识别')
 const bytes=Buffer.from(image.data,'base64')
 if(bytes.length<33||bytes.length>33554432||bytes.toString('base64')!==image.data||bytes.subarray(0,8).toString('hex')!=='89504e470d0a1a0a'||bytes.readUInt32BE(8)!==13||bytes.toString('ascii',12,16)!=='IHDR'||bytes.readUInt32BE(16)!==image.width||bytes.readUInt32BE(20)!==image.height)throw fail('ocr-invalid-image','截图PNG校验失败')
 return {data:image.data,width:image.width,height:image.height}
}
export function createScreenshotRecognizer({spawnProcess=spawn,platform=process.platform,timeoutMs=30000,maxOutput=2*1024*1024}={}){
 return async function recognizeScreenshot(image,{signal}={}){
  const input=validate(image)
  if(signal?.aborted)throw fail('ocr-cancelled','已取消文字识别')
  if(platform!=='win32'&&platform!=='darwin')throw fail('ocr-unsupported','本地文字识别需要Windows')
  return new Promise((resolve,reject)=>{
   let child,timer,done=false,size=0;const chunks=[]
   const finish=(error,value)=>{if(done)return;done=true;clearTimeout(timer);signal?.removeEventListener('abort',abort);error?reject(error):resolve(value)}
   const stop=error=>{child?.kill();finish(error)}
   const abort=()=>stop(fail('ocr-cancelled','已取消文字识别'))
   try{
    if(platform==='darwin'){
     child=spawnProcess(ensureMacOcrExecutable(),[],{shell:false,stdio:['pipe','pipe','pipe']})
    }else{
     child=spawnProcess(path.join(process.env.SystemRoot||'C:\\Windows','System32','WindowsPowerShell','v1.0','powershell.exe'),['-NoLogo','-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',script],{shell:false,windowsHide:true,stdio:['pipe','pipe','pipe']})
    }
   }catch{finish(fail('ocr-start-failed','无法启动本地文字识别'));return}
   timer=setTimeout(()=>stop(fail('ocr-timeout','本地文字识别超时，请缩小截图范围')),timeoutMs)
   signal?.addEventListener('abort',abort,{once:true})
   child.stderr.resume()
   child.stdout.on('data',chunk=>{if(done)return;size+=chunk.length;if(size>maxOutput){stop(fail('ocr-output-limit','识别文字过多，请缩小截图范围'));return}chunks.push(chunk)})
   child.once('error',()=>finish(fail('ocr-start-failed','无法启动本地文字识别')))
   child.stdin.on('error',()=>stop(fail('ocr-failed','本地文字识别未完成')))
   child.once('close',code=>{
    if(done)return
    try{
     if(code!==0)throw Error()
     const out=JSON.parse(Buffer.concat(chunks).toString('utf8').replace(/^\uFEFF/,''))
     if(!out.ok){const noLanguage=out.error?.code==='ocr-no-language';finish(fail(noLanguage?'ocr-no-language':'ocr-failed',noLanguage?'本机没有可用的OCR识别语言':'本地文字识别未完成，图片可能损坏或超过系统尺寸限制'));return}
     const value=out.value
     if(typeof value?.text!=='string'||!Array.isArray(value.lines)||value.lines.some(line=>typeof line.text!=='string')||value.width!==input.width||value.height!==input.height)throw Error()
     const lines=value.lines.map(line=>({...line,text:normalizeOcrLine(line)}))
     finish(null,{...value,lines,text:lines.map(line=>line.text).join('\n')})
    }catch{finish(fail('ocr-failed','本地文字识别返回无效结果'))}
   })
   if(signal?.aborted){abort();return}
   child.stdin.end(JSON.stringify(input))
  })
 }
}
export const recognizeScreenshot=createScreenshotRecognizer()
