import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import {fileURLToPath} from 'node:url'
import {spawn} from 'node:child_process'
export async function ensureFileActionExecutable(){
 if(process.platform!=='win32')throw Error('仅支持 Windows 本机文件操作')
 const source=fileURLToPath(new URL('./FileAction.cs',import.meta.url))
 const hash=crypto.createHash('sha256').update('file-action-winexe-v1\n').update(fs.readFileSync(source)).digest('hex').slice(0,20)
 const dir=fileURLToPath(new URL('./.cache/file-actions/',import.meta.url));fs.mkdirSync(dir,{recursive:true})
 const exe=path.join(dir,'file-action-'+hash+'.exe');if(fs.existsSync(exe))return exe
 const system=process.env.SystemRoot||process.env.WINDIR
 if(!system||!path.isAbsolute(system))throw Error('未找到 Windows 系统目录')
 const compiler=['Framework64','Framework'].map(arch=>path.join(system,'Microsoft.NET',arch,'v4.0.30319','csc.exe')).find(file=>fs.existsSync(file))
 if(!compiler)throw Error('系统缺少 .NET Framework 编译组件')
 const temp=path.join(dir,'build-'+crypto.randomUUID()+'.exe')
 try{
  await new Promise((resolve,reject)=>{
   const child=spawn(compiler,['/nologo','/target:winexe','/optimize+','/reference:System.Drawing.dll','/reference:System.Windows.Forms.dll','/reference:System.Web.Extensions.dll','/out:'+temp,source],{shell:false,windowsHide:true,stdio:['ignore','pipe','pipe']})
   const timer=setTimeout(()=>{child.kill();reject(Error('文件操作组件编译超时'))},20000)
   child.stdout.resume();child.stderr.resume()
   child.once('error',error=>{clearTimeout(timer);reject(error)})
   child.once('close',code=>{clearTimeout(timer);code===0?resolve():reject(Error('文件操作组件编译失败'))})
  })
  try{fs.linkSync(temp,exe)}catch(error){if(error.code!=='EEXIST')throw error}
  return exe
 }finally{if(fs.existsSync(temp))fs.unlinkSync(temp)}
}
