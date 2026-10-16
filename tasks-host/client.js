window.__ModuleLoader__.load({id:'dsh-tasks',factory:require=>{
  'use strict';
  const React=require('react'),h=React.createElement;
  function taskPageUrl(sessionId){return '/m/tasks.html?s='+encodeURIComponent(sessionId||'')+'&embedded=1';}
  function taskNavigationId(event,frameWindow,origin){const value=event?.data;return event?.origin===origin&&event.source===frameWindow&&value?.type==='dsh-task-open-session'&&typeof value.sessionId==='string'&&/^session-[a-zA-Z0-9-]{1,160}$/.test(value.sessionId)?value.sessionId:null;}
  function TasksView({sessionId,onOpenSession}){
    const frame=React.useRef(null);
    React.useEffect(()=>{const handle=event=>{const id=taskNavigationId(event,frame.current?.contentWindow,location.origin);if(id)onOpenSession(id);};window.addEventListener('message',handle);return()=>window.removeEventListener('message',handle);},[sessionId,onOpenSession]);
    return h('div',{style:{height:'max(260px, calc(100dvh - 260px))',overflow:'hidden',boxSizing:'border-box'}},h('iframe',{ref:frame,key:sessionId,src:taskPageUrl(sessionId),title:'自动任务',style:{display:'block',width:'100%',height:'100%',border:0,background:'transparent'}}));
  }
  function apply(ctx){ctx.slots.inject('conversation.view',()=>ctx.slots.register({name:'conversation.view',id:'automatic-tasks',label:'任务',order:30,inject:()=>({onOpenSession:id=>ctx.sessions.open(id)})},TasksView));}
  return{inject:['slots','sessions'],apply,TasksView,taskPageUrl,taskNavigationId};
}});
