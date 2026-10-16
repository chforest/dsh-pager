import {test} from 'node:test';
import assert from 'node:assert/strict';
import {inject,apply} from './index.js';
import {registerTaskTools} from './tools.mjs';
import {pathToFileURL} from 'node:url';
import {createRequire} from 'node:module';import path from 'node:path';import os from 'node:os';
async function installedDefineTool(){
 const locations=process.env.DSH_TEST_PROFILE?[path.join(process.env.DSH_TEST_PROFILE,'package.json')]:[import.meta.url,path.join(process.env.DSH_HOME||path.join(os.homedir(),'.dsh'),'profiles','web','package.json')];
 for(const location of locations){let resolved;try{resolved=createRequire(location).resolve('@deepseek-ai/dsh-tools')}catch(error){if(error.code==='MODULE_NOT_FOUND')continue;throw error}return(await import(pathToFileURL(resolved).href)).defineTool}
 return null;
}
const defineTool=await installedDefineTool();

test('tasks host exposes a model tool registration path instead of only HTTP/UI',()=>{
  assert.ok(inject.includes('tools'),'tasks host does not request ToolRuntime, so the model receives no task tools');
  assert.match(apply.toString(),/registerTaskTools/,'the same running task service must be registered for native tools');
});

function fixture(preset='workspace-write',factory=definition=>definition){
  const tools=new Map(),writes=[],tasks=[],sections=[];
  const agent={id:'session-current',session:{id:'session-current',header:{cwd:'D:\\fixture-workspace'},events:[]}};
  const ctx={tools:{register:tool=>tools.set(tool.name,tool)},systemPrompt:{section:value=>sections.push(value)},agents:{get:id=>id===agent.id?agent:null,roots:()=>[agent]},permissionPresets:{current:()=>preset,resolve:name=>{assert.ok(['read-only','workspace-write','danger-full-access'].includes(name));return{};}}};
  const adapter={catalog:async()=>({workspaces:[{workspaceId:'workspace-fixture',title:'测试工作区',path:'D:\\fixture-workspace',sessionIds:[agent.id]},{workspaceId:'other-workspace',title:'另一工作区',path:'E:\\fixture',sessionIds:[]}],permissionPresets:[{name:preset,label:preset}],defaultPermissionPreset:'workspace-write'})};
  const service={list:async id=>tasks.filter(task=>!id||task.id===id),mutate:async request=>{writes.push(request);const task={id:request.id||'fixture-task',revision:1,title:'测试任务',objective:'测试目标',workspaceId:'workspace-fixture',permissionPreset:preset,schedule:{kind:'manual'},status:'idle',enabled:true,archived:false,nextRunAt:null,...request.task};tasks.push(task);return task;}};
  registerTaskTools(ctx,{service,adapter,defineTool:factory});return{ctx,agent,tools,writes,tasks,sections,service,exec:{agent,callId:'call-fixture',signal:new AbortController().signal}};
}

test('real native defineTool registers discoverable list/manage schemas and a short routing section',{skip:defineTool?false:'DSH SDK not installed; set DSH_TEST_PROFILE for real SDK integration'},()=>{
  const f=fixture('workspace-write',defineTool);assert.deepEqual([...f.tools.keys()],['automatic_tasks_list','automatic_tasks_manage']);
  assert.ok(f.tools.get('automatic_tasks_manage').parameters.properties.action.enum.includes('create'));
  assert.equal(f.sections.length,1);assert.match(f.sections[0].text,/不要声称没有任务插件/);
});

test('list exposes durable failure state and Beijing schedules without executing or mutating tasks',async()=>{
  const f=fixture();f.tasks.push({id:'existing',title:'测试',objective:'待检查目标',status:'failed',lastRun:{id:'run1',status:'failed',error:{message:'fixture failure'},sessionId:'session-run',summary:'失败待核对'}});
  const out=await f.tools.get('automatic_tasks_list').execute({},f.exec);
  assert.equal(out.ok,true);assert.equal(out.tasks[0].lastRun.error,'fixture failure');assert.equal(out.timeZone,'Asia/Shanghai');assert.equal(out.scheduleExamples.每日06点.time,'06:00');assert.equal(f.writes.length,0);
});

test('create delegates once to the same service using caller workspace, source and permission without auto-run',async()=>{
  const f=fixture('read-only'),args={action:'create',task:{title:'fixture',objective:'只读测试目标',schedule:{kind:'daily',time:'06:00',timeZone:'Asia/Shanghai'}}};
  const result=await f.tools.get('automatic_tasks_manage').execute(args,f.exec);
  assert.equal(result.ok,true);assert.equal(f.writes.length,1);assert.equal(f.writes[0].action,'create');assert.equal(f.writes[0].task.permissionPreset,'read-only');assert.equal(f.writes[0].task.workspaceId,'workspace-fixture');assert.equal(f.writes[0].task.sourceSessionId,f.agent.id);assert.equal(f.writes[0].task.continuous,false);
  await f.tools.get('automatic_tasks_manage').execute(args,f.exec);assert.equal(f.writes[0].requestId,f.writes[1].requestId,'same native call identity retains the operation UUID');
});

test('task tools reject permission escalation, stale editing prerequisites, subagents and pre-cancelled calls',async()=>{
  const f=fixture('read-only'),tool=f.tools.get('automatic_tasks_manage');
  const elevated=await tool.execute({action:'create',task:{title:'fixture',objective:'fixture',permissionPreset:'danger-full-access',schedule:{kind:'manual'}}},f.exec);assert.equal(elevated.ok,false);assert.equal(elevated.outcome,'rejected');
  f.tasks.push({id:'existing',permissionPreset:'read-only'});assert.equal((await tool.execute({action:'update',id:'existing',task:{title:'改名'}},f.exec)).ok,false);
  const foreign={...f.agent,id:'session-child'};assert.equal((await tool.execute({action:'run',id:'existing'},{...f.exec,agent:foreign})).ok,false);
  const abort=new AbortController();abort.abort();assert.equal((await tool.execute({action:'run',id:'existing'},{...f.exec,signal:abort.signal})).ok,false);assert.equal(f.writes.length,0);
});

test('unknown mutation returns the same retry id and never retries itself; pause can reduce a higher-permission task',async()=>{
  const f=fixture('read-only');f.tasks.push({id:'existing',permissionPreset:'danger-full-access'});
  const tool=f.tools.get('automatic_tasks_manage');assert.equal((await tool.execute({action:'pause',id:'existing'},f.exec)).ok,true);
  let calls=0;f.service.mutate=async()=>{calls++;throw Object.assign(new Error('response uncertain'),{status:503});};
  const first=await tool.execute({action:'create',task:{title:'fixture',objective:'fixture',schedule:{kind:'manual'}}},{...f.exec,callId:'uncertain-create'});
  assert.equal(first.ok,false);assert.equal(first.outcome,'unknown');assert.equal(calls,1);assert.match(first.nextStep,/复用/);
  const second=await tool.execute({action:'create',requestId:first.requestId,task:{title:'fixture',objective:'fixture',schedule:{kind:'manual'}}},{...f.exec,callId:'explicit-retry'});assert.equal(second.requestId,first.requestId);assert.equal(calls,2);
});
