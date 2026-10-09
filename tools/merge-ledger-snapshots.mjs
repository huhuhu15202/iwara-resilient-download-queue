import { readdir, stat } from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

const argv = process.argv.slice(2);

function option(name, fallback = "") {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] || fallback : fallback;
}

function options(name) {
  const values = [];
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === name && argv[index + 1]) values.push(argv[index + 1]);
  }
  return values;
}

const targetPath = path.resolve(option("--target"));
const sourcePath = path.resolve(option("--source"));
const historyRoots = options("--history-root").map(value => path.resolve(value));
const apply = argv.includes("--apply");

if (!option("--target") || !option("--source") || historyRoots.length === 0) {
  throw new Error("Usage: node tools/merge-ledger-snapshots.mjs --target <G ledger.sqlite> --source <F snapshot.sqlite> --history-root <backup dir> [--history-root <backup dir>] [--apply]");
}

const TASK_COLUMNS = [
  "id", "video_id", "state", "title", "author", "alias", "upload_time", "attempts",
  "created_at", "updated_at", "data_json", "media_status", "media_size", "media_checked_at",
  "playback_position", "playback_duration", "watched", "playback_updated_at", "favorite",
  "watch_later", "discarded", "queue_position"
];

const FIELD_SPECS = [
  { key: "author", jsonKey: "author", column: "author", placeholder: value => value === "本地导入" },
  { key: "alias", jsonKey: "alias", column: "alias" },
  { key: "upload_date", jsonKey: "uploadTime", column: "upload_time" },
  { key: "views", jsonKey: "viewCount" },
  { key: "tags", jsonKey: "tags" },
  { key: "title", jsonKey: "title", column: "title", placeholder: (value, task) =>
    value === task.video_id || (String(task.video_id).startsWith("local-") && value === sourcePageId(task.data)) }
];

function sourcePageId(data) {
  return String(data?.sourcePage || "").replace(/\/+$/, "").split("/").at(-1) || "";
}

function clean(value) {
  return typeof value === "string" ? value.trim() : value;
}

function normalizeTagList(value) {
  if (!Array.isArray(value)) return value;
  return value.map(item => typeof item === "string" ? item.trim() : item).filter(item => item !== "");
}

function fieldValue(row, spec) {
  const data = row.data;
  if (spec.key === "views") {
    const value = data.viewCount ?? data.views;
    if (value === null || value === undefined || value === "") return null;
    const number = Number(String(value).replaceAll(",", ""));
    return Number.isSafeInteger(number) && number >= 0 ? number : value;
  }
  if (spec.key === "tags") {
    const value = normalizeTagList(data.tags);
    return Array.isArray(value) && value.length ? value : null;
  }
  const value = spec.jsonKey === "title"
    ? ((spec.placeholder?.(clean(data.title), row) && !spec.placeholder?.(clean(row.title), row)) ? row.title : (data.title || row.title)) :
    spec.jsonKey === "author" ? (data.author || row.author) :
      spec.jsonKey === "alias" ? (data.alias || row.alias) :
        spec.jsonKey === "uploadTime" ? (data.uploadTime ?? row.upload_time) : data[spec.jsonKey];
  return value === null || value === undefined || value === "" ? null : clean(value);
}

function isMissing(row, spec) {
  const value = fieldValue(row, spec);
  if (value === null || value === undefined || value === "") return true;
  return Boolean(spec.placeholder?.(clean(value), row));
}

function valueKey(value, spec) {
  if (spec.key === "tags" && Array.isArray(value)) {
    const normalized = value.map(item => typeof item === "string" ? item.trim().toLocaleLowerCase() : item)
      .filter(item => item !== "");
    return JSON.stringify([...normalized].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))));
  }
  if (spec.key === "views") return String(Number(value));
  if (value && typeof value === "object") return JSON.stringify(value, Object.keys(value).sort());
  return String(clean(value));
}

function taskFromDbRow(row) {
  let data;
  try { data = JSON.parse(row.data_json); }
  catch (error) { throw new Error(`Invalid data_json for ${row.video_id}: ${error.message}`); }
  if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error(`Invalid task JSON for ${row.video_id}`);
  return { ...row, data };
}

function tableExists(db, name) {
  return Boolean(db.prepare("SELECT 1 AS found FROM sqlite_master WHERE type='table' AND name=?").get(name));
}

function readTasks(db) {
  const byVideo = new Map();
  const byId = new Map();
  for (const raw of db.prepare("SELECT * FROM tasks").all()) {
    const row = taskFromDbRow(raw);
    if (byVideo.has(row.video_id)) throw new Error(`Duplicate video_id in ledger: ${row.video_id}`);
    byVideo.set(row.video_id, row);
    byId.set(row.id, row);
  }
  return { byVideo, byId };
}

