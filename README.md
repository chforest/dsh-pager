# dsh-pager（个人分叉）

把 **DeepSeek Harness** 的会话搬到手机上：一个 DSH 插件 + 一个约 58 KB 的安卓 App。
人不在电脑前，也能看进度、发指令、在通知栏里直接批准或拒绝。

这个仓库是 [wg5759/dsh-pager](https://github.com/wg5759/dsh-pager) 的个人分叉，
上游的完整说明（功能、截图、桌面文件、语音、外部 Agent 接入等）在
[README.upstream.md](README.upstream.md)，这里只写**这个分叉改了什么、怎么装、怎么用**。

---

## 和上游的区别

| 项目 | 上游 | 这个分叉 |
|---|---|---|
| `--host` 绑定非回环地址 | 内部调用写死 `127.0.0.1`，手机提交回答一律 502，提示「家里电脑暂时连不上」 | 跟随 `ctx.webServer.host`（`plugin/host-http.mjs`、`native-responses.mjs`、`server.js`） |
| 提问卡片 | 提交后卡片可能不消失，再点报「已失效」 | 提交即收起；失败静默重试一次，仍失败才还原并保留所选 |
| 错误文案 | 上游 4xx 一律被改写成 502 | 4xx 原样透传，手机上看到主机真实原因 |
| 登录 | 只有 `?token=` 链接（WebView 没地址栏，粘不进去） | 新增 `/m/login` 登录页，贴链接换 30 天 cookie |
| 多台电脑 | 一个 App 只能连一台 | 保存多台、顶栏一键切换、后台各自保活并合并通知 |
| 安卓包 | `com.agenthub.dsh`，桌面名「DSH」 | 本分支是 `com.agenthub.dshmulti`，桌面名「DSH 多机」，可与原版并存 |
| 构建版本 | 手动改版本号 | 每次构建自动生成 versionCode（秒级时间戳）与 versionName |

分支说明：

- `main`：绑定地址修复 + `/m/login` + 使用文档
- `feat/multi-host`：以上全部 + 多机切换（App 与网页顶栏）

## 快速开始

### 1. 电脑：装插件

```bash
git clone https://github.com/chforest/dsh-pager ~/dsh-pager
git -C ~/dsh-pager checkout feat/multi-host
ln -s ~/dsh-pager/plugin ~/.dsh/profiles/web/node_modules/dsh-pager
```

在 `~/.dsh/profiles/web/cordis.patch.yml` 末尾追加（`trustedHosts` 填手机访问时用的 `host:port`）：

```yaml
- insert:
    - id: mobile
      name: 'dsh-pager'
      config:
        trustedHosts: ['47.97.159.150:3080']
```

### 2. 电脑：启动 DSH

**Linux / macOS 命令行**（macOS 桌面版安装后会自带 `/usr/local/bin/dsh`）：

```bash
dsh web --no-open --host 10.181.64.56 --port 3080 \
  --trusted-host 47.97.159.150:3080 \
  --public-url http://47.97.159.150:3080
```

关键点：`--host` 必须是**手机能访问到的那张网卡地址**，不能只写 `127.0.0.1`。
插件内部的回调会跟着这个地址走，这正是上游会报「家里电脑暂时连不上」的地方。

桌面版（`dsh-desktop`）本身**不能**被手机直连：它固定 `--host 127.0.0.1 --port 0`（随机端口），
只服务自己的 Electron 窗口。要在 Mac 上给手机用，就按上面这行另起一个 `dsh web`——
它和桌面版共用 `~/.dsh`，会话是同一份。

### 3. 手机：装 App

从本仓库 Releases 或自己构建：

```bash
cd android
# 需要 JDK 17 + Android SDK（build-tools 34.0.0 / platform android-34）
# 可在 android/local.properties 里写：
#   DSH_DEFAULT_SERVER=http://47.97.159.150:3080
#   ANDROID_SDK=/path/to/android-sdk
#   JDK_HOME=/path/to/jdk-17
bash build.sh public          # 产物：android/out/dsh-pager-v1.6.3-multi.apk
```

> 签名：`android/keystore/dsh.jks` 是首次构建时生成的，**务必保留**。
> 换钥匙后新包无法覆盖安装，只能卸载重装（会丢服务器地址和登录状态）。

首次打开会预填 `DSH_DEFAULT_SERVER`（如果构建时给了），否则让你填地址。

### 4. 登录

每台电脑第一次连都要登录一次：打开该电脑的 `/m/login`，把终端里 `dsh web` 打印的
带 `?token=` 的整条链接粘进去，换取 30 天有效的 cookie。

- token 每次重启都会变（进程内随机生成），但 **cookie 不受影响**；
- 手机 App 里未登录访问 `/m/` 会自动跳到登录页；
- 每台电脑的登录互相独立。

## 多台电脑怎么用

1. 顶栏右侧（「⋯」左边）显示当前电脑的名字；
2. 点它 → 电脑列表 → 点另一台直接切过去；最后一行「添加电脑」；
3. 只保存了一台时这个按钮自动隐藏。

后台是**每台各一条** `/m/api/notify` 长连接，所以 A 机的任务完成时，即使你正在看 B 机也会收到提醒；
通知标题在多台时会带主机名（「工作室 · 任务完成」），点开、允许/拒绝、直接回复都回到产生该通知的那台。

## 常见问题

| 现象 | 原因 | 处理 |
|---|---|---|
| 提交回答提示「家里电脑暂时连不上」 | 插件内部调用打到了没在监听的 `127.0.0.1` | 升级到本分叉；确认 `--host` 是真实网卡地址 |
| 「问题已失效或已提交」 | 这道题在 DSH 侧已经结束（默认等 120 秒） | 正常现象；要更从容就在提问时把 `timeout` 调大 |
| 点了提交没反应 | 旧版设置页脚本 bug（`var name` 撞 `window.name`） | 升级到 `1.6.3-multi.261019-105922` 之后 |
| 每次重启都要重新登录 | 一般是 cookie 没保住（换了地址 / 清了 App 数据） | 见 [绑定地址、登录与排查](docs/host-binding-and-signin.md) |
| 收不到通知 | 系统限制后台 | 允许通知、电池策略设「无限制」、允许自启动 |

## 文档

- [绑定地址、登录与红字排查](docs/host-binding-and-signin.md)
- [一台手机，多台电脑](docs/multi-host.md)
- 上游功能说明：[README.upstream.md](README.upstream.md)（语音、桌面文件、截图 OCR、Claude Code / Codex 接入、插件市场等）

## 安全

- 手机能发指令就等于能让电脑执行命令，远程通道必须有你信得过的认证；
- 别把 DSH 直接暴露到公网：明文 HTTP + 公网 IP 时，cookie 在网络上是可见的，前面应加一层带证书的反向代理；
- App 本地只存服务器地址和登录 cookie，不记内容；公开构建关闭了 WebView 远程调试。

## 许可

MIT，与上游一致。上游作者：wg5759；本分叉的改动见 git 记录。
