import assert from "node:assert/strict";
import { copyFile, mkdir, mkdtemp, open, rename, rm, stat, unlink, writeFile } from "node:fs/promises";
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
  const { diskSpaceProvider, volumeKeyProvider, ...configOverrides } = overrides;
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
      downloadMinimumFreeBytes: 0,
      ...configOverrides
    },
    ...(diskSpaceProvider ? { diskSpaceProvider } : {}),
    ...(volumeKeyProvider ? { volumeKeyProvider } : {})
  });
  return { current, currentStore, currentAria2 };
}

describe("download disk reserve and fallback", () => {
  test("keeps the configured reserve on J and completes overflow into the F Video root", async () => {
    const root = await tempRoot("iwara-disk-reserve-");
    try {
      const primary = path.join(root, "J", "Video");
      const fallback = path.join(root, "F", "Video");
      const stagingFile = path.join(root, "staging", "overflow.mp4");
      await mkdir(path.dirname(stagingFile), { recursive: true });
      await writeFile(stagingFile, Buffer.alloc(20, 7));
      const currentTask = task({
        state: "finalizing",
        author: "作者",
        resolved: { relativePath: "作者\\overflow [video-123].mp4" },
        stagingFile,
        pendingDestination: null,
        downloadEngine: "aria2",
        gid: "gid-overflow"
      });
      const { current } = scheduler([currentTask], {
        root,
        downloadRoot: primary,
        fallbackDownloadRoot: fallback,
        externalMediaRoots: [fallback],
        stagingRoot: path.join(root, "F", "staging"),
        downloadMinimumFreeBytes: 5 * 1024 ** 3,
        diskSpaceProvider: async drive => drive === primary ? 5 * 1024 ** 3 + 19 : 5 * 1024 ** 3 + 1,
        volumeKeyProvider: value => value.includes(`${path.sep}J${path.sep}`) ? "J" : value.includes(`${path.sep}F${path.sep}`) ? "F" : "C"
      });

      await current.complete(currentTask);

      assert.equal(currentTask.state, "completed");
      assert.equal(currentTask.destination, path.join(fallback, "作者", "overflow [video-123].mp4"));
      assert.equal(await fileInfoForTest(currentTask.destination), true);
      assert.equal(await fileInfoForTest(stagingFile), false);
      assert.match(currentTask.message, /保存到 F 盘 Video 目录/);
      assert.equal((await current.mediaPath(currentTask.id)).path, currentTask.destination);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  test("stays on J when the incoming video still leaves the reserved space", async () => {
    const root = await tempRoot("iwara-disk-primary-");
    try {
      const primary = path.join(root, "J", "Video");
      const fallback = path.join(root, "F", "Video");
      const stagingFile = path.join(root, "staging", "primary.mp4");
      await mkdir(path.dirname(stagingFile), { recursive: true });
      await writeFile(stagingFile, Buffer.alloc(20, 7));
      const currentTask = task({ state: "finalizing", resolved: { relativePath: "primary.mp4" }, stagingFile });
      const { current } = scheduler([currentTask], {
        root,
        downloadRoot: primary,
        fallbackDownloadRoot: fallback,
        stagingRoot: path.join(root, "F", "staging"),
        downloadMinimumFreeBytes: 5 * 1024 ** 3,
        diskSpaceProvider: async drive => drive === primary ? 5 * 1024 ** 3 + 20 : 5 * 1024 ** 3 + 1,
        volumeKeyProvider: value => value.includes(`${path.sep}J${path.sep}`) ? "J" : value.includes(`${path.sep}F${path.sep}`) ? "F" : "C"
      });
      await current.complete(currentTask);
      assert.equal(currentTask.destination, path.join(primary, "primary.mp4"));
      assert.equal(currentTask.state, "completed");
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  test("retains the staged file and retries finalization when both disks are below reserve", async () => {
    const root = await tempRoot("iwara-disk-retry-");
    try {
      const primary = path.join(root, "J", "Video");
      const fallback = path.join(root, "F", "Video");
      const stagingFile = path.join(root, "staging", "retry.mp4");
      await mkdir(path.dirname(stagingFile), { recursive: true });
      await writeFile(stagingFile, Buffer.alloc(20, 7));
      const currentTask = task({ state: "finalizing", resolved: { relativePath: "retry.mp4" }, stagingFile });
      let fallbackFree = 5 * 1024 ** 3 - 1;
      const { current } = scheduler([currentTask], {
        root,
        downloadRoot: primary,
        fallbackDownloadRoot: fallback,
        stagingRoot: path.join(root, "F", "staging"),
        downloadMinimumFreeBytes: 5 * 1024 ** 3,
        diskSpaceProvider: async drive => drive === fallback ? fallbackFree : 5 * 1024 ** 3 + 19,
        volumeKeyProvider: value => value.includes(`${path.sep}J${path.sep}`) ? "J" : value.includes(`${path.sep}F${path.sep}`) ? "F" : "C"
      });
      await current.complete(currentTask);
      assert.equal(currentTask.state, "finalizing");
      assert.match(currentTask.message, /J 盘和 F 盘均无法/);
      assert.equal(await fileInfoForTest(stagingFile), true);
      fallbackFree = 5 * 1024 ** 3 + 1;
      currentTask.spaceRetryAt = 0;
      await current.tick();
      assert.equal(currentTask.state, "completed");
      assert.equal(currentTask.destination, path.join(fallback, "retry.mp4"));
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});

async function fileInfoForTest(filePath) {
  try { await stat(filePath); return true; } catch { return false; }
}

describe("error classification", () => {
  test("HTTP 404 is not_found", () => assert.equal(classifyError("HTTP 404 Not Found"), "not_found"));
  test("Chinese missing page is not_found", () => assert.equal(classifyError("视频不存在"), "not_found"));
  test("HTTP 403 is access_or_expired", () => assert.equal(classifyError("HTTP 403 Forbidden"), "access_or_expired"));
  test("expired URL is access_or_expired", () => assert.equal(classifyError("signed URL expired"), "access_or_expired"));
  test("TLS hostname failure is tls_certificate", () => assert.equal(classifyError("hostname mismatch"), "tls_certificate"));
  test("timeout is timeout", () => assert.equal(classifyError("download timeout"), "timeout"));
  test("network failure is network", () => assert.equal(classifyError("socket connect failed"), "network"));
  test("only confirmed video API failures are terminal categories", () => {
    assert.equal(isPermanentErrorCategory("not_found"), false);
    assert.equal(isPermanentErrorCategory("access_or_expired"), false);
    assert.equal(isPermanentErrorCategory("video_missing"), true);
    assert.equal(isPermanentErrorCategory("permission_denied"), true);
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

  test("permanent download filter rejects known Han1/Pixiv/Iwara IDs and futa tags", async () => {
    const { current, currentStore } = scheduler([], {
      downloadFilter: {
        han1meIds: ["104155"], pixivIds: ["778899"], iwaraVideoIds: ["blocked-video-123"],
        blockedTags: ["futa", "futanari", "fata", "扶她", "扶他", "ふたなり"]
      }
    });
    const result = await current.enqueue([
      { videoId: "han1meview-104155" },
      { videoId: "pixiv-linked-01", metadata: { pixivId: "https://www.pixiv.net/artworks/778899" } },
      { videoId: "blocked-video-123" },
      { videoId: "tagged-video-01", metadata: { tags: ["dance_only", { name: "Futanari" }] } },
      { videoId: "chinese-tag-01", metadata: { tags: ["扶他向"] } },
      { videoId: "fata-tag-01", metadata: { tags: ["FATA"] } }
    ]);
    assert.equal(result.accepted.length, 0);
    assert.equal(result.ignored.length, 6);
    assert.ok(result.ignored.every(item => item.filtered));
    assert.equal(currentStore.state.tasks.length, 0);
  });

  test("download filter avoids false-positive substring matches", async () => {
    const { current } = scheduler([], { downloadFilter: { blockedTags: ["futa"] } });
    const result = await current.enqueue([{ videoId: "fatality-safe", metadata: { tags: ["fatal", "fuchsia"] } }]);
    assert.equal(result.accepted.length, 1);
  });

  test("enqueue rejects duplicate video id", async () => {
    const { current } = scheduler([]);
    await current.enqueue([{ videoId: "abc" }]);
    const result = await current.enqueue([{ videoId: "abc" }]);
    assert.equal(result.accepted.length, 0);
    assert.match(result.ignored[0].reason, /already recorded/);
  });

  test("enqueue persists safe Iwara page metadata with a new task", async () => {
    const { current, currentStore } = scheduler([]);
    const result = await current.enqueue([{ videoId: "page-metadata", metadata: {
      title: "  Page title ", author: " creator ", alias: "Display name", uploadTime: 1_759_000_000_000,
      viewCount: "12,345", tags: [{ name: "dance" }, { id: "blender" }],
      destination: "must-not-be-copied", sourcePage: "https://evil.invalid/"
    } }]);
    assert.equal(result.accepted.length, 1);
    const task = currentStore.state.tasks[0];
    assert.equal(task.title, "Page title");
    assert.equal(task.author, "creator");
    assert.equal(task.alias, "Display name");
    assert.equal(task.uploadTime, new Date(1_759_000_000_000).toISOString());
    assert.equal(task.viewCount, 12345);
    assert.deepEqual(task.tags, ["dance", "blender"]);
    assert.equal(task.destination, undefined);
    assert.equal(task.sourcePage, "https://www.iwara.tv/video/page-metadata");
  });

  test("duplicate enqueue fills only missing page metadata without changing recorded values", async () => {
    const existing = task({
      id: "existing-metadata-row", videoId: "existing-metadata", title: "Keep this title", author: "", alias: "",
      uploadTime: null, viewCount: null, tags: [], state: "failed", authorBackfillStatus: "retry"
    });
    const { current, currentStore } = scheduler([existing]);
    const result = await current.enqueue([{ videoId: existing.videoId, metadata: {
      title: "New title must not replace", author: "Recovered author", alias: "Display", uploadTime: "2025-04-03",
      views: 4200, tags: ["dance"]
    } }]);
    assert.equal(result.accepted.length, 0);
    assert.equal(result.ignored[0].metadataUpdated, true);
    assert.ok(currentStore.saves >= 1);
    assert.equal(existing.title, "Keep this title");
    assert.equal(existing.author, "Recovered author");
    assert.equal(existing.alias, "Display");
    assert.equal(existing.uploadTime, "2025-04-03");
    assert.equal(existing.viewCount, 4200);
    assert.deepEqual(existing.tags, ["dance"]);
    assert.equal(existing.authorBackfillStatus, "complete");
    assert.equal(existing.state, "failed", "metadata repair must not silently retry a failed download");
  });

  test("leaseNext enters API resolving state", async () => {
    const currentTask = task();
    const { current } = scheduler([currentTask]);
    const lease = await current.leaseNext();
    assert.equal(lease.mode, "api");
    assert.equal(currentTask.state, "resolving");
    assert.ok(lease.leaseId);
  });

  test("startup filters already-queued tasks before leasing them", async () => {
    const alreadyQueued = task({ tags: ["扶他"] });
    const { current, currentStore } = scheduler([alreadyQueued], { downloadFilter: { blockedTags: ["扶他"] } });
    await current.init();
    assert.equal(alreadyQueued.state, "filtered");
    assert.ok(currentStore.saves >= 1);
    assert.equal(await current.leaseNext(), null);
  });

  test("resolver tags are checked before a media download starts", async () => {
    const root = await tempRoot();
    try {
      const currentTask = task();
      const { current, currentAria2 } = scheduler([currentTask], { root, downloadFilter: { blockedTags: ["futa"] } });
      const lease = await current.leaseNext();
      const result = await current.submitResolution({
        taskId: currentTask.id,
        leaseId: lease.leaseId,
        ok: true,
        video: { url: "https://cdn.example/video.mp4", metadata: { Tags: ["Futanari"] } }
      });
      assert.equal(result.state, "filtered");
      assert.equal(currentTask.attempts, 0);
      assert.equal(currentAria2.statuses.size, 0);
      assert.equal(currentTask.lastErrorCategory, "download_filtered");
      assert.equal(current.status().counts.filtered, 1);
    } finally { await rm(root, { recursive: true, force: true }); }
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

  test("confirmed video API 404 fails without fallback", async () => {
    const currentTask = task();
    const { current } = scheduler([currentTask]);
    const lease = await current.leaseNext();
    await current.submitResolution({ taskId: currentTask.id, leaseId: lease.leaseId, ok: false, error: "HTTP 404 Not Found", failure: { stage: "video_api", httpStatus: 404 } });
    assert.equal(currentTask.state, "failed");
    assert.equal(currentTask.lastErrorCategory, "video_missing");
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

  test("CDN HTTP 404 download failure refreshes the link", async () => {
    const root = await tempRoot();
    try {
      const currentTask = task({ state: "downloading", gid: "gid-404", downloadEngine: "aria2", stagingFile: path.join(root, "bad.mp4") });
      const { current, currentAria2 } = scheduler([currentTask], { root });
      currentAria2.statuses.set("gid-404", { gid: "gid-404", status: "error", errorMessage: "HTTP 404 Not Found" });
      await current.failDownload(currentTask, "HTTP 404 Not Found");
      assert.equal(currentTask.state, "queued");
      assert.equal(currentTask.lastErrorCategory, "cdn_not_found");
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  test("ordinary attempts exhaust into browser fallback", async () => {
    const currentTask = task({ attempts: 2 });
    const { current } = scheduler([currentTask]);
    await current.retryOrFail(currentTask, "CDN failed", true);
    assert.equal(currentTask.state, "queued");
    assert.equal(currentTask.browserFallbackPending, true);
  });

  test("legacy resolver HTTP 403/404 strings retry without pretending permanent removal", async () => {
    for (const status of [403, 404]) {
      const t = task(); const { current } = scheduler([t]); const lease = await current.leaseNext();
      await current.submitResolution({ taskId: t.id, leaseId: lease.leaseId, ok: false, error: `HTTP ${status}` });
      assert.equal(t.state, "queued"); assert.equal(t.attempts, 1);
    }
  });

  test("source API 403 is retryable but video API permission is terminal", async () => {
    for (const stage of ["source_api", "video_api"]) {
      const t = task(); const { current } = scheduler([t]); const lease = await current.leaseNext();
      await current.submitResolution({ taskId: t.id, leaseId: lease.leaseId, ok: false, error: "HTTP 403", failure: { stage, httpStatus: 403 } });
      assert.equal(t.state, stage === "video_api" ? "failed" : "queued");
    }
  });

  test("429 respects Retry-After capped at sixty seconds", async () => {
    const t = task(); const { current } = scheduler([t]); const lease = await current.leaseNext();
    await current.submitResolution({ taskId: t.id, leaseId: lease.leaseId, ok: false, error: "HTTP 429", failure: { stage: "video_api", httpStatus: 429, retryAfterMs: 300000 } });
    assert.equal(t.state, "queued"); assert.equal(t.nextRunAt, 61000); assert.equal(t.lastErrorCategory, "rate_limited");
  });

  test("an expired resolver result cannot start a download before the lease tick", async () => {
    const t = task(); const { current, currentAria2 } = scheduler([t]); const lease = await current.leaseNext(); current.clock.now = () => t.leaseExpiresAt;
    await assert.rejects(current.submitResolution({ taskId: t.id, leaseId: lease.leaseId, ok: true, video: { url: "https://cdn.example/a.mp4" } }), /租约无效或已过期/);
    assert.equal(currentAria2.statuses.size, 0); await current.tick(); assert.equal(t.state, "queued"); assert.equal(t.attempts, 1);
  });

  test("source-unavailable errors still use six normal attempts and one sniff", async () => {
    const t = task(); const { current } = scheduler([t], { maxAttempts: 6, retryDelayMs: 0 });
    for (let index = 0; index < 7; index++) {
      const lease = await current.leaseNext(); assert.ok(lease); assert.equal(lease.mode, index === 6 ? "browser_sniff" : "api");
      await current.submitResolution({ taskId: t.id, leaseId: lease.leaseId, ok: false, error: "没有可用视频源", failure: { stage: "source_api" } });
    }
    assert.equal(t.attempts, 7); assert.equal(t.state, "failed"); assert.equal(await current.leaseNext(), null);
  });

  test("CDN 429 obtains a bounded Retry-After without counting another attempt", async () => {
    const t = task({ state: "downloading", attempts: 1, resolved: { url: "https://cdn.example/a.mp4?private=hidden", headers: {} } }); const { current } = scheduler([t]);
    current.httpRequest = async (url, options) => { assert.equal(options.method, "HEAD"); return { headers: new Headers({ "retry-after": "45" }) }; };
    await current.failDownload(t, "HTTP 429"); assert.equal(t.nextRunAt, 46000); assert.equal(t.lastFailure.stage, "cdn"); assert.equal(t.attempts, 1); assert.equal(t.state, "queued");
  });

  test("a completed tiny CDN file refreshes its source rather than recording video deletion", async () => {
    const root = await tempRoot();
    try {
      const file = path.join(root, "bad.mp4"); await writeFile(file, "error");
      const t = task({ state: "downloading", attempts: 1, gid: "bad", stagingFile: file }); const { current, currentAria2 } = scheduler([t], { root });
      currentAria2.statuses.set("bad", { status: "complete", totalLength: "5", completedLength: "5", downloadSpeed: "0" });
      await current.reconcileDownloadTask(t); assert.equal(t.state, "queued"); assert.equal(t.attempts, 1); assert.equal(t.lastFailure.stage, "cdn"); assert.notEqual(t.lastErrorCategory, "video_missing"); assert.ok(currentAria2.forgotten.includes("bad"));
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  test("a resolved CDN 403 counts once and removes signed query strings from history", async () => {
    const root = await tempRoot();
    try {
      const t = task(); const { current, currentStore } = scheduler([t], { root }); const lease = await current.leaseNext();
      await current.submitResolution({ taskId: t.id, leaseId: lease.leaseId, ok: true, video: { url: "https://cdn.example/a.mp4?token=secret", fileName: "a.mp4" } });
      await current.failDownload(t, "HTTP 403 https://cdn.example/a.mp4?token=secret");
      assert.equal(t.state, "queued"); assert.equal(t.attempts, 1); assert.equal(t.lastErrorCategory, "link_expired");
      assert.ok(!currentStore.events.at(-1).message.includes("secret"));
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  test("six failed API attempts plus one sniff failure stop, without infinite retry", async () => {
    const t = task(); const { current } = scheduler([t], { maxAttempts: 6, retryDelayMs: 0 });
    for (let index = 0; index < 7; index++) {
      const lease = await current.leaseNext(); assert.ok(lease); assert.equal(lease.mode, index === 6 ? "browser_sniff" : "api");
      await current.submitResolution({ taskId: t.id, leaseId: lease.leaseId, ok: false, error: "HTTP 403" });
    }
    assert.equal(t.state, "failed"); assert.equal(t.attempts, 7); assert.equal(await current.leaseNext(), null);
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

  test("successful Iwara downloads queue missing author/date metadata, but Han1 and complete rows do not", async () => {
    const root = await tempRoot();
    try {
      const stagingRoot = path.join(root, "staging");
      const makeStagingFile = async id => {
        const file = path.join(stagingRoot, id, `${id}.mp4`);
        await mkdir(path.dirname(file), { recursive: true });
        await writeFile(file, Buffer.concat([Buffer.from([0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70]), Buffer.alloc(2048)]));
        return file;
      };
      const missingIwara = task({
        id: "download-iwara-missing-metadata",
        videoId: "X0ODsuCGZUgc5C",
        sourcePage: "https://www.iwara.tv/video/X0ODsuCGZUgc5C",
        state: "downloading",
        author: "",
        alias: "",
        uploadTime: null,
        resolved: { relativePath: "iwara-missing-metadata.mp4" },
        stagingFile: await makeStagingFile("download-iwara-missing-metadata")
      });
      const han = task({
        id: "download-han-missing-metadata",
        videoId: "han1meview-123456",
        sourcePage: "",
        localOnly: true,
        state: "downloading",
        author: "",
        uploadTime: null,
        resolved: { relativePath: "han-missing-metadata.mp4" },
        stagingFile: await makeStagingFile("download-han-missing-metadata")
      });
      const complete = task({
        id: "download-iwara-complete-metadata",
        videoId: "CompleteMeta1234",
        sourcePage: "https://www.iwara.tv/video/CompleteMeta1234",
        state: "downloading",
        author: "已有作者",
        alias: "已有作者",
        uploadTime: "2026-10-01",
        resolved: { relativePath: "iwara-complete-metadata.mp4" },
        stagingFile: await makeStagingFile("download-iwara-complete-metadata")
      });
      const genericIwara = task({
        id: "download-iwara-generic-author",
        videoId: "GenericAuthor123",
        sourcePage: "https://www.iwara.tv/video/GenericAuthor123",
        state: "downloading",
        author: "本地导入",
        alias: "",
        uploadTime: "2026-10-01",
        resolved: { relativePath: "iwara-generic-author.mp4" },
        stagingFile: await makeStagingFile("download-iwara-generic-author")
      });
      const { current } = scheduler([missingIwara, han, complete, genericIwara], { root });

      await current.complete(missingIwara);
      await current.complete(han);
      await current.complete(complete);
      await current.complete(genericIwara);

      assert.equal(missingIwara.state, "completed");
      assert.equal(missingIwara.baseMetadataRequested, true);
      assert.equal(missingIwara.metadataStatus, "pending");
      assert.equal(missingIwara.metadataNextRunAt, 0);
      assert.match(missingIwara.metadataMessage, /等待补齐 Iwara 作者或上传日期/);
      assert.equal(han.metadataStatus, undefined, "Han1me IDs are not sent to the Iwara metadata queue");
      assert.equal(complete.metadataStatus, undefined, "complete metadata is not queued again");
      assert.equal(genericIwara.metadataStatus, "pending", "the generic local-import label is not a real Iwara author");

      const lease = await current.leaseMetadataEnrichment();
      assert.equal(lease.videoId, missingIwara.videoId);
      const genericLease = await current.leaseMetadataEnrichment();
      assert.equal(genericLease.videoId, genericIwara.videoId);
      await current.submitMetadataEnrichment({ taskId: genericIwara.id, leaseId: genericLease.leaseId, ok: true,
        metadata: { author: "RecoveredAuthor", alias: "Creator", uploadTime: "2026-10-01" } });
      assert.equal(genericIwara.author, "RecoveredAuthor", "metadata enrichment replaces the generic placeholder only with fetched Iwara data");
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  test("recovered finalizing Iwara downloads also queue missing author/date metadata", async () => {
    const root = await tempRoot();
    try {
      const destination = path.join(root, "Video", "recovered.mp4");
      await mkdir(path.dirname(destination), { recursive: true });
      await writeFile(destination, Buffer.concat([Buffer.from([0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70]), Buffer.alloc(2048)]));
      const currentTask = task({
        id: "recover-iwara-missing-metadata",
        videoId: "Recovered12345",
        sourcePage: "https://www.iwara.tv/video/Recovered12345",
        state: "finalizing",
        author: "",
        uploadTime: null,
        pendingDestination: destination
      });
      const { current } = scheduler([currentTask], { root });

      await current.recoverFinalizing(currentTask);

      assert.equal(currentTask.state, "completed");
      assert.equal(currentTask.baseMetadataRequested, true);
      assert.equal(currentTask.metadataStatus, "pending");
      assert.equal((await current.leaseMetadataEnrichment()).videoId, currentTask.videoId);
    } finally { await rm(root, { recursive: true, force: true }); }
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

  test("explicit base metadata queue only leases missing Iwara metadata when legacy imports are paused", async () => {
    const eligible = task({ id: "missing-date", videoId: "MissingDate1234", sourcePage: "https://www.iwara.tv/video/MissingDate1234",
      state: "completed", destination: "C:\\missing-date.mp4", imported: true, uploadTime: null, metadataStatus: "complete" });
    const han = task({ id: "han-missing-date", videoId: "han1meview-110410", sourcePage: "", sourcePlatform: "han1meview",
      state: "completed", destination: "C:\\han.mp4", imported: true, localOnly: true, uploadTime: null, metadataStatus: "complete" });
    const { current } = scheduler([eligible, han], { importedMetadataEnrichmentEnabled: false });
    assert.deepEqual(await current.queueBaseMetadataEnrichment(), { queued: 1, remaining: 0 });
    const lease = await current.leaseMetadataEnrichment();
    assert.equal(lease.videoId, eligible.videoId);
    await current.submitMetadataEnrichment({ taskId: eligible.id, leaseId: lease.leaseId, ok: true,
      metadata: { author: "作者", uploadTime: "2025-01-02" } });
    assert.equal(eligible.baseMetadataRequested, false);
    assert.equal(eligible.uploadTime, "2025-01-02");
    assert.equal(han.metadataStatus, "complete", "Han1me local IDs never enter the Iwara API queue");
  });

  test("author backfill queues only blank Iwara authors with matching canonical video pages", async () => {
    const eligible = task({ id: "old-iwara", videoId: "FiEbOWOE1GVk9Z", sourcePage: "https://www.iwara.tv/video/FiEbOWOE1GVk9Z", state: "completed", destination: "C:\\video.mp4", imported: true, author: "", alias: "", metadataStatus: "complete" });
    const han = task({ id: "han", videoId: "han1meview-110410", sourcePage: "", state: "completed", destination: "C:\\han.mp4", localOnly: true, author: "", alias: "" });
    const known = task({ id: "known", videoId: "KnownVideo1234", sourcePage: "https://www.iwara.tv/video/KnownVideo1234", state: "completed", destination: "C:\\known.mp4", author: "known", alias: "" });
    const mismatch = task({ id: "mismatch", videoId: "Mismatch1234", sourcePage: "https://www.iwara.tv/video/OtherVideo1234", state: "completed", destination: "C:\\other.mp4", author: "", alias: "" });
    const unsafe = task({ id: "unsafe", videoId: "UnsafeVideo1234", sourcePage: "https://example.com/video/UnsafeVideo1234", state: "completed", destination: "C:\\unsafe.mp4", author: "", alias: "" });
    const { current, currentStore } = scheduler([eligible, han, known, mismatch, unsafe]);
    const result = await current.queueAuthorBackfill();
    assert.deepEqual(result, { queued: 1, remaining: 0, totalEligible: 1 });
    assert.equal(eligible.authorBackfillStatus, "pending");
    assert.equal(han.authorBackfillStatus, undefined);
    assert.equal(known.authorBackfillStatus, undefined);
    assert.equal(mismatch.authorBackfillStatus, undefined);
    assert.equal(unsafe.authorBackfillStatus, undefined);
    assert.equal(currentStore.saves, 1);
    assert.deepEqual(await current.queueAuthorBackfill(), { queued: 0, remaining: 0, totalEligible: 0 });
  });

  test("author backfill lease writes only missing author fields and leaves metadata and download times intact", async () => {
    const currentTask = task({
      id: "author-only", videoId: "FiEbOWOE1GVk9Z", sourcePage: "https://www.iwara.tv/video/FiEbOWOE1GVk9Z",
      state: "completed", destination: "C:\\video.mp4", imported: true, author: "", alias: "",
      title: "Keep this title", uploadTime: "2025-01-02", tags: ["keep-tag"], viewCount: 321,
      metadataStatus: "complete", updatedAt: "2025-01-03T00:00:00.000Z"
    });
    const { current } = scheduler([currentTask]);
    await current.queueAuthorBackfill();
    const lease = await current.leaseAuthorBackfill();
    assert.equal(lease.videoId, currentTask.videoId);
    assert.equal(currentTask.metadataStatus, "complete");
    assert.equal(current.status().authorBackfill.enriching, 1);
    assert.equal(Object.hasOwn(current.status().metadataCurrent || {}, "authorBackfillLeaseId"), false);
    await current.submitAuthorBackfill({ taskId: currentTask.id, leaseId: lease.leaseId, ok: true, author: "username", alias: "Display Name" });
    assert.equal(currentTask.author, "username");
    assert.equal(currentTask.alias, "Display Name");
    assert.equal(currentTask.title, "Keep this title");
    assert.equal(currentTask.uploadTime, "2025-01-02");
    assert.deepEqual(currentTask.tags, ["keep-tag"]);
    assert.equal(currentTask.viewCount, 321);
    assert.equal(currentTask.metadataStatus, "complete");
    assert.equal(currentTask.updatedAt, "2025-01-03T00:00:00.000Z");
    assert.equal(currentTask.authorBackfillStatus, "complete");
  });

  test("author backfill failures retry finitely without changing download failure state", async () => {
    const currentTask = task({ id: "author-retry", videoId: "FiEbOWOE1GVk9Z", sourcePage: "https://www.iwara.tv/video/FiEbOWOE1GVk9Z", state: "completed", destination: "C:\\video.mp4", author: "", alias: "", metadataStatus: "complete" });
    const { current } = scheduler([currentTask], { metadataMaxAttempts: 2, metadataRetryDelayMs: 10 });
    await current.queueAuthorBackfill();
    let lease = await current.leaseAuthorBackfill();
    await current.submitAuthorBackfill({ taskId: currentTask.id, leaseId: lease.leaseId, ok: false, error: "Cloudflare 403" });
    assert.equal(currentTask.authorBackfillStatus, "retry");
    assert.equal(currentTask.authorBackfillNextRunAt, 1010);
    currentTask.authorBackfillNextRunAt = 0;
    lease = await current.leaseAuthorBackfill();
    await current.submitAuthorBackfill({ taskId: currentTask.id, leaseId: lease.leaseId, ok: false, error: "仍无法访问" });
    assert.equal(currentTask.authorBackfillStatus, "failed");
    assert.equal(currentTask.state, "completed");
    assert.equal(currentTask.metadataStatus, "complete");
    assert.equal(currentTask.authorBackfillMessage, "仍无法访问；保留原记录");
  });

  test("pausing author backfill clears leases and preserves completed metadata", async () => {
    const pending = task({ id: "author-pending", authorBackfillStatus: "pending", author: "", alias: "" });
    const leased = task({ id: "author-leased", authorBackfillStatus: "enriching", authorBackfillLeaseId: "lease", authorBackfillLeaseExpiresAt: 5000, author: "", alias: "" });
    const complete = task({ id: "author-done", authorBackfillStatus: "complete", author: "known", alias: "Known" });
    const { current, currentStore } = scheduler([pending, leased, complete]);
    assert.deepEqual(await current.pauseAuthorBackfill(), { paused: 2 });
    assert.equal(pending.authorBackfillStatus, "paused");
    assert.equal(leased.authorBackfillStatus, "paused");
    assert.equal(leased.authorBackfillLeaseId, null);
    assert.equal(leased.authorBackfillLeaseExpiresAt, null);
    assert.equal(complete.authorBackfillStatus, "complete");
    assert.equal(complete.author, "known");
    assert.equal(currentStore.saves, 1);
    assert.equal(await current.leaseAuthorBackfill(), null);
    assert.equal(current.status().authorBackfill.paused, 2);
  });

  test("author folder backfill uses existing usernames or folder labels without touching other fields", async () => {
    const root = await tempRoot("iwara-author-folders-");
    try {
      const downloadRoot = path.join(root, "Video");
      const usernamePath = path.join(downloadRoot, "creator123", "one.mp4");
      const aliasPath = path.join(downloadRoot, "Creator Display", "two.mp4");
      const localPath = path.join(downloadRoot, "New Folder Creator", "three.mp4");
      const rootPath = path.join(downloadRoot, "root.mp4");
      const outsidePath = path.join(root, "Other", "outside.mp4");
      for (const mediaPath of [usernamePath, aliasPath, localPath, rootPath, outsidePath]) {
        await mkdir(path.dirname(mediaPath), { recursive: true });
        await writeFile(mediaPath, "video");
      }
      const known = task({ id: "known-author", author: "creator123", alias: "Creator Display", state: "completed", destination: usernamePath });
      const byUsername = task({ id: "by-username", author: "", alias: "", state: "completed", destination: usernamePath, title: "keep title" });
      const byAlias = task({ id: "by-alias", author: "", alias: "", state: "completed", destination: aliasPath });
      const byFolder = task({ id: "by-folder", author: "", alias: "", state: "completed", destination: localPath, metadataStatus: "complete", viewCount: 12, tags: ["keep"] });
      const rootFile = task({ id: "root-file", author: "", alias: "", state: "completed", destination: rootPath });
      const outside = task({ id: "outside", author: "", alias: "", state: "completed", destination: outsidePath });
      const { current, currentStore } = scheduler([known, byUsername, byAlias, byFolder, rootFile, outside], { root });
      const preview = await current.backfillAuthorsFromFolders();
      assert.equal(preview.applied, false);
      assert.deepEqual({ eligible: preview.eligible, matchedUsername: preview.matchedUsername, matchedAlias: preview.matchedAlias, folderLabelOnly: preview.folderLabelOnly, skippedRoot: preview.skippedRoot, skippedOutsideRoot: preview.skippedOutsideRoot }, {
        eligible: 3, matchedUsername: 1, matchedAlias: 1, folderLabelOnly: 1, skippedRoot: 1, skippedOutsideRoot: 1
      });
      assert.equal(byUsername.author, "");
      const applied = await current.backfillAuthorsFromFolders({ apply: true });
      assert.equal(applied.applied, true);
      assert.equal(byUsername.author, "creator123");
      assert.equal(byUsername.alias, "Creator Display");
      assert.equal(byUsername.authorSource, "local_folder_matchedUsername");
      assert.equal(byAlias.author, "creator123");
      assert.equal(byAlias.alias, "Creator Display");
      assert.equal(byFolder.author, "");
      assert.equal(byFolder.alias, "New Folder Creator");
      assert.equal(byFolder.authorSource, "local_folder_label");
      assert.equal(byFolder.metadataStatus, "complete");
      assert.equal(byFolder.viewCount, 12);
      assert.deepEqual(byFolder.tags, ["keep"]);
      assert.equal(byFolder.title, "测试视频");
      assert.equal(rootFile.alias, "");
      assert.equal(outside.alias, "");
      assert.equal(currentStore.saves, 1);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  test("author folder backfill uses corroborated aliases and unanimous multiple-folder aliases", async () => {
    const root = await tempRoot("iwara-author-folder-aliases-");
    try {
      const downloadRoot = path.join(root, "Video");
      const knownPath = path.join(downloadRoot, "Creator Display", "known.mp4");
      const aliasPath = path.join(downloadRoot, "Creator Display", "fill.mp4");
      const multiplePaths = [path.join(downloadRoot, "multiple", "a.mp4"), path.join(downloadRoot, "multiple", "b.mp4")];
      const mismatchPath = path.join(downloadRoot, "Unrelated", "mismatch.mp4");
      const rootPath = path.join(downloadRoot, "root.mp4");
      for (const file of [knownPath, aliasPath, ...multiplePaths, mismatchPath, rootPath]) {
        await mkdir(path.dirname(file), { recursive: true });
        await writeFile(file, "video");
      }
      const known = task({ id: "known-alias-owner", videoId: "known-alias-owner", author: "creator123", alias: "Creator Display", state: "completed", destination: knownPath });
      const fromFolderAlias = task({ id: "folder-alias", videoId: "folder-alias", author: "", alias: "Creator Display", state: "completed", destination: aliasPath, tags: ["preserve"] });
      const fromConsensus = multiplePaths.map((destination, index) => task({ id: `multiple-${index}`, videoId: `multiple-${index}`, author: "", alias: "LqMydHXH", state: "completed", destination }));
      const mismatch = task({ id: "mismatch-alias", videoId: "mismatch-alias", author: "", alias: "A different creator", state: "completed", destination: mismatchPath });
      const rootFile = task({ id: "root-no-folder", videoId: "root-no-folder", author: "", alias: "", state: "completed", destination: rootPath });
      const { current, currentStore } = scheduler([known, fromFolderAlias, ...fromConsensus, mismatch, rootFile], { root });

      const preview = await current.backfillAuthorsFromFolders();
      assert.deepEqual({ eligible: preview.eligible, matchedAlias: preview.matchedAlias, matchedConsensusAlias: preview.matchedConsensusAlias,
        skippedRoot: preview.skippedRoot, skippedAmbiguousAlias: preview.skippedAmbiguousAlias }, {
        eligible: 3, matchedAlias: 1, matchedConsensusAlias: 2, skippedRoot: 1, skippedAmbiguousAlias: 1
      });
      assert.equal(fromFolderAlias.author, "", "preview must not mutate the task");
      const applied = await current.backfillAuthorsFromFolders({ apply: true });
      assert.equal(applied.eligible, 3);
      assert.equal(fromFolderAlias.author, "creator123", "a known alias mapping should preserve the canonical username");
      assert.equal(fromFolderAlias.authorSource, "local_folder_matchedAlias");
      assert.equal(fromFolderAlias.alias, "Creator Display");
      assert.deepEqual(fromFolderAlias.tags, ["preserve"]);
      assert.equal(fromConsensus[0].author, "LqMydHXH", "a unanimous alias can be used when the folder name is only a grouping label");
      assert.equal(fromConsensus[0].authorSource, "local_folder_matchedConsensusAlias");
      assert.equal(mismatch.author, "", "a conflicting folder and alias must remain untouched");
      assert.equal(rootFile.author, "", "root-level files have no author folder evidence");
      assert.equal(currentStore.saves, 1);
    } finally { await rm(root, { recursive: true, force: true }); }
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
      task({ id: "task-existing-view", videoId: "ExistingView123", sourcePage: "https://www.iwara.tv/video/ExistingView123", state: "completed", destination: "C:\\existing.mp4", metadataStatus: "complete", viewCount: 123 }),
      task({ id: "task-missing-view", videoId: "MissingView1234", sourcePage: "https://www.iwara.tv/video/MissingView1234", state: "completed", destination: "C:\\missing.mp4", metadataStatus: "failed", viewCount: null }),
      task({ id: "task-enriching", videoId: "BusyView123456", sourcePage: "https://www.iwara.tv/video/BusyView123456", state: "completed", destination: "C:\\busy.mp4", metadataStatus: "enriching", viewCount: 456 }),
      task({ id: "task-han-view", videoId: "han1meview-110410", sourcePage: "", sourcePlatform: "han1meview", state: "completed", destination: "C:\\han.mp4", viewCount: null }),
      task({ id: "task-local-view", videoId: "local-12345678901234567890", sourcePage: "", state: "completed", destination: "C:\\local.mp4", viewCount: null })
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
      task({ id: "task-existing-tag", videoId: "ExistingTag1234", sourcePage: "https://www.iwara.tv/video/ExistingTag1234", state: "completed", destination: "C:\\existing.mp4", metadataStatus: "complete", tags: ["dance"], tagsUpdatedAt: "2026-01-01T00:00:00.000Z" }),
      task({ id: "task-missing-tag", videoId: "MissingTag12345", sourcePage: "https://www.iwara.tv/video/MissingTag12345", state: "completed", destination: "C:\\missing.mp4", metadataStatus: "failed", tagsRequested: true }),
      task({ id: "task-enriching-tag", videoId: "BusyTag1234567", sourcePage: "https://www.iwara.tv/video/BusyTag1234567", state: "completed", destination: "C:\\busy.mp4", metadataStatus: "enriching", tags: ["old"], tagsUpdatedAt: "2026-01-01T00:00:00.000Z" }),
      task({ id: "task-han-tag", videoId: "han1meview-110410", sourcePage: "", sourcePlatform: "han1meview", state: "completed", destination: "C:\\han.mp4", tags: [] }),
      task({ id: "task-local-tag", videoId: "local-12345678901234567890", sourcePage: "", state: "completed", destination: "C:\\local.mp4", tags: [] })
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

  test("SQLite recommendations draw a reproducible random sample from the full candidate list", async () => {
    const root = await tempRoot();
    let sqlite;
    try {
      const tasks = [];
      for (let index = 0; index < 42; index += 1) {
        const file = path.join(root, `video-${index}.mp4`);
        await writeFile(file, Buffer.concat([Buffer.from([0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70]), Buffer.alloc(128)]));
        tasks.push(task({
          id: `random-task-${index}`,
          videoId: `random-video-${index}`,
          title: `随机视频 ${index}`,
          destination: file,
          state: "completed",
          fileStatus: "present",
          mediaCheckedAt: new Date().toISOString(),
          updatedAt: new Date(Date.UTC(2026, 0, 1, 0, index)).toISOString()
        }));
      }
      sqlite = new SQLiteStore({
        filePath: path.join(root, "ledger.sqlite"),
        legacyJsonPath: path.join(root, "state.json"),
        backupRoot: path.join(root, "backups")
      });
      await sqlite.load();
      sqlite.state.tasks = tasks;
      await sqlite.save();

      const first = sqlite.queryPlaylist({ randomSample: true, randomSeed: "recommendation-seed-a", pageSize: 6 });
      const sameSeed = sqlite.queryPlaylist({ randomSample: true, randomSeed: "recommendation-seed-a", pageSize: 6 });
      const nextBatch = sqlite.queryPlaylist({ randomSample: true, randomSeed: "recommendation-seed-b", pageSize: 6 });
      const firstIds = first.tasks.map(item => item.id);
      assert.equal(first.total, 42);
      assert.equal(first.page, 1);
      assert.equal(first.tasks.length, 6);
      assert.deepEqual(sameSeed.tasks.map(item => item.id), firstIds, "opening a recommended item should reproduce its originating sample");
      assert.notDeepEqual(nextBatch.tasks.map(item => item.id), firstIds, "a new seed should produce a new random order/sample");
      assert.ok(firstIds.some(id => Number(id.slice("random-task-".length)) >= 6), "recommendations should not be limited to the first sorted page");
    } finally {
      sqlite?.close();
      await rm(root, { recursive: true, force: true });
    }
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
      const currentTask = task({ id: "cached-task", videoId: "cached-video", state: "completed", destination: media, fileStatus: "present", mediaCheckedAt: new Date().toISOString(), tags: ["dance"], tagsUpdatedAt: new Date().toISOString(), queuePosition: 2 });
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
      await current.updatePlaylistFlags("cached-task", { discarded: true });
      assert.equal(currentTask.discarded, true);
      assert.equal(currentTask.queuePosition, null);
      assert.equal((await current.playlist({ page: 1, pageSize: 30 })).total, 0);
      const discarded = await current.playlist({ discarded: "only", page: 1, pageSize: 30 });
      assert.equal(discarded.total, 1);
      assert.equal(discarded.items[0].discarded, true);
      assert.deepEqual(current.playlistTags(), []);
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
      assert.equal(reopened.state.tasks[0].discarded, true);
      const reopenedScheduler = new Scheduler({
        store: reopened,
        aria2: aria2(),
        config: { downloadRoot: root, maxConcurrentTasks: 3 }
      });
      await reopenedScheduler.updatePlaylistFlags("cached-task", { discarded: false });
      assert.equal((await reopenedScheduler.playlist({ page: 1, pageSize: 30 })).total, 1);
      assert.equal((await reopenedScheduler.playlist({ discarded: "only", page: 1, pageSize: 30 })).total, 0);
      reopened.close();
    } finally {
      sqlite?.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  test("imports local-only media without an Iwara ID", async () => {
    const root = await tempRoot();
    let sqlite;
    try {
      const mediaRoot = path.join(root, "Video");
      const localDir = path.join(mediaRoot, "NekroX2");
      await mkdir(localDir, { recursive: true });
      const media = path.join(localDir, "没有远程编号.mp4");
      await writeFile(media, Buffer.concat([Buffer.from([0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70]), Buffer.alloc(2048)]));
      sqlite = new SQLiteStore({
        filePath: path.join(root, "ledger.sqlite"),
        legacyJsonPath: path.join(root, "state.json"),
        backupRoot: path.join(root, "backups")
      });
      await sqlite.load();
      const result = await sqlite.importExistingFiles(mediaRoot);
      assert.equal(result.scanned, 1);
      assert.equal(result.imported, 1);
      assert.equal(result.localImported, 1);
      assert.equal(result.unmatched, 0);
      const imported = sqlite.state.tasks[0];
      assert.match(imported.videoId, /^local-[a-f0-9]{24}$/);
      assert.equal(imported.localOnly, true);
      assert.equal(imported.author, "NekroX2");
      assert.equal(imported.sourcePage, "");
      assert.equal(imported.destination, media);
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
