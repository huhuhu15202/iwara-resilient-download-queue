import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { setTimeout as sleep } from "node:timers/promises";
import path from "node:path";

const isLocal = task => (task.localOnly || String(task.videoId || "").startsWith("local-")) && task.sourcePlatform !== "han1meview";
const mediaName = name => /\.(mp4|webm|mkv|mov|avi|m4v)$/i.test(name);
const remoteId = name => /\[[A-Za-z0-9_-]{10,32}\]/.test(path.parse(name).name);

export class LocalFileIdentity {
  constructor({ store, root, bytesPerSecond = 32 * 1024 * 1024, onPathsChanged = () => {}, onError = console.error }) {
    this.store = store; this.root = path.resolve(root); this.bytesPerSecond = bytesPerSecond;
    this.onPathsChanged = onPathsChanged; this.onError = onError;
    this.pending = null; this.closed = false; this.stream = null; this.issues = [];
    this.state = { running: false, ready: 0, pending: 0, ambiguous: 0, changed: 0, failed: 0, bytesHashed: 0, lastScanAt: null };
    store.db.exec(`
      CREATE TABLE IF NOT EXISTS local_media_identity (
        task_id TEXT PRIMARY KEY REFERENCES tasks(id) ON DELETE CASCADE,
        sha256 TEXT NOT NULL, size INTEGER NOT NULL, mtime_ms REAL NOT NULL, path TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_local_identity_hash ON local_media_identity(sha256);
      CREATE TABLE IF NOT EXISTS local_file_fingerprints (
        path TEXT PRIMARY KEY COLLATE NOCASE, sha256 TEXT NOT NULL, size INTEGER NOT NULL, mtime_ms REAL NOT NULL
      );
    `);
    this.state.ready = Number(store.db.prepare("SELECT COUNT(*) count FROM local_media_identity").get().count);
    this.state.pending = Math.max(0, store.state.tasks.filter(isLocal).length - this.state.ready);
  }

  status() {
    const total = this.store.state.tasks.filter(isLocal).length;
    // Each file is committed independently; expose that progress while the
    // initial multi-minute migration is still running, not just at its end.
    const ready = this.closed ? this.state.ready : Number(this.store.db.prepare("SELECT COUNT(*) count FROM local_media_identity").get().count);
    return { ...this.state, total, ready, pending: Math.max(this.state.pending, total - ready), issues: this.issues.slice(-20) };
  }
  inside(file) { const relative = path.relative(this.root, path.resolve(file)); return Boolean(relative && !relative.startsWith("..") && !path.isAbsolute(relative)); }
  row(task) { return this.store.db.prepare("SELECT * FROM local_media_identity WHERE task_id=?").get(task.id); }
  issue(task, reason, file = task?.destination) { this.issues.push({ taskId: task?.id || null, fileName: file ? path.basename(file) : "", reason }); }

  async files() {
    const result = []; const pending = [this.root];
    while (pending.length && !this.closed) {
      let entries; const directory = pending.pop();
      try { entries = await readdir(directory, { withFileTypes: true }); }
      catch (error) { if (error.code === "ENOENT") continue; throw error; }
      for (const entry of entries) {
        if (entry.isSymbolicLink()) continue;
        const file = path.join(directory, entry.name);
        if (entry.isDirectory()) pending.push(file);
        else if (entry.isFile() && mediaName(entry.name)) result.push(file);
      }
    }
    return result;
  }

  async hash(file) {
    const before = await stat(file);
    const cached = this.store.db.prepare("SELECT * FROM local_file_fingerprints WHERE path=? COLLATE NOCASE").get(file);
    if (cached && cached.size === before.size && cached.mtime_ms === before.mtimeMs) return { digest: cached.sha256, info: before };
    const hash = createHash("sha256"); let bytes = 0; const started = performance.now();
    this.stream = createReadStream(file, { highWaterMark: 1024 * 1024 });
    try {
      for await (const chunk of this.stream) {
        if (this.closed) throw new Error("文件指纹任务已关闭");
        hash.update(chunk); bytes += chunk.length; this.state.bytesHashed += chunk.length;
        const wait = this.bytesPerSecond > 0 ? bytes * 1000 / this.bytesPerSecond - (performance.now() - started) : 0;
        if (wait > 0) await sleep(Math.min(wait, 1000));
      }
    } finally { this.stream?.destroy(); this.stream = null; }
    const after = await stat(file);
    if (before.size !== after.size || before.mtimeMs !== after.mtimeMs) throw new Error("计算指纹期间文件发生变化，将在下一轮重试");
    const digest = hash.digest("hex");
    this.store.db.prepare(`INSERT INTO local_file_fingerprints(path,sha256,size,mtime_ms) VALUES(?,?,?,?)
      ON CONFLICT(path) DO UPDATE SET sha256=excluded.sha256,size=excluded.size,mtime_ms=excluded.mtime_ms`).run(file, digest, after.size, after.mtimeMs);
    return { digest, info: after };
  }

