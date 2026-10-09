import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, copyFile, writeFile, readdir, rename, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { backup } from "node:sqlite";
import { SQLiteStore } from "../src/sqlite-store.mjs";
import { BackupManager, beijingDate, validateBackup } from "../src/backup-manager.mjs";
import { LocalFileIdentity } from "../src/local-file-identity.mjs";
import { failurePolicy, classifyError } from "../src/failure-policy.mjs";
import { Scheduler } from "../src/scheduler.mjs";

async function fixture(work) {
  const root = await mkdtemp(path.join(tmpdir(), "iwara-reliable-"));
  const store = new SQLiteStore({ filePath: path.join(root, "ledger.sqlite"), backupRoot: path.join(root, "backups"), legacyJsonPath: path.join(root, "state.json") });
  await store.load();
  try { await work({ root, store }); }
  finally { await store.fileIdentity?.stop(); store.close(); await rm(root, { recursive: true, force: true }); }
}
const task = (id, videoId = id) => ({ id, videoId, state: "completed", title: id, createdAt: "2026-10-03T00:00:00Z", updatedAt: "2026-10-03T00:00:00Z", watched: true, playbackPosition: 42, playbackDuration: 100 });
const media = value => Buffer.concat([Buffer.from([0,0,0,24,0x66,0x74,0x79,0x70]), Buffer.alloc(4096, value)]);

test("SQLite real mid-transaction constraint failure does not poison snapshots", () => fixture(async ({ store }) => {
  store.state.tasks.push(task("a", "same"), task("b", "same"));
  await assert.rejects(store.save()); assert.equal(store.snapshots.size, 0);
  assert.equal(store.db.prepare("SELECT count(*) count FROM tasks").get().count, 0);
  store.state.tasks[1].videoId = "different"; await store.save();
  assert.equal(store.db.prepare("SELECT count(*) count FROM tasks").get().count, 2);
  store.reloadMemory(); assert.equal(store.state.tasks[0].playbackPosition, 42);
}));

test("SQLite COMMIT failure retains both pending records for the next save", () => fixture(async ({ store }) => {
  store.state.tasks.push(task("a"), task("b"));
  const original = store.db.exec.bind(store.db); let fail = true;
  store.db.exec = sql => { if (sql === "COMMIT" && fail) { fail = false; throw new Error("injected COMMIT failure"); } return original(sql); };
  await assert.rejects(store.save(), /COMMIT/); assert.equal(store.snapshots.size, 0);
  await store.save(); assert.equal(store.snapshots.size, 2); store.reloadMemory(); assert.equal(store.state.tasks.length, 2);
}));

test("expired CDN links are not excluded as whole source hosts", () => fixture(async ({ store }) => {
  const t = task("a"); store.state.tasks.push(t); await store.save();
  for (const category of ["link_expired", "cdn_not_found", "rate_limited", "invalid_media"]) store.recordAttempt(t, { phase: "download", outcome: "failure", sourceHost: "good-cdn.example", category });
  store.recordAttempt(t, { phase: "download", outcome: "failure", sourceHost: "bad-tls.example", category: "tls_certificate" });
  assert.deepEqual(store.failedSourceHosts(t.id), ["bad-tls.example"]);
}));

test("temporary transport failures never poison fresh links on either CDN", () => fixture(async ({ store }) => {
  const t = task('transport'); store.state.tasks.push(t); await store.save();
  for (const category of ['unknown', 'network', 'timeout', 'tls_handshake', 'source_unavailable']) {
    for (const sourceHost of ['hime.iwara.tv', 'mikoto.iwara.tv']) {
      store.recordAttempt(t, { phase: 'download', outcome: 'failure', sourceHost, category, completedLength: 10452992 });
    }
  }
  assert.deepEqual(store.failedSourceHosts(t.id), []);
  assert.equal(classifyError('No URI available.（aria2 错误码 1）'), 'network');
}));

