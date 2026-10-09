import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { SQLiteStore } from "../src/sqlite-store.mjs";
import { Han1meImporter } from "../src/han1me-importer.mjs";
import { fullFingerprint, sampleFingerprint } from "../src/mobile-library.mjs";

test("stable Han1me copies import sidecar metadata, preserve the folder video ID, and queue a fingerprint", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "iwara-han1me-import-"));
  const mediaRoot = path.join(root, "han1me"); await mkdir(mediaRoot);
  const videoDirectory = path.join(mediaRoot, "102355"); await mkdir(videoDirectory);
  const database = new SQLiteStore({ filePath: path.join(root, "ledger.sqlite"), backupRoot: path.join(root, "backups"), legacyJsonPath: path.join(root, "state.json") });
  await database.load();
  database.db.exec(`CREATE TABLE mobile_media_identity(task_id TEXT PRIMARY KEY,path TEXT,size INTEGER,mtime_ms REAL,sha256 TEXT,sample_sha256 TEXT)`);
  const file = path.join(videoDirectory, "[Aak] ニヤニヤ教授 LIVE2D_1080P.mp4");
  await writeFile(file, Buffer.alloc(100_000, 7));
  await writeFile(path.join(videoDirectory, "info.json"), JSON.stringify({
    title: "[Aak] ニヤニヤ教授 LIVE2D", chineseTitle: "笑脸教授 LIVE2D", uploadTime: "2024-12-12",
    artist: { name: "Aak" }, tags: ["蔚藍檔案", "笑臉教授", "1080P"], videoUrls: { "1080P": "must-not-be-used" }
  }));
  const queued = []; const imported = [];
  const importer = new Han1meImporter({
    store: database, root: mediaRoot, bytesPerSecond: 0, stabilityMs: 0, minBytes: 1,
    mobileLibrary: { enqueueDownload(task) { queued.push(task.id); return true; } },
    onImported(task) { imported.push(task.id); }, onError(error) { throw new Error(error); }
  });
  try {
    await importer.scan(); // first observation: let file copy settle
    const result = await importer.scan();
    assert.equal(result.imported, 1);
    assert.equal(database.state.tasks.length, 1);
    const task = database.state.tasks[0];
    assert.equal(task.sourcePlatform, "han1meview");
    assert.equal(task.localOnly, true);
    assert.equal(task.state, "completed");
    assert.equal(task.fileStatus, "present");
    assert.equal(task.videoId, "han1meview-102355");
    assert.equal(task.title, "[Aak] ニヤニヤ教授 LIVE2D");
    assert.equal(task.author, "Aak");
    assert.equal(task.uploadTime, "2024-12-12");
    assert.deepEqual(task.tags, ["蔚藍檔案", "笑臉教授", "1080P"]);
    assert.ok(task.tagsUpdatedAt, "sidecar tags carry their info.json modification time as provenance");
    assert.equal(task.tagsSource, "han1me_info_json");
    assert.equal(task.views, null, "do not invent play counts absent from the sidecar");
    assert.match(task.metadataMessage, /info\.json/);
    assert.equal(task.destination, file);
    assert.deepEqual(queued, [task.id]);
    assert.deepEqual(imported, [task.id]);
    assert.equal(database.queryPlaylist({}).tasks.length, 1, "a present completed Han1me row must appear in the ordinary playlist query");
    await importer.scan();
    assert.equal(database.state.tasks.length, 1, "repeated scans must not create another row for the same path");
  } finally {
    await importer.stop(); database.close(); await rm(root, { recursive: true, force: true });
  }
});

test("filename and folder remain a safe fallback when info.json is absent", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "iwara-han1me-fallback-"));
  const mediaRoot = path.join(root, "han1me"); const videoDirectory = path.join(mediaRoot, "112233"); await mkdir(videoDirectory, { recursive: true });
  const database = new SQLiteStore({ filePath: path.join(root, "ledger.sqlite"), backupRoot: path.join(root, "backups"), legacyJsonPath: path.join(root, "state.json") });
  await database.load();
  database.db.exec(`CREATE TABLE mobile_media_identity(task_id TEXT PRIMARY KEY,path TEXT,size INTEGER,mtime_ms REAL,sha256 TEXT,sample_sha256 TEXT)`);
  const file = path.join(videoDirectory, "[Aak] fallback_720P.mp4"); await writeFile(file, Buffer.alloc(100_000, 5));
  const importer = new Han1meImporter({ store: database, root: mediaRoot, bytesPerSecond: 0, stabilityMs: 0, minBytes: 1,
    mobileLibrary: { enqueueDownload: () => true } });
  try {
    await importer.scan(); await importer.scan();
    const task = database.state.tasks[0];
    assert.equal(task.videoId, "han1meview-112233", "a numeric Han1me folder remains a stable ID even without a sidecar");
    assert.equal(task.title, "[Aak] fallback");
    assert.equal(task.author, "Aak");
    assert.equal(task.uploadTime, null);
    assert.deepEqual(task.tags, []);
    assert.match(task.metadataMessage, /未找到 info\.json/);
  } finally { await importer.stop(); database.close(); await rm(root, { recursive: true, force: true }); }
});

