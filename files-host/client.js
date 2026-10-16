window.__ModuleLoader__.load({id:'dsh-workspace-files',factory:require=>{
  'use strict';
  const React=require('react'),h=React.createElement;
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
  function FilesView({sessionId,workspaces,isLoopback,useHostDescription}){
    const hostCanOpen=useHostDescription?useHostDescription(description=>description?.canOpenPath===true):false;
    const canNative=!!isLoopback&&hostCanOpen;
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
    React.useEffect(()=>{const escape=event=>{if(event.key==='Escape'&&!event.defaultPrevented&&document.hasFocus()){event.preventDefault();back();}};window.addEventListener('keydown',escape);return()=>window.removeEventListener('keydown',escape);},[sessionId,data]);
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
      data?.kind==='dir'&&h('div',null,!data.entries.length&&h('p',null,'这个文件夹是空的。'),...data.entries.map(entry=>{const relative=childPath(data.rel,entry.name);return h('div',{key:relative,style:{display:'flex',alignItems:'center',gap:10,padding:'9px 0',borderBottom:'1px solid var(--dsw-alias-border-l2,#ddd)'}},h('button',{type:'button',onClick:()=>void openEntry(relative,!entry.dir&&isVideoName(entry.name)),disabled:loading,title:!entry.dir&&isVideoName(entry.name)&&canNative?'用本机播放器打开':undefined,style:{...buttonStyle,flex:1,textAlign:'left',border:0,minWidth:0,overflowWrap:'anywhere'}},(entry.dir?'📁 ':'📄 ')+entry.name),!entry.dir&&h('small',{style:{opacity:.7,whiteSpace:'nowrap'}},sizeLabel(entry.size)),!entry.dir&&isVideoName(entry.name)&&canNative&&h('button',{type:'button',style:buttonStyle,disabled:loading,onClick:()=>void load(relative),'aria-label':'页内预览 '+entry.name},'页内预览'),h('button',{type:'button',style:buttonStyle,title:'复制完整路径','aria-label':'复制 '+entry.name+' 完整路径',disabled:copying,onClick:()=>void copy(relative)},'⧉'));}),data.more&&h('p',{role:'status'},'目录项目较多，当前仅显示前一部分。')),
      data&&data.kind!=='dir'&&h('div',{style:{marginTop:12,textAlign:data.kind==='media'?'center':'left'}},h('h3',null,data.name),h('div',{style:{display:data.kind==='media'?'flex':'block',justifyContent:'center',alignItems:'flex-start'}},preview)));
  }
  function apply(ctx){ctx.slots.inject('conversation.view',()=>ctx.slots.register({name:'conversation.view',id:'workspace-files',label:'文件',order:20,inject:()=>({workspaces:ctx.workspaces,isLoopback:ctx.get('connection').isLoopback,hooks:{hostDescription:ctx.get('connection').hostDescription}})},FilesView));}
  return{inject:['slots','workspaces','connection'],apply,FilesView,fileUrl,childPath,parentPath,requestGate,readFileInfo,copyPath,isVideoName,openLocalVideo};
}});
