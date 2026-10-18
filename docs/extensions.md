# 安装完整扩展

1.6.1 的网页、Android 和桌面扩展共同发布。已验证宿主为 DeepSeek Harness `0.1.1-rc.2`、Node.js 24；基础插件支持 Node.js 22+。扩展会用宿主的 `llm`、`agents`、`tools`、`goals` 和客户端插槽，升级 DSH 前需检查兼容性。

## 保留已有安装

先备份自己的 profile 配置和数据，再更新本仓库。不要把别人的 profile、任务清单或凭据覆盖进来。任务和恢复的旧数据目录必须在原有插件的 `config.dataDir`、`config.stateFile`、`config.tasksFile` 中显式保留；新安装使用用户目录。未知派发和暂停状态不自动清除。

## 注册本仓库模块

在仓库根目录运行：

```sh
node tools/link-extensions.mjs --profile /path/to/.dsh/profiles/web --dry-run
node tools/link-extensions.mjs --profile /path/to/.dsh/profiles/web
```

Windows 可用实际 profile 路径；脚本创建目录联接，其他系统创建符号链接。它不会覆盖已有包、改 profile、装社区插件或启动任务。把打印出的 YAML 中尚未注册的模块合并进 `cordis.patch.yml`。**已有同名或同功能条目保留原 id 和 config，不再重复插入。**使用可解析的包名，不能用带 query 的绝对文件入口代替客户端包发现。

模块顺序为手机界面、恢复、自动任务、异步问题、桌面文件、截图、输入建议、聊天内任务卡片、市场安装回执、可选 Google CLI 桥。Google CLI 桥默认关闭；启用需要用户自行安装官方 CLI、登录并完成调用验证。它不把订阅转换为 API 凭据。

手机插件的 `trustedHosts` 沿用你的已认证网关或私网地址；桌面扩展不会替你开放公网。保存后按宿主方式重载插件/重启，并在 `/m/` 更新界面。重启前先处理待审批及正在进行的操作。

## 独立依赖

- [语音安装](voice.md)：安装附带的固定版本扩展及其公开依赖；ASR/TTS 模型需另行下载，不随源码/APK分发。
- [社区插件市场](plugin-market-mobile.md)：市场服务为第三方组件，需要单独安装。只有本仓库的市场页面与安装回执桥不够。
- [截图](desktop-screenshot.md)：Windows 原生截图与系统 OCR；其他平台不支持该本机截图实现。
- [文件与播放器](desktop-files.md)：电脑本机可配置已安装的播放器；不捆绑 AgentPlay。
- 微信、Windows-MCP、UFO、浏览器控制属于单独安装的第三方工具，并非本项目自带能力；本发行包不包含个人 MCP 配置、微信数据、浏览器会话或第三方程序。应按各工具官方文档及许可证安装、验证后注册进自己的 DSH。

## 验收

检查手机对话/权限/文件列表、桌面截图与灰字建议、语音三种模式、创建后暂停一个固定测试任务、异步问题晚答归属。安装成功和自动测试通过不代表你的麦克风、系统 OCR 语言、播放器及远程网关均已验收。

## 1.6.1 升级

已有安装需要补充注册 dsh-task-timeline，保留其他模块配置和私有数据目录。任务/目标卡片使用宿主原生组件；Windows文件功能首次使用会编译本地辅助程序，不捆绑第三方播放器。调度升级应在宿主空闲时重启；已归档任务如遗留已停止目标，可再次正式归档以核对清理，不手改台账、不把受阻目标标为完成。
