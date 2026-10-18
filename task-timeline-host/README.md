# 原生任务与目标进入聊天流

独立桌面插件 `dsh-task-timeline`，空 host；需通过 bare package 注册，client inject 依赖原生 conversation 和 goal 插件。不会修改核心源码或任务状态。

读取官方 `slots.entries('conversation.input.dock')` 的 todo/goal 原注册，以同 id 更高优先级 shadow，保留原 component、inject 与 locale。使用 React portal 把原组件渲染到本会话的 `data-chat-anchor-key` 行内，随消息滚动；没有 clone DOM，也不重写原生暂停、编辑、展开操作。卸载 shadow 后原始注册重新生效。

目标依据 goal projection 的 createdAt 在原生消息时间线定位；待办依据成功 todo_write 的完整列表与当前投影匹配，绑定其 tool call。没有足够证据（原历史未加载、未知上游结构）时放到本会话聊天流顶部，明确标注“较早的任务记录”，不固定在输入区、不猜挂最新消息。加载历史后重新查找；同会话复用portal容器保留原生控件状态。此插件不是每次变更的独立历史快照，当前原生投影仍只展示一份。

测试：`node --test --test-isolation=none task-timeline-host/client.test.mjs`。单测验证关联/隔离/原组件与注入保留；实际滚动、真实原生按钮及热卸载恢复需在桌面浏览器验收，不能以单测冒充。

2026-10-17 本机Chrome真实验收：原生goal从消息历史位置随滚动移动，原位置在goal上下文注入与对应目标第一轮之间；DOM证明inFlow=true、inComposer=false，暂停/编辑/清除控件保留（未触发业务动作）。切至无目标验收会话后旧panel消失，返回原会话归位。当前会话原生todos投影为null，未冒用移动端折叠历史的6条待办作为当前状态；todo非空时的真实交互仍需另验。

随后在独立固定测试会话完成非空待办真实验收：3条completed/in_progress/pending投影matched到对应todo_write工具行，原生展开按钮可用；滚动149.65px后卡片坐标同幅移动且保持展开，inFlow=true/inComposer=false。未改变待办状态、未发送消息、未触生产目标。截图由浏览器工具显示，证据见项目验收目录todo-browser-receipt.json。
