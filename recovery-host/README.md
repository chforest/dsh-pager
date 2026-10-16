# 普通聊天断点恢复

新安装默认状态文件为 `$DSH_HOME/extensions/recovery/recovery.json`，任务归属索引为 `$DSH_HOME/extensions/tasks/tasks.json`；DSH_HOME 未设置时使用 `~/.dsh`。可通过 `config.stateFile`、`config.tasksFile` 指向现有存储。发现旧版日志但未配置路径时停止初始化，不自行搬迁、合并或恢复旧记录。

加载顺序应先于 tasks-host。`dsh_prepare_restart` 只记录限时更新意图，不执行更新。手动停止、待审批、已完成、已出现新输入或未知派发结果不重放。同进程热更新不等于重启授权。

迁移时停用插件并保留整个状态文件；不要删除未知派发记录。将运行数据、状态、实际会话标识及日志排除在公开仓库之外。默认路径变化上线前必须为既有部署明确保留原路径。

测试：`node --test --test-isolation=none mobile/recovery-host/recovery.test.mjs`。SDK 集成测试使用 `DSH_TEST_PROFILE` 或当前用户的 `$DSH_HOME/profiles/web`，不使用固定 Windows 用户名。
