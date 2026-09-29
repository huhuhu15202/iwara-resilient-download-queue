import { createHash, randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdir, readdir, rename, rm, stat, utimes } from "node:fs/promises";
import path from "node:path";

const MIN_OUTPUT_BYTES = 1024;
const DEFAULT_HEIGHT = 480;

function cacheKey(taskId, media, height) {
  return createHash("sha256")
    .update(`${taskId}\n${media.path}\n${media.name}\n${media.size || ""}\n${media.mtimeMs || ""}\n${height}`)
    .digest("hex");
}

function removeExtension(name = "video") {
  const value = String(name || "video");
  return value.replace(/\.[A-Za-z0-9]{1,8}$/, "") || "video";
}

export class TranscodeCache {
  constructor({
    ffmpeg,
    root,
    height = DEFAULT_HEIGHT,
    concurrency = 2,
    maxBytes = 20 * 1024 * 1024 * 1024,
    maxAgeMs = 24 * 60 * 60 * 1000
  } = {}) {
    this.ffmpeg = ffmpeg;
    this.root = path.resolve(String(root || "transcode-cache"));
    this.height = Number.isInteger(Number(height)) && Number(height) > 0 ? Number(height) : DEFAULT_HEIGHT;
    this.concurrency = Math.max(1, Number(concurrency) || 2);
    this.maxBytes = Math.max(0, Number(maxBytes) || 0);
    this.maxAgeMs = Math.max(0, Number(maxAgeMs) || 0);
    this.cache = new Map();
    this.pending = new Map();
    this.queue = [];
    this.processes = new Set();
    this.active = 0;
    this.closed = false;
    this.cleanupPromise = null;
  }

  async init() {
    await mkdir(this.root, { recursive: true });
    await this.cleanup();
  }

  enqueue(work) {
    return new Promise((resolve, reject) => {
      this.queue.push({ work, resolve, reject });
      this.pump();
    });
  }

  pump() {
    while (!this.closed && this.active < this.concurrency && this.queue.length) {
      const item = this.queue.shift();
      this.active += 1;
      Promise.resolve().then(item.work).then(item.resolve, item.reject).finally(() => {
        this.active -= 1;
        this.pump();
      });
    }
  }

  async sourceInfo(taskId, scheduler) {
    const media = await scheduler.mediaPath(taskId);
    const info = await stat(media.path);
    return {
      ...media,
      size: info.size,
      mtimeMs: info.mtimeMs
    };
  }

  async get(taskId, scheduler) {
    if (this.closed) throw new Error("远程转码服务已关闭");
    const media = await this.sourceInfo(taskId, scheduler);
    const key = cacheKey(taskId, media, this.height);
    const cached = this.cache.get(key);
    if (cached) {
      try {
        const info = await stat(cached.path);
        if (info.size > MIN_OUTPUT_BYTES) {
          await utimes(cached.path, new Date(), new Date()).catch(() => {});
          return { ...cached, size: info.size };
        }
      } catch {}
      this.cache.delete(key);
    }

    const targetPath = path.join(this.root, `${key}.mp4`);
    try {
      const info = await stat(targetPath);
      if (info.size > MIN_OUTPUT_BYTES) {
        const output = this.outputMedia(media, targetPath, info.size);
        this.cache.set(key, output);
        await utimes(targetPath, new Date(), new Date()).catch(() => {});
        return output;
      }
    } catch {}
    if (this.pending.has(key)) return this.pending.get(key);

    const job = this.enqueue(async () => {
      const executable = await this.ffmpeg?.resolveExecutable();
      if (!executable) throw new Error("本机未找到 FFmpeg，无法生成远程 480p 视频");
      await mkdir(this.root, { recursive: true });
      // Keep the final .mp4 suffix so FFmpeg selects the MP4 muxer; the
      // .part marker still lets startup cleanup remove interrupted jobs.
      const tempPath = `${targetPath}.part-${process.pid}-${randomBytes(4).toString("hex")}.mp4`;
      const output = await this.run(executable, media, tempPath);
      await rename(tempPath, targetPath);
      const info = await stat(targetPath);
      if (info.size <= MIN_OUTPUT_BYTES) {
        await rm(targetPath, { force: true });
        throw new Error("FFmpeg 生成的远程 480p 文件为空");
      }
      const result = this.outputMedia(media, targetPath, info.size);
      this.cache.set(key, result);
      void this.cleanup();
      return result;
    });
    this.pending.set(key, job);
    try {
      return await job;
    } finally {
      this.pending.delete(key);
    }
  }

