# 手机、平板插件市场

这里接入的是第三方社区项目 **dshmarket**，不是 DeepSeek 官方插件市场。电脑端固定版本1.66.17的中文排序/分类补丁和隔离安装器见 [market-extension](../market-extension/README.md)，不携带社区目录快照或私人配置。安装器不会修改现有DSH profile，也不会自动安装目录中的插件。

首页右上角“插件”打开独立市场页；手机单列、平板双列。支持中文搜索、分类、GitHub星标最多、npm近30天下载最多、最新收录和名称排序。没有统一点赞数据，不把Star标成点赞。

目录与电脑共用，中文简介取目录的description.zh，缺失时明确标注；图标优先作者提供的头像。已安装清单结合market manifest与DSH runtime inventory，保留本机手工加载的插件，缺少文件的配置不冒称正在运行。

详情中确认后可“安装到电脑”；电脑任务运行中暂不安装。安装仍经现有dsh-market原生服务检查来源、并发与兼容性，不提供force绕过，不替用户接受构建脚本审批。升级、卸载留在电脑市场操作。

## 部署

静态页面位于plugin/www/market.html、market.js、market-model.js、market.css；首页链接版本随资源改动更新。通过已安装dsh-pager静态路由供给，无需APK重装。

安装回执服务位于market-host/，作为私有本地插件dsh-pager-market单独挂载web profile，inject webServer，exact路由/m/market-install。与手机插件使用同一Host/Origin检查；原生market接口仍执行其原有门禁。仅转交固定安装路径及经过校验的GitHub URL，不开放任意HTTP代理。

每次确认生成UUID，服务端排他写入receipts/<id>.json后才派发一次。网络重复请求、界面刷新或服务重载都不会再次执行同一编号；与编号不一致的来源返回409。结果不明确保持unknown并请用户核对。GET只查询回执。回执不入Git；不因浏览器断开而取消已准入的电脑安装。磁盘写入失败不宣称成功。

回归：node --test test/market.test.mjs test/market-install.test.mjs test/app.test.mjs。UI应验证分类与排序交集、安装前确认、断线后重载不重发、真实已安装状态；隔离模拟安装不能替代真实第三方插件兼容性验收。
