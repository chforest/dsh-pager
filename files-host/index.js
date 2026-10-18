import {createVideoOpener} from './native-video.mjs';
import {createFileActions} from './native-actions.mjs';
export const name = 'workspace-files';
export const inject = ['webServer'];
export function apply(ctx,config={}) {
  const opener=createVideoOpener({apiPort:()=>ctx.webServer.port,playerPath:config.playerPath});
  ctx.effect(()=>ctx.webServer.register({kind:'exact',path:'/m/api/desktop/open-video',handler:opener.handler}),'workspace-files: local AgentPlay opener');
  const actions=createFileActions({apiPort:()=>ctx.webServer.port,playerPath:config.playerPath,codePath:config.codePath});
  ctx.effect(()=>ctx.webServer.register({kind:'exact',path:'/m/api/desktop/file-action',handler:actions.handler}),'workspace-files: local file actions');
}
