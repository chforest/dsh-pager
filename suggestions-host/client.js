window.__ModuleLoader__.load({id:'dsh-suggestions',factory:require=>{
  'use strict';
  const React=require('react'),h=React.createElement;
  const cache=new Map(),attempted=new Set(),dismissed=new Set();
  function contextKey(session){let last=-1;for(const seq of session.turnEnds?.values?.()||[])if(Number.isSafeInteger(seq))last=Math.max(last,seq);return session.sessionId+'|'+last+'|'+(session.nodes?.length||0);}
  function pageVisible(doc=document){return doc.visibilityState==='visible'&&!doc.hidden;}
  function rememberDismissal(key){dismissed.add(key);if(dismissed.size>500)dismissed.delete(dismissed.values().next().value);}
  function eligible(session,input){return !!session&&session.turnEnds?.size>0&&!session.running&&!session.removed&&!session.pending?.length&&!session.pendingSubmissions?.length&&!session.queue?.length&&!!input&&input.phase==='plain'&&input.draft===''&&!(input.attachmentIds||input.imageIds)?.length&&!input.queue?.length;}
  function findInput(anchor){const seat=anchor?.closest?.('[data-composer-seat]');if(!seat)return null;const rows=Array.from(seat.querySelectorAll('textarea[data-phase], [data-composer-input][role="textbox"]')).filter(el=>el.getClientRects().length>0);return rows.length===1?rows[0]:null;}
  function modernInput(element){return element.getAttribute('data-composer-input')!==null;}
  function inputEmpty(element){return modernInput(element)?(element.textContent||'')==='':element.value==='';}
  function inputDisabled(element){return element.disabled||element.readOnly||element.getAttribute('aria-disabled')==='true'||modernInput(element)&&element.getAttribute('contenteditable')==='false';}
  function placeholderRead(element){return modernInput(element)?element.parentElement?.querySelector('[data-composer-placeholder]')?.textContent??null:element.getAttribute('placeholder');}
  function placeholderWrite(element,value){if(modernInput(element)){const node=element.parentElement?.querySelector('[data-composer-placeholder]');if(node&&node.textContent!==(value??''))node.textContent=value??'';}else if(value===null)element.removeAttribute('placeholder');else if(element.getAttribute('placeholder')!==value)element.setAttribute('placeholder',value);}
  function voiceActive(seat){if(!seat)return false;if(seat.querySelector('[role="dialog"][aria-label="DSH 语音电话"]'))return true;const mic=seat.querySelector('[data-dshvm="mic"][aria-pressed="true"]');if(!mic)return false;return mic.getAttribute('data-voice-kind')!=='message'||mic.getAttribute('data-voice-recording')==='true';}
  function bindGhost(element,{text,current,accept,dismiss,onVisible=()=>{}}){
    let original=placeholderRead(element),ours=null,composing=false,dead=false;
    function hide(){if(ours!==null&&placeholderRead(element)===ours)placeholderWrite(element,original);ours=null;onVisible(false);}
    function show(){if(dead||composing||!current()||!inputEmpty(element)||inputDisabled(element)||modernInput(element)&&placeholderRead(element)===null){hide();return;}if(ours===null)original=placeholderRead(element);ours=text;placeholderWrite(element,text);onVisible(true);}
    function reject(){hide();dismiss();}
    function key(event){if(event.target!==element&&!element.contains?.(event.target)||element.ownerDocument.activeElement!==element)return;if(event.isComposing||composing)return;if(event.key==='Escape'){reject();return;}if(event.key==='Tab'&&!event.shiftKey&&!event.altKey&&!event.ctrlKey&&!event.metaKey&&ours!==null&&current()&&inputEmpty(element)&&!inputDisabled(element)){event.preventDefault();event.stopPropagation();hide();accept(text);dismiss();}else if(event.key.length===1||event.key==='Backspace'||event.key==='Delete')reject();}
    function composition(){composing=true;reject();}function compositionEnd(){composing=false;}
    element.addEventListener('keydown',key,true);element.addEventListener('beforeinput',reject);element.addEventListener('input',reject);element.addEventListener('compositionstart',composition);element.addEventListener('compositionend',compositionEnd);
    show();return{refresh:show,close(){dead=true;hide();element.removeEventListener('keydown',key,true);element.removeEventListener('beforeinput',reject);element.removeEventListener('input',reject);element.removeEventListener('compositionstart',composition);element.removeEventListener('compositionend',compositionEnd);}};
  }
  async function fetchSuggestion(sessionId,signal,fetcher=fetch){const response=await fetcher('/m/api/suggestions',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({sessionId}),signal});const out=await response.json();if(!response.ok||!out.ok)throw Error('suggestion unavailable');const value=out.value;if(typeof value?.text!=='string'||Array.from(value.text).length>100||!['string','number'].includes(typeof value.revision))throw Error('invalid suggestion');return{text:value.text.trim(),revision:String(value.revision)};}
  function Suggestions({sessionId,session:sessionMeta,input,inputActions,useChat}){
    const chat=useChat?useChat(s=>s):null,session=chat?{...sessionMeta,...chat.legacy}:sessionMeta;
    const anchor=React.useRef(null),state=React.useRef(null),epoch=React.useRef(0),[suggestion,setSuggestion]=React.useState(null),[visible,setVisible]=React.useState(false),[composing,setComposing]=React.useState(false),[foreground,setForeground]=React.useState(()=>pageVisible()),[voiceBusy,setVoiceBusy]=React.useState(false);
    const key=session?contextKey(session):'',ready=eligible(session,input)&&!composing&&foreground&&!voiceBusy;
    state.current={sessionId,key,ready,input,session};
    React.useEffect(()=>{const changed=()=>{setForeground(pageVisible());if(!pageVisible()){epoch.current++;setSuggestion(null);setVisible(false);}};document.addEventListener('visibilitychange',changed);return()=>document.removeEventListener('visibilitychange',changed);},[]);
    React.useEffect(()=>{setComposing(false);const seat=anchor.current?.closest('[data-composer-seat]');if(!seat){setVoiceBusy(false);return;}const syncVoice=()=>setVoiceBusy(voiceActive(seat));syncVoice();const voiceObs=new MutationObserver(syncVoice);voiceObs.observe(seat,{subtree:true,childList:true,attributes:true,attributeFilter:['aria-pressed','data-voice-kind','data-voice-recording']});const start=e=>{if(e.target===findInput(anchor.current))setComposing(true);};const end=()=>setComposing(false);seat.addEventListener('compositionstart',start,true);seat.addEventListener('compositionend',end,true);return()=>{voiceObs.disconnect();seat.removeEventListener('compositionstart',start,true);seat.removeEventListener('compositionend',end,true);};},[sessionId]);
    React.useEffect(()=>{
      const token=++epoch.current,controller=new AbortController();setSuggestion(null);setVisible(false);
      const seat=anchor.current?.closest('[data-composer-seat]');
      if(!ready||!pageVisible()||!sessionId||!key||voiceActive(seat))return()=>controller.abort();
      if(cache.has(key)){setSuggestion(cache.get(key));return()=>controller.abort();}
      if(attempted.has(key))return()=>controller.abort();
      const hidden=()=>{if(!pageVisible())controller.abort();};document.addEventListener('visibilitychange',hidden);
      const watcher=new MutationObserver(()=>{if(voiceActive(seat)){controller.abort();epoch.current++;setSuggestion(null);}});if(seat)watcher.observe(seat,{subtree:true,childList:true,attributes:true,attributeFilter:['aria-pressed','data-voice-kind','data-voice-recording']});
      void (async()=>{
        try{
          let value=null;
          for(let attempt=0;attempt<3;attempt++){
            if(attempt>0)await new Promise((r,j)=>{const t=setTimeout(r,450*attempt);controller.signal.addEventListener('abort',()=>{clearTimeout(t);j(new Error('aborted'));},{once:true});});
            value=await fetchSuggestion(sessionId,controller.signal);
            if(controller.signal.aborted)return;
            if(value.revision||value.text)break;
          }
          if(!value||controller.signal.aborted)return;
          if(value.revision){
            attempted.add(key);if(attempted.size>500)attempted.delete(attempted.values().next().value);
            cache.set(key,value);if(cache.size>100)cache.delete(cache.keys().next().value);
          }
          if(epoch.current===token&&state.current.sessionId===sessionId&&state.current.key===key&&state.current.ready&&!voiceActive(seat))setSuggestion(value);
        }catch{}
      })();
      return()=>{document.removeEventListener('visibilitychange',hidden);watcher.disconnect();epoch.current++;controller.abort();};
    },[sessionId,key,ready]);
    React.useEffect(()=>{
      if(!ready||!suggestion?.text)return;
      const dismissKey=sessionId+'|'+suggestion.revision;if(dismissed.has(dismissKey))return;
      const element=findInput(anchor.current),seat=anchor.current?.closest('[data-composer-seat]');if(!element||!seat)return;
      const current=()=>pageVisible()&&state.current.sessionId===sessionId&&state.current.key===key&&state.current.ready&&!dismissed.has(dismissKey)&&!voiceActive(seat)&&findInput(anchor.current)===element;
      const binding=bindGhost(element,{text:suggestion.text,current,accept:text=>{if(current())inputActions.setDraft(text);},dismiss:()=>{rememberDismissal(dismissKey);setVisible(false);},onVisible:setVisible});
      const visibility=()=>binding.refresh();document.addEventListener('visibilitychange',visibility);
      const observer=new MutationObserver(()=>binding.refresh());observer.observe(seat,{subtree:true,childList:true,characterData:true,attributes:true,attributeFilter:['aria-pressed','data-voice-kind','data-voice-recording','aria-disabled','disabled','readonly','contenteditable','data-phase']});
      return()=>{document.removeEventListener('visibilitychange',visibility);observer.disconnect();binding.close();};
    },[sessionId,key,ready,suggestion,inputActions]);
    return h('span',{ref:anchor,'data-dsh-suggestions':sessionId,onClick:()=>{if(visible&&suggestion?.text){inputActions?.setDraft?.(suggestion.text);rememberDismissal(sessionId+'|'+suggestion.revision);setVisible(false);}},style:{fontSize:11,color:'var(--dsw-alias-label-tertiary,#888)',display:'block',height:visible?18:0,lineHeight:'18px',overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap',cursor:visible?'pointer':'default',pointerEvents:visible?'auto':'none'}},visible&&suggestion?.text?'💡 '+suggestion.text+'  (Tab 或点击采用 · Esc 忽略)':'Tab 采用 · Esc 忽略');
  }
  function apply(ctx){ctx.slots.inject('conversation.input.dock',()=>ctx.slots.register({name:'conversation.input.dock',id:'context-suggestions',order:90},Suggestions));}
  return{inject:['slots'],apply,Suggestions,eligible,contextKey,pageVisible,rememberDismissal,dismissalCount:()=>dismissed.size,findInput,bindGhost,fetchSuggestion,voiceActive};
}});
