import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { Script } from "node:vm";
import { mkdir, mkdtemp, readdir, rm, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  allowedOrigin,
  authorizeRequest,
  authorizeBatchDownloadRequest,
  createServer,
  isLoopbackAddress,
  partitionMobileDownloadBatches
} from "../src/server.mjs";
import { issueResourceTicket, verifyResourceTicket, RESOURCE_TICKET_LIFETIME_MS } from "../src/resource-ticket.mjs";

function request(port, path, headers = {}, method = "GET", body = null) {
  return new Promise((resolve, reject) => {
    const payload = body == null ? null : (typeof body === "string" ? body : JSON.stringify(body));
    const requestHeaders = { ...headers };
    if (payload != null && !requestHeaders["content-type"]) requestHeaders["content-type"] = typeof body === "string" ? "application/x-www-form-urlencoded" : "application/json";
    if (payload != null) requestHeaders["content-length"] = Buffer.byteLength(payload);
    const req = http.request({ hostname: "127.0.0.1", port, path, headers: requestHeaders, method }, response => {
      const chunks = [];
      response.on("data", chunk => chunks.push(chunk));
      response.on("end", () => resolve({
        status: response.statusCode,
        headers: response.headers,
        raw: Buffer.concat(chunks),
        body: Buffer.concat(chunks).toString("utf8")
      }));
    });
    req.on("error", reject);
    req.end(payload);
  });
}

test("LAN origin and token helpers only accept private/authorized clients", () => {
  assert.equal(isLoopbackAddress("::ffff:127.0.0.1"), true);
  assert.equal(isLoopbackAddress("192.168.1.10"), false);
  assert.equal(allowedOrigin("http://192.168.1.10:18777", "192.168.1.10:18777"), true);
  assert.equal(allowedOrigin("http://192.0.2.10:18777", "192.0.2.10:18777"), true);
  assert.equal(allowedOrigin("https://example.com", "192.168.1.10:18777"), false);

  const url = new URL("http://192.168.1.10:18777/playlist");
  const remote = address => ({ socket: { remoteAddress: address }, headers: {} });
  assert.equal(authorizeRequest(remote("192.168.1.20"), url, "secret").ok, false);
  assert.equal(authorizeRequest({ socket: { remoteAddress: "192.168.1.20" }, headers: { "x-iwara-access-token": "secret" } }, url, "secret").ok, true);
  assert.equal(authorizeRequest({ socket: { remoteAddress: "192.168.1.20" }, headers: { cookie: "iwara_lan_token=secret" } }, url, "secret").ok, true);
  assert.equal(authorizeRequest({ socket: { remoteAddress: "192.168.1.20" }, headers: {} }, new URL("http://x/?access_token=secret"), "secret").viaQuery, true);
  assert.equal(authorizeRequest(remote("127.0.0.1"), url, "secret").ok, true);
});

test("batch download tickets grant only a live GET for the exact ZIP", () => {
  const token = "a".repeat(36);
  const jobs = new Map([[token, { expiresAt: 10_000 }]]);
  const remoteGet = { socket: { remoteAddress: "192.168.1.20" }, method: "GET", headers: {} };
  const remotePost = { ...remoteGet, method: "POST" };
  assert.deepEqual(authorizeBatchDownloadRequest(remoteGet, new URL(`http://192.168.1.10/batch-download/${token}.zip`), "secret", jobs, 9_999), { ok: true, viaCapability: true });
  assert.equal(authorizeBatchDownloadRequest(remotePost, new URL(`http://192.168.1.10/batch-download/${token}.zip`), "secret", jobs, 9_999).ok, false);
  assert.equal(authorizeBatchDownloadRequest(remoteGet, new URL(`http://192.168.1.10/batch-download/${"b".repeat(36)}.zip`), "secret", jobs, 9_999).ok, false);
  assert.equal(authorizeBatchDownloadRequest(remoteGet, new URL(`http://192.168.1.10/batch-download/${token}.zip`), "secret", jobs, 10_000).ok, false);
});

test("resource tickets authorize only their video asset and expire after twelve hours", () => {
  const now = 1_800_000_000_000;
  const ticket = issueResourceTicket("secret", "media", "video-a", now);
  assert.equal(verifyResourceTicket("secret", "media", "video-a", ticket, now + 1000), true);
  assert.equal(verifyResourceTicket("secret", "cover", "video-a", ticket, now), false);
  assert.equal(verifyResourceTicket("secret", "media", "video-b", ticket, now), false);
  assert.equal(verifyResourceTicket("other", "media", "video-a", ticket, now), false);
  assert.equal(verifyResourceTicket("secret", "media", "video-a", ticket, now + RESOURCE_TICKET_LIFETIME_MS + 1), false);
  const remote = method => ({ socket: { remoteAddress: "192.168.1.20" }, method, headers: {} });
  const url = new URL(`http://192.168.1.10:18777/media/video-a?ticket=${ticket}`);
  assert.equal(authorizeRequest(remote("GET"), url, "secret").ok, false); // mocked clock is in the past
  const live = issueResourceTicket("secret", "media", "video-a");
  url.searchParams.set("ticket", live);
  assert.equal(authorizeRequest(remote("GET"), url, "secret").ok, true);
  assert.equal(authorizeRequest(remote("HEAD"), url, "secret").ok, true);
  assert.equal(authorizeRequest(remote("POST"), url, "secret").ok, false);
  assert.equal(authorizeRequest(remote("GET"), new URL(`http://x/api/ledger?ticket=${live}`), "secret").ok, false);
});

test("LAN info endpoint is available on the local service", async () => {
  const scheduler = { status: () => ({ ok: true }) };
  const service = createServer({
    scheduler,
    host: "127.0.0.1",
    port: 0,
    accessToken: "secret",
    onShutdown: () => {}
  });
  await service.listen();
  const port = service.server.address().port;
  try {
    const response = await request(port, "/api/lan-info");
    assert.equal(response.status, 200);
    const payload = JSON.parse(response.body);
    assert.equal(payload.enabled, true);
    assert.equal(payload.port, 0);
  } finally {
    await service.close();
  }
});

