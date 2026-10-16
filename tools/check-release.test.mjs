import {test} from 'node:test'
import assert from 'node:assert/strict'
import {checkFile} from './check-release.mjs'
test('release gate rejects runtime paths and credentials without echoing secret values',()=>{
 assert.ok(checkFile('recovery-host/data/state.json',Buffer.from('{}')).length)
 const fake='ghp_'+'a'.repeat(36);const errors=checkFile('config.js',Buffer.from(fake));assert.ok(errors.length);assert.ok(!errors.join('').includes(fake))
 assert.deepEqual(checkFile('plugin/test/fixture.mjs',Buffer.from('const token="test"')),[])
})