test("Han1me copies with a blocked ID or futa tag are not added to the ledger", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "iwara-han1me-filter-"));
  const mediaRoot = path.join(root, "han1me"); const videoDirectory = path.join(mediaRoot, "104155"); await mkdir(videoDirectory, { recursive: true });
  const file = path.join(videoDirectory, "blocked.mp4"); await writeFile(file, Buffer.alloc(100_000, 4));
  await writeFile(path.join(videoDirectory, "info.json"), JSON.stringify({ id: "104155", title: "Blocked by Han ID", tags: ["dance"] }));
  const pixivDirectory = path.join(mediaRoot, "123456"); await mkdir(pixivDirectory, { recursive: true });
  const pixivFile = path.join(pixivDirectory, "blocked-by-pixiv.mp4"); await writeFile(pixivFile, Buffer.alloc(100_000, 5));
  await writeFile(path.join(pixivDirectory, "info.json"), JSON.stringify({ id: "123456", title: "Blocked by Pixiv ID", pixiv: { id: "778899" }, tags: ["dance"] }));
  const tagDirectory = path.join(mediaRoot, "7654321"); await mkdir(tagDirectory, { recursive: true });
  const tagFile = path.join(tagDirectory, "blocked-by-tag.mp4"); await writeFile(tagFile, Buffer.alloc(100_000, 6));
  await writeFile(path.join(tagDirectory, "info.json"), JSON.stringify({ id: "7654321", title: "Blocked by tag", tags: ["扶她"] }));
  const database = new SQLiteStore({ filePath: path.join(root, "ledger.sqlite"), backupRoot: path.join(root, "backups"), legacyJsonPath: path.join(root, "state.json") });
  await database.load();
  const importer = new Han1meImporter({ store: database, root: mediaRoot, minBytes: 1, stabilityMs: 0, bytesPerSecond: 0,
    downloadFilter: { han1meIds: ["104155"], pixivIds: ["778899"], blockedTags: ["futa", "扶她"] }, mobileLibrary: { enqueueDownload: () => { throw new Error("blocked media cannot be fingerprinted"); } } });
  try {
    await importer.scan(); const result = await importer.scan();
    assert.equal(result.filtered, 3);
    assert.equal(database.state.tasks.length, 0);
    assert.equal(await stat(file).then(info => info.isFile()), true, "filtering an externally copied Han1me file does not delete the original");
    assert.equal(await stat(pixivFile).then(info => info.isFile()), true);
    assert.equal(await stat(tagFile).then(info => info.isFile()), true);
    assert.ok(result.issues.some(issue => /Han1me 编号/.test(issue)));
    assert.ok(result.issues.some(issue => /Pixiv 编号/.test(issue)));
    assert.ok(result.issues.some(issue => /标签/.test(issue)));
  } finally { await importer.stop(); database.close(); await rm(root, { recursive: true, force: true }); }
});

