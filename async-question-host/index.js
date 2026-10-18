import crypto from 'node:crypto'
import {createRequire} from 'node:module'
import path from 'node:path'
import {pathToFileURL} from 'node:url'
import {nativeHostDependencies} from '../plugin/host-compat.mjs'
import {createHostFetch} from '../plugin/host-http.mjs'

export const name = 'async-questions'
export const inject = [...new Set(['tools', 'systemPrompt', 'webServer',...nativeHostDependencies()])]
export const guidance = `普通偏好、样式选择、可稍后补充的信息，优先使用 ask_user_async。该工具等待用户最多60秒；超时返回deferred/answered:false，表示用户尚未回答，绝非同意任何方案。收到deferred后主动继续independent_work所述且既有授权内、不依赖答案的工作，不要重复提问或不断调用等待工具。问题持续保留，用户稍后回答会作为原会话的新消息送达；结合当前进度调整，不重做完成的动作。必要的安全、付费、发布、删除、权限或方案批准，以及缺失答案就无法安全推进的事项，仍用原生ask_user_question及审批机制，不得用本工具绕过。不要把界面里默认选项当成用户回答。`
export async function apply(ctx) {
  const fromHost={resolve:spec=>{for(const c of [process.argv[1]&&!process.argv[1].startsWith('-')?path.resolve(process.argv[1]):null,import.meta.url,'/Applications/DeepSeek Harness.app/Contents/Resources/app.asar/package.json'].filter(Boolean)){try{return createRequire(c).resolve(spec)}catch{}}return createRequire(import.meta.url).resolve(spec)}}
  const {defineTool}=await import(pathToFileURL(fromHost.resolve('@deepseek-ai/dsh-tools')).href)
  const hostFetch=createHostFetch(ctx)
  ctx.systemPrompt.section({ name: 'async-clarification-workflow', order: 110, text: guidance })
  ctx.tools.register(defineTool({
    name: 'ask_user_async',
    description: '向用户提出可稍后回答的普通澄清/偏好问题，最多等待60秒。超时明确返回未回答，继续不依赖答案的工作；问题保留，稍后答案回原会话。不得用于授权、审批、付款、发布、删除或必须得到答案的操作。',
    parameters: {
      question: { type: 'string', required: true, description: '简短、可独立理解的问题，仅普通澄清或偏好。' },
      options: { type: 'array', items: { type: 'string' }, description: '可选2至3个简短建议选项；用户也可自由回答，不自动选择。' },
      independent_work: { type: 'string', required: true, description: '若60秒没回答，接下来能做哪些既有授权内、不依赖答案的具体工作；必须有真实可继续的工作。' },
    },
    timeoutMs: 90000,
    isConcurrencySafe: () => false,
    output: { schema: { type: 'object', additionalProperties: true }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
    async execute(args, exec) {
      const agents = ctx.get('agents')
      if (!exec.agent || !agents || agents.get(exec.agent.id) !== exec.agent || !agents.roots().includes(exec.agent)) throw new Error('只有当前存活的主会话可以向用户提问；子任务应将问题交回主会话')
      const sid = exec.agent?.session?.id || exec.agent?.id
      if (typeof sid !== 'string' || !sid.startsWith('session-')) throw new Error('异步问题必须属于当前DSH会话')
      const digest = crypto.createHash('sha256').update(sid + ':' + (exec.callId || crypto.randomUUID())).digest('hex')
      const requestId = `${digest.slice(0,8)}-${digest.slice(8,12)}-4${digest.slice(13,16)}-a${digest.slice(17,20)}-${digest.slice(20,32)}`
      const response = await hostFetch(`http://127.0.0.1:${ctx.webServer.port}/m/api/async-questions/create`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ s: sid, kind: 'clarification', question: args.question, options: args.options || [], independentWork: args.independent_work, requestId }),
        signal: exec.signal ? AbortSignal.any([exec.signal, AbortSignal.timeout(80000)]) : AbortSignal.timeout(80000),
      })
      const out = await response.json()
      if (!response.ok || !out.ok) throw new Error(out.error?.message || '提问失败；请检查待回答列表，勿盲目重发')
      return out.value
    },
  }))
}