function readIdentities(db) {
  const taskHashes = new Map();
  const hashTasks = new Map();
  const rowsByTaskAndTable = new Map();
  for (const table of ["local_media_identity", "mobile_media_identity"]) {
    if (!tableExists(db, table)) continue;
    for (const row of db.prepare(`SELECT * FROM ${table}`).all()) {
      if (!/^[a-f0-9]{64}$/i.test(String(row.sha256 || ""))) continue;
      const digest = row.sha256.toLowerCase();
      if (!taskHashes.has(row.task_id)) taskHashes.set(row.task_id, new Set());
      taskHashes.get(row.task_id).add(digest);
      if (!hashTasks.has(digest)) hashTasks.set(digest, new Set());
      hashTasks.get(digest).add(row.task_id);
      if (!rowsByTaskAndTable.has(row.task_id)) rowsByTaskAndTable.set(row.task_id, new Map());
      rowsByTaskAndTable.get(row.task_id).set(table, row);
    }
  }
  return { taskHashes, hashTasks, rowsByTaskAndTable };
}

async function findSqliteFiles(root) {
  const result = [];
  async function visit(directory) {
    let entries;
    try { entries = await readdir(directory, { withFileTypes: true }); }
    catch (error) {
      if (error.code === "ENOENT") return;
      throw error;
    }
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const fullPath = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(fullPath);
      else if (entry.isFile() && entry.name.toLowerCase().endsWith(".sqlite")) result.push(fullPath);
    }
  }
  await visit(root);
  return result;
}

function rowFromHistory(raw) {
  return taskFromDbRow(raw);
}

function metadataValueMap(rows) {
  const values = new Map(FIELD_SPECS.map(spec => [spec.key, new Map()]));
  for (const row of rows) {
    for (const spec of FIELD_SPECS) {
      const value = fieldValue(row, spec);
      if (value === null || value === undefined || value === "" || spec.placeholder?.(clean(value), row)) continue;
      const key = valueKey(value, spec);
      values.get(spec.key).set(key, value);
    }
  }
  return values;
}

async function collectHistoryValues() {
  const files = [...new Set((await Promise.all(historyRoots.map(findSqliteFiles))).flat())];
  const byVideo = new Map();
  let readable = 0;
  let unreadable = 0;
  for (const file of files) {
    let db;
    try {
      db = new DatabaseSync(file, { readOnly: true });
      if (!tableExists(db, "tasks")) continue;
      const check = db.prepare("PRAGMA quick_check").get();
      if (Object.values(check || {})[0] !== "ok") { unreadable += 1; continue; }
      readable += 1;
      for (const raw of db.prepare("SELECT * FROM tasks").all()) {
        const row = rowFromHistory(raw);
        if (!byVideo.has(row.video_id)) byVideo.set(row.video_id, []);
        byVideo.get(row.video_id).push(row);
      }
    } catch {
      unreadable += 1;
    } finally {
      db?.close();
    }
  }
  const candidates = new Map();
  for (const [videoId, rows] of byVideo) candidates.set(videoId, metadataValueMap(rows));
  return { filesSeen: files.length, readable, unreadable, candidates };
}

function sourceRowsByFingerprint(targetRow, targetIdentity, sourceTasks, sourceIdentity) {
  const hashes = targetIdentity.taskHashes.get(targetRow.id) || new Set();
  const sourceIds = new Set();
  for (const hash of hashes) {
    for (const taskId of sourceIdentity.hashTasks.get(hash) || []) sourceIds.add(taskId);
  }
  return [...sourceIds].map(taskId => sourceTasks.byId.get(taskId)).filter(Boolean);
}

async function fileIsConsistent(row) {
  const destination = row.data.destination;
  if (!destination) return false;
  try {
    const info = await stat(destination);
    const expected = Number(row.data.actualFileSize || row.media_size || 0);
    return info.isFile() && (!expected || info.size === expected);
  } catch {
    return false;
  }
}