test("mobile Han1me view-count routes list pending codes and accept numeric updates", async () => {
  const calls = [];
  const han1meImporter = {
    status: () => ({ enabled: true }),
    async missingViewCountCodes() { return ["123456", "654321"]; },
    async applyViewCounts(counts) {
      calls.push(counts);
      return { updatedCount: counts.length, skippedCount: 0 };
    },
    async scan() { return { enabled: true }; },
  };
  const service = createServer({
    scheduler: { status: () => ({ ok: true }) },
    host: "127.0.0.1",
    port: 0,
    accessToken: "secret",
    han1meImporter,
    onShutdown: () => {},
  });
  await service.listen();
  const port = service.server.address().port;
  try {
    const pending = await request(port, "/api/mobile/han1me-view-counts/missing");
    assert.equal(pending.status, 200);
    assert.deepEqual(JSON.parse(pending.body).codes, ["123456", "654321"]);

    const saved = await request(port, "/api/mobile/han1me-view-counts", {}, "POST", {
      counts: [{ code: "123456", views: 321 }, { code: "654321", views: 654 }],
    });
    assert.equal(saved.status, 200);
    assert.deepEqual(JSON.parse(saved.body), { updatedCount: 2, skippedCount: 0 });
    assert.deepEqual(calls, [[{ code: "123456", views: 321 }, { code: "654321", views: 654 }]]);
  } finally {
    await service.close();
  }
});

test("mobile Han1me metadata routes list missing codes and persist validated metadata", async () => {
  const calls = [];
  const han1meImporter = {
    status: () => ({ enabled: true }),
    async missingVideoMetadataCodes() { return ["123456", "654321"]; },
    async applyVideoMetadata(videos) {
      calls.push(videos);
      return { updatedCount: videos.length, skippedCount: 0 };
    },
    async scan() { return { enabled: true }; },
  };
  const service = createServer({
    scheduler: { status: () => ({ ok: true }) },
    host: "127.0.0.1",
    port: 0,
    accessToken: "secret",
    han1meImporter,
    onShutdown: () => {},
  });
  await service.listen();
  const port = service.server.address().port;
  try {
    const pending = await request(port, "/api/mobile/han1me-video-metadata/missing");
    assert.equal(pending.status, 200);
    assert.deepEqual(JSON.parse(pending.body).codes, ["123456", "654321"]);

    const saved = await request(port, "/api/mobile/han1me-video-metadata", {}, "POST", {
      videos: [
        { code: "123456", author: "Artist A", uploadTime: "2025-04-03", tags: ["tag-a"] },
        { code: "654321", author: "Artist B", uploadTime: "2024-11-19", tags: ["tag-b", "tag-c"] },
      ],
    });
    assert.equal(saved.status, 200);
    assert.deepEqual(JSON.parse(saved.body), { updatedCount: 2, skippedCount: 0 });
    assert.deepEqual(calls, [[
      { code: "123456", author: "Artist A", uploadTime: "2025-04-03", tags: ["tag-a"] },
      { code: "654321", author: "Artist B", uploadTime: "2024-11-19", tags: ["tag-b", "tag-c"] },
    ]]);
  } finally {
    await service.close();
  }
});

test("author backfill API delegates queue, lease, and result without exposing credentials", async () => {
  const calls = [];
  const scheduler = {
    status: () => ({ ok: true }),
    queueAuthorBackfill: async options => { calls.push(["queue", options]); return { queued: 2, remaining: 10, totalEligible: 12 }; },
    pauseAuthorBackfill: async () => ({ paused: 9 }),
    backfillAuthorsFromFolders: async options => ({ applied: options.apply, eligible: 3 }),
    leaseAuthorBackfill: async () => ({ taskId: "t1", leaseId: "l1", videoId: "FiEbOWOE1GVk9Z" }),
    submitAuthorBackfill: async body => { calls.push(["result", body]); return { id: body.taskId, authorBackfillStatus: "complete" }; }
  };
  const service = createServer({ scheduler, host: "127.0.0.1", port: 0, onShutdown() {} });
  await service.listen(); const port = service.server.address().port;
  try {
    const queued = await request(port, "/api/enrich/queue-authors", {}, "POST", { limit: 2, retryFailed: true });
    assert.equal(queued.status, 200);
    assert.deepEqual(JSON.parse(queued.body), { queued: 2, remaining: 10, totalEligible: 12 });
    assert.deepEqual(calls[0], ["queue", { limit: 2, retryFailed: true }]);
    const paused = await request(port, "/api/enrich/pause-authors", {}, "POST", {});
    assert.equal(paused.status, 200);
    assert.deepEqual(JSON.parse(paused.body), { paused: 9 });
    const folderPreview = await request(port, "/api/enrich/authors-from-folders");
    assert.equal(folderPreview.status, 200);
    assert.deepEqual(JSON.parse(folderPreview.body), { applied: false, eligible: 3 });
    const folderApply = await request(port, "/api/enrich/authors-from-folders", {}, "POST", {});
    assert.equal(folderApply.status, 200);
    assert.deepEqual(JSON.parse(folderApply.body), { applied: true, eligible: 3 });
    const next = await request(port, "/api/enrich/next-authors");
    assert.equal(JSON.parse(next.body).task.videoId, "FiEbOWOE1GVk9Z");
    const result = await request(port, "/api/enrich/authors-result", {}, "POST", { taskId: "t1", leaseId: "l1", ok: true, author: "user", alias: "Display" });
    assert.equal(result.status, 200);
    assert.equal(JSON.parse(result.body).authorBackfillStatus, "complete");
    assert.equal(calls[1][1].leaseId, "l1");
  } finally { await service.close(); }
});

test("Han1me folder import endpoint exposes status and triggers a safe scan", async () => {
  let scans = 0;
  const importer = {
    status: () => ({ enabled: true, running: false, imported: 2 }),
    scan: async () => { scans += 1; return { imported: 2 }; },
    stop: async () => {}
  };
  const service = createServer({ scheduler: { status: () => ({ ok: true }) }, han1meImporter: importer, host: "127.0.0.1", port: 0, onShutdown() {} });
  await service.listen(); const port = service.server.address().port;
  try {
    const status = await request(port, "/api/han1me/import");
    assert.equal(status.status, 200);
    assert.equal(JSON.parse(status.body).imported, 2);
    const started = await request(port, "/api/han1me/import", {}, "POST");
    assert.equal(started.status, 202);
    await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(scans, 1);
  } finally { await service.close(); }
});

