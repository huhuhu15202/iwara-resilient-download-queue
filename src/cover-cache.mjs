import { spawn } from "node:child_process";
import { stat } from "node:fs/promises";

const MAX_JPEG_BYTES = 2 * 1024 * 1024;
const CAPTURE_TIMEOUT_MS = 15000;

function captureFrame(executable, filePath, seconds, processes) {
  return new Promise(resolve => {
    const child = spawn(executable, [
      "-nostdin", "-hide_banner", "-loglevel", "error", "-ss", String(seconds),
      "-i", filePath, "-frames:v", "1", "-vf", "scale=640:-2",
      "-q:v", "5", "-f", "image2pipe", "-vcodec", "mjpeg", "pipe:1"
    ], { windowsHide: true, stdio: ["ignore", "pipe", "ignore"] });
    processes.add(child);
    const chunks = [];
    let bytes = 0;
    let settled = false;
    const finish = value => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      processes.delete(child);
      resolve(value);
    };
    const timeout = setTimeout(() => child.kill(), CAPTURE_TIMEOUT_MS);
    child.stdout.on("data", chunk => {
      bytes += chunk.length;
      if (bytes > MAX_JPEG_BYTES) child.kill();
      else chunks.push(chunk);
    });
    child.on("error", () => finish(null));
    child.on("close", code => {
      const image = code === 0 && bytes <= MAX_JPEG_BYTES ? Buffer.concat(chunks) : null;
      finish(image?.subarray(0, 2).equals(Buffer.from([0xff, 0xd8])) ? image : null);
    });
  });
}

export class CoverCache {
  constructor({ ffmpeg, limit = 150, concurrency = 2 } = {}) {
    this.ffmpeg = ffmpeg;
    this.limit = limit;
    this.concurrency = concurrency;
    this.cache = new Map();
    this.pending = new Map();
    this.queue = [];
    this.active = 0;
    this.processes = new Set();
    this.closed = false;
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

  async get(taskId, scheduler) {
    if (this.closed) throw new Error("封面服务已关闭");
    const media = await scheduler.mediaPath(taskId);
    const info = await stat(media.path);
    const key = `${taskId}\n${media.path}\n${info.size}\n${info.mtimeMs}`;
    const cached = this.cache.get(key);
    if (cached) {
      this.cache.delete(key);
      this.cache.set(key, cached);
      return cached;
    }
    if (this.pending.has(key)) return this.pending.get(key);
    const job = this.enqueue(async () => {
      const executable = await this.ffmpeg?.resolveExecutable();
      if (!executable) throw new Error("本机未找到 FFmpeg，无法生成封面");
      let image = await captureFrame(executable, media.path, +(2 + Math.random() * 88).toFixed(2), this.processes);
      if (!image) image = await captureFrame(executable, media.path, 0.5, this.processes);
      if (!image) throw new Error("无法从本地视频生成封面");
      if (!this.closed) {
        for (const oldKey of this.cache.keys()) {
          if (oldKey.startsWith(`${taskId}\n`) && oldKey !== key) this.cache.delete(oldKey);
        }
        this.cache.set(key, image);
        while (this.cache.size > this.limit) this.cache.delete(this.cache.keys().next().value);
      }
      return image;
    });
    this.pending.set(key, job);
    try { return await job; }
    finally { this.pending.delete(key); }
  }

  clear() {
    this.closed = true;
    this.cache.clear();
    for (const process of this.processes) process.kill();
    for (const item of this.queue.splice(0)) item.reject(new Error("封面服务已关闭"));
  }
}