function makePlan(targetDb, sourceDb, history) {
  const targetTasks = readTasks(targetDb);
  const sourceTasks = readTasks(sourceDb);
  const targetIdentity = readIdentities(targetDb);
  const sourceIdentity = readIdentities(sourceDb);
  const metadataUpdates = [];
  const fillCounts = Object.fromEntries(FIELD_SPECS.map(spec => [spec.key, { exact_history: 0, fingerprint: 0 }]));
  const conflicts = Object.fromEntries(FIELD_SPECS.map(spec => [spec.key, { exact_history: 0, fingerprint: 0 }]));

  for (const row of targetTasks.byVideo.values()) {
    const patched = { ...row.data };
    const changeSources = {};
    const fingerprintRows = sourceRowsByFingerprint(row, targetIdentity, sourceTasks, sourceIdentity);
    const fingerprintValues = metadataValueMap(fingerprintRows);
    const exactValues = history.candidates.get(row.video_id);
    for (const spec of FIELD_SPECS) {
      if (!isMissing(row, spec)) continue;
      const historical = exactValues?.get(spec.key);
      const hashed = fingerprintValues.get(spec.key);
      let value = null;
      let source = "";
      if (historical?.size === 1) {
        [value] = historical.values();
        source = "exact_history";
      } else if (historical?.size > 1) {
        conflicts[spec.key].exact_history += 1;
        continue;
      } else if (hashed?.size === 1) {
        [value] = hashed.values();
        source = "fingerprint";
      } else if (hashed?.size > 1) {
        conflicts[spec.key].fingerprint += 1;
        continue;
      }
      if (value === null || value === undefined || value === "") continue;
      if (spec.key === "views") {
        patched.viewCount = value;
        patched.views = value;
      } else if (spec.key === "tags") {
        patched.tags = normalizeTagList(value);
      } else {
        patched[spec.jsonKey] = value;
      }
      changeSources[spec.key] = source;
      fillCounts[spec.key][source] += 1;
    }
    if (Object.keys(changeSources).length) metadataUpdates.push({ row, patched, changeSources });
  }

  const targetHashes = new Set(targetIdentity.hashTasks.keys());
  const allSourceHashToTasks = sourceIdentity.hashTasks;
  const orderedSourceRows = [...sourceTasks.byVideo.values()].sort((a, b) => {
    const priority = row => row.video_id.startsWith("local-") ? 2 : row.video_id.startsWith("han1meview-") ? 1 : 0;
    return priority(a) - priority(b) || String(a.video_id).localeCompare(String(b.video_id));
  });
  const addRows = [];
  const skippedExistingContent = [];
  const skippedUnfingerprinted = [];
  const skippedConflictingFingerprints = [];
  const skippedTaskIdConflicts = [];
  const reservedHashes = new Set(targetHashes);
  const reservedVideoIds = new Set(targetTasks.byVideo.keys());
  const reservedTaskIds = new Set(targetTasks.byId.keys());
  // A source row with the same video ID already in G can still have a
  // different task ID. Reserve its known content hash to avoid adding an
  // alias row when the corresponding G identity record is missing.
  for (const sourceRow of sourceTasks.byVideo.values()) {
    if (!targetTasks.byVideo.has(sourceRow.video_id)) continue;
    for (const hash of sourceIdentity.taskHashes.get(sourceRow.id) || []) reservedHashes.add(hash);
  }
  for (const row of orderedSourceRows) {
    if (reservedVideoIds.has(row.video_id)) continue;
    const hashes = sourceIdentity.taskHashes.get(row.id) || new Set();
    if (hashes.size !== 1) {
      if (hashes.size === 0) skippedUnfingerprinted.push(row.video_id);
      else skippedConflictingFingerprints.push(row.video_id);
      continue;
    }
    const [hash] = hashes;
    if (reservedHashes.has(hash)) {
      skippedExistingContent.push(row.video_id);
      continue;
    }
    if (reservedTaskIds.has(row.id)) {
      skippedTaskIdConflicts.push(row.video_id);
      continue;
    }
    addRows.push(row);
    reservedVideoIds.add(row.video_id);
    reservedTaskIds.add(row.id);
    reservedHashes.add(hash);
  }

  const targetMissingIdentity = [];
  for (const row of targetTasks.byVideo.values()) {
    if (targetIdentity.rowsByTaskAndTable.get(row.id)?.has("mobile_media_identity")) continue;
    const candidates = sourceRowsByFingerprint(row, targetIdentity, sourceTasks, sourceIdentity);
    if (candidates.length) targetMissingIdentity.push({ target: row, source: candidates });
  }

  return {
    targetTasks, sourceTasks, targetIdentity, sourceIdentity, metadataUpdates, fillCounts, conflicts,
    addRows, skippedExistingContent, skippedUnfingerprinted, skippedConflictingFingerprints,
    skippedTaskIdConflicts, targetMissingIdentity
  };
}

function serializeTask(data) {
  return JSON.stringify(data);
}

