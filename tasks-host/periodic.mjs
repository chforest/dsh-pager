export const isPeriodic = task => ['daily','interval'].includes(task.schedule?.kind)
export function periodicProof({task,run,goal,agent,events,approvals}) {
  const no=reason=>({eligible:false,reason})
  if(!isPeriodic(task)||!task.continuous||!task.enabled||task.archived||task.manualPause)return no('计划不是已启用的周期目标')
  if(run.stage!=='accepted'||['unknown','dispatching'].includes(run.status)||['unknown','dispatching'].includes(run.restartRecovery?.status))return no('派发结果尚未确认')
  if(!agent||agent.status!=='idle'||agent.inbox?.hasPending||approvals)return no('会话、输入或审批尚未结束')
  if(!goal||goal.id!==run.goal?.id||goal.phase!=='blocked'||goal.activation!=='disarmed')return no('没有匹配且已停止的受阻目标')
  if(!goal.blockedReason?.code||/round.?limit|transport|timeout|unknown|abort|cancel|queue.?failed|prompt.?rejected|permission|approval/i.test(goal.blockedReason.code))return no('受阻类型需要人工核对')
  const ends=events.filter(e=>e.type==='turn/end')
  if(!ends.length||events.at(-1)?.type!=='turn/end'||ends.some(e=>e.data?.reason?.kind!=='completed'))return no('本次回合没有正常结束')
  const calls=new Map(),results=new Map()
  for(const e of events){
    if(e.type==='tool/call'){if(!e.data?.callId)return no('工具调用缺少编号');calls.set(e.data.callId,e.data.name)}
    if(e.type==='tool/result'){
      const m=e.data?.message,id=m?.source?.callId
      const nativeV4=m?.role==='tool'&&m.toolCallId===id&&Array.isArray(m.content)
      const nativeV3=m?.role==='user'&&m.content?.length===1&&m.content[0]?.type==='tool-result'&&m.content[0]?.toolCallId===id
      if(m?.source?.kind!=='tool'||typeof id!=='string'||!id||(!nativeV4&&!nativeV3))return no('工具结果缺少一致的原生关联编号')
      if(/transport|timeout|unknown|abort|cancel/i.test(e.data?.error?.code||''))return no('工具结果未确认')
      const text=JSON.stringify(m.content||[]);if(/TOOL_OUTCOME_UNKNOWN|TRANSPORT_ERROR/.test(text))return no('工具结果未确认')
      results.set(id,m)
    }
  }
  for(const [id,name] of calls){
    if(!results.has(id))return no('工具尚无结果')
    if(/ask_user|request_user|question|clarification/i.test(name||''))return no('本次包含需人工核对的用户问题')
  }
  for(const id of results.keys())if(!calls.has(id))return no('存在无法关联的工具结果')
  return{eligible:true,goalRef:{id:goal.id,revision:goal.revision},blockedReason:structuredClone(goal.blockedReason)}
}
