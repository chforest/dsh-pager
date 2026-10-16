import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
let dependenciesPresent=true;
try{require.resolve('@deepseek-ai/schemastery');require.resolve('sherpa-onnx');}catch{dependenciesPresent=false;}
test('installed host entry imports without model download or starting capture',{skip:dependenciesPresent?false:'Install voice-extension npm dependencies to exercise host import'},async()=>{const host=await import('../lib/index.js');assert.equal(typeof host.apply,'function');assert.ok(host.Config);});
test('browser client registers with the native module loader without running UI',()=>{let registration;vm.runInNewContext(fs.readFileSync(new URL('../lib/client.js',import.meta.url),'utf8'),{window:{__ModuleLoader__:{load:value=>registration=value}}});assert.equal(registration.id,'dsh-voice-mode');assert.equal(typeof registration.factory,'function');});
