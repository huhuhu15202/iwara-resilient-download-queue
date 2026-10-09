// The phone receives a sanitized, read-only catalogue, never the production DB.
import { DatabaseSync } from 'node:sqlite';
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, readFileSync } from 'node:fs';
import { mkdir, open, realpath, stat, unlink } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { classifyMediaSource } from './media-source.mjs';

export const SAMPLE_BYTES = 65536;
export async function sampleFingerprint(file, size) {
  const handle = await open(file, 'r');
  const hash = createHash('sha256');
  const sizeHeader = Buffer.alloc(8); sizeHeader.writeBigUInt64BE(BigInt(size)); hash.update(sizeHeader);
  try {
    for (const offset of [0, Math.max(0, Math.floor((size - SAMPLE_BYTES) / 2)), Math.max(0, size - SAMPLE_BYTES)]) {
      const length = Math.min(SAMPLE_BYTES, size - offset);
      const header = Buffer.alloc(12); header.writeBigUInt64BE(BigInt(offset)); header.writeUInt32BE(length, 8);
      hash.update(header);
      const buffer = Buffer.alloc(length); let count = 0;
      while (count < length) {
        const result = await handle.read(buffer, count, length - count, offset + count);
        if (!result.bytesRead) throw new Error('文件读取不完整');
        count += result.bytesRead;
      }
      hash.update(buffer);
    }
    return hash.digest('hex');
  } finally { await handle.close(); }
}

export async function fullFingerprint(file, { bytesPerSecond = 32 * 1024 * 1024, signal, onBytes = () => {} } = {}) {
  const before = await stat(file); const hash = createHash('sha256');
  const started = performance.now(); let bytes = 0;
  const stream = createReadStream(file, { highWaterMark: 1024 * 1024, signal });
  for await (const chunk of stream) {
    hash.update(chunk); bytes += chunk.length; onBytes(chunk.length);
    const delay = bytesPerSecond > 0 ? bytes * 1000 / bytesPerSecond - (performance.now() - started) : 0;
    if (delay > 0) await sleep(delay, null, { signal });
  }
  const after = await stat(file);
  if (before.size !== after.size || before.mtimeMs !== after.mtimeMs) throw new Error('计算期间文件变化，请重新扫描');
  return { sha256: hash.digest('hex'), size: after.size, mtimeMs: after.mtimeMs };
}

function cleanTags(tags) {
  return [...new Set((Array.isArray(tags) ? tags : []).map(tag => typeof tag === 'string' ? tag : tag?.id || tag?.name || '').filter(Boolean))];
}