function updateMetadata(targetDb, update) {
  const data = update.patched;
  const columns = [];
  const values = [];
  if (update.changeSources.title) { columns.push("title=?"); values.push(data.title || ""); }
  if (update.changeSources.author) { columns.push("author=?"); values.push(data.author || ""); }
  if (update.changeSources.alias) { columns.push("alias=?"); values.push(data.alias || ""); }
  if (update.changeSources.upload_date) { columns.push("upload_time=?"); values.push(data.uploadTime ?? null); }
  columns.push("data_json=?");
  values.push(serializeTask(data), update.row.id);
  targetDb.prepare(`UPDATE tasks SET ${columns.join(", ")} WHERE id=?`).run(...values);
}

function insertTask(targetDb, row) {
  const data = { ...row.data };
  data.favorite = Boolean(row.favorite);
  data.watchLater = Boolean(row.watch_later);
  data.discarded = Boolean(row.discarded);
  data.queuePosition = row.queue_position === null || row.queue_position === undefined ? null : Number(row.queue_position);
  const columns = [...TASK_COLUMNS];
  const values = columns.map(column => column === "data_json" ? serializeTask(data) : row[column]);
  targetDb.prepare(`INSERT INTO tasks (${columns.join(",")}) VALUES (${columns.map(() => "?").join(",")})`).run(...values);
}

function copyIdentityRows(targetDb, sourceIdentity, insertedRows, plan) {
  const count = { mobile: 0, local: 0, localFileFingerprints: 0, conflictingFileFingerprints: 0 };
  for (const row of insertedRows) {
    const identities = sourceIdentity.rowsByTaskAndTable.get(row.id);
    if (!identities) continue;
    for (const [table, record] of identities) {
      const columns = table === "mobile_media_identity"
        ? ["task_id", "path", "size", "mtime_ms", "sha256", "sample_sha256"]
        : ["task_id", "sha256", "size", "mtime_ms", "path"];
      targetDb.prepare(`INSERT OR IGNORE INTO ${table} (${columns.join(",")}) VALUES (${columns.map(() => "?").join(",")})`)
        .run(...columns.map(column => record[column]));
      count[table === "mobile_media_identity" ? "mobile" : "local"] += Number(targetDb.prepare(`SELECT changes() AS n`).get().n || 0);
      const fingerprint = targetDb.prepare("SELECT * FROM local_file_fingerprints WHERE path=? COLLATE NOCASE").get(record.path);
      if (table === "local_media_identity" && !fingerprint) {
        targetDb.prepare("INSERT OR IGNORE INTO local_file_fingerprints(path,sha256,size,mtime_ms) VALUES(?,?,?,?)")
          .run(record.path, record.sha256, record.size, record.mtime_ms);
        count.localFileFingerprints += Number(targetDb.prepare("SELECT changes() AS n").get().n || 0);
      } else if (table === "local_media_identity" && fingerprint &&
        (fingerprint.sha256 !== record.sha256 || Number(fingerprint.size) !== Number(record.size))) {
        count.conflictingFileFingerprints += 1;
      }
    }
  }

  for (const { target, source } of plan.targetMissingIdentity) {
    const choices = source.flatMap(row => {
      const rows = sourceIdentity.rowsByTaskAndTable.get(row.id);
      return rows?.has("mobile_media_identity") ? [rows.get("mobile_media_identity")] : [];
    });
    const hashes = new Set(choices.map(row => row.sha256));
    if (hashes.size !== 1 || !choices.length) continue;
    const choice = choices[0];
    targetDb.prepare("INSERT OR IGNORE INTO mobile_media_identity(task_id,path,size,mtime_ms,sha256,sample_sha256) VALUES(?,?,?,?,?,?)")
      .run(target.id, choice.path, choice.size, choice.mtime_ms, choice.sha256, choice.sample_sha256);
    count.mobile += Number(targetDb.prepare("SELECT changes() AS n").get().n || 0);
  }
  return count;
}

function copyAttemptEvents(targetDb, sourceDb, taskIds) {
  if (!taskIds.length || !tableExists(targetDb, "attempt_events") || !tableExists(sourceDb, "attempt_events")) return 0;
  const select = sourceDb.prepare("SELECT task_id,attempt_no,phase,outcome,category,message,source_host,completed_length,created_at FROM attempt_events WHERE task_id=?");
  const insert = targetDb.prepare("INSERT INTO attempt_events(task_id,attempt_no,phase,outcome,category,message,source_host,completed_length,created_at) VALUES(?,?,?,?,?,?,?,?,?)");
  let copied = 0;
  for (const taskId of taskIds) {
    for (const event of select.all(taskId)) {
      insert.run(event.task_id, event.attempt_no, event.phase, event.outcome, event.category,
        event.message, event.source_host, event.completed_length, event.created_at);
      copied += 1;
    }
  }
  return copied;
}

