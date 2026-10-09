# Android 0.2.2：MX 有序队列交接

## 本次修改

- 原因：0.2.1 的外置播放只设置 Intent.data 和 title，没有交付播放列表，MX 只能自行猜测下一条。
- 卡片点击按当前 items 快照传入 URI 和标题，Intent.data 保持用户点击项；作者、标签、搜索、排序和当前随机推荐批次都不丢失。
- 随机播放把当前列表打乱一次后交付，不混入筛选外项目，不自动循环；取消旧版逐次从整个筛选库抽一个视频的 randomPool。
- 使用 MX 官方 `Uri[] video_list`、`String[] video_list.name`、`video_list_is_explicit`、`return_result`。所有条目通过 ClipData 授予临时读取权限；不增加应用存储权限。
- 最多 200 条 / 256 KiB 一批。私有队列快照保留完整顺序；只有 RESULT_OK、官方返回 action、playback_completion 原因、最后 URI 四者一致才自动交付下一批。返回、取消、错误、无有效结果或提前结束均停止，不无限重试。
- Activity 重建等待已启动的播放器，不重复拉起。MX 不在时保留单视频播放器选择器，不把任意播放器当作 MX 队列兼容实现。
- 原资料库、目录授权、隐藏状态、视频文件和电脑版令牌不变；没有 GitHub 上传。

## 已验证

Android 35 的隔离模拟器覆盖安装原签名 0.2.2，既有 6 个手机测试副本和扫描目录保持不变。模拟接收器运行在另一个 UID，不拥有本库的持久 SAF 授权，逐个实际打开收到的 URI，验证临时授权，而不只检查参数字符串。

1. QueueTest：实际卡片点击、点击中间项、当前列表随机顺序和不重复成员、名称对应、每项读取授权均通过。
2. 405 个唯一 URI 队列项（6 个隔离副本的查询参数别名，不是 405 个新增真实视频）按 200 / 200 / 5 分批交接，最后停止。用户退出、错误、取消不交付第二批；提前结束不跳过未播项目。
3. 队列保存/读取和实际桥接 Activity.recreate 测试通过：播放器继续存在，不重复启动，返回正常关闭。
4. 长 URI 测试确认 Parcelable Intent 不超过 256 KiB，缩小批次仍保留点击起点及所有 URI 授权；重复 URI 去重，过期点击项明确拒绝。
5. FolderTest：递归 SAF 扫描、原持久目录授权、任意改名后的 SHA-256 关联、外置播放器交接通过；扫描 504 ms。
6. UiTest：411dp 手机宽度下底栏、等高卡片、无溢出、随机批次返回状态通过。
7. ManagementTest：资料库迁移、电脑时间及播放量排序、20 次状态更新保留位置、标题两行、加密连接设置通过。
8. `node --test` 全套 124 项通过。

测试是 MX 官方协议模拟接收器的交接验证，不是用户手机上安装的 MX 的实际解码/自动下一条验证。真实 MX 的版本、内部随机/循环设置、后台播放设置可能影响行为，仍需手机实测；App 不能远程改 MX 设置。

## 安装与服务

- 私有 APK：`android/output/IwaraLocal-0.2.2.apk`，74,279 字节。
- 交付副本是本机 APK 构建产物，不纳入 Git。
- SHA-256：`b1e721923421f07ff25970e88f59a5ee4e3df744fde1600628877fc0541d44e5`。
- APK 签名证书与 0.2.1 相同；签名 v2/v3 校验通过。不要卸载旧版本，直接覆盖安装。个人 APK 内含同步令牌，不公开上传。
- 正式服务空闲时在配置的数据目录保存并校验升级快照，包含 2309 条任务。
- 使用原 `start.ps1` 重启；18777 只有一个监听服务。重启后完成 2300、失败 9、运行任务 0，令牌哈希前后一致。
- `/mobile-app.apk` 返回新 0.2.2，HTTP 200，长度和磁盘 APK 完全一致；局域网无令牌 HEAD 401、有效令牌 HEAD 200。测试模拟器及独立 ADB 服务已退出。

## 已知边界

通常长度的列表在 MX 内可上一条/下一条；超长列表向前连续跨批，上一条无法跨回已经结束的批次。点击中间项从该项向后播放，不自动绕回前面的项。App 不记录 MX 观看进度，不内置解码器，不改 MX 的设置。请先关闭 MX 自身随机和循环，用 3 个真实手机视频确认连续切换及上一条/下一条。

依据：[MX 官方 Intent 定义](https://sites.google.com/site/mxvpen/api)、[Android Intent 临时 URI 读取授权](https://developer.android.com/reference/android/content/Intent#FLAG_GRANT_READ_URI_PERMISSION)、[Android Binder 事务大小限制](https://developer.android.com/reference/android/os/TransactionTooLargeException)。
