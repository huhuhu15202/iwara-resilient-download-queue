import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rename, rm, copyFile, stat, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { SQLiteStore } from '../src/sqlite-store.mjs';
import { MobileLibrary, fullFingerprint, sampleFingerprint } from '../src/mobile-library.mjs';
import { createServer, authorizeRequest } from '../src/server.mjs';
import { Scheduler } from '../src/scheduler.mjs';

async function until(check, timeout = 5000) {
  const deadline = Date.now() + timeout;
  while (!check()) {
    if (Date.now() >= deadline) throw new Error('等待指纹任务超时');
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}

async function fixture(work) {
  const root = await mkdtemp(path.join(tmpdir(), 'iwara-mobile-'));
  const videoRoot = path.join(root, 'Video'); await mkdir(videoRoot);
  const store = new SQLiteStore({ filePath: path.join(root, 'ledger.sqlite'), legacyJsonPath: path.join(root, 'none.json'), backupRoot: path.join(root, 'backups') });
  await store.load();
  const mobile = new MobileLibrary({ store, root: videoRoot, exportRoot: path.join(root, 'exports'), bytesPerSecond: 0 });
  const add = async (id, content, fields = {}) => {
    const file = path.join(videoRoot, `${id}.mp4`); await writeFile(file, content);
    const task = { id, videoId: id, title: '视频 '+id, author: '作者', tags: ['dance', { id: 'blender' }], state: 'completed', destination: file, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), ...fields };
    store.state.tasks.push(task); await store.save(); return task;
  };
  try { await work({ root, store, mobile, add, videoRoot }); }
  finally { await mobile.stop(); store.close(); await rm(root, { recursive: true, force: true }); }
}
test('content fingerprint survives rename and is not a file-name hash', () => fixture(async ({ add }) => {
  const content = Buffer.alloc(200000, 33); const task = await add('a', content);
  const full = await fullFingerprint(task.destination, { bytesPerSecond: 0 });
  assert.equal(full.sha256, createHash('sha256').update(content).digest('hex'));
  const before = await sampleFingerprint(task.destination, content.length);
  const next = path.join(path.dirname(task.destination), 'completely-renamed.mp4'); await rename(task.destination, next);
  assert.equal((await fullFingerprint(next, { bytesPerSecond: 0 })).sha256, full.sha256);
  assert.equal(await sampleFingerprint(next, content.length), before);
}));
test('sampling is a candidate filter, not proof of identical contents', () => fixture(async ({ add }) => {
  const a = Buffer.alloc(1024*1024, 55); const b = Buffer.from(a); b[200000] = 88;
  const first = await add('a', a); const second = await add('b', b);
  assert.equal(await sampleFingerprint(first.destination, a.length), await sampleFingerprint(second.destination, b.length));
  assert.notEqual((await fullFingerprint(first.destination, { bytesPerSecond: 0 })).sha256, (await fullFingerprint(second.destination, { bytesPerSecond: 0 })).sha256);
}));
test('catalogue exports allowlisted metadata only and never changes ledger rows', () => fixture(async ({ add, store, mobile, root }) => {
  await add('a', Buffer.alloc(70000, 3), { viewCount: 123, completedAt:'2026-10-01T12:34:56Z', playbackPosition: 99, sourcePlatform:'iwara', sourcePage:'https://www.iwara.tv/video/Fixture12345', sourceUrl: 'https://secret.example/?token=private', metadata: { Authorization: 'private' } });
  const outside = path.join(root, 'outside.mp4'); await writeFile(outside, Buffer.alloc(5));
  store.state.tasks.push({ ...store.state.tasks[0], id: 'outside', videoId: 'outside', destination: outside }); await store.save();
  const baseline = store.db.prepare('SELECT * FROM tasks ORDER BY id').all();
  await mobile.scan(); assert.equal(mobile.status().ready, 1); assert.equal(mobile.status().total, 1);
  const snapshot = await mobile.snapshot(); const db = new DatabaseSync(snapshot.file, { readOnly: true });
  try {
    const rows = db.prepare('SELECT * FROM catalogue').all(); assert.equal(rows.length, 1); assert.equal(rows[0].views, 123);
    assert.equal(rows[0].download_time,Date.parse('2026-10-01T12:34:56Z'));
    assert.equal(rows[0].source,'iwara');
    assert.deepEqual(JSON.parse(rows[0].tags), ['dance','blender']); assert.match(rows[0].sha256, /^[0-9a-f]{64}$/);
    assert.equal(db.prepare('PRAGMA user_version').get().user_version, 2);
    const contents = await readFile(snapshot.file); for (const secret of ['secret.example','Authorization','private',root]) assert.equal(contents.includes(Buffer.from(secret)), false);
    assert.deepEqual(store.db.prepare('SELECT * FROM tasks ORDER BY id').all(), baseline);
  } finally { db.close(); await snapshot.cleanup(); }
}));
test('configured external media roots are fingerprinted and exported for phone metadata matching', () => fixture(async ({ root, store, videoRoot }) => {
  const externalRoot = path.join(root, 'hanime_download'); await mkdir(externalRoot);
  const content = Buffer.alloc(70000, 41); const file = path.join(externalRoot, '302', 'renamed-title.mp4');
  await mkdir(path.dirname(file)); await writeFile(file, content);
  const task = { id:'hanime-302', videoId:'han1meview-302', title:'Hanime imported title', alias:'Imported author', author:'Imported author', uploadTime:'2024-12-12', views:9876, tags:['tag-a','tag-b'], state:'completed', destination:file, completedAt:'2026-10-07T02:00:00Z' };
  store.state.tasks.push(task); await store.save();
  const library = new MobileLibrary({ store, root:videoRoot, additionalRoots:[externalRoot], exportRoot:path.join(root,'external-exports'), bytesPerSecond:0 });
  try {
    assert.deepEqual(library.eligibleTasks().map(item=>item.id), ['hanime-302']);
    await library.scan(); assert.equal(library.status().ready,1); assert.equal(library.status().pending,0);
    const snapshot=await library.snapshot(); const db=new DatabaseSync(snapshot.file,{readOnly:true});
    try {
      const row=db.prepare('SELECT * FROM catalogue').get();
      assert.equal(row.task_id,'hanime-302'); assert.equal(row.title,task.title); assert.equal(row.author,task.author);
      assert.equal(row.upload_time,Date.parse('2024-12-12'), 'ISO Han1me upload dates are exported as Android-compatible milliseconds');
      assert.equal(db.prepare('SELECT typeof(upload_time) type FROM catalogue').get().type,'integer');
      assert.equal(row.views,9876); assert.deepEqual(JSON.parse(row.tags),task.tags);
      assert.equal(row.source,'han1');
      assert.equal(row.sha256,createHash('sha256').update(content).digest('hex'));
      assert.equal(row.sample_sha256,await sampleFingerprint(file,content.length));
    } finally { db.close(); await snapshot.cleanup(); }
    const outside=path.join(root,'outside.mp4');await writeFile(outside,Buffer.alloc(8));
    await assert.rejects(library.checkedPath(outside),/已配置的视频目录/);
  } finally { await library.stop(); }
}));
test('changed file invalidates export fingerprint until rehashed; duplicate records stay separate', () => fixture(async ({ add, mobile, store }) => {
  const content = Buffer.alloc(70000, 4); const a = await add('a', content); await add('b', content);
  await mobile.scan(); assert.equal(mobile.status().ready, 2);
  let snapshot = await mobile.snapshot(); let db = new DatabaseSync(snapshot.file, { readOnly: true });
  assert.equal(db.prepare('SELECT COUNT(DISTINCT sha256) count FROM catalogue').get().count, 1); db.close(); await snapshot.cleanup();
  await writeFile(a.destination, Buffer.alloc(70001, 5));
  snapshot = await mobile.snapshot(); db = new DatabaseSync(snapshot.file, { readOnly: true });
  assert.equal(db.prepare("SELECT sha256 FROM catalogue WHERE task_id='a'").get().sha256, null); db.close(); await snapshot.cleanup();
  await mobile.scan(); assert.equal(store.state.tasks.length, 2);
}));
test('scan is idempotent, cancellable and safe to resume', () => fixture(async ({ add, mobile }) => {
  await add('a', Buffer.alloc(300000, 5)); mobile.bytesPerSecond = 1024;
  const first = mobile.scan(); assert.equal(mobile.scan(), first);
  setTimeout(() => void mobile.stop(), 20); await first;
  assert.equal(mobile.status().ready, 0); assert.equal(mobile.status().running, false);
  mobile.closed = false; mobile.bytesPerSecond = 0; await mobile.scan(); assert.equal(mobile.status().ready, 1);
  await mobile.scan(); assert.equal(mobile.progress.bytesHashed, 0);
}));
test('phone catalogue and scan endpoints retain token authorization', () => fixture(async ({ mobile }) => {
  assert.equal(authorizeRequest({ socket: { remoteAddress: '192.168.10.89' }, method: 'GET', headers: {} }, new URL('http://x/api/mobile/catalog.sqlite'), 'secret').ok, false);
  const server = createServer({ scheduler: { status: () => ({ ok: true }) }, mobileLibrary: mobile, host: '127.0.0.1', port: 0, accessToken: 'secret', onShutdown: () => {} });
  await server.listen(); const origin = `http://127.0.0.1:${server.server.address().port}`;
  try {
    assert.equal((await fetch(origin+'/api/mobile/fingerprints', { method:'POST' })).status, 202);
    const status = await (await fetch(origin+'/api/mobile/fingerprints')).json(); assert.equal(status.total, 0);
    const response = await fetch(origin+'/api/mobile/catalog.sqlite'); assert.equal(response.status, 200); assert.equal(response.headers.get('content-type'), 'application/vnd.sqlite3');
    assert.equal(Buffer.from(await response.arrayBuffer()).subarray(0,16).toString(), 'SQLite format 3\0');
  } finally { await server.close(); }
}));

