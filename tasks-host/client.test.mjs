import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const source=fs.readFileSync(new URL('./client.js',import.meta.url),'utf8');
const pageSource=fs.readFileSync(new URL('../plugin/www/tasks.js',import.meta.url),'utf8');
function loadClient(){let api;vm.runInNewContext(source,{window:{__ModuleLoader__:{load:value=>{api=value.factory(()=>({createElement(){}}));}}}});return api;}
function loadPage(){const module={exports:{}};vm.runInNewContext(pageSource,{module,Date,URL,Number,Set,JSON,Error,crypto:{randomUUID:()=> '00000000-0000-4000-8000-000000000001'}});return module.exports;}
const plain=value=>JSON.parse(JSON.stringify(value));
const response=value=>({ok:true,status:200,json:async()=>({ok:true,value})});

test('desktop registers only a native task conversation view and an encoded same-origin iframe URL',()=>{
  const api=loadClient(),calls=[];
  api.apply({slots:{inject(name,fn){calls.push(name);fn();},register(definition,component){calls.push(definition);assert.equal(component,api.TasksView);}}});
  assert.equal(calls[0],'conversation.view');assert.equal(calls[1].id,'automatic-tasks');assert.equal(calls[1].label,'任务');assert.equal(calls[1].order,30);
  const url=new URL(api.taskPageUrl('session-a&next=https://bad.test'),'https://dsh.local');
  assert.equal(url.origin,'https://dsh.local');assert.equal(url.pathname,'/m/tasks.html');assert.equal(url.searchParams.get('s'),'session-a&next=https://bad.test');assert.equal(url.searchParams.get('embedded'),'1');
  assert.doesNotMatch(source,/conversation\.input|input\.actions/);
});

test('desktop chat navigation accepts only its own same-origin iframe and uses native sessions.open',()=>{
  const api=loadClient(),frame={},origin='https://dsh.local',event={origin,source:frame,data:{type:'dsh-task-open-session',sessionId:'session-known'}};
  assert.equal(api.taskNavigationId(event,frame,origin),'session-known');
  assert.equal(api.taskNavigationId({...event,origin:'https://other.test'},frame,origin),null);
  assert.equal(api.taskNavigationId({...event,source:{}},frame,origin),null);
  assert.equal(api.taskNavigationId({...event,data:{type:'dsh-task-open-session',sessionId:'https://bad.test'}},frame,origin),null);
  let definition,opened;api.apply({sessions:{open:id=>{opened=id;}},slots:{inject(name,fn){fn();},register(value){definition=value;}}});
  definition.inject().onOpenSession('session-known');assert.equal(opened,'session-known');
  assert.doesNotMatch(source,/location\.href\s*=|layout\.focus/);
});

test('desktop task iframe is bounded by the visible viewport rather than content scroll height',()=>{
  let api;const React={createElement:(tag,props,...children)=>({tag,props,children}),useRef:()=>({current:null}),useEffect(){}};
  vm.runInNewContext(source,{window:{__ModuleLoader__:{load:value=>{api=value.factory(()=>React);}}}});
  const view=api.TasksView({sessionId:'session-one',onOpenSession(){}}),iframe=view.children[0];
  assert.equal(view.props.style.height,'max(260px, calc(100dvh - 260px))');assert.equal(view.props.style.overflow,'hidden');
  assert.equal(iframe.props.style.height,'100%');assert.equal(iframe.tag,'iframe');
  assert.doesNotMatch(source,/ResizeObserver|scrollHeight|setHeight|paddingBottom/);
});

test('task schedule expresses Beijing once/delay/interval/daily/weekly without guessing execution times',()=>{
  const api=loadPage(),now=Date.parse('2026-10-13T00:00:00Z');
  assert.equal(api.scheduleFrom({execution:'once',at:'2026-10-14T09:00'},now).at,'2026-10-14T01:00:00.000Z');
  assert.equal(api.scheduleFrom({execution:'delay',minutes:30},now).at,'2026-10-13T00:30:00.000Z');
  assert.equal(api.scheduleFrom({execution:'interval',minutes:5},now).seconds,300);
  assert.throws(()=>api.scheduleFrom({execution:'interval',minutes:4},now),/至少/);
  assert.throws(()=>api.scheduleFrom({execution:'once',at:'2026-10-12T09:00'},now),/未来/);
  assert.deepEqual(plain(api.scheduleFrom({execution:'weekly',time:'09:30',days:[1,3,5]},now).days),[1,3,5]);
  assert.equal(api.scheduleFrom({execution:'daily',time:'09:00'},now).days.length,7);
  assert.throws(()=>api.scheduleFrom({execution:'weekly',time:'09:30',days:[]},now),/星期/);
});