test("mobile Han1me download-code endpoint returns only the PC media IDs", async () => {
  const service = createServer({
    scheduler: { status: () => ({ ok: true }) },
    han1meImporter: {
      status: () => ({ enabled: true }),
      downloadCodes: async () => ({ codes: ["102355"], codeCount: 1, videoFileCount: 2, generatedAt: "2026-10-08T00:00:00.000Z" }),
      stop: async () => {}
    },
    host: "127.0.0.1", port: 0, onShutdown() {}
  });
  await service.listen(); const port = service.server.address().port;
  try {
    const response = await request(port, "/api/mobile/han1me-download-codes");
    assert.equal(response.status, 200);
    assert.deepEqual(JSON.parse(response.body), {
      codes: ["102355"], codeCount: 1, videoFileCount: 2, generatedAt: "2026-10-08T00:00:00.000Z"
    });
  } finally { await service.close(); }
});

test("remote media releases cache leases on HEAD, range errors and disconnected clients", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "iwara-media-pin-"));
  const file = path.join(root, "remote.mp4"); await writeFile(file, Buffer.alloc(1024 * 1024));
  let acquired = 0, released = 0;
  const cache = { acquire: async () => { acquired++; let done = false; return { media: { path: file, name: "remote.mp4", profile: "remote-480p" }, release: () => { if (!done) { done = true; released++; } } }; }, close() {} };
  const service = createServer({ scheduler: { status: () => ({}) }, host: "127.0.0.1", port: 0, transcodeCache: cache, onShutdown() {} });
  await service.listen(); const port = service.server.address().port;
  try {
    assert.equal((await request(port, "/media/a?profile=remote", {}, "HEAD")).status, 200);
    assert.equal((await request(port, "/media/a?profile=remote", { range: "bytes=999999999-" })).status, 416);
    assert.equal((await request(port, "/media/a?profile=remote", { range: "bytes=0-1023" })).status, 206);
    await new Promise((resolve, reject) => { const req = http.get({ hostname: "127.0.0.1", port, path: "/media/a?profile=remote" }, response => { response.once("data", () => { response.destroy(); req.destroy(); resolve(); }); }); req.on("error", error => error.code === "ECONNRESET" ? resolve() : reject(error)); });
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(acquired, 4); assert.equal(released, 4);
  } finally { await service.close(); await rm(root, { recursive: true, force: true }); }
});

test("presence endpoint wakes the scheduler and returns to idle", async () => {
  const calls = [];
  const scheduler = {
    status: () => ({ ok: true }),
    setWebPresence(active, clients) {
      calls.push([active, clients]);
      return { active, clients, sleeping: false, idle: !active };
    },
    webPresenceStatus() { return { active: false, clients: 0, sleeping: false, idle: true }; }
  };
  const service = createServer({ scheduler, host: "127.0.0.1", port: 0, onShutdown: () => {} });
  await service.listen();
  const port = service.server.address().port;
  try {
    const active = await request(port, "/api/presence", {}, "POST", { clientId: "test-client", page: "test", active: true });
    assert.equal(active.status, 200);
    assert.equal(JSON.parse(active.body).active, true);
    assert.equal(JSON.parse(active.body).sleeping, false);
    const inactive = await request(port, "/api/presence", {}, "POST", { clientId: "test-client", page: "test", active: false });
    assert.equal(inactive.status, 200);
    assert.equal(JSON.parse(inactive.body).active, false);
    assert.equal(JSON.parse(inactive.body).sleeping, false);
    assert.equal(JSON.parse(inactive.body).idle, true);
    assert.deepEqual(calls.at(-2), [true, 1]);
    assert.deepEqual(calls.at(-1), [false, 0]);
  } finally {
    await service.close();
  }
});

test("shutdown bounds a paused media client and releases its cache pin", { timeout: 9000 }, async () => {
  const root = await mkdtemp(path.join(tmpdir(), "iwara-paused-client-")); const file = path.join(root, "paused.mp4");
  await writeFile(file, Buffer.alloc(1024)); await truncate(file, 64 * 1024 * 1024);
  let released = 0, req;
  const cache = { acquire: async () => { let done = false; return { media: { path: file, name: "paused.mp4" }, release: () => { if (!done) { done = true; released++; } } }; }, close() {} };
  const service = createServer({ scheduler: { status: () => ({}) }, host: "127.0.0.1", port: 0, transcodeCache: cache, onShutdown() {} });
  await service.listen();
  try {
    await new Promise((resolve, reject) => { req = http.get({ hostname: "127.0.0.1", port: service.server.address().port, path: "/media/a?profile=remote" }, response => { response.on("error", () => {}); response.pause(); resolve(); }); req.on("error", error => error.code === "ECONNRESET" ? undefined : reject(error)); });
    const started = performance.now(); await service.close(); assert.ok(performance.now() - started < 7500); await new Promise(resolve => setTimeout(resolve, 20)); assert.equal(released, 1);
  } finally { req?.destroy(); await service.close(); await rm(root, { recursive: true, force: true }); }
});

test("view refresh endpoints expose the manual bulk update flow", async () => {
  const calls = [];
  const scheduler = {
    status: () => ({ ok: true }),
    async refreshViewCountEnrichment(limit) { calls.push(["refresh", limit]); return { queued: 12, remaining: 0 }; },
    async leaseMetadataEnrichment(options) { calls.push(["lease", options]); return { taskId: "task-view" }; }
  };
  const service = createServer({ scheduler, host: "127.0.0.1", port: 0, onShutdown: () => {} });
  await service.listen();
  const port = service.server.address().port;
  try {
    const refresh = await request(port, "/api/enrich/refresh-views", {}, "POST");
    assert.equal(refresh.status, 200);
    assert.equal(JSON.parse(refresh.body).queued, 12);
    const next = await request(port, "/api/enrich/next-views");
    assert.equal(next.status, 200);
    assert.equal(JSON.parse(next.body).task.taskId, "task-view");
    assert.deepEqual(calls, [["refresh", undefined], ["lease", { viewsOnly: true }]]);
  } finally {
    await service.close();
  }
});

