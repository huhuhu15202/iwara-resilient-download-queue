import {
  access, copyFile, mkdir, open, readFile, rename, rm, stat, unlink
} from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";

function nowIso() {
  return new Date().toISOString();
}

function safeSegment(value, fallback = "video.mp4") {
  const cleaned = String(value || fallback)
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_")
    .replace(/[. ]+$/g, "")
    .slice(0, 180);
  return cleaned || fallback;
}

function safeFolderName(value) {
  const input = String(value || "").trim();
  const cleaned = safeSegment(input, "").slice(0, 80);
  if (!input || cleaned !== input || input === "." || input === "..") {
    throw new Error(`分类目录名无效：${input || "空白"}`);
  }
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(input)) {
    throw new Error(`分类目录名是 Windows 保留名称：${input}`);
  }
  return cleaned;
}

function publicTask(task) {
  const { resolved, leaseId, metadataLeaseId, stagingFile, gid, ...safe } = task;
  return safe;
}

function sourceHost(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return "";
  }
}

function normalizeMediaType(value, url = "") {
  const explicit = String(value || "").toLowerCase();
  const pathname = (() => {
    try { return new URL(url).pathname.toLowerCase(); } catch { return String(url || "").toLowerCase(); }
  })();
  if (explicit === "hls" || /mpegurl/.test(explicit) || pathname.endsWith(".m3u8")) return "hls";
  if (explicit === "dash" || /dash/.test(explicit) || pathname.endsWith(".mpd")) return "dash";
  return "direct";
}

function isIwaraWatchPage(url) {
  try {
    const parsed = new URL(url);
    return /(^|\.)iwara\.(tv|zip|shop|ai)$/i.test(parsed.hostname) && /^\/video\/[^/]+\/?$/i.test(parsed.pathname);
  } catch {
    return false;
  }
}

function sanitizeForwardHeaders(headers = {}) {
  const safe = {};
  for (const [name, value] of Object.entries(headers || {})) {
    const headerName = String(name || "").trim();
    const headerValue = String(value || "").replace(/[\r\n]+/g, " ").trim();
    if (!headerName || !headerValue || !/^[A-Za-z0-9-]+$/.test(headerName)) continue;
    if (/^(host|content-length)$/i.test(headerName)) continue;
    safe[headerName] = headerValue;
  }
  return safe;
}

export function classifyError(message) {
  const text = String(message || "").toLowerCase();
  if (/80090322|sec_e_wrong_principal|wrong principal|target principal|目标主要名称|hostname mismatch|certificate.*(?:host|name)|sni/.test(text)) return "tls_certificate";
  if (/80090326|sec_e_illegal_message|ssl|tls|handshake|schannel|握手/.test(text)) return "tls_handshake";
  if (/\b404\b|not found|不存在|deleted/.test(text)) return "not_found";
  if (/\b403\b|forbidden|expired|过期/.test(text)) return "access_or_expired";
  if (/timeout|timed out|超时|无进度/.test(text)) return "timeout";
  if (/network|fetch|connect|socket|网络/.test(text)) return "network";
  if (/private|permission|unauthorized|权限|登录/.test(text)) return "permission";
  if (/所有可用 cdn 源均已失败|all available cdn/.test(text)) return "source_exhausted";
  if (/quality|source|画质|视频源/.test(text)) return "source_unavailable";
  return "unknown";
}

function aria2FailureMessage(status) {
  const detail = String(status?.errorMessage || "").trim();
  const code = String(status?.errorCode || "").trim();
  if (detail && code && !detail.includes(code)) return `${detail}（aria2 错误码 ${code}）`;
  return detail || (code ? `aria2 错误码 ${code}` : `aria2 状态: ${status?.status || "error"}`);
}

async function fileInfo(filePath) {
  try {
    return await stat(filePath);
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

async function mediaFileValidation(filePath, expectedLength, minimumBytes) {
  const info = await fileInfo(filePath);
  if (!info) return { ok: false, status: "missing", message: "下载文件不存在" };
  const minimum = Math.max(1024, Number(minimumBytes) || 65536);
  if (info.size < minimum) {
    return { ok: false, status: "too_small", message: `下载文件只有 ${info.size} B，疑似 CDN 错误页或空文件` };
  }
  const expected = Number(expectedLength || 0);
  if (Number.isFinite(expected) && expected >= minimum && info.size !== expected) {
    return { ok: false, status: "size_mismatch", message: `下载文件大小 ${info.size} B 与预期 ${expected} B 不一致` };
  }
  const handle = await open(filePath, "r");
  try {
    const head = Buffer.alloc(32);
    const { bytesRead } = await handle.read(head, 0, head.length, 0);
    const isMp4 = bytesRead >= 8 && head.subarray(4, 8).toString("ascii") === "ftyp";
    const isWebm = bytesRead >= 4 && head.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]));
    if (!isMp4 && !isWebm) {
      return { ok: false, status: "not_media", message: "下载结果不是有效 MP4/WebM 媒体文件，疑似 CDN 错误页" };
    }
  } finally {
    await handle.close();
  }
  return { ok: true, status: "present", size: info.size };
}

export async function moveFileSafely(source, destination, taskId, operations = {}) {
  const renameFile = operations.rename || rename;
  const copy = operations.copyFile || copyFile;
  const openFile = operations.open || open;
  const removeFile = operations.unlink || unlink;
  try {
    await renameFile(source, destination);
    return;
  } catch (error) {
    if (error.code !== "EXDEV") throw error;
  }
  const temporaryDestination = `${destination}.iwara-${taskId}.part`;
  await copy(source, temporaryDestination);
  const handle = await openFile(temporaryDestination, "r+");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
  await renameFile(temporaryDestination, destination);
  await removeFile(source);
}

async function availableDestination(requested) {
  try {
    await access(requested);
  } catch {
    return requested;
  }
  const parsed = path.parse(requested);
  for (let index = 1; index < 10000; index += 1) {
    const candidate = path.join(parsed.dir, `${parsed.name} (${index})${parsed.ext}`);
    try {
      await access(candidate);
    } catch {
      return candidate;
    }
  }
  throw new Error(`无法为 ${requested} 生成不重复的文件名`);
}

export class Scheduler {
  constructor({ store, aria2, ffmpeg = null, config, clock = Date }) {
    this.store = store;
    this.aria2 = aria2;
    this.ffmpeg = ffmpeg;
    this.config = config;
    this.clock = clock;
    this.timer = null;
    this.busy = false;
  }

