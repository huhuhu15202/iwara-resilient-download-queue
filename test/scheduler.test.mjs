import assert from "node:assert/strict";
import { copyFile, mkdtemp, open, rename, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, test } from "node:test";
import {
  Scheduler,
  classifyError,
  isPermanentErrorCategory,
  mediaFileValidation,
  moveFileSafely
} from "../src/scheduler.mjs";
import { SQLiteStore } from "../src/sqlite-store.mjs";
import { mediaContentType } from "../src/server.mjs";

async function tempRoot(prefix = "iwara-test-") {
  return mkdtemp(path.join(tmpdir(), prefix));
}

function task(overrides = {}) {
  return {
    id: "task-1",
    videoId: "video-abc",
    sourcePage: "https://www.iwara.tv/video/video-abc",
    title: "测试视频",
    author: "作者",
    alias: "作者",
    state: "queued",
    attempts: 0,
    resolveFailures: 0,
    nextRunAt: 0,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    message: "等待浏览器解析",
    gid: null,
    downloadEngine: null,
    browserFallbackPending: false,
    browserFallbackAttempted: false,
    ...overrides
  };
}

function store(tasks = []) {
  const events = [];
  return {
    loaded: true,
    state: { tasks },
    events,
    saves: 0,
    async save() { this.saves += 1; },
    recordAttempt(current, event) { events.push({ taskId: current.id, ...event }); },
    failedSourceHosts() { return []; },
    counts() {
      const result = { queued: 0, resolving: 0, downloading: 0, finalizing: 0, completed: 0, failed: 0 };
      for (const current of this.state.tasks) result[current.state] = (result[current.state] || 0) + 1;
      return result;
    },
    authors() { return []; },
    authorCategory() { return ""; },
    authorCategoryRules() { return []; },
    queryTasks() { return { total: this.state.tasks.length, page: 1, pageSize: 50, tasks: this.state.tasks }; }
  };
}

function aria2() {
  let sequence = 0;
  const statuses = new Map();
  return {
    statuses,
    forgotten: [],
    async addUri(url, options) {
      const gid = `gid-${++sequence}`;
      statuses.set(gid, {
        gid, url, options, status: "active", totalLength: "100", completedLength: "0", downloadSpeed: "0"
      });
      return gid;
    },
    async tellStatus(gid) {
      if (!statuses.has(gid)) throw new Error("unknown gid");
      return statuses.get(gid);
    },
    async forget(gid) { this.forgotten.push(gid); statuses.delete(gid); },
    async listStatuses() { return [...statuses.values()]; }
  };
}

function scheduler(tasks = [], overrides = {}) {
  const root = overrides.root || "C:\\iwara-test";
  const currentStore = store(tasks);
  const currentAria2 = aria2();
  const current = new Scheduler({
    store: currentStore,
    aria2: currentAria2,
    ffmpeg: null,
    clock: { now: () => 1000 },
    config: {
      stagingRoot: path.join(root, "staging"),
      downloadRoot: path.join(root, "Video"),
      maxAttempts: 2,
      maxConcurrentTasks: 3,
      retryDelayMs: 10,
      leaseMs: 100,
      stallMs: 100,
      metadataMaxAttempts: 2,
      metadataRetryDelayMs: 10,
      browserFallbackEnabled: true,
      browserFallbackTimeoutMs: 100,
      minValidMediaBytes: 1024,
      ...overrides
    }
  });
  return { current, currentStore, currentAria2 };
}

describe("error classification", () => {
  test("HTTP 404 is not_found", () => assert.equal(classifyError("HTTP 404 Not Found"), "not_found"));
  test("Chinese missing page is not_found", () => assert.equal(classifyError("视频不存在"), "not_found"));
  test("HTTP 403 is access_or_expired", () => assert.equal(classifyError("HTTP 403 Forbidden"), "access_or_expired"));
  test("expired URL is access_or_expired", () => assert.equal(classifyError("signed URL expired"), "access_or_expired"));
  test("TLS hostname failure is tls_certificate", () => assert.equal(classifyError("hostname mismatch"), "tls_certificate"));
  test("timeout is timeout", () => assert.equal(classifyError("download timeout"), "timeout"));
  test("network failure is network", () => assert.equal(classifyError("socket connect failed"), "network"));
  test("not_found and access_or_expired are terminal categories", () => {
    assert.equal(isPermanentErrorCategory("not_found"), true);
    assert.equal(isPermanentErrorCategory("access_or_expired"), true);
    assert.equal(isPermanentErrorCategory("network"), false);
  });
});

