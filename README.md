# Iwara Resilient Download Queue

本地 Iwara 下载队列与视频台账服务。下载解析由网页脚本完成，稳定下载、失败重试、文件校验、元数据补齐和本地播放由本服务负责。

## 功能

- 最多 3 个并发下载/元数据任务，失败记录永久保留。
- 使用 Aria2 RPC（可选 FFmpeg 兜底）下载到统一视频目录。
- 本地台账、文件缺失检查、失败重试和作者分类整理。
- 本地播放列表：每页 30 个视频；点击卡片进入独立播放器，避免列表页长期保留播放器资源。
- 独立播放器只保留当前视频和少量相邻切换项；相邻项使用静态随机帧，不在悬停时播放。

## 使用

1. 安装 Node.js 18+、Aria2（或 Motrix Next）。
2. 按本机目录修改 `src/main.mjs` 中的 `dataRoot` 和 `downloadRoot`。
3. 双击 `启动稳定下载.cmd`。
4. 打开 `http://127.0.0.1:18777/`，播放列表地址为 `http://127.0.0.1:18777/playlist`。
5. 在 Tampermonkey 中安装 `IwaraResilientQueue.user.js`，并将下载方式指向本地队列。

## 数据与隐私

下载数据库、日志和运行时状态应放在本机数据目录，不要提交到 Git。视频文件也不会随源码发布。公开发布前请检查自己的目录、代理、令牌和浏览器配置。

## 许可

`IwaraResilientQueue.user.js` 保留上游 Iwara Download Tool 的 Apache-2.0 声明；本地服务部分按仓库维护者的发布范围使用。
