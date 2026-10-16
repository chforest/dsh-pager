#!/usr/bin/env node
// Link this checkout into an existing DSH profile; print config for review.
// Never edits an existing profile or installs dependencies implicitly.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {fileURLToPath} from 'node:url'
export const modules=['plugin','recovery-host','tasks-host','async-question-host','files-host','screenshot-host','suggestions-host','market-host','antigravity-cli-host']
export function linkExtensions(root,profile,{dryRun=false}={}){
  if(!fs.existsSync(path.join(profile,'package.json')))throw Error('Choose an existing DSH profile with --profile <directory>')
  const plans=modules.map(dir=>{const target=path.join(root,dir);const pkg=JSON.parse(fs.readFileSync(path.join(target,'package.json')));const link=path.join(profile,'node_modules',pkg.name);return{dir,target,link,name:pkg.name}})
  for(const row of plans){try{fs.lstatSync(row.link);if(fs.realpathSync(row.link)!==fs.realpathSync(row.target))throw Error('Refusing to replace existing package: '+row.name)}catch(e){if(e.code!=='ENOENT')throw e;row.create=true}}
  if(!dryRun){fs.mkdirSync(path.join(profile,'node_modules'),{recursive:true});for(const row of plans)if(row.create)fs.symlinkSync(row.target,row.link,process.platform==='win32'?'junction':'dir')}
  return plans
}
export function configExample(plans){return '# Merge only missing entries. Keep existing config and private data paths.\n- insert:\n'+plans.map(row=>`    - id: ${row.name}\n      name: ${row.name}${row.dir==='antigravity-cli-host'?'\n      config:\n        enabled: false':''}`).join('\n')+'\n'}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const args=process.argv.slice(2),i=args.indexOf('--profile'),profile=i<0?path.join(process.env.DSH_HOME||path.join(os.homedir(),'.dsh'),'profiles','web'):args[i+1]
  if(!profile)throw Error('--profile needs a directory')
  const root=fileURLToPath(new URL('../',import.meta.url)),plans=linkExtensions(root,path.resolve(profile),{dryRun:args.includes('--dry-run')})
  console.log(configExample(plans))
}
