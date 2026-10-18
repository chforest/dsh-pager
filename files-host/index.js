import {createVideoOpener} from './native-video.mjs';
import {createFileActions} from './native-actions.mjs';
import {createHostFetch,authorizeHostOwner} from '../plugin/host-http.mjs';
export const name = 'workspace-files';
export const inject = ['webServer','connection'];
export function apply(ctx,config={}) {
  const fetcher=createHostFetch(ctx),authorizeRequest=req=>authorizeHostOwner(ctx,req);
  const opener=createVideoOpener({apiPort:()=>ctx.webServer.port,playerPath:config.playerPath,fetcher,authorizeRequest});
  ctx.effect(()=>ctx.webServer.register({kind:'exact',path:'/m/api/desktop/open-video',handler:opener.handler}),'workspace-files: local AgentPlay opener');
  const actions=createFileActions({apiPort:()=>ctx.webServer.port,playerPath:config.playerPath,codePath:config.codePath,fetcher,authorizeRequest});
  ctx.effect(()=>ctx.webServer.register({kind:'exact',path:'/m/api/desktop/file-action',handler:actions.handler}),'workspace-files: local file actions');
}
