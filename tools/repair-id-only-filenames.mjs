import { DatabaseSync } from "node:sqlite";
import { access, rename } from "node:fs/promises";
import path from "node:path";

const dataRoot = "F:\\IwaraVideos\\R18\\ServiceData";
const databasePath = path.join(dataRoot, "ledger.sqlite");
const apply = process.argv.includes("--apply");

function safeSegment(value, fallback = "video.mp4") {
  const cleaned = String(value || fallback)
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_")
    .replace(/[. ]+$/g, "")
    .slice(0, 180);
  return cleaned || fallback;
}

async function exists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

const db = new DatabaseSync(databasePath);
const rows = db.prepare("SELECT id, video_id, title, data_json FROM tasks WHERE state='completed'").all();
const candidates = [];
const skipped = [];

for (const row of rows) {
  const task = JSON.parse(row.data_json);
  const source = String(task.destination || "");
  const extension = path.extname(source) || ".mp4";
  if (!source || path.basename(source) !== `${task.videoId}${extension}`) continue;
  if (!task.title || task.title === task.videoId) {
    skipped.push({ videoId: task.videoId, reason: "缺少可用标题" });
    continue;
  }
  const destination = path.join(path.dirname(source), safeSegment(`${task.title}[${task.videoId}]${extension}`));
  if (source.toLowerCase() === destination.toLowerCase()) continue;
  if (!await exists(source)) {
    skipped.push({ videoId: task.videoId, reason: "原文件不存在", source });
    continue;
  }
  if (await exists(destination)) {
    skipped.push({ videoId: task.videoId, reason: "目标文件已存在", destination });
    continue;
  }
  candidates.push({ row, task, source, destination });
}

console.log(JSON.stringify({ mode: apply ? "apply" : "dry-run", candidates: candidates.length, skipped, preview: candidates.map(item => ({
  videoId: item.task.videoId, from: path.basename(item.source), to: path.basename(item.destination)
})) }, null, 2));

if (!apply) {
  db.close();
  process.exitCode = skipped.length ? 2 : 0;
} else if (skipped.length) {
  db.close();
  throw new Error(`预检未通过：${skipped.length} 条无法安全改名，未执行任何修改`);
} else {
  const renamed = [];
  try {
    for (const item of candidates) {
      await rename(item.source, item.destination);
      renamed.push(item);
    }
    db.exec("BEGIN IMMEDIATE");
    try {
      const updateTask = db.prepare("UPDATE tasks SET updated_at=?, data_json=? WHERE id=?");
      const addEvent = db.prepare(`INSERT INTO attempt_events (task_id, attempt_no, phase, outcome, category, message, source_host, completed_length, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
      const now = new Date().toISOString();
      for (const item of candidates) {
        item.task.destination = item.destination;
        item.task.preferredRelativePath = path.basename(item.destination);
        item.task.updatedAt = now;
        item.task.message = "下载完成（文件名已按标题和 ID 修复）";
        updateTask.run(now, JSON.stringify(item.task), item.task.id);
        addEvent.run(item.task.id, Number(item.task.attempts || 0), "maintenance", "renamed", "", `文件名修复：${path.basename(item.source)} -> ${path.basename(item.destination)}`, "", null, now);
      }
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  } catch (error) {
    for (const item of renamed.reverse()) {
      try { await rename(item.destination, item.source); } catch {}
    }
    throw error;
  } finally {
    db.close();
  }
  console.log(`APPLIED ${candidates.length} filename and ledger updates`);
}
