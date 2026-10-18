import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
const source=await readFile(new URL('../lib/client.js',import.meta.url),'utf8');
function context(fetchImpl=async()=>({ok:true,json:async()=>({ok:true,value:{id:'saved'}})})) {
 const calls=[];
 const c=vm.createContext({Uint8Array,DataView,Math,Map,AbortSignal,crypto:globalThis.crypto,btoa,fetch:fetchImpl,window:{dispatchEvent:e=>calls.push(e)},CustomEvent:class{constructor(type,init){this.type=type;this.detail=init.detail;}}});
 vm.runInContext(source.slice(source.indexOf('function voiceBytesBase64'),source.indexOf('function VoiceConversationDock')),c);
 return {c,calls};
}
test('recorded PCM becomes real PCM16 WAV with sample length and rate',()=>{
 const {c}=context();const wav=c.voicePcmWav(new Float32Array([-1,0,1,.5]),16000);const view=new DataView(wav.buffer);
 assert.equal(Buffer.from(wav.slice(0,4)).toString(),'RIFF');assert.equal(view.getUint32(40,true),8);assert.equal(view.getUint32(24,true),16000);assert.equal(view.getInt16(44,true),-32768);assert.equal(view.getInt16(48,true),32767);
});
test('storage reports failure and never manufactures a receipt',async()=>{
 const {c,calls}=context(async()=>({ok:false,json:async()=>({ok:false,error:'disk full'})}));
 await assert.rejects(c.voiceStoreMessage({s:'session',id:'one'}),/disk full/);assert.equal(calls.length,0);
});
test('storage posts original audio with session and dispatches refresh after commit',async()=>{
 let received;const {c,calls}=context(async(url,options)=>{received={url,body:JSON.parse(options.body)};return{ok:true,json:async()=>({ok:true,value:{id:'one'}})}});
 await c.voiceStoreMessage({s:'session',id:'one',audio:'UklGRg=='});assert.equal(received.url,'/m/api/voice');assert.equal(received.body.audio,'UklGRg==');assert.equal(calls[0].detail,'session');
});
test('assistant complete sentence persists playable original bytes and final text',async()=>{
 let body;const {c}=context(async(url,opts)=>{body=JSON.parse(opts.body);return{ok:true,json:async()=>({ok:true,value:body})}});
 vm.runInContext('voiceReplyOwners.set("s",{id:"user-id",requestId:"r"})',c);
 const wav=c.voicePcmWav(new Float32Array(16000));c.voiceRememberReply({sessionId:'s',text:'你好'},wav,'audio/wav');await new Promise(r=>setImmediate(r));
 assert.equal(body.text,'你好');assert.equal(body.role,'assistant');assert.equal(body.durationMs,1000);assert.equal(body.replyTo,'user-id');assert.equal(Buffer.from(body.audio,'base64').length,32044);
});
test('failed reply storage retains original audio for explicit retry',async()=>{
 const {c}=context(async()=>{throw new Error('offline')});vm.runInContext('voiceReplyOwners.set("s",{id:"u",requestId:"r"})',c);c.voiceRememberReply({sessionId:'s',text:'回答'},c.voicePcmWav(new Float32Array(16)),'audio/wav');await new Promise(r=>setImmediate(r));assert.equal(vm.runInContext('voiceUnstoredReplies.size',c),1);
});
test('draft remains manual and telephone exposes independent accessible controls',()=>{
 assert.match(source,/if \(voiceKindRef.current !== "draft"\) \{[\s\S]*?voicePcmWav\(meta.pcm/);
 assert.match(source,/const meta = \{ force: forcePending, pcm: sliceChunks\(recoverySegment, 0\)/);
 assert.match(source,/'DSH 语音电话'/);assert.match(source,/onMute:.*mutedRef.current/s);
 assert.match(source,/if \(!active \|\| inFlush \|\| config.isMuted\?\.\(\)\) return/);
});
function sendContext(store) {
 const events=[];
 const c=vm.createContext({captureGenerationRef:{current:0},mutedRef:{current:false},voiceSavingRef:{current:false},pendingVoiceRef:{current:null},sidRef:{current:'s'},localRef:{current:'on'},setPendingVoice:x=>events.push(['pending',x]),voiceStoreMessage:store,voiceReplyOwners:new Map(),voiceReplyOwnersByRequest:new Map(),actionsRef:{current:{setDraft:x=>events.push(['draft',x]),submit:()=>{}}},voicePrompt:async x=>events.push(['submit',x.text]),submitDraftNow:x=>events.push(['submit',x]),bus:{setUi:x=>events.push(['ui',x])}});
 const start=source.indexOf('  const sendSavedVoice = async (item) => {'),end=source.indexOf('  const scheduleAutoSend = () => {',start);
 vm.runInContext(source.slice(start,end)+'\nglobalThis.send=sendSavedVoice;',c);
 return {c,events};
}
test('user voice is durably stored before draft and exactly one submit',async()=>{
 let release;const {c,events}=sendContext(()=>new Promise(r=>release=r));
 const p=c.send({s:'s',id:'uuid',requestId:'req',text:'原话'});assert.equal(events.some(x=>x[0]==='submit'),false);release();await p;
 assert.equal(events.filter(x=>x[0]==='submit').length,1);assert.equal(events.at(-1)[1],'原话');assert.equal(c.pendingVoiceRef.current,null);
});
test('storage failure retains original item and never submits',async()=>{
 const {c,events}=sendContext(async()=>{throw new Error('offline')});const item={s:'s',id:'uuid',audio:'original',text:'原话'};await c.send(item);
 assert.equal(c.pendingVoiceRef.current.audio,'original');assert.equal(events.some(x=>x[0]==='submit'),false);
});
test('hanging up during saving cannot send a late model prompt',async()=>{
 let release;const {c,events}=sendContext(()=>new Promise(r=>release=r));const p=c.send({s:'s',id:'uuid',text:'hi'});c.localRef.current='off';release();await p;assert.equal(events.some(x=>x[0]==='submit'),false);
});
test('manual AEC fallback captures ordinary toggle speech but gates speaker echo',()=>{
 const expression=source.match(/if \((runtimeBargeInMode === "manual" && !holdActive && \(config.mode === "hold" \|\| config.isPlaying\?\.\(\)\))\) return;/)?.[1];assert.ok(expression);
 const blocked=(mode,playing,held=false)=>vm.runInNewContext(expression,{runtimeBargeInMode:'manual',holdActive:held,config:{mode,isPlaying:()=>playing}});
 assert.equal(blocked('toggle',false),false);assert.equal(blocked('toggle',true),true);assert.equal(blocked('hold',false),true);assert.equal(blocked('hold',true,true),false);
});
test('telephone interrupt routes through real cancellation and ASR reset',()=>{
 assert.match(source,/onInterrupt:\(\)=>void breakRef.current\?\.\(\)/);assert.match(source,/onClick:onInterrupt/);
 const body=source.slice(source.indexOf('const hardBreak = async'),source.indexOf('breakRef.current = hardBreak'));
 assert.match(body,/bus.cancelTurn/);assert.match(body,/\/cancel/);assert.match(body,/discardSegment/);
});
test('muting then unmuting during storage cannot submit the old recording',async()=>{
 let release;const {c,events}=sendContext(()=>new Promise(r=>release=r));const p=c.send({s:'s',id:'uuid',text:'hi'});c.captureGenerationRef.current+=2;release();await p;assert.equal(events.some(x=>x[0]==='submit'),false);
 assert.match(source,/onMute:[\s\S]*?discardSegment\(\)/);
});
test('single voice entry opens three actions and selection starts chosen mode',()=>{
 let open=false;const selected=[];
 const React={useState:()=>[open,v=>{open=typeof v==='function'?v(open):v}],useRef:()=>({current:null}),useEffect:()=>{},createElement:(tag,props,...children)=>({tag,props:props||{},children})};
 const c=vm.createContext({React,VoiceSoundSettings:()=>null});vm.runInContext(source.slice(source.indexOf('function VoiceModeMenu('),source.indexOf('function MicButton(')),c);
 let root=c.VoiceModeMenu({onChoose:x=>selected.push(x)});assert.equal(root.children[0].children[0],'语音');assert.equal(root.children[1],false);root.children[0].props.onClick();assert.equal(selected.length,0);
 root=c.VoiceModeMenu({onChoose:x=>selected.push(x)});const menu=root.children[1];assert.equal(menu.props.role,'menu');assert.equal(menu.children.length,5);assert.deepEqual(menu.children.slice(0,3).map(x=>x.props.role),['menuitem','menuitem','menuitem']);
 menu.children[1].props.onClick();assert.deepEqual(selected,['message']);assert.equal(open,false);
});
test('idle pointer cannot bypass menu and mode selection updates ref before entry',()=>{
 assert.match(source,/const onPointerDown = \(e\) => \{\s*if \(localRef.current !== "on" \|\| voiceKindRef.current === "message"\) return;/);
 assert.match(source,/const onPointerUp = \(e\) => \{\s*if \(localRef.current !== "on" \|\| voiceKindRef.current === "message"\) return;/);
 assert.match(source,/onChoose:\(kind\)=>\{ voiceKindRef.current=kind; setVoiceKind\(kind\); void enterMode\(\); \}/);
 assert.doesNotMatch(source,/React.createElement\("select", \{\s*"aria-label": "语音模式"/);
 assert.match(source,/local !== "off" && !\(voiceKind === "call" && local === "on"\)/);
});
test('idle default draft shows persisted history without microphone and hides empty history',()=>{
 const compile=(history)=>{
  let at=0;const states=[history,{},0,''];const React={useState:()=>[states[at++],()=>{}],useRef:()=>({current:null}),useEffect:()=>{},createElement:(tag,props,...children)=>({tag,props:props||{},children})};
  const c=vm.createContext({React,voiceUnstoredReplies:new Map()});vm.runInContext(source.slice(source.indexOf('function VoiceConversationDock('),source.indexOf('function VoiceModeMenu(')),c);
  return c.VoiceConversationDock({bus:{ui:{}},sessionId:'s',kind:'draft',active:false});
 };
 assert.equal(compile([]),null);
 const view=compile([{id:'a',role:'user',text:'手机录音',url:'/m/api/voice/audio?s=s&id=a'}]);assert.equal(view.tag,'details');assert.equal(view.children[0].tag,'summary');assert.equal(view.children[1].children[0],'刷新语音记录');assert.equal(typeof view.props.onToggle,'function');
});
test('native message audio matches request IDs across repeated identical text',()=>{
 const {c}=context();const nodes=new Map([
 ['u1',{key:'u1',kind:'user',anchorSeq:1,data:{source:{rpcId:'r1'}}}],['a1',{key:'a1',kind:'assistant-step',anchorSeq:2}],
 ['u2',{key:'u2',kind:'user',anchorSeq:3,data:{source:{rpcId:'r2'}}}],['a2',{key:'a2',kind:'assistant-step',anchorSeq:4}]]);
 const items=[{id:'v1',role:'user',requestId:'r1',text:'你好'},{id:'v2',role:'user',requestId:'r2',text:'你好'},{id:'reply2',role:'assistant',replyTo:'v2',requestId:'r2'}];
 const bound=c.voiceInlineBindings(nodes,items);assert.deepEqual(Array.from(bound,x=>[x.key,x.item.id]),[['u1','v1'],['u2','v2'],['a2','reply2']]);
});
test('voice prompt uses persisted request ID and inherited session configuration once',async()=>{
 let request,count=0;const {c}=context(async(url,opts)=>{count++;request=JSON.parse(opts.body);assert.equal(url,'/m/api/rpc');return{ok:true,json:async()=>({ok:true,value:{}})}});
 await c.voicePrompt({s:'session',requestId:'stable',text:'原话'});assert.equal(count,1);assert.equal(request.rpcId,'stable');assert.equal(request.payload.sessionId,'session');assert.equal(request.payload.model,undefined);assert.equal(request.payload.approval,undefined);
});
test('message mode no longer renders a floating history and enter transmits the mode',()=>{
 assert.match(source,/voiceKind === "call" && local === "on" && React.createElement\(VoiceConversationDock/);
 assert.match(source,/React.createElement\(VoiceInlineMessages, \{sessionId,useSession,useChat,bus,callActive:/);
 assert.match(source,/JSON.stringify\(\{ sessionId, on: true, mode, tabId/);
 assert.match(source,/const delay = 0;/);
});
test('inline user audio aligns with the user bubble and exposes measured duration',()=>{
 assert.match(source,/if\(item.role==='user'\)\{element.style.justifyContent='flex-end';element.style.marginLeft='auto';element.style.width='fit-content';\}/);
 assert.match(source,/const duration=item.durationMs>0\?item.durationMs\/1000/);
 assert.match(source,/player.preload='metadata'/);
});
test('queued call user cannot steal previous turn audio and multiple tool steps stay one reply',()=>{
 const {c}=context();const nodes=new Map([
 ['u1',{key:'u1',kind:'user',anchorSeq:1,data:{source:{rpcId:'r1'}},location:{turn:{turn:1}}}],
 ['u2',{key:'u2',kind:'user',anchorSeq:2,data:{source:{rpcId:'r2'}},location:{turn:{turn:2}}}],
 ['a1tool',{key:'a1tool',kind:'assistant-step',anchorSeq:3,location:{turn:{turn:1}}}],
 ['a1',{key:'a1',kind:'assistant-step',anchorSeq:4,location:{turn:{turn:1}}}],
 ['a2',{key:'a2',kind:'assistant-step',anchorSeq:5,location:{turn:{turn:2}}}]]);
 const items=[{id:'v1',role:'user',requestId:'r1'},{id:'v2',role:'user',requestId:'r2'},{id:'z1',role:'assistant',replyTo:'v1',requestId:'r1'},{id:'z2',role:'assistant',replyTo:'v2',requestId:'r2'}];
 const bound=c.voiceInlineBindings(nodes,items);assert.deepEqual(Array.from(bound,x=>[x.key,x.item.id]),[['u1','v1'],['u2','v2'],['a1','z1'],['a2','z2']]);
});
test('a TTS sentence keeps its captured owner across next user and carries call metadata',async()=>{
 let body;const {c}=context(async(url,opts)=>{body=JSON.parse(opts.body);return{ok:true,json:async()=>({ok:true,value:body})}});
 vm.runInContext('voiceReplyOwners.set("s",{id:"new",requestId:"new-r"})',c);
 c.voiceRememberReply({sessionId:'s',text:'回答'},c.voicePcmWav(new Float32Array(16)),'audio/wav',{id:'old',requestId:'old-r',mode:'call',callId:'call-uuid',callStartedAt:'2026-10-12T00:00:00Z'});
 await new Promise(r=>setImmediate(r));assert.equal(body.replyTo,'old');assert.equal(body.requestId,'old-r');assert.equal(body.mode,'call');assert.equal(body.callId,'call-uuid');
});
test('a sentence with explicitly missing owner is never attributed to a later user',async()=>{
 let calls=0;const {c}=context(async()=>{calls++;return{ok:true,json:async()=>({ok:true})}});vm.runInContext('voiceReplyOwners.set("s",{id:"new",requestId:"new-r"})',c);
 c.voiceRememberReply({sessionId:'s'},c.voicePcmWav(new Float32Array(16)),'audio/wav',null);await new Promise(r=>setImmediate(r));assert.equal(calls,0);
});
test('preview preserves backend failure detail instead of claiming a playback failure',async()=>{
 const c=vm.createContext({AbortSignal,fetch:async()=>({ok:false,status:503,json:async()=>({error:{message:'local engine unavailable'}})})});
 vm.runInContext(source.slice(source.indexOf('async function voicePreviewBlob'),source.indexOf('function VoiceSoundSettings')),c);
 await assert.rejects(c.voicePreviewBlob('kokoro:48',1.1),/local engine unavailable/);
});
test('preview uses chosen voice without changing configured voice and returns actual audio',async()=>{
 let sent;const bytes=new Blob([new Uint8Array([1,2,3])],{type:'audio/wav'});
 const c=vm.createContext({AbortSignal,fetch:async(url,opts)=>{sent={url,body:JSON.parse(opts.body)};return{ok:true,blob:async()=>bytes}}});
 vm.runInContext(source.slice(source.indexOf('async function voicePreviewBlob'),source.indexOf('function VoiceSoundSettings')),c);
 const result=await c.voicePreviewBlob('fushiyu',1.1);assert.equal(result.size,3);assert.equal(sent.url,'/voice-mode/preview');assert.equal(sent.body.voice,'fushiyu');
 assert.match(source,/'aria-label':'声音试听播放器'/);assert.match(source,/试听已生成，点击下方播放按钮即可收听/);
});
test('inline growing grouped response updates duration without replacing the audio element',()=>{
 assert.match(source,/element._voiceItem=item;element._queue=queue/);
 assert.match(source,/player.dataset.voiceUrl!==item.url&&player.paused/);
});
test('compact bubble converges without duplicate observer mutations',()=>{
 const {c}=context();let value='',mutations=0,aria='';
 const button={get textContent(){return value},set textContent(v){value=v;mutations++},getAttribute(){return aria},setAttribute(_,v){aria=v}};
 const player={paused:true,duration:3};const element={_voiceItem:{role:'assistant',durationMs:3000},querySelector:t=>t==='audio'?player:button};
 for(let i=0;i<5;i++)c.refreshVoiceBubble(element);assert.equal(mutations,1);assert.match(value,/3″/);
 element._voiceItem.durationMs=6000;c.refreshVoiceBubble(element);c.refreshVoiceBubble(element);assert.equal(mutations,2);
 player.paused=false;c.refreshVoiceBubble(element);assert.match(aria,/点击暂停/);
});
test('message uses one click to begin and one click to finish once, without exit or hold gestures',()=>{
 const start=source.indexOf('  const toggle = () => {'),end=source.indexOf('  const toggleRef =',start);const body=source.slice(start,end);
 const events=[];const engine={holding:false,beginHeld(){this.holding=true;events.push('begin')},endHeld(){this.holding=false;events.push('finish')}};
 const c=vm.createContext({localRef:{current:'on'},voiceKindRef:{current:'message'},engineRef:{current:engine},voiceSavingRef:{current:false},pendingVoiceRef:{current:null},bus:{ui:{},setUi(){}},runningRef:{current:false},setHolding(){}});
 vm.runInContext(body+'\nglobalThis.click=toggle;',c);c.click();c.click();assert.deepEqual(events,['begin','finish']);
 c.voiceSavingRef.current=true;c.click();assert.deepEqual(events,['begin','finish']);
});
test('compact original audio buttons toggle playback and enforce a single active player',async()=>{
 const {c}=context();const audios=[];
 function node(tag){const n={tag,dataset:{},style:{},children:[],attrs:{},textContent:'',paused:true,duration:10,append(...children){this.children.push(...children)},querySelector(t){return this.children.find(x=>x.tag===t)},getAttribute(k){return this.attrs[k]},setAttribute(k,v){this.attrs[k]=v},pause(){this.paused=true;this.onpause?.()},play(){this.paused=false;this.onplay?.();return Promise.resolve()}};if(tag==='audio')audios.push(n);return n;}
 c.document={createElement:node,querySelectorAll:()=>audios};
 const a=c.makeVoiceBubble({id:'u',role:'user',durationMs:10000,url:'/audio/u'}),b=c.makeVoiceBubble({id:'a',role:'assistant',durationMs:5000,url:'/audio/a'});
 a.querySelector('button').onclick();assert.equal(audios[0].paused,false);
 b.querySelector('button').onclick();assert.equal(audios[0].paused,true);assert.equal(audios[1].paused,false);
 b.querySelector('button').onclick();assert.equal(audios[1].paused,true);assert.equal(audios[0].src,'/audio/u');assert.equal(audios[0].hidden,true);assert.match(a.querySelector('button').textContent,/10″/);
});
test('completed message voice turn has text fallback placeholder before audio without touching typed turn',()=>{
 const {c}=context();const nodes=new Map([['u',{key:'u',kind:'user',anchorSeq:1,data:{source:{rpcId:'r'}},location:{turn:{turn:1}}}],['a',{key:'a',kind:'assistant-step',anchorSeq:2,data:{finalNode:{},blocks:[{kind:'text',text:'reply'}]},location:{turn:{turn:1,status:'closed'}}}],['typed',{key:'typed',kind:'user',anchorSeq:3,data:{source:{rpcId:'typed'}}}]]);
 const bindings=c.voiceInlineBindings(nodes,[{id:'v',role:'user',mode:'message',requestId:'r'}]);assert.equal(bindings.length,2);assert.equal(bindings[1].item.pending,true);assert.equal(bindings[1].item.text,'reply');
});
test('only matching final text nodes are hidden, original display restored, calls and tools remain visible',()=>{
 const {c}=context();const text={},thinking={};const target={querySelector:()=>({children:[thinking,text]}),querySelectorAll:()=>[text]};
 const node={location:{turn:{status:'closed'}},data:{finalNode:{},blocks:[{kind:'reasoning'},{kind:'text'},{kind:'tool-call'}]}};
 assert.deepEqual(Array.from(c.voiceTextNodes(target,{voiceRequestId:'r',item:{role:'assistant',mode:'message',requestId:'r'},node})),[text]);assert.equal(c.voiceTextNodes(target,{item:{role:'assistant',mode:'call'},node}).length,0);
 let value='flex',priority='',writes=0;const element={style:{getPropertyValue:()=>value,getPropertyPriority:()=>priority,setProperty:(_,v,p)=>{value=v;priority=p;writes++},removeProperty:()=>{value='';priority='';writes++}}};const originals=new Map();c.setVoiceTextVisible([element],false,originals);c.setVoiceTextVisible([element],false,originals);assert.equal(writes,1);assert.equal(value,'none');c.setVoiceTextVisible([element],true,originals);assert.equal(value,'flex');assert.equal(priority,'');
});
test('continuous playback follows loaded order and cancellation stops advancing',()=>{
 const {c}=context(),played=[];const entries=['a','b'].map(id=>{const audio={pause(){},play(){played.push(id);return Promise.resolve()}};return{querySelector:()=>audio}});c.document={querySelectorAll:()=>entries.map(x=>x.querySelector())};const queue=c.createVoiceQueue(()=>entries);queue.start(entries[0]);assert.deepEqual(played,['a']);entries[0]._queueEnded();assert.deepEqual(played,['a','b']);queue.cancel();assert.equal(entries[1]._queueEnded,null);
});
test('voice-saved pushes merge same-session metadata immediately and reject audio payloads',()=>{
 const {c}=context(),items=[{id:'v',role:'user',text:'old'}];
 assert.equal(c.mergeVoiceSaved(items,{s:'other',item:{id:'x',role:'user'}},'s'),items);
 assert.equal(c.mergeVoiceSaved(items,{s:'s',item:{id:'x',role:'user',audio:'private-base64'}},'s'),items);
 const merged=c.mergeVoiceSaved(items,{s:'s',item:{id:'v',role:'user',text:'new',url:'/m/api/voice/audio?s=s&id=v'}},'s');assert.equal(merged.length,1);assert.equal(merged[0].text,'new');
 assert.equal(c.mergeVoiceSaved(items,{s:'s',item:{id:'chunk',role:'assistant',mode:'call'}},'s'),items);
 assert.match(source,/events.close\(\)/);assert.match(source,/source.onopen=.*onOpen/);
});
test('background tab releases metadata SSE and visibility opens only one replacement',()=>{
 const {c}=context(),sources=[],listeners=new Set();let refreshes=0,received=0;
 c.document={hidden:true,addEventListener:(_,fn)=>listeners.add(fn),removeEventListener:(_,fn)=>listeners.delete(fn)};
 c.EventSource=class{constructor(url){this.url=url;this.closed=false;sources.push(this)}addEventListener(_,fn){this.saved=fn}close(){this.closed=true}};
 const dispose=c.watchVisibleVoiceEvents('s',()=>received++,()=>refreshes++);
 assert.equal(sources.length,0);assert.equal(listeners.size,1);
 c.document.hidden=false;listeners.forEach(fn=>fn());listeners.forEach(fn=>fn());assert.equal(sources.length,1);assert.equal(refreshes,1);
 c.document.hidden=true;listeners.forEach(fn=>fn());assert.equal(sources[0].closed,true);sources[0].saved({});assert.equal(received,0);
 c.document.hidden=false;listeners.forEach(fn=>fn());assert.equal(sources.length,2);sources[1].onopen();sources[1].saved({});assert.equal(received,1);
 dispose();assert.equal(sources[1].closed,true);assert.equal(listeners.size,0);sources[1].saved({});assert.equal(received,1);
});
test('open voice turn text deltas create pending bubble and hide only exact linked text before finalNode',()=>{
 const {c}=context(),text={},reason={};const user={key:'u',kind:'user',anchorSeq:1,data:{source:{rpcId:'voice-r'}},location:{turn:{turn:1,status:'open'}}};
 const assistant={key:'a',kind:'assistant-step',anchorSeq:2,data:{status:'running',blocks:[{kind:'reasoning',text:'thinking'},{kind:'text',text:'正在回答'}]},location:{turn:{turn:1,status:'open'}}};
 const nodes=new Map([['u',user],['a',assistant]]),items=[{id:'v',role:'user',requestId:'voice-r',mode:'message'}];
 const result=c.voiceInlineBindings(nodes,items),pending=result.find(b=>b.key==='a');assert.ok(pending);assert.equal(pending.item.pending,true);assert.equal(pending.item.streaming,true);assert.equal(pending.node.data.finalNode,undefined);
 const target={querySelector:()=>({children:[reason,text]})};assert.deepEqual(Array.from(c.voiceTextNodes(target,pending)),[text]);
 assert.equal(c.voiceTextNodes(target,{...pending,voiceRequestId:'unrelated'}).length,0);
 assert.equal(c.voiceInlineBindings(nodes,[{...items[0],requestId:'other'}]).length,0);
});