test("manual retry starts a fresh source session without deleting history", () => fixture(async ({ store }) => {
  const t = { ...task('retry'), state: 'failed', attempts: 3, browserFallbackAttempted: true };
  store.state.tasks.push(t); await store.save();
  store.recordAttempt(t, { phase: 'download', outcome: 'failure', sourceHost: 'old.example', category: 'tls_certificate' });
  const scheduler = new Scheduler({ store, aria2: {}, config: { maxConcurrentTasks: 3, leaseMs: 1000 } });
  await scheduler.retryTask(t.id);
  assert.equal(t.attempts, 0); assert.equal(t.browserFallbackAttempted, false);
  assert.equal(store.attemptHistory(t.id).length, 1);
  assert.deepEqual((await scheduler.leaseNext()).avoidHosts, []);
  store.recordAttempt(t, { phase: 'download', outcome: 'failure', sourceHost: 'new.example', category: 'tls_certificate' });
  assert.deepEqual(store.failedSourceHosts(t.id, t.sourceFailureCursor), ['new.example']);
  await store.save(); store.reloadMemory();
  assert.equal(store.state.tasks[0].sourceFailureCursor, t.sourceFailureCursor);
}));

test("failure policy needs video API evidence before declaring permanent failure", () => {
  assert.equal(failurePolicy("HTTP 403").permanent, false);
  assert.equal(failurePolicy("HTTP 404", { stage: "cdn", httpStatus: 404 }).permanent, false);
  assert.equal(failurePolicy("HTTP 404", { stage: "video_api", httpStatus: 404 }).permanent, true);
  assert.equal(failurePolicy("HTTP 403", { stage: "video_api", httpStatus: 403, reason: "unverified_response" }).permanent, false);
  assert.equal(failurePolicy("HTTP 404", { stage: "video_api", httpStatus: 404, reason: "unverified_response" }).permanent, false);
  assert.equal(failurePolicy("CDN 错误页或空文件", null, "cdn").category, "invalid_media");
});

test("daily backup uses Beijing midnight and preserves playback plus configuration", () => fixture(async ({ root, store }) => {
  store.state.tasks.push(task("a")); await store.save();
  let now = Date.parse("2026-10-03T15:59:00Z");
  const manager = new BackupManager({ db: store.db, root: store.backupRoot, config: { lanAccessToken: "private", downloadRoot: "J:\\Video" }, clock: { now: () => now } });
  const first = await manager.runOnce(); assert.equal(beijingDate(now), "2026-10-03");
  now += 120000; const second = await manager.runOnce(); assert.equal(beijingDate(now), "2026-10-04");
  assert.notEqual(first.directory, second.directory);
  const restored = path.join(root, "restore-drill"); await mkdir(restored);
  await copyFile(path.join(second.directory, "ledger.sqlite"), path.join(restored, "ledger.sqlite"));
  await copyFile(path.join(second.directory, "config.json"), path.join(restored, "config.json"));
  assert.equal((await validateBackup(restored)).config.lanAccessToken, "private");
  const restoredStore = new SQLiteStore({ filePath: path.join(restored, "ledger.sqlite"), backupRoot: path.join(restored, "backups"), legacyJsonPath: path.join(restored, "none.json") });
  await restoredStore.load(); assert.equal(restoredStore.state.tasks[0].playbackPosition, 42); restoredStore.close();
  await manager.stop();
}));

