window.__ModuleLoader__.load({id:'dsh-screenshot',factory:(require)=>{
  'use strict';
  const React=require('react'),h=React.createElement;
  function allowedEnvironment(loc=location,nav=navigator){return ['127.0.0.1','localhost','[::1]','::1'].includes(loc.hostname)&&/Windows|Win32|Win64/i.test((nav.userAgent||'')+' '+(nav.platform||''));}
  function captureTicket(value){
    if(!value||typeof value.captureUrl!=='string'||typeof value.token!=='string'||!value.token||value.token.length>4096||/[\r\n]/.test(value.token))throw new Error('截图授权无效');
    const url=new URL(value.captureUrl);
    if(url.protocol!=='http:'||url.hostname!=='127.0.0.1'||url.pathname!=='/capture'||url.username||url.password||url.search||url.hash||!url.port)throw new Error('截图服务地址不安全');
    return{captureUrl:url.href,token:value.token};
  }
  async function brokerRequest(endpoint,payload,signal,fetcher=fetch){
    if(!['/capture','/ocr','/translate'].includes(endpoint))throw new Error('不支持的截图操作');
    const response=await fetcher('/m/api/desktop/screenshot',{method:'POST',headers:{'content-type':'application/json'},body:'{}',signal});
    const out=await response.json();if(!response.ok||!out.ok)throw new Error(out.error?.message||out.error||'无法连接截图服务');
    const ticket=captureTicket(out.value);
    const url=new URL(ticket.captureUrl);url.pathname=endpoint;
    const captured=await fetcher(url.href,{method:'POST',headers:{'content-type':'application/json','x-dsh-capture-token':ticket.token},body:JSON.stringify(payload),credentials:'omit',redirect:'error',signal});
    const result=await captured.json();if(!captured.ok||!result.ok)throw new Error(result.error?.message||result.error||'截图失败');
    return result.value;
  }
  async function captureRequest(signal,fetcher=fetch){return brokerRequest('/capture',{},signal,fetcher);}
  function historyChange(marks,redo,action,mark){if(action==='add')return{marks:[...marks,mark],redo:[]};if(action==='undo'&&marks.length)return{marks:marks.slice(0,-1),redo:[...redo,marks.at(-1)]};if(action==='redo'&&redo.length)return{marks:[...marks,redo.at(-1)],redo:redo.slice(0,-1)};return{marks,redo};}
  function addTextDraft(actions,draft,value,current){if(!current()||!value.trim()||typeof actions?.setDraft!=='function')return false;actions.setDraft(draft+(draft&&!draft.endsWith('\n')?'\n':'')+value);return true;}
  function canvasImage(canvas){return{mime:'image/png',data:canvas.toDataURL('image/png').split(',')[1],width:canvas.width,height:canvas.height};}
  function resultCurrent(owner,state){return state.live&&state.sid===owner.sid&&state.generation===owner.token&&state.request===owner.request&&state.revision===owner.revision;}
  async function translationPipeline({text,image,target,sessionId,signal,current,request=brokerRequest,onStage=()=>{}}){
    if(!current()||signal?.aborted)return null;
    let original=text;
    if(!original.trim()){
      onStage('正在提取文字…');
      const value=await request('/ocr',{image:image()},signal);
      if(!current()||signal?.aborted)return null;
      if(typeof value?.text!=='string')throw new Error('没有收到有效文字');
      original=value.text;
    }
    if(!original.trim())throw new Error('未识别到文字，请框选包含文字的区域或在侧栏输入');
    if(!current()||signal?.aborted)return null;
    onStage('正在翻译…');
    const value=await request('/translate',{text:original,target,sessionId},signal);
    if(!current()||signal?.aborted)return null;
    if(typeof value?.text!=='string')throw new Error('没有收到有效译文');
    return{original,text:value.text};
  }
  function drawMark(ctx,mark,original,makeCanvas=()=>document.createElement('canvas')){
    const x=Math.min(mark.x,mark.ex),y=Math.min(mark.y,mark.ey),w=Math.abs(mark.ex-mark.x),height=Math.abs(mark.ey-mark.y);
    ctx.save();ctx.strokeStyle='#f04444';ctx.fillStyle='#f04444';ctx.lineWidth=4;ctx.lineCap='round';
    if(mark.tool==='rect')ctx.strokeRect(x,y,w,height);
    if(mark.tool==='arrow'){
      const angle=Math.atan2(mark.ey-mark.y,mark.ex-mark.x),head=18;
      ctx.beginPath();ctx.moveTo(mark.x,mark.y);ctx.lineTo(mark.ex,mark.ey);ctx.moveTo(mark.ex-head*Math.cos(angle-Math.PI/6),mark.ey-head*Math.sin(angle-Math.PI/6));ctx.lineTo(mark.ex,mark.ey);ctx.lineTo(mark.ex-head*Math.cos(angle+Math.PI/6),mark.ey-head*Math.sin(angle+Math.PI/6));ctx.stroke();
    }
    if(mark.tool==='text'&&mark.text){ctx.font='28px sans-serif';ctx.textBaseline='top';ctx.fillText(mark.text,mark.x,mark.y);}
    if(mark.tool==='cover'){ctx.fillStyle='#111';ctx.fillRect(x,y,w,height);}
    if(mark.tool==='mosaic'&&w>0&&height>0){
      const small=makeCanvas();small.width=Math.max(1,Math.ceil(w/16));small.height=Math.max(1,Math.ceil(height/16));
      small.getContext('2d').drawImage(ctx.canvas||original,x,y,w,height,0,0,small.width,small.height);ctx.imageSmoothingEnabled=false;ctx.drawImage(small,0,0,small.width,small.height,x,y,w,height);
    }
    ctx.restore();
  }
  function addScreenshotDraft(conversation,actions,file,stillCurrent){
    if(!stillCurrent())return false;
    const images=conversation.createDraftImages([file]);
    try{if(!stillCurrent()||actions.addImages(images.map(image=>image.id))===false){conversation.releaseDraftImages(images);return false;}return true;}
    catch(error){conversation.releaseDraftImages(images);throw error;}
  }
  function ScreenshotButton({sessionId,inputActions,conversation,useInput}){
    const [busy,setBusy]=React.useState(false),[shot,setShot]=React.useState(null),[marks,setMarks]=React.useState([]),[tool,setTool]=React.useState('rect'),[text,setText]=React.useState(''),[error,setError]=React.useState('');
    const [waitingLong,setWaitingLong]=React.useState(false);
    const [redo,setRedo]=React.useState([]),[panel,setPanel]=React.useState(false),[original,setOriginal]=React.useState(''),[translated,setTranslated]=React.useState(''),[tab,setTab]=React.useState('original'),[target,setTarget]=React.useState('zh-CN'),[operation,setOperation]=React.useState('');
    const draft=useInput?useInput(s=>s?.draft??''):null;
    const editRevision=React.useRef(0),requestId=React.useRef(0),analysisController=React.useRef(null);
    function invalidate(){editRevision.current++;requestId.current++;analysisController.current?.abort();setOperation('');setOriginal('');setTranslated('');}
    function change(action,mark){invalidate();const next=historyChange(marks,redo,action,mark);setMarks(next.marks);setRedo(next.redo);}
    const canvasRef=React.useRef(null),imageRef=React.useRef(null),dragRef=React.useRef(null),controllerRef=React.useRef(null),generation=React.useRef(0),sidRef=React.useRef(sessionId),live=React.useRef(true),captureRef=React.useRef(null),lock=React.useRef(false);
    sidRef.current=sessionId;
    function cancel(){generation.current++;requestId.current++;analysisController.current?.abort();controllerRef.current?.abort();controllerRef.current=null;dragRef.current=null;imageRef.current=null;lock.current=false;if(live.current){setOperation('');setPanel(false);setOriginal('');setTranslated('');setRedo([]);setBusy(false);setShot(null);setMarks([]);setError('');}}
    React.useEffect(()=>{cancel();return()=>{generation.current++;controllerRef.current?.abort();};},[sessionId]);
    React.useEffect(()=>{live.current=true;return()=>{live.current=false;generation.current++;requestId.current++;analysisController.current?.abort();controllerRef.current?.abort();};},[]);
    React.useEffect(()=>{
      setWaitingLong(false);
      if(!busy||shot)return;
      const timer=setTimeout(()=>setWaitingLong(true),12000);
      const escape=event=>{if(event.key==='Escape'){event.preventDefault();cancel();}};
      const rightClick=event=>{event.preventDefault();cancel();};
      window.addEventListener('keydown',escape);window.addEventListener('contextmenu',rightClick);
      return()=>{clearTimeout(timer);window.removeEventListener('keydown',escape);window.removeEventListener('contextmenu',rightClick);};
    },[busy,shot]);
    function paint(preview){const canvas=canvasRef.current,img=imageRef.current;if(!canvas||!img)return;const ctx=canvas.getContext('2d');ctx.clearRect(0,0,canvas.width,canvas.height);ctx.drawImage(img,0,0);marks.forEach(mark=>drawMark(ctx,mark,img));if(preview)drawMark(ctx,preview,img);}
    React.useEffect(()=>{paint();},[marks,shot]);
    async function capture(){
      if(lock.current||shot||!sessionId||!allowedEnvironment())return;
      lock.current=true;setBusy(true);setError('');const sid=sessionId,token=++generation.current,controller=new AbortController();controllerRef.current=controller;
      const current=()=>live.current&&generation.current===token&&sidRef.current===sid;
      try{
        const value=await captureRequest(AbortSignal.any([controller.signal,AbortSignal.timeout(105000)]));if(!current())return;if(value?.cancelled)return;
        if(value?.mime!=='image/png'||typeof value.data!=='string'||!value.data)throw new Error('没有收到有效截图');
        const img=new Image();await new Promise((resolve,reject)=>{img.onload=resolve;img.onerror=()=>reject(new Error('截图无法读取'));img.src='data:image/png;base64,'+value.data;});if(!current())return;
        imageRef.current=img;setMarks([]);setShot({width:img.naturalWidth,height:img.naturalHeight,sid,token});
      }catch(cause){if(current()&&!controller.signal.aborted)setError(cause.name==='TimeoutError'?'未收到框选结果，已停止本次截图。请重试；若没有框选窗口，请检查原生截图服务。':cause.message);}
      finally{if(current()){lock.current=false;setBusy(false);controllerRef.current=null;}}
    }
    captureRef.current=capture;
    React.useEffect(()=>{const key=event=>{if(!event.repeat&&event.ctrlKey&&event.shiftKey&&!event.altKey&&!event.metaKey&&event.code==='KeyX'&&!document.hidden&&document.hasFocus()&&allowedEnvironment()){event.preventDefault();void captureRef.current?.();}};window.addEventListener('keydown',key);return()=>window.removeEventListener('keydown',key);},[]);
    function point(event){const rect=event.currentTarget.getBoundingClientRect();return{x:Math.max(0,Math.min(shot.width,(event.clientX-rect.left)*shot.width/rect.width)),y:Math.max(0,Math.min(shot.height,(event.clientY-rect.top)*shot.height/rect.height))};}
    function down(event){if(busy)return;const p=point(event);if(tool==='text'){if(!text.trim()){setError('先填写要添加的文字，再点图片');return;}change('add',{...p,ex:p.x,ey:p.y,tool,text:text.trim()});return;}invalidate();dragRef.current={...p,ex:p.x,ey:p.y,tool};event.currentTarget.setPointerCapture(event.pointerId);}
    function move(event){if(!dragRef.current)return;const p=point(event);dragRef.current={...dragRef.current,ex:p.x,ey:p.y};paint(dragRef.current);}
    function up(event){if(!dragRef.current)return;move(event);const mark=dragRef.current;dragRef.current=null;if(Math.abs(mark.ex-mark.x)+Math.abs(mark.ey-mark.y)>3)change('add',mark);else paint();}
    async function analyze(kind){
      if(!shot||dragRef.current)return;analysisController.current?.abort();const controller=new AbortController();analysisController.current=controller;
      const owned=shot,id=++requestId.current,revision=editRevision.current;
      const current=()=>resultCurrent({...owned,request:id,revision},{live:live.current,sid:sidRef.current,generation:generation.current,request:requestId.current,revision:editRevision.current});
      setPanel(true);setOperation(kind==='ocr'?'正在提取文字…':'正在翻译…');setError('');
      try{const signal=AbortSignal.any([controller.signal,AbortSignal.timeout(90000)]);
        if(kind==='translate'){
          const value=await translationPipeline({text:original,image:()=>{paint();return canvasImage(canvasRef.current);},target,sessionId:owned.sid,signal,current,onStage:stage=>{if(current())setOperation(stage);}});
          if(!value||!current())return;setOriginal(value.original);setTranslated(value.text);setTab('translated');return;
        }
        paint();const payload={image:canvasImage(canvasRef.current)};
        const value=await brokerRequest('/ocr',payload,signal);if(!current())return;
        if(typeof value?.text!=='string')throw new Error('没有收到有效文字');
        if(kind==='ocr'){setOriginal(value.text);setTranslated('');setTab('original');if(!value.text.trim())setError('未识别到文字，可直接在侧栏输入');}else{setTranslated(value.text);setTab('translated');}
      }catch(cause){if(current()&&!controller.signal.aborted)setError(cause.name==='TimeoutError'?'处理超时，请稍后重试':cause.message);}finally{if(current())setOperation('');}
    }
    async function exportImage(copy){if(!shot||dragRef.current)return;const owned=shot,revision=editRevision.current,current=()=>live.current&&sidRef.current===owned.sid&&generation.current===owned.token&&revision===editRevision.current;
      try{paint();const blob=await new Promise(resolve=>canvasRef.current.toBlob(resolve,'image/png'));if(!current())return;if(!blob)throw new Error('图片导出失败');
        if(copy){if(!navigator.clipboard?.write||typeof ClipboardItem==='undefined')throw new Error('当前环境不支持复制图片，请保存 PNG');await navigator.clipboard.write([new ClipboardItem({'image/png':blob})]);}
        else{const url=URL.createObjectURL(blob),link=document.createElement('a');link.href=url;link.download='DSH截图.png';link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}
      }catch(cause){if(current())setError(cause.message);}}
    async function copyText(){const token=generation.current;try{await navigator.clipboard.writeText(tab==='original'?original:translated);}catch{if(live.current&&generation.current===token)setError('复制失败，请选择文字后手动复制');}}
    async function attach(){
      if(lock.current||!shot||dragRef.current)return;
      lock.current=true;setBusy(true);setError('');const owned=shot,actions=inputActions;
      const current=()=>live.current&&sidRef.current===owned.sid&&generation.current===owned.token;
      try{paint();const blob=await new Promise(resolve=>canvasRef.current.toBlob(resolve,'image/png'));if(!current())return;if(!blob)throw new Error('截图导出失败');
        const file=new File([blob],'DSH截图-'+new Date().toISOString().replace(/[:.]/g,'-')+'.png',{type:'image/png'});
        if(!addScreenshotDraft(conversation,actions,file,current))throw new Error('当前输入框暂不能添加图片，请稍后重试');cancel();
      }catch(cause){if(current())setError(cause.message);}finally{if(current()){lock.current=false;setBusy(false);}}
    }
    if(!sessionId||!allowedEnvironment())return null;
    const buttons=[['rect','矩形'],['arrow','箭头'],['text','标字'],['cover','遮挡'],['mosaic','马赛克']];
    return h(React.Fragment,null,h('style',null,'.dsh-shot-editor{font:14px/1.5 system-ui,-apple-system,Segoe UI,sans-serif}.dsh-shot-editor button,.dsh-shot-editor select{font:inherit;color:inherit;border:1px solid #dbe1ea;border-radius:8px;background:#fff;padding:6px 10px;cursor:pointer;transition:background .12s}.dsh-shot-editor button:hover:not(:disabled){background:#f0f5ff}.dsh-shot-editor button:disabled{opacity:.42;cursor:default}.dsh-shot-editor button[aria-pressed=true]{background:#e8f0ff;border-color:#b6cfff;color:#245ec7}.dsh-shot-editor textarea{box-sizing:border-box;font:15px/1.65 system-ui,sans-serif;padding:12px;border:1px solid #dbe1ea;border-radius:10px;resize:none}.dsh-shot-editor textarea:focus,.dsh-shot-editor select:focus{outline:2px solid #aecbff;outline-offset:1px}.dsh-shot-editor small{color:#687386}.dsh-shot-editor strong{font-size:16px;margin-right:6px}'),h('button',{type:'button',disabled:busy||!!shot,onClick:()=>void capture(),title:'截图并标注（Ctrl+Shift+X）','aria-label':'截图并标注',style:{border:0,background:'transparent',color:'inherit',cursor:'pointer',padding:8}},'✂'),
      busy&&!shot&&h('small',{role:'status'},waitingLong?'仍在等待框选结果；若没有出现框选窗口，请按 Esc 或右键取消后重试':'正在打开框选…右键 / Esc 取消'),!shot&&error&&h('span',{role:'alert'},error),
      shot&&h('section',{className:'dsh-shot-editor',role:'dialog','aria-modal':true,'aria-label':'截图标注',style:{position:'fixed',inset:24,zIndex:11000,borderRadius:16,background:'#fff',color:'#222',boxShadow:'0 0 0 100vmax #0008',padding:16,display:'flex',flexDirection:'column',gap:12}},
        h('div',{role:'toolbar','aria-label':'截图编辑工具',style:{display:'flex',gap:6,alignItems:'center',flexWrap:'wrap'}},h('strong',null,'截图'),...buttons.map(([id,label])=>h('button',{key:id,type:'button',disabled:busy,'aria-pressed':tool===id,onClick:()=>setTool(id),style:{border:'1px solid #ddd',borderRadius:6,padding:'5px 9px',background:tool===id?'#dceaff':'#fff'}},label)),h('button',{type:'button',disabled:busy||!marks.length,onClick:()=>change('undo')},'撤销'),h('button',{type:'button',disabled:busy||!redo.length,onClick:()=>change('redo')},'重做'),h('button',{type:'button',disabled:busy||!!operation,onClick:()=>void analyze('ocr')},'提取文字'),h('button',{type:'button',disabled:busy||!!operation,onClick:()=>void analyze('translate')},'翻译'),h('button',{type:'button',disabled:busy,onClick:()=>void exportImage(true)},'复制图片'),h('button',{type:'button',disabled:busy,onClick:()=>void exportImage(false)},'保存 PNG'),h('button',{type:'button',onClick:cancel},'取消'),h('button',{type:'button',disabled:busy,onClick:()=>void attach(),style:{marginLeft:'auto',background:'#1677ff',color:'#fff',border:0,borderRadius:6,padding:'7px 12px'}},busy?'正在添加…':'添加图片')),
        tool==='text'&&h('input',{'aria-label':'标注文字',value:text,onChange:event=>setText(event.target.value),placeholder:'输入文字，再点击图片放置',maxLength:160,disabled:busy}),
        error&&h('p',{role:'alert',style:{margin:0,color:'#b42318'}},error),h('div',{style:{display:'flex',gap:12,flex:1,minHeight:0}},
          h('div',{style:{flex:1,minWidth:0,overflow:'auto',textAlign:'center',background:'#eef0f3'}},h('canvas',{ref:canvasRef,width:shot.width,height:shot.height,onPointerDown:down,onPointerMove:move,onPointerUp:up,onPointerCancel:()=>{dragRef.current=null;paint();},style:{maxWidth:'100%',height:'auto',touchAction:'none',cursor:'crosshair'}})),
          panel&&h('aside',{'aria-label':'文字提取与翻译',style:{width:'min(340px,40vw)',display:'flex',flexDirection:'column',gap:8,minHeight:0}},
            h('button',{'aria-label':'关闭文字侧栏',onClick:()=>{requestId.current++;analysisController.current?.abort();setOperation('');setPanel(false);},style:{alignSelf:'flex-end'}},'×'),h('div',{style:{display:'flex',gap:8}},h('button',{'aria-pressed':tab==='original',onClick:()=>setTab('original')},'原文'),h('button',{'aria-pressed':tab==='translated',onClick:()=>setTab('translated')},'译文'),h('select',{'aria-label':'翻译目标语言',value:target,onChange:e=>{requestId.current++;analysisController.current?.abort();setOperation('');setTarget(e.target.value);setTranslated('');}},h('option',{value:'zh-CN'},'中文'),h('option',{value:'en'},'英语'))),
            h('textarea',{'aria-label':tab==='original'?'提取的原文':'翻译结果',value:tab==='original'?original:translated,onChange:e=>{requestId.current++;analysisController.current?.abort();setOperation('');if(tab==='original'){setOriginal(e.target.value);setTranslated('');}else setTranslated(e.target.value);},placeholder:'点击“提取文字”，或在这里输入文字',style:{flex:1,minHeight:120,resize:'none',padding:10,border:'1px solid #ddd',borderRadius:8}}),
            operation&&h('small',{role:'status'},operation),h('button',{disabled:!!operation||!original.trim(),onClick:()=>void analyze('translate')},'重新翻译'),h('small',{style:{color:'#666'}},'仅将文字交给当前模型翻译'),
            h('div',{style:{display:'flex',gap:8}},h('button',{onClick:()=>void copyText(),disabled:!(tab==='original'?original:translated).trim()},'复制文字'),h('button',{onClick:()=>{if(draft===null||!addTextDraft(inputActions,draft,tab==='original'?original:translated,()=>sidRef.current===shot.sid&&generation.current===shot.token))setError('当前输入框暂不可添加，请复制文字后粘贴');},disabled:!(tab==='original'?original:translated).trim()},'添加文字草稿')))),h('small',null,'隐私内容请用实心“遮挡”。只提取编辑后的图片；添加草稿后仍由你检查并发送。')));
  }
  function apply(ctx){ctx.slots.inject('conversation.input.left',()=>ctx.slots.register({name:'conversation.input.left',id:'desktop-screenshot',order:35,inject:()=>({conversation:ctx.conversation})},ScreenshotButton));}
  return{inject:['slots','conversation'],apply,ScreenshotButton,allowedEnvironment,captureTicket,captureRequest,brokerRequest,translationPipeline,historyChange,addTextDraft,canvasImage,resultCurrent,drawMark,addScreenshotDraft};
}});
