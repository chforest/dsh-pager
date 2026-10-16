import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import {fileURLToPath} from 'node:url'
export const patch=JSON.parse(fs.readFileSync(new URL('./patch.json',import.meta.url)))
const hash=b=>crypto.createHash('sha256').update(b).digest('hex')
export function transformPatch(source,spec){
 if(hash(source)!==spec.before)throw Error('Unexpected upstream bytes: '+spec.file)
 let text=source.toString('utf8')
 for(const [from,to]of spec.replacements){if(text.split(from).length!==2)throw Error('Patch does not match: '+spec.file);text=text.replace(from,to)}
 const result=Buffer.from(text);if(hash(result)!==spec.after)throw Error('Patched hash mismatch: '+spec.file)
 return result
}
export function applyPatch(root){
 const pkg=JSON.parse(fs.readFileSync(path.join(root,'package.json')))
 if(pkg.name!==patch.name||pkg.version!==patch.version)throw Error('Only dshmarket@1.66.17 is supported')
 // Validate every input before any mutation. Never overwrite an existing custom patch.
 const prepared=patch.files.map(spec=>{
  const file=path.join(root,spec.file)
  if(fs.lstatSync(file).isSymbolicLink()||fs.realpathSync(file)!==path.resolve(file))throw Error('Symlink patch target rejected')
  const source=fs.readFileSync(file)
  return {file,data:hash(source)===spec.after?source:transformPatch(source,spec)}
 })
 for(const item of prepared)fs.writeFileSync(item.file,item.data)
 return patch.files.map(({file,after})=>({file,sha256:after}))
}
