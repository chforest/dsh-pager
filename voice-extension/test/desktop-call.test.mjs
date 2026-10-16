import{test}from'node:test';import assert from'node:assert/strict';import fs from'node:fs';import vm from'node:vm';
const source=fs.readFileSync(new URL('../lib/client.js',import.meta.url),'utf8');
test('call prompts never enter the ordinary queue while message prompts keep queue semantics',async()=>{
 const sent=[];const context=vm.createContext({AbortSignal,fetch:async(url,opts)=>{sent.push(JSON.parse(opts.body));return{ok:true,json:async()=>({ok:true,value:{accepted:true}})}}});
 vm.runInContext(source.slice(source.indexOf('async function voicePrompt('),source.indexOf('function voiceInlineBindings(')),context);
 await context.voicePrompt({s:'session-fixture',requestId:'call-1',mode:'call',text:'同一句话'});
 await context.voicePrompt({s:'session-fixture',requestId:'message-1',mode:'message',text:'语音消息'});
 assert.equal(sent[0].payload.mode,'steer','telephone speech must not appear in normal queued-message list');assert.equal(sent[1].payload.mode,'queue');
});
test('call capture must not use the regression 900ms ceiling for natural speech pauses',()=>{
 const context=vm.createContext({});vm.runInContext(source.slice(source.indexOf('function voiceModeConfig('),source.indexOf('function MicButton(')),context);
 assert.ok(context.voiceModeConfig({silenceMs:1500},'call').silenceMs>=1200,'900ms fragments ordinary speech into multiple turns');
});
test('phone locally combines consecutive ASR segments into one transcript and original PCM record',()=>{
 const c=vm.createContext({setTimeout,clearTimeout});vm.runInContext(source.slice(source.indexOf('function createCallTurnBuffer'),source.indexOf('function MicButton')),c);
 const timers=new Map(),sent=[];let key=0,busy=false,active=true;
 const buffer=c.createCallTurnBuffer({submit:(text,meta)=>sent.push({text,meta}),isActive:()=>active,isBusy:()=>busy,schedule:fn=>{timers.set(++key,fn);return key},unschedule:id=>timers.delete(id)});
 const add=(text,n)=>buffer.add(text,{pcm:new Float32Array([n,n]),sampleRate:16000});add('你好',1);add('我现在',2);add('想问一个问题',3);assert.equal(timers.size,1);
 const fire=()=>{const [id,fn]=[...timers][0];timers.delete(id);fn()};busy=true;fire();assert.equal(sent.length,0);busy=false;fire();assert.equal(sent.length,1);assert.equal(sent[0].text,'你好 我现在 想问一个问题');assert.deepEqual(Array.from(sent[0].meta.pcm),[1,1,2,2,3,3]);
 add('挂断后不发送',4);active=false;fire();assert.equal(sent.length,1);buffer.dispose();add('迟到',5);assert.equal(timers.size,0);
});
test('phone distinguishes listening thinking and speaking without mislabelling thinking as listening',()=>{
 const c=vm.createContext({setTimeout,clearTimeout});vm.runInContext(source.slice(source.indexOf('function phoneCallStatus'),source.indexOf('function MicButton')),c);
 assert.match(c.phoneCallStatus({callModelRunning:true},false),/正在思考/);assert.match(c.phoneCallStatus({playing:true},false),/正在说话/);assert.match(c.phoneCallStatus({},false),/正在听/);assert.match(c.phoneCallStatus({callPhase:'collecting',callModelRunning:true},false),/补充/);
});
test('real PCM capture ignores premature server endpoints until 1400ms call silence',async()=>{
 let processor,now=10000,finalAt=null;const finals=[];
 class AC{sampleRate=16000;destination={};resume(){return Promise.resolve()}close(){return Promise.resolve()}createMediaStreamSource(){return{connect(){}}}createScriptProcessor(){processor={connect(){},disconnect(){}};return processor}}
 const track={stop(){},getSettings:()=>({echoCancellation:true})};
 const c=vm.createContext({window:{AudioContext:AC},navigator:{mediaDevices:{getUserMedia:async()=>({getTracks:()=>[track],getAudioTracks:()=>[track]})}},location:{origin:'http://fixture.invalid'},fixtureRecorder:{isActive:false},Date:class extends Date{static now(){return now}},performance:{now:()=>now},console,AbortSignal,setTimeout,clearTimeout,fetch:async url=>{const final=url.includes('final=1');if(final)finalAt=now;return{ok:true,status:200,json:async()=>({text:final?'完整一句话':'',endpoint:true,isSpeech:false})}}});
 vm.runInContext(source.slice(source.indexOf('var SAMPLE_RATE2 ='),source.indexOf('// src/aec.ts')),c);
 const engine=c.createAsrEngine({basePath:'/voice-mode',mode:'toggle',silenceMs:1400,endpointSilenceMs:1400,bargeInMode:'auto',isPlaying:()=>false},'fixture-no-model');engine.onSegment(text=>finals.push(text));await engine.start();
 const feed=async value=>{now+=64;processor.onaudioprocess({inputBuffer:{getChannelData:()=>new Float32Array(1024).fill(value)}});await new Promise(r=>setImmediate(r))};
 for(let i=0;i<10;i++)await feed(.12);assert.equal(finalAt,null,'server endpoint during active speech must not split the utterance');
 for(let i=0;i<16;i++)await feed(0);assert.equal(finalAt,null,'a 1024ms natural pause must not submit');
 for(let i=0;i<5;i++)await feed(.12);const end=now;for(let i=0;i<23&&finalAt===null;i++)await feed(0);
 assert.equal(finalAt-end,1408);assert.deepEqual(finals,['完整一句话']);await engine.stop();
});
test('manual echo fallback gives button interruption guidance instead of promising auto barge-in',()=>{
 const c=vm.createContext({});vm.runInContext(source.slice(source.indexOf('function phoneCallStatus'),source.indexOf('function MicButton')),c);
 assert.match(c.phoneCallStatus({playing:true,bargeInDetectFallback:true},false),/可点/);
 assert.doesNotMatch(c.phoneCallStatus({playing:true,boot:{bargeInMode:'manual'}},false),/直接开口/);
 assert.match(c.phoneCallStatus({playing:true,boot:{bargeInMode:'auto'}},false),/直接开口/);
});
test('call owns a single phone panel while legacy status bar and mini overlay remain hidden',()=>{
 const c=vm.createContext({useLang(){},import_react3:{useState:init=>[typeof init==='function'?init():init,()=>{}],useEffect(){}},import_jsx_runtime2:{jsx:()=>null,Fragment:'fragment'}});
 vm.runInContext(source.slice(source.indexOf('function VoiceStatusBar('),source.indexOf('function VoiceOverlay(')),c);
 vm.runInContext(source.slice(source.indexOf('function VoiceOverlay('),source.lastIndexOf('return module.exports;')),c);
 const bus={activeSessionId:'s',ui:{voiceKind:'call',playing:true}};assert.equal(c.VoiceStatusBar({bus,sessionId:'s'}),null);assert.equal(c.VoiceOverlay({bus}),null);assert.match(source,/ui.voiceKind = mode;/);
});
test('busy session accepts a call as non-destructive supplement while draft and message guards retain purpose',()=>{
 const c=vm.createContext({});vm.runInContext(source.slice(source.indexOf('function voiceEntryError'),source.indexOf('function MicButton')),c);
 assert.equal(c.voiceEntryError('call','',true),null);assert.match(c.voiceEntryError('call','已有草稿',true),/先处理输入框草稿/);
 assert.match(c.voiceEntryError('message','',true),/等待完成/);assert.equal(c.voiceEntryError('message','',false),null);
 assert.equal(c.voiceEntryError('draft','已有草稿',true),null);
 assert.equal((source.match(/voiceEntryError\(voiceKindRef.current,draftRef.current,runningRef.current\)/g)||[]).length,2);
 assert.match(source,/callModelRunning:runningRef.current,callPhase:runningRef.current\?'thinking':'listening'/);
});
