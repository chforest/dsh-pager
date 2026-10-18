import {spawnSync} from 'node:child_process'
import assert from 'node:assert/strict'
const child=spawnSync(process.argv[2],[],{input:JSON.stringify({action:'open',path:process.argv[3]}),encoding:'utf8',windowsHide:true,timeout:10000})
assert.ifError(child.error)
assert.equal(child.status,1)
assert.deepEqual(JSON.parse(child.stdout),{ok:false,error:'FILE_ACTION_FAILED'})
assert.match(child.stderr,/^FILE_ACTION_ERROR type=FileNotFoundException hresult=-?\d+/)
console.log('PASS: GUI subsystem compiled; Node pipes returned structured missing-file failure; no GUI action invoked')
