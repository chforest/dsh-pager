import {test} from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {fileURLToPath} from 'node:url'
import {linkExtensions,configExample} from './link-extensions.mjs'
test('extension links preserve profile and are idempotent; conflicting package fails closed',t=>{
 const root=fileURLToPath(new URL('../',import.meta.url)),profile=fs.mkdtempSync(path.join(os.tmpdir(),'pager-link-'));t.after(()=>fs.rmSync(profile,{recursive:true,force:true}))
 fs.writeFileSync(path.join(profile,'package.json'),'{}');fs.writeFileSync(path.join(profile,'cordis.patch.yml'),'# untouched')
 const preview=linkExtensions(root,profile,{dryRun:true});assert.equal(fs.existsSync(path.join(profile,'node_modules')),false)
 const rows=linkExtensions(root,profile);assert.equal(rows.length,9);assert.equal(linkExtensions(root,profile).filter(x=>x.create).length,0)
 assert.equal(fs.readFileSync(path.join(profile,'cordis.patch.yml'),'utf8'),'# untouched');assert.match(configExample(preview),/enabled: false/)
 fs.unlinkSync(rows[0].link);fs.mkdirSync(rows[0].link);assert.throws(()=>linkExtensions(root,profile),/Refusing to replace/)
})
