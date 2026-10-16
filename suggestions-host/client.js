window.__ModuleLoader__.load({id:'dsh-suggestions',factory:require=>{
  'use strict';
  const React=require('react'),h=React.createElement;
  const cache=new Map(),attempted=new Set(),dismissed=new Set();
  function contextKey(session){let last=-1;for(const seq of session.turnEnds?.values?.()||[])if(Number.isSafeInteger(seq))last=Math.max(last,seq);return session.sessionId+'|'+last+'|'+(session.nodes?.length||0);}
  function pageVisible(doc=document){return doc.visibilityState==='visible'&&!doc.hidden;}
  function rememberDismissal(key){dismissed.add(key);if(dismissed.size>500)dismissed.delete(dismissed.values().next().value);}
  function eligible(session,input){return !!session&&session.turnEnds?.size>0&&!session.running&&!session.removed&&!session.pending?.length&&!session.queue?.length&&!!input&&input.phase==='plain'&&input.draft===''&&!input.imageIds?.length&&!input.queue?.length;}
  function findInput(anchor){const seat=anchor?.closest?.('[data-composer-seat]');if(!seat)return null;const rows=Array.from(seat.querySelectorAll('textarea[data-phase]')).filter(el=>el.getClientRects().length>0);return rows.length===1?rows[0]:null;}
  function voiceActive(seat){return !!seat?.querySelector('[data-dshvm="mic"][aria-pressed="true"], [role="dialog"][aria-label="DSH 语音电话"]');}
  function bindGhost(element,{text,current,accept,dismiss,onVisible=()=>{}}){
    let original=element.getAttribute('placeholder'),ours=null,composing=false,dead=false;
    function hide(){if(ours!==null&&element.getAttribute('placeholder')===ours){if(original===null)element.removeAttribute('placeholder');else element.setAttribute('placeholder',original);}ours=null;onVisible(false);}
    function show(){if(dead||composing||!current()||element.value!==''||element.disabled||element.readOnly){hide();return;}if(ours===null)original=element.getAttribute('placeholder');ours=text;element.setAttribute('placeholder',text);onVisible(true);}
    function reject(){hide();dismiss();}
    function key(event){if(event.target!==element||element.ownerDocument.activeElement!==element)return;if(event.isComposing||composing)return;if(event.key==='Escape'){reject();return;}if(event.key==='Tab'&&!event.shiftKey&&!event.altKey&&!event.ctrlKey&&!event.metaKey&&ours!==null&&current()&&element.value===''&&!element.disabled&&!element.readOnly){event.preventDefault();event.stopPropagation();hide();accept(text);dismiss();}else if(event.key.length===1||event.key==='Backspace'||event.key==='Delete')reject();}
    function composition(){composing=true;reject();}function compositionEnd(){composing=false;}
    element.addEventListener('keydown',key,true);element.addEventListener('beforeinput',reject);element.addEventListener('input',reject);element.addEventListener('compositionstart',composition);element.addEventListener('compositionend',compositionEnd);
    show();return{refresh:show,close(){dead=true;hide();element.removeEventListener('keydown',key,true);element.removeEventListener('beforeinput',reject);element.removeEventListener('input',reject);element.removeEventListener('compositionstart',composition);element.removeEventListener('compositionend',compositionEnd);}};
  }
  async function fetchSuggestion(sessionId,signal,fetcher=fetch){const response=await fetcher('/m/api/suggestions',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({sessionId}),signal});const out=await response.json();if(!response.ok||!out.ok)throw Error('suggestion unavailable');const value=out.value;if(typeof value?.text!=='string'||Array.from(value.text).length>100||!['string','number'].includes(typeof value.revision))throw Error('invalid suggestion');return{text:value.text.trim(),revision:String(value.revision)};}
  function Suggestions({sessionId,session,input,inputActions}){
    const anchor=React.useRef(null),state=React.useRef(null),epoch=React.useRef(0),[suggestion,setSuggestion]=React.useState(null),[visible,setVisible]=React.useState(false),[composing,setComposing]=React.useState(false),[foreground,setForeground]=React.useState(()=>pageVisible());
    const key=session?contextKey(session):'',ready=eligible(session,input)&&!composing&&foreground;
    state.current={sessionId,key,ready,input,session};
    React.useEffect(()=>{const changed=()=>{setForeground(pageVisible());if(!pageVisible()){epoch.current++;setSuggestion(null);setVisible(false);}};document.addEventListener('visibilitychange',changed);return()=>document.removeEventListener('visibilitychange',changed);},[]);
    React.useEffect(()=>{setComposing(false);const seat=anchor.current?.closest('[data-composer-seat]');if(!seat)return;const start=e=>{if(e.target===findInput(anchor.current))setComposing(true);};const end=()=>setComposing(false);seat.addEventListener('compositionstart',start,true);seat.addEventListener('compositionend',end,true);return()=>{seat.removeEventListener('compositionstart',start,true);seat.removeEventListener('compositionend',end,true);};},[sessionId]);
    React.useEffect(()=>{
      const token=++epoch.current,controller=new AbortController();setSuggestion(null);setVisible(false);
      const seat=anchor.current?.closest('[data-composer-seat]');
      if(!ready||!pageVisible()||!sessionId||!key||voiceActive(seat))return()=>controller.abort();
      if(cache.has(key)){setSuggestion(cache.get(key));return()=>controller.abort();}
      if(attempted.has(key))return()=>controller.abort();attempted.add(key);if(attempted.size>500)attempted.delete(attempted.values().next().value);
      const hidden=()=>{if(!pageVisible())controller.abort();};document.addEventListener('visibilitychange',hidden);
      const watcher=new MutationObserver(()=>{if(voiceActive(seat)){controller.abort();epoch.current++;setSuggestion(null);}});if(seat)watcher.observe(seat,{subtree:true,childList:true,attributes:true,attributeFilter:['aria-pressed']});
      void fetchSuggestion(sessionId,controller.signal).then(value=>{if(controller.signal.aborted)return;cache.set(key,value);if(cache.size>100)cache.delete(cache.keys().next().value);if(epoch.current===token&&state.current.sessionId===sessionId&&state.current.key===key&&state.current.ready&&!voiceActive(seat))setSuggestion(value);}).catch(()=>{});
      return()=>{document.removeEventListener('visibilitychange',hidden);watcher.disconnect();epoch.current++;controller.abort();};
    },[sessionId,key,ready]);
    React.useEffect(()=>{
      if(!ready||!suggestion?.text)return;
      const dismissKey=sessionId+'|'+suggestion.revision;if(dismissed.has(dismissKey))return;
      const element=findInput(anchor.current),seat=anchor.current?.closest('[data-composer-seat]');if(!element||!seat)return;
      const current=()=>pageVisible()&&state.current.sessionId===sessionId&&state.current.key===key&&state.current.ready&&!dismissed.has(dismissKey)&&!voiceActive(seat)&&findInput(anchor.current)===element;
      const binding=bindGhost(element,{text:suggestion.text,current,accept:text=>{if(current())inputActions.setDraft(text);},dismiss:()=>{rememberDismissal(dismissKey);setVisible(false);},onVisible:setVisible});
      const visibility=()=>binding.refresh();document.addEventListener('visibilitychange',visibility);
      const observer=new MutationObserver(()=>binding.refresh());observer.observe(seat,{subtree:true,childList:true,attributes:true,attributeFilter:['aria-pressed','disabled','readonly','data-phase']});
      return()=>{document.removeEventListener('visibilitychange',visibility);observer.disconnect();binding.close();};
    },[sessionId,key,ready,suggestion,inputActions]);
    return h('span',{ref:anchor,'data-dsh-suggestions':sessionId,style:{fontSize:11,color:'var(--dsw-alias-label-tertiary,#888)',display:'block',height:visible?16:0,overflow:'hidden',pointerEvents:'none'}},'Tab 采用 · Esc 忽略');
  }
  function apply(ctx){ctx.slots.inject('conversation.input.dock',()=>ctx.slots.register({name:'conversation.input.dock',id:'context-suggestions',order:90},Suggestions));}
  return{inject:['slots'],apply,Suggestions,eligible,contextKey,pageVisible,rememberDismissal,dismissalCount:()=>dismissed.size,findInput,bindGhost,fetchSuggestion};
}});