function uploadTimeMillis(value) {
  if (value == null || value === '') return null;
  if (typeof value === 'number' || /^\d+(?:\.\d+)?$/.test(String(value).trim())) {
    const numeric = Number(value);
    return Number.isFinite(numeric) && numeric > 0 ? numeric : null;
  }
  const parsed = Date.parse(String(value));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

export class MobileLibrary {
  constructor({ store, root, additionalRoots = [], exportRoot, externalProgressFile = '', bytesPerSecond = 32 * 1024 * 1024, manageDownloadJobs = true, fingerprintRetryDelayMs = 5000 }) {
    this.store = store; this.root = path.resolve(root);
    this.roots = [...new Set([this.root, ...(Array.isArray(additionalRoots) ? additionalRoots : [])
      .filter(value => typeof value === 'string' && value.trim())
      .map(value => path.resolve(value))])];
    this.exportRoot = exportRoot;
    this.bytesPerSecond = bytesPerSecond; this.pending = null; this.controller = null; this.closed = false;
    this.externalProgressFile = externalProgressFile;
    this.queueTimer = null;
    this.manageDownloadJobs = manageDownloadJobs;
    this.fingerprintRetryDelayMs = fingerprintRetryDelayMs;
    this.progress = { running: false, ready: 0, total: 0, failed: 0, bytesHashed: 0, current: '', lastScanAt: null, issues: [] };
    store.db.exec(`CREATE TABLE IF NOT EXISTS mobile_media_identity (
      task_id TEXT PRIMARY KEY REFERENCES tasks(id) ON DELETE CASCADE,
      path TEXT NOT NULL, size INTEGER NOT NULL, mtime_ms REAL NOT NULL,
      sha256 TEXT NOT NULL, sample_sha256 TEXT NOT NULL
    ); CREATE INDEX IF NOT EXISTS idx_mobile_identity_hash ON mobile_media_identity(sha256);`);
    if (manageDownloadJobs) store.db.exec(`CREATE TABLE IF NOT EXISTS mobile_fingerprint_jobs (
      task_id TEXT PRIMARY KEY REFERENCES tasks(id) ON DELETE CASCADE,
      state TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0,
      next_run_at INTEGER NOT NULL DEFAULT 0, error TEXT NOT NULL DEFAULT '', updated_at TEXT NOT NULL
    );`);
  }
  status() {
    const tasks = this.eligibleTasks(); const total = tasks.length; const ids = new Set(tasks.map(task => task.id));
    const ready = this.store.db.prepare('SELECT task_id FROM mobile_media_identity').all().filter(row => ids.has(row.task_id)).length;
    const jobs = { queued: 0, running: 0, failed: 0 };
    if (this.manageDownloadJobs) {
      for (const row of this.store.db.prepare('SELECT state,COUNT(*) count FROM mobile_fingerprint_jobs GROUP BY state').all()) jobs[row.state] = row.count;
    }
    return { ...this.progress, ...this.externalProgress(), total, ready, pending: Math.max(0, total - ready), sampleVersion: 1, jobs };
  }
  enqueueDownload(task) {
    if (!this.manageDownloadJobs) return false;
    if (!this.eligibleTasks().some(item => item.id === task.id)) return false;
    this.store.db.prepare(`INSERT INTO mobile_fingerprint_jobs VALUES(?,'queued',0,0,'',?)
      ON CONFLICT(task_id) DO UPDATE SET state='queued',attempts=0,next_run_at=0,error='',updated_at=excluded.updated_at`)
      .run(task.id, new Date().toISOString());
    this.scheduleQueue();
    return true;
  }
  resumeDownloads() {
    if (!this.manageDownloadJobs) return;
    this.store.db.prepare("UPDATE mobile_fingerprint_jobs SET state='queued' WHERE state='running'").run();
    const identities = new Set(this.store.db.prepare('SELECT task_id FROM mobile_media_identity').all().map(row => row.task_id));
    const jobs = new Set(this.store.db.prepare('SELECT task_id FROM mobile_fingerprint_jobs').all().map(row => row.task_id));
    // Missing identities are the durable fallback if shutdown happened between
    // the ledger COMMIT and queue insertion. Never re-download a completed file.
    for (const task of this.eligibleTasks()) {
      if (!identities.has(task.id) && !jobs.has(task.id)) this.enqueueDownload(task);
    }
    this.scheduleQueue();
  }
  scheduleQueue(delay = 0) {
    if (!this.manageDownloadJobs || this.closed || this.pending || this.queueTimer) return;
    this.queueTimer = setTimeout(() => {
      this.queueTimer = null;
      if (this.closed || this.pending) return;
      try {
        if (this.externalProgress().running) { this.scheduleQueue(5000); return; }
        // A previous database error may have interrupted the final job UPDATE.
        // There is no active local worker here, so these leases can be reclaimed.
        this.store.db.prepare("UPDATE mobile_fingerprint_jobs SET state='queued' WHERE state='running'").run();
        const next = this.store.db.prepare("SELECT MIN(next_run_at) next FROM mobile_fingerprint_jobs WHERE state='queued'").get().next;
        if (next == null) return;
        if (next > Date.now()) { this.scheduleQueue(Math.min(60000, next - Date.now())); return; }
        void this.startWork(signal => this.drainQueue(signal)).catch(error => {
          console.warn(`[fingerprint queue] ${error.code || error.message}`);
        });
      } catch (error) {
        console.warn(`[fingerprint queue] ${error.code || error.message}`);
        this.scheduleQueue(5000);
      }
    }, delay);
    this.queueTimer.unref?.();
  }
  startWork(work) {
    if (this.pending) return this.pending;
    this.controller = new AbortController();
    Object.assign(this.progress, { running: true, failed: 0, issues: [], bytesHashed: 0 });
    let retryDelay = 0;
    this.pending = work(this.controller.signal).catch(error => { retryDelay = 5000; throw error; }).finally(() => {
      this.progress.running = false; this.progress.current = ''; this.progress.lastScanAt = new Date().toISOString(); this.pending = null;
      this.scheduleQueue(retryDelay);
    });
    return this.pending;
  }
  async drainQueue(signal) {
    while (!signal.aborted) {
      const job = this.store.db.prepare("SELECT * FROM mobile_fingerprint_jobs WHERE state='queued' AND next_run_at<=? ORDER BY updated_at,task_id LIMIT 1").get(Date.now());
      if (!job) break;
      const task = this.eligibleTasks().find(item => item.id === job.task_id);
      if (!task) { this.store.db.prepare('DELETE FROM mobile_fingerprint_jobs WHERE task_id=?').run(job.task_id); continue; }
      this.store.db.prepare("UPDATE mobile_fingerprint_jobs SET state='running',updated_at=? WHERE task_id=?").run(new Date().toISOString(), task.id);
      try {
        await this.hashTask(task, signal);
        this.store.db.prepare('DELETE FROM mobile_fingerprint_jobs WHERE task_id=?').run(task.id);
      } catch (error) {
        const attempts = job.attempts + (signal.aborted ? 0 : 1);
        this.store.db.prepare("UPDATE mobile_fingerprint_jobs SET state=?,attempts=?,next_run_at=?,error=?,updated_at=? WHERE task_id=?")
          .run(attempts >= 3 ? 'failed' : 'queued', attempts, signal.aborted ? 0 : Date.now() + this.fingerprintRetryDelayMs * attempts,
            signal.aborted ? '' : String(error.code || error.message).slice(0, 300), new Date().toISOString(), task.id);
        if (!signal.aborted) this.reportFailure(task, error);
      }
    }
    return this.status();
  }
  eligibleTasks() {
    return this.store.state.tasks.filter(task => {
      if (task.state !== 'completed' || !task.destination) return false;
      const destination = path.resolve(task.destination);
      return this.roots.some(root => {
        const relative = path.relative(root, destination);
        return relative && !relative.startsWith('..') && !path.isAbsolute(relative);
      });
    });
  }
  externalProgress() {
    if (!this.externalProgressFile) return {};
    try {
      const state = JSON.parse(readFileSync(this.externalProgressFile, 'utf8'));
      if (!state.running || !Number.isInteger(state.pid)) return {};
      process.kill(state.pid, 0);
      return { running: true, external: true, bytesHashed: Number(state.bytesHashed || 0), current: path.basename(String(state.current || '')), failed: Number(state.failed || 0), lastScanAt: state.lastScanAt || null };
    } catch { return {}; }
  }
  scan() {
    if (this.closed) return Promise.resolve(this.status());
    if (this.externalProgress().running) return Promise.resolve(this.status());
    if (this.pending) return this.pending;
    return this.startWork(signal => this.run(signal));
  }
  async checkedPath(file) {
    const resolved = await realpath(file);
    for (const allowedRoot of this.roots) {
      try {
        const root = await realpath(allowedRoot);
        const relative = path.relative(root, resolved);
        if (relative && !relative.startsWith('..') && !path.isAbsolute(relative)) return resolved;
      } catch (error) {
        if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') throw error;
      }
    }
    throw new Error('文件不在已配置的视频目录内');
  }
  async run(signal) {
    for (const task of this.eligibleTasks()) {
      if (signal.aborted) break;
      try {
        await this.hashTask(task, signal);
        if (this.manageDownloadJobs) this.store.db.prepare('DELETE FROM mobile_fingerprint_jobs WHERE task_id=?').run(task.id);
      } catch (error) {
        if (signal.aborted) break;
        this.reportFailure(task, error);
      }
    }
    return this.status();
  }
  reportFailure(task, error) {
    this.progress.failed += 1;
    this.progress.issues.push({ taskId: task.id, reason: error.code || error.message });
    this.progress.issues = this.progress.issues.slice(-20);
    console.warn(`[fingerprint] ${task.id}: ${error.code || error.message}`);
  }
  async hashTask(task, signal) {
    const file = await this.checkedPath(task.destination); const info = await stat(file);
    const old = this.store.db.prepare('SELECT * FROM mobile_media_identity WHERE task_id=?').get(task.id);
    if (old && old.path === file && old.size === info.size && old.mtime_ms === info.mtimeMs) return;
    this.progress.current = path.basename(file);
    let digest;
    const exists = this.store.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='local_file_fingerprints'").get();
    if (exists) {
      const cached = this.store.db.prepare('SELECT * FROM local_file_fingerprints WHERE path=? COLLATE NOCASE').get(file);
      if (cached?.size === info.size && cached?.mtime_ms === info.mtimeMs) digest = cached.sha256;
    }
    const sample = await sampleFingerprint(file, info.size);
    if (!digest) digest = (await fullFingerprint(file, { bytesPerSecond: this.bytesPerSecond, signal, onBytes: bytes => this.progress.bytesHashed += bytes })).sha256;
    if (signal.aborted) throw new Error('指纹计算已取消');
    const after = await stat(file);
    if (info.size !== after.size || info.mtimeMs !== after.mtimeMs) throw new Error('文件内容变化，等待下次扫描');
    this.store.db.prepare(`INSERT INTO mobile_media_identity VALUES(?,?,?,?,?,?) ON CONFLICT(task_id) DO UPDATE SET
      path=excluded.path,size=excluded.size,mtime_ms=excluded.mtime_ms,sha256=excluded.sha256,sample_sha256=excluded.sample_sha256`)
      .run(task.id, file, after.size, after.mtimeMs, digest, sample);
  }
  async snapshot() {
    await mkdir(this.exportRoot, { recursive: true });
    const file = path.join(this.exportRoot, `mobile-${randomUUID()}.sqlite`);
    const db = new DatabaseSync(file);
    let count = 0; let ready = 0;
    try {
      db.exec(`PRAGMA journal_mode=DELETE; PRAGMA user_version=2;
        CREATE TABLE catalogue(task_id TEXT PRIMARY KEY,video_id TEXT,title TEXT,author TEXT,upload_time INTEGER,views INTEGER,tags TEXT,size INTEGER,sha256 TEXT,sample_sha256 TEXT,download_time INTEGER,source TEXT NOT NULL DEFAULT 'other');
        CREATE INDEX catalogue_hash ON catalogue(sha256); CREATE INDEX catalogue_sample ON catalogue(size,sample_sha256);
        CREATE TABLE catalogue_meta(key TEXT PRIMARY KEY,value TEXT);
        BEGIN;`);
      const insert = db.prepare('INSERT INTO catalogue VALUES(?,?,?,?,?,?,?,?,?,?,?,?)');
      for (const task of this.eligibleTasks()) {
        let fingerprint = this.store.db.prepare('SELECT * FROM mobile_media_identity WHERE task_id=?').get(task.id);
        try {
          const info = await stat(task.destination);
          if (!fingerprint || fingerprint.path !== await this.checkedPath(task.destination) || info.size !== fingerprint.size || info.mtimeMs !== fingerprint.mtime_ms) fingerprint = null;
          const viewCount = task.views ?? task.viewCount;
          insert.run(task.id, task.videoId || '', task.title || '', task.alias || task.author || '', uploadTimeMillis(task.uploadTime),
            viewCount != null && Number.isFinite(Number(viewCount)) ? Number(viewCount) : null, JSON.stringify(cleanTags(task.tags)), info.size, fingerprint?.sha256 || null, fingerprint?.sample_sha256 || null,
            Number.isFinite(Date.parse(task.completedAt)) ? Date.parse(task.completedAt) : null, classifyMediaSource(task));
          count += 1; if (fingerprint) ready += 1;
        } catch (error) { if (error.code !== 'ENOENT') throw error; }
      }
      const meta = db.prepare('INSERT INTO catalogue_meta VALUES(?,?)');
      for (const [key, value] of Object.entries({ schema: 2, sampleVersion: 1, generatedAt: new Date().toISOString(), count, ready })) meta.run(key, String(value));
      db.exec('COMMIT');
      if (db.prepare('PRAGMA integrity_check').get().integrity_check !== 'ok') throw new Error('手机资料库校验失败');
      db.close();
      return { file, count, ready, cleanup: () => unlink(file).catch(() => {}) };
    } catch (error) { db.close(); await unlink(file).catch(() => {}); throw error; }
  }
  async stop() {
    this.closed = true; clearTimeout(this.queueTimer); this.queueTimer = null; this.controller?.abort();
    try { await this.pending; }
    catch (error) { console.warn(`[fingerprint stop] ${error.code || error.message}`); }
  }
}
