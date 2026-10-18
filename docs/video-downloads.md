# 手机和平板保存视频

公开版 **1.6.1（versionCode 16）**包含本功能。通用APK不预设服务器，沿用原公开签名；本次已通过完整编译、签名、15项Java下载策略检查和原文件HTTP/HEAD/Range回归。下述华为实测为1.5.3历史结果，1.6.1尚未进行实体设备安装与下载验收。

App 1.5.3（code 14）开始，使用播放器右下角三点菜单中的“下载”。播放器自带的下载、全屏已在华为平板实测，因此不再在播放器下方重复放两个按钮。

点击后，App 从当前 DSH 服务器下载原文件，保存到系统文件管理器的 **下载 → DSH**（`Download/DSH`）。下载中有系统进度通知；写入完整并完成系统登记后才显示成功，点完成通知可打开视频。流畅预览不影响下载原片：App 下载接管会还原原文件地址。

普通浏览器保留“下载原视频”与全屏按钮，并通过controlsList隐藏原生重复项，避免浏览器下载当前压缩预览。旧App的下载按钮用于明确引导升级，不和原生无效入口并列。

旧 App 会提示更新；通过菜单里的 App 更新入口安装电脑提供的新包。页面刷新不能补上旧壳缺失的原生下载能力。下载不需要授予所有文件访问或读取整个相册权限。

实现采用 Android MediaStore Downloads 和前台 dataSync 服务。网络请求只允许配置服务器的 `/m/api/raw`，携带现有登录Cookie；拒绝所有HTTP重定向以防凭据跨站传递。失败会清理本次未完成项；恢复时仅处理本下载器记录、且仍为IS_PENDING的文件，不删除已完成视频。应用被系统强制停止或设备重启后，未完成下载需要用户重新发起。

服务端 `download=1` 返回attachment及UTF-8文件名，忽略preview参数，保留会话工作区边界、信任校验、Range和HEAD。

参考：[Android MediaStore](https://developer.android.com/training/data-storage/shared/media)、[WebView DownloadListener](https://developer.android.com/reference/android/webkit/DownloadListener)。