test('task payload keeps backend permission default and requires an explicit workspace',()=>{
  const api=loadPage(),values={objective:'整理素材',workspaceId:'w1',execution:'manual',continuous:true};
  assert.equal(api.permissionLabel('read-only','read-only'),'只读');assert.equal(api.permissionLabel('workspace-write','workspace-write'),'工作区写入');assert.equal(api.permissionLabel('danger-full-access','danger-full-access'),'完全访问');
  const task=api.taskFrom(values,'s1');assert.equal(task.sourceSessionId,'s1');assert.equal(task.maxGoalRounds,8);assert.equal(task.continuous,true);assert.equal('permissionPreset' in task,false);
  assert.equal(api.taskFrom({...values,permissionPreset:'read-only'},'s1').permissionPreset,'read-only');
  assert.throws(()=>api.taskFrom({...values,workspaceId:''},'s1'),/工作区/);assert.throws(()=>api.taskFrom({...values,maxGoalRounds:101},'s1'),/轮数/);
});

test('task workspace follows the current session and never carries that source into a different workspace',()=>{
  const api=loadPage(),workspaces=[{workspaceId:'one',sessionIds:['session-one']},{workspaceId:'two',sessionIds:['session-two']}];
  assert.equal(api.defaultWorkspace(workspaces,'session-two','one'),'two');
  assert.equal(api.sourceForWorkspace(workspaces,'two','session-two'),'session-two');
  assert.equal(api.sourceForWorkspace(workspaces,'one','session-two'),undefined);
  const task=api.taskFrom({objective:'整理',workspaceId:'one',execution:'manual'},api.sourceForWorkspace(workspaces,'one','session-two'));
  assert.equal('sourceSessionId' in task,false);assert.equal('permissionPreset' in task,false);
  assert.equal(api.defaultWorkspace(workspaces,'unknown',undefined),'');
});

test('task reads reject late snapshots and cannot override a mutation with a stale list',async()=>{
  const waiting=[],api=loadPage(),client=api.createClient((url,options)=>new Promise(resolve=>waiting.push({resolve,options})),()=> 'request-id');
  const older=client.read(),newer=client.read();waiting[1].resolve(response({tasks:['new']}));assert.equal((await newer).current,true);waiting[0].resolve(response({tasks:['old']}));assert.equal((await older).current,false);
  const read=client.read(),write=client.write({action:'pause',id:'t1'});waiting[2].resolve(response({tasks:['stale']}));assert.equal((await read).current,false);
  assert.equal((await client.read()).current,false,'no parallel read paints old state during a pending mutation');waiting[3].resolve(response({id:'t1'}));await write;
});

test('task mutation locks double-click and unknown outcomes retry only explicitly with the same request id',async()=>{
  let release;const calls=[],api=loadPage(),client=api.createClient((url,options)=>{calls.push(JSON.parse(options.body));return new Promise(resolve=>{release=resolve;});},()=> 'stable-operation');
  const first=client.write({action:'create',task:{title:'test'}});await assert.rejects(client.write({action:'create',task:{title:'test'}}),/处理中/);assert.equal(calls.length,1);
  release(response({id:'t1'}));await first;
  let count=0;const wire=[],unknown=api.createClient(async(url,options)=>{wire.push(options.body);if(++count===1)throw new Error('lost response');return response({id:'confirmed'});},()=> 'same-id');
  await assert.rejects(unknown.write({action:'create',task:{title:'test'}}));assert.equal(wire.length,1);assert.ok(unknown.uncertainRequest);
  await assert.rejects(unknown.write({action:'create',task:{title:'another'}}),/确认/);assert.equal(wire.length,1);
  assert.equal((await unknown.retry()).id,'confirmed');assert.equal(wire[0],wire[1]);assert.equal(unknown.uncertainRequest,null);
});

