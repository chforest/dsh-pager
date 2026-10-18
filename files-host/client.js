window.__ModuleLoader__.load({id:'dsh-workspace-files',factory:require=>{
  'use strict';
  const React=require('react'),h=React.createElement;
  function chatFilePath(element,sessionId){
    const target=element?.closest?.('a[href],button[title]');if(!target||!target.closest('[data-chat-flow]'))return null;
    let value=target.getAttribute(target.tagName==='A'?'href':'title');if(!value||value.length>4096||/[\x00-\x1f]/.test(value))return null;
    if(target.tagName==='A'){
      if(/^file:/i.test(value)){try{const url=new URL(value);if(url.hostname&&!['localhost'].includes(url.hostname))return null;value=decodeURIComponent(url.pathname).replace(/^\/([A-Z]:)/i,'$1');}catch{return null;}}
      else if(/^\/m\/api\/(raw|fs|video)\?/.test(value)){try{const url=new URL(value,'http://localhost');if(url.searchParams.get('s')!==sessionId)return null;value=url.searchParams.get('path');}catch{return null;}}
      else{if(/^(?:[a-z][a-z0-9+.-]*:|\/\/|#)/i.test(value)&&!/^\/?[a-z]:[\\/]/i.test(value))return null;try{value=decodeURIComponent(value.split('#')[0]);}catch{return null;}}
    }
    if(!value||/[\x00-\x1f]/.test(value)||/^(https?|javascript|data):/i.test(value))return null;
    if(!/[\\/]|\.[a-z0-9]{1,12}(?::\d+(?::\d+)?)?$/i.test(value))return null;
    return value.replace(/:\d+(?::\d+)?$/,'');
  }
  function bindChatFileMenu(sessionId,doc=document){
    const context=event=>{const path=chatFilePath(event.target,sessionId);if(path)requestFileMenu(event,sessionId,path);};
    const key=event=>{if(event.key==='ContextMenu'||event.key==='F10'&&event.shiftKey)context(event);};
    doc.addEventListener('contextmenu',context);doc.addEventListener('keydown',key);return()=>{doc.removeEventListener('contextmenu',context);doc.removeEventListener('keydown',key);};
  }
  function fileUrl(kind,sessionId,path){return '/m/api/'+kind+'?s='+encodeURIComponent(sessionId)+'&path='+encodeURIComponent(path||'');}
  function childPath(parent,name){if(typeof name!=='string'||!name||name==='.'||name==='..'||/[\\/]/.test(name))throw new Error('文件名无效');return parent?parent.replace(/\/$/,'')+'/'+name:name;}
  function parentPath(path){const parts=(path||'').split('/').filter(Boolean);parts.pop();return parts.join('/');}
  function requestGate(){let generation=0,controller=null;return{begin(){controller?.abort();controller=new AbortController();const token=++generation;return{signal:controller.signal,current:()=>token===generation};},cancel(){generation++;controller?.abort();},version:()=>generation};}
  async function readFileInfo(sessionId,path,signal,fetcher=fetch){const response=await fetcher(fileUrl('fs',sessionId,path),{signal,cache:'no-store'});const out=await response.json();if(!response.ok||!out.ok)throw new Error(out.error?.message||out.error||'文件读取失败');return out.value;}
  async function copyPath(path,clipboard=navigator.clipboard){if(typeof path!=='string'||!path)throw new Error('服务器未返回完整路径');if(!clipboard?.writeText)throw new Error('当前环境无法自动复制，请手动复制完整路径');try{await clipboard.writeText(path);}catch{throw new Error('复制失败，请手动复制完整路径');}}
  function sizeLabel(n){if(!Number.isFinite(n))return '';return n>=1048576?(n/1048576).toFixed(1)+' MB':n>=1024?(n/1024).toFixed(1)+' KB':n+' B';}
  function isVideoName(name){return /\.(mp4|m4v|webm|mov|mkv|avi|wmv|flv|ts|mts|3gp)$/i.test(name||'');}
  async function openLocalVideo(sessionId,path,workspaces,signal,current,fetcher=fetch){
    if(!current())return false;
    const response=await fetcher('/m/api/desktop/open-video',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({sessionId,path}),signal});
    const out=await response.json();if(!current())return false;if(!response.ok||!out.ok||out.value?.opened!==true)throw new Error(out.error?.message||'AgentPlay 打开请求未确认');return true;
  }
  const FILE_ACTIONS=['open','vscode','notepad','open-with','save-as','reveal'];
  function validContext(detail,sessionId){return !!detail&&detail.sessionId===sessionId&&typeof detail.path==='string'&&detail.path.length>0&&detail.path.length<=4096&&!detail.path.includes('\0');}
  function contextPoint(x,y,width,height,viewportWidth,viewportHeight){return{left:Math.max(8,Math.min(Number.isFinite(x)?x:8,viewportWidth-width-8)),top:Math.max(8,Math.min(Number.isFinite(y)?y:8,viewportHeight-height-8))};}
  function copyableContent(info){return info?.kind==='text'&&info.truncated!==true&&typeof info.text==='string';}
  async function copyFileContent(info,clipboard=navigator.clipboard){if(!copyableContent(info))throw Error('仅能复制完整文本文件；二进制或截断内容不可复制');if(!clipboard?.writeText)throw Error('当前环境无法复制');await clipboard.writeText(info.text);}
  async function nativeFileAction(sessionId,path,action,signal,fetcher=fetch){
    if(!FILE_ACTIONS.includes(action))throw Error('不支持的文件操作');
    const response=await fetcher('/m/api/desktop/file-action',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({sessionId,path,action}),signal});
    const out=await response.json();if(!response.ok||!out.ok)throw Error(out.error?.message||'本机操作未确认，请先核对结果');return out.value;
  }
  function requestFileMenu(event,sessionId,path){
    event.preventDefault();event.stopPropagation();
    const rect=event.currentTarget?.getBoundingClientRect?.();
    window.dispatchEvent(new CustomEvent('dsh:file-context',{detail:{sessionId,path,x:event.clientX||rect?.left||8,y:event.clientY||rect?.bottom||8}}));
  }
  function FileContextMenu({sessionId,isLoopback}){
    React.useEffect(()=>{if(isLoopback)return bindChatFileMenu(sessionId);},[sessionId,isLoopback]);
    const [menu,setMenu]=React.useState(null),[info,setInfo]=React.useState(null),[busy,setBusy]=React.useState(false),[message,setMessage]=React.useState(''),[applications,setApplications]=React.useState(false);
    const dialog=React.useRef(null),gate=React.useRef(requestGate()),sid=React.useRef(sessionId),lock=React.useRef(false),returnFocus=React.useRef(null);sid.current=sessionId;
    function close(){gate.current.cancel();dialog.current?.close();setMenu(null);setApplications(false);setInfo(null);setBusy(false);lock.current=false;const target=returnFocus.current;if(target?.isConnected)target.focus();}
    React.useEffect(()=>{
      close();if(!isLoopback)return;
      const open=event=>{
        if(!validContext(event.detail,sessionId))return;
        const d=event.detail,token=gate.current.begin();returnFocus.current=document.activeElement;lock.current=false;setBusy(false);setMessage('正在读取文件…');setInfo(null);setApplications(false);setMenu({sessionId,path:d.path,x:d.x,y:d.y});
        void readFileInfo(sessionId,d.path,token.signal).then(value=>{if(token.current()&&sid.current===sessionId){setInfo(value);setMessage('');}}).catch(error=>{if(token.current())setMessage(error.message||'文件读取失败');});
      };
      window.addEventListener('dsh:file-context',open);return()=>{window.removeEventListener('dsh:file-context',open);gate.current.cancel();dialog.current?.close();};
    },[sessionId,isLoopback]);
    React.useLayoutEffect(()=>{
      const node=dialog.current;if(!menu||!node)return;if(!node.open)node.showModal();
      const place=()=>{const rect=node.getBoundingClientRect(),p=contextPoint(menu.x,menu.y,rect.width,rect.height,window.innerWidth,window.innerHeight);node.style.left=p.left+'px';node.style.top=p.top+'px';};place();
      node.querySelector('[role="menuitem"]:not(:disabled)')?.focus();window.addEventListener('resize',place);return()=>window.removeEventListener('resize',place);
    },[menu,info,applications]);
    async function act(action){
      if(action==='applications'){setApplications(true);return;}if(action==='back'){setApplications(false);return;}if(!menu||!info||lock.current||sid.current!==menu.sessionId)return;lock.current=true;setBusy(true);setMessage('');const token=gate.current.begin();
      try{if(action==='copy-path')await copyPath(info.absolutePath);else if(action==='copy-content')await copyFileContent(info);else{const result=await nativeFileAction(menu.sessionId,menu.path,action,token.signal);if(result?.cancelled){if(token.current())setMessage('已取消');return;}if(action==='save-as'){if(result?.saved!==true||typeof result.path!=='string')throw Error('保存结果未确认，请核对文件');if(token.current())setMessage('已保存到：'+result.path);return;}if(result?.launched!==true)throw Error('打开结果未确认，请核对本机窗口');}
        if(token.current())setMessage(action.startsWith('copy-')?'已复制':'已向本机应用发送请求');
      }catch(error){if(token.current())setMessage(error.message||'操作未确认，请先核对结果');}
      finally{if(token.current()){lock.current=false;setBusy(false);}}
    }
    function key(event){
      if(event.key==='Escape'){event.preventDefault();event.stopPropagation();close();return;}
      if(!['ArrowDown','ArrowUp','Home','End'].includes(event.key))return;
      event.preventDefault();const items=Array.from(dialog.current.querySelectorAll('[role="menuitem"]:not(:disabled)'));if(!items.length)return;const i=items.indexOf(document.activeElement),next=event.key==='Home'?0:event.key==='End'?items.length-1:event.key==='ArrowUp'?(i-1+items.length)%items.length:(i+1)%items.length;items[next].focus();
    }
    if(!menu)return null;
    const entries=applications?[['back','‹ 返回'],['open','系统默认应用'],['vscode','VS Code'],['notepad','记事本'],['open-with','选择其他程序…']]:[['open',info?.kind==='dir'?'打开文件夹':'打开文件'],['vscode','用 VS Code 打开'],['applications','打开方式 ›'],['save-as','另存为'],['copy-path','复制路径'],['copy-content','复制文件内容'],['reveal','在资源管理器中定位']];
    return h('dialog',{ref:dialog,'aria-label':'文件操作',onCancel:event=>{event.preventDefault();close();},onClick:event=>{if(event.target===dialog.current){const r=dialog.current.getBoundingClientRect();if(event.clientX<r.left||event.clientX>r.right||event.clientY<r.top||event.clientY>r.bottom)close();}},onKeyDown:key,style:{position:'fixed',margin:0,padding:6,width:230,maxWidth:'calc(100vw - 16px)',maxHeight:'calc(100dvh - 16px)',overflowY:'auto',border:'1px solid var(--dsw-alias-border-l2,#ccc)',borderRadius:10,boxShadow:'0 8px 32px #0003',background:'var(--dsw-alias-background-primary,#fff)',color:'var(--dsw-alias-label-primary,#222)'}},
      h('div',{role:'menu','aria-label':'文件操作'},...entries.map(([action,label])=>h('button',{key:action,type:'button',role:'menuitem',disabled:busy||!info||(action==='copy-content'&&!copyableContent(info))||(['applications','save-as'].includes(action)&&info?.kind==='dir')||(action==='notepad'&&info?.kind!=='text'),onClick:()=>void act(action),style:{display:'block',width:'100%',textAlign:'left',padding:'8px 12px',border:0,borderRadius:6,background:'transparent',color:'inherit',opacity:busy||!info||(action==='copy-content'&&!copyableContent(info)) ? 0.45 : 1}},label))),message&&h('p',{role:'status',style:{margin:8,fontSize:12,overflowWrap:'anywhere'}},message));
  }

  function FilesView({sessionId,workspaces,isLoopback,useHostDescription}){
    const hostCanOpen=useHostDescription?useHostDescription(description=>description?.canOpenPath===true):false;
    const canNative=!!isLoopback&&(hostCanOpen||/Windows|Win32|Win64/i.test((navigator.userAgent||'')+' '+(navigator.platform||'')));
    const [storedData,setData]=React.useState(null),[loading,setLoading]=React.useState(false),[error,setError]=React.useState(''),[notice,setNotice]=React.useState(''),[copyFallback,setCopyFallback]=React.useState(''),[copying,setCopying]=React.useState(false);
    const data=storedData?.viewSessionId===sessionId?storedData:null;
    const mediaRef=React.useRef(null);
    React.useEffect(()=>{const player=mediaRef.current;return()=>player?.pause();},[sessionId,data?.rel]);
    const gateRef=React.useRef(requestGate()),sidRef=React.useRef(sessionId),directoryRef=React.useRef(''),dataRef=React.useRef(null),copyController=React.useRef(null),copyLock=React.useRef(false),openLock=React.useRef(false);
    sidRef.current=sessionId;dataRef.current=data;
    async function load(path=''){
      const sid=sessionId;if(!sid)return;openLock.current=false;const gate=gateRef.current.begin();copyController.current?.abort();copyLock.current=false;setCopying(false);setLoading(true);setError('');setNotice('');setCopyFallback('');setData(null);
      try{const value=await readFileInfo(sid,path,gate.signal);if(!gate.current()||sidRef.current!==sid)return;if(value.kind==='dir')directoryRef.current=value.rel||'';setData({...value,viewSessionId:sid});}
      catch(cause){if(gate.current()&&sidRef.current===sid)setError(cause.message||'文件读取失败');}
      finally{if(gate.current()&&sidRef.current===sid)setLoading(false);}
    }
    React.useEffect(()=>{directoryRef.current='';void load('');return()=>{gateRef.current.cancel();copyController.current?.abort();};},[sessionId]);
    async function openEntry(relative,video){
      if(!video||!canNative){void load(relative);return;}
      if(loading||openLock.current)return;openLock.current=true;
      const sid=sessionId,gate=gateRef.current.begin();copyController.current?.abort();copyLock.current=false;setCopying(false);setCopyFallback('');setLoading(true);setError('');setNotice('');
      const current=()=>gate.current()&&sidRef.current===sid;
      try{if(await openLocalVideo(sid,relative,workspaces,gate.signal,current)){if(current())setNotice('已向 AgentPlay 发送本地打开请求。');}}
      catch(cause){if(current())setError('本机打开失败：'+cause.message+'；可点“页内预览”查看。');}
      finally{if(current()){openLock.current=false;setLoading(false);}}
    }
    function back(){const current=dataRef.current;if(current?.kind==='dir')void load(parentPath(current.rel));else void load(directoryRef.current);}
    React.useEffect(()=>{const escape=event=>{if(event.key==='Escape'&&!event.defaultPrevented&&!document.querySelector('dialog[open][aria-label="文件操作"]')&&document.hasFocus()){event.preventDefault();back();}};window.addEventListener('keydown',escape);return()=>window.removeEventListener('keydown',escape);},[sessionId,data]);
    async function copy(relative,known){
      if(copyLock.current)return;copyLock.current=true;setCopying(true);setNotice('');setCopyFallback('');const sid=sessionId,version=gateRef.current.version(),controller=new AbortController();copyController.current=controller;
      const current=()=>sidRef.current===sid&&gateRef.current.version()===version&&!controller.signal.aborted;
      let absolute=known;
      try{if(!absolute)absolute=(await readFileInfo(sid,relative,controller.signal)).absolutePath;if(!current())return;setCopyFallback(absolute||'');await copyPath(absolute);if(current()){setNotice('已复制完整路径');setCopyFallback('');}}
      catch(cause){if(current())setNotice(cause.message||'复制失败');}
      finally{if(current()){copyLock.current=false;setCopying(false);}}
    }
    const buttonStyle={padding:'7px 10px',border:'1px solid var(--dsw-alias-border-l2,#ddd)',borderRadius:8,background:'transparent',color:'inherit',cursor:'pointer'};
    let preview=null;
    if(data?.kind==='media'){
      const url=fileUrl('raw',sessionId,data.rel),type=data.type||'';
      if(type.startsWith('image/'))preview=h('img',{src:url,alt:data.name,style:{maxWidth:'100%',maxHeight:'max(120px, calc(100dvh - 390px))',objectFit:'contain'}});
      else if(type.startsWith('video/'))preview=h('video',{ref:mediaRef,key:url,src:url,controls:true,preload:'metadata',playsInline:true,onError:()=>setError('视频暂时无法播放，可复制完整路径后用本机播放器打开。'),style:{maxWidth:'100%',maxHeight:'max(120px, calc(100dvh - 390px))'},'aria-label':'播放 '+data.name});
      else if(type.startsWith('audio/'))preview=h('audio',{ref:mediaRef,key:url,src:url,controls:true,preload:'metadata',onError:()=>setError('音频暂时无法播放，可复制完整路径后用本机播放器打开。'),'aria-label':'播放 '+data.name});
      else preview=h('p',null,'此文件暂不支持内嵌预览，可复制完整路径后用本机应用打开。');
    }
    if(data?.kind==='text')preview=h(React.Fragment,null,data.truncated&&h('p',{role:'status'},'文件较大，仅显示开头内容。'),h('pre',{style:{whiteSpace:'pre-wrap',overflowWrap:'anywhere',fontSize:13,padding:16,borderRadius:10,background:'var(--dsw-alias-interactive-bg-hover,#f5f6f8)'}},data.text||''));
    if(data?.kind==='binary')preview=h('p',null,'此文件暂不支持内嵌预览，可复制完整路径后用本机应用打开。');
    return h('section',{'aria-label':'工作区文件',style:{padding:20,paddingBottom:180,height:'100%',boxSizing:'border-box',overflow:'auto',color:'var(--dsw-alias-label-primary,inherit)'}},
      h('div',{style:{display:'flex',gap:8,alignItems:'center',flexWrap:'wrap'}},h('strong',null,'文件'),h('button',{type:'button',style:buttonStyle,onClick:()=>void load(''),disabled:loading},'工作区根目录'),h('button',{type:'button',style:buttonStyle,onClick:back,disabled:loading||data?.kind==='dir'&&!data.rel},data&&data.kind!=='dir'?'关闭预览':'上一级'),h('button',{type:'button',style:buttonStyle,onClick:()=>void load(data?.rel||directoryRef.current),disabled:loading},'刷新')),
      data&&h('div',{style:{display:'flex',alignItems:'center',gap:8,margin:'12px 0'}},h('input',{'aria-label':'当前位置完整路径',readOnly:true,value:data.absolutePath||'',style:{flex:1,minWidth:0,padding:8,border:'1px solid var(--dsw-alias-border-l2,#ddd)',borderRadius:8,background:'transparent',color:'inherit'},onFocus:event=>event.target.select()}),h('button',{type:'button',style:buttonStyle,title:'复制当前位置完整路径','aria-label':'复制当前位置完整路径',disabled:copying||!data.absolutePath,onClick:()=>void copy(data.rel,data.absolutePath)},'⧉')),
      notice&&h('p',{role:'status'},notice),copyFallback&&h('input',{'aria-label':'可手动复制的完整路径',value:copyFallback,readOnly:true,onFocus:event=>event.target.select(),style:{width:'100%',boxSizing:'border-box'}}),
      loading&&h('p',{role:'status'},'正在读取文件…'),error&&h('p',{role:'alert'},error),
      data?.kind==='dir'&&h('div',null,!data.entries.length&&h('p',null,'这个文件夹是空的。'),...data.entries.map(entry=>{const relative=childPath(data.rel,entry.name);return h('div',{key:relative,onContextMenu:canNative?event=>requestFileMenu(event,sessionId,relative):undefined,onKeyDown:canNative?event=>{if((event.shiftKey&&event.key==='F10')||event.key==='ContextMenu')requestFileMenu(event,sessionId,relative);}:undefined,style:{display:'flex',alignItems:'center',gap:10,padding:'9px 0',borderBottom:'1px solid var(--dsw-alias-border-l2,#ddd)'}},h('button',{type:'button',onClick:()=>void openEntry(relative,!entry.dir&&isVideoName(entry.name)),disabled:loading,title:!entry.dir&&isVideoName(entry.name)&&canNative?'用本机播放器打开':undefined,style:{...buttonStyle,flex:1,textAlign:'left',border:0,minWidth:0,overflowWrap:'anywhere'}},(entry.dir?'📁 ':'📄 ')+entry.name),!entry.dir&&h('small',{style:{opacity:.7,whiteSpace:'nowrap'}},sizeLabel(entry.size)),!entry.dir&&isVideoName(entry.name)&&canNative&&h('button',{type:'button',style:buttonStyle,disabled:loading,onClick:()=>void load(relative),'aria-label':'页内预览 '+entry.name},'页内预览'),h('button',{type:'button',style:buttonStyle,title:'复制完整路径','aria-label':'复制 '+entry.name+' 完整路径',disabled:copying,onClick:()=>void copy(relative)},'⧉'));}),data.more&&h('p',{role:'status'},'目录项目较多，当前仅显示前一部分。')),
      data&&data.kind!=='dir'&&h('div',{style:{marginTop:12,textAlign:data.kind==='media'?'center':'left'}},h('h3',null,data.name),h('div',{style:{display:data.kind==='media'?'flex':'block',justifyContent:'center',alignItems:'flex-start'}},preview)));
  }
  function apply(ctx){ctx.slots.inject('conversation.input.dock',()=>ctx.slots.register({name:'conversation.input.dock',id:'workspace-file-context',order:95,inject:()=>({isLoopback:ctx.get('connection').isLoopback})},FileContextMenu));ctx.slots.inject('conversation.view',()=>ctx.slots.register({name:'conversation.view',id:'workspace-files',label:'文件',order:20,inject:()=>{const connection=ctx.get('connection');return{workspaces:ctx.workspaces,isLoopback:connection.isLoopback,...(connection.hostDescription?{hooks:{hostDescription:connection.hostDescription}}:{})};}},FilesView));}
  return{inject:['slots','workspaces','connection'],apply,chatFilePath,bindChatFileMenu,FileContextMenu,validContext,contextPoint,copyableContent,copyFileContent,nativeFileAction,requestFileMenu,FilesView,fileUrl,childPath,parentPath,requestGate,readFileInfo,copyPath,isVideoName,openLocalVideo};
}});
