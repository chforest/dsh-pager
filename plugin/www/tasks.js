(function(){
  'use strict';
  const ZONE='Asia/Shanghai';
  function scheduleFrom(values,now=Date.now()){
    const mode=values.execution;
    if(mode==='manual')return{kind:'manual',timeZone:ZONE};
    if(mode==='once'||mode==='delay'){
      const at=mode==='once'?Date.parse(values.at+'+08:00'):now+Number(values.minutes)*60000;
      if(!Number.isFinite(at)||at<=now)throw new Error('请选择未来的执行时间');
      return{kind:'once',at:new Date(at).toISOString(),timeZone:ZONE};
    }
    if(mode==='interval'){
      const seconds=Number(values.minutes)*60;if(!Number.isInteger(seconds)||seconds<300)throw new Error('执行间隔至少为5分钟');
      return{kind:'interval',seconds,timeZone:ZONE};
    }
    if(mode!=='daily'&&mode!=='weekly')throw new Error('请选择执行方式');
    if(!/^([01]\d|2[0-3]):[0-5]\d$/.test(values.time))throw new Error('请选择正确的每日时间');
    const days=mode==='daily'?[0,1,2,3,4,5,6]:[...new Set(values.days||[])].map(Number).sort();
    if(!days.length||days.some(day=>!Number.isInteger(day)||day<0||day>6))throw new Error('至少选择一个星期');
    return{kind:'daily',time:values.time,days,timeZone:ZONE};
  }
  function taskFrom(values,sessionId,now){
    const objective=String(values.objective||'').trim(),workspaceId=String(values.workspaceId||'');
    if(!objective)throw new Error('请填写目标内容');if(!workspaceId)throw new Error('请选择工作区');
    const maxGoalRounds=Number(values.maxGoalRounds??8);if(!Number.isInteger(maxGoalRounds)||maxGoalRounds<1||maxGoalRounds>100)throw new Error('推进轮数须为1到100');
    const task={title:String(values.title||'').trim()||objective.slice(0,30),objective,workspaceId,...(sessionId?{sourceSessionId:sessionId}:{}),continuous:!!values.continuous,maxGoalRounds,schedule:scheduleFrom(values,now)};
    if(values.permissionPreset)task.permissionPreset=values.permissionPreset;
    return task;
  }
  function permissionLabel(value,label){return {'read-only':'只读','workspace-write':'工作区写入','danger-full-access':'完全访问'}[value]||label||value;}
  function sourceForWorkspace(workspaces,workspaceId,sessionId){const workspace=workspaces.find(item=>(item.workspaceId||item.id)===workspaceId);return sessionId&&workspace?.sessionIds?.includes(sessionId)?sessionId:undefined;}
  function defaultWorkspace(workspaces,sessionId,fallback){const owner=workspaces.find(item=>item.sessionIds?.includes(sessionId));if(owner)return owner.workspaceId||owner.id;if(workspaces.some(item=>(item.workspaceId||item.id)===fallback))return fallback;return workspaces.length===1?(workspaces[0].workspaceId||workspaces[0].id):'';}
  function createClient(fetcher,makeId=()=>crypto.randomUUID()){
    let revision=0,busy=false,unknownRequest=null;
    async function request(options){let response,decoded=false;try{response=await fetcher('/m/api/tasks',options);const out=await response.json();decoded=true;if(!response.ok||!out.ok){const error=new Error(out.error?.message||out.error||'任务操作失败');error.uncertain=response.status>=500;throw error;}return out.value;}catch(error){if(!response||!decoded)error.uncertain=true;throw error;}}
    async function write(body,retry=false){if(busy)throw new Error('上一项操作仍在处理中');if(unknownRequest&&!retry)throw new Error('请先确认上次操作结果');const payload=retry?unknownRequest:{...body,requestId:body.requestId||makeId()};if(!payload)throw new Error('没有待确认的操作');busy=true;revision++;try{const result=await request({method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(payload)});unknownRequest=null;return result;}catch(error){if(error.uncertain)unknownRequest=payload;throw error;}finally{busy=false;}}
    return{get busy(){return busy;},get uncertainRequest(){return unknownRequest;},async read(){if(busy)return{current:false};const token=++revision,value=await request({cache:'no-store'});return{current:token===revision,value};},write:body=>write(body),retry:()=>write(null,true)};
  }
  if(typeof module!=='undefined'&&module.exports){module.exports={scheduleFrom,taskFrom,createClient,sourceForWorkspace,defaultWorkspace,permissionLabel};return;}
  const $=id=>document.getElementById(id),sessionId=new URLSearchParams(location.search).get('s')||'',client=createClient(fetch);
  let data={tasks:[],workspaces:[],permissionPresets:[]},editing=null,locked=false,uncertain=false,lastRefresh=false,renderSignature='',editorVersion=0,folderBusy=false;const openRecords=new Set();
  const STATUS={'waiting-idle':'等待原聊天空闲',idle:'待执行',ready:'待执行',scheduled:'已安排',waiting:'等待执行',running:'正在执行',paused:'已暂停',completed:'已完成',complete:'已完成',dispatching:'正在启动',queued:'已排队',needs_confirmation:'需确认继续',failed:'执行失败',blocked:'等待确认',interrupted:'需确认继续',unknown:'需确认继续',archived:'已归档'};
  function node(tag,text,cls){const element=document.createElement(tag);if(text!=null)element.textContent=String(text);if(cls)element.className=cls;return element;}
  function date(value){if(!value)return'';const number=new Date(value);return Number.isNaN(number.getTime())?'':number.toLocaleString('zh-CN',{timeZone:ZONE,month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit'});}
  function notice(text,error=false){$('notice').hidden=!text;$('notice').textContent=text||'';$('notice').setAttribute('role',error?'alert':'status');}
  function lock(value){locked=value;$('newTask').disabled=value||uncertain;$('saveTask').disabled=value||uncertain;$('cancel').disabled=value;$('browseWorkspace').disabled=value||folderBusy;document.querySelectorAll('[data-task-action]').forEach(button=>button.disabled=value||uncertain);}
  function report(error){notice(error.uncertain?'操作结果尚未确认，请刷新并核对列表；不会自动重试。':error.message,true);if(error.uncertain){uncertain=true;lastRefresh=false;$('acknowledge').hidden=false;$('acknowledge').disabled=true;}lock(false);}
  function titleForWorkspace(id){const workspace=data.workspaces.find(value=>(value.workspaceId||value.id)===id);return workspace?(workspace.title||workspace.name||workspace.path||id):id||'未指定工作区';}
  function scheduleLabel(schedule){if(!schedule)return'手动执行';if(schedule.kind==='once')return'指定时间 · '+date(schedule.at);if(schedule.kind==='interval')return'每隔 '+Math.round(schedule.seconds/60)+' 分钟';if(schedule.kind==='daily'){const labels=['日','一','二','三','四','五','六'];return((schedule.days||[]).length===7?'每天':'周'+(schedule.days||[]).map(day=>labels[day]).join('、'))+' '+schedule.time+'（北京时间）';}return'手动执行';}
  function chatLink(id,label='打开聊天'){const link=node('a',label);link.href='/m/#'+encodeURIComponent(id);if(window.parent!==window)link.onclick=event=>{event.preventDefault();window.parent.postMessage({type:'dsh-task-open-session',sessionId:id},location.origin);};return link;}
  function render(){
    const list=$('taskList');
    list.querySelectorAll('details[data-task-record]').forEach(details=>{if(details.open)openRecords.add(details.dataset.taskRecord);else openRecords.delete(details.dataset.taskRecord);});
    const signature=JSON.stringify({tasks:data.tasks,workspaces:data.workspaces,archived:$('showArchived').checked});if(signature===renderSignature)return;renderSignature=signature;
    list.replaceChildren();const tasks=data.tasks.filter(task=>$('showArchived').checked||!(task.archived||task.status==='archived'));
    if(!tasks.length){list.append(node('p','还没有任务，点击“新建任务”开始。','empty'));return;}
    for(const task of tasks){
      const card=node('article',null,'task'),head=node('div',null,'task-head');head.append(node('h2',task.title||'未命名任务'),node('span',STATUS[task.status]||task.status||'待执行','status '+(task.status||'')));card.append(head,node('p',task.objective,'objective'));
      card.append(node('div',titleForWorkspace(task.workspaceId),'meta'),node('div',scheduleLabel(task.schedule),'meta'));
      card.append(node('div',task.sourceSessionId?'在原聊天执行并回复':'在固定任务聊天执行并回复','meta'));
      if(task.error)card.append(node('p',task.error,'progress'));
      const primarySession=task.sourceSessionId||task.executionSessionId;
      if(primarySession)card.append(chatLink(primarySession,task.sourceSessionId?'打开原聊天':'打开任务聊天'));
      if(task.nextRunAt)card.append(node('div','下次执行：'+date(task.nextRunAt),'meta'));
      if(task.continuous)card.append(node('div','自动拆解并推进 · 最多 '+(task.maxGoalRounds||8)+' 轮','meta'));
      const progress=typeof task.progress==='string'?task.progress:task.progress?.summary||task.goal?.summary||task.lastRun?.summary;
      if(progress)card.append(node('p',progress,'progress progress-summary'));
      if(task.status==='unknown'||task.status==='interrupted')card.append(node('p','上次执行结果需要核对，确认后再继续。','progress'));
      const details=node('details'),summary=node('summary','执行记录');details.dataset.taskRecord=task.id;details.open=openRecords.has(task.id);details.addEventListener('toggle',()=>{if(!details.isConnected)return;if(details.open)openRecords.add(task.id);else openRecords.delete(task.id);});details.append(summary);
      const record=node('div',null,'record'),todos=task.lastRun?.todos||task.todos||task.goal?.todos||[];
      if(task.lastRun?.summary)record.append(node('p',task.lastRun.summary,'latest-summary'));
      for(const todo of todos)record.append(node('p',(todo.status==='completed'?'✓ ':'· ')+(todo.content||todo.title||String(todo))));
      const goal=task.lastRun?.goal||task.goal;if(goal)record.append(node('p',typeof goal==='string'?goal:[goal.summary||goal.objective,goal.status?'目标状态：'+goal.status:''].filter(Boolean).join(' · ')));
      const runs=task.runs||task.history||[];for(const run of runs.slice(-5).reverse())record.append(node('p',[date(run.startedAt||run.createdAt),STATUS[run.status]||run.status,(run.id&&run.id===task.lastRun?.id?'':run.summary)||run.error?.message].filter(Boolean).join(' · ')));
      const sessions=[...new Set([task.sourceSessionId,task.executionSessionId,task.currentSessionId,task.sessionId,task.lastRun?.sessionId,...runs.map(run=>run.sessionId)].filter(Boolean))];for(const id of sessions.filter(id=>id!==primarySession))record.append(chatLink(id,'打开历史执行聊天'));
      if(!record.childNodes.length)record.append(node('p','暂无执行记录'));details.append(record);card.append(details);
      const actions=node('div',null,'task-actions');
      for(const [action,label] of [['run','立即执行'],[task.status==='paused'||task.status==='interrupted'||task.status==='unknown'?'resume':'pause',task.status==='interrupted'||task.status==='unknown'?'确认继续':task.status==='paused'?'继续':'暂停'],['edit','编辑'],['archive',task.archived?'恢复':'归档']]){
        if((task.archived||task.status==='archived')&&action!=='archive')continue;
        const button=node('button',label);button.dataset.taskAction=action;button.disabled=locked||uncertain;button.onclick=()=>action==='edit'?openEditor(task):mutate(action,task.id);actions.append(button);
      }
      card.append(actions);list.append(card);
    }
  }
  async function refresh(){try{const result=await client.read();if(!result.current)return;data={tasks:result.value.tasks||[],workspaces:result.value.workspaces||[],permissionPresets:result.value.permissionPresets||[],defaultPermissionPreset:result.value.defaultPermissionPreset,currentWorkspaceId:result.value.currentWorkspaceId};lastRefresh=true;$('acknowledge').disabled=!uncertain;render();}catch(error){notice('读取失败：'+error.message,true);}}
  async function mutate(action,id){if(locked||uncertain)return;lock(true);try{const current=data.tasks.find(task=>task.id===id);await client.write({action,id,task:{...(current?.revision!=null?{revision:current.revision}:{}),...(action==='archive'?{archived:!current?.archived}:{})}});notice(action==='run'?'已提交执行请求，请查看任务状态。':'操作已提交。');await refresh();}catch(error){report(error);}finally{lock(false);}}
  function fields(){const mode=$('execution').value;$('onceFields').hidden=mode!=='once';$('minutesFields').hidden=mode!=='delay'&&mode!=='interval';$('dailyFields').hidden=mode!=='daily'&&mode!=='weekly';$('weekFields').hidden=mode!=='weekly';$('minutes').min=mode==='delay'?'1':'5';$('minutesLabel').firstChild.textContent=mode==='delay'?'延时分钟':'间隔分钟';$('saveTask').textContent=editing?'保存修改':mode==='manual'?'创建并开始':'创建任务';}
  function openEditor(task){
    editorVersion++;editing=task||null;$('taskForm').reset();$('formError').hidden=true;$('formTitle').textContent=task?'编辑任务':'新建任务';
    $('workspace').replaceChildren(new Option('请选择工作区',''));for(const workspace of data.workspaces)$('workspace').add(new Option(workspace.title||workspace.name||workspace.path||workspace.id,workspace.workspaceId||workspace.id));
    $('workspace').value=task?.workspaceId||defaultWorkspace(data.workspaces,sessionId,data.currentWorkspaceId);
    $('permission').replaceChildren(new Option('使用默认权限'+(data.defaultPermissionPreset?'（'+permissionLabel(data.defaultPermissionPreset)+'）':''),''));for(const preset of data.permissionPresets){const value=typeof preset==='string'?preset:preset.name||preset.value||preset.id;const label=permissionLabel(value,typeof preset==='string'?null:preset.label);$('permission').add(new Option(label,value));}
    $('title').value=task?.title||'';$('objective').value=task?.objective||'';$('continuous').checked=!!task?.continuous;$('permission').value=task?.permissionPreset||'';$('rounds').value=task?.maxGoalRounds||8;
    const schedule=task?.schedule||{kind:'manual'};$('execution').value=schedule.kind==='daily'&&schedule.days?.length!==7?'weekly':schedule.kind;$('minutes').value=schedule.kind==='interval'?Math.max(5,schedule.seconds/60):60;$('time').value=schedule.time||'09:00';
    if(schedule.at)$('at').value=new Date(new Date(schedule.at).getTime()+8*3600000).toISOString().slice(0,16);
    $('weekDays').replaceChildren();for(const day of [1,2,3,4,5,6,0]){const label=node('label'),input=node('input');input.type='checkbox';input.value=day;input.checked=(schedule.days||[0,1,2,3,4,5,6]).includes(day);label.append(input,document.createTextNode('周'+['日','一','二','三','四','五','六'][day]));$('weekDays').append(label);}
    fields();$('editor').showModal();
  }
  $('browseWorkspace').onclick=async()=>{
    if(locked||folderBusy)return;
    if(!window.DSHFolderPicker){$('formError').hidden=false;$('formError').textContent='文件夹选择器尚未加载，请刷新页面';return;}
    const version=editorVersion;folderBusy=true;$('browseWorkspace').disabled=true;
    try{const workspace=await window.DSHFolderPicker.choose();if(!workspace||version!==editorVersion||!$('editor').open)return;const id=workspace.workspaceId||workspace.id,known=data.workspaces.find(item=>(item.workspaceId||item.id)===id),entry={...known,...workspace,workspaceId:id,sessionIds:workspace.sessionIds||known?.sessionIds||[]};data.workspaces=data.workspaces.filter(item=>(item.workspaceId||item.id)!==id).concat(entry);if(!Array.from($('workspace').options).some(option=>option.value===id))$('workspace').add(new Option(entry.title||entry.name||entry.path,id));$('workspace').value=id;$('formError').hidden=true;}
    catch(error){$('formError').hidden=false;$('formError').textContent=error.message;}
    finally{folderBusy=false;$('browseWorkspace').disabled=locked;}
  };
  $('taskForm').onsubmit=async event=>{
    event.preventDefault();if(locked||uncertain)return;let task;
    try{task=taskFrom({title:$('title').value,objective:$('objective').value,workspaceId:$('workspace').value,permissionPreset:$('permission').value,maxGoalRounds:$('rounds').value,continuous:$('continuous').checked,execution:$('execution').value,at:$('at').value,minutes:$('minutes').value,time:$('time').value,days:[...$('weekDays').querySelectorAll('input:checked')].map(input=>Number(input.value))},sourceForWorkspace(data.workspaces,$('workspace').value,editing?.sourceSessionId||sessionId));if(editing?.revision!=null)task.revision=editing.revision;}catch(error){$('formError').hidden=false;$('formError').textContent=error.message;return;}
    const creating=!editing,immediate=creating&&task.schedule.kind==='manual';lock(true);try{const result=await client.write({action:editing?'update':'create',...(editing?{id:editing.id}:{}),task});const created=result?.task||result;if(creating&&created?.id){editing=created;$('formTitle').textContent='编辑任务';fields();}if(immediate){if(!created?.id)throw Object.assign(new Error('任务已创建但未收到任务编号，请刷新核对。'),{uncertain:true});await client.write({action:'run',id:created.id});} $('editor').close();notice(immediate?'任务已创建，已提交执行请求。':'任务已保存。');await refresh();}catch(error){$('formError').hidden=false;$('formError').textContent=error.uncertain?'提交结果未确认，请先刷新任务列表核对，不要重复提交。':error.message;report(error);}finally{lock(false);}
  };
  $('newTask').onclick=()=>openEditor();$('cancel').onclick=()=>{if(!locked)$('editor').close();};$('execution').onchange=fields;$('refresh').onclick=refresh;$('showArchived').onchange=render;$('acknowledge').onclick=async()=>{if(!lastRefresh||locked)return;lock(true);try{const action=client.uncertainRequest?.action;await client.retry();uncertain=false;$('acknowledge').hidden=true;$('editor').close();notice(action==='create'?'任务创建结果已确认。如需立即开始，请在任务卡点击立即执行。':'上次操作结果已确认。');await refresh();}catch(error){report(error);}finally{lock(false);}};
  $('editor').addEventListener('cancel',event=>{if(locked)event.preventDefault();});$('back').href='/m/'+(sessionId?'#'+encodeURIComponent(sessionId):'');if(window.parent!==window)$('back').hidden=true;
  refresh();setInterval(()=>{if(document.visibilityState==='visible'&&!locked&&!$('editor').open)refresh();},15000);
})();
