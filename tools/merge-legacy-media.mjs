import { access, readdir, rename, stat } from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

// This tool is intentionally dry-run by default.  It only moves media files
// that have a bracketed Iwara ID and are absent from both the ledger and the
// canonical J:\Video tree. JSON sidecars and files without a reliable ID are
// never moved.
const videoRoot = "J:\\Video";
const ledgerPath = "F:\\IwaraVideos\\R18\\ServiceData\\ledger.sqlite";
const sourceRoots = [
  "J:\\01musemu",
  "J:\\DANDELIONESTUDIO",
  "J:\\hoyosan",
  "J:\\NekroX2（不要在线解压！！！）",
  "J:\\tokuneo",
  "J:\\user1235858",
  "J:\\user937858",
  "J:\\wangbaduzio"
];
const mediaExtensions = new Set([".mp4", ".webm", ".mkv", ".mov", ".avi", ".m4v"]);
const idPattern = /\[([A-Za-z0-9_-]{10,32})\]/g;
const apply = process.argv.includes("--apply");

async function walk(root) {
  const files = [];
  async function visit(directory) {
    let entries = [];
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      if (error.code === "ENOENT") return;
      throw error;
    }
    for (const entry of entries) {
      const filePath = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(filePath);
      else if (entry.isFile() && mediaExtensions.has(path.extname(entry.name).toLowerCase())) {
        const info = await stat(filePath);
        const matches = [...entry.name.matchAll(idPattern)].map(match => match[1]);
        files.push({ path: filePath, name: entry.name, size: info.size, id: matches.at(-1) || "" });
      }
    }
  }
  await visit(root);
  return files;
}

async function exists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

function bytes(files) {
  return files.reduce((sum, file) => sum + Number(file.size || 0), 0);
}

const [external, canonical] = await Promise.all([
  Promise.all(sourceRoots.map(walk)).then(groups => groups.flat()),
  walk(videoRoot)
]);
const db = new DatabaseSync(ledgerPath, { readOnly: true });
const ledgerIds = new Set(db.prepare("SELECT video_id FROM tasks").all().map(row => row.video_id));
db.close();
const canonicalIds = new Set(canonical.map(file => file.id).filter(Boolean));
const grouped = new Map();
for (const file of external) {
  if (!file.id) continue;
  if (!grouped.has(file.id)) grouped.set(file.id, []);
  grouped.get(file.id).push(file);
}

const candidates = [];
const duplicateIds = [];
const duplicateFiles = [];
const unmatched = external.filter(file => !file.id);
for (const [id, files] of grouped) {
  if (ledgerIds.has(id) || canonicalIds.has(id)) {
    duplicateIds.push(id);
    continue;
  }
  const ordered = [...files].sort((a, b) => b.size - a.size || Number(a.name.endsWith(".1")) - Number(b.name.endsWith(".1")));
  const chosen = ordered[0];
  duplicateFiles.push(...ordered.slice(1));
  const target = path.join(videoRoot, chosen.name);
  if (await exists(target)) {
    duplicateIds.push(id);
    continue;
  }
  if (chosen.size < 65_536) {
    unmatched.push({ ...chosen, reason: "文件过小" });
    continue;
  }
  candidates.push({ ...chosen, target });
}

const result = {
  mode: apply ? "apply" : "dry-run",
  sourceMediaFiles: external.length,
  sourceBytes: bytes(external),
  sourceIds: grouped.size,
  ledgerOrCanonicalDuplicates: duplicateIds.length,
  candidateIds: candidates.length,
  candidateFiles: candidates.length,
  candidateBytes: bytes(candidates),
  duplicateSourceFiles: duplicateFiles.length,
  unmatchedFiles: unmatched.length,
  unmatchedExamples: unmatched.slice(0, 30).map(file => typeof file === "string" ? file : file.path),
  duplicateSourceExamples: duplicateFiles.slice(0, 20).map(file => file.path)
};
console.log(JSON.stringify(result, null, 2));

if (!apply) process.exit(0);
let moved = 0;
for (const file of candidates) {
  await rename(file.path, file.target);
  moved += 1;
}
console.log(JSON.stringify({ applied: true, moved, bytes: bytes(candidates), next: "重启服务以导入这些新 ID；随后在控制面板执行检查文件" }, null, 2));