  async init() {
    if (!this.store.loaded) await this.store.load();
    const knownGids = new Set(this.store.state.tasks.map(task => task.gid).filter(Boolean));
    try {
      for (const status of await this.aria2.listStatuses()) {
        if (!knownGids.has(status.gid)) await this.aria2.forget(status.gid);
      }
    } catch {
      // The scheduler can still reconcile known tasks individually.
    }
    for (const task of this.store.state.tasks) {
      task.sourcePage = `https://www.iwara.tv/video/${task.videoId}`;
      task.browserFallbackPending ??= false;
      task.browserFallbackAttempted ??= false;
      task.downloadEngine ??= task.gid ? "aria2" : null;
      if (task.classificationMove) {
        const { source, destination, folder } = task.classificationMove;
        const [sourceInfo, destinationInfo] = await Promise.all([
          fileInfo(source), fileInfo(destination)
        ]);
        if (destinationInfo && !sourceInfo) {
          task.destination = destination;
          task.categoryFolder = folder;
          task.classificationMove = null;
          task.message = `服务重启，已确认归入 ${folder}`;
        } else if (sourceInfo && !destinationInfo) {
          task.classificationMove = null;
          task.message = "服务重启，作者分类移动尚未执行";
        } else if (sourceInfo && destinationInfo) {
          task.classificationMove = null;
          task.message = "作者分类发现源文件和目标文件同时存在，已保留两者待人工检查";
        } else {
          task.classificationMove = null;
          task.message = "作者分类移动未完成，文件位置需要检查";
        }
      }
      if ((!task.title || !task.author) && task.destination) {
        try {
          const metadataPath = task.destination.replace(/\.[^.]+$/, "") + ".json";
          const metadata = JSON.parse(await readFile(metadataPath, "utf8"));
          task.title ||= metadata.Title || "";
          task.author ||= metadata.Author || "";
          task.alias ||= metadata.Alias || "";
          task.uploadTime ||= metadata.UploadTime || null;
          task.viewCount ??= metadata.Views ?? metadata.viewCount ?? metadata.views ?? null;
        } catch {
          // Older records may not have a sidecar metadata file.
        }
      }
      if (task.imported || task.viewCountRequested) {
        // A view-count sync is an explicit queue request.  Keep it pending
        // across service restarts even when author/date are already present.
        if (task.viewCountRequested && task.viewCount == null && task.metadataStatus === "failed") {
          // Preserve a terminal view-sync failure for the ledger/report.
          task.metadataMessage ||= "播放量同步失败；保留原文件和记录";
        } else if (task.viewCountRequested && task.viewCount == null && ["pending", "retry", "enriching"].includes(task.metadataStatus)) {
          if (task.metadataStatus === "enriching") {
            task.metadataStatus = "pending";
            task.metadataLeaseId = null;
            task.metadataLeaseExpiresAt = null;
            task.metadataNextRunAt = 0;
            task.metadataMessage = "服务重启，等待同步播放量";
          }
        } else if (task.viewCountRequested && task.viewCount == null && task.metadataStatus === "complete") {
          // Older service versions could clear the failed state on restart.
          // A requested sync with no view count is not a successful sync.
          task.metadataStatus = "failed";
          task.metadataMessage = "播放量接口未找到该视频；保留原文件和记录";
        } else if (task.author && task.uploadTime) {
          task.metadataStatus = "complete";
          task.metadataMessage = task.viewCount == null ? "作者和上传日期已齐全" : "作者、日期和播放量已齐全";
        } else if (task.metadataStatus === "enriching") {
          task.metadataStatus = "pending";
          task.metadataLeaseId = null;
          task.metadataLeaseExpiresAt = null;
          task.metadataNextRunAt = 0;
          task.metadataMessage = "服务重启，等待重新补齐";
        } else if (!task.metadataStatus) {
          task.metadataStatus = "pending";
          task.metadataAttempts = 0;
          task.metadataNextRunAt = 0;
          task.metadataMessage = "等待补齐作者和上传日期";
        }
        task.metadataLeaseId ||= null;
        task.metadataLeaseExpiresAt ||= null;
      }
      if (task.state === "completed") {
        await this.verifyCompletedTask(task);
        continue;
      }
      if (task.state === "finalizing") {
        await this.recoverFinalizing(task);
        continue;
      }
      if (task.state === "resolving") {
        const wasSniffing = task.resolveMode === "browser_sniff";
        task.state = "queued";
        task.leaseId = null;
        task.resolveMode = null;
        if (wasSniffing) {
          task.browserFallbackPending = true;
          task.browserFallbackAttempted = false;
          task.message = "服务重启，等待重新进行网页嗅探";
        } else {
          task.message = "服务重启，等待重新解析";
        }
        task.nextRunAt = 0;
        continue;
      }
      if (task.state === "downloading") {
        if (task.downloadEngine === "ffmpeg") {
          task.state = "queued";
          task.gid = null;
          task.ffmpegPid = null;
          task.downloadEngine = null;
          task.resolved = null;
          task.browserFallbackPending = true;
          task.browserFallbackAttempted = false;
          task.message = "服务重启，FFmpeg 媒体流重新进行网页嗅探";
          task.nextRunAt = 0;
          await this.cleanupTaskStaging(task);
          continue;
        }
        try {
          const status = await this.aria2.tellStatus(task.gid);
          if (status.status === "complete") await this.complete(task);
          else if (status.status === "error" || status.status === "removed") {
            await this.failDownload(task, aria2FailureMessage(status));
          } else {
            task.message = "服务重启，已接管原下载";
            task.lastProgressAt = this.clock.now();
          }
        } catch {
          task.state = "queued";
          task.gid = null;
          task.leaseId = null;
          task.downloadEngine = null;
          task.resolved = null;
          task.message = "原下载内核任务不存在，等待重新解析";
          task.nextRunAt = 0;
          await this.cleanupTaskStaging(task);
        }
      }
    }
    await this.store.save();
  }

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => this.tick().catch(console.error), this.config.pollMs);
    this.timer.unref?.();
  }

  stop() {
    clearInterval(this.timer);
    this.timer = null;
  }

  maxConcurrentTasks() {
    return Math.max(1, Number(this.config.maxConcurrentTasks || 1));
  }

  activeTaskCount() {
    return this.store.state.tasks.filter(task =>
      ["resolving", "downloading", "finalizing"].includes(task.state)
    ).length + this.store.state.tasks.filter(task => task.metadataStatus === "enriching").length;
  }

  async enqueue(items) {
    const accepted = [];
    const ignored = [];
    for (const item of items) {
      const videoId = String(item.videoId || "").trim();
      if (!/^[A-Za-z0-9_-]{3,128}$/.test(videoId)) {
        ignored.push({ videoId, reason: "invalid videoId" });
        continue;
      }
      const duplicate = this.store.state.tasks.find(task => task.videoId === videoId);
      if (duplicate) {
        ignored.push({
          videoId,
          reason: `already recorded: ${duplicate.state}`,
          state: duplicate.state,
          taskId: duplicate.id
        });
        continue;
      }
      const task = {
        id: randomUUID(),
        videoId,
        sourcePage: `https://www.iwara.tv/video/${videoId}`,
        state: "queued",
        attempts: 0,
        resolveFailures: 0,
        nextRunAt: 0,
        createdAt: nowIso(),
        updatedAt: nowIso(),
        message: "等待浏览器解析",
        gid: null,
        downloadEngine: null,
        browserFallbackPending: false,
        browserFallbackAttempted: false
      };
      this.store.state.tasks.push(task);
      accepted.push(publicTask(task));
    }
    await this.store.save();
    return { accepted, ignored };
  }

  async leaseNext() {
    if (this.activeTaskCount() >= this.maxConcurrentTasks()) return null;
    const now = this.clock.now();
    const task = this.store.state.tasks.find(
      item => item.state === "queued" && (item.nextRunAt || 0) <= now
    );
    if (!task) return null;
    const mode = task.browserFallbackPending ? "browser_sniff" : "api";
    task.state = "resolving";
    task.resolveMode = mode;
    task.leaseId = randomUUID();
    task.leaseExpiresAt = now + (mode === "browser_sniff"
      ? Math.max(this.config.leaseMs, (this.config.browserFallbackTimeoutMs || 45_000) + 30_000)
      : this.config.leaseMs);
    if (mode === "browser_sniff") {
      task.browserFallbackPending = false;
      task.browserFallbackAttempted = true;
      task.message = "普通 CDN 已耗尽，正在用真实网页播放嗅探媒体地址";
    } else {
      task.message = `第 ${task.attempts + 1} 次解析`;
    }
    task.updatedAt = nowIso();
    await this.store.save();
    return {
      taskId: task.id,
      leaseId: task.leaseId,
      videoId: task.videoId,
      sourcePage: task.sourcePage,
      mode,
      attempt: task.attempts + 1,
      sniffTimeoutMs: this.config.browserFallbackTimeoutMs || 45_000,
      avoidHosts: mode === "api" ? (this.store.failedSourceHosts?.(task.id) || []) : []
    };
  }

  async submitResolution({ taskId, leaseId, ok, video, error, partialMetadata }) {
    const task = this.store.state.tasks.find(item => item.id === taskId);
    if (!task || task.state !== "resolving" || task.leaseId !== leaseId) {
      throw new Error("解析租约无效或已过期");
    }
    const resolveMode = task.resolveMode || "api";
    task.leaseId = null;
    task.resolveMode = null;
    if (partialMetadata) {
      task.title = partialMetadata.Title || partialMetadata.title || task.title || task.videoId;
      task.author = partialMetadata.Author || partialMetadata.author || task.author || "";
      task.alias = partialMetadata.Alias || partialMetadata.alias || task.alias || "";
      task.uploadTime = partialMetadata.UploadTime || partialMetadata.uploadTime || task.uploadTime || null;
    }
    if (!ok || !video?.url) {
      task.resolveFailures += 1;
      const message = error || (resolveMode === "browser_sniff" ? "网页嗅探失败" : "浏览器解析失败");
      const category = classifyError(message);
      task.lastErrorCategory = category;
      this.store.recordAttempt?.(task, {
        phase: resolveMode === "browser_sniff" ? "browser_sniff" : "resolve",
        outcome: "failure", category, message
      });
      // 页面明确返回 403/私人视频或不存在时，继续重试没有意义；
      // 终止并保留台账，让用户可以清楚区分权限/页面问题与临时 CDN 故障。
      if (category === "access_or_expired" || category === "page_not_found") {
        task.state = "failed";
        task.browserFallbackPending = false;
        task.browserFallbackAttempted = true;
        task.message = `${message}；已确认无法下载，停止重试`;
        task.updatedAt = nowIso();
        await this.store.save();
        return publicTask(task);
      }
      // 连续多次仅得到无媒体源（例如页面只有 YouTube 嵌入）时，
      // 视为当前账号/页面无法提供 Iwara Source，停止无意义的无限重试。
      // 网络/CDN 类错误仍按原策略重试。
      if (category === "source_unavailable" && (task.attempts >= 4 || task.resolveFailures >= 20)) {
        task.state = "failed";
        task.browserFallbackPending = false;
        task.browserFallbackAttempted = true;
        task.message = `${message}；已连续多次无可用 Source，停止重试`;
        task.updatedAt = nowIso();
        await this.store.save();
        return publicTask(task);
      }
      return this.retryOrFail(task, message, false, {
        fallbackFailure: resolveMode === "browser_sniff",
        forceFallback: resolveMode !== "browser_sniff" && category === "source_exhausted"
      });
    }

    if (resolveMode === "browser_sniff" && isIwaraWatchPage(video.url)) {
      const message = "网页嗅探捕获到的是 Iwara 视频页面，不是实际媒体地址";
      task.lastErrorCategory = "source_unavailable";
      this.store.recordAttempt?.(task, {
        phase: "browser_sniff", outcome: "failure", category: "source_unavailable", message
      });
      if (task.attempts >= 4 || task.resolveFailures >= 20) {
        task.state = "failed";
        task.browserFallbackPending = false;
        task.browserFallbackAttempted = true;
        task.message = `${message}；已连续多次无可用 Source，停止重试`;
        task.updatedAt = nowIso();
        await this.store.save();
        return publicTask(task);
      }
      return this.retryOrFail(task, message, false, { fallbackFailure: true });
    }

    task.attempts += 1;
    task.title = video.metadata?.Title || video.title || task.title || task.videoId;
    task.author = video.metadata?.Author || task.author || "";
    task.alias = video.metadata?.Alias || task.alias || "";
    task.uploadTime = video.metadata?.UploadTime || task.uploadTime || null;
    task.viewCount ??= video.metadata?.Views ?? video.metadata?.viewCount ?? video.metadata?.views ?? null;
    const requestedFile = video.fileName || video.relativePath || task.preferredRelativePath || `${task.videoId}.mp4`;
    const forwardHeaders = sanitizeForwardHeaders(video.headers || {});
    if (video.referer && !forwardHeaders.Referer) forwardHeaders.Referer = video.referer;
    if (video.userAgent && !forwardHeaders["User-Agent"]) forwardHeaders["User-Agent"] = video.userAgent;
    task.resolved = {
      url: video.url,
      title: video.title || task.title || task.videoId,
      relativePath: safeSegment(path.basename(requestedFile.replaceAll("\\", "/"))),
      metadata: video.metadata || null,
      referer: video.referer || task.sourcePage || "",
      userAgent: video.userAgent || "",
      headers: forwardHeaders,
      mediaType: normalizeMediaType(video.mediaType, video.url),
      resolveMode
    };
    task.preferredRelativePath = task.resolved.relativePath;
    task.sourceHost = sourceHost(task.resolved.url);
    return this.startResolvedDownload(task);
  }

  async startResolvedDownload(task) {
    const attemptDir = path.join(this.config.stagingRoot, task.id, String(task.attempts));
    await mkdir(attemptDir, { recursive: true });
    let outputName = safeSegment(path.basename(task.resolved.relativePath));
    if (["hls", "dash"].includes(task.resolved.mediaType) && !/\.mp4$/i.test(outputName)) {
      outputName = `${path.parse(outputName).name}.mp4`;
      task.resolved.relativePath = outputName;
      task.preferredRelativePath = outputName;
    }
    task.stagingFile = path.join(attemptDir, outputName);
    try {
      if (["hls", "dash"].includes(task.resolved.mediaType)) {
        if (!this.ffmpeg) throw new Error("FFmpeg 下载器未初始化");
        const started = await this.ffmpeg.start({
          taskId: task.id,
          url: task.resolved.url,
          headers: task.resolved.headers,
          outputPath: task.stagingFile
        });
        task.gid = null;
        task.ffmpegPid = started.pid || null;
        task.downloadEngine = "ffmpeg";
      } else {
        const headers = Object.entries(task.resolved.headers || {}).map(([name, value]) => `${name}: ${value}`);
        task.gid = await this.aria2.addUri(task.resolved.url, {
          dir: attemptDir,
          out: outputName,
          split: "1",
          "max-connection-per-server": "1",
          "max-tries": "1",
          "retry-wait": "1",
          continue: "false",
          "auto-file-renaming": "false",
          "allow-overwrite": "true",
          header: headers
        });
        task.ffmpegPid = null;
        task.downloadEngine = "aria2";
      }
      task.state = "downloading";
      task.lastCompletedLength = "0";
      task.lastProgressAt = this.clock.now();
      task.updatedAt = nowIso();
      const modeText = task.resolved.resolveMode === "browser_sniff" ? "网页嗅探兜底" : `第 ${task.attempts} 次链接`;
      const engineText = task.downloadEngine === "ffmpeg" ? "FFmpeg 合并媒体流" : "aria2";
      task.message = `正在下载（${modeText}，${engineText}）`;
      this.store.recordAttempt?.(task, {
        phase: "download", outcome: "started", sourceHost: task.sourceHost,
        message: `${task.resolved.mediaType}/${task.downloadEngine}`
      });
      await this.store.save();
      return publicTask(task);
    } catch (downloadError) {
      await this.cleanupTaskStaging(task);
      return this.retryOrFail(task, `${task.resolved.mediaType === "direct" ? "aria2" : "FFmpeg"} 创建任务失败: ${downloadError.message}`, true, {
        fallbackFailure: task.resolved.resolveMode === "browser_sniff"
      });
    }
  }

  async leaseMetadataEnrichment() {
    const now = this.clock.now();
    if (this.activeTaskCount() >= this.maxConcurrentTasks()) return null;
    const waitingDownload = this.store.state.tasks.some(item =>
      item.state === "queued" && (item.nextRunAt || 0) <= now
    );
    if (waitingDownload) return null;
    const task = this.store.state.tasks.find(item =>
      item.state === "completed" && item.destination && (item.imported || item.viewCountRequested) &&
      ((!item.author || !item.uploadTime) || (item.viewCountRequested && item.viewCount == null)) &&
      ["pending", "retry"].includes(item.metadataStatus) &&
      (item.metadataNextRunAt || 0) <= now
    );
    if (!task) return null;
    task.metadataStatus = "enriching";
    task.metadataLeaseId = randomUUID();
    task.metadataLeaseExpiresAt = now + this.config.leaseMs;
    task.metadataMessage = `正在补齐（第 ${(task.metadataAttempts || 0) + 1} 次）`;
    task.updatedAt = nowIso();
    await this.store.save();
    return {
      taskId: task.id,
      leaseId: task.metadataLeaseId,
      videoId: task.videoId,
      attempt: (task.metadataAttempts || 0) + 1
    };
  }

  async submitMetadataEnrichment({
    taskId, leaseId, ok, metadata, error, permanent = false
  }) {
    const task = this.store.state.tasks.find(item => item.id === taskId);
    if (!task || task.metadataStatus !== "enriching" || task.metadataLeaseId !== leaseId) {
      throw new Error("元数据补齐租约无效或已过期");
    }
    task.metadataLeaseId = null;
    task.metadataLeaseExpiresAt = null;
    task.metadataAttempts = (task.metadataAttempts || 0) + 1;
    task.updatedAt = nowIso();
    if (ok && metadata) {
      const requestedViews = task.viewCountRequested === true;
      task.title = metadata.title || task.title || task.videoId;
      task.author = metadata.author || task.author || "";
      task.alias = metadata.alias || task.alias || "";
      task.uploadTime = metadata.uploadTime || task.uploadTime || null;
      const fetchedViews = metadata.views ?? metadata.viewCount ?? metadata.Views ?? null;
      if (fetchedViews != null) {
        const views = Number(fetchedViews);
        if (Number.isSafeInteger(views) && views >= 0) {
          task.viewCount = views;
          task.viewsUpdatedAt = nowIso();
        }
      }
      if (requestedViews) task.viewCountRequested = false;
      if (!task.author || !task.uploadTime) {
        ok = false;
        error = "Iwara 返回的数据缺少作者或上传日期";
      } else {
        task.metadataStatus = "complete";
        task.metadataMessage = requestedViews
          ? (task.viewCount == null ? "作者和日期已补齐；Iwara 未返回播放量" : "作者、日期和播放量已补齐")
          : "作者和上传日期已补齐";
        await this.store.save();
        return publicTask(task);
      }
    }

    const maxAttempts = this.config.metadataMaxAttempts ?? 3;
    const message = error || "元数据补齐失败";
    if (permanent || task.metadataAttempts >= maxAttempts) {
      task.metadataStatus = "failed";
      task.metadataMessage = `${message}；保留原文件和记录`;
    } else {
      task.metadataStatus = "retry";
      task.metadataNextRunAt = this.clock.now() + (this.config.metadataRetryDelayMs ?? 60_000);
      task.metadataMessage = `${message}；稍后重试`;
    }
    await this.store.save();
    return publicTask(task);
  }

  async retryFailedMetadata() {
    let count = 0;
    for (const task of this.store.state.tasks) {
      if ((task.imported || task.viewCountRequested) && task.metadataStatus === "failed" && ((!task.author || !task.uploadTime) || task.viewCountRequested)) {
        task.metadataStatus = "pending";
        task.metadataAttempts = 0;
        task.metadataNextRunAt = 0;
        task.metadataMessage = "手动重试补齐";
        task.updatedAt = nowIso();
        count += 1;
      }
    }
    await this.store.save();
    return { count };
  }

  async queueViewCountEnrichment(limit = 0) {
    const max = Math.min(5000, Math.max(0, Number(limit) || 0));
    const candidates = this.store.state.tasks
      .filter(task => task.state === "completed" && task.destination && task.viewCount == null &&
        !(task.viewCountRequested && ["pending", "retry", "enriching", "failed"].includes(task.metadataStatus)))
      .sort((a, b) => String(a.updatedAt || a.completedAt || a.id).localeCompare(String(b.updatedAt || b.completedAt || b.id)));
    const selected = max ? candidates.slice(0, max) : candidates;
    for (const task of selected) {
      task.viewCountRequested = true;
      task.metadataStatus = "pending";
      task.metadataAttempts = 0;
      task.metadataNextRunAt = 0;
      task.metadataLeaseId = null;
      task.metadataLeaseExpiresAt = null;
      task.metadataMessage = "等待同步播放量";
      task.updatedAt = nowIso();
    }
    await this.store.save();
    return { queued: selected.length, remaining: Math.max(0, candidates.length - selected.length) };
  }

  async retryOrFail(task, message, countedAttempt, { fallbackFailure = false, forceFallback = false } = {}) {
    if (!countedAttempt) task.attempts += 1;
    const wasFallback = task.resolved?.resolveMode === "browser_sniff" || fallbackFailure;
    task.gid = null;
    task.ffmpegPid = null;
    task.downloadEngine = null;
    task.resolved = null;
    task.updatedAt = nowIso();
    const ordinaryAttemptsExhausted = task.attempts >= this.config.maxAttempts;
    const canUseFallback = this.config.browserFallbackEnabled !== false && !task.browserFallbackAttempted;
    if (!wasFallback && (ordinaryAttemptsExhausted || forceFallback) && canUseFallback) {
      task.state = "queued";
      task.browserFallbackPending = true;
      task.nextRunAt = this.clock.now() + this.config.retryDelayMs;
      task.message = `${message}；普通 CDN 已全部尝试，下一步使用网页播放嗅探兜底`;
    } else if (wasFallback || ordinaryAttemptsExhausted || forceFallback) {
      task.state = "failed";
      task.browserFallbackPending = false;
      task.message = wasFallback
        ? `${message}；网页播放嗅探兜底也未能完成下载`
        : `${message}；已达到 ${this.config.maxAttempts} 次上限`;
    } else {
      task.state = "queued";
      task.nextRunAt = this.clock.now() + this.config.retryDelayMs;
      task.message = `${message}；稍后重新解析`;
    }
    await this.store.save();
    return publicTask(task);
  }

  async tick() {
    if (this.busy) return;
    this.busy = true;
    try {
      for (const resolving of this.store.state.tasks.filter(task => task.state === "resolving")) {
        if (resolving.leaseExpiresAt <= this.clock.now()) {
          await this.retryOrFail(resolving, "浏览器解析超时", false);
        }
      }
      for (const enriching of this.store.state.tasks.filter(task => task.metadataStatus === "enriching")) {
        if (enriching.metadataLeaseExpiresAt <= this.clock.now()) {
          await this.submitMetadataEnrichment({
            taskId: enriching.id,
            leaseId: enriching.metadataLeaseId,
            ok: false,
            error: "浏览器补齐元数据超时"
          });
        }
      }
      for (const task of this.store.state.tasks.filter(item => item.state === "downloading")) {
        await this.reconcileDownloadTask(task);
      }
    } finally {
      this.busy = false;
    }
  }

  async reconcileDownloadTask(task) {
    let status;
    if (task.downloadEngine === "ffmpeg") {
      status = await this.ffmpeg?.tellStatus(task.id);
      if (!status) {
        await this.cleanupTaskStaging(task);
        task.browserFallbackPending = true;
        task.browserFallbackAttempted = false;
        task.state = "queued";
        task.downloadEngine = null;
        task.ffmpegPid = null;
        task.resolved = null;
        task.nextRunAt = 0;
        task.message = "FFmpeg 任务在服务重启后不可接管，重新进行网页嗅探";
        await this.store.save();
        return;
      }
    } else {
      try {
        status = await this.aria2.tellStatus(task.gid);
      } catch (error) {
        task.message = `等待 aria2 状态: ${error.message}`;
        task.updatedAt = nowIso();
        await this.store.save();
        return;
      }
    }
    task.totalLength = status.totalLength || task.totalLength || "0";
    task.completedLength = status.completedLength || "0";
    task.downloadSpeed = status.downloadSpeed || "0";
    task.updatedAt = nowIso();
    if (status.status === "complete") {
      const validation = await this.validateMediaFile(task.stagingFile, task.totalLength);
      if (!validation.ok) {
        await this.failDownload(task, validation.message);
        return;
      }
      await this.complete(task);
      return;
    }
    if (status.status === "error" || status.status === "removed") {
      await this.failDownload(task, task.downloadEngine === "ffmpeg"
        ? (status.errorMessage || "FFmpeg 下载失败")
        : aria2FailureMessage(status));
      return;
    }
    if (status.completedLength !== task.lastCompletedLength) {
      task.lastCompletedLength = status.completedLength;
      task.lastProgressAt = this.clock.now();
    } else if (this.clock.now() - task.lastProgressAt > this.config.stallMs) {
      await this.failDownload(task, `下载 ${Math.round(this.config.stallMs / 1000)} 秒无进度`);
      return;
    }
    await this.store.save();
  }

  async failDownload(task, message) {
    if (task.downloadEngine === "ffmpeg") await this.ffmpeg?.forget(task.id, { kill: true });
    else if (task.gid) await this.aria2.forget(task.gid);
    await this.cleanupTaskStaging(task);
    const category = classifyError(message);
    task.lastErrorCategory = category;
    this.store.recordAttempt?.(task, {
      phase: "download",
      outcome: "failure",
      category,
      message,
      sourceHost: task.sourceHost || "",
      completedLength: task.completedLength || 0
    });
    await this.retryOrFail(task, message, true);
  }

  async complete(task) {
    let destination = task.pendingDestination;
    if (!destination) {
      const categoryFolder = this.store.authorCategory?.(task.author) || "";
      const requestedDestination = categoryFolder
        ? path.join(this.config.downloadRoot, categoryFolder, task.resolved.relativePath)
        : path.join(this.config.downloadRoot, task.resolved.relativePath);
      destination = await availableDestination(requestedDestination);
      task.pendingDestination = destination;
      task.categoryFolder = categoryFolder;
      task.state = "finalizing";
      task.message = "正在完成文件入库";
      await this.store.save();
    }
    const destinationInfo = await fileInfo(destination);
    if (!destinationInfo) {
      await mkdir(path.dirname(destination), { recursive: true });
      await moveFileSafely(task.stagingFile, destination, task.id);
    }
    if (task.downloadEngine === "ffmpeg") await this.ffmpeg?.forget(task.id);
    else if (task.gid) await this.aria2.forget(task.gid);
    await this.cleanupTaskStaging(task);
    task.state = "completed";
    task.destination = destination;
    task.pendingDestination = null;
    task.fileStatus = "present";
    task.gid = null;
    task.ffmpegPid = null;
    task.downloadEngine = null;
    task.resolved = null;
    task.completedAt = nowIso();
    task.updatedAt = nowIso();
    task.message = "下载完成";
    this.store.recordAttempt?.(task, {
      phase: "download",
      outcome: "success",
      sourceHost: task.sourceHost || "",
      completedLength: task.completedLength || task.totalLength || 0
    });
    await this.store.save();
  }

  async recoverFinalizing(task) {
    const destination = task.pendingDestination || task.destination;
    if (destination && await fileInfo(destination)) {
      if (task.gid) await this.aria2.forget(task.gid);
      task.destination = destination;
      task.pendingDestination = null;
      task.state = "completed";
      task.fileStatus = "present";
      task.message = "服务重启，已确认文件完成";
      task.completedAt ||= nowIso();
      task.updatedAt = nowIso();
      task.gid = null;
      task.resolved = null;
      await this.cleanupTaskStaging(task);
      return;
    }
    if (task.stagingFile && await fileInfo(task.stagingFile) && task.resolved) {
      await this.complete(task);
      return;
    }
    task.state = "queued";
    task.pendingDestination = null;
    task.gid = null;
    task.resolved = null;
    task.message = "文件入库未完成，等待重新解析";
    task.nextRunAt = 0;
  }

  async verifyCompletedTask(task) {
    if (!task.destination) {
      task.fileStatus = "unknown";
      return;
    }
    const media = await this.locateMediaFile(task);
    if (!media) {
      task.fileStatus = "missing";
      return;
    }
    if (path.resolve(task.destination) !== path.resolve(media.path)) {
      // The whole download directory may have been moved (for example from
      // D:\\Documents\\Downloads\\Video to F:\\Video). Keep the ledger
      // record, but point it at the matching file under the configured root.
      task.destination = media.path;
      task.pendingDestination = null;
      task.pathReconciledAt = nowIso();
    }
    const info = media.info;
    const validation = await this.validateMediaFile(media.path, task.totalLength);
    task.fileStatus = validation.status;
    task.actualFileSize = String(info.size);
  }

  async validateMediaFile(filePath, expectedLength = "0") {
    return mediaFileValidation(filePath, expectedLength, this.config.minValidMediaBytes);
  }

  async cleanupTaskStaging(task) {
    const controlledRoot = path.resolve(this.config.stagingRoot);
    const target = path.resolve(this.config.stagingRoot, task.id);
    if (target.startsWith(`${controlledRoot}${path.sep}`)) {
      await rm(target, { recursive: true, force: true });
    }
  }

  async retryTask(taskId) {
    const task = this.store.state.tasks.find(item => item.id === taskId);
    if (!task || task.state !== "failed") throw new Error("只能重试失败任务");
    task.state = "queued";
    task.attempts = 0;
    task.browserFallbackPending = false;
    task.browserFallbackAttempted = false;
    task.nextRunAt = 0;
    task.message = "手动重试，等待重新解析";
    task.updatedAt = nowIso();
    await this.store.save();
    return publicTask(task);
  }

  async redownloadTask(taskId) {
    const task = this.store.state.tasks.find(item => item.id === taskId);
    if (!task || task.state !== "completed") throw new Error("只能重新下载已完成记录");
    await this.verifyCompletedTask(task);
    if (task.fileStatus === "present") throw new Error("文件仍然存在，无需重新下载");
    if (["too_small", "not_media", "size_mismatch"].includes(task.fileStatus) && task.destination) {
      // The user explicitly requested a re-download. Remove only a file already
      // proven invalid so the corrected copy can retain its original filename.
      await unlink(task.destination).catch(error => {
        if (error.code !== "ENOENT") throw error;
      });
      task.actualFileSize = "0";
      task.fileStatus = "missing";
    }
    task.state = "queued";
    task.attempts = 0;
    task.browserFallbackPending = false;
    task.browserFallbackAttempted = false;
    task.nextRunAt = 0;
    task.gid = null;
    task.resolved = null;
    task.pendingDestination = null;
    task.message = "手动重新下载，等待解析";
    task.updatedAt = nowIso();
    await this.store.save();
    return publicTask(task);
  }

  async verifyFiles() {
    let present = 0, missing = 0, sizeMismatch = 0;
    for (const task of this.store.state.tasks.filter(item => item.state === "completed")) {
      await this.verifyCompletedTask(task);
      if (task.fileStatus === "present") present += 1;
      else if (task.fileStatus === "missing") missing += 1;
      else if (task.fileStatus === "size_mismatch") sizeMismatch += 1;
    }
    await this.store.save();
    return { present, missing, sizeMismatch };
  }

  async openDownloadDirectory() {
    await mkdir(this.config.downloadRoot, { recursive: true });
    const explorer = spawn("explorer.exe", [this.config.downloadRoot], {
      detached: true,
      stdio: "ignore"
    });
    explorer.unref();
    return { ok: true, path: this.config.downloadRoot };
  }

  authorClassificationCandidates(minCount = 10) {
    const threshold = Math.max(1, Number(minCount) || 10);
    const root = path.resolve(this.config.downloadRoot);
    const grouped = new Map();
    for (const task of this.store.state.tasks) {
      if (task.state !== "completed" || !task.author) continue;
      let item = grouped.get(task.author);
      if (!item) {
        item = {
          author: task.author,
          alias: task.alias || "",
          completedCount: 0,
          unclassifiedCount: 0,
          classifiedCount: 0
        };
        grouped.set(task.author, item);
      }
      item.completedCount += 1;
      if (task.destination && path.dirname(path.resolve(task.destination)) === root) {
        item.unclassifiedCount += 1;
      } else if (task.destination) {
        item.classifiedCount += 1;
      }
      if (!item.alias && task.alias) item.alias = task.alias;
    }
    const candidates = [...grouped.values()]
      .filter(item => item.completedCount > threshold)
      .map(item => ({
        ...item,
        category: this.store.authorCategory?.(item.author) || ""
      }))
      .sort((left, right) =>
        right.completedCount - left.completedCount ||
        left.author.localeCompare(right.author, "zh-CN")
      );
    return {
      minCount: threshold,
      candidates,
      rules: this.store.authorCategoryRules?.() || []
    };
  }

  normalizeAuthorCategoryRules(rules, minCount = 10) {
    if (!Array.isArray(rules) || rules.length === 0) {
      throw new Error("请至少选择一位作者");
    }
    if (rules.length > 200) throw new Error("一次最多处理 200 位作者");
    const allowed = new Set(
      this.authorClassificationCandidates(minCount).candidates.map(item => item.author)
    );
    const seen = new Set();
    return rules.map(rule => {
      const author = String(rule?.author || "").trim();
      const key = author.toLocaleLowerCase();
      if (!allowed.has(author)) throw new Error(`作者不在候选列表中：${author || "空白"}`);
      if (seen.has(key)) throw new Error(`作者重复：${author}`);
      seen.add(key);
      return { author, folder: safeFolderName(rule?.folder) };
    });
  }

  async previewAuthorClassification(rules, minCount = 10) {
    const normalized = this.normalizeAuthorCategoryRules(rules, minCount);
    const root = path.resolve(this.config.downloadRoot);
    const byAuthor = new Map(normalized.map(rule => [rule.author, rule.folder]));
    let moveCount = 0, missingCount = 0, collisionCount = 0, alreadyClassifiedCount = 0;
    const groups = new Map();
    for (const rule of normalized) {
      if (!groups.has(rule.folder)) {
        groups.set(rule.folder, { folder: rule.folder, authors: [], files: 0 });
      }
      groups.get(rule.folder).authors.push(rule.author);
    }
    for (const task of this.store.state.tasks) {
      const folder = byAuthor.get(task.author);
      if (!folder || task.state !== "completed" || !task.destination) continue;
      const source = path.resolve(task.destination);
      if (path.dirname(source) !== root) {
        alreadyClassifiedCount += 1;
        continue;
      }
      if (!await fileInfo(source)) {
        missingCount += 1;
        continue;
      }
      const destination = path.join(root, folder, path.basename(source));
      if (await fileInfo(destination)) collisionCount += 1;
      moveCount += 1;
      groups.get(folder).files += 1;
    }
    return {
      rules: normalized,
      groups: [...groups.values()],
      moveCount,
      missingCount,
      collisionCount,
      alreadyClassifiedCount
    };
  }

  async applyAuthorClassification(rules, minCount = 10) {
    const preview = await this.previewAuthorClassification(rules, minCount);
    this.store.upsertAuthorCategoryRules?.(preview.rules);
    const root = path.resolve(this.config.downloadRoot);
    const byAuthor = new Map(preview.rules.map(rule => [rule.author, rule.folder]));
    let moved = 0, renamedForCollision = 0, missing = 0, skipped = 0;
    const errors = [];
    for (const task of this.store.state.tasks) {
      const folder = byAuthor.get(task.author);
      if (!folder || task.state !== "completed" || !task.destination) continue;
      const source = path.resolve(task.destination);
      if (path.dirname(source) !== root) {
        skipped += 1;
        continue;
      }
      if (!await fileInfo(source)) {
        missing += 1;
        continue;
      }
      try {
        const requestedDestination = path.join(root, folder, path.basename(source));
        const destination = await availableDestination(requestedDestination);
        if (destination !== requestedDestination) renamedForCollision += 1;
        await mkdir(path.dirname(destination), { recursive: true });
        task.classificationMove = { source, destination, folder };
        task.message = `正在按作者归入 ${folder}`;
        task.updatedAt = nowIso();
        await this.store.save();
        await moveFileSafely(source, destination, task.id);
        task.destination = destination;
        task.categoryFolder = folder;
        task.classificationMove = null;
        task.fileStatus = "present";
        task.message = `已按作者归入 ${folder}`;
        task.updatedAt = nowIso();
        await this.store.save();
        moved += 1;
      } catch (error) {
        task.classificationMove = null;
        task.message = `作者分类失败：${error.message}`;
        task.updatedAt = nowIso();
        await this.store.save();
        errors.push({ videoId: task.videoId, error: error.message });
      }
    }
    return {
      ok: errors.length === 0,
      rulesSaved: preview.rules.length,
      moved,
      renamedForCollision,
      missing,
      skipped,
      errors: errors.slice(0, 20)
    };
  }

  status() {
    const tasks = this.store.state.tasks.map(publicTask);
    const metadataCounts = Object.fromEntries(
      ["pending", "retry", "enriching", "complete", "failed"]
        .map(state => [state, tasks.filter(task => task.metadataStatus === state).length])
    );
    const completedTasks = tasks.filter(task => task.state === "completed");
    const viewCounts = {
      complete: completedTasks.filter(task => task.viewCount != null).length,
      pending: completedTasks.filter(task => task.viewCount == null && task.viewCountRequested && ["pending", "retry", "enriching"].includes(task.metadataStatus)).length,
      failed: completedTasks.filter(task => task.viewCount == null && task.viewCountRequested && task.metadataStatus === "failed").length,
      missing: completedTasks.filter(task => task.viewCount == null).length
    };
    return {
      counts: this.store.counts?.() || Object.fromEntries(
        ["queued", "resolving", "downloading", "finalizing", "completed", "failed"]
          .map(state => [state, tasks.filter(task => task.state === state).length])
      ),
      current: tasks.find(task => ["resolving", "downloading", "finalizing"].includes(task.state)) || null,
      currents: tasks.filter(task => ["resolving", "downloading", "finalizing"].includes(task.state)),
      metadataCounts,
      viewCounts,
      metadataCurrent: tasks.find(task => task.metadataStatus === "enriching") || null,
      metadataCurrents: tasks.filter(task => task.metadataStatus === "enriching"),
      activeTaskCount: this.activeTaskCount(),
      maxConcurrentTasks: this.maxConcurrentTasks(),
      total: tasks.length
    };
  }

  ledger(params) {
    const result = this.store.queryTasks
      ? this.store.queryTasks(params)
      : { total: this.store.state.tasks.length, page: 1, pageSize: 10000, tasks: this.store.state.tasks };
    return { ...result, tasks: result.tasks.map(publicTask), authors: this.store.authors?.() || [] };
  }

  async playlist({ query = "", author = "all", taskId = "", contextId = "", contextSize = 5, sort = "updatedAt", direction = "desc", page = 1, pageSize = 25, randomPage = false } = {}) {
    const needle = String(query || "").trim().toLocaleLowerCase();
    const matches = [];
    for (const task of this.store.state.tasks) {
      if (task.state !== "completed" || !task.destination) continue;
      // A standalone player asks for a small neighborhood around one item.
      // Keep the normal taskId filter for the legacy one-item view, but do
      // not throw away neighbors when contextId is present.
      if (taskId && !contextId && task.id !== taskId) continue;
      if (author !== "all" && task.author !== author) continue;
      if (!needle) {
        try {
          await this.mediaPath(task.id);
          matches.push(task);
        } catch {}
        continue;
      }
      if (![task.title, task.videoId, task.author, task.alias]
        .some(value => String(value || "").toLocaleLowerCase().includes(needle))) continue;
      try {
        await this.mediaPath(task.id);
        matches.push(task);
      } catch {
        // Keep the player limited to files that can actually be served.
      }
    }
    const valueFor = task => {
      if (sort === "title") return String(task.title || task.videoId || "").toLocaleLowerCase();
      if (sort === "author") return String(task.alias || task.author || "").toLocaleLowerCase();
      if (sort === "uploadTime") return Number(task.uploadTime || 0);
      if (sort === "views") return Number(task.viewCount ?? task.views ?? -1);
      return String(task.updatedAt || task.completedAt || task.createdAt || "");
    };
    const factor = direction === "asc" ? 1 : -1;
    matches.sort((a, b) => {
      const left = valueFor(a), right = valueFor(b);
      if (left < right) return -1 * factor;
      if (left > right) return 1 * factor;
      return String(a.id).localeCompare(String(b.id));
    });
    const safePageSize = Math.min(60, Math.max(6, Number(pageSize) || 25));
    const pageCount = Math.max(1, Math.ceil(matches.length / safePageSize));
    const safePage = randomPage
      ? 1 + Math.floor(Math.random() * pageCount)
      : Math.min(pageCount, Math.max(1, Number(page) || 1));
    let selected = matches.slice((safePage - 1) * safePageSize, safePage * safePageSize);
    let currentIndex = null;
    if (contextId) {
      const center = matches.findIndex(task => task.id === contextId);
      const size = Math.min(9, Math.max(2, Number(contextSize) || 5));
      if (center < 0) {
        selected = [];
      } else {
        const start = Math.max(0, Math.min(center - Math.floor(size / 2), matches.length - size));
        selected = matches.slice(start, start + size);
        currentIndex = center - start;
      }
    }
    const items = selected
      .map(task => ({
        ...publicTask(task),
        streamUrl: `/media/${encodeURIComponent(task.id)}`,
        views: task.viewCount ?? task.views ?? null,
        viewsUpdatedAt: task.viewsUpdatedAt || null,
        localFileName: path.basename(task.destination)
      }));
    return { total: matches.length, page: safePage, pageSize: safePageSize, currentIndex, items };
  }

  mediaCandidates(task) {
    const root = path.resolve(this.config.downloadRoot);
    const original = path.resolve(task.destination);
    const candidates = [];
    const add = candidate => {
      const resolved = path.resolve(candidate);
      const relative = path.relative(root, resolved);
      if (resolved === root || !relative || relative.startsWith("..") || path.isAbsolute(relative)) return;
      if (!candidates.includes(resolved)) candidates.push(resolved);
    };
    const originalRelative = path.relative(root, original);
    if (originalRelative && !originalRelative.startsWith("..") && !path.isAbsolute(originalRelative)) {
      add(original);
    }
    // Preserve the subdirectory below a previous ...\\Video root when the
    // complete folder was moved to the currently configured download root.
    const rootName = path.basename(root).toLocaleLowerCase();
    const parts = original.split(/[\\/]+/);
    let rootIndex = -1;
    for (let index = parts.length - 2; index >= 0; index -= 1) {
      if (parts[index].toLocaleLowerCase() === rootName) {
        rootIndex = index;
        break;
      }
    }
    if (rootIndex >= 0 && rootIndex < parts.length - 1) {
      add(path.join(root, ...parts.slice(rootIndex + 1)));
    }
    if (task.categoryFolder) {
      try {
        add(path.join(root, safeFolderName(task.categoryFolder), path.basename(original)));
      } catch {
        // Ignore an old/invalid category name and continue with safe paths.
      }
    }
    // Files moved to the configured root retain their ledger basename.
    add(path.join(root, path.basename(original)));
    return candidates;
  }

  async locateMediaFile(task) {
    for (const filePath of this.mediaCandidates(task)) {
      const info = await fileInfo(filePath);
      if (info) return { path: filePath, info };
    }
    return null;
  }

  async mediaPath(taskId) {
    const task = this.store.state.tasks.find(item => item.id === taskId);
    if (!task || task.state !== "completed" || !task.destination) throw new Error("本地视频不存在");
    const media = await this.locateMediaFile(task);
    if (media) return { path: media.path, name: path.basename(media.path) };
    throw new Error("本地视频不存在");
  }

  async updateViewCount(videoId, value) {
    const id = String(videoId || "").trim();
    const views = Number(value);
    if (!id) throw new Error("缺少视频 ID");
    if (!Number.isSafeInteger(views) || views < 0) throw new Error("播放量不是有效的非负整数");
    const task = this.store.state.tasks.find(item => item.videoId === id);
    if (!task) throw new Error("未找到对应的视频记录");
    task.viewCount = views;
    task.viewsUpdatedAt = nowIso();
    task.updatedAt = nowIso();
    await this.store.save();
    return publicTask(task);
  }

  attemptHistory(taskId) {
    return this.store.attemptHistory?.(taskId) || [];
  }
}
