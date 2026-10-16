# 官方 CLI 按需分析桥

默认关闭调用，只有 `config.enabled: true` 才能启动。不会分发 Google CLI 程序、OAuth 文件或认证令牌，不设置 API Key 兜底。

程序路径使用 `config.executablePath`，其次 `DSH_ANTIGRAVITY_CLI_PATH`，再查找 PATH 中的 `agy.exe`（Windows）或 `agy`。不会自动下载程序或启动 shell。发布前应独立核对官方安装渠道、CLI 版本、订阅可用性与条款；这些不是此插件授予的权限。

回执默认保存在 `$DSH_HOME/extensions/antigravity-cli`（未设置 DSH_HOME 时用 `~/.dsh`），`config.dataDir` 优先。检测到包内旧回执时要求明确保留旧路径或停机后迁移，不丢弃未知结果的去重记录。认证目录仍由官方 CLI 管理，本插件不迁移它。

仅传本次任务明确需要的最少文本。调用可能消耗用户订阅额度，必须按当前授权使用；失败或结果未知不自动重试。`data/`、`.test-output/`、prompt、stdout、回执及认证文件不能上传公共仓库。

测试：`node --test --test-isolation=none mobile/antigravity-cli-host/runner.test.mjs`，使用模拟子进程，不发模型请求。实际 CLI 的安装、登录、plan 模式与输出协议必须单独验收。