  remember(task, file, digest, info) {
    this.store.db.prepare(`INSERT INTO local_media_identity(task_id,sha256,size,mtime_ms,path) VALUES(?,?,?,?,?)
      ON CONFLICT(task_id) DO UPDATE SET sha256=excluded.sha256,size=excluded.size,mtime_ms=excluded.mtime_ms,path=excluded.path`)
      .run(task.id, digest, info.size, info.mtimeMs, file);
    task.identityStatus = "ready";
    if (task.fileStatus === "identity_changed") task.fileStatus = "present";
    if (task.destination !== file) {
      task.destination = file; task.fileStatus = "present"; task.actualFileSize = String(info.size);
      task.message = "已通过完整文件指纹重建本地引导，保留原台账与观看记录";
      this.onPathsChanged();
    }
  }

  async candidates(task, files) {
    const known = [];
    if (task.destination && this.inside(task.destination)) known.push(path.resolve(task.destination));
    const parts = String(task.destination || "").split(/[\\/]+/);
    const index = parts.map(value => value.toLowerCase()).lastIndexOf(path.basename(this.root).toLowerCase());
    if (index >= 0) known.push(path.join(this.root, ...parts.slice(index + 1)));
    const base = path.basename(task.destination || "");
    const byName = files.filter(file => path.basename(file).toLowerCase() === base.toLowerCase());
    if (byName.length === 1) known.push(byName[0]);
    for (const file of [...new Set(known)]) {
      if (!this.inside(file)) continue;
      try { if ((await stat(file)).isFile()) return file; } catch (error) { if (error.code !== "ENOENT") throw error; }
    }
    return null;
  }

  scan() {
    if (this.closed) return Promise.resolve(this.status());
    if (this.pending) return this.pending;
    this.state.running = true;
    this.pending = this.run().catch(error => { if (!this.closed) { this.state.failed += 1; this.issue(null, error.message); this.onError(`文件指纹检查失败：${error.message}`); } return this.status(); })
      .finally(() => { this.pending = null; this.state.running = false; });
    return this.pending;
  }

  async run() {
    this.issues = []; Object.assign(this.state, { pending: 0, ambiguous: 0, changed: 0, failed: 0 });
    const files = await this.files(); const claimed = new Set(); const missing = [];
    for (const task of this.store.state.tasks.filter(isLocal)) {
      if (this.closed) break;
      try {
        const old = this.row(task); const file = await this.candidates(task, files);
        if (!file) { missing.push(task); continue; }
        claimed.add(file.toLowerCase());
        const { digest, info } = await this.hash(file);
        if (old && old.sha256 !== digest) {
          task.identityStatus = "changed"; task.fileStatus = "identity_changed";
          this.state.changed += 1; this.issue(task, "文件内容已改变，未自动关联旧观看记录"); continue;
        }
        this.remember(task, file, digest, info);
        await this.store.save();
      } catch (error) { if (!this.closed) { this.state.failed += 1; this.issue(task, error.message); } }
    }
    const unresolvedLegacy = missing.filter(task => !this.row(task));
    for (const file of files) {
      if (this.closed) break;
      if (claimed.has(file.toLowerCase()) || remoteId(path.basename(file))) continue;
      try {
        const { digest, info } = await this.hash(file);
        const rows = this.store.db.prepare("SELECT task_id FROM local_media_identity WHERE sha256=?").all(digest);
        const matches = rows.map(row => this.store.state.tasks.find(task => task.id === row.task_id)).filter(Boolean);
        if (matches.length > 1) { this.state.ambiguous += 1; this.issue(null, "同内容对应多个历史记录，保留原记录等待人工确认", file); }
        else if (matches.length === 1) {
          const task = matches[0];
          if (missing.includes(task)) { this.remember(task, file, digest, info); missing.splice(missing.indexOf(task), 1); claimed.add(file.toLowerCase()); }
          else this.issue(task, "发现相同内容副本，未重复建档或删除文件", file);
        } else if (unresolvedLegacy.length || this.state.failed || this.state.changed) { this.state.pending += 1; this.issue(null, "存在尚未识别的历史文件，暂缓新建档以避免重复", file); }
        else {
          await this.store.importExistingFiles(this.root, { files: [file], fingerprints: new Map([[file, digest]]) });
          const task = this.store.state.tasks.find(item => item.videoId === `local-${digest.slice(0, 24)}`);
          if (task) this.remember(task, file, digest, info);
        }
        await this.store.save();
      } catch (error) { if (!this.closed) { this.state.failed += 1; this.issue(null, error.message, file); } }
    }
    for (const task of missing) { this.state.pending += 1; this.issue(task, this.row(task) ? "未找到与原指纹一致的文件" : "原文件缺失且尚未建立指纹，不能仅按大小猜测关联"); }
    this.state.ready = this.store.state.tasks.filter(task => isLocal(task) && task.identityStatus === "ready").length;
    this.state.lastScanAt = new Date().toISOString(); await this.store.save(); return this.status();
  }

  async locate(task) {
    if (!isLocal(task) || task.identityStatus === "changed") return null;
    const row = this.row(task); if (!row || !this.inside(row.path)) return null;
    try { const info = await stat(row.path); if (info.size === row.size && info.mtimeMs === row.mtime_ms) return { path: row.path, info }; }
    catch (error) { if (error.code !== "ENOENT") throw error; }
    return null;
  }

  async stop() { this.closed = true; this.stream?.destroy(new Error("文件指纹任务已关闭")); await this.pending; }
}
