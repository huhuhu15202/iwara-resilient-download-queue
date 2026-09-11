import { DatabaseSync, backup as sqliteBackup } from "node:sqlite";
import {
  copyFile, mkdir, readdir, readFile, stat, unlink
} from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

const MEDIA_EXTENSIONS = new Set([".mp4", ".webm", ".mkv", ".mov", ".avi", ".m4v"]);
const SORT_COLUMNS = {
  updatedAt: "updated_at",
  uploadTime: "upload_time",
  title: "title",
  author: "author",
  state: "state",
  attempts: "attempts"
};

function extractIwaraId(baseName) {
  const matches = [...baseName.matchAll(/\[([A-Za-z0-9_-]{14}|[A-Za-z0-9_-]{17})\]/g)];
  return matches.length ? matches.at(-1)[1] : "";
}

function inferredTitle(baseName, videoId) {
  return baseName
    .replace(/^Iwara\s*-\s*/i, "")
    .replace(new RegExp(`\\[${videoId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\]`, "g"), "")
    .replace(/\[(Source|540|720|1080|4K)\]/gi, "")
    .replace(/[_\s-]+$/g, "")
    .trim() || videoId;
}

async function walkMediaFiles(root) {
  const found = [];
  async function visit(directory) {
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      if (error.code === "ENOENT") return;
      throw error;
    }
    for (const entry of entries) {
      const fullPath = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(fullPath);
      else if (entry.isFile() && MEDIA_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
        found.push(fullPath);
      }
    }
  }
  await visit(root);
  return found;
}

export class SQLiteStore {
  constructor({ filePath, legacyJsonPath, backupRoot }) {
    this.filePath = filePath;
    this.legacyJsonPath = legacyJsonPath;
    this.backupRoot = backupRoot;
    this.db = null;
    this.loaded = false;
    this.state = { version: 2, tasks: [] };
    this.snapshots = new Map();
  }

