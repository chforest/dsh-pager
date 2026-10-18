# 安装完整扩展

1.6.2 的网页（含 iPhone / iPad 主屏幕 Web App）、Android 和桌面扩展（Windows 与 macOS）共同发布。已验证宿主为 DeepSeek Harness `0.1.1-rc.2`、Node.js 24；基础插件支持 Node.js 22+。扩展会用宿主的 `llm`、`agents`、`tools`、`goals` 和客户端插槽，升级 DSH 前需检查兼容性。

## 保留已有安装

先备份自己的 profile 配置和数据，再更新本仓库。不要把别人的 profile、任务清单或凭据覆盖进来。任务和恢复的旧数据目录必须在原有插件的 `config.dataDir`、`config.stateFile`、`config.tasksFile` 中显式保留；新安装使用用户目录。未知派发和暂停状态不自动清除。

## 注册本仓库模块

在仓库根目录运行：

```sh
node tools/link-extensions.mjs --profile /path/to/.dsh/profiles/web --dry-run
node tools/link-extensions.mjs --profile /path/to/.dsh/profiles/web
```

Windows 可用实际 profile 路径；脚本创建目录联接，macOS / Linux 创建符号链接。它不会覆盖已有包、改 profile、装社区插件或启动任务。把打印出的 YAML 中尚未注册的模块合并进 `cordis.patch.yml`。**已有同名或同功能条目保留原 id 和 config，不再重复插入。**使用可解析的包名，不能用带 query 的绝对文件入口代替客户端包发现。若希望桌面端在 Agent 运行时按回车同样进入“修改 / 引导 / 等待”三选一队列栏，可将 `chat.preferences.busyEnter` 设为 `queue`。

模块顺序为手机界面、恢复、自动任务、异步问题、桌面文件、截图、输入建议、聊天内任务卡片、市场安装回执、可选 Google CLI 桥。Google CLI 桥默认关闭；启用需要用户自行安装官方 CLI、登录并完成调用验证。它不把订阅转换为 API 凭据。

手机插件的 `trustedHosts` 沿用你的已认证网关或私网地址；桌面扩展不会替你开放公网。保存后按宿主方式重载插件/重启，并在 `/m/` 更新界面。重启前先处理待审批及正在进行的操作。

## 独立依赖

- [语音安装](voice.md)：安装附带的固定版本扩展及其公开依赖；ASR/TTS 模型需另行下载，不随源码/APK分发（支持 Windows 与 macOS `afplay` / `AVAudioEngine` / `sox`）。
- [社区插件市场](plugin-market-mobile.md)：市场服务为第三方组件，需要单独安装。只有本仓库的市场页面与安装回执桥不够。
- [截图](desktop-screenshot.md)：Windows 原生截图 + `Windows.Media.Ocr` 与 macOS `screencapture -i -r` + `Vision.framework` 系统 OCR。
- [文件与播放器](desktop-files.md)：电脑本机可配置已安装的播放器（Windows 或 macOS `open` / `IINA` / `QuickTime Player`）；不捆绑第三方播放器。
- 微信、Windows-MCP、UFO、浏览器控制属于单独安装的第三方工具，并非本项目自带能力；本发行包不包含个人 MCP 配置、微信数据、浏览器会话或第三方程序。应按各工具官方文档及许可证安装、验证后注册进自己的 DSH。

## 验收

检查手机对话/权限/文件列表、运行中插话三选一（修改 / 引导 / 等待）、桌面截图与灰字建议、语音三种模式、创建后暂停一个固定测试任务、异步问题晚答归属。安装成功和自动测试通过不代表你的麦克风、系统 OCR 语言、播放器及远程网关均已验收。

## 1.6.2 升级

1.6.2 新增 macOS 宿主（`darwin`）全套原生能力适配（截图与 Vision OCR、Finder 文件操作与另存为、磁盘/目录远程浏览、语音通话麦克风采集与播报、Electron `.app` 宿主模块解析）以及运行中队列栏“修改 / 引导 / 等待”三项显式选择。已有安装拉取更新后重启宿主并在手机端刷新界面即可。
