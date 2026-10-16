# 可稍后回答的澄清问题

普通偏好和补充信息通过 `ask_user_async` 发问。默认等待60秒；无回答时返回`deferred / answered:false`，模型继续工具参数`independent_work`所述、既有授权内且不依赖答案的工作。沉默不是批准，也不会选择第一个建议选项。

手机/平板在聊天底部显示选项、自由回答和“提交回答”；首页“待补充 N”提示还有问题。桌面用原生conversation.input.dock，保留普通输入框。确认回答成功后立即移出待答区域，不再常驻“已回答”或已答历史折叠块；原始问答记录仍保留。尚未答复或送达状态不确定的卡片继续显示。

等待期间的答案直接作为工具返回；等待结束后的答案使用原生session.prompt排入原会话后续处理。持久记录answerId，重复提交不重复投递；网络或重启导致投递结果未知时保留待核对，不自动重发。

必须明确确认的审批、付费、发布、删除、权限变更和计划批准继续走原生审批/ask_user_question，不能通过超时获得同意。子代理不能直接调用此人机提问工具，应把问题交回主会话。

宿主插件`async-question-host`需要`@deepseek-ai/dsh-tools`，在DSH配置注册`dsh-async-questions`；持久目录通过mobile插件的`questionDir`配置。当前运行已热加载，无需新版APK；重新打开/更新界面即可看到卡片。存储达到限制时拒绝新增，不自动删未答问题。

代码：plugin/async-questions.js、server.js、www/app.js，async-question-host/index.js和client.js。接口：GET/POST `/m/api/async-questions`；工具创建与等待POST `/m/api/async-questions/create`。均保留Host/Origin和当前会话工作区校验。
