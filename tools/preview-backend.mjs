// Isolated ledger copy; real media are only read, never changed by this preview.
import { copyFile, mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { SQLiteStore } from "../src/sqlite-store.mjs";
import { Scheduler } from "../src/scheduler.mjs";
import { FfmpegDownloader } from "../src/ffmpeg-downloader.mjs";
import { createServer } from "../src/server.mjs";

const config = JSON.parse(await readFile(path.resolve(import.meta.dirname, "../config.json"), "utf8"));
const root = process.argv[2];
if (!root || !path.isAbsolute(root)) throw new Error("Provide an absolute private validation directory");
await mkdir(root, { recursive: true });
await copyFile(process.argv[3], path.join(root, "ledger.sqlite"));
const store = new SQLiteStore({ filePath: path.join(root, "ledger.sqlite"), backupRoot: path.join(root, "backups"), legacyJsonPath: path.join(root, "none.json") });
await store.load();
const aria2 = { listStatuses: async () => [], forget: async () => {}, tellStatus: async () => ({ status: "removed" }) };
const scheduler = new Scheduler({ store, aria2, config: { ...config, stagingRoot: path.join(root, "staging") } });
const ffmpeg = new FfmpegDownloader({ configuredPath: config.ffmpegPath || "" });
const service = createServer({ scheduler, host: "127.0.0.1", port: 18878, ffmpeg, onShutdown: () => void stop() });
await service.listen(); console.log("Isolated preview listening on 18878");
async function stop() { await service.close(); store.close(); process.exit(0); }
process.on("SIGINT", () => void stop()); process.on("SIGTERM", () => void stop());
