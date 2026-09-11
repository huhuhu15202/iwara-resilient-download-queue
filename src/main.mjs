import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import path from "node:path";
import { Aria2Client } from "./aria2-client.mjs";
import { SQLiteStore } from "./sqlite-store.mjs";
import { Scheduler } from "./scheduler.mjs";
import { FfmpegDownloader } from "./ffmpeg-downloader.mjs";
import { createServer } from "./server.mjs";

const appRoot = path.resolve(import.meta.dirname, "..");
const dataRoot = "F:\\IwaraVideos\\R18\\ServiceData";
const configPath = path.join(dataRoot, "config.json");
const defaultEngine = "C:\\Program Files\\MotrixNext\\motrix-next-engine.exe";

async function exists(filePath) {
  try {
    await access(filePath, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

async function loadConfig() {
  await mkdir(dataRoot, { recursive: true });
  const defaults = {
    serviceHost: "127.0.0.1",
    servicePort: 18777,
    aria2Port: 16801,
    aria2Secret: randomBytes(18).toString("hex"),
    enginePath: defaultEngine,
    downloadRoot: "F:\\Video",
    maxAttempts: 6,
    maxConcurrentTasks: 3,
    retryDelayMs: 3000,
    leaseMs: 120000,
    stallMs: 180000,
    pollMs: 1000,
    metadataMaxAttempts: 3,
    metadataRetryDelayMs: 60000,
    browserFallbackEnabled: true,
    browserFallbackTimeoutMs: 45000,
    minValidMediaBytes: 65536,
    ffmpegPath: ""
  };
  try {
    const current = JSON.parse(await readFile(configPath, "utf8"));
    const merged = { ...defaults, ...current };
    if (Object.keys(defaults).some(key => !(key in current))) {
      await writeFile(configPath, JSON.stringify(merged, null, 2), "utf8");
    }
    return merged;
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    await writeFile(configPath, JSON.stringify(defaults, null, 2), "utf8");
    return defaults;
  }
}

async function waitForAria2(client, timeoutMs = 12000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      return await client.getVersion();
    } catch {
      await new Promise(resolve => setTimeout(resolve, 250));
    }
  }
  throw new Error("无法连接独立 aria2 内核");
}

async function main() {
  const config = await loadConfig();
  if (!await exists(config.enginePath)) {
    throw new Error(`找不到 Motrix Next 下载内核：${config.enginePath}`);
  }
  const aria2Url = `http://127.0.0.1:${config.aria2Port}/jsonrpc`;
  const aria2 = new Aria2Client({ url: aria2Url, secret: config.aria2Secret });
  let engine = null;
  try {
    await aria2.getVersion();
    console.log("已连接现有独立下载内核");
  } catch {
    engine = spawn(config.enginePath, [
      "--enable-rpc=true",
      "--rpc-listen-all=false",
      `--rpc-listen-port=${config.aria2Port}`,
      `--rpc-secret=${config.aria2Secret}`,
      `--max-concurrent-downloads=${config.maxConcurrentTasks}`,
      "--split=1",
      "--max-connection-per-server=1",
      "--max-tries=1",
      "--retry-wait=1",
      "--continue=false",
      "--auto-file-renaming=false",
      "--allow-overwrite=true",
      "--file-allocation=none",
      "--console-log-level=warn"
    ], { windowsHide: true, stdio: "ignore" });
    await waitForAria2(aria2);
    console.log("独立下载内核已启动");
  }
  await aria2.changeGlobalOption({
    "max-concurrent-downloads": String(config.maxConcurrentTasks)
  });

  const store = new SQLiteStore({
    filePath: path.join(dataRoot, "ledger.sqlite"),
    legacyJsonPath: path.join(dataRoot, "state.json"),
    backupRoot: path.join(dataRoot, "backups")
  });
  await store.load();
  const importSummary = await store.importExistingFiles(config.downloadRoot);
  const ffmpeg = new FfmpegDownloader({ configuredPath: config.ffmpegPath || "" });
  const scheduler = new Scheduler({
    store,
    aria2,
    ffmpeg,
    config: {
      ...config,
      stagingRoot: path.join(dataRoot, "staging")
    }
  });
  await scheduler.init();
  await store.createDailyBackup();
  scheduler.start();
  let stopping = false;
  let httpServer;
  const shutdown = async () => {
    if (stopping) return;
    stopping = true;
    scheduler.stop();
    await httpServer?.close();
    if (engine) {
      try { await aria2.call("shutdown"); } catch {}
    }
    store.close();
    process.exit(0);
  };
  httpServer = createServer({
    scheduler,
    host: config.serviceHost,
    port: config.servicePort,
    onShutdown: shutdown
  });
  await httpServer.listen();
  console.log(`Iwara 稳定下载队列：http://${config.serviceHost}:${config.servicePort}/`);
  console.log(`下载目录：${config.downloadRoot}`);
  console.log(`已有文件扫描：${importSummary.scanned}，新建档：${importSummary.imported}，未识别：${importSummary.unmatched}`);
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch(error => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