test('completed download automatically hashes after ledger commit, without waiting for the full read', () => fixture(async ({ add, mobile, store, videoRoot, root }) => {
  const content = Buffer.concat([Buffer.from([0,0,0,24,0x66,0x74,0x79,0x70]), Buffer.alloc(70000, 7)]);
  const task = await add('download', content);
  Object.assign(task, { state: 'downloading', stagingFile: task.destination, resolved: { relativePath: 'finished.mp4' }, gid: 'gid-1', destination: null });
  await store.save();
  let committed = false;
  const scheduler = new Scheduler({ store, aria2: { forget: async () => {}, tellStatus: async () => ({ status: 'complete', totalLength: String(content.length), completedLength: String(content.length) }) }, config: { downloadRoot: videoRoot, stagingRoot: path.join(root, 'staging'), minValidMediaBytes: 1024 },
    onCompleted: current => {
      committed = store.db.prepare('SELECT state FROM tasks WHERE id=?').get(current.id).state === 'completed';
      mobile.enqueueDownload(current);
    }
  });
  let release; const gate = new Promise(resolve => { release = resolve; });
  const hashTask = mobile.hashTask.bind(mobile);
  mobile.hashTask = async (...args) => { await gate; return hashTask(...args); };
  await scheduler.reconcileDownloadTask(task);
  assert.equal(committed, true); assert.equal(task.state, 'completed');
  assert.equal(mobile.status().ready, 0); assert.equal(mobile.status().jobs.queued, 1);
  release(); await until(() => mobile.status().ready === 1 && !mobile.pending);
  const row = store.db.prepare('SELECT * FROM mobile_media_identity WHERE task_id=?').get(task.id);
  assert.equal(row.sha256, createHash('sha256').update(content).digest('hex'));
  assert.equal(row.sample_sha256, await sampleFingerprint(task.destination, content.length));
  const exportFile = await mobile.snapshot(); const db = new DatabaseSync(exportFile.file, { readOnly: true });
  try {
    const exported = db.prepare('SELECT * FROM catalogue').get();
    assert.equal(exported.sha256, row.sha256); assert.equal(exported.download_time, Date.parse(task.completedAt));
  } finally { db.close(); await exportFile.cleanup(); }
}));

