import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
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
