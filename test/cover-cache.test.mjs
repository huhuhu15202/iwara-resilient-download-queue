import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { CoverCache, mp4Duration } from "../src/cover-cache.mjs";
import { FfmpegDownloader } from "../src/ffmpeg-downloader.mjs";

function box(type, payload) { const header = Buffer.alloc(8); header.writeUInt32BE(payload.length + 8); header.write(type, 4); return Buffer.concat([header, payload]); }
function movie(seconds = 2, version = 0) {
  const header = Buffer.alloc(version === 1 ? 32 : 20); header[0] = version;
  header.writeUInt32BE(1000, version === 1 ? 20 : 12);
  if (version === 1) header.writeBigUInt64BE(BigInt(seconds * 1000), 24); else header.writeUInt32BE(seconds * 1000, 16);
  return Buffer.concat([box("ftyp", Buffer.from("isom")), box("mdat", Buffer.alloc(128)), box("moov", box("mvhd", header))]);
}
async function fixture(work, options = {}) {
  const root = await mkdtemp(path.join(tmpdir(), "iwara-cover-"));
  const files = {}; for (const id of ["a", "b", "c", "d"]) { files[id] = path.join(root, id + ".mp4"); await writeFile(files[id], movie()); }
  const scheduler = { mediaPath: async id => ({ path: files[id], name: id + ".mp4" }) };
  const cache = new CoverCache({ ffmpeg: { resolveExecutable: async () => "fake" }, capture: async () => Buffer.from([255, 216, 255, 217]), ...options });
  try { await work(cache, scheduler, files); }
  finally { cache.clear(); await Promise.allSettled([...cache.pending.values()].map(entry => entry.job.promise)); await rm(root, { recursive: true, force: true }); }
}

test("MP4 duration reads tail moov and both mvhd versions without reading payload", () => fixture(async (cache, scheduler, files) => {
  assert.equal(await mp4Duration(files.a), 2); await writeFile(files.b, movie(9, 1)); assert.equal(await mp4Duration(files.b), 9);
  await writeFile(files.c, Buffer.from("invalid")); assert.equal(await mp4Duration(files.c), null);
}));

test("short covers use a valid random timestamp, reuse cache and invalidate modified files", () => fixture(async (cache, scheduler, files) => {
  const seeks = []; cache.capture = async (exe, file, seconds) => { seeks.push(seconds); return Buffer.from([255, 216, 255, 217]); };
  const first = await cache.get("a", scheduler); assert.equal(await cache.get("a", scheduler), first); assert.equal(seeks.length, 1); assert.ok(seeks[0] > 0 && seeks[0] < 2);
  await writeFile(files.a, movie(3)); await cache.get("a", scheduler); assert.equal(seeks.length, 2); assert.equal(cache.cache.size, 1);
}));

test("visible covers take precedence over queued distant covers, with bounded workers", () => fixture(async (cache, scheduler) => {
  let release, start; const started = new Promise(resolve => { start = resolve; }); const gate = new Promise(resolve => { release = resolve; }); const order = [];
  cache.capture = async (exe, file) => { const name = path.basename(file); order.push(name); if (name === "a.mp4") { start(); await gate; } return Buffer.from([255, 216]); };
  const first = cache.get("a", scheduler); await started;
  const distant = cache.get("b", scheduler); const visible = cache.get("c", scheduler, { priority: 1 });
  while (cache.queue.length < 2) await new Promise(resolve => setImmediate(resolve));
  assert.equal(cache.active, 1); release(); await Promise.all([first, distant, visible]); assert.deepEqual(order, ["a.mp4", "c.mp4", "b.mp4"]);
}, { concurrency: 1, limit: 2 }));

test("abandoned queued cover is canceled but a shared request remains usable", () => fixture(async (cache, scheduler) => {
  let release, start; const started = new Promise(resolve => { start = resolve; }); const gate = new Promise(resolve => { release = resolve; }); const order = [];
  cache.capture = async (exe, file) => { order.push(path.basename(file)); if (file.endsWith("a.mp4")) { start(); await gate; } return Buffer.from([255, 216]); };
  const first = cache.get("a", scheduler); await started;
  const controller = new AbortController(); const abandoned = cache.get("b", scheduler, { signal: controller.signal }).catch(error => error);
  while (cache.queue.length < 1) await new Promise(resolve => setImmediate(resolve)); controller.abort(); assert.match((await abandoned).message, /取消/);
  const sharedController = new AbortController(); const canceledShared = cache.get("c", scheduler, { signal: sharedController.signal }).catch(error => error); const liveShared = cache.get("c", scheduler);
  while (cache.queue.length < 1 || [...cache.pending.values()].at(-1)?.consumers.size < 2) await new Promise(resolve => setImmediate(resolve));
  sharedController.abort(); assert.match((await canceledShared).message, /取消/); release(); await first; assert.ok((await liveShared).length); assert.deepEqual(order, ["a.mp4", "c.mp4"]);
}, { concurrency: 1 }));