test("multiple Han1me roots share import, metadata backfill, and download-filter rules", async () => {
  const temp = await mkdtemp(path.join(tmpdir(), "iwara-han1me-multi-root-"));
  const primaryRoot = path.join(temp, "F-Video", "hanime_download");
  const secondaryRoot = path.join(temp, "E-hanime_download");
  for (const directory of [primaryRoot, secondaryRoot]) await mkdir(directory, { recursive: true });
  const addVideo = async (root, code, name, info, bytes) => {
    const directory = path.join(root, code); await mkdir(directory, { recursive: true });
    const file = path.join(directory, `${name}.mp4`); await writeFile(file, bytes);
    if (info) await writeFile(path.join(directory, "info.json"), JSON.stringify(info));
    return file;
  };
  const ordinaryInfo = { id: "880001", title: "Primary root", artist: { name: "A" }, uploadTime: "2026-01-01", tags: ["dance"], views: 5 };
  const ordinaryBytes = Buffer.alloc(90_000, 11);
  await addVideo(primaryRoot, "880001", "primary", ordinaryInfo, ordinaryBytes);
  await addVideo(primaryRoot, "880003", "duplicate-primary", { id: "880003", title: "Two roots" }, Buffer.alloc(90_000, 13));
  await addVideo(secondaryRoot, "880002", "blocked", { id: "880002", title: "Blocked", tags: ["扶她"] }, Buffer.alloc(90_000, 12));
  await addVideo(secondaryRoot, "880003", "duplicate-secondary", { id: "880003", title: "Two roots" }, Buffer.alloc(90_000, 13));

  const database = new SQLiteStore({ filePath: path.join(temp, "ledger.sqlite"), backupRoot: path.join(temp, "backups"), legacyJsonPath: path.join(temp, "state.json") });
  await database.load();
  database.db.exec("CREATE TABLE mobile_media_identity(task_id TEXT PRIMARY KEY,path TEXT,size INTEGER,mtime_ms REAL,sha256 TEXT,sample_sha256 TEXT)");
  const importer = new Han1meImporter({ store: database, root: primaryRoot, historyRoots: [secondaryRoot],
    bytesPerSecond: 0, stabilityMs: 0, minBytes: 1,
    downloadFilter: { blockedTags: ["futa", "扶她"], han1meIds: [], pixivIds: [], iwaraVideoIds: [] },
    mobileLibrary: { enqueueDownload: () => true } });
  try {
    assert.deepEqual(await importer.applyVideoMetadata([{ code: "880003", author: "Backfilled", uploadTime: "2026-02-02", tags: ["dance"] }]),
      { updatedCount: 1, skippedCount: 0, updatedCodes: ["880003"], skippedCodes: [] });
    assert.deepEqual(await importer.applyViewCounts([{ code: "880003", views: 42 }]),
      { updatedCount: 1, skippedCount: 0, updatedCodes: ["880003"], skippedCodes: [] });
    for (const mediaRoot of [primaryRoot, secondaryRoot]) {
      const sidecar = JSON.parse(await readFile(path.join(mediaRoot, "880003", "info.json"), "utf8"));
      assert.equal(sidecar.author, "Backfilled");
      assert.deepEqual(sidecar.tags, ["dance"]);
      assert.equal(sidecar.views, 42);
    }

    await importer.scan();
    const result = await importer.scan();
    assert.equal(result.rootAvailable, true);
    assert.equal(result.availableRootCount, 2);
    assert.equal(result.imported, 2);
    assert.equal(result.filtered, 1);
    assert.equal(database.state.tasks.length, 2, "the blocked tag stays excluded and identical roots do not duplicate the ledger row");
    assert.deepEqual((await importer.downloadCodes()).codes, ["880001", "880002", "880003"]);
    assert.equal(database.state.tasks.find(task => task.videoId === "han1meview-880003").views, 42);
  } finally { await importer.stop(); database.close(); await rm(temp, { recursive: true, force: true }); }
});

test("download-code sync returns unique numeric IDs from stable media folders only", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "iwara-han1me-codes-"));
  const mediaRoot = path.join(root, "han1me"); await mkdir(mediaRoot);
  const folders = ["102355", "102355", "203344"];
  for (const [index, code] of folders.entries()) {
    const directory = path.join(mediaRoot, code, String(index));
    await mkdir(directory, { recursive: true });
    await writeFile(path.join(directory, `video-${index}.mp4`), Buffer.alloc(index === 2 ? 100_000 : 80_000, index + 1));
  }
  const partial = path.join(mediaRoot, "303355"); await mkdir(partial);
  await writeFile(path.join(partial, "partial.mp4"), Buffer.alloc(10));
  const noId = path.join(mediaRoot, "misc"); await mkdir(noId);
  await writeFile(path.join(noId, "unidentified.mp4"), Buffer.alloc(80_000));
  await writeFile(path.join(noId, "info.json"), JSON.stringify({ id: "404466" }));
  const database = new SQLiteStore({ filePath: path.join(root, "ledger.sqlite"), backupRoot: path.join(root, "backups"), legacyJsonPath: path.join(root, "state.json") });
  await database.load();
  const importer = new Han1meImporter({ store: database, root: mediaRoot, minBytes: 65_536 });
  try {
    const result = await importer.downloadCodes();
    assert.deepEqual(result.codes, ["102355", "203344", "404466"]);
    assert.equal(result.codeCount, 3);
    assert.equal(result.videoFileCount, 4);
    assert.ok(result.generatedAt);
    assert.equal(Object.hasOwn(result, "root"), false, "sync response does not expose the PC folder path");
  } finally { await importer.stop(); database.close(); await rm(root, { recursive: true, force: true }); }
});

