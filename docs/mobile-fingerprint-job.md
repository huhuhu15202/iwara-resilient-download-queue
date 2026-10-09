# 手机资料库内容指纹后台任务

独立扫描器为已经完成、位于配置的视频根目录中的台账条目建立完整 SHA-256 和采样指纹。它只读取任务 JSON，只写 `mobile_media_identity`，不会调用 `SQLiteStore.load/save`，不会改台账、观看进度或真实视频。

- 数据库：配置的数据目录下的 `ledger.sqlite`
- 单个工作任务，完整 SHA-256 顺序流式读取，上限 32 MiB/s。
- 先复用 `local_file_fingerprints` 中大小及修改时间仍相同的已验证完整指纹；采样指纹统一使用 `src/mobile-library.mjs` 的版本 1 算法。
- 每个条目单独提交，SQLite `busy_timeout=5000`、FULL 同步；进程结束后可以继续扫描，不重读有效条目。
- 数据目录中的 `mobile-fingerprint.lock` 和活动 PID 防止重复启动。正式服务也读取下面的外部进度，避免另开全库扫描。
- 进度每 2 秒原子更新至配置的数据目录下的 `mobile-fingerprint-progress.json`，不含令牌或完整文件路径。
- `running=false` 且 `failed>0` 时保留失败条目；排除根目录之外的条目，不擅自搬移文件或修复台账路径。

在本地下载服务目录检查状态：

```powershell
node tools/build-mobile-fingerprints.mjs --status
```

需要从上次进度继续时：

```powershell
node tools/build-mobile-fingerprints.mjs
```

此命令在终端前台运行。隐藏后台启动使用 Windows `Start-Process -WindowStyle Hidden`，标准输出及错误日志存放 F 盘数据目录。正式启动脚本不必重复调用它。

隔离验证：

```powershell
node --test test/mobile-fingerprint-job.test.mjs
```

测试使用临时目录，验证禁止任务写入时仍能扫描、旧指纹复用、完整及采样指纹对应、断续扫描跳过已完成项、活动进程和锁防止重复启动。真实视频不参与测试。
