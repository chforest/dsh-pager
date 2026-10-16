(function(){
  'use strict';
  function createFolderModel(fetcher,onChange=()=>{},makeId=()=>crypto.randomUUID()){
    let generation=0,controller=null;
    const state={path:null,parent:null,roots:[],entries:[],workspaces:[],truncated:false,loading:false,adding:false,uncertain:false,error:'',finished:false};
    const emit=()=>onChange({...state});
    async function navigate(path=''){
      if(state.finished||state.adding)return;
      const token=++generation;controller?.abort();controller=new AbortController();state.loading=true;state.error='';emit();
      try{const response=await fetcher('/m/api/folders?path='+encodeURIComponent(path||''),{cache:'no-store',signal:controller.signal});const out=await response.json();if(!response.ok||!out.ok)throw new Error(out.error?.message||out.error||'无法读取电脑文件夹');if(token!==generation||state.finished)return;const value=out.value;Object.assign(state,{path:value.path||null,parent:value.parent||null,roots:value.roots||[],entries:value.entries||[],workspaces:value.workspaces||[],truncated:!!value.truncated});}
      catch(error){if(token===generation&&!state.finished&&error.name!=='AbortError')state.error=error.message;}
      finally{if(token===generation&&!state.finished){state.loading=false;emit();}}
    }
    async function select(){
      if(state.finished||state.adding||state.loading||state.uncertain||state.error||!state.path)return null;
      state.adding=true;state.error='';emit();let response,decoded=false;const posting=new AbortController(),timer=setTimeout(()=>posting.abort(),30000);
      try{response=await fetcher('/m/api/folders/workspace',{method:'POST',signal:posting.signal,headers:{'content-type':'application/json'},body:JSON.stringify({path:state.path,requestId:makeId()})});const out=await response.json();decoded=true;if(!response.ok||!out.ok){const error=new Error(out.error?.message||out.error||'添加工作区失败');error.uncertain=response.status>=500||out.error?.code==='outcome_unknown';throw error;}const workspace=out.value?.workspace;if(!workspace||!(workspace.id||workspace.workspaceId))throw Object.assign(new Error('未收到工作区确认，请返回列表核对'),{uncertain:true});state.finished=true;return{...workspace,id:workspace.id||workspace.workspaceId,workspaceId:workspace.workspaceId||workspace.id};}
      catch(error){state.uncertain=!!error.uncertain||!response||!decoded;state.error=state.uncertain?'添加结果尚未确认，请返回工作区列表核对；不会自动重试。':error.message;return null;}
      finally{clearTimeout(timer);state.adding=false;emit();}
    }
    function cancel(){if(state.adding)return false;state.finished=true;generation++;controller?.abort();return true;}
    return{get state(){return{...state};},navigate,select,cancel};
  }
  if(typeof module!=='undefined'&&module.exports){module.exports={createFolderModel};return;}
  let active=null;
  function choose(){
    if(active)return active;
    active=new Promise(resolve=>{
      const element=(tag,text,cls)=>{const node=document.createElement(tag);if(text!=null)node.textContent=text;if(cls)node.className=cls;return node;};
      const dialog=element('dialog',null,'dsh-folder-picker'),body=element('div',null,'dsh-folder-body'),heading=element('div',null,'dsh-folder-heading'),title=element('h2','浏览电脑文件夹'),cancel=element('button','取消');cancel.type='button';heading.append(title,cancel);
      const hint=element('p','这是电脑上的文件夹，不是手机文件。','dsh-folder-hint'),roots=element('div',null,'dsh-folder-roots'),pathRow=element('div',null,'dsh-folder-path'),up=element('button','上一级'),path=element('input'),go=element('button','前往');path.setAttribute('aria-label','电脑文件夹完整路径');path.placeholder='可输入电脑上的完整路径';up.type=go.type='button';pathRow.append(up,path,go);
      const savedTitle=element('p','已登记工作区','dsh-folder-hint'),saved=element('div',null,'dsh-folder-workspaces');
      const status=element('p',null,'dsh-folder-status');status.setAttribute('role','status');const list=element('div',null,'dsh-folder-list'),more=element('p',null,'dsh-folder-hint'),select=element('button','选用此文件夹','dsh-folder-select');select.type='button';
      body.append(heading,hint,roots,savedTitle,saved,pathRow,status,list,more,select);dialog.append(body);document.body.append(dialog);
      let done=false;
      function finish(value){if(done)return;done=true;model.cancel();dialog.close();dialog.remove();active=null;resolve(value);}
      const model=createFolderModel(fetch,state=>{
        cancel.disabled=state.adding;up.disabled=state.adding||!state.parent;go.disabled=state.adding;path.disabled=state.adding;select.disabled=state.loading||state.adding||!state.path||state.uncertain||!!state.error;
        select.textContent=state.adding?'正在确认工作区…':'选用此文件夹';if(!state.loading)path.value=state.path||'';
        status.textContent=state.error||(state.loading?'正在读取电脑文件夹…':state.path?'当前：'+state.path:'请选择磁盘或常用目录');status.setAttribute('role',state.error?'alert':'status');
        roots.replaceChildren();for(const root of state.roots){const button=element('button',root.name);button.type='button';button.disabled=state.adding;button.onclick=()=>model.navigate(root.path);roots.append(button);}
        saved.replaceChildren();savedTitle.hidden=!state.workspaces.length;saved.hidden=!state.workspaces.length;for(const workspace of state.workspaces){const button=element('button'),name=element('span',workspace.title||workspace.name||workspace.path),location=element('small',workspace.path);button.type='button';button.dataset.folderWorkspace=workspace.id||workspace.workspaceId||'';button.disabled=state.adding;button.append(name,location);button.onclick=()=>model.navigate(workspace.path);saved.append(button);}
        list.replaceChildren();for(const entry of state.entries){const button=element('button','📁 '+entry.name);button.type='button';button.disabled=state.adding;button.onclick=()=>model.navigate(entry.path);list.append(button);}
        if(!state.entries.length&&!state.loading)list.append(element('p',state.path?'此文件夹没有子文件夹，可以直接选用。':'选择一个位置开始浏览。','dsh-folder-empty'));
        more.textContent=state.truncated?'目录较多，当前仅显示部分；可输入完整路径定位。':'';
      });
      cancel.onclick=()=>{if(model.cancel())finish(null);};dialog.addEventListener('cancel',event=>{event.preventDefault();if(model.cancel())finish(null);});
      up.onclick=()=>model.navigate(model.state.parent);go.onclick=()=>model.navigate(path.value.trim());path.onkeydown=event=>{if(event.key==='Enter'){event.preventDefault();go.click();}};
      select.onclick=async()=>{const workspace=await model.select();if(workspace)finish(workspace);};
      dialog.showModal();model.navigate();
    });
    return active;
  }
  window.DSHFolderPicker={choose};
})();
