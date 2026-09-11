# Iwara Resilient Download Queue

本地 Iwara 下载队列与视频台账服务。下载解析由网页脚本完成，稳定下载、失败重试、文件校验、元数据补齐和本地播放由本服务负责。

## 功能

- 最多 3 个并发下载/元数据任务，失败记录永久保留。
- 使用 Aria2 RPC（可选 FFmpeg 兜底）下载到统一视频目录。
- 本地台账、文件缺失检查、失败重试和作者分类整理。
- 本地播放列表：每页 30 个视频；点击卡片进入独立播放器，避免列表页长期保留播放器资源。
- 独立播放器只保留当前视频和少量相邻切换项；相邻项使用静态随机帧，不在悬停时播放。

## 使用

1. 安装 Node.js >= 22.13.0（推荐当前 Node.js 24 LTS）、Aria2（或 Motrix Next）。`node:sqlite` 在 Node 22.5.0 才加入，Node 22.13.0 起无需实验参数。
2. 复制 `config.example.json` 为程序目录下的 `config.json`，按本机目录填写 `dataRoot`、`downloadRoot` 和 `enginePath`；也可以使用 `IWARA_DATA_ROOT`、`IWARA_DOWNLOAD_ROOT`、`IWARA_ENGINE_PATH` 环境变量覆盖。无需修改源码。
3. 双击 `启动稳定下载.cmd`。启动脚本会拒绝低于 Node 22.13.0 的运行时。
4. 打开 `http://127.0.0.1:18777/`，播放列表地址为 `http://127.0.0.1:18777/playlist`。
5. 在 Tampermonkey 中安装 `IwaraResilientQueue.user.js`，并将下载方式指向本地队列。

## 测试

`npm test` 会运行状态机、失败分类、媒体格式和文件移动测试；`npm run test:engine` 会实际创建 SQLite 数据库并验证每日 backup 流程。

## 数据与隐私

下载数据库、日志和运行时状态应放在本机数据目录，不要提交到 Git。视频文件也不会随源码发布。公开发布前请检查自己的目录、代理、令牌和浏览器配置。

支持导入并校验 `.mp4`、`.webm`、`.mkv`、`.mov`、`.avi` 和 `.m4v`；本地媒体接口会根据实际扩展名返回对应 MIME 类型。

## 许可

`IwaraResilientQueue.user.js` 保留上游 Iwara Download Tool 的 Apache-2.0 声明；本地服务部分按仓库维护者的发布范围使用。
