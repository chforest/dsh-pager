# 自动任务插件

在安排任务的原聊天中执行，保留原生模型、权限和上下文。运行中或存在未完成目标时等待；结果未知不自动重放。

新安装默认数据目录为 `$DSH_HOME/extensions/tasks`，未设置 DSH_HOME 时为 `~/.dsh/extensions/tasks`。`config.dataDir` 优先。检测到旧版项目内任务库时拒绝默默创建新库，要求显式指定旧目录或手动迁移。

迁移必须先暂停任务、停用调度插件并备份完整目录，再复制到目标目录、更新配置和只读核对任务数量/状态。不要合并两份库，不要因迁移自动启用任务。发布源代码不能包含 tasks.json、历史目标、会话编号、日志或回执。

重启恢复需搭配 recovery-host；只继续同一连续目标的剩余预算。单次未知结果需人工核对。此功能不会增加发送、发布或付款授权。

测试：`node --test --test-isolation=none mobile/tasks-host/*.test.mjs`。真实 SDK 测试通过 `DSH_TEST_PROFILE` 指定安装后的 DSH profile，默认 `$DSH_HOME/profiles/web`；请使用受支持的官方 SDK。当前 HTTP/客户端集成还依赖同仓库 `mobile/plugin`，不能只复制这个目录独立运行。