function printPlan(plan, history, fileChecks = null) {
  const before = plan.targetTasks.byVideo.size;
  const addBySource = Object.fromEntries(["Iwara", "Han1me", "local/other"].map(name => [name, 0]));
  for (const row of plan.addRows) {
    const name = row.video_id.startsWith("han1meview-") ? "Han1me" : row.video_id.startsWith("local-") ? "local/other" : "Iwara";
    addBySource[name] += 1;
  }
  return {
    mode: apply ? "apply" : "dry-run",
    target_tasks_before: before,
    source_tasks: plan.sourceTasks.byVideo.size,
    add_unique_content: plan.addRows.length,
    add_by_source: addBySource,
    skip_same_content: plan.skippedExistingContent.length,
    skip_without_fingerprint: plan.skippedUnfingerprinted.length,
    skip_conflicting_fingerprint: plan.skippedConflictingFingerprints.length,
    skip_task_id_collision: plan.skippedTaskIdConflicts.length,
    fillable_metadata: plan.fillCounts,
    unresolved_metadata_conflicts: plan.conflicts,
    history_snapshots: { seen: history.filesSeen, readable: history.readable, unreadable: history.unreadable },
    missing_mobile_identity_candidates: plan.targetMissingIdentity.length,
    source_media_preflight: fileChecks
  };
}

const targetDb = new DatabaseSync(targetPath, { readOnly: !apply });
const sourceDb = new DatabaseSync(sourcePath, { readOnly: true });
let transactionOpen = false;
try {
  for (const column of TASK_COLUMNS) {
    const columns = new Set(targetDb.prepare("PRAGMA table_info(tasks)").all().map(row => row.name));
    if (!columns.has(column)) throw new Error(`Target ledger missing tasks.${column}`);
  }
  if (!tableExists(targetDb, "mobile_media_identity") || !tableExists(sourceDb, "mobile_media_identity")) {
    throw new Error("Both ledgers must contain mobile_media_identity before merging");
  }
  const targetCheck = Object.values(targetDb.prepare("PRAGMA quick_check").get() || {})[0];
  const sourceCheck = Object.values(sourceDb.prepare("PRAGMA quick_check").get() || {})[0];
  if (targetCheck !== "ok" || sourceCheck !== "ok") throw new Error(`quick_check failed (target=${targetCheck}, source=${sourceCheck})`);
  const history = await collectHistoryValues();
  const plan = makePlan(targetDb, sourceDb, history);
  const fileChecks = { checked: 0, present_and_size_matched: 0, failed: [] };
  for (const row of plan.addRows) {
    fileChecks.checked += 1;
    if (await fileIsConsistent(row)) fileChecks.present_and_size_matched += 1;
    else fileChecks.failed.push(row.video_id);
  }
  const report = printPlan(plan, history, fileChecks);
  if (!apply) {
    console.log(JSON.stringify(report, null, 2));
    process.exitCode = fileChecks.failed.length ? 2 : 0;
  } else {
    if (fileChecks.failed.length) throw new Error(`Refusing merge: ${fileChecks.failed.length} media file paths are missing or size-mismatched`);
    targetDb.exec("PRAGMA foreign_keys=ON; BEGIN IMMEDIATE;");
    transactionOpen = true;
    const insertedIds = [];
    for (const row of plan.addRows) {
      insertTask(targetDb, row);
      insertedIds.push(row.id);
    }
    for (const update of plan.metadataUpdates) updateMetadata(targetDb, update);
    const identityCounts = copyIdentityRows(targetDb, plan.sourceIdentity, plan.addRows, plan);
    const copiedEvents = copyAttemptEvents(targetDb, sourceDb, insertedIds);
    targetDb.exec("COMMIT");
    transactionOpen = false;
    const afterCheck = Object.values(targetDb.prepare("PRAGMA quick_check").get() || {})[0];
    if (afterCheck !== "ok") throw new Error(`Post-merge quick_check failed: ${afterCheck}`);
    report.mode = "applied";
    report.target_tasks_after = targetDb.prepare("SELECT COUNT(*) AS count FROM tasks").get().count;
    report.metadata_rows_updated = plan.metadataUpdates.length;
    report.attempt_events_copied = copiedEvents;
    report.identity_rows_copied = identityCounts;
    report.integrity_after = afterCheck;
    console.log(JSON.stringify(report, null, 2));
  }
} catch (error) {
  if (transactionOpen) {
    try { targetDb.exec("ROLLBACK"); } catch { /* preserve original failure */ }
  }
  throw error;
} finally {
  sourceDb.close();
  targetDb.close();
}