test('failed completion commit never publishes a fingerprint job', () => fixture(async ({ add, mobile, store, videoRoot, root }) => {
  const task = await add('failed-commit', Buffer.alloc(70000, 2));
  Object.assign(task, { state: 'downloading', stagingFile: task.destination, resolved: { relativePath: 'finished.mp4' }, gid: 'gid-1' });
  await store.save(); let notified = false;
  const original = store.save.bind(store);
  store.save = async () => { if (task.state === 'completed') throw new Error('injected COMMIT failure'); return original(); };
  const scheduler = new Scheduler({ store, aria2: { forget: async () => {} }, config: { downloadRoot: videoRoot, stagingRoot: path.join(root, 'staging') },
    onCompleted: current => { notified = true; mobile.enqueueDownload(current); } });
  await assert.rejects(scheduler.complete(task), /COMMIT/);
  assert.equal(notified, false); assert.equal(mobile.status().jobs.queued, 0);
  assert.equal(store.db.prepare('SELECT state FROM tasks').get().state, 'finalizing');
  store.save = original; await store.save();
  // Covers a crash after the completion COMMIT but before enqueueing.
  mobile.resumeDownloads(); await until(() => mobile.status().ready === 1 && !mobile.pending);
}));

test('automatic hash worker is single-concurrency even when downloads finish during a bulk scan', () => fixture(async ({ add, mobile }) => {
  await add('first', Buffer.alloc(70000, 1));
  const hashTask = mobile.hashTask.bind(mobile); let active = 0, maximum = 0;
  mobile.hashTask = async (...args) => {
    active++; maximum = Math.max(maximum, active);
    try { await new Promise(resolve => setTimeout(resolve, 20)); return await hashTask(...args); }
    finally { active--; }
  };
  const scan = mobile.scan();
  mobile.enqueueDownload(await add('second', Buffer.alloc(70000, 2)));
  mobile.enqueueDownload(await add('third', Buffer.alloc(70000, 3)));
  await scan; await until(() => mobile.status().ready === 3 && !mobile.pending);
  assert.equal(maximum, 1); assert.deepEqual(mobile.status().jobs, { queued: 0, running: 0, failed: 0 });
}));

