import { access, mkdir, readdir, stat } from "node:fs/promises";
import { constants } from "node:fs";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import path from "node:path";

const YOUTUBE_HOSTS = new Set([
  "youtube.com", "www.youtube.com", "m.youtube.com", "music.youtube.com",
  "youtu.be", "www.youtu.be", "youtube-nocookie.com", "www.youtube-nocookie.com"
]);

export function normalizeYoutubeVideoUrl(value) {
  let parsed;
  try { parsed = new URL(String(value || "")); }
  catch { throw new Error("这不是有效的 YouTube 视频链接"); }
  if (parsed.protocol !== "https:" || !YOUTUBE_HOSTS.has(parsed.hostname.toLowerCase()) || parsed.username || parsed.password || (parsed.port && parsed.port !== "443")) {
    throw new Error("只接受 HTTPS YouTube 视频链接");
  }
  let videoId = "";
  const host = parsed.hostname.toLowerCase();
  if (host === "youtu.be" || host === "www.youtu.be") {
    videoId = parsed.pathname.split("/").filter(Boolean)[0] || "";
  } else if (parsed.pathname === "/watch") {
    videoId = parsed.searchParams.get("v") || "";
  } else {
    videoId = /^\/(?:embed|shorts|live|v)\/([^/?#]+)/i.exec(parsed.pathname)?.[1] || "";
  }
  if (!/^[A-Za-z0-9_-]{11}$/.test(videoId)) throw new Error("只支持单个 YouTube 视频；播放列表链接不支持");
  return { videoId, url: `https://www.youtube.com/watch?v=${videoId}` };
}

async function canAccess(filePath) {
  try { await access(filePath, constants.X_OK); return true; }
  catch { return false; }
}

async function findOnPath(executable) {
  const locator = process.platform === "win32" ? "where.exe" : "which";
  return await new Promise(resolve => {
    const child = spawn(locator, [executable], { windowsHide: true, stdio: ["ignore", "pipe", "ignore"] });
    let output = "";
    child.stdout.on("data", chunk => { output += chunk.toString(); });
    child.on("error", () => resolve(""));
    child.on("close", code => resolve(code === 0 ? output.split(/\r?\n/).map(line => line.trim()).find(Boolean) || "" : ""));
  });
}

function publicJob(job, duplicate = false) {
  return {
    id: job.id,
    videoId: job.videoId,
    status: job.status,
    progress: job.progress,
    fileName: job.outputPath ? path.basename(job.outputPath) : "",
    message: job.message,
    errorMessage: job.errorMessage,
    createdAt: job.createdAt,
    startedAt: job.startedAt,
    completedAt: job.completedAt,
    duplicate
  };
}

export class YoutubeDownloader {
  constructor({ downloadRoot, archivePath, configuredPath = "", resolveFfmpeg = async () => "", onCompleted = async () => {} }) {
    this.downloadRoot = path.resolve(downloadRoot, "YouTube");
    this.archivePath = path.resolve(archivePath);
    this.configuredPath = String(configuredPath || "").trim();
    this.resolveFfmpeg = resolveFfmpeg;
    this.onCompleted = onCompleted;
    this.executable = null;
    this.jobs = new Map();
    this.pending = [];
    this.running = false;
    this.closed = false;
  }

  async resolveExecutable() {
    if (this.executable) return this.executable;
    const profile = process.env.USERPROFILE || process.env.HOME || "";
    const localAppData = process.env.LOCALAPPDATA || "";
    const candidates = [
      this.configuredPath,
      process.env.IWARA_YTDLP_PATH,
      profile ? path.join(profile, "scoop", "shims", "yt-dlp.exe") : "",
      localAppData ? path.join(localAppData, "Programs", "Python", "Python314", "Scripts", "yt-dlp.exe") : ""
    ].filter(Boolean);
    for (const candidate of candidates) {
      if (await canAccess(candidate)) return this.executable = candidate;
    }
    const fromPath = await findOnPath(process.platform === "win32" ? "yt-dlp.exe" : "yt-dlp");
    if (fromPath) return this.executable = fromPath;
    throw new Error("本机没有找到 yt-dlp。请安装 yt-dlp，或在 IWARA_YTDLP_PATH 中指定 yt-dlp.exe 的完整路径");
  }

  enqueue(value) {
    if (this.closed) throw new Error("本机下载服务正在关闭");
    const { videoId, url } = normalizeYoutubeVideoUrl(value);
    const prior = [...this.jobs.values()].reverse().find(job => job.videoId === videoId && ["queued", "active", "completed", "skipped"].includes(job.status));
    if (prior) return { job: publicJob(prior, true), duplicate: true };
    const job = {
      id: randomUUID(), videoId, url, status: "queued", progress: null,
      message: "等待本机下载", errorMessage: "", outputPath: "", outputText: "",
      stdoutBuffer: "", child: null, createdAt: new Date().toISOString(),
      startedAt: null, completedAt: null, completion: null
    };
    this.jobs.set(job.id, job);
    this.pending.push(job);
    this.pruneJobs();
    void this.pump();
    return { job: publicJob(job), duplicate: false };
  }

  get(jobId) {
    const job = this.jobs.get(String(jobId || ""));
    return job ? publicJob(job) : null;
  }

  pruneJobs() {
    const cutoff = Date.now() - 24 * 60 * 60_000;
    for (const [id, job] of this.jobs) {
      if (this.jobs.size <= 200) break;
      if (["completed", "skipped", "failed"].includes(job.status) && Date.parse(job.completedAt || job.createdAt) < cutoff) this.jobs.delete(id);
    }
  }

  async pump() {
    if (this.running || this.closed) return;
    this.running = true;
    try {
      while (!this.closed && this.pending.length) await this.runJob(this.pending.shift());
    } finally {
      this.running = false;
      if (!this.closed && this.pending.length) void this.pump();
    }
  }

  appendOutput(job, chunk) {
    job.outputText = `${job.outputText}${chunk.toString()}`.slice(-16000);
    const clean = job.outputText.replace(/\u001b\[[0-9;]*m/g, "");
    const matches = [...clean.matchAll(/(?:^|\s)(\d{1,3}(?:\.\d+)?)%/g)];
    if (matches.length) job.progress = Math.max(0, Math.min(100, Number(matches.at(-1)[1])));
  }

  async runJob(job) {
    job.status = "active";
    job.message = "正在由本机 yt-dlp 下载";
    job.startedAt = new Date().toISOString();
    try {
      const executable = await this.resolveExecutable();
      if (this.closed) throw new Error("本机下载服务正在关闭");
      await Promise.all([mkdir(this.downloadRoot, { recursive: true }), mkdir(path.dirname(this.archivePath), { recursive: true })]);
      const ffmpeg = await this.resolveFfmpeg().catch(() => "");
      const args = [
        "--no-playlist", "--no-overwrites", "--windows-filenames", "--newline", "--progress",
        "--download-archive", this.archivePath,
        "--output", "%(title).180B - %(id)s.%(ext)s",
        "--print", "after_move:filepath",
        "--format", ffmpeg ? "bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best" : "best[ext=mp4]/best",
        "--merge-output-format", "mp4"
      ];
      if (ffmpeg) args.push("--ffmpeg-location", ffmpeg);
      args.push(job.url);
      const child = spawn(executable, args, { cwd: this.downloadRoot, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
      job.child = child;
      child.stdout.on("data", chunk => {
        this.appendOutput(job, chunk);
        const lines = `${job.stdoutBuffer}${chunk.toString()}`.split(/\r?\n/);
        job.stdoutBuffer = lines.pop() || "";
        for (const line of lines) {
          const candidate = line.trim().replace(/^['"]|['"]$/g, "");
          if (candidate && path.isAbsolute(candidate) && path.dirname(path.resolve(candidate)).toLowerCase() === this.downloadRoot.toLowerCase()) job.outputPath = path.resolve(candidate);
        }
      });
      child.stderr.on("data", chunk => this.appendOutput(job, chunk));
      job.completion = new Promise((resolve, reject) => {
        child.once("error", reject);
        child.once("close", (code, signal) => resolve({ code, signal }));
      });
      const result = await job.completion;
      job.child = null;
      job.completion = null;
      if (result.code !== 0) {
        const detail = job.outputText.trim().split(/\r?\n/).map(line => line.trim()).filter(Boolean).slice(-5).join(" | ");
        throw new Error(detail || `yt-dlp 退出码 ${result.code}${result.signal ? ` (${result.signal})` : ""}`);
      }
      if (!job.outputPath) {
        try {
          const suffix = ` - ${job.videoId}`.toLowerCase();
          const existing = (await readdir(this.downloadRoot)).find(name => path.parse(name).name.toLowerCase().endsWith(suffix));
          if (existing) job.outputPath = path.join(this.downloadRoot, existing);
        } catch {}
      }
      let outputExists = false;
      try { outputExists = Boolean(job.outputPath && (await stat(job.outputPath)).isFile()); } catch {}
      job.status = outputExists ? "completed" : "skipped";
      job.progress = outputExists ? 100 : job.progress;
      job.message = outputExists ? "已保存到下载目录的 YouTube 文件夹" : "没有生成新文件（可能已下载或已归档）";
      job.completedAt = new Date().toISOString();
      if (outputExists) await this.onCompleted(job.outputPath, publicJob(job));
    } catch (error) {
      job.child = null;
      job.completion = null;
      job.status = "failed";
      job.errorMessage = error.message || "YouTube 下载失败";
      job.message = "下载失败";
      job.completedAt = new Date().toISOString();
    }
  }

  async close() {
    this.closed = true;
    this.pending.length = 0;
    const active = [...this.jobs.values()].filter(job => job.status === "active" && job.child);
    for (const job of active) {
      try { job.child.kill("SIGTERM"); } catch {}
    }
    await Promise.allSettled(active.map(job => job.completion).filter(Boolean));
  }
}