test("scheduled backup failure is nonfatal and the next tick retries successfully", () => fixture(async ({ store }) => {
  let calls = 0; const errors = []; let now = Date.parse("2026-10-03T15:59:00Z");
  const manager = new BackupManager({ db: store.db, root: store.backupRoot, clock: { now: () => now }, intervalMs: 20, onError: value => errors.push(value), backupFunction: async (...args) => { if (++calls === 1) throw new Error("disk busy"); return backup(...args); } });
  manager.start();
  for (let count = 0; count < 100 && !manager.status().lastSuccessAt; count++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.ok(manager.status().lastSuccessAt); assert.ok(errors.length);
  now += 120000;
  for (let count = 0; count < 100 && manager.status().date !== "2026-10-04"; count++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(manager.status().date, "2026-10-04"); await manager.stop();
  assert.ok(!(await readdir(store.backupRoot)).some(name => name.startsWith(".pending-")));
}));

test("backup retention keeps seven new dates without deleting legacy backups", () => fixture(async ({ store }) => {
  await writeFile(path.join(store.backupRoot, "ledger-2026-09-01.sqlite"), "legacy");
  let now = Date.parse("2026-10-01T00:00:00Z"); const manager = new BackupManager({ db: store.db, root: store.backupRoot, clock: { now: () => now } });
  for (let index = 0; index < 9; index++) { await manager.runOnce(); now += 86400000; }
  const names = await readdir(store.backupRoot); assert.equal(names.filter(name => /^\d{4}-\d{2}-\d{2}$/.test(name)).length, 7); assert.ok(names.includes("ledger-2026-09-01.sqlite"));
}));

test("incomplete backup is preserved for diagnosis and replaced with a validated snapshot", () => fixture(async ({ store }) => {
  const manager = new BackupManager({ db: store.db, root: store.backupRoot });
  await mkdir(path.join(store.backupRoot, beijingDate())); await manager.runOnce();
  assert.equal((await validateBackup(path.join(store.backupRoot, beijingDate()))).tasks, 0);
  assert.ok((await readdir(store.backupRoot)).some(name => name.includes(".invalid-")));
}));

test("local media rename and root move keep IDs, flags and playback after restart", () => fixture(async ({ root, store }) => {
  const videoRoot = path.join(root, "Video"); await mkdir(videoRoot); const original = path.join(videoRoot, "without-id.mp4"); await writeFile(original, media(1));
  await store.importExistingFiles(videoRoot); const t = store.state.tasks[0]; t.playbackPosition = 42; t.favorite = true; await store.save();
  const oldId = t.id, oldVideoId = t.videoId; store.fileIdentity = new LocalFileIdentity({ store, root: videoRoot, bytesPerSecond: 0 });
  await store.fileIdentity.scan(); const bytes = store.fileIdentity.status().bytesHashed;
  await store.fileIdentity.scan(); assert.equal(store.fileIdentity.status().bytesHashed, bytes);
  const renamed = path.join(videoRoot, "new-name.mp4"); await rename(original, renamed); await store.fileIdentity.scan();
  assert.equal(t.destination, renamed); assert.equal(t.id, oldId); assert.equal(t.videoId, oldVideoId); assert.equal(t.playbackPosition, 42); assert.equal(store.state.tasks.length, 1);
  await store.fileIdentity.stop(); const nextRoot = path.join(root, "moved", "Video"); await mkdir(path.dirname(nextRoot)); await rename(videoRoot, nextRoot);
  store.reloadMemory(); store.fileIdentity = new LocalFileIdentity({ store, root: nextRoot, bytesPerSecond: 0 }); await store.fileIdentity.scan();
  assert.equal(store.state.tasks[0].id, oldId); assert.equal(store.state.tasks[0].favorite, true); assert.equal(store.state.tasks[0].destination, path.join(nextRoot, "new-name.mp4"));
}));

test("identical local copy is not imported again and no file is removed", () => fixture(async ({ root, store }) => {
  const videoRoot = path.join(root, "Video"); await mkdir(videoRoot); const original = path.join(videoRoot, "a.mp4"); await writeFile(original, media(2));
  store.fileIdentity = new LocalFileIdentity({ store, root: videoRoot, bytesPerSecond: 0 }); await store.fileIdentity.scan();
  const copy = path.join(videoRoot, "copy.mp4"); await copyFile(original, copy); await store.fileIdentity.scan();
  assert.equal(store.state.tasks.length, 1); assert.equal((await readdir(videoRoot)).length, 2); assert.ok(store.fileIdentity.status().issues.some(item => item.reason.includes("副本")));
}));

test("unfingerprinted missing history is not guessed from same-size media", () => fixture(async ({ root, store }) => {
  const videoRoot = path.join(root, "Video"); await mkdir(videoRoot); await writeFile(path.join(videoRoot, "different.mp4"), media(3));
  store.state.tasks.push({ ...task("old", "local-old"), localOnly: true, destination: path.join(videoRoot, "missing.mp4") }); await store.save();
  store.fileIdentity = new LocalFileIdentity({ store, root: videoRoot, bytesPerSecond: 0 }); await store.fileIdentity.scan();
  assert.equal(store.state.tasks.length, 1); assert.ok(store.fileIdentity.status().pending >= 1);
}));

test("modified local content is reported without replacing old progress", () => fixture(async ({ root, store }) => {
  const videoRoot = path.join(root, "Video"); await mkdir(videoRoot); const original = path.join(videoRoot, "a.mp4"); await writeFile(original, media(4));
  store.fileIdentity = new LocalFileIdentity({ store, root: videoRoot, bytesPerSecond: 0 }); await store.fileIdentity.scan(); const t = store.state.tasks[0]; t.playbackPosition = 42;
  await writeFile(original, media(5)); await store.fileIdentity.scan();
  assert.equal(t.identityStatus, "changed"); assert.equal(t.playbackPosition, 42); assert.equal(store.fileIdentity.status().changed, 1); assert.equal(store.state.tasks.length, 1);
}));

test("multiple historical identities with identical bytes remain separate and ambiguous", () => fixture(async ({ root, store }) => {
  const videoRoot = path.join(root, "Video"); await mkdir(videoRoot); const a = path.join(videoRoot, "a.mp4"), b = path.join(videoRoot, "b.mp4"); await writeFile(a, media(6)); await copyFile(a, b);
  await store.importExistingFiles(videoRoot); store.fileIdentity = new LocalFileIdentity({ store, root: videoRoot, bytesPerSecond: 0 }); await store.fileIdentity.scan();
  await rename(a, path.join(videoRoot, "renamed.mp4")); await store.fileIdentity.scan();
  assert.equal(store.state.tasks.length, 2); assert.equal(store.fileIdentity.status().ambiguous, 1); assert.equal((await readdir(videoRoot)).length, 2);
}));

test("a file modified during full hashing is rejected and recomputed on the next scan", () => fixture(async ({ root, store }) => {
  const videoRoot = path.join(root, "Video"); await mkdir(videoRoot); const original = path.join(videoRoot, "changing.mp4");
  await writeFile(original, Buffer.concat([media(1), Buffer.alloc(2 * 1024 * 1024, 1)])); await store.importExistingFiles(videoRoot);
  const identity = new LocalFileIdentity({ store, root: videoRoot, bytesPerSecond: 16 * 1024 * 1024 }); store.fileIdentity = identity;
  const running = identity.scan(); while (!identity.state.bytesHashed) await new Promise(resolve => setTimeout(resolve, 2));
  await writeFile(original, Buffer.concat([media(2), Buffer.alloc(2 * 1024 * 1024 + 256, 2)])); await running;
  assert.equal(identity.row(store.state.tasks[0]), undefined); assert.equal(identity.status().failed, 1); assert.ok(identity.status().issues.some(issue => issue.reason.includes("发生变化")));
  identity.bytesPerSecond = 0; await identity.scan(); assert.ok(identity.row(store.state.tasks[0]).sha256); assert.equal(identity.status().failed, 0); assert.equal(store.state.tasks.length, 1);
}));

test("interrupted fingerprint migration resumes from committed files without changing IDs", () => fixture(async ({ root, store }) => {
  const videoRoot = path.join(root, "Video"); await mkdir(videoRoot);
  await writeFile(path.join(videoRoot, "a.mp4"), media(1)); await writeFile(path.join(videoRoot, "b.mp4"), Buffer.concat([media(2), Buffer.alloc(3 * 1024 * 1024, 2)]));
  await store.importExistingFiles(videoRoot); const ids = store.state.tasks.map(task => task.id); store.state.tasks[0].playbackPosition = 42; await store.save();
  let identity = new LocalFileIdentity({ store, root: videoRoot, bytesPerSecond: 16 * 1024 * 1024 }); store.fileIdentity = identity;
  const running = identity.scan(); while (store.db.prepare("SELECT count(*) n FROM local_media_identity").get().n < 1 || identity.state.bytesHashed < 1000000) await new Promise(resolve => setTimeout(resolve, 2));
  await identity.stop(); await running; assert.equal(store.db.prepare("SELECT count(*) n FROM local_media_identity").get().n, 1);
  store.reloadMemory(); identity = new LocalFileIdentity({ store, root: videoRoot, bytesPerSecond: 0 }); store.fileIdentity = identity; await identity.scan();
  assert.deepEqual(store.state.tasks.map(task => task.id), ids); assert.equal(store.state.tasks[0].playbackPosition, 42); assert.equal(identity.status().ready, 2); assert.ok(identity.status().bytesHashed < 3 * 1024 * 1024 + 8192);
}));