test('manual scan started before an already-scheduled queue timer cannot create a second worker', () => fixture(async ({ add, mobile }) => {
  const task = await add('first', Buffer.alloc(70000, 1));
  let active = 0, maximum = 0; const hashTask = mobile.hashTask.bind(mobile);
  mobile.hashTask = async (...args) => {
    active++; maximum = Math.max(maximum, active);
    try { await new Promise(resolve => setTimeout(resolve, 20)); return await hashTask(...args); }
    finally { active--; }
  };
  mobile.enqueueDownload(task); await mobile.scan();
  await until(() => !mobile.pending && !mobile.queueTimer);
  assert.equal(maximum, 1); assert.equal(mobile.status().ready, 1);
  assert.deepEqual(mobile.status().jobs, { queued: 0, running: 0, failed: 0 });
}));

test('shutdown preserves pending fingerprints and restart resumes without changing completed time', () => fixture(async ({ add, mobile, store, videoRoot, root }) => {
  const task = await add('resume', Buffer.alloc(300000, 9), { completedAt: '2026-10-04T00:00:00Z' });
  mobile.bytesPerSecond = 1024; mobile.enqueueDownload(task);
  await until(() => mobile.progress.bytesHashed > 0);
  await mobile.stop();
  assert.equal(mobile.status().ready, 0); assert.equal(mobile.status().jobs.queued, 1);
  assert.equal(store.db.prepare('SELECT attempts FROM mobile_fingerprint_jobs').get().attempts, 0);
  const reopened = new MobileLibrary({ store, root: videoRoot, exportRoot: path.join(root, 'exports'), bytesPerSecond: 0 });
  try {
    reopened.resumeDownloads(); await until(() => reopened.status().ready === 1 && !reopened.pending);
    assert.equal(task.completedAt, '2026-10-04T00:00:00Z'); assert.equal(task.state, 'completed');
  } finally { await reopened.stop(); }
}));

