# 工作区文件查看

提供原生文件列表、媒体/文字预览与完整路径复制。访问范围由同仓库 mobile/plugin 的文件接口校验。

Windows 本机打开视频优先使用 `config.playerPath`，其次 `DSH_VIDEO_PLAYER_PATH`，最后尝试 `%ProgramFiles%/ai-player/AgentPlay/AgentPlay.exe`。路径必须是绝对路径；未安装或未配置时明确失败。不会修改系统文件关联。播放器只收到已经过工作区边界校验的文件路径，使用 `spawn` 参数数组，禁用 shell。

AgentPlay 不随此模块分发，其安装、签名和许可证须由发布者另行核实。测试用的虚构盘符只是路径转义样例，不包含用户文件。切勿发布截图、真实工作区文件或本地配置。

测试：`node --test --test-isolation=none mobile/files-host/*.test.mjs`。非 Windows 环境只验页面及策略，原生播放器须在 Windows 上单独验收。