  outputMedia(media, targetPath, size) {
    return {
      ...media,
      path: targetPath,
      size,
      name: `${removeExtension(media.name)}.${this.height}p.mp4`,
      profile: `remote-${this.height}p`
    };
  }

  run(executable, media, outputPath) {
    return new Promise((resolve, reject) => {
      const args = [
        "-nostdin", "-y", "-hide_banner", "-loglevel", "error",
        "-i", media.path,
        "-map", "0:v:0",
        "-map", "0:a:0?",
        "-vf", `scale=854:${this.height}:force_original_aspect_ratio=decrease:force_divisible_by=2`,
        "-c:v", "libx264", "-preset", "veryfast", "-crf", "28",
        "-pix_fmt", "yuv420p",
        "-c:a", "aac", "-b:a", "96k", "-ac", "2",
        "-sn", "-dn", "-movflags", "+faststart",
        outputPath
      ];
      const child = spawn(executable, args, {
        windowsHide: true,
        stdio: ["ignore", "ignore", "pipe"]
      });
      this.processes.add(child);
      let stderr = "";
      let settled = false;
      const finish = (error, value) => {
        if (settled) return;
        settled = true;
        this.processes.delete(child);
        if (error) reject(error);
        else resolve(value);
      };
      child.stderr.on("data", chunk => {
        stderr = `${stderr}${chunk.toString()}`.slice(-16000);
      });
      child.on("error", error => finish(error));
      child.on("close", code => {
        if (code === 0) return finish(null, outputPath);
        const detail = stderr.trim().split(/\r?\n/).slice(-6).join(" | ");
        const error = new Error(detail || `FFmpeg 远程转码失败，退出码 ${code}`);
        error.code = "REMOTE_TRANSCODE_FAILED";
        finish(error);
      });
    }).catch(async error => {
      await rm(outputPath, { force: true }).catch(() => {});
      throw error;
    });
  }

  async cleanup() {
    if (this.cleanupPromise) return this.cleanupPromise;
    this.cleanupPromise = (async () => {
      await mkdir(this.root, { recursive: true });
      const now = Date.now();
      const entries = [];
      for (const entry of await readdir(this.root, { withFileTypes: true })) {
        if (!entry.isFile()) continue;
        const filePath = path.join(this.root, entry.name);
        let info;
        try { info = await stat(filePath); } catch { continue; }
        if (entry.name.includes(".part-")) {
          await rm(filePath, { force: true }).catch(() => {});
          continue;
        }
        if (!entry.name.endsWith(".mp4")) continue;
        if (this.maxAgeMs > 0 && now - info.mtimeMs > this.maxAgeMs) {
          await rm(filePath, { force: true }).catch(() => {});
          continue;
        }
        entries.push({ path: filePath, size: info.size, mtimeMs: info.mtimeMs });
      }
      if (this.maxBytes > 0) {
        let total = entries.reduce((sum, item) => sum + item.size, 0);
        for (const item of entries.sort((a, b) => a.mtimeMs - b.mtimeMs)) {
          if (total <= this.maxBytes) break;
          await rm(item.path, { force: true }).catch(() => {});
          total -= item.size;
        }
      }
    })().finally(() => { this.cleanupPromise = null; });
    return this.cleanupPromise;
  }

  close() {
    this.closed = true;
    for (const process of this.processes) {
      try { process.kill("SIGTERM"); } catch {}
    }
    for (const item of this.queue.splice(0)) item.reject(new Error("远程转码服务已关闭"));
  }
}
