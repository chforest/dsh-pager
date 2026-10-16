# 社区市场固定版本补丁

这是第三方社区项目 [dshmarket](https://github.com/dsh-market/dsh-market) 的可复现补丁，不是 DeepSeek 官方插件市场。上游版本固定为 **1.66.17**，MIT 许可见本目录 `LICENSE`。

与未经修改的 npm 原包逐文件比较，本机修改仅涉及三个文件、十处替换：默认 GitHub 星标降序、分类默认展开、中文排序标签，以及仅在按收录时间排序时显示最近收录置顶行。中文简介/名称及大部分翻译是上游已有功能；不把它们冒称为本地新增。没有复制目录快照、注册库、私人配置或安装回执。

## 隔离安装

需要 Node.js 22+、npm 及联网。先查看计划，再确认执行；目标必须是不存在的新绝对目录，父目录必须已存在。

```sh
node market-extension/install.mjs --target /absolute/new-market-runtime
node market-extension/install.mjs --target /absolute/new-market-runtime --install
```

Windows 示例：`--target D:/DSH/market-runtime`（先创建 `D:/DSH`）。若 npm 不随 Node 安装，添加 `--npm-cli /absolute/npm/bin/npm-cli.js`。

安装器从 `registry.npmjs.org` 下载固定官方 npm 归档，验证固定 SHA-512 后才安装，npm 使用 `--ignore-scripts --legacy-peer-deps --omit=dev`，随后校验三个源文件的完整 SHA-256、执行精确替换并校验产物 SHA-256。任何不匹配都停止，不尝试兼容未知版本。依赖安装会生成 `package-lock.json`，请保留以固定本次依赖解析；仅市场本体归档和补丁在此锁定，不宣称第三方依赖跨日期自动解析完全一致。

已有相同官方归档时，可用 `--archive /path/dshmarket-1.66.17.tgz` 省去归档下载，但 npm 依赖仍可能联网。安装失败的隔离目录保留供检查，不覆盖旧运行目录、不自动重试。没有写入 DSH profile，也没有启动市场代码、安装市场目录中的任何社区插件。完成后按 DSH 自身插件安装方式审阅并注册目标包；不要把这里的路径误当已启用。

## 核验

```sh
node --test --test-isolation=none market-extension/patch.test.mjs
```

本地独立安装验收使用空目标目录及真实 npm 归档；结果只证明固定包安装和补丁精确复现，不表示所有社区插件安全或兼容。安装其他插件仍需用户明确选择并遵守现有权限、审批及运行中任务保护。