test("download-code sync merges legacy and receive roots, deduplicates IDs, and fails closed if either root is unavailable", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "iwara-han1me-multi-root-codes-"));
  const legacyRoot = path.join(root, "legacy");
  const receiveRoot = path.join(root, "receive");
  await mkdir(path.join(legacyRoot, "405190"), { recursive: true });
  await mkdir(path.join(receiveRoot, "405190"), { recursive: true });
  await mkdir(path.join(receiveRoot, "404543"), { recursive: true });
  await writeFile(path.join(legacyRoot, "405190", "legacy.mp4"), Buffer.alloc(70_000, 1));
  await writeFile(path.join(receiveRoot, "405190", "duplicate.mp4"), Buffer.alloc(70_000, 2));
  await writeFile(path.join(receiveRoot, "404543", "new.mp4"), Buffer.alloc(70_000, 3));
  const database = new SQLiteStore({ filePath: path.join(root, "ledger.sqlite"), backupRoot: path.join(root, "backups"), legacyJsonPath: path.join(root, "state.json") });
  await database.load();
  const importer = new Han1meImporter({ store: database, root: receiveRoot, roots: [legacyRoot], minBytes: 65_536 });
  const missingRootImporter = new Han1meImporter({ store: database, root: receiveRoot, roots: [path.join(root, "missing-legacy")], minBytes: 65_536 });
  try {
    const result = await importer.downloadCodes();
    assert.deepEqual(result.codes, ["404543", "405190"]);
    assert.equal(result.codeCount, 2, "the same code in legacy and new receive roots counts once");
    assert.equal(result.videoFileCount, 3, "file count covers both roots, including duplicate-code files");
    await assert.rejects(missingRootImporter.downloadCodes(), /同步目录不完整或不可用/,
      "never return a partial history snapshot when a configured root is missing");
  } finally {
    await importer.stop(); await missingRootImporter.stop(); database.close(); await rm(root, { recursive: true, force: true });
  }
});

test("view-count backfill updates existing and missing sidecars, then enriches existing ledger rows", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "iwara-han1me-view-backfill-"));
  const mediaRoot = path.join(root, "han1me");
  const existingDirectory = path.join(mediaRoot, "123456");
  const missingDirectory = path.join(mediaRoot, "654321");
  await mkdir(existingDirectory, { recursive: true });
  await mkdir(missingDirectory, { recursive: true });
  const existingFile = path.join(existingDirectory, "existing.mp4");
  const missingFile = path.join(missingDirectory, "missing.mp4");
  await writeFile(existingFile, Buffer.alloc(100_000, 1));
  await writeFile(missingFile, Buffer.alloc(100_000, 2));
  await writeFile(path.join(existingDirectory, "info.json"), JSON.stringify({ id: "123456", title: "Keep this title" }));

  const database = new SQLiteStore({
    filePath: path.join(root, "ledger.sqlite"),
    backupRoot: path.join(root, "backups"),
    legacyJsonPath: path.join(root, "state.json"),
  });
  await database.load();
  const tasks = [
    { id: "view-1", videoId: "han1meview-123456", sourcePlatform: "han1meview", localOnly: true,
      title: "Preserved title", author: "Artist", uploadTime: "2025-01-01", tags: ["tag"], tagsUpdatedAt: "2025-01-01T00:00:00Z",
      views: null, viewCount: null, state: "completed", destination: existingFile, fileStatus: "present" },
    { id: "view-2", videoId: "han1meview-654321", sourcePlatform: "han1meview", localOnly: true,
      title: "Second title", author: "Artist", uploadTime: "2025-01-02", tags: ["tag"], tagsUpdatedAt: "2025-01-02T00:00:00Z",
      views: null, viewCount: null, state: "completed", destination: missingFile, fileStatus: "present" },
  ];
  database.state.tasks.push(...tasks);
  await database.save();
  const importer = new Han1meImporter({ store: database, root: mediaRoot, minBytes: 1, stabilityMs: 0, bytesPerSecond: 0 });

  try {
    assert.deepEqual(await importer.missingViewCountCodes(), ["123456", "654321"]);
    const applied = await importer.applyViewCounts([
      { code: "123456", views: 54321 },
      { code: "654321", views: 67890 },
    ]);
    assert.equal(applied.updatedCount, 2);
    assert.equal(applied.skippedCount, 0);

    const existingInfo = JSON.parse(await readFile(path.join(existingDirectory, "info.json"), "utf8"));
    const createdInfo = JSON.parse(await readFile(path.join(missingDirectory, "info.json"), "utf8"));
    assert.equal(existingInfo.title, "Keep this title", "backfill preserves unrelated sidecar metadata");
    assert.equal(existingInfo.views, 54321);
    assert.equal(createdInfo.id, "654321");
    assert.equal(createdInfo.viewCount, 67890);

    await importer.scan();
    assert.equal(database.state.tasks.find(task => task.id === "view-1").views, 54321);
    assert.equal(database.state.tasks.find(task => task.id === "view-2").viewCount, 67890);
    assert.deepEqual(await importer.missingViewCountCodes(), []);
    assert.deepEqual(await importer.applyViewCounts([{ code: "123456", views: 999 }]), {
      updatedCount: 0, skippedCount: 1, updatedCodes: [], skippedCodes: ["123456"],
    }, "a later request cannot overwrite a valid view count");
    await assert.rejects(importer.applyViewCounts([{ code: "../outside", views: 2 }]), /无效/);
  } finally {
    await importer.stop();
    database.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("video metadata backfill fills only fields missing from info.json and ignores filename guesses", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "iwara-han1me-metadata-backfill-"));
  const mediaRoot = path.join(root, "han1me");
  const completeDirectory = path.join(mediaRoot, "111111");
  const missingDirectory = path.join(mediaRoot, "222222");
  await mkdir(completeDirectory, { recursive: true });
  await mkdir(missingDirectory, { recursive: true });
  await writeFile(path.join(completeDirectory, "complete.mp4"), Buffer.alloc(100_000, 1));
  await writeFile(path.join(missingDirectory, "[Filename Guess] missing.mp4"), Buffer.alloc(100_000, 2));
  await writeFile(path.join(completeDirectory, "info.json"), JSON.stringify({
    id: "111111", title: "Keep title", author: "Keep author", uploadTime: "2025-01-02", tags: ["keep-tag"], views: 17,
  }));
  await writeFile(path.join(missingDirectory, "info.json"), JSON.stringify({
    id: "222222", title: "Keep second title", views: 23,
  }));

  const importer = new Han1meImporter({ root: mediaRoot, minBytes: 1, stabilityMs: 0, bytesPerSecond: 0 });
  try {
    assert.deepEqual(await importer.missingVideoMetadataCodes(), ["222222"],
      "metadata inferred from a filename must still be fetched from Hanime1");
    const result = await importer.applyVideoMetadata([
      { code: "111111", author: "Do not replace", uploadTime: "2026-01-01", tags: ["replacement"] },
      { code: "222222", author: "Actual author", uploadTime: "2024-06-05", tags: ["tag-a", "tag-b"] },
    ]);
    assert.deepEqual(result.updatedCodes, ["222222"]);
    assert.deepEqual(result.skippedCodes, ["111111"]);

    const complete = JSON.parse(await readFile(path.join(completeDirectory, "info.json"), "utf8"));
    const enriched = JSON.parse(await readFile(path.join(missingDirectory, "info.json"), "utf8"));
    assert.equal(complete.title, "Keep title");
    assert.equal(complete.author, "Keep author");
    assert.equal(complete.uploadTime, "2025-01-02");
    assert.deepEqual(complete.tags, ["keep-tag"]);
    assert.equal(complete.views, 17);
    assert.equal(enriched.title, "Keep second title");
    assert.equal(enriched.views, 23);
    assert.equal(enriched.author, "Actual author");
    assert.equal(enriched.uploadTime, "2024-06-05");
    assert.deepEqual(enriched.tags, ["tag-a", "tag-b"]);
    assert.equal(enriched.metadataSource, "han1meview");
    assert.deepEqual(await importer.missingVideoMetadataCodes(), []);
    await assert.rejects(importer.applyVideoMetadata([{ code: "../outside", author: "bad" }]), /无效/);
  } finally {
    await importer.stop();
    await rm(root, { recursive: true, force: true });
  }
});

