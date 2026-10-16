import {createVideoOpener} from './native-video.mjs';
export const name = 'workspace-files';
export const inject = ['webServer'];
export function apply(ctx,config={}) {
  const opener=createVideoOpener({apiPort:()=>ctx.webServer.port,playerPath:config.playerPath});
  ctx.effect(()=>ctx.webServer.register({kind:'exact',path:'/m/api/desktop/open-video',handler:opener.handler}),'workspace-files: local AgentPlay opener');
}