test("shutdown during executable resolution cannot launch another capture", () => fixture(async (cache, scheduler) => {
  let release, start; const started = new Promise(resolve => { start = resolve; }); const gate = new Promise(resolve => { release = resolve; }); let captures = 0;
  cache.ffmpeg.resolveExecutable = async () => { start(); await gate; return "fake"; }; cache.capture = async () => { captures++; return Buffer.from([255, 216]); };
  const work = cache.get("a", scheduler).catch(error => error); await started; cache.clear(); release(); assert.match((await work).message, /关闭/); assert.equal(captures, 0); await assert.rejects(cache.get("b", scheduler), /关闭/);
}));

test("real FFmpeg generates a JPEG from a short MP4 and leaves no cover files", async t => {
  const ffmpeg = new FfmpegDownloader(); const exe = await ffmpeg.resolveExecutable(); if (!exe) { t.skip("FFmpeg unavailable"); return; }
  const root = await mkdtemp(path.join(tmpdir(), "iwara-cover-real-")); const input = path.join(root, "short.mp4"); const cache = new CoverCache({ ffmpeg });
  try {
    await new Promise((resolve, reject) => { const child = spawn(exe, ["-nostdin", "-loglevel", "error", "-f", "lavfi", "-i", "testsrc=size=640x360:rate=10", "-t", "1", "-c:v", "libx264", "-pix_fmt", "yuv420p", input], { windowsHide: true, stdio: "ignore" }); child.on("error", reject); child.on("close", code => code === 0 ? resolve() : reject(Error("fixture encoder failed"))); });
    assert.equal(await mp4Duration(input), 1); const image = await cache.get("real", { mediaPath: async () => ({ path: input }) }); assert.equal(image.readUInt16BE(0), 0xffd8); assert.ok(image.length > 1024);
  } finally { cache.clear(); await rm(root, { recursive: true, force: true }); }
});

test("real FFmpeg bakes anamorphic portrait SAR into cover pixels", async t => {
  const ffmpeg = new FfmpegDownloader(); const exe = await ffmpeg.resolveExecutable(); if (!exe) { t.skip("FFmpeg unavailable"); return; }
  const root = await mkdtemp(path.join(tmpdir(), "iwara-cover-sar-")); const input = path.join(root, "portrait-sar.mp4"); const cache = new CoverCache({ ffmpeg });
  try {
    await new Promise((resolve, reject) => {
      const child = spawn(exe, ["-nostdin", "-loglevel", "error", "-f", "lavfi", "-i", "testsrc=size=640x360:rate=10", "-vf", "setsar=81/256", "-t", "1", "-c:v", "libx264", "-pix_fmt", "yuv420p", input], { windowsHide: true, stdio: "ignore" });
      child.on("error", reject); child.on("close", code => code === 0 ? resolve() : reject(Error("SAR fixture encoder failed")));
    });
    const image = await cache.get("portrait", { mediaPath: async () => ({ path: input }) });
    assert.equal(image.readUInt16BE(0), 0xffd8);
    const dimensions = (() => {
      for (let offset = 2; offset < image.length - 9;) {
        if (image[offset++] !== 0xff) continue;
        while (image[offset] === 0xff) offset++;
        const marker = image[offset++];
        if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker)) {
          return { width: image.readUInt16BE(offset + 5), height: image.readUInt16BE(offset + 3) };
        }
        if (marker !== 0xd8 && marker !== 0xd9 && (marker < 0xd0 || marker > 0xd7) && marker !== 0x01) offset += image.readUInt16BE(offset);
      }
      return null;
    })();
    assert.ok(dimensions, "generated JPEG should declare its dimensions");
    assert.ok(dimensions.height > dimensions.width, `portrait display aspect should yield portrait JPEG, got ${dimensions.width}x${dimensions.height}`);
  } finally { cache.clear(); await rm(root, { recursive: true, force: true }); }
});