test("existing Han1me rows fill only missing metadata from JSON or the bracketed filename author", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "iwara-han1me-enrich-"));
  const mediaRoot = path.join(root, "han1me"); const videoDirectory = path.join(mediaRoot, "123456"); await mkdir(videoDirectory, { recursive: true });
  const noSidecarDirectory = path.join(mediaRoot, "223344"); await mkdir(noSidecarDirectory, { recursive: true });
  const database = new SQLiteStore({ filePath: path.join(root, "ledger.sqlite"), backupRoot: path.join(root, "backups"), legacyJsonPath: path.join(root, "state.json") });
  await database.load();
  database.db.exec(`CREATE TABLE mobile_media_identity(task_id TEXT PRIMARY KEY,path TEXT,size INTEGER,mtime_ms REAL,sha256 TEXT,sample_sha256 TEXT)`);
  const file = path.join(videoDirectory, "original.mp4"); await writeFile(file, Buffer.alloc(100_000, 4));
  await writeFile(path.join(videoDirectory, "info.json"), JSON.stringify({ title: "JSON title", uploadTime: "2025-04-03", artist: { name: "JSON author" }, tags: ["tag-a"] }));
  const noSidecarFile = path.join(noSidecarDirectory, "[Filename Artist] no-sidecar.mp4"); await writeFile(noSidecarFile, Buffer.alloc(100_000, 2));
  const existing = { id: "existing-row", videoId: "han1meview-123456", sourcePlatform: "han1meview", localOnly: true, state: "completed",
    title: "Keep this title", author: "", uploadTime: null, tags: ["tag-a"], views: null, destination: file, fileStatus: "present" };
  const noSidecar = { id: "existing-no-json", videoId: "han1meview-223344", sourcePlatform: "han1meview", localOnly: true, state: "completed",
    title: "Known title", author: "", uploadTime: null, tags: [], views: null, destination: noSidecarFile, fileStatus: "present", metadataMessage: "retain this message" };
  database.state.tasks.push(existing, noSidecar); await database.save();
  const importer = new Han1meImporter({ store: database, root: mediaRoot, bytesPerSecond: 0, stabilityMs: 0, minBytes: 1,
    mobileLibrary: { enqueueDownload: () => true } });
  try {
    const result = await importer.scan();
    assert.equal(result.metadataUpdated, 2);
    assert.equal(database.state.tasks.length, 2, "enrichment must not create a second ledger row");
    assert.equal(existing.title, "Keep this title", "non-empty values are never overwritten");
    assert.equal(existing.author, "JSON author");
    assert.equal(existing.uploadTime, "2025-04-03");
    assert.deepEqual(existing.tags, ["tag-a"]);
    assert.ok(existing.tagsUpdatedAt, "a matching existing tag array is verified from info.json without being overwritten");
    assert.equal(existing.tagsSource, "han1me_info_json");
    assert.equal(noSidecar.author, "Filename Artist", "only a missing author may be inferred from the leading bracketed filename prefix");
    assert.match(noSidecar.metadataMessage, /文件名前缀补齐作者/);
    await importer.scan();
    assert.equal(importer.status().metadataUpdated, 2, "an unchanged file should not be reprocessed on every scan");
  } finally { await importer.stop(); database.close(); await rm(root, { recursive: true, force: true }); }
});

