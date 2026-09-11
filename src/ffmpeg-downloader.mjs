import { access, mkdir, stat } from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";

function candidatePaths(configuredPath = "") {
  const env = process.env;
  return [
    configuredPath,
    env.FFMPEG_PATH,
    env.LOCALAPPDATA ? path.join(env.LOCALAPPDATA, "Microsoft", "WinGet", "Links", "ffmpeg.exe") : "",
    env.ProgramData ? path.join(env.ProgramData, "chocolatey", "bin", "ffmpeg.exe") : "",
    env.ProgramFiles ? path.join(env.ProgramFiles, "ffmpeg", "bin", "ffmpeg.exe") : "",
    "C:\\ffmpeg\\bin\\ffmpeg.exe"
  ].filter(Boolean);
}

async function executableExists(filePath) {
  try {
    await access(filePath, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

async function findOnPath() {
  const command = process.platform === "win32" ? "where.exe" : "which";
  return await new Promise(resolve => {
    const child = spawn(command, [process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg"], {
      windowsHide: true,
      stdio: ["ignore", "pipe", "ignore"]
    });
    let output = "";
    child.stdout.on("data", chunk => { output += chunk.toString(); });
    child.on("error", () => resolve(""));
    child.on("close", code => {
      if (code !== 0) return resolve("");
      resolve(output.split(/\r?\n/).map(item => item.trim()).find(Boolean) || "");
    });
  });
}

function normalizeHeaders(headers = {}) {
  const safe = [];
  for (const [name, value] of Object.entries(headers || {})) {
    const headerName = String(name || "").trim();
    const headerValue = String(value || "").replace(/[\r\n]+/g, " ").trim();
    if (!headerName || !headerValue) continue;
    if (!/^[A-Za-z0-9-]+$/.test(headerName)) continue;
    if (/^(host|content-length)$/i.test(headerName)) continue;
    safe.push(`${headerName}: ${headerValue}`);
  }
  return safe;
}

async function sizeOf(filePath) {
  try {
    return String((await stat(filePath)).size);
  } catch {
    return "0";
  }
}

export class FfmpegDownloader {
  constructor({ configuredPath = "" } = {}) {
    this.configuredPath = configuredPath;
    this.executable = null;
    this.jobs = new Map();
  }

  async resolveExecutable() {
    if (this.executable) return this.executable;
    for (const filePath of candidatePaths(this.configuredPath)) {
      if (await executableExists(filePath)) {
        this.executable = filePath;
        return filePath;
      }
    }
    const fromPath = await findOnPath();
    if (fromPath) {
      this.executable = fromPath;
      return fromPath;
    }
    return "";
  }

  async start({ taskId, url, headers = {}, outputPath }) {
    const executable = await this.resolveExecutable();
    if (!executable) {
      throw new Error("浏览器已嗅探到 HLS/DASH，但本机未找到 FFmpeg。请安装 FFmpeg，或在 config.json 的 ffmpegPath 中填写 ffmpeg.exe 路径");
    }
    if (this.jobs.has(taskId)) throw new Error("该任务已有 FFmpeg 下载进程");
    await mkdir(path.dirname(outputPath), { recursive: true });
    const headerLines = normalizeHeaders(headers);
    const args = ["-nostdin", "-y", "-hide_banner", "-loglevel", "warning"];
    if (headerLines.length) args.push("-headers", `${headerLines.join("\r\n")}\r\n`);
    args.push(
      "-i", url,
      "-map", "0:v?",
      "-map", "0:a?",
      "-c", "copy",
      "-movflags", "+faststart",
      outputPath
    );

    const child = spawn(executable, args, {
      windowsHide: true,
      stdio: ["ignore", "ignore", "pipe"]
    });
    const job = {
      taskId,
      child,
      pid: child.pid || null,
      outputPath,
      status: "active",
      errorMessage: "",
      stderr: "",
      startedAt: Date.now()
    };
    this.jobs.set(taskId, job);
    child.stderr.on("data", chunk => {
      job.stderr = `${job.stderr}${chunk.toString()}`.slice(-16000);
    });
    child.on("error", error => {
      job.status = "error";
      job.errorMessage = error.message;
    });
    child.on("close", code => {
      if (job.status === "error") return;
      if (code === 0) {
        job.status = "complete";
      } else {
        job.status = "error";
        const detail = job.stderr.trim().split(/\r?\n/).slice(-6).join(" | ");
        job.errorMessage = detail || `FFmpeg 退出码 ${code}`;
      }
    });
    return { pid: job.pid };
  }

  async tellStatus(taskId) {
    const job = this.jobs.get(taskId);
    if (!job) return null;
    return {
      status: job.status,
      completedLength: await sizeOf(job.outputPath),
      totalLength: "0",
      downloadSpeed: "0",
      errorMessage: job.errorMessage,
      pid: job.pid
    };
  }

  async forget(taskId, { kill = false } = {}) {
    const job = this.jobs.get(taskId);
    if (!job) return;
    if (kill && job.status === "active") {
      try { job.child.kill("SIGTERM"); } catch {}
    }
    this.jobs.delete(taskId);
  }
}
