import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { mkdtemp, mkdir, writeFile, stat, readFile, rm, realpath } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { acquireLock, atomicJson, loadTasksReadOnly, readProgress, runScan } from '../tools/build-mobile-fingerprints.mjs';
import { MobileLibrary, sampleFingerprint } from '../src/mobile-library.mjs';

async function fixture() {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'iwara-mobile-fingerprint-'));
  const root = path.join(temporary, 'Video'); const dataDirectory = path.join(temporary, 'ServiceData');
  await mkdir(root); await mkdir(dataDirectory);
  const dbFile = path.join(dataDirectory, 'ledger.sqlite'); const db = new DatabaseSync(dbFile);
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
    CREATE TABLE tasks(id TEXT PRIMARY KEY, video_id TEXT UNIQUE, state TEXT, playback_position REAL, favorite INTEGER,data_json TEXT);
    CREATE TABLE local_file_fingerprints(path TEXT PRIMARY KEY COLLATE NOCASE, sha256 TEXT,size INTEGER,mtime_ms REAL);
    CREATE TABLE meta(key TEXT PRIMARY KEY,value TEXT);
    INSERT INTO meta VALUES('token-placeholder','DO_NOT_EXPORT_OR_CHANGE');`);
  const files = [path.join(root, 'named-with-no-id.mp4'), path.join(root, '任意名称.mp4')];
  const buffers = [Buffer.alloc(153_000, 17), Buffer.alloc(256_000, 27)];
  for (let index = 0; index < files.length; index += 1) {
    await writeFile(files[index], buffers[index]);
    const task = { id: `task-${index}`, videoId: `video-${index}`, state: 'completed', destination: files[index], title: '资料不能修改', playbackPosition: 36.25, favorite: true };
    db.prepare('INSERT INTO tasks VALUES(?,?,?,?,?,?)').run(task.id, task.videoId, task.state, task.playbackPosition, 1, JSON.stringify(task));
  }
  const outside = { id: 'outside', videoId: 'outside-video', state: 'completed', destination: path.join(temporary, 'not-in-library.mp4') };
  db.prepare('INSERT INTO tasks VALUES(?,?,?,?,?,?)').run(outside.id, outside.videoId, outside.state, 10, 0, JSON.stringify(outside));
  const file = await realpath(files[0]); const info = await stat(file);
  db.prepare('INSERT INTO local_file_fingerprints VALUES(?,?,?,?)').run(file, createHash('sha256').update(buffers[0]).digest('hex'), info.size, info.mtimeMs);
  db.exec(`CREATE TRIGGER deny_task_updates BEFORE UPDATE ON tasks BEGIN SELECT RAISE(ABORT,'task writes forbidden'); END;
    CREATE TRIGGER deny_task_inserts BEFORE INSERT ON tasks BEGIN SELECT RAISE(ABORT,'task writes forbidden'); END;
    CREATE TRIGGER deny_task_deletes BEFORE DELETE ON tasks BEGIN SELECT RAISE(ABORT,'task writes forbidden'); END;`);
  return { temporary, root, dataDirectory, dbFile, db, files, buffers,
    cleanup: async () => { db.close(); await rm(temporary, { recursive: true, force: true }); } };
}

test('mobile standalone scan only adds content fingerprints and reuses valid legacy hashes', async () => {
  const context = await fixture();
  try {
    const before = context.db.prepare('SELECT * FROM tasks ORDER BY id').all();
    const legacy = context.db.prepare('SELECT * FROM local_file_fingerprints').all();
    const result = await runScan({ ...context, bytesPerSecond: 0, logger: () => {} });
    assert.equal(result.running, false); assert.equal(result.failed, 0);
    assert.equal(result.total, 2); assert.equal(result.ready, 2); assert.equal(result.excluded, 1);
    assert.equal(result.bytesHashed, context.buffers[1].length);
    assert.deepEqual(context.db.prepare('SELECT * FROM tasks ORDER BY id').all(), before);
    assert.deepEqual(context.db.prepare('SELECT * FROM local_file_fingerprints').all(), legacy);
    assert.equal(context.db.prepare("SELECT value FROM meta WHERE key='token-placeholder'").get().value, 'DO_NOT_EXPORT_OR_CHANGE');
    const rows = context.db.prepare('SELECT * FROM mobile_media_identity ORDER BY task_id').all();
    for (let index = 0; index < rows.length; index += 1) {
      assert.equal(rows[index].sha256, createHash('sha256').update(context.buffers[index]).digest('hex'));
      assert.equal(rows[index].sample_sha256, await sampleFingerprint(context.files[index], context.buffers[index].length));
    }
    const second = await runScan({ ...context, bytesPerSecond: 0, logger: () => {} });
    assert.equal(second.bytesHashed, 0); assert.equal(second.ready, 2);
    const progress = await readFile(path.join(context.dataDirectory, 'mobile-fingerprint-progress.json'), 'utf8');
    assert(!progress.includes(context.temporary)); assert(!progress.includes('DO_NOT_EXPORT_OR_CHANGE'));
  } finally { await context.cleanup(); }
});

test('task snapshot is read-only and prioritizes cached legacy identities', async () => {
  const context = await fixture();
  try {
    const snapshot = loadTasksReadOnly(context.dbFile, context.root);
    assert.equal(snapshot.completed, 3); assert.equal(snapshot.excluded, 1);
    assert.deepEqual(snapshot.tasks.map(task => task.id), ['task-0', 'task-1']);
  } finally { await context.cleanup(); }
});

test('a live scan lock blocks a second launcher, then releases cleanly', async () => {
  const context = await fixture();
  try {
    const lock = path.join(context.dataDirectory, 'test.lock'); const release = await acquireLock(lock);
    await assert.rejects(acquireLock(lock), /禁止重复启动/);
    await release(); const releaseAgain = await acquireLock(lock); await releaseAgain();
    await atomicJson(lock, { pid: -1, startedAt: 'stale' });
    const staleRelease = await acquireLock(lock); await staleRelease();
  } finally { await context.cleanup(); }
});

test('external running progress refuses a second worker and atomic progress stays parseable', async () => {
  const context = await fixture();
  try {
    const progressFile = path.join(context.dataDirectory, 'mobile-fingerprint-progress.json');
    await atomicJson(progressFile, { pid: process.pid, running: true, ready: 4 });
    assert.equal((await readProgress(progressFile)).ready, 4);
    await assert.rejects(runScan({ ...context, logger: () => {} }), /禁止重复运行/);
    assert.equal(context.db.prepare("SELECT count(*) n FROM sqlite_master WHERE name='mobile_media_identity'").get().n, 0);
  } finally { await context.cleanup(); }
});

test('content changed during hashing is not committed, and the next scan safely retries it', async t => {
  const context = await fixture();
  try {
    // Synchronize with the real fullFingerprint onBytes callback. A wall-clock
    // timeout may fire before the initial stat under a busy parallel test run.
    // Also change the size, so this does not depend on filesystem mtime precision.
    const replacement = Buffer.alloc(context.buffers[1].length + 1, 51);
    let changed = false;
    const originalScan = MobileLibrary.prototype.scan;
    t.mock.method(MobileLibrary.prototype, 'scan', function (...args) {
      let bytesHashed = this.progress.bytesHashed;
      Object.defineProperty(this.progress, 'bytesHashed', {
        enumerable: true, configurable: true,
        get: () => bytesHashed,
        set: value => {
          bytesHashed = value;
          if (value > 0 && !changed) {
            changed = true;
            writeFileSync(context.files[1], replacement);
          }
        }
      });
      return originalScan.apply(this, args);
    });
    const first = await runScan({ ...context, bytesPerSecond: 0, logger: () => {} });
    assert.equal(changed, true);
    assert.equal(first.failed, 1); assert.equal(first.ready, 1);
    assert.equal(context.db.prepare("SELECT count(*) n FROM mobile_media_identity WHERE task_id='task-1'").get().n, 0);
    const second = await runScan({ ...context, bytesPerSecond: 0, logger: () => {} });
    assert.equal(second.failed, 0); assert.equal(second.ready, 2);
    assert.equal(context.db.prepare("SELECT sha256 FROM mobile_media_identity WHERE task_id='task-1'").get().sha256,
      createHash('sha256').update(replacement).digest('hex'));
  } finally { await context.cleanup(); }
});

test('a missing file records failure without changing tasks or blocking valid files', async () => {
  const context = await fixture();
  try {
    await rm(context.files[1]);
    const before = context.db.prepare('SELECT * FROM tasks ORDER BY id').all();
    const result = await runScan({ ...context, bytesPerSecond: 0, logger: () => {} });
    assert.equal(result.ready, 1); assert.equal(result.failed, 1);
    assert.equal(result.issues[0].taskId, 'task-1'); assert.equal(result.issues[0].reason, 'ENOENT');
    assert.deepEqual(context.db.prepare('SELECT * FROM tasks ORDER BY id').all(), before);
  } finally { await context.cleanup(); }
});
