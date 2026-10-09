import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, stat, writeFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { FfmpegDownloader } from "../src/ffmpeg-downloader.mjs";
import { TranscodeCache } from "../src/transcode-cache.mjs";

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { windowsHide: true, stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on("data", chunk => { stderr += chunk.toString(); });
    child.on("error", reject);
    child.on("close", code => code === 0 ? resolve() : reject(new Error(stderr || `exit ${code}`)));
  });
}

test("remote transcode cache creates a 480p H264/AAC MP4 and reuses it", async t => {
  const ffmpeg = new FfmpegDownloader();
  const executable = await ffmpeg.resolveExecutable();
  if (!executable) {
    t.skip("FFmpeg unavailable");
    return;
  }
  const temp = await mkdtemp(path.join(tmpdir(), "iwara-transcode-test-"));
  try {
    const input = path.join(temp, "input.mp4");
    await run(executable, [
      "-hide_banner", "-loglevel", "error", "-y",
      "-f", "lavfi", "-i", "testsrc=size=1280x720:rate=25",
      "-f", "lavfi", "-i", "sine=frequency=1000:sample_rate=48000",
      "-t", "2", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", input
    ]);
    const cache = new TranscodeCache({ ffmpeg, root: path.join(temp, "cache"), maxAgeMs: 0 });
    await cache.init();
    const scheduler = { mediaPath: async () => ({ path: input, name: "input.mp4" }) };
    const first = await cache.get("smoke-video", scheduler);
    const firstInfo = await stat(first.path);
    assert.equal(first.name, "input.480p.mp4");
    assert.ok(firstInfo.size > 1024);
    const second = await cache.get("smoke-video", scheduler);
    assert.equal(second.path, first.path);
    const probe = await readFile(first.path, { encoding: "latin1" });
    assert.ok(probe.includes("ftyp"));
    cache.close();
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

async function fakeFixture(work, options = {}) {
  const root = await mkdtemp(path.join(tmpdir(), "iwara-cache-race-"));
  const cache = new TranscodeCache({ ffmpeg: { resolveExecutable: async () => "fake" }, root: path.join(root, "cache"), maxAgeMs: 0, ...options });
  await cache.init();
  const files = {};
  for (const name of ["a", "b"]) { files[name] = path.join(root, `${name}.mp4`); await writeFile(files[name], Buffer.alloc(2048)); }
  const scheduler = { mediaPath: async id => ({ path: files[id], name: `${id}.mp4` }) };
  try { await work(cache, scheduler); }
  finally { cache.close(); if (cache.cleanupPromise) await cache.cleanupPromise; await rm(root, { recursive: true, force: true }); }
}

test("finishing one transcode cannot remove another concurrent temporary output", () => fakeFixture(async (cache, scheduler) => {
  let release, ready; const slow = new Promise(resolve => { release = resolve; }); const started = new Promise(resolve => { ready = resolve; }); let slowPath;
  cache.run = async (exe, media, output) => { await writeFile(output, Buffer.alloc(4096)); if (media.name === "b.mp4") { slowPath = output; ready(); await slow; } return output; };
  const second = cache.get("b", scheduler); await started; const first = await cache.get("a", scheduler);
  await cache.cleanup(); assert.equal((await stat(slowPath)).size, 4096); assert.equal((await stat(first.path)).size, 4096);
  release(); const result = await second; assert.equal((await stat(result.path)).size, 4096); assert.equal(cache.activeOutputs.size, 0);
}));

test("a pinned playback output survives quota eviction until its final consumer releases", () => fakeFixture(async (cache, scheduler) => {
  cache.run = async (exe, media, output) => { await writeFile(output, Buffer.alloc(4096)); return output; };
  const first = await cache.acquire("a", scheduler); const second = await cache.acquire("a", scheduler);
  await cache.cleanup(); assert.equal((await stat(first.media.path)).size, 4096);
  first.release(); first.release(); await cache.cleanup(); assert.equal(cache.pins.get(first.media.path), 1);
  second.release(); await cache.cleanup(); await assert.rejects(stat(first.media.path), { code: "ENOENT" });
  assert.equal(cache.pins.size, 0);
}, { maxBytes: 1 }));

test("startup removes only abandoned parts and failures release pins and temporary outputs", () => fakeFixture(async (cache, scheduler) => {
  const abandoned = path.join(cache.root, "old.part-123.mp4"); await writeFile(abandoned, Buffer.alloc(4096)); await cache.init(); await assert.rejects(stat(abandoned), { code: "ENOENT" });
  cache.run = async (exe, media, output) => { await writeFile(output, Buffer.alloc(2048)); throw new Error("injected encoder error"); };
  await assert.rejects(cache.acquire("a", scheduler), /encoder error/); assert.equal(cache.pins.size, 0); assert.equal(cache.activeOutputs.size, 0);
  assert.equal((await readdir(cache.root)).length, 0);
}));

test("closing cache rejects queued work and kills active encoding without leaked pins", () => fakeFixture(async (cache, scheduler) => {
  let ready; const started = new Promise(resolve => { ready = resolve; });
  cache.run = (exe, media, output) => new Promise((resolve, reject) => { cache.processes.add({ kill: () => reject(new Error("encoder stopped")) }); ready(); });
  const first = cache.acquire("a", scheduler).catch(error => error); await started;
  const second = cache.acquire("b", scheduler).catch(error => error); await new Promise(resolve => setImmediate(resolve));
  cache.close(); assert.match((await first).message, /stopped/); assert.match((await second).message, /关闭/); assert.equal(cache.pins.size, 0); assert.equal(cache.activeOutputs.size, 0);
}, { concurrency: 1 }));