test("Han1me sidecar metadata can match the stable folder video ID after the media moved elsewhere", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "iwara-han1me-sidecar-by-id-"));
  const mediaRoot = path.join(root, "han1me"); const videoDirectory = path.join(mediaRoot, "110549"); await mkdir(videoDirectory, { recursive: true });
  const database = new SQLiteStore({ filePath: path.join(root, "ledger.sqlite"), backupRoot: path.join(root, "backups"), legacyJsonPath: path.join(root, "state.json") });
  await database.load();
  database.db.exec(`CREATE TABLE mobile_media_identity(task_id TEXT PRIMARY KEY,path TEXT,size INTEGER,mtime_ms REAL,sha256 TEXT,sample_sha256 TEXT)`);
  const file = path.join(videoDirectory, "[exprational] ela-005-Vivian_1080P.mp4"); await writeFile(file, Buffer.alloc(100_000, 7));
  await writeFile(path.join(videoDirectory, "info.json"), JSON.stringify({ title: "ela-005-Vivian", uploadTime: "2026-09-30", artist: "exprational", tags: ["vivian", "animation"] }));
  const oldDestination = path.join(root, "Video", "[exprational] ela-005-Vivian_1080P.mp4");
  const existing = { id: "moved-row", videoId: "han1meview-110549", sourcePlatform: "han1meview", localOnly: true, state: "completed",
    title: "Keep existing title", author: "exprational", uploadTime: "2026-09-30", tags: ["vivian", "animation"],
    destination: oldDestination, fileStatus: "present" };
  database.state.tasks.push(existing); await database.save();
  const importer = new Han1meImporter({ store: database, root: mediaRoot, bytesPerSecond: 0, stabilityMs: 0, minBytes: 1,
    mobileLibrary: { enqueueDownload: () => { throw new Error("metadata-only match must not create a row or queue a fingerprint"); } } });
  try {
    const result = await importer.scan();
    assert.equal(result.metadataUpdated, 1);
    assert.equal(result.imported, 0);
    assert.equal(result.duplicates, 0);
    assert.equal(database.state.tasks.length, 1);
    assert.equal(existing.destination, oldDestination, "ID-based sidecar enrichment never rewrites the relocated media path");
    assert.deepEqual(existing.tags, ["vivian", "animation"]);
    assert.ok(existing.tagsUpdatedAt);
    assert.equal(existing.tagsSource, "han1me_info_json");
  } finally { await importer.stop(); database.close(); await rm(root, { recursive: true, force: true }); }
});

