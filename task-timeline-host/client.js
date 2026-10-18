window.__ModuleLoader__.load({id:'dsh-task-timeline',factory:require=>{
 'use strict';
 const React=require('react'),{createPortal}=require('react-dom'),h=React.createElement;
 const SLOT='conversation.input.dock';
 function sameTodos(a,b){return Array.isArray(a)&&Array.isArray(b)&&a.length===b.length&&a.every((v,i)=>v.content===b[i]?.content&&v.status===b[i]?.status);}
 function anchorKey(session,kind,projection){
  if(!session?.sessionId||!session.chat?.nodes||!projection)return null;
  const order=session.chat.order||[],visible=order.map(key=>session.chat.nodes.get(key)).filter(n=>n&&n.visibility!=='hidden');
  if(kind==='todo'){
   if(!Array.isArray(projection)||!projection.length)return null;
   const matches=(session.nodes||[]).filter(n=>{if(n.kind!=='tool-result'||n.isError||n.call?.name!=='todo_write')return false;try{return sameTodos(JSON.parse(n.call.argsRaw).todos,projection);}catch{return false;}}).sort((a,b)=>b.seq-a.seq);
   const last=matches[0];if(!last)return null;
   const node=visible.find(n=>n.anchorSeq===last.seq||n.data?.root?.callId===last.callId||n.data?.callId===last.callId||n.key==='tool-call:'+last.callId);
   return node?.key||null;
  }
  if(projection.goal?.phase==='complete')return null;
  const at=projection.createdAt;if(!Number.isFinite(at))return null;
  const timed=(session.nodes||[]).filter(n=>Number.isFinite(n.time)).sort((a,b)=>a.seq-b.seq);
  if(!timed.length||(session.hasMore&&at<timed[0].time))return null;
  // Place at the create event's chronological position, never at the newest turn.
  const source=timed.find(n=>n.time>=at)||timed[timed.length-1];
  const node=visible.find(n=>n.anchorSeq>=source.seq);return node?.key||null;
 }
 function findRow(root,key){if(!root||!key)return null;return Array.from(root.querySelectorAll('[data-chat-anchor-key]')).find(node=>node.dataset.chatAnchorKey===key)||null;}
 function timelineSession(session,chat){return chat?{...session,chat,...chat.legacy}:session;}
 function portalComponent(original,kind){
  function Timeline(props){
   const chat=props.useChat?props.useChat(s=>s):null;
   const session=timelineSession(props.session,chat);
   const projection=props.useProjection(kind==='goal'?'goal':'todos'),key=anchorKey(session,kind,projection);
   const marker=React.useRef(null),container=React.useRef(null),[target,setTarget]=React.useState(null);
   const present=kind==='todo'?Array.isArray(projection)&&projection.length>0:!!projection?.goal&&projection.goal.phase!=='complete';
   React.useLayoutEffect(()=>()=>{container.current?.remove();container.current=null;},[props.sessionId]);
   React.useLayoutEffect(()=>{
    const root=marker.current?.closest('[data-conversation-scroll]');if(!root||!present){container.current?.remove();setTarget(null);return;}
    let mount=container.current;if(!mount||mount.dataset.sessionId!==props.sessionId){mount=document.createElement('section');mount.dataset.dshTaskTimeline=kind;mount.dataset.sessionId=props.sessionId;mount.className='dsh-task-timeline-native';mount.style.cssText='position:static;display:block;margin:12px 0;min-width:0;width:100%;';container.current=mount;}
    function place(){
     const row=findRow(root,key),flow=root.querySelector('[data-chat-flow]');
     if(row){mount.dataset.placement='matched';if(mount.parentNode!==row)row.appendChild(mount);}
     else if(flow){mount.dataset.placement='earlier';if(mount.parentNode!==flow)flow.prepend(mount);}
     else{mount.remove();setTarget(null);return;}
     setTarget(current=>current===mount?current:mount);
    }
    const observer=new MutationObserver(place);observer.observe(root,{childList:true,subtree:true});place();
    return()=>observer.disconnect();
   },[props.sessionId,key,present]);
   const native=h(original.component,props),valid=target&&target===container.current&&target.dataset.sessionId===props.sessionId;
   return h(React.Fragment,null,h('span',{ref:marker,'data-task-timeline-source':kind,'data-projection-state':Array.isArray(projection)?'items:'+projection.length:projection==null?'absent':typeof projection,'data-anchor-state':key?'matched':'earlier',style:{display:'none'}}),valid?createPortal(h(React.Fragment,null,h('style',null,'.dsh-task-timeline-native > :not(style){width:100%!important;max-width:100%!important;margin:0!important;position:static!important}.dsh-task-timeline-native[data-placement=matched] .dsh-earlier-label{display:none}'),h('p',{className:'dsh-earlier-label',style:{fontSize:12,opacity:.65,paddingBottom:6}},'较早的任务记录 · 加载对应历史后自动归位'),native),target):null);
  }
  Timeline.taskTimeline=true;return Timeline;
 }
 function install(ctx){
  const mounted=new Map();let closed=false;
  function sync(){if(closed)return;for(const id of ['todo','goal']){
   const entry=ctx.slots.entries(SLOT).find(e=>e.options?.id===id&&!e.component?.taskTimeline);
   if(mounted.get(id)?.entry===entry)continue;
   mounted.get(id)?.dispose();mounted.delete(id);if(!entry)continue;
   const dispose=ctx.slots.register({name:SLOT,id,order:entry.options.order,priority:(entry.options.priority||0)-100,locale:entry.locale,inject:entry.inject},portalComponent(entry,id));mounted.set(id,{entry,dispose});
  }}
  const unsubscribe=ctx.slots.subscribe(SLOT,sync);sync();return()=>{closed=true;unsubscribe();for(const item of mounted.values())item.dispose();mounted.clear();};
 }
 function apply(ctx){ctx.slots.inject(SLOT,()=>install(ctx));}
 return{inject:['slots'],apply,install,anchorKey,sameTodos,findRow,portalComponent,timelineSession};
}});