  async load() {
    if (this.loaded) return this.state;
    await mkdir(path.dirname(this.filePath), { recursive: true });
    await mkdir(this.backupRoot, { recursive: true });
    this.db = new DatabaseSync(this.filePath);
    this.db.exec(`
      PRAGMA journal_mode=WAL;
      PRAGMA synchronous=FULL;
      PRAGMA foreign_keys=ON;
      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY,
        video_id TEXT NOT NULL UNIQUE,
        state TEXT NOT NULL,
        title TEXT NOT NULL DEFAULT '',
        author TEXT NOT NULL DEFAULT '',
        alias TEXT NOT NULL DEFAULT '',
        upload_time INTEGER,
        attempts INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        data_json TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_tasks_state ON tasks(state);
      CREATE INDEX IF NOT EXISTS idx_tasks_author ON tasks(author);
      CREATE INDEX IF NOT EXISTS idx_tasks_updated ON tasks(updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_tasks_upload ON tasks(upload_time DESC);
      CREATE TABLE IF NOT EXISTS attempt_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id TEXT NOT NULL,
        attempt_no INTEGER NOT NULL,
        phase TEXT NOT NULL,
        outcome TEXT NOT NULL,
        category TEXT NOT NULL DEFAULT '',
        message TEXT NOT NULL DEFAULT '',
        source_host TEXT NOT NULL DEFAULT '',
        completed_length INTEGER,
        created_at TEXT NOT NULL,
        FOREIGN KEY(task_id) REFERENCES tasks(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_attempt_task ON attempt_events(task_id, id);
      CREATE TABLE IF NOT EXISTS meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS author_categories (
        author TEXT PRIMARY KEY COLLATE NOCASE,
        folder TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);

    // Keep frequently queried media/player state in indexed columns while
    // retaining data_json as the forward-compatible task record.
    const columns = new Set(this.db.prepare("PRAGMA table_info(tasks)").all().map(row => row.name));
    const additions = [
      ["media_status", "TEXT NOT NULL DEFAULT 'unknown'"],
      ["media_size", "INTEGER"],
      ["media_checked_at", "TEXT"],
      ["playback_position", "REAL NOT NULL DEFAULT 0"],
      ["playback_duration", "REAL NOT NULL DEFAULT 0"],
      ["watched", "INTEGER NOT NULL DEFAULT 0"],
      ["playback_updated_at", "TEXT"]
    ];
    for (const [name, definition] of additions) {
      if (!columns.has(name)) this.db.exec(`ALTER TABLE tasks ADD COLUMN ${name} ${definition}`);
    }
    this.db.exec("CREATE INDEX IF NOT EXISTS idx_tasks_state_media ON tasks(state, media_status, watched, updated_at DESC)");
    this.backfillIndexedFields();

    const count = Number(this.db.prepare("SELECT COUNT(*) AS count FROM tasks").get().count);
    if (count === 0) await this.migrateLegacyJson();
    this.reloadMemory();
    this.loaded = true;
    return this.state;
  }

  reloadMemory() {
    const rows = this.db.prepare("SELECT data_json FROM tasks ORDER BY created_at").all();
    this.state.tasks = rows.map(row => JSON.parse(row.data_json));
    this.snapshots.clear();
    for (const task of this.state.tasks) this.snapshots.set(task.id, JSON.stringify(task));
  }

  backfillIndexedFields() {
    const update = this.db.prepare(`
      UPDATE tasks SET media_status=?, media_size=?, media_checked_at=?,
        playback_position=?, playback_duration=?, watched=?, playback_updated_at=?
      WHERE id=?
    `);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const rows = this.db.prepare(`
        SELECT id, data_json FROM tasks
        WHERE media_status='unknown' OR media_checked_at IS NULL
      `).all();
      for (const row of rows) {
        const task = JSON.parse(row.data_json);
        update.run(
          task.fileStatus || "unknown",
          Number(task.actualFileSize || 0) || null,
          task.mediaCheckedAt || null,
          Number(task.playbackPosition || 0) || 0,
          Number(task.playbackDuration || 0) || 0,
          task.watched ? 1 : 0,
          task.playbackUpdatedAt || null,
          row.id
        );
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  async migrateLegacyJson() {
    let parsed;
    try {
      parsed = JSON.parse(await readFile(this.legacyJsonPath, "utf8"));
    } catch (error) {
      if (error.code === "ENOENT") return;
      throw error;
    }
    if (!Array.isArray(parsed?.tasks) || parsed.tasks.length === 0) return;
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    await copyFile(this.legacyJsonPath, path.join(this.backupRoot, `state-json-migrated-${stamp}.json`));
    this.db.exec("BEGIN IMMEDIATE");
    try {
      for (const task of parsed.tasks) this.upsertTask(task);
      this.setMeta("legacy_json_migrated_at", new Date().toISOString());
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  upsertTask(task) {
    const data = JSON.stringify(task);
    this.db.prepare(`
      INSERT INTO tasks (
        id, video_id, state, title, author, alias, upload_time,
        attempts, created_at, updated_at, data_json,
        media_status, media_size, media_checked_at,
        playback_position, playback_duration, watched, playback_updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        video_id=excluded.video_id, state=excluded.state, title=excluded.title,
        author=excluded.author, alias=excluded.alias, upload_time=excluded.upload_time,
        attempts=excluded.attempts, created_at=excluded.created_at,
        updated_at=excluded.updated_at, data_json=excluded.data_json,
        media_status=excluded.media_status, media_size=excluded.media_size,
        media_checked_at=excluded.media_checked_at,
        playback_position=excluded.playback_position,
        playback_duration=excluded.playback_duration,
        watched=excluded.watched,
        playback_updated_at=excluded.playback_updated_at
    `).run(
      task.id,
      task.videoId,
      task.state,
      task.title || "",
      task.author || "",
      task.alias || "",
      task.uploadTime || null,
      Number(task.attempts || 0),
      task.createdAt || new Date().toISOString(),
      task.updatedAt || new Date().toISOString(),
      data,
      task.fileStatus || "unknown",
      Number(task.actualFileSize || 0) || null,
      task.mediaCheckedAt || null,
      Number(task.playbackPosition || 0) || 0,
      Number(task.playbackDuration || 0) || 0,
      task.watched ? 1 : 0,
      task.playbackUpdatedAt || null
    );
    return data;
  }

  async save() {
    const changed = [];
    for (const task of this.state.tasks) {
      const serialized = JSON.stringify(task);
      if (this.snapshots.get(task.id) !== serialized) changed.push({ task, serialized });
    }
    if (!changed.length) return;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      for (const { task } of changed) {
        const serialized = this.upsertTask(task);
        this.snapshots.set(task.id, serialized);
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  recordAttempt(task, {
    phase, outcome, category = "", message = "", sourceHost = "", completedLength = null
  }) {
    this.db.prepare(`
      INSERT INTO attempt_events (
        task_id, attempt_no, phase, outcome, category, message,
        source_host, completed_length, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      task.id,
      Number(task.attempts || 0),
      phase,
      outcome,
      category,
      String(message).slice(0, 1000),
      sourceHost,
      completedLength === null ? null : Number(completedLength),
      new Date().toISOString()
    );
  }

  failedSourceHosts(taskId) {
    return this.db.prepare(`
      SELECT DISTINCT source_host FROM attempt_events
      WHERE task_id=? AND outcome='failure' AND source_host<>''
    `).all(taskId).map(row => row.source_host);
  }

  attemptHistory(taskId, limit = 50) {
    return this.db.prepare(`
      SELECT attempt_no AS attemptNo, phase, outcome, category, message,
             source_host AS sourceHost, completed_length AS completedLength,
             created_at AS createdAt
      FROM attempt_events WHERE task_id=? ORDER BY id DESC LIMIT ?
    `).all(taskId, limit);
  }

  queryTasks({
    query = "", state = "all", author = "all", sort = "updatedAt",
    direction = "desc", page = 1, pageSize = 50, watched = "all"
  } = {}) {
    const where = [];
    const params = [];
    if (query) {
      where.push("(title LIKE ? ESCAPE '\\' OR author LIKE ? ESCAPE '\\' OR alias LIKE ? ESCAPE '\\' OR video_id LIKE ? ESCAPE '\\')");
      const escaped = `%${query.replace(/[\\%_]/g, "\\$&")}%`;
      params.push(escaped, escaped, escaped, escaped);
    }
    if (state !== "all") {
      where.push("state=?");
      params.push(state);
    }
    if (author !== "all") {
      where.push("author=?");
      params.push(author);
    }
    if (watched === "watched" || watched === "unwatched") {
      where.push("watched=?");
      params.push(watched === "watched" ? 1 : 0);
    }
    const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";
    const total = Number(this.db.prepare(`SELECT COUNT(*) AS count FROM tasks ${clause}`).get(...params).count);
    const column = SORT_COLUMNS[sort] || SORT_COLUMNS.updatedAt;
    const order = direction === "asc" ? "ASC" : "DESC";
    const safePageSize = Math.min(200, Math.max(10, Number(pageSize) || 50));
    const safePage = Math.max(1, Number(page) || 1);
    const rows = this.db.prepare(`
      SELECT data_json FROM tasks ${clause}
      ORDER BY ${column} ${order}, id ASC LIMIT ? OFFSET ?
    `).all(...params, safePageSize, (safePage - 1) * safePageSize);
    return {
      total,
      page: safePage,
      pageSize: safePageSize,
      tasks: rows.map(row => JSON.parse(row.data_json))
    };
  }

  queryPlaylist({
    query = "", author = "all", watched = "all", sort = "updatedAt",
    direction = "desc", page = 1, pageSize = 30, randomPage = false,
    contextId = "", contextSize = 5
  } = {}) {
    const where = ["state='completed'", "media_status='present'", "COALESCE(json_extract(data_json, '$.destination'), '')<>''"];
    const params = [];
    if (query) {
      where.push("(title LIKE ? ESCAPE '\\' OR author LIKE ? ESCAPE '\\' OR alias LIKE ? ESCAPE '\\' OR video_id LIKE ? ESCAPE '\\')");
      const escaped = `%${String(query).replace(/[\\%_]/g, "\\$&")}%`;
      params.push(escaped, escaped, escaped, escaped);
    }
    if (author !== "all") { where.push("author=?"); params.push(author); }
    if (watched === "watched" || watched === "unwatched") {
      where.push("watched=?"); params.push(watched === "watched" ? 1 : 0);
    }
    const clause = `WHERE ${where.join(" AND ")}`;
    const total = Number(this.db.prepare(`SELECT COUNT(*) AS count FROM tasks ${clause}`).get(...params).count);
    const orderColumns = {
      title: "LOWER(title)",
      author: "LOWER(CASE WHEN alias<>'' THEN alias ELSE author END)",
      uploadTime: "COALESCE(upload_time, 0)",
      views: "COALESCE(CAST(json_extract(data_json, '$.viewCount') AS INTEGER), CAST(json_extract(data_json, '$.views') AS INTEGER), -1)",
      updatedAt: "updated_at"
    };
    const orderColumn = orderColumns[sort] || orderColumns.updatedAt;
    const order = direction === "asc" ? "ASC" : "DESC";
    const tieOrder = "ASC";
    const safePageSize = Math.min(60, Math.max(6, Number(pageSize) || 30));
    let safePage = Math.max(1, Number(page) || 1);
    let currentIndex = null;
    let offset = (safePage - 1) * safePageSize;
    if (contextId) {
      const center = this.db.prepare(`SELECT ${orderColumn} AS order_value, id FROM tasks ${clause} AND id=?`).get(...params, contextId);
      if (center) {
        const comparator = order === "ASC"
          ? `(${orderColumn} < ? OR (${orderColumn} = ? AND id < ?))`
          : `(${orderColumn} > ? OR (${orderColumn} = ? AND id < ?))`;
        const before = Number(this.db.prepare(`SELECT COUNT(*) AS count FROM tasks ${clause} AND ${comparator}`).get(...params, center.order_value, center.order_value, center.id).count);
        const size = Math.min(9, Math.max(2, Number(contextSize) || 5));
        offset = Math.max(0, Math.min(before - Math.floor(size / 2), Math.max(0, total - size)));
        currentIndex = before - offset;
        safePage = 1;
        const rows = this.db.prepare(`SELECT data_json FROM tasks ${clause} ORDER BY ${orderColumn} ${order}, id ${tieOrder} LIMIT ? OFFSET ?`).all(...params, size, offset);
        return { total, page: safePage, pageSize: size, currentIndex, tasks: rows.map(row => JSON.parse(row.data_json)) };
      }
      return { total, page: 1, pageSize: Math.min(9, Math.max(2, Number(contextSize) || 5)), currentIndex: null, tasks: [] };
    }
    const pageCount = Math.max(1, Math.ceil(total / safePageSize));
    safePage = randomPage ? 1 + Math.floor(Math.random() * pageCount) : Math.min(pageCount, safePage);
    offset = (safePage - 1) * safePageSize;
    const rows = this.db.prepare(`SELECT data_json FROM tasks ${clause} ORDER BY ${orderColumn} ${order}, id ${tieOrder} LIMIT ? OFFSET ?`).all(...params, safePageSize, offset);
    return { total, page: safePage, pageSize: safePageSize, currentIndex, tasks: rows.map(row => JSON.parse(row.data_json)) };
  }

  counts() {
    const counts = { queued: 0, resolving: 0, downloading: 0, finalizing: 0, completed: 0, failed: 0 };
    for (const row of this.db.prepare("SELECT state, COUNT(*) AS count FROM tasks GROUP BY state").all()) {
      counts[row.state] = Number(row.count);
    }
    return counts;
  }

  authors() {
    return this.db.prepare(`
      SELECT author, MAX(alias) AS alias, COUNT(*) AS count
      FROM tasks WHERE author<>'' GROUP BY author ORDER BY author COLLATE NOCASE
    `).all();
  }

  authorCategory(author) {
    if (!author) return "";
    return this.db.prepare(
      "SELECT folder FROM author_categories WHERE author=? COLLATE NOCASE"
    ).get(author)?.folder || "";
  }

  authorCategoryRules() {
    return this.db.prepare(`
      SELECT author, folder, updated_at AS updatedAt
      FROM author_categories ORDER BY folder COLLATE NOCASE, author COLLATE NOCASE
    `).all();
  }

  upsertAuthorCategoryRules(rules) {
    const statement = this.db.prepare(`
      INSERT INTO author_categories(author,folder,updated_at) VALUES(?,?,?)
      ON CONFLICT(author) DO UPDATE SET
        folder=excluded.folder, updated_at=excluded.updated_at
    `);
    const updatedAt = new Date().toISOString();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      for (const rule of rules) statement.run(rule.author, rule.folder, updatedAt);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return this.authorCategoryRules();
  }

  setMeta(key, value) {
    this.db.prepare(`
      INSERT INTO meta(key,value) VALUES(?,?)
      ON CONFLICT(key) DO UPDATE SET value=excluded.value
    `).run(key, String(value));
  }

  getMeta(key) {
    return this.db.prepare("SELECT value FROM meta WHERE key=?").get(key)?.value;
  }

  async importExistingFiles(downloadRoot) {
    const files = await walkMediaFiles(downloadRoot);
    const existingIds = new Set(this.state.tasks.map(task => task.videoId));
    let imported = 0;
    const unmatched = [];
    for (const filePath of files) {
      const parsed = path.parse(filePath);
      const videoId = extractIwaraId(parsed.name);
      if (!videoId) {
        unmatched.push(filePath);
        continue;
      }
      if (existingIds.has(videoId)) continue;
      const info = await stat(filePath);
      const timestamp = info.mtime.toISOString();
      const task = {
        id: randomUUID(),
        videoId,
        sourcePage: `https://www.iwara.tv/video/${videoId}`,
        title: inferredTitle(parsed.name, videoId),
        author: "",
        alias: "",
        uploadTime: null,
        state: "completed",
        attempts: 0,
        resolveFailures: 0,
        createdAt: timestamp,
        updatedAt: timestamp,
        completedAt: timestamp,
        completedLength: String(info.size),
        totalLength: String(info.size),
        destination: filePath,
        fileStatus: "present",
        imported: true,
        metadataStatus: "pending",
        metadataAttempts: 0,
        metadataNextRunAt: 0,
        metadataMessage: "等待补齐作者和上传日期",
        message: "从已有文件导入",
        gid: null
      };
      this.state.tasks.push(task);
      existingIds.add(videoId);
      imported += 1;
    }
    await this.save();
    const result = { scanned: files.length, imported, unmatched: unmatched.length, unmatchedFiles: unmatched };
    this.setMeta("last_file_import", JSON.stringify({ ...result, unmatchedFiles: undefined, at: new Date().toISOString() }));
    return result;
  }

  async createDailyBackup() {
    const date = new Date().toISOString().slice(0, 10);
    const target = path.join(this.backupRoot, `ledger-${date}.sqlite`);
    try {
      await stat(target);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      await sqliteBackup(this.db, target);
    }
    const backups = (await readdir(this.backupRoot))
      .filter(name => /^ledger-\d{4}-\d{2}-\d{2}\.sqlite$/.test(name))
      .sort()
      .reverse();
    for (const oldName of backups.slice(7)) {
      await unlink(path.join(this.backupRoot, oldName));
    }
  }

  close() {
    this.db?.close();
  }
}
