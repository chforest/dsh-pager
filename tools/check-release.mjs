#!/usr/bin/env node
// Scan Git's release list, never print matching secret values.
import fs from 'node:fs'
import path from 'node:path'
import {execFileSync} from 'node:child_process'
import {fileURLToPath} from 'node:url'
export function checkFile(name,buffer){
 const errors=[]
 if(/(^|\/)(node_modules|data|receipts|keystore|\.cache|out|\.git)(\/|$)|\.bak|\.log$|(^|\/)(\.env(?:\..*)?|local\.properties|credentials[^/]*|tasks\.json|recovery\.json)$|\.(jks|keystore|p12|pfx|apk|exe|dll|onnx|tgz)$/i.test(name))errors.push('private/runtime/build path')
 if(buffer.includes(0))return errors
 const lines=buffer.toString('utf8').split('\n')
 const rules=[[/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,'private key'],[/\bgh[pousr]_[A-Za-z0-9]{30,}\b|\bgithub_pat_[A-Za-z0-9_]{40,}\b/,'GitHub credential'],[/\bsk-[A-Za-z0-9]{32,}\b/,'API credential'],[/agenthub-u\.com|[DE]:[\\/]手机互联|[CD]:[\\/]Users[\\/]Administrator/i,'private deployment identity']]
 lines.forEach((line,i)=>{for(const [pattern,label]of rules)if(pattern.test(line))errors.push(`${label} at line ${i+1}`)})
 return errors
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const names=execFileSync('git',['ls-files','-z'],{encoding:'utf8'}).split('\0').filter(Boolean);let count=0
 for(const name of names){const blob=execFileSync('git',['show',`:${name}`],{maxBuffer:16*1024*1024});const errors=checkFile(name,blob);for(const error of errors){console.error(`${name}: ${error}`);count++}}
 if(count)process.exitCode=1;else console.log(`Release privacy check passed: ${names.length} tracked files. Review still required for business data and third-party rights.`)
}
