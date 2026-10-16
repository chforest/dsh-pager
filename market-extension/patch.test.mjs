import {test} from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {transformPatch,patch} from './apply.mjs'
import {planInstall,verifyArchive} from './install.mjs'
const hash=b=>crypto.createHash('sha256').update(b).digest('hex')
test('patches exact bytes and rejects drift before writing',()=>{const before=Buffer.from('hello default'),after=Buffer.from('hello stars'),spec={file:'fixture',before:hash(before),after:hash(after),replacements:[['default','stars']]};assert.deepEqual(transformPatch(before,spec),after);assert.throws(()=>transformPatch(Buffer.from('wrong'),spec));assert.throws(()=>transformPatch(before,{...spec,after:'wrong'}))})
test('pinned package and narrow three-file patch contain no registry snapshot',()=>{assert.equal(patch.version,'1.66.17');assert.deepEqual(patch.files.map(x=>x.file),['client/client.js','src/client/MarketSection.tsx','src/client/locales.ts']);assert.throws(()=>verifyArchive(Buffer.from('not upstream')))})
test('installer refuses existing targets and relative directories',()=>{assert.throws(()=>planInstall('.'));assert.throws(()=>planInstall(os.tmpdir()));const parent=fs.mkdtempSync(path.join(os.tmpdir(),'market-plan-'));try{assert.equal(planInstall(path.join(parent,'new')).root,path.join(parent,'new'))}finally{fs.rmdirSync(parent)}})
