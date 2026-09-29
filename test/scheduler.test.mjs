import assert from "node:assert/strict";
import { copyFile, mkdir, mkdtemp, open, rename, rm, unlink, writeFile } from "node:fs/promises";
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

  test("download slots are independent from metadata slots", async () => {
    const importedTask = task({ id: "imported", state: "completed", destination: "C:\\existing.mp4", imported: true, metadataStatus: "pending" });
    const { current } = scheduler([importedTask], { maxConcurrentTasks: 1, maxConcurrentMetadataTasks: 1 });
    const metadataLease = await current.leaseMetadataEnrichment();
    assert.ok(metadataLease);
    await current.enqueue([{ videoId: "new-video" }]);
    const downloadLease = await current.leaseNext();
    assert.ok(downloadLease, "an enriching metadata task must not consume the download slot");
  });

  test("legacy imported base metadata can be paused without blocking tags or downloads", async () => {
    const importedTask = task({
      id: "imported-base-only",
      state: "completed",
      destination: "C:\\existing.mp4",
      imported: true,
      author: "",
      uploadTime: null,
      metadataStatus: "pending"
    });
    const { current } = scheduler([importedTask], { importedMetadataEnrichmentEnabled: false });
    assert.equal(await current.leaseMetadataEnrichment(), null);
    const status = current.status();
    assert.equal(status.importedMetadataEnrichmentEnabled, false);
    assert.equal(status.metadataCounts.pending, 0);
  });

  test("init migrates legacy automatic imported tag requests without remote fetch", async () => {
    const importedTask = task({
      id: "legacy-imported-tags",
      state: "completed",
      destination: "C:\\missing.mp4",
      imported: true,
      tagsRequested: true,
      metadataStatus: "failed",
      metadataMessage: "Iwara 返回的数据缺少标签字段"
    });
    const { current } = scheduler([importedTask], { importedMetadataEnrichmentEnabled: false });
    await current.init();
    assert.equal(importedTask.tagsRequested, false);
    assert.equal(importedTask.tagsRequestedExplicitly, false);
    assert.equal(importedTask.metadataStatus, "complete");
    assert.match(importedTask.metadataMessage, /未自动获取 Iwara 资料/);
    assert.equal(await current.leaseMetadataEnrichment(), null);
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

  test("refresh view counts queues existing and missing values", async () => {
    const currentTasks = [
      task({ id: "task-existing-view", state: "completed", destination: "C:\\existing.mp4", metadataStatus: "complete", viewCount: 123 }),
      task({ id: "task-missing-view", state: "completed", destination: "C:\\missing.mp4", metadataStatus: "failed", viewCount: null }),
      task({ id: "task-enriching", state: "completed", destination: "C:\\busy.mp4", metadataStatus: "enriching", viewCount: 456 })
    ];
    const { current } = scheduler(currentTasks);
    const result = await current.refreshViewCountEnrichment();
    assert.equal(result.queued, 2);
    assert.equal(currentTasks[0].viewCountRequested, true);
    assert.equal(currentTasks[0].metadataStatus, "pending");
    assert.equal(currentTasks[1].metadataStatus, "pending");
    assert.equal(currentTasks[2].metadataStatus, "enriching");
  });

  test("view-only metadata lease includes previously known view counts", async () => {
    const currentTask = task({ state: "completed", destination: "C:\\video.mp4", metadataStatus: "pending", viewCountRequested: true, viewCount: 321 });
    const { current } = scheduler([currentTask]);
    const lease = await current.leaseMetadataEnrichment({ viewsOnly: true });
    assert.equal(lease.videoId, currentTask.videoId);
    assert.equal(currentTask.metadataStatus, "enriching");
  });

  test("refresh tags queues existing and missing values", async () => {
    const currentTasks = [
      task({ id: "task-existing-tag", state: "completed", destination: "C:\\existing.mp4", metadataStatus: "complete", tags: ["dance"], tagsUpdatedAt: "2026-01-01T00:00:00.000Z" }),
      task({ id: "task-missing-tag", state: "completed", destination: "C:\\missing.mp4", metadataStatus: "failed", tagsRequested: true }),
      task({ id: "task-enriching-tag", state: "completed", destination: "C:\\busy.mp4", metadataStatus: "enriching", tags: ["old"], tagsUpdatedAt: "2026-01-01T00:00:00.000Z" })
    ];
    const { current } = scheduler(currentTasks);
    const result = await current.refreshTagEnrichment();
    assert.equal(result.queued, 2);
    assert.equal(currentTasks[0].tagsRequested, true);
    assert.equal(currentTasks[0].metadataStatus, "pending");
    assert.equal(currentTasks[1].metadataStatus, "pending");
    assert.equal(currentTasks[2].metadataStatus, "enriching");
  });

  test("tag-only metadata lease and empty tag success are retained", async () => {
    const currentTask = task({ state: "completed", destination: "C:\\video.mp4", metadataStatus: "pending", tagsRequested: true, tags: ["old"] });
    const { current } = scheduler([currentTask]);
    const lease = await current.leaseMetadataEnrichment({ tagsOnly: true });
    assert.equal(lease.videoId, currentTask.videoId);
    await current.submitMetadataEnrichment({
      taskId: currentTask.id,
      leaseId: lease.leaseId,
      ok: true,
      metadata: { title: "标题", author: "作者", uploadTime: "2026-01-01", tags: [] }
    });
    assert.deepEqual(currentTask.tags, []);
    assert.equal(currentTask.tagsRequested, false);
    assert.ok(currentTask.tagsUpdatedAt);
    assert.equal(currentTask.metadataStatus, "complete");
  });

  test("tag enrichment accepts nested Iwara tag arrays and object ids", async () => {
    const currentTask = task({ state: "completed", destination: "C:\\video.mp4", metadataStatus: "pending", tagsRequested: true });
    const { current } = scheduler([currentTask]);
    const lease = await current.leaseMetadataEnrichment({ tagsOnly: true });
    await current.submitMetadataEnrichment({
      taskId: currentTask.id,
      leaseId: lease.leaseId,
      ok: true,
      metadata: { title: "标题", author: "作者", uploadTime: "2026-01-01", data: { tags: [{ id: "blender" }, { name: "mmd" }] } }
    });
    assert.deepEqual(currentTask.tags, ["blender", "mmd"]);
    assert.ok(currentTask.tagsUpdatedAt);
    assert.equal(currentTask.tagsRequested, false);
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
      assert.equal(result.globalIndex, 3);
      assert.equal(result.hasPrevious, true);
      assert.equal(result.hasNext, true);
      assert.ok(result.items.some(item => item.id === "task-3"));
      const nextContext = await current.playlist({ contextIndex: 4, contextSize: 5, direction: "asc" });
      assert.equal(nextContext.globalIndex, 4);
      assert.equal(nextContext.currentIndex, 2);
      assert.equal(nextContext.items[2].id, "task-4");
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
      const currentTask = task({ id: "cached-task", videoId: "cached-video", state: "completed", destination: media, fileStatus: "present", mediaCheckedAt: new Date().toISOString(), tags: ["dance"], tagsUpdatedAt: new Date().toISOString() });
      sqlite.state.tasks = [currentTask];
      await sqlite.save();
      const current = new Scheduler({
        store: sqlite,
        aria2: aria2(),
        config: { downloadRoot: root, maxConcurrentTasks: 3 }
      });
      current.mediaPath = async () => { throw new Error("playlist must use cached media status"); };
      const result = await current.playlist({ page: 1, pageSize: 30 });
      assert.equal(result.total, 1);
      assert.equal(result.items[0].id, "cached-task");
      assert.ok(Array.isArray(result.authors));
      assert.equal(result.hasPrevious, false);
      assert.equal(result.hasNext, false);
      const byTag = await current.playlist({ query: "dance", page: 1, pageSize: 30 });
      assert.equal(byTag.total, 1);
      const context = await current.playlist({ contextIndex: 0, contextSize: 5 });
      assert.equal(context.globalIndex, 0);
      assert.equal(context.currentIndex, 0);
      assert.equal(context.items[0].id, "cached-task");
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

  test("background media reconcile checks only a bounded batch", async () => {
    const root = await tempRoot();
    try {
      const file = path.join(root, "reconcile.mp4");
      await writeFile(file, Buffer.concat([Buffer.from([0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70]), Buffer.alloc(2048)]));
      const tasks = [
        task({ id: "reconcile-1", videoId: "reconcile-video-1", state: "completed", destination: file, fileStatus: "present", actualFileSize: "2056" }),
        task({ id: "reconcile-2", videoId: "reconcile-video-2", state: "completed", destination: path.join(root, "missing.mp4"), fileStatus: "present" })
      ];
      const { current, currentStore } = scheduler(tasks, { root, downloadRoot: root, mediaReconcileBatchSize: 1 });
      await rm(file, { force: true });
      const result = await current.reconcileMediaBatch();
      assert.equal(result.checked, 1);
      assert.equal(result.changed, 1);
      assert.equal(tasks[0].fileStatus, "missing");
      assert.equal(tasks[1].fileStatus, "present");
      assert.equal(currentStore.saves, 1);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  test("media reconciliation finds a moved and renamed file by video ID", async () => {
    const root = await tempRoot();
    try {
      const moved = path.join(root, "Video", "author-folder", "Sanitized title[video-index].mp4");
      await mkdir(path.dirname(moved), { recursive: true });
      await writeFile(moved, Buffer.concat([Buffer.from([0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70]), Buffer.alloc(2048)]));
      const currentTask = task({
        id: "moved-task",
        videoId: "video-index",
        state: "completed",
        destination: path.join("D:\\Documents\\Downloads\\Video", "Original title[video-index].mp4"),
        fileStatus: "missing"
      });
      const { current } = scheduler([currentTask], { root, downloadRoot: path.join(root, "Video") });
      await current.verifyCompletedTask(currentTask);
      assert.equal(currentTask.fileStatus, "present");
      assert.equal(currentTask.destination, moved);
      assert.ok(currentTask.pathReconciledAt);
    } finally { await rm(root, { recursive: true, force: true }); }
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