test("tag refresh endpoints expose the manual tag update flow", async () => {
  const calls = [];
  const scheduler = {
    status: () => ({ ok: true }),
    async refreshTagEnrichment(limit) { calls.push(["refresh-tags", limit]); return { queued: 8, remaining: 2 }; },
    async leaseMetadataEnrichment(options) { calls.push(["lease", options]); return { taskId: "task-tags" }; }
  };
  const service = createServer({ scheduler, host: "127.0.0.1", port: 0, onShutdown: () => {} });
  await service.listen();
  const port = service.server.address().port;
  try {
    const refresh = await request(port, "/api/enrich/refresh-tags", {}, "POST");
    assert.equal(refresh.status, 200);
    assert.equal(JSON.parse(refresh.body).queued, 8);
    const next = await request(port, "/api/enrich/next-tags");
    assert.equal(next.status, 200);
    assert.equal(JSON.parse(next.body).task.taskId, "task-tags");
    assert.deepEqual(calls, [["refresh-tags", undefined], ["lease", { tagsOnly: true }]]);
  } finally {
    await service.close();
  }
});

test("playlist resource URLs and media ranges work without changing the stored video", async () => {
  const temp = await mkdtemp(path.join(tmpdir(), "iwara-media-range-"));
  const filePath = path.join(temp, "sample.mp4");
  const bytes = Buffer.alloc(8192);
  bytes.write("ftyp", 4);
  await writeFile(filePath, bytes);
  const playlistFilters = [];
  const authorSources = [];
  const scheduler = {
    status: () => ({ ok: true }),
    playlist: async options => { playlistFilters.push(options); return { total: 1, page: 1, pageSize: 30, items: [{ id: "video-a", title: "sample" }] }; },
    playlistAuthors: options => { authorSources.push(options.source); return []; },
    mediaPath: async id => {
      if (id !== "video-a") throw new Error("本地视频不存在");
      return { path: filePath, name: "sample.mp4" };
    }
  };
  const service = createServer({ scheduler, host: "127.0.0.1", port: 0, accessToken: "secret", onShutdown: () => {} });
  await service.listen();
  const port = service.server.address().port;
  try {
    const list = await request(port, "/playlist-data?pageSize=30");
    assert.equal(list.status, 200);
    const item = JSON.parse(list.body).items[0];
    assert.equal(playlistFilters.at(-1).discarded, "exclude");
    assert.match(item.streamUrl, /^\/media\/video-a\?ticket=/);
    assert.match(item.downloadUrl, /^\/media\/video-a\?ticket=.*[&]download=1/);
    assert.match(item.coverUrl, /^\/cover\/video-a\?ticket=/);
    assert.equal(item.streamUrl.includes("secret"), false);
    const hanList = await request(port, "/playlist-data?source=han1&pageSize=30");
    assert.equal(hanList.status, 200);
    assert.equal(playlistFilters.at(-1).source, "han1");
    const authors = await request(port, "/api/playlist-authors?source=iwara");
    assert.equal(authors.status, 200);
    assert.deepEqual(JSON.parse(authors.body).authors, []);
    assert.equal(authorSources.at(-1), "iwara");
    const recommendation = await request(port, "/playlist-data?randomSample=1&randomSeed=seed-a&pageSize=30");
    assert.equal(recommendation.status, 200);
    assert.equal(playlistFilters.at(-1).randomSample, true);
    assert.equal(playlistFilters.at(-1).randomSeed, "seed-a");
    const page = await request(port, "/playlist");
    assert.equal(page.status, 200);
    const inlineScripts = [...page.body.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(match => match[1]);
    assert.ok(inlineScripts.length >= 1);
    for (const inlineScript of inlineScripts) assert.doesNotThrow(() => new Script(inlineScript));
    const script = /<script>([\s\S]*?)<\/script>/.exec(page.body)?.[1];
    assert.ok(script);
    assert.doesNotThrow(() => new Script(script));
    assert.match(page.body, /id="loadSentinel"/);
    assert.match(page.body, /IntersectionObserver/);
    assert.match(page.body, /id="qualityToggle"/);
    assert.match(page.body, /setPlaybackProfile/);
    assert.match(page.body, /id="pageInfo"/);
    assert.match(page.body, /id="playModeToggle"/);
    assert.match(page.body, /sourceSwitch\.id='sourceFilter'/);
    assert.match(page.body, /discardBtn/);
    assert.match(page.body, /已丢弃（找回）/);
    assert.match(page.body, /id="card-select"|class="card-select"/);
    assert.match(page.body, /id="downloadSelected"/);
    assert.match(page.body, /id="selectionModeToggle"/);
    assert.match(page.body, /\.cover-image\.portrait-cover\{object-fit:contain!important/);
    assert.match(script, /function setCoverOrientation\(image\)/);
    assert.match(script, /image\.naturalHeight>image\.naturalWidth\*1\.05/);
    assert.match(page.body, /id="mobileRefresh"/);
    assert.match(page.body, /随机推荐/);
    assert.match(page.body, /免压缩 ZIP/);
    assert.match(page.body, /form\.action='\/batch-download'/);
    assert.match(page.body, /function downloadSelectedWithoutPopup\(\)/);
    assert.match(page.body, /form\.target=frame\.name/);
    assert.match(script, /const batchUiJobs=new Map\(\)/);
    assert.match(script, /frame\.id='batchDownloadFrame-'\+downloadId/);
    assert.match(script, /可继续换一批并下载/);
    assert.match(script, /if\(state\.state==='ready'\|\|state\.state==='transferring'\)\{job\.preparing=false;refreshBatchPending\(\);updateSelectionUi\(\)/);
    assert.doesNotMatch(script, /if\(batchStatusTimer\)clearInterval\(batchStatusTimer\);let misses=0/);
    assert.doesNotMatch(page.body, /form\.target='_blank'/);
    assert.match(page.body, /form\.submit\(\)/);
    assert.match(page.headers["content-security-policy"], /frame-src 'self'/);
    assert.equal((await request(port, "/playlist-data?pageSize=30", { origin: "null" })).status, 403, "opaque origins stay blocked on API reads");
    assert.match(page.body, /selection-mode #status:not\(:empty\)\{position:static/);
    assert.doesNotMatch(page.body, /location\.assign\(result\.url\)/);
    assert.match(script, /function formatByteSize\(value\)/);
    assert.doesNotMatch(script, /\bbytes\(result\.totalBytes\)/);
    const byteFormatterSource = script.split("\n").find(line => line.includes("function formatByteSize"));
    assert.ok(byteFormatterSource);
    const byteFormatter = new Function(`${byteFormatterSource}; return formatByteSize`)();
    assert.equal(byteFormatter(0), "0 B");
    assert.equal(byteFormatter(1024), "1.0 KB");
    assert.equal(byteFormatter(1024 * 1024), "1.0 MB");
    assert.doesNotMatch(page.body, /confirm\('将一次下载/);
    assert.match(page.body, /checkbox\.dispatchEvent\(new Event\('change'/);
    assert.match(page.body, /downloadUrl/);
    assert.match(page.body, /handlePlaybackEnded/);
    assert.match(script, /setActionHandler\('previoustrack',handleMediaPrevious\)/);
    assert.match(script, /setActionHandler\('nexttrack',handleMediaNext\)/);
    assert.match(script, /updateMediaSessionTrack\(t\)/);
    assert.match(script, /updateMediaSessionPlaybackState/);
    assert.doesNotMatch(page.body, /plyr\.polyfilled\.min\.js/);
    assert.match(page.body, /<video id="mainVideo" controls playsinline/);
    assert.match(page.body, /Plyr integration intentionally disabled/);
    assert.match(page.body, /window\.__iwaraSetPage/);
    assert.match(page.body, /iwara-page-jump/);
    assert.match(page.body, /captureLibraryReturnState\(i\)/);
    assert.match(page.body, /restoreLibraryReturnState\(state\)/);
    assert.match(page.body, /pageNo>=Math\.ceil\(totalItems\/playlistPageSize\(\)\)/);
    assert.match(page.body, /mobileFilterSheet/);
    assert.match(page.body, /playbackModeSheet/);
    assert.match(page.body, /webkit-media-controls-panel/);
    assert.match(page.body, /@media\(max-width:600px\)\{header\{position:relative/);
    const recommendationPage = await request(port, "/recommend");
    assert.equal(recommendationPage.status, 200);
    assert.match(recommendationPage.body, /id="recommendLink"/);
    assert.match(recommendationPage.body, /随机推荐 · 本批/);
    assert.match(recommendationPage.body, /location\.pathname==='\/recommend'/);
    const recommendationScript = /<script>([\s\S]*?)<\/script>/.exec(recommendationPage.body)?.[1];
    assert.ok(recommendationScript);
    assert.doesNotThrow(() => new Script(recommendationScript));
    const tokenRecommendationPage = await request(port, "/recommend?access_token=secret");
    assert.equal(tokenRecommendationPage.status, 200);
    const discardedList = await request(port, "/playlist-data?discarded=only&pageSize=30");
    assert.equal(discardedList.status, 200);
    assert.equal(playlistFilters.at(-1).discarded, "only");
    const plyrCss = await request(port, "/assets/plyr/plyr.css");
    assert.equal(plyrCss.status, 200);
    assert.match(plyrCss.headers["content-type"], /^text\/css/);
    assert.match(plyrCss.body, /\.plyr/);
    const plyrJs = await request(port, "/assets/plyr/plyr.polyfilled.min.js");
    assert.equal(plyrJs.status, 200);
    assert.match(plyrJs.headers["content-type"], /^application\/javascript/);
    assert.match(plyrJs.body, /Plyr/);
    const plyrSvg = await request(port, "/assets/plyr/plyr.svg");
    assert.equal(plyrSvg.status, 200);
    assert.match(plyrSvg.headers["content-type"], /^image\/svg\+xml/);
    const head = await request(port, item.streamUrl, { range: "bytes=100-" }, "HEAD");
    assert.equal(head.status, 206);
    assert.equal(head.headers["content-range"], "bytes 100-8191/8192");
    assert.equal(head.raw.length, 0);
    const open = await request(port, item.streamUrl, { range: "bytes=100-" });
    assert.equal(open.status, 206);
    assert.equal(open.raw.length, 8092);
    const download = await request(port, item.downloadUrl, { range: "bytes=0-3" });
    assert.equal(download.status, 206);
    assert.match(download.headers["content-disposition"], /^attachment;/);
    const suffix = await request(port, item.streamUrl, { range: "bytes=-200" });
    assert.equal(suffix.status, 206);
    assert.equal(suffix.raw.length, 200);
    assert.equal(suffix.headers["content-range"], "bytes 7992-8191/8192");
    const multiple = await request(port, item.streamUrl, { range: "bytes=0-3,100-103" });
    assert.equal(multiple.status, 206);
    assert.match(multiple.headers["content-type"], /^multipart\/byteranges; boundary=/);
    assert.equal(multiple.raw.length, Number(multiple.headers["content-length"]));
    assert.match(multiple.body, /Content-Range: bytes 0-3\/8192/);
    assert.match(multiple.body, /Content-Range: bytes 100-103\/8192/);
    const invalid = await request(port, item.streamUrl, { range: "bytes=9000-" });
    assert.equal(invalid.status, 416);
    const emptySuffix = await request(port, item.streamUrl, { range: "bytes=-0" });
    assert.equal(emptySuffix.status, 416);
    const diagnostics = await request(port, "/api/media-diagnostics/video-a?since=0");
    assert.equal(diagnostics.status, 200);
    assert.equal(JSON.parse(diagnostics.body).events.at(-1).status, 416);
    const remoteService = createServer({
      scheduler,
      host: "127.0.0.1",
      port: 0,
      accessToken: "secret",
      transcodeCache: {
        get: async () => ({ path: filePath, name: "sample.480p.mp4" }),
        close: () => {}
      },
      onShutdown: () => {}
    });
    await remoteService.listen();
    const remotePort = remoteService.server.address().port;
    const remoteList = await request(remotePort, "/playlist-data?profile=remote&pageSize=30");
    const remotePayload = JSON.parse(remoteList.body);
    assert.equal(remotePayload.playbackProfile, "remote");
    const remoteItem = remotePayload.items[0];
    assert.equal(remoteItem.playbackProfile, "remote");
    assert.match(remoteItem.streamUrl, /[?&]profile=remote(?:&|$)/);
    const tailscaleList = await request(remotePort, "/playlist-data?pageSize=30", { host: `100.64.0.3:${remotePort}` });
    assert.equal(JSON.parse(tailscaleList.body).items[0].playbackProfile, "remote");
    const explicitLocalList = await request(remotePort, "/playlist-data?profile=local&pageSize=30", { host: `100.64.0.3:${remotePort}` });
    const explicitLocalPayload = JSON.parse(explicitLocalList.body);
    assert.equal(explicitLocalPayload.playbackProfile, "local");
    assert.equal(explicitLocalPayload.items[0].playbackProfile, "local");
    assert.match(explicitLocalPayload.items[0].streamUrl, /[?&]profile=local(?:&|$)/);
    const remoteRange = await request(remotePort, remoteItem.streamUrl, { range: "bytes=0-99" });
    assert.equal(remoteRange.status, 206);
    assert.match(remoteRange.headers["content-disposition"], /sample\.480p\.mp4/);
    await remoteService.close();
    await rm(filePath);
    assert.equal((await request(port, item.streamUrl)).status, 404);
    assert.equal((await request(port, item.coverUrl)).status, 404);
  } finally {
    await service.close();
    await rm(temp, { recursive: true, force: true });
  }
});

test("batch download streams a ZIP64 archive without compression or temporary files", async () => {
  const temp = await mkdtemp(path.join(tmpdir(), "iwara-batch-download-"));
  const primaryRoot = path.join(temp, "Video");
  const externalRoot = path.join(temp, "hanime_download");
  const outsideRoot = path.join(temp, "not-configured");
  const firstPath = path.join(primaryRoot, "author-a", "first.mp4");
  const secondPath = path.join(externalRoot, "author-b", "第二个.webm");
  const outsidePath = path.join(outsideRoot, "outside.mp4");
  const firstBytes = Buffer.from("first-video-bytes");
  const secondBytes = Buffer.from("second-video-bytes");
  await mkdir(path.dirname(firstPath), { recursive: true });
  await mkdir(path.dirname(secondPath), { recursive: true });
  await mkdir(path.dirname(outsidePath), { recursive: true });
  await writeFile(firstPath, firstBytes);
  await writeFile(secondPath, secondBytes);
  await writeFile(outsidePath, Buffer.from("outside-root"));
  const scheduler = {
    config: { downloadRoot: primaryRoot, externalMediaRoots: [externalRoot] },
    mediaPath: async id => {
      if (id === "task-a") return { path: firstPath, name: path.basename(firstPath) };
      if (id === "task-b") return { path: secondPath, name: path.basename(secondPath) };
      if (id === "task-outside") return { path: outsidePath, name: path.basename(outsidePath) };
      throw new Error("本地视频不存在");
    }
  };
  const service = createServer({ scheduler, host: "127.0.0.1", port: 0, onShutdown: () => {} });
  await service.listen();
  const port = service.server.address().port;
  try {
    const missing = await request(port, "/api/batch-download", {}, "POST", { taskIds: ["task-a", "missing"] });
    assert.equal(missing.status, 409);
    assert.deepEqual(JSON.parse(missing.body).missing, ["missing"]);
    const outside = await request(port, "/api/batch-download", {}, "POST", { taskIds: ["task-outside"] });
    assert.equal(outside.status, 400);
    assert.match(JSON.parse(outside.body).error, /未配置的媒体目录/);

    const created = await request(port, "/api/batch-download", {}, "POST", { taskIds: ["task-a", "task-b"] });
    assert.equal(created.status, 200);
    const job = JSON.parse(created.body);
    assert.equal(job.fileCount, 2);
    assert.equal(job.totalBytes, firstBytes.length + secondBytes.length);
    assert.match(job.url, /^\/batch-download\/[a-f0-9]{36}\.zip$/);

    const download = await request(port, job.url);
    assert.equal(download.status, 200);
    assert.match(download.headers["content-type"], /^application\/zip/);
    assert.match(download.headers["content-disposition"], /^attachment;/);
    const archive = download.raw;
    assert.equal(Number(download.headers["content-length"]), archive.length, "the browser should receive an exact length for download progress");
    let cursor = 0;
    const expected = new Map([
      ["author-a/first.mp4", firstBytes],
      ["external-1-hanime_download/author-b/第二个.webm", secondBytes]
    ]);
    let localEntries = 0;
    while (archive.readUInt32LE(cursor) === 0x04034b50) {
      const flags = archive.readUInt16LE(cursor + 6);
      const method = archive.readUInt16LE(cursor + 8);
      const nameLength = archive.readUInt16LE(cursor + 26);
      const extraLength = archive.readUInt16LE(cursor + 28);
      const nameStart = cursor + 30;
      const name = archive.subarray(nameStart, nameStart + nameLength).toString("utf8");
      const expectedBytes = expected.get(name);
      assert.ok(expectedBytes, `unexpected archive entry: ${name}`);
      assert.equal(method, 0, "ZIP entries should be stored without compression");
      assert.equal(flags & 0x0008, 0x0008, "ZIP entry should use a data descriptor");
      const dataStart = nameStart + nameLength + extraLength;
      assert.deepEqual(archive.subarray(dataStart, dataStart + expectedBytes.length), expectedBytes);
      const descriptorStart = dataStart + expectedBytes.length;
      assert.equal(archive.readUInt32LE(descriptorStart), 0x08074b50);
      assert.equal(archive.readBigUInt64LE(descriptorStart + 8), BigInt(expectedBytes.length));
      assert.equal(archive.readBigUInt64LE(descriptorStart + 16), BigInt(expectedBytes.length));
      expected.delete(name);
      localEntries += 1;
      cursor = descriptorStart + 24;
    }
    assert.equal(localEntries, 2);
    assert.equal(expected.size, 0);
    assert.equal(archive.readUInt32LE(cursor), 0x02014b50, "central directory should follow streamed entries");
    assert.equal(archive.readUInt32LE(archive.length - 22), 0x06054b50, "ZIP end record should be present");
    assert.equal(archive.readUInt32LE(archive.length - 42), 0x07064b50, "ZIP64 locator should be present");
    assert.deepEqual((await readdir(temp)).sort(), ["Video", "hanime_download", "not-configured"]);
  } finally {
    await service.close();
    await rm(temp, { recursive: true, force: true });
  }
});

test("mobile random download respects source, excludes phone records, and streams metadata with each ZIP batch", async () => {
  const temp = await mkdtemp(path.join(tmpdir(), "iwara-mobile-random-download-"));
  const rows = [
    { id: "iwara-a", videoId: "iwara-video-a", sourcePlatform: "iwara", sourcePage: "https://www.iwara.tv/video/iwara-video-a", title: "Iwara A", author: "creator-a", state: "completed", fileStatus: "present", destination: path.join(temp, "iwara-a.mp4"), tags: ["mmd", "dance"], completedAt: "2026-10-08T00:00:00.000Z", views: 321 },
    { id: "iwara-b", videoId: "iwara-video-b", sourcePlatform: "iwara", title: "Iwara B", author: "creator-b", state: "completed", fileStatus: "present", destination: path.join(temp, "iwara-b.mp4"), tags: ["mmd"] },
    { id: "han-a", videoId: "han1meview-123456", sourcePlatform: "han1meview", title: "Han A", author: "creator-h", state: "completed", fileStatus: "present", destination: path.join(temp, "han-a.mp4"), tags: ["live2d"] },
    { id: "gone", videoId: "iwara-gone", sourcePlatform: "iwara", state: "completed", fileStatus: "missing", destination: path.join(temp, "gone.mp4") },
    { id: "discarded", videoId: "iwara-discarded", sourcePlatform: "iwara", state: "completed", fileStatus: "present", destination: path.join(temp, "discarded.mp4"), discarded: true }
  ];
  for (const row of rows) if (row.fileStatus === "present") await writeFile(row.destination, Buffer.from("media:" + row.id));
  const scheduler = {
    config: { downloadRoot: temp, externalMediaRoots: [] },
    store: { state: { tasks: rows } },
    mediaPath: async id => { const row = rows.find(item => item.id === id && item.fileStatus === "present"); if (!row) throw new Error("missing"); return { path: row.destination, name: path.basename(row.destination) }; }
  };
  const service = createServer({ scheduler, host: "127.0.0.1", port: 0, accessToken: "secret", mobileLibrary: {}, onShutdown() {} });
  await service.listen(); const port = service.server.address().port;
  try {
    const planned = await request(port, "/api/mobile/random-download", {}, "POST", { count: 2, source: "iwara", excludeTaskIds: ["iwara-a"] });
    assert.equal(planned.status, 200);
    const plan = JSON.parse(planned.body);
    assert.equal(plan.source, "iwara"); assert.equal(plan.requestedCount, 2); assert.equal(plan.selectedCount, 1);
    assert.equal(plan.alreadyPresentCount, 1); assert.equal(plan.batches.length, 1);
    assert.equal(plan.batches[0].fileCount, 1); assert.match(plan.batches[0].url, /^\/batch-download\/[a-f0-9]{36}\.zip$/);
    assert.equal(plan.batches[0].expiresInSeconds, 12 * 60 * 60);
    const archive = await request(port, plan.batches[0].url);
    assert.equal(archive.status, 200); assert.equal(archive.raw.readUInt32LE(0), 0x04034b50);
    assert.equal(Number(archive.headers["content-length"]), archive.raw.length);
    assert.ok(archive.raw.includes(Buffer.from('"type":"iwara-mobile-random-batch"')));
    assert.ok(archive.raw.includes(Buffer.from('"source":"iwara"')));
    assert.ok(archive.raw.includes(Buffer.from('"taskId":"iwara-b"')));
    assert.ok(archive.raw.includes(Buffer.from('"title":"Iwara B"')));
    assert.equal(archive.raw.includes(Buffer.from('"taskId":"han-a"')), false);

    const han = await request(port, "/api/mobile/random-download", {}, "POST", { count: 20, source: "han1" });
    assert.equal(han.status, 200); const hanPlan = JSON.parse(han.body);
    assert.equal(hanPlan.selectedCount, 1); assert.equal(hanPlan.batches[0].fileCount, 1);
    assert.equal(JSON.parse(han.body).source, "han1");
    const invalid = await request(port, "/api/mobile/random-download", {}, "POST", { count: 101, source: "iwara" });
    assert.equal(invalid.status, 400);
  } finally { await service.close(); await rm(temp, { recursive: true, force: true }); }
});

test("mobile batch partitioning keeps exact limits, never splits a media file, and rejects unsafe sizes", () => {
  const limit = 4_500_000_000;
  const rows = [
    { id: "a", size: 2_250_000_000 },
    { id: "b", size: 2_250_000_000 },
    { id: "c", size: 1 },
    { id: "d", size: limit }
  ];
  const groups = partitionMobileDownloadBatches(rows, limit);
  assert.deepEqual(groups.map(group => group.items.map(item => item.id)), [["a", "b"], ["c"], ["d"]]);
  assert.deepEqual(groups.map(group => group.totalBytes), [limit, 1, limit]);
  assert.throws(() => partitionMobileDownloadBatches([{ size: limit + 1 }], limit), /fit within one batch/);
  assert.throws(() => partitionMobileDownloadBatches([{ size: 0 }], limit), /fit within one batch/);
  assert.throws(() => partitionMobileDownloadBatches([], Number.MAX_SAFE_INTEGER + 1), /positive safe integer/);
});

test("mobile batch form redirects to a tracked GET ZIP transfer and reports missing files", async () => {
  const temp = await mkdtemp(path.join(tmpdir(), "iwara-mobile-batch-download-"));
  const firstPath = path.join(temp, "first.mp4");
  const secondPath = path.join(temp, "second.mp4");
  await writeFile(firstPath, Buffer.from("first-video"));
  await writeFile(secondPath, Buffer.from("second-video"));
  const scheduler = {
    config: { downloadRoot: temp },
    mediaPath: async id => {
      if (id === "task-a") return { path: firstPath, name: "first.mp4" };
      if (id === "task-b") return { path: secondPath, name: "second.mp4" };
      throw new Error("文件不存在");
    }
  };
  const service = createServer({ scheduler, host: "127.0.0.1", port: 0, accessToken: "secret", onShutdown: () => {} });
  await service.listen();
  const port = service.server.address().port;
  try {
    const downloadId = "a".repeat(36);
    const form = (taskIds, id = downloadId) => new URLSearchParams({ taskIds: JSON.stringify(taskIds), access_token: "secret", downloadId: id }).toString();
    const prepared = await request(port, "/batch-download", { origin: "null" }, "POST", form(["task-a", "task-b"]));
    assert.equal(prepared.status, 303);
    assert.match(prepared.headers.location, /^\/batch-download\/[a-f0-9]{36}\.zip$/);
    const ready = await request(port, "/api/batch-download/status?id=" + downloadId, { "x-iwara-access-token": "secret" });
    assert.equal(JSON.parse(ready.body).state, "ready");
    const downloaded = await request(port, prepared.headers.location, { origin: "null" });
    assert.equal(downloaded.status, 200);
    assert.match(downloaded.headers["content-type"], /^application\/zip/);
    assert.match(downloaded.headers["content-disposition"], /^attachment;/);
    assert.equal(Number(downloaded.headers["content-length"]), downloaded.raw.length, "the response should be a complete, length-tracked download");
    assert.equal(downloaded.raw.readUInt32LE(0), 0x04034b50, "redirected GET response should begin with a ZIP local-file header");
    const completed = await request(port, "/api/batch-download/status?id=" + downloadId, { "x-iwara-access-token": "secret" });
    assert.equal(JSON.parse(completed.body).state, "completed");

    const missing = await request(port, "/batch-download", {}, "POST", form(["task-a", "missing"], "b".repeat(36)));
    assert.equal(missing.status, 409);
    assert.match(missing.headers["content-type"], /^text\/html/);
    assert.match(missing.body, /1 个文件缺失或不可用/);
  } finally {
    await service.close();
    await rm(temp, { recursive: true, force: true });
  }
});

test("separate batch downloads can be prepared and transferred concurrently", async () => {
  const temp = await mkdtemp(path.join(tmpdir(), "iwara-concurrent-batch-download-"));
  const filePath = path.join(temp, "sample.mp4");
  await writeFile(filePath, Buffer.from("sample-video-content"));
  const scheduler = {
    config: { downloadRoot: temp },
    mediaPath: async () => ({ path: filePath, name: "sample.mp4" })
  };
  const service = createServer({ scheduler, host: "127.0.0.1", port: 0, accessToken: "secret", onShutdown() {} });
  await service.listen();
  const port = service.server.address().port;
  try {
    const ids = Array.from({ length: 6 }, (_, index) => (index + 10).toString(16).repeat(36));
    const prepared = await Promise.all(ids.map(downloadId => request(
      port,
      "/batch-download",
      { origin: "null" },
      "POST",
      new URLSearchParams({ taskIds: JSON.stringify(["task-a"]), access_token: "secret", downloadId }).toString()
    )));
    for (const response of prepared) {
      assert.equal(response.status, 303);
      assert.match(response.headers.location, /^\/batch-download\/[a-f0-9]{36}\.zip$/);
    }

    const downloads = await Promise.all(prepared.map(response => request(port, response.headers.location, { origin: "null" })));
    for (const download of downloads) {
      assert.equal(download.status, 200);
      assert.equal(Number(download.headers["content-length"]), download.raw.length);
      assert.equal(download.raw.readUInt32LE(0), 0x04034b50);
    }
    const states = await Promise.all(ids.map(id => request(port, "/api/batch-download/status?id=" + id, { "x-iwara-access-token": "secret" })));
    assert.deepEqual(states.map(state => JSON.parse(state.body).state), Array(6).fill("completed"));
  } finally {
    await service.close();
    await rm(temp, { recursive: true, force: true });
  }
});

test("batch download status exposes a live transfer, then marks it complete", async () => {
  const temp = await mkdtemp(path.join(tmpdir(), "iwara-batch-progress-"));
  const filePath = path.join(temp, "large.mp4");
  await writeFile(filePath, Buffer.alloc(8 * 1024 * 1024, 0x5a));
  const scheduler = {
    config: { downloadRoot: temp },
    mediaPath: async () => ({ path: filePath, name: "large.mp4" })
  };
  const service = createServer({ scheduler, host: "127.0.0.1", port: 0, onShutdown() {} });
  await service.listen();
  const port = service.server.address().port;
  try {
    const created = await request(port, "/api/batch-download", {}, "POST", { taskIds: ["large-task"] });
    const job = JSON.parse(created.body);
    const response = await new Promise((resolve, reject) => {
      const req = http.get({ hostname: "127.0.0.1", port, path: job.url }, incoming => {
        incoming.pause();
        resolve(incoming);
      });
      req.on("error", reject);
    });
    assert.equal(response.statusCode, 200);
    const active = await request(port, "/api/batch-download/status?id=" + job.downloadId);
    const activeState = JSON.parse(active.body);
    assert.equal(activeState.state, "transferring");
    assert.ok(activeState.archiveBytes > 0);

    const transferredBytes = new Promise((resolve, reject) => {
      let received = 0;
      response.on("data", chunk => { received += chunk.length; });
      response.on("end", () => resolve(received));
      response.on("error", reject);
    });
    response.resume();
    assert.equal(await transferredBytes, job.archiveBytes);
    const completed = await request(port, "/api/batch-download/status?id=" + job.downloadId);
    assert.equal(JSON.parse(completed.body).state, "completed");
  } finally {
    await service.close();
    await rm(temp, { recursive: true, force: true });
  }
});
