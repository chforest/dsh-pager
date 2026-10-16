import path from 'node:path';import crypto from 'node:crypto';import {createRequire} from 'node:module';import {fileURLToPath,pathToFileURL} from 'node:url';import {createRunner} from './runner.mjs';
import {cliDataDir} from './user-data.mjs';
export const name='antigravity-cli';export const inject=['tools','systemPrompt'];
export async function apply(ctx,config={}){
 const require=createRequire(path.resolve(process.argv[1]));const {defineTool}=await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-tools')).href);
 const runner=createRunner({root:cliDataDir(config),...(config.executablePath?{exe:path.resolve(config.executablePath)}:{})});
 const output={schema:{type:'object',additionalProperties:true},render:(_args,value)=>[{type:'text',text:JSON.stringify(value)}]};
 ctx.tools.register(defineTool({name:'antigravity_cli_status',description:'只读检查官方Google Antigravity CLI安装和本地调用策略；不读登录令牌、不调用模型。',parameters:{},output,isConcurrencySafe:()=>true,execute:async()=>({...runner.status(),askEnabled:config.enabled===true})}));
 ctx.tools.register(defineTool({name:'antigravity_cli_ask',description:'按需让官方Google CLI分析明确提供的文本；不自动复制聊天历史。仍由DSH执行具体操作。仅用户已要求或当前任务明确需要第二意见时使用；失败不自动重试，不替换当前DeepSeek/Agnes模型。',parameters:{prompt:{type:'string',required:true,description:'完整、最小必要的分析任务和资料；不得传密码/密钥或无关聊天。'}},output,isConcurrencySafe:()=>false,execute:async(args,exec)=>{if(config.enabled!==true)return{ok:false,code:'INTEGRATION_PENDING',message:'官方接替CLI已安装，待登录与调用验收；不能使用旧Gemini个人订阅入口。'};if(!exec.agent?.session?.id||!exec.callId)return{ok:false,code:'INVALID_CALLER'};const requestId=crypto.createHash('sha256').update(exec.agent.session.id+':'+exec.callId).digest('hex');return runner.ask({prompt:args.prompt,requestId,signal:exec.signal})}}));
 ctx.systemPrompt.section({name:'official-google-cli',order:132,text:'主模型只使用DeepSeek/Agnes。Google个人Pro终端入口已迁移到官方Antigravity CLI。需要独立分析时先查antigravity_cli_status再按当前工具状态使用antigravity_cli_ask；只交付明确任务所需文本，不自动打包全部聊天、不读取/复制OAuth令牌，不把CLI包装成模型API，不开启API Key兜底；不自动循环调用或在失败后换认证绕过。CLI未验收时如实说明，不声称可用。'})
}
