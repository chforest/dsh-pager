import crypto from 'node:crypto'
import path from 'node:path'

const beijingFormatter=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'})
export function beijingTime(value){if(value==null||value==='')return null;const date=new Date(value);if(!Number.isFinite(date.getTime()))return null;const parts=Object.fromEntries(beijingFormatter.formatToParts(date).filter(part=>part.type!=='literal').map(part=>[part.type,part.value]));return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}:${parts.second}（北京时间）`}
const ACTIONS=['create','update','pause','resume','run','archive']
const RANK={'read-only':0,'workspace-write':1,'danger-full-access':2}
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const fail=(message,status=400)=>{throw Object.assign(new Error(message),{status})}
export const guidance='用户要求定时、每日/每周、周期执行或自动拆解持续推进时，使用 automatic_tasks_list 与 automatic_tasks_manage 管理已安装的任务服务，不要声称没有任务插件或另外编造定时脚本。日期时间面向用户直接使用nowBeijing和nextRunAtBeijing，不把UTC日期原样当北京时间，也不自行心算转换。所有任务默认在安排它的原聊天执行并回复，直接沿用该聊天上下文；原聊天忙时等待，不另开聊天或打断当前工作。waiting-idle表示等待原聊天空闲或停止目标清理，不代表定时器冻结；先核对目标和任务占用，不要据此反复新建或重启。独立任务页创建且没有来源聊天的任务只创建一次固定聊天，以后复用。先查现有任务避免重复；创建返回的持久化任务编号和nextRunAt才是创建证据。manual创建不会立即运行，需用户已要求立即执行时另用run；每日多个时间可创建多条明确任务。权限不得高于当前会话；定时/持续任务不增加外部发送、发布、付款或删除授权。未知结果先list核对，确需重试时复用原requestId和内容，不盲目新建。'

function caller(ctx,exec){
  const agent=exec?.agent,sid=agent?.session?.id||agent?.id
  if(!agent||typeof sid!=='string'||!sid.startsWith('session-')||ctx.agents.get(agent.id)!==agent||!ctx.agents.roots().includes(agent))fail('自动任务仅能由当前存活的主会话管理',403)
  if(exec.signal?.aborted)fail('调用已取消，未提交任何任务操作',409)
  return{agent,sid}
}
function operationId(sid,callId,explicit){
  if(explicit!==undefined){if(!UUID.test(explicit))fail('requestId必须为UUID');return explicit}
  if(typeof callId!=='string'||!callId)fail('缺少原生tool callId；请提供明确requestId')
  const hex=crypto.createHash('sha256').update('dsh-tasks:'+sid+':'+callId).digest('hex')
  return `${hex.slice(0,8)}-${hex.slice(8,12)}-4${hex.slice(13,16)}-a${hex.slice(17,20)}-${hex.slice(20,32)}`
}
function allows(current,target){return current===target||(Object.hasOwn(RANK,current)&&Object.hasOwn(RANK,target)&&RANK[target]<=RANK[current])}
function summarize(task,full=false){
  if(!task)return null
  const run=task.lastRun
  return JSON.parse(JSON.stringify({id:task.id,revision:task.revision,title:task.title,objective:full?task.objective:String(task.objective||'').slice(0,400),objectiveTruncated:!full&&String(task.objective||'').length>400,workspaceId:task.workspaceId,sourceSessionId:task.sourceSessionId,executionSessionId:task.sourceSessionId||task.executionSessionId||null,permissionPreset:task.permissionPreset,continuous:task.continuous,maxGoalRounds:task.maxGoalRounds,schedule:task.schedule,status:task.status,enabled:task.enabled,archived:task.archived,nextRunAt:task.nextRunAt,nextRunAtBeijing:beijingTime(task.nextRunAt),lastRun:run?{id:run.id,sessionId:run.sessionId,status:run.status,summary:String(run.summary||'').slice(0,1200),error:typeof run.error==='string'?run.error:run.error?.message||null,goal:run.goal,todos:run.todos,startedAt:run.startedAt,finishedAt:run.finishedAt}:null}))
}
export function registerTaskTools(ctx,{service,adapter,defineTool}){
  const output={schema:{type:'object',additionalProperties:true},render:(_args,value)=>[{type:'text',text:JSON.stringify(value)}]}
  ctx.systemPrompt.section({name:'automatic-tasks-native-tools',order:118,text:guidance})
  ctx.tools.register(defineTool({name:'automatic_tasks_list',description:'只读查看正式自动任务、失败/中断状态、北京时间下次执行时间，以及可用工作区和权限。创建前先查，避免重复。指定id可取完整目标。',parameters:{id:{type:'string',description:'可选任务编号；省略返回所有任务的简要状态。'}},output,isConcurrencySafe:()=>false,
    async execute(args,exec){caller(ctx,exec);const [tasks,catalog]=await Promise.all([service.list(args.id),adapter.catalog()]);return{ok:true,nowBeijing:beijingTime(Date.now()),tasks:tasks.map(task=>summarize(task,!!args.id)),workspaces:catalog.workspaces.map(w=>({workspaceId:w.workspaceId||w.id,title:w.title,path:w.path})),permissionPresets:catalog.permissionPresets,defaultPermissionPreset:catalog.defaultPermissionPreset,timeZone:'Asia/Shanghai',scheduleExamples:{每日06点:{kind:'daily',time:'06:00',days:[0,1,2,3,4,5,6],timeZone:'Asia/Shanghai'},每日19点:{kind:'daily',time:'19:00',days:[0,1,2,3,4,5,6],timeZone:'Asia/Shanghai'},每小时:{kind:'interval',seconds:3600,timeZone:'Asia/Shanghai'}},notice:'任务状态和下次执行时间不代表业务已经完成；失败、中断或未知结果需核对后明确继续。'}}
  }))
  ctx.tools.register(defineTool({name:'automatic_tasks_manage',description:'管理正式自动任务：create/update/pause/resume/run/archive。复用UI同一持久服务、权限和幂等机制。创建不等于业务执行成功；manual需要另run才开始。不能据此自动授权发送/发布等外部动作。',parameters:{
    action:{type:'string',enum:ACTIONS,required:true,description:'create创建、update修改、pause暂停、resume继续、run立即执行、archive归档/恢复。'},
    id:{type:'string',description:'除create外必须指定已有任务编号。'},
    requestId:{type:'string',description:'通常省略，按原生callId生成稳定UUID。核对未知结果后重试须复用原返回UUID及相同内容。'},
    task:{type:'object',additionalProperties:false,description:'create/update的任务字段；更新须带查询所得revision。archive恢复用archived:false。',properties:{title:{type:'string'},objective:{type:'string'},workspaceId:{type:'string',description:'省略时create使用当前会话工作区。'},sourceSessionId:{type:'string',description:'仅允许当前会话，且须属于所选工作区；一般省略自动判断。'},permissionPreset:{type:'string',description:'省略时create沿用当前会话权限；不得超过当前会话。'},continuous:{type:'boolean'},maxGoalRounds:{type:'integer'},revision:{type:'integer'},archived:{type:'boolean'},schedule:{type:'object',additionalProperties:false,properties:{kind:{type:'string',enum:['manual','once','interval','daily'],required:true},at:{type:'string',description:'once使用带时区ISO时间。'},seconds:{type:'integer',description:'interval至少300秒。'},time:{type:'string',description:'daily为HH:mm。'},days:{type:'array',items:{type:'integer'},description:'0周日至6周六，默认全周。'},timeZone:{type:'string',enum:['Asia/Shanghai']}}}}}
  },output,isConcurrencySafe:()=>false,
    async execute(args,exec){
      let requestId,request
      try{
        const {agent,sid}=caller(ctx,exec);requestId=operationId(sid,exec.callId,args.requestId)
        if(!ACTIONS.includes(args.action))fail('不支持的任务操作')
        if(args.action!=='create'&&!args.id)fail('请先查询并指定任务编号')
        const catalog=await adapter.catalog(),current=ctx.permissionPresets.current(agent.session.events)
        if(!current)fail('无法确定当前会话权限，请先检查原生权限设置',409)
        const task={...(args.task||{})},existing=args.action==='create'?null:(await service.list(args.id))[0]
        if(args.action==='create'){
          const workspace=task.workspaceId?catalog.workspaces.find(w=>(w.workspaceId||w.id)===task.workspaceId):catalog.workspaces.find(w=>(w.sessionIds||[]).includes(sid))||catalog.workspaces.find(w=>agent.session.header?.cwd&&path.resolve(w.path).toLowerCase()===path.resolve(agent.session.header.cwd).toLowerCase())
          if(!workspace)fail('无法确定工作区，请先list选择workspaceId')
          task.workspaceId=workspace.workspaceId||workspace.id
          if(task.sourceSessionId&&task.sourceSessionId!==sid)fail('不能把其他会话作为当前任务来源',403)
          if((workspace.sessionIds||[]).includes(sid))task.sourceSessionId=sid
          else if(task.sourceSessionId)fail('当前会话不属于所选工作区',403)
          task.permissionPreset=task.permissionPreset||current
          task.continuous=task.continuous??false;task.maxGoalRounds=task.maxGoalRounds??8
          if(!task.schedule)fail('必须明确执行时间；立即任务使用manual，定时请给完整schedule')
        }
        if(args.action==='update'&&task.revision===undefined)fail('修改前先list获取revision，避免覆盖其他页面的修改',409)
        if(task.sourceSessionId&&task.sourceSessionId!==sid)fail('新增来源会话必须是当前会话',403)
        const targetPreset=task.permissionPreset||existing?.permissionPreset
        if(['create','update','resume','run'].includes(args.action)){if(!targetPreset||!allows(current,targetPreset))fail('任务权限高于当前会话或无法比较，不能自动升级权限',403);ctx.permissionPresets.resolve(targetPreset)}
        request={action:args.action,...(args.id?{id:args.id}:{}),task,requestId}
        if(exec.signal?.aborted)fail('调用已取消，未提交任务操作',409)
        const result=await service.mutate(request)
        if(!result?.id)fail('未收到持久化任务编号，请查询核对',503)
        return{ok:true,requestId,action:args.action,nowBeijing:beijingTime(Date.now()),task:summarize(result,true),timeZone:'Asia/Shanghai',authorization:'沿用原生权限与审批；本次任务操作不赋予消息发送、发布或付费授权。'}
      }catch(error){return{ok:false,requestId:requestId||null,taskId:args.id||null,action:args.action,outcome:!error.status||error.status>=500||error.code==='outcome_unknown'?'unknown':'rejected',error:{code:error.code||'tasks',message:error.status&&error.status<500?error.message:'操作结果未确认，请先list核对，不要重新创建或重复启动。'},nextStep:'使用automatic_tasks_list核对任务状态；如需重试，复用本次requestId和相同参数。'}}
    }
  }))
}
