import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import {spawnSync} from 'node:child_process'
import {fileURLToPath} from 'node:url'
import {patch,applyPatch} from './apply.mjs'
export function planInstall(target){
 if(!target||!path.isAbsolute(target))throw Error('Provide a new absolute --target directory')
 const root=path.resolve(target),parent=path.dirname(root)
 if(fs.existsSync(root))throw Error('Target already exists; no overwrite')
 if(!fs.existsSync(parent)||fs.realpathSync(parent).toLowerCase()!==parent.toLowerCase())throw Error('Parent must exist and cannot be a symlink')
 return {root,name:patch.name,version:patch.version,url:patch.url}
}
export function verifyArchive(bytes){
 const integrity='sha512-'+crypto.createHash('sha512').update(bytes).digest('base64')
 if(integrity!==patch.integrity)throw Error('Pinned npm archive integrity mismatch')
}
export async function install(plan,{archive,npmCli=process.env.npm_execpath||path.join(path.dirname(process.execPath),'node_modules/npm/bin/npm-cli.js')}={}){
 if(!fs.existsSync(npmCli))throw Error('npm CLI missing; supply --npm-cli')
 let bytes
 if(archive)bytes=fs.readFileSync(archive)
 else {const response=await fetch(patch.url,{signal:AbortSignal.timeout(60000),redirect:'error'});if(!response.ok)throw Error('npm archive download failed');bytes=Buffer.from(await response.arrayBuffer())}
 verifyArchive(bytes)
 fs.mkdirSync(plan.root)
 const tgz=path.join(plan.root,'dshmarket-1.66.17.tgz')
 fs.writeFileSync(tgz,bytes)
 fs.writeFileSync(path.join(plan.root,'package.json'),JSON.stringify({name:'dsh-market-runtime',version:'1.0.0',private:true},null,2)+'\n')
 const result=spawnSync(process.execPath,[npmCli,'install',tgz,'--ignore-scripts','--legacy-peer-deps','--omit=dev','--no-audit','--no-fund','--registry=https://registry.npmjs.org/'],{cwd:plan.root,shell:false,windowsHide:true,timeout:180000,maxBuffer:1024*1024,encoding:'utf8'})
 if(result.status!==0)throw Error('npm installation failed; incomplete directory retained for inspection')
 const files=applyPatch(path.join(plan.root,'node_modules/dshmarket'))
 const receipt={name:patch.name,version:patch.version,integrity:patch.integrity,files,profileChanged:false,scriptsExecuted:false}
 fs.writeFileSync(path.join(plan.root,'market-patch-receipt.json'),JSON.stringify(receipt,null,2)+'\n')
 return receipt
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 try{const args=process.argv.slice(2),get=k=>args.includes(k)?args[args.indexOf(k)+1]:undefined;const plan=planInstall(get('--target'));console.log(JSON.stringify(args.includes('--install')?await install(plan,{archive:get('--archive'),npmCli:get('--npm-cli')}):plan,null,2))}catch(error){console.error(error.message);process.exitCode=1}
}
