# 安装和使用三种语音模式

本仓库 [voice-extension](../voice-extension/) 是基于社区dsh-voice-mode 0.7.23的维护版，包含可直接运行、可编辑的JavaScript源码快照及所有新增worker。它必须与本仓库dsh-pager服务端配套，单装上游npm版不包含三端持久语音消息改动。

|模式|发送|回复|
|---|---|---|
|录音转文字|结束后进入可编辑草稿，手动发送|普通对话|
|语音消息|明确发送原声，移动端支持按住/松开、取消|一条完整可回放语音，文字可展开|
|语音电话|自然停顿后提交，可静音、打断、挂断|分句朗读与字幕、保留通话记录|

所有模式使用当前DSH模型、工具及审批。手机/平板朗读时暂停采集以避免扬声器回声，不能宣传为已验证的全双工免耳机插话。电话仍受识别、模型思考、CPU合成和网络耗时影响。

## 安装

前提：Node.js22+及npm、DSH Web宿主、本仓库pager。桌面Electron需要系统Node用于原生子进程，必要时设置DSHVM_NODE。移动麦克风要求HTTPS安全上下文及用户授权；Android需使用包含RECORD_AUDIO、MODIFY_AUDIO_SETTINGS与权限桥的新版App，网页更新不能补齐旧APK权限。

从本仓库根目录执行，target必须是父目录已存在、目标尚未存在的绝对路径：

```sh
node voice-extension/install.mjs --target /absolute/path/to/new-voice-runtime
node voice-extension/install.mjs --target /absolute/path/to/new-voice-runtime --install
```

第一条预览，第二条把本地快照打包并npm安装到独立目录。Windows同样使用本机绝对路径。找不到npm时追加 `--npm-cli /absolute/path/to/npm/bin/npm-cli.js`。脚本不修改DSH profile、不重启宿主、不下载模型；禁用npm生命周期脚本，保留平台原生可选依赖。失败保留不完整目录供检查，不覆盖旧安装。

安装生成voice-plugin.example.json，插件name固定为裸包名dsh-voice-mode。voice-package-location.json另存包目录与真实主机入口作为定位证据，主机file URL不能作为插件name，否则可能仅加载服务端而无法发现dsh.client。先按下节将包链接到所用profile的node_modules，再在该profile配置加入示例对象并按正常方式启用；示例不是整个profile替换文件。只启用一个语音插件实例。不要在裸包名后拼查询字符串。启用后检查桌面输入框语音入口，不能仅凭服务端健康就认定客户端已加载。

包保留dsh-voice-mode名称及客户端导出，版本0.7.23-pager.1，private防止误发npm。schemastery3.18.4、sherpa-onnx1.13.8、sherpa-onnx-node1.13.6为固定顶层依赖；平台native可选包按上游解析。保留安装生成的package-lock.json锁定实际传递依赖，跨平台可能不同。

### 将包连接到选定profile

先确认实际使用的profile目录（例如默认DSH home下的profiles/web，桌面与Web可能不同）。备份该profile配置；若 `node_modules/dsh-voice-mode` 已存在，先停用旧实例，记录旧目录/链接目标并将旧项移到备份位置，**不要覆盖或直接删除**。保留旧包及配置即可回滚。

以下为人工检查后执行的链接命令，变量替换为自己的绝对路径。父目录 `profile/node_modules` 须已存在，链接名须不存在。安装脚本不会执行这些步骤。

Windows PowerShell（目录联接，目标为完整包目录，不是lib目录）：

```powershell
$voicePackage = 'X:\your-voice-runtime\node_modules\dsh-voice-mode'
$voiceProfile = 'X:\your-dsh-home\profiles\web'
New-Item -ItemType Junction -Path (Join-Path $voiceProfile 'node_modules\dsh-voice-mode') -Target $voicePackage
```

Linux/macOS：

```sh
ln -s /absolute/voice-runtime/node_modules/dsh-voice-mode /absolute/dsh-home/profiles/web/node_modules/dsh-voice-mode
```

链接后以裸包名启用示例配置。完整包的package.json包含 `dsh.client` 与 `./client` 导出，宿主才能同时发现主机和桌面界面。若换目标目录，先停用再更换链接；不要让运行中的profile指向已删除的runtime。

## 模型与隐私

示例使用本地VITS/fushiyu/语速1.1，可在设置里调整。首次在语音插件设置中下载/准备所选模型。模型仓库、固定文件哈希和下载源见voice-extension/lib/index.js；模型二进制及其授权不包含于本源码包，使用前核对模型许可。Zipformer/SenseVoice/VAD用于识别；电话native识别在独立子进程，不可用时保留原音回退。

VITS/Kokoro本地朗读；Edge是网络朗读，会传输待朗读文字，不可将所有引擎都称为离线。DSH模型本身仍按原配置联网。cacheDir应指向自己的模型目录；原声及回复持久文件由pager的voiceDir管理。模型、音频、设置、预览缓存是私有运行数据，不提交Git。

两插件必须同源。桌面语音依赖pager的/m/api/voice、/m/api/rpc等认证接口；移动端通过pager转发宿主/voice-mode。保留现有可信网关认证，不直接对公网暴露宿主回环端口。手机和电脑共用一个活动语音会话。

## 验证和限制

```sh
node --test --test-isolation=none voice-extension/test/*.test.mjs
```

测试覆盖安装计划不覆盖、许可证/模块齐全、已知私有路径排除和句子队列边界，不启动麦克风、下载模型或调用模型API。安装后检查/voice-mode、设置页和桌面入口，再实际测试草稿、原声消息、电话、挂断、断线和审批。不同DSH/浏览器/Android/iOS组合需复验。

电话不再把积压句子合成大段，语音消息仍整条生成。低性能机器合成可能慢于播放，不能保证无空隙；开发机历史延迟不是其他设备性能承诺。

## 来源

上游[qishuilalala/dsh-voice-mode](https://github.com/qishuilalala/dsh-voice-mode)，MIT，保留衍生自dsh-voice的版权。见[LICENSE](../voice-extension/LICENSE)和内联依赖的[THIRD_PARTY_NOTICES.md](../voice-extension/THIRD_PARTY_NOTICES.md)。新增改动按MIT提供。可编辑运行时快照无需上游TypeScript编译；来源、SHA256与改动范围见[PROVENANCE.json](../voice-extension/PROVENANCE.json)。本包不含个人配置、聊天音频、模型二进制或部署主机信息。

### 公开回归覆盖

测试使用虚构PCM、消息与时间，不依赖开发机录音或聊天记录。覆盖工具过程不朗读、只播正常最终结果、草稿不自动发送、原声保存失败不提交、挂断/静音时迟到提交取消、重复文本按requestId绑定、下一话轮不能夺取前轮回复、连续播放与停止、电话合句和steer、试听缓存边界。

源码树没有安装npm依赖时，仅host入口导入测试明确skip；其余回归照常运行。安装依赖后该测试必须执行。Windows Node24干净安装已验证host导入、浏览器ModuleLoader注册以及原生addon加载；这不是实际浏览器界面或麦克风验收。Node22、Linux与其他原生平台由对应CI/环境继续验证。