test('hash failure is bounded, reported and does not fail a successful download or block another file', () => fixture(async ({ add, mobile, store }) => {
  const missing = await add('missing', Buffer.alloc(70000, 1)); await unlink(missing.destination);
  const valid = await add('valid', Buffer.alloc(70000, 2)); mobile.fingerprintRetryDelayMs = 0;
  mobile.enqueueDownload(missing); mobile.enqueueDownload(valid);
  await until(() => mobile.status().jobs.failed === 1 && !mobile.pending);
  assert.equal(mobile.status().ready, 1); assert.equal(missing.state, 'completed'); assert.equal(valid.state, 'completed');
  const job = store.db.prepare('SELECT * FROM mobile_fingerprint_jobs').get();
  assert.equal(job.task_id, missing.id); assert.equal(job.attempts, 3); assert.equal(job.error, 'ENOENT');
  assert.equal(mobile.progress.issues.some(issue => issue.taskId === missing.id), true);
  await writeFile(missing.destination, Buffer.alloc(70000, 1));
  mobile.enqueueDownload(missing); await until(() => mobile.status().ready === 2 && !mobile.pending);
  assert.equal(mobile.status().jobs.failed, 0);
}));

test('restart skips identities already complete and interrupted running jobs are safely reclaimed', () => fixture(async ({ add, mobile, store }) => {
  const first = await add('first', Buffer.alloc(70000, 1)); await mobile.scan();
  const second = await add('second', Buffer.alloc(70000, 2)); mobile.enqueueDownload(second);
  store.db.prepare("UPDATE mobile_fingerprint_jobs SET state='running'").run();
  mobile.resumeDownloads();
  assert.equal(store.db.prepare('SELECT task_id FROM mobile_fingerprint_jobs').get().task_id, second.id);
  await until(() => mobile.status().ready === 2 && !mobile.pending);
  assert.equal(mobile.progress.bytesHashed, 70000); assert.equal(first.state, 'completed');
}));

test('a recovered finalizing download also enters the automatic fingerprint queue', () => fixture(async ({ add, mobile, store, videoRoot, root }) => {
  const task = await add('recover', Buffer.alloc(70000, 6));
  Object.assign(task, { state: 'finalizing', pendingDestination: task.destination }); await store.save();
  const scheduler = new Scheduler({ store, aria2: {}, config: { downloadRoot: videoRoot, stagingRoot: path.join(root, 'staging') },
    onCompleted: current => mobile.enqueueDownload(current) });
  await scheduler.recoverFinalizing(task);
  assert.equal(store.db.prepare('SELECT state FROM tasks').get().state, 'completed');
  await until(() => mobile.status().ready === 1 && !mobile.pending);
  assert.deepEqual(mobile.status().jobs, { queued: 0, running: 0, failed: 0 });
}));

test('one fingerprint database write failure retries safely and retains the completed ledger', () => fixture(async ({ add, mobile, store }) => {
  const task = await add('write-retry', Buffer.alloc(70000, 8)); mobile.fingerprintRetryDelayMs = 0;
  const prepare = store.db.prepare.bind(store.db); let fail = true;
  store.db.prepare = sql => {
    const statement = prepare(sql);
    if (/INSERT INTO mobile_media_identity/.test(sql)) {
      const run = statement.run.bind(statement);
      statement.run = (...args) => { if (fail) { fail = false; throw new Error('injected fingerprint write failure'); } return run(...args); };
    }
    return statement;
  };
  mobile.enqueueDownload(task); await until(() => mobile.status().ready === 1 && !mobile.pending);
  assert.equal(mobile.status().jobs.failed, 0); assert.equal(task.state, 'completed');
  assert.equal(mobile.progress.bytesHashed, 140000);
  assert.equal(store.db.prepare('SELECT state FROM tasks').get().state, 'completed');
}));
