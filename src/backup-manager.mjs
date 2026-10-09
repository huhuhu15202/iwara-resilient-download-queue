import { DatabaseSync, backup } from "node:sqlite";
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

export function beijingDate(time = Date.now()) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" }).format(time);
}

export async function validateBackup(directory) {
  const config = JSON.parse(await readFile(path.join(directory, "config.json"), "utf8"));
  if (!config || typeof config !== "object" || Array.isArray(config)) throw new Error("备份配置无效");
  const db = new DatabaseSync(path.join(directory, "ledger.sqlite"), { readOnly: true });
  try {
    const check = db.prepare("PRAGMA integrity_check").all();
    if (check.length !== 1 || Object.values(check[0])[0] !== "ok") throw new Error("SQLite 备份完整性检查失败");
    if (db.prepare("PRAGMA foreign_key_check").all().length) throw new Error("SQLite 备份关联检查失败");
    return { tasks: Number(db.prepare("SELECT COUNT(*) AS count FROM tasks").get().count), config };
  } finally { db.close(); }
}

export class BackupManager {
  constructor({ db, root, config = {}, clock = Date, intervalMs = 3_600_000, onError = console.error, backupFunction = backup }) {
    this.db = db; this.root = path.resolve(root); this.config = config; this.clock = clock;
    this.intervalMs = intervalMs; this.onError = onError; this.backupFunction = backupFunction;
    this.timer = null; this.pending = null;
    this.state = { running: false, date: null, lastAttemptAt: null, lastSuccessAt: null, error: null };
  }

  status() { return { ...this.state, root: this.root }; }

  start() {
    if (this.timer) return;
    void this.check();
    this.timer = setInterval(() => void this.check(), this.intervalMs);
    this.timer.unref?.();
  }

  async check() {
    try { return await this.runOnce(); }
    catch (error) { this.onError(`每日备份失败，稍后重试：${error.message}`); return null; }
  }

  runOnce(label = beijingDate(this.clock.now())) {
    if (this.pending) return this.pending;
    if (!/^(?:\d{4}-\d{2}-\d{2}|before-backend-upgrade-[\w-]+)$/.test(label)) return Promise.reject(new Error("备份目录名无效"));
    this.state.running = true; this.state.lastAttemptAt = new Date(this.clock.now()).toISOString();
    this.pending = this.create(label).then(result => {
      Object.assign(this.state, { date: label, lastSuccessAt: new Date(this.clock.now()).toISOString(), error: null });
      return result;
    }).catch(error => { this.state.error = error.message; throw error; })
      .finally(() => { this.pending = null; this.state.running = false; });
    return this.pending;
  }

  async create(label) {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    const target = path.join(this.root, label);
    let existing = false;
    try { await stat(target); existing = true; }
    catch (error) { if (error.code !== "ENOENT") throw error; }
    if (existing) {
      try {
      // A finalized directory is reusable only if both files validate.
      const result = await validateBackup(target);
      return { directory: target, tasks: result.tasks, reused: true };
      } catch {
        // Preserve a corrupt snapshot for diagnosis instead of overwriting it.
        await rename(target, `${target}.invalid-${randomUUID()}`);
      }
    }
    const temporary = path.join(this.root, `.pending-${label}-${randomUUID()}`);
    await mkdir(temporary, { mode: 0o700 });
    try {
      await this.backupFunction(this.db, path.join(temporary, "ledger.sqlite"));
      await writeFile(path.join(temporary, "config.json"), JSON.stringify(this.config, null, 2), { mode: 0o600 });
      const result = await validateBackup(temporary);
      await rename(temporary, target);
      await this.prune();
      return { directory: target, tasks: result.tasks, reused: false };
    } finally { await rm(temporary, { recursive: true, force: true }); }
  }

  async prune() {
    const dates = (await readdir(this.root, { withFileTypes: true }))
      .filter(entry => entry.isDirectory() && /^\d{4}-\d{2}-\d{2}$/.test(entry.name))
      .map(entry => entry.name).sort().reverse();
    for (const name of dates.slice(7)) {
      const target = path.resolve(this.root, name);
      if (path.dirname(target) !== this.root) throw new Error("备份清理路径越界");
      await rm(target, { recursive: true, force: true });
    }
    // Legacy ledger-YYYY-MM-DD.sqlite and upgrade snapshots are kept intact.
  }

  async stop() {
    clearInterval(this.timer); this.timer = null;
    await this.pending?.catch(() => {});
  }
}