test('task page renders user content as text and keeps native approvals outside its controls',()=>{
  assert.doesNotMatch(pageSource,/innerHTML\s*=|insertAdjacentHTML|session\.prompt|allowed-once|approvalId/);
  assert.match(pageSource,/element\.textContent=String\(text\)/);
  assert.match(pageSource,/task\.revision=editing\.revision/);
  assert.match(pageSource,/sessionId:id\},location\.origin/);
});

test('task page keeps record links in place on unchanged refresh and preserves expansion through real updates',async()=>{
  class Element{
    constructor(tag='div'){this.tagName=tag.toUpperCase();this.children=[];this.childNodes=this.children;this.dataset={};this.listeners={};this.checked=false;this.open=false;this.isConnected=true;this.replacements=0;}
    append(...children){this.children.push(...children);}
    replaceChildren(...children){this.replacements++;const detach=node=>{node.isConnected=false;node.children?.forEach(detach);};this.children.forEach(detach);this.children=children;this.childNodes=this.children;}
    setAttribute(){}
    addEventListener(name,fn){this.listeners[name]=fn;}
    querySelectorAll(selector){const found=[];const walk=node=>{for(const child of node.children||[]){if(selector==='details[data-task-record]'&&child.tagName==='DETAILS'&&child.dataset.taskRecord)found.push(child);if(selector==='[data-task-action]'&&child.dataset?.taskAction)found.push(child);walk(child);}};walk(this);return found;}
  }
  const ids=[...fs.readFileSync(new URL('../plugin/www/tasks.html',import.meta.url),'utf8').matchAll(/id="([^"]+)"/g)].map(match=>match[1]),elements=new Map(ids.map(id=>[id,new Element()]));
  const snapshot={tasks:[{id:'t1',title:'任务',objective:'目标',workspaceId:'w1',status:'complete',schedule:{kind:'manual'},lastRun:{id:'r1',sessionId:'session-one',summary:'完整结果第一版',status:'complete'},runs:[]}],workspaces:[{workspaceId:'w1',title:'项目'}],permissionPresets:[]};
  const sandbox={document:{getElementById:id=>elements.get(id),createElement:tag=>new Element(tag),querySelectorAll:selector=>elements.get('taskList').querySelectorAll(selector),visibilityState:'visible'},location:{search:'?s=session-one',origin:'https://dsh.local'},URLSearchParams,Date,Number,Set,JSON,Error,crypto:{randomUUID:()=> 'operation-id'},setInterval(){},fetch:async()=>response(JSON.parse(JSON.stringify(snapshot)))};
  sandbox.window=sandbox;sandbox.parent=sandbox;vm.runInNewContext(pageSource,sandbox);await new Promise(resolve=>setTimeout(resolve,0));
  const list=elements.get('taskList'),first=list.querySelectorAll('details[data-task-record]')[0];first.open=true;first.listeners.toggle();
  const count=list.replacements;await elements.get('refresh').onclick();
  assert.equal(list.replacements,count,'unchanged list must not detach a link the user is clicking');assert.equal(list.querySelectorAll('details[data-task-record]')[0],first);assert.equal(first.open,true);
  snapshot.tasks[0].lastRun.summary='完整结果第二版';await elements.get('refresh').onclick();
  const updated=list.querySelectorAll('details[data-task-record]')[0];assert.notEqual(updated,first);assert.equal(updated.open,true,'task-id expansion survives changed data');
  updated.open=false;updated.listeners.toggle();snapshot.tasks[0].status='paused';await elements.get('refresh').onclick();assert.equal(list.querySelectorAll('details[data-task-record]')[0].open,false);
  const select=elements.get('workspace');select.options=[];select.add=option=>select.options.push(option);elements.get('editor').open=true;elements.get('objective').value='尚未提交的目标';elements.get('title').value='原任务名称';
  sandbox.Option=class{constructor(text,value){this.text=text;this.value=value;}};
  sandbox.DSHFolderPicker={choose:async()=>null};await elements.get('browseWorkspace').onclick();assert.equal(select.options.length,0);assert.equal(elements.get('objective').value,'尚未提交的目标');
  sandbox.DSHFolderPicker={choose:async()=>({id:'added-workspace',workspaceId:'added-workspace',title:'电脑目录',path:'D:\\资料'})};await elements.get('browseWorkspace').onclick();
  assert.equal(select.value,'added-workspace');assert.equal(elements.get('objective').value,'尚未提交的目标');assert.equal(elements.get('title').value,'原任务名称');assert.equal(select.options.length,1);
});