test("matching content restores a missing historical path without creating a second ledger row", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "iwara-han1me-relink-"));
  const mediaRoot = path.join(root, "han1me"); await mkdir(mediaRoot);
  const database = new SQLiteStore({ filePath: path.join(root, "ledger.sqlite"), backupRoot: path.join(root, "backups"), legacyJsonPath: path.join(root, "state.json") });
  await database.load();
  database.db.exec(`CREATE TABLE mobile_media_identity(task_id TEXT PRIMARY KEY,path TEXT,size INTEGER,mtime_ms REAL,sha256 TEXT,sample_sha256 TEXT)`);
  const file = path.join(mediaRoot, "[Aak] relocated.mp4"); const bytes = Buffer.alloc(120_000, 3); await writeFile(file, bytes);
  const info = await stat(file);
  const sample = await sampleFingerprint(file, info.size); const full = await fullFingerprint(file, { bytesPerSecond: 0 });
  const task = { id: "historic-id", videoId: "han1meview-123", sourcePlatform: "han1meview", localOnly: true,
    state: "completed", title: "Existing metadata retained", author: "Aak", destination: path.join(root, "old-location.mp4"),
    fileStatus: "missing", actualFileSize: String(info.size), createdAt: info.mtime.toISOString(), updatedAt: info.mtime.toISOString() };
  database.state.tasks.push(task); await database.save();
  database.db.prepare("INSERT INTO mobile_media_identity VALUES(?,?,?,?,?,?)")
    .run(task.id, task.destination, info.size, info.mtimeMs, full.sha256, sample);
  const importer = new Han1meImporter({ store: database, root: mediaRoot, bytesPerSecond: 0, stabilityMs: 0, minBytes: 1,
    mobileLibrary: { enqueueDownload: () => { throw new Error("a restored identity should not be requeued"); } } });
  try {
    await importer.scan(); const result = await importer.scan();
    assert.equal(result.relinked, 1);
    assert.equal(database.state.tasks.length, 1);
    assert.equal(task.destination, file);
    assert.equal(task.title, "Existing metadata retained");
    assert.equal(task.fileStatus, "present");
    assert.equal(database.queryPlaylist({}).tasks.length, 1);
  } finally { await importer.stop(); database.close(); await rm(root, { recursive: true, force: true }); }
});

test("a duplicate represented by multiple still-present historical rows is skipped without a false ambiguity", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "iwara-han1me-duplicate-"));
  const mediaRoot = path.join(root, "han1me"); await mkdir(mediaRoot);
  const database = new SQLiteStore({ filePath: path.join(root, "ledger.sqlite"), backupRoot: path.join(root, "backups"), legacyJsonPath: path.join(root, "state.json") });
  await database.load();
  database.db.exec(`CREATE TABLE mobile_media_identity(task_id TEXT PRIMARY KEY,path TEXT,size INTEGER,mtime_ms REAL,sha256 TEXT,sample_sha256 TEXT)`);
  const bytes = Buffer.alloc(140_000, 6);
  const paths = [path.join(root, "old-a.mp4"), path.join(root, "old-b.mp4"), path.join(mediaRoot, "copy.mp4")];
  for (const file of paths) await writeFile(file, bytes);
  const info = await stat(paths[0]); const sample = await sampleFingerprint(paths[0], info.size); const full = await fullFingerprint(paths[0], { bytesPerSecond: 0 });
  const tasks = paths.slice(0, 2).map((destination, index) => ({ id: `old-${index}`, videoId: `han1meview-${index}`, sourcePlatform: "han1meview",
    localOnly: true, state: "completed", title: `record-${index}`, author: "Aak", destination, fileStatus: "present",
    createdAt: info.mtime.toISOString(), updatedAt: info.mtime.toISOString() }));
  database.state.tasks.push(...tasks); await database.save();
  const insert = database.db.prepare("INSERT INTO mobile_media_identity VALUES(?,?,?,?,?,?)");
  for (let index = 0; index < tasks.length; index += 1) {
    const fileInfo = await stat(paths[index]); insert.run(tasks[index].id, paths[index], fileInfo.size, fileInfo.mtimeMs, full.sha256, sample);
  }
  const importer = new Han1meImporter({ store: database, root: mediaRoot, bytesPerSecond: 0, stabilityMs: 0, minBytes: 1, mobileLibrary: { enqueueDownload: () => true } });
  try {
    await importer.scan(); const result = await importer.scan();
    assert.equal(result.duplicates, 1);
    assert.equal(result.ambiguous, 0);
    assert.equal(result.issues.length, 0);
    assert.equal(database.state.tasks.length, 2);
  } finally { await importer.stop(); database.close(); await rm(root, { recursive: true, force: true }); }
});

