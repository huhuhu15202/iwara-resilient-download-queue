// Read-only paired thumbnail benchmark: same files, seek positions and workers.
import { readFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import { CoverCache } from "../src/cover-cache.mjs";
import { FfmpegDownloader } from "../src/ffmpeg-downloader.mjs";
const config = JSON.parse(await readFile(path.resolve(import.meta.dirname, "../config.json"), "utf8"));
const db = new DatabaseSync(path.join(config.dataRoot, "ledger.sqlite"), { readOnly: true });
const data = await (await fetch("http://127.0.0.1:18777/api/playlist?page=55&pageSize=8")).json();
const files = new Map(data.items.map(item => [item.id, JSON.parse(db.prepare("SELECT data_json FROM tasks WHERE id=?").get(item.id).data_json).destination])); db.close();
const scheduler = { mediaPath: async id => ({ path: files.get(id) }) };
const ffmpeg = new FfmpegDownloader({ configuredPath: config.ffmpegPath || "" });
const baseline = (exe, file, seconds, processes) => new Promise(resolve => {
  const child = spawn(exe, ["-nostdin", "-hide_banner", "-loglevel", "error", "-ss", String(seconds), "-i", file, "-frames:v", "1", "-vf", "scale=640:-2", "-q:v", "5", "-f", "image2pipe", "-vcodec", "mjpeg", "pipe:1"], { windowsHide: true, stdio: ["ignore", "pipe", "ignore"] });
  processes.add(child); const chunks = []; child.stdout.on("data", chunk => chunks.push(chunk)); child.on("error", () => resolve(null)); child.on("close", code => { processes.delete(child); resolve(code === 0 && chunks.length ? Buffer.concat(chunks) : null); });
});
for (const variant of ["baseline", "optimized"]) {
  const cache = new CoverCache({ ffmpeg, random: () => .3, ...(variant === "baseline" ? { capture: baseline } : {}) });
  const samples = []; let index = 0; const ids = [...files.keys()]; const started = performance.now();
  try {
    await Promise.all(Array.from({ length: 2 }, async () => { while (index < ids.length) { const id = ids[index++], start = performance.now(); const image = await cache.get(id, scheduler); samples.push({ ms: performance.now() - start, bytes: image.length }); } }));
    const times = samples.map(item => item.ms).sort((a,b) => a-b);
    console.log(JSON.stringify({ variant, count: samples.length, totalMs: Math.round(performance.now()-started), medianMs: Math.round(times[Math.floor(times.length/2)]), averageBytes: Math.round(samples.reduce((sum,item)=>sum+item.bytes,0)/samples.length) }));
  } finally { cache.clear(); }
}
