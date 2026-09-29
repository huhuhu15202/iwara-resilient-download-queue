import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { networkInterfaces } from "node:os";
import path from "node:path";
import { Aria2Client } from "./aria2-client.mjs";
import { SQLiteStore } from "./sqlite-store.mjs";
import { Scheduler } from "./scheduler.mjs";
import { FfmpegDownloader } from "./ffmpeg-downloader.mjs";
import { TranscodeCache } from "./transcode-cache.mjs";
import { createServer } from "./server.mjs";

const appRoot = path.resolve(import.meta.dirname, "..");
const defaultDataRoot = "F:\\IwaraVideos\\R18\\ServiceData";
const defaultDownloadRoot = "F:\\Video";
const defaultEngine = "C:\\Program Files\\MotrixNext\\motrix-next-engine.exe";
const configOverride = String(process.env.IWARA_CONFIG_PATH || "").trim()
  ? path.resolve(String(process.env.IWARA_CONFIG_PATH).trim())
  : "";
const envValue = name => String(process.env[name] || "").trim();

async function exists(filePath) {
  try {
    await access(filePath, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function isLoopbackHost(host = "") {
  const value = String(host || "").trim().toLowerCase();
  return value === "127.0.0.1" || value === "localhost" || value === "::1" || value === "[::1]";
}

function localLanAddresses() {
  const addresses = [];
  for (const entries of Object.values(networkInterfaces())) {
    for (const entry of entries || []) {
      if (!entry || entry.internal) continue;
      const address = String(entry.address || "").trim();
      if (!address || address.includes(":")) continue;
      if (/^(10|192\.168|169\.254)\./.test(address) || /^172\.(1[6-9]|2[0-9]|3[0-1])\./.test(address)) {
        addresses.push(address);
      }
    }
  }
  return [...new Set(addresses)];
}

async function loadConfig() {
  const defaults = {
    dataRoot: envValue("IWARA_DATA_ROOT") || defaultDataRoot,
    downloadRoot: envValue("IWARA_DOWNLOAD_ROOT") || defaultDownloadRoot,
    enginePath: envValue("IWARA_ENGINE_PATH") || defaultEngine,
    serviceHost: "127.0.0.1",
    servicePort: 18777,
    aria2Port: 16801,
    aria2Secret: randomBytes(18).toString("hex"),
    maxAttempts: 6,
    maxConcurrentTasks: 3,
    // Download slots are independent from metadata enrichment slots. Keep
    // legacy imported-file author/date backfill paused unless explicitly
    // enabled; tag and view refreshes remain separately available.
    // Metadata/tag/view refreshes use the browser script's bounded 8-worker
    // pool and never consume the three download slots.
    maxConcurrentMetadataTasks: 8,
    importedMetadataEnrichmentEnabled: false,
    mediaReconcileIntervalMs: 300000,
    mediaReconcileBatchSize: 50,
    retryDelayMs: 3000,
    leaseMs: 120000,
    stallMs: 180000,
    pollMs: 1000,
    metadataMaxAttempts: 3,
    metadataRetryDelayMs: 60000,
    browserFallbackEnabled: true,
    browserFallbackTimeoutMs: 45000,
    minValidMediaBytes: 65536,
    ffmpegPath: "",
    remoteTranscodeEnabled: true,
    remoteTranscodeHeight: 480,
    remoteTranscodeConcurrency: 2,
    remoteTranscodeCacheMaxBytes: 20 * 1024 * 1024 * 1024,
    remoteTranscodeCacheMaxAgeMs: 24 * 60 * 60 * 1000,
    // Keep the service loopback-only by default.  When serviceHost is changed
    // to 0.0.0.0 or a LAN address, a persistent token protects non-loopback
    // clients from download-management actions.
    lanAccessToken: ""
  };
  const candidates = configOverride
    ? [configOverride]
    : [path.join(appRoot, "config.json"), path.join(defaults.dataRoot, "config.json")];
  let configPath = configOverride || path.join(appRoot, "config.json");
  let current = {};
  for (const candidate of candidates) {
    try {
      current = JSON.parse(await readFile(candidate, "utf8"));
      configPath = candidate;
      break;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
  const merged = { ...defaults, ...(current && typeof current === "object" ? current : {}) };
  const envOverrides = {
    dataRoot: "IWARA_DATA_ROOT",
    downloadRoot: "IWARA_DOWNLOAD_ROOT",
    enginePath: "IWARA_ENGINE_PATH",
    serviceHost: "IWARA_SERVICE_HOST",
    ffmpegPath: "IWARA_FFMPEG_PATH"
  };
  for (const [key, name] of Object.entries(envOverrides)) {
    const value = envValue(name);
    if (value) merged[key] = value;
  }
  for (const [key, name] of [["servicePort", "IWARA_SERVICE_PORT"], ["aria2Port", "IWARA_ARIA2_PORT"]]) {
    const value = Number(envValue(name));
    if (Number.isInteger(value) && value > 0) merged[key] = value;
  }
  const missingDefault = Object.keys(defaults).some(key => !(key in current));
  let shouldWriteConfig = !Object.keys(current).length || missingDefault;
  if (!isLoopbackHost(merged.serviceHost) && !String(merged.lanAccessToken || "").trim()) {
    merged.lanAccessToken = randomBytes(24).toString("hex");
    shouldWriteConfig = true;
  }
  merged.dataRoot = path.resolve(appRoot, String(merged.dataRoot || defaultDataRoot));
  merged.downloadRoot = path.resolve(appRoot, String(merged.downloadRoot || defaultDownloadRoot));
  merged.enginePath = path.resolve(appRoot, String(merged.enginePath || defaultEngine));
  await mkdir(merged.dataRoot, { recursive: true });
  await mkdir(path.dirname(configPath), { recursive: true });
  if (shouldWriteConfig) {
    await writeFile(configPath, JSON.stringify(merged, null, 2), "utf8");
  }
  return merged;
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
  const dataRoot = config.dataRoot;
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
  const transcodeCache = config.remoteTranscodeEnabled === false ? null : new TranscodeCache({
    ffmpeg,
    root: path.join(dataRoot, "transcode-cache", "480p"),
    height: config.remoteTranscodeHeight,
    concurrency: config.remoteTranscodeConcurrency,
    maxBytes: config.remoteTranscodeCacheMaxBytes,
    maxAgeMs: config.remoteTranscodeCacheMaxAgeMs
  });
  await transcodeCache?.init();
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
    accessToken: config.lanAccessToken,
    ffmpeg,
    transcodeCache,
    onShutdown: shutdown
  });
  await httpServer.listen();
  console.log(`Iwara 稳定下载队列：http://127.0.0.1:${config.servicePort}/`);
  if (!isLoopbackHost(config.serviceHost)) {
    const token = encodeURIComponent(String(config.lanAccessToken || ""));
    const urls = localLanAddresses().map(address => `http://${address}:${config.servicePort}/playlist?access_token=${token}`);
    console.log(`局域网播放令牌已启用；请仅在可信局域网内使用以下链接：`);
    if (urls.length) urls.forEach(url => console.log(`局域网播放：${url}`));
    else console.log(`局域网播放：http://<本机局域网IP>:${config.servicePort}/playlist?access_token=${token}`);
  }
  console.log(`下载目录：${config.downloadRoot}`);
  console.log(`已有文件扫描：${importSummary.scanned}，新建档：${importSummary.imported}，未识别：${importSummary.unmatched}`);
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch(error => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