test("an exact Han1me copy merges sidecar data into one J-drive ledger row without redownloading", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "iwara-han1me-ledger-merge-"));
  const mediaRoot = path.join(root, "han1me"); await mkdir(mediaRoot);
  const oldRoot = path.join(root, "J-Video"); await mkdir(oldRoot);
  const database = new SQLiteStore({ filePath: path.join(root, "ledger.sqlite"), backupRoot: path.join(root, "backups"), legacyJsonPath: path.join(root, "state.json") });
  await database.load();
  database.db.exec(`CREATE TABLE mobile_media_identity(task_id TEXT PRIMARY KEY,path TEXT,size INTEGER,mtime_ms REAL,sha256 TEXT,sample_sha256 TEXT)`);
  const bytes = Buffer.alloc(180_000, 17);
  const oldFile = path.join(oldRoot, "old-name.mp4");
  const hanFile = path.join(mediaRoot, "[Han Artist] new-name_1080P.mp4");
  await writeFile(oldFile, bytes); await writeFile(hanFile, bytes);
  await writeFile(path.join(mediaRoot, "info.json"), JSON.stringify({ id: "405616", title: "Han JSON title", views: 877000 }));
  const oldInfo = await stat(oldFile); const hanInfo = await stat(hanFile);
  const sample = await sampleFingerprint(oldFile, oldInfo.size);
  const full = await fullFingerprint(oldFile, { bytesPerSecond: 0 });
  const task = { id: "keep-this-task-id", videoId: "local-old-fingerprint", sourcePlatform: "local_import", localOnly: true,
    state: "completed", attempts: 4, completedLength: String(bytes.length), totalLength: String(bytes.length),
    title: "Old title", author: "本地导入", uploadTime: "2024-05-01", tags: ["old-tag"], views: null, viewCount: null,
    destination: oldFile, fileStatus: "present", actualFileSize: String(bytes.length), playbackPosition: 1234,
    playbackDuration: 9000, watched: true, favorite: true, createdAt: oldInfo.mtime.toISOString(), updatedAt: oldInfo.mtime.toISOString() };
  database.state.tasks.push(task); await database.save();
  database.db.prepare("INSERT INTO mobile_media_identity VALUES(?,?,?,?,?,?)")
    .run(task.id, oldFile, oldInfo.size, oldInfo.mtimeMs, full.sha256, sample);
  let fingerprintEnqueues = 0;
  const importer = new Han1meImporter({ store: database, root: mediaRoot, bytesPerSecond: 0, stabilityMs: 0, minBytes: 1,
    mobileLibrary: { enqueueDownload: () => { fingerprintEnqueues += 1; return true; } } });
  try {
    await importer.scan();
    const result = await importer.scan();
    assert.equal(result.merged, 1);
    assert.equal(database.state.tasks.length, 1, "the matching Han file must update, not duplicate, the completed row");
    assert.equal(task.id, "keep-this-task-id");
    assert.equal(task.videoId, "han1meview-405616");
    assert.equal(task.state, "completed");
    assert.equal(task.attempts, 4);
    assert.equal(task.completedLength, String(bytes.length));
    assert.equal(task.playbackPosition, 1234);
    assert.equal(task.playbackDuration, 9000);
    assert.equal(task.watched, true);
    assert.equal(task.favorite, true);
    assert.equal(task.title, "Han JSON title");
    assert.equal(task.author, "Han Artist", "placeholder authors may be inferred from a bracketed Han filename");
    assert.equal(task.views, 877000);
    assert.equal(task.viewCount, 877000);
    assert.equal(task.uploadTime, "2024-05-01", "fields absent from the sidecar must not be erased");
    assert.deepEqual(task.tags, ["old-tag"], "fields absent from the sidecar must not be erased");
    assert.equal(task.destination, hanFile, "the ledger should point at the Han copy while retaining the old J file");
    assert.equal((await stat(oldFile)).isFile(), true, "merging metadata must not delete the J-drive source file");
    assert.equal(database.db.prepare("SELECT path FROM mobile_media_identity WHERE task_id=?").get(task.id).path, hanFile);
    assert.equal(fingerprintEnqueues, 0, "a completed duplicate must not be queued as a new download or fingerprint task");
    assert.match(task.metadataMessage, /完整文件指纹合并到既有台账/);
    await importer.scan();
    assert.equal(database.state.tasks.length, 1, "a repeated scan must not create a second task");
  } finally { await importer.stop(); database.close(); await rm(root, { recursive: true, force: true }); }
});

test("Han1me scan waits for the copied file to become stable before importing", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "iwara-han1me-settle-"));
  const mediaRoot = path.join(root, "han1me"); await mkdir(mediaRoot);
  const database = new SQLiteStore({ filePath: path.join(root, "ledger.sqlite"), backupRoot: path.join(root, "backups"), legacyJsonPath: path.join(root, "state.json") });
  await database.load();
  database.db.exec(`CREATE TABLE mobile_media_identity(task_id TEXT PRIMARY KEY,path TEXT,size INTEGER,mtime_ms REAL,sha256 TEXT,sample_sha256 TEXT)`);
  const file = path.join(mediaRoot, "unfinished.mp4"); await writeFile(file, Buffer.alloc(100_000, 9));
  const importer = new Han1meImporter({ store: database, root: mediaRoot, bytesPerSecond: 0, stabilityMs: 60_000, minBytes: 1, mobileLibrary: { enqueueDownload: () => true } });
  try {
    await importer.scan();
    await writeFile(file, Buffer.alloc(120_000, 9));
    await importer.scan();
    assert.equal(database.state.tasks.length, 0);
    assert.equal(importer.status().pendingFiles, 1);
  } finally { await importer.stop(); database.close(); await rm(root, { recursive: true, force: true }); }
});