describe("media formats", () => {
  test("MIME maps supported extensions", () => {
    assert.equal(mediaContentType("x.mp4"), "video/mp4");
    assert.equal(mediaContentType("x.webm"), "video/webm");
    assert.equal(mediaContentType("x.mkv"), "video/x-matroska");
    assert.equal(mediaContentType("x.mov"), "video/quicktime");
    assert.equal(mediaContentType("x.avi"), "video/x-msvideo");
    assert.equal(mediaContentType("x.m4v"), "video/x-m4v");
  });

  test("MIME falls back safely for unknown extension", () => assert.equal(mediaContentType("x.bin"), "application/octet-stream"));

  test("MP4/ MOV/ M4V ftyp media validates", async () => {
    const root = await tempRoot();
    try {
      for (const extension of [".mp4", ".mov", ".m4v"]) {
        const file = path.join(root, `sample${extension}`);
        await writeFile(file, Buffer.concat([Buffer.from([0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70]), Buffer.alloc(2048)]));
        assert.equal((await mediaFileValidation(file, "0", 1024)).status, "present");
      }
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  test("WebM and MKV EBML media validates", async () => {
    const root = await tempRoot();
    try {
      for (const extension of [".webm", ".mkv"]) {
        const file = path.join(root, `sample${extension}`);
        await writeFile(file, Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.alloc(2048)]));
        assert.equal((await mediaFileValidation(file, "0", 1024)).status, "present");
      }
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  test("AVI RIFF media validates", async () => {
    const root = await tempRoot();
    try {
      const file = path.join(root, "sample.avi");
      await writeFile(file, Buffer.concat([Buffer.from("RIFF0000AVI ", "ascii"), Buffer.alloc(2048)]));
      assert.equal((await mediaFileValidation(file, "0", 1024)).status, "present");
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  test("missing media is reported", async () => {
    const root = await tempRoot();
    try { assert.equal((await mediaFileValidation(path.join(root, "missing.mp4"), "0", 1024)).status, "missing"); }
    finally { await rm(root, { recursive: true, force: true }); }
  });

  test("too-small media is rejected", async () => {
    const root = await tempRoot();
    try {
      const file = path.join(root, "tiny.mp4");
      await writeFile(file, Buffer.alloc(12));
      assert.equal((await mediaFileValidation(file, "0", 1024)).status, "too_small");
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  test("size mismatch is reported before signature check", async () => {
    const root = await tempRoot();
    try {
      const file = path.join(root, "mismatch.mp4");
      await writeFile(file, Buffer.concat([Buffer.from([0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70]), Buffer.alloc(2048)]));
      assert.equal((await mediaFileValidation(file, "4096", 1024)).status, "size_mismatch");
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  test("HTML/error payload is rejected as not_media", async () => {
    const root = await tempRoot();
    try {
      const file = path.join(root, "error.mp4");
      await writeFile(file, Buffer.concat([Buffer.from("<html>error</html>", "ascii"), Buffer.alloc(2048)]));
      assert.equal((await mediaFileValidation(file, "0", 1024)).status, "not_media");
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});

describe("scheduler state transitions", () => {
  test("enqueue accepts valid task and rejects invalid id", async () => {
    const { current, currentStore } = scheduler([]);
    const result = await current.enqueue([{ videoId: "abc" }, { videoId: "x" }]);
    assert.equal(result.accepted.length, 1);
    assert.equal(result.ignored.length, 1);
    assert.equal(currentStore.state.tasks[0].state, "queued");
  });

  test("enqueue rejects duplicate video id", async () => {
    const { current } = scheduler([]);
    await current.enqueue([{ videoId: "abc" }]);
    const result = await current.enqueue([{ videoId: "abc" }]);
    assert.equal(result.accepted.length, 0);
    assert.match(result.ignored[0].reason, /already recorded/);
  });

  test("leaseNext enters API resolving state", async () => {
    const currentTask = task();
    const { current } = scheduler([currentTask]);
    const lease = await current.leaseNext();
    assert.equal(lease.mode, "api");
    assert.equal(currentTask.state, "resolving");
    assert.ok(lease.leaseId);
  });

  test("leaseNext honors max concurrent tasks", async () => {
    const tasks = [task({ id: "a", videoId: "aaa" }), task({ id: "b", videoId: "bbb" }), task({ id: "c", videoId: "ccc" }), task({ id: "d", videoId: "ddd" })];
    const { current } = scheduler(tasks, { maxConcurrentTasks: 2 });
    assert.ok(await current.leaseNext());
    assert.ok(await current.leaseNext());
    assert.equal(await current.leaseNext(), null);
  });

  test("browser fallback lease uses browser_sniff mode", async () => {
    const currentTask = task({ browserFallbackPending: true });
    const { current } = scheduler([currentTask]);
    const lease = await current.leaseNext();
    assert.equal(lease.mode, "browser_sniff");
    assert.equal(currentTask.browserFallbackAttempted, true);
  });

  test("stale resolution lease is rejected", async () => {
    const { current } = scheduler([task()]);
    await assert.rejects(() => current.submitResolution({ taskId: "missing", leaseId: "bad", ok: false, error: "x" }), /租约无效/);
  });

  test("HTTP 404 resolution fails permanently without fallback", async () => {
    const currentTask = task();
    const { current } = scheduler([currentTask]);
    const lease = await current.leaseNext();
    await current.submitResolution({ taskId: currentTask.id, leaseId: lease.leaseId, ok: false, error: "HTTP 404 Not Found" });
    assert.equal(currentTask.state, "failed");
    assert.equal(currentTask.lastErrorCategory, "not_found");
    assert.equal(currentTask.browserFallbackPending, false);
  });

  test("network resolution failure is queued for retry", async () => {
    const currentTask = task();
    const { current } = scheduler([currentTask]);
    const lease = await current.leaseNext();
    await current.submitResolution({ taskId: currentTask.id, leaseId: lease.leaseId, ok: false, error: "socket connect failed" });
    assert.equal(currentTask.state, "queued");
    assert.equal(currentTask.lastErrorCategory, "network");
    assert.ok(currentTask.nextRunAt > 1000);
  });

  test("successful resolution starts aria2 download", async () => {
    const root = await tempRoot();
    try {
      const currentTask = task();
      const { current, currentAria2 } = scheduler([currentTask], { root });
      const lease = await current.leaseNext();
      await current.submitResolution({ taskId: currentTask.id, leaseId: lease.leaseId, ok: true, video: { url: "https://cdn.example/video.mp4", fileName: "video.mp4", title: "已解析", metadata: { Author: "作者" } } });
      assert.equal(currentTask.state, "downloading");
      assert.equal(currentTask.downloadEngine, "aria2");
      assert.equal(currentAria2.statuses.size, 1);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  test("HTTP 404 download failure is terminal", async () => {
    const root = await tempRoot();
    try {
      const currentTask = task({ state: "downloading", gid: "gid-404", downloadEngine: "aria2", stagingFile: path.join(root, "bad.mp4") });
      const { current, currentAria2 } = scheduler([currentTask], { root });
      currentAria2.statuses.set("gid-404", { gid: "gid-404", status: "error", errorMessage: "HTTP 404 Not Found" });
      await current.failDownload(currentTask, "HTTP 404 Not Found");
      assert.equal(currentTask.state, "failed");
      assert.equal(currentTask.lastErrorCategory, "not_found");
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  test("ordinary attempts exhaust into browser fallback", async () => {
    const currentTask = task({ attempts: 2 });
    const { current } = scheduler([currentTask]);
    await current.retryOrFail(currentTask, "CDN failed", true);
    assert.equal(currentTask.state, "queued");
    assert.equal(currentTask.browserFallbackPending, true);
  });

  test("fallback failure becomes terminal", async () => {
    const currentTask = task({ attempts: 2, browserFallbackAttempted: true, resolved: { resolveMode: "browser_sniff" } });
    const { current } = scheduler([currentTask]);
    await current.retryOrFail(currentTask, "网页嗅探失败", true, { fallbackFailure: true });
    assert.equal(currentTask.state, "failed");
  });

  test("metadata lease enters enriching state", async () => {
    const currentTask = task({ state: "completed", destination: "C:\\video.mp4", imported: true, metadataStatus: "pending" });
    const { current } = scheduler([currentTask]);
    const lease = await current.leaseMetadataEnrichment();
    assert.equal(lease.videoId, currentTask.videoId);
    assert.equal(currentTask.metadataStatus, "enriching");
  });

  test("metadata success completes enrichment", async () => {
    const currentTask = task({ state: "completed", destination: "C:\\video.mp4", imported: true, metadataStatus: "pending" });
    const { current } = scheduler([currentTask]);
    const lease = await current.leaseMetadataEnrichment();
    await current.submitMetadataEnrichment({ taskId: currentTask.id, leaseId: lease.leaseId, ok: true, metadata: { title: "标题", author: "作者", uploadTime: "2026-01-01" } });
    assert.equal(currentTask.metadataStatus, "complete");
    assert.equal(currentTask.title, "标题");
  });

  test("metadata transient failure enters retry", async () => {
    const currentTask = task({ state: "completed", destination: "C:\\video.mp4", imported: true, metadataStatus: "pending" });
    const { current } = scheduler([currentTask]);
    const lease = await current.leaseMetadataEnrichment();
    await current.submitMetadataEnrichment({ taskId: currentTask.id, leaseId: lease.leaseId, ok: false, error: "网络失败" });
    assert.equal(currentTask.metadataStatus, "retry");
  });

  test("metadata permanent failure is retained", async () => {
    const currentTask = task({ state: "completed", destination: "C:\\video.mp4", imported: true, metadataStatus: "pending" });
    const { current } = scheduler([currentTask]);
    const lease = await current.leaseMetadataEnrichment();
    await current.submitMetadataEnrichment({ taskId: currentTask.id, leaseId: lease.leaseId, ok: false, error: "视频不存在", permanent: true });
    assert.equal(currentTask.metadataStatus, "failed");
    assert.match(currentTask.metadataMessage, /保留原文件/);
  });

  test("expired resolving lease is requeued by tick", async () => {
    const currentTask = task({ state: "resolving", leaseExpiresAt: 0, leaseId: "lease", resolveMode: "api" });
    const { current } = scheduler([currentTask]);
    await current.tick();
    assert.equal(currentTask.state, "queued");
  });

  test("playlist context returns current index and five items", async () => {
    const root = await tempRoot();
    try {
      const tasks = [];
      for (let index = 0; index < 7; index += 1) {
        const file = path.join(root, `v${index}.mp4`);
        await writeFile(file, Buffer.concat([Buffer.from([0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70]), Buffer.alloc(2048)]));
        tasks.push(task({ id: `task-${index}`, videoId: `video-${index}`, destination: file, state: "completed", updatedAt: `2026-01-0${index + 1}T00:00:00.000Z` }));
      }
      const { current } = scheduler(tasks, { root, downloadRoot: root });
      const result = await current.playlist({ contextId: "task-3", contextSize: 5 });
      assert.equal(result.items.length, 5);
      assert.equal(result.currentIndex, 2);
      assert.ok(result.items.some(item => item.id === "task-3"));
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  test("SQLite playlist uses cached media state and persists playback", async () => {
    const root = await tempRoot();
    let sqlite;
    try {
      const media = path.join(root, "cached.mp4");
      await writeFile(media, Buffer.concat([Buffer.from([0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70]), Buffer.alloc(2048)]));
      sqlite = new SQLiteStore({
        filePath: path.join(root, "ledger.sqlite"),
        legacyJsonPath: path.join(root, "state.json"),
        backupRoot: path.join(root, "backups")
      });
      await sqlite.load();
      const currentTask = task({ id: "cached-task", videoId: "cached-video", state: "completed", destination: media, fileStatus: "present", mediaCheckedAt: new Date().toISOString() });
      sqlite.state.tasks = [currentTask];
      await sqlite.save();
      const current = new Scheduler({
        store: sqlite,
        aria2: aria2(),
        config: { downloadRoot: root, maxConcurrentTasks: 3 }
      });
      const result = await current.playlist({ page: 1, pageSize: 30 });
      assert.equal(result.total, 1);
      assert.equal(result.items[0].id, "cached-task");
      await current.updatePlayback("cached-task", { position: 37.5, duration: 120, watched: false });
      assert.equal(currentTask.playbackPosition, 37.5);
      assert.equal(currentTask.watched, false);
      sqlite.close();
      sqlite = null;
      const reopened = new SQLiteStore({
        filePath: path.join(root, "ledger.sqlite"),
        legacyJsonPath: path.join(root, "state.json"),
        backupRoot: path.join(root, "backups")
      });
      await reopened.load();
      assert.equal(reopened.state.tasks[0].playbackPosition, 37.5);
      assert.equal(reopened.state.tasks[0].playbackDuration, 120);
      assert.equal(reopened.state.tasks[0].watched, false);
      reopened.close();
    } finally {
      sqlite?.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  test("moveFileSafely handles a normal rename", async () => {
    const root = await tempRoot();
    try {
      const source = path.join(root, "source.mp4");
      const destination = path.join(root, "destination.mp4");
      await writeFile(source, "ok");
      await moveFileSafely(source, destination, "task");
      assert.equal(await (await import("node:fs/promises")).readFile(destination, "utf8"), "ok");
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  test("moveFileSafely handles EXDEV copy fallback", async () => {
    const root = await tempRoot();
    try {
      const source = path.join(root, "source.mp4");
      const destination = path.join(root, "destination.mp4");
      await writeFile(source, "ok");
      let firstRename = true;
      const simulatedRename = async (from, to) => {
        if (firstRename && to === destination) {
          firstRename = false;
          const error = new Error("cross device");
          error.code = "EXDEV";
          throw error;
        }
        return rename(from, to);
      };
      await moveFileSafely(source, destination, "task", { rename: simulatedRename, copyFile, open, unlink });
      assert.equal(await (await import("node:fs/promises")).readFile(destination, "utf8"), "ok");
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
