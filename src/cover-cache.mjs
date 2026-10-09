import { spawn } from "node:child_process";
import { open, stat } from "node:fs/promises";

const MAX_JPEG_BYTES = 2 * 1024 * 1024;
const CAPTURE_TIMEOUT_MS = 15000;

// Read only MP4 box headers and mvhd, not the video payload. Avoid a second
// FFmpeg process when a random timestamp would fall beyond a short video.
export async function mp4Duration(filePath) {
  let file;
  try {
    file = await open(filePath, "r");
    const size = (await file.stat()).size;
    const header = Buffer.alloc(16);
    const boxes = async (start, end, wanted) => {
      for (let offset = start, count = 0; offset + 8 <= end && count < 256; count++) {
        const { bytesRead } = await file.read(header, 0, 16, offset);
        if (bytesRead < 8) return null;
        let length = header.readUInt32BE(0), prefix = 8;
        if (length === 1) { if (bytesRead < 16) return null; length = Number(header.readBigUInt64BE(8)); prefix = 16; }
        if (length === 0) length = end - offset;
        if (!Number.isSafeInteger(length) || length < prefix || offset + length > end) return null;
        if (header.toString("ascii", 4, 8) === wanted) return { start: offset + prefix, end: offset + length };
        offset += length;
      }
      return null;
    };
    const moov = await boxes(0, size, "moov");
    if (!moov) return null;
    const mvhd = await boxes(moov.start, moov.end, "mvhd");
    if (!mvhd || mvhd.end - mvhd.start < 20) return null;
    const data = Buffer.alloc(Math.min(32, mvhd.end - mvhd.start));
    await file.read(data, 0, data.length, mvhd.start);
    if (data[0] !== 0 && data[0] !== 1) return null;
    const version = data[0];
    if (version === 1 && data.length < 32) return null;
    const scale = data.readUInt32BE(version === 1 ? 20 : 12);
    const ticks = version === 1 ? Number(data.readBigUInt64BE(24)) : data.readUInt32BE(16);
    const seconds = ticks / scale;
    return scale > 0 && Number.isFinite(seconds) && seconds > 0 && seconds < 7 * 86400 ? seconds : null;
  } catch { return null; }
  finally { await file?.close(); }
}

function captureFrame(executable, filePath, seconds, processes) {
  return new Promise(resolve => {
    const child = spawn(executable, [
      "-nostdin", "-hide_banner", "-loglevel", "error", "-noaccurate_seek", "-ss", String(seconds),
      "-skip_frame", "nokey", "-threads", "2", "-i", filePath, "-frames:v", "1", "-filter_threads", "1",
      // Some portrait encodes store landscape-sized pixels with a portrait
      // sample-aspect-ratio (SAR). Convert the display aspect ratio to square
      // pixels before fitting the thumbnail, otherwise the JPEG becomes a
      // false landscape image and the client cannot preserve portrait framing.
      "-vf", "scale=iw*sar:ih,setsar=1,scale=480:854:force_original_aspect_ratio=decrease:force_divisible_by=2,setsar=1", "-threads", "1",
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
  constructor({ ffmpeg, limit = 150, concurrency = 2, capture = captureFrame, random = Math.random } = {}) {
    this.ffmpeg = ffmpeg;
    this.limit = limit;
    this.concurrency = concurrency;
    this.cache = new Map();
    this.pending = new Map();
    this.queue = [];
    this.active = 0;
    this.processes = new Set();
    this.closed = false;
    this.capture = capture;
    this.random = random;
  }

  enqueue(work, priority = 0) {
    const item = { work, priority, started: false };
    item.promise = new Promise((resolve, reject) => {
      Object.assign(item, { resolve, reject });
      if (this.closed) { reject(new Error("封面服务已关闭")); return; }
      this.queue.push(item);
      this.pump();
    });
    return item;
  }

  pump() {
    while (!this.closed && this.active < this.concurrency && this.queue.length) {
      this.queue.sort((a, b) => b.priority - a.priority);
      const item = this.queue.shift();
      item.started = true;
      this.active += 1;
      Promise.resolve().then(item.work).then(item.resolve, item.reject).finally(() => {
        this.active -= 1;
        this.pump();
      });
    }
  }

  wait(entry, signal) {
    return new Promise((resolve, reject) => {
      const consumer = {};
      entry.consumers.add(consumer);
      const cleanup = () => { entry.consumers.delete(consumer); signal?.removeEventListener("abort", aborted); };
      const aborted = () => {
        cleanup();
        if (!entry.consumers.size && !entry.job.started) {
          const index = this.queue.indexOf(entry.job);
          if (index >= 0) { this.queue.splice(index, 1); entry.job.reject(new Error("封面请求已取消")); }
        }
        reject(new Error("封面请求已取消"));
      };
      entry.job.promise.then(value => { cleanup(); resolve(value); }, error => { cleanup(); reject(error); });
      signal?.addEventListener("abort", aborted, { once: true });
      if (signal?.aborted) aborted();
    });
  }

  async get(taskId, scheduler, { signal, priority = 0 } = {}) {
    if (this.closed) throw new Error("封面服务已关闭");
    const media = await scheduler.mediaPath(taskId);
    const info = await stat(media.path);
    if (this.closed) throw new Error("封面服务已关闭");
    if (signal?.aborted) throw new Error("封面请求已取消");
    const key = `${taskId}\n${media.path}\n${info.size}\n${info.mtimeMs}`;
    const cached = this.cache.get(key);
    if (cached) {
      this.cache.delete(key);
      this.cache.set(key, cached);
      return cached;
    }
    if (this.pending.has(key)) {
      const entry = this.pending.get(key);
      entry.job.priority = Math.max(entry.job.priority, priority);
      return this.wait(entry, signal);
    }
    const job = this.enqueue(async () => {
      const executable = await this.ffmpeg?.resolveExecutable();
      if (this.closed) throw new Error("封面服务已关闭");
      if (!executable) throw new Error("本机未找到 FFmpeg，无法生成封面");
      const duration = await mp4Duration(media.path);
      if (this.closed) throw new Error("封面服务已关闭");
      const seconds = duration ? Math.max(0, Math.min(duration - 0.05, duration * (0.08 + this.random() * 0.8))) : 2 + this.random() * 28;
      let image = await this.capture(executable, media.path, +seconds.toFixed(3), this.processes);
      if (!image && !this.closed) image = await this.capture(executable, media.path, 0, this.processes);
      if (this.closed) throw new Error("封面服务已关闭");
      if (!image) throw new Error("无法从本地视频生成封面");
      if (!this.closed) {
        for (const oldKey of this.cache.keys()) {
          if (oldKey.startsWith(`${taskId}\n`) && oldKey !== key) this.cache.delete(oldKey);
        }
        this.cache.set(key, image);
        while (this.cache.size > this.limit) this.cache.delete(this.cache.keys().next().value);
      }
      return image;
    }, priority);
    const entry = { job, consumers: new Set() };
    this.pending.set(key, entry);
    const cleanup = () => { if (this.pending.get(key) === entry) this.pending.delete(key); };
    job.promise.then(cleanup, cleanup);
    return this.wait(entry, signal);
  }

  clear() {
    this.closed = true;
    this.cache.clear();
    for (const process of this.processes) process.kill();
    for (const item of this.queue.splice(0)) item.reject(new Error("封面服务已关闭"));
    return Promise.allSettled([...this.pending.values()].map(entry => entry.job.promise));
  }
}
