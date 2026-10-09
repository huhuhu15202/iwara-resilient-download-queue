// Production verification is read-only. Never print private capability URLs.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import { validateBackup } from "../src/backup-manager.mjs";
const config = JSON.parse(await readFile(path.resolve(import.meta.dirname, "../config.json"), "utf8"));
const snapshot = path.resolve(process.argv[2]);
const oldConfig = JSON.parse(await readFile(path.join(snapshot, "config.json"), "utf8"));
assert.equal(config.lanAccessToken, oldConfig.lanAccessToken);
const db = new DatabaseSync(path.join(config.dataRoot, "ledger.sqlite"), { readOnly: true });
const oldDb = new DatabaseSync(path.join(snapshot, "ledger.sqlite"), { readOnly: true });
const records = database => database.prepare("SELECT id,video_id,playback_position,playback_duration,watched,favorite,watch_later,discarded,queue_position FROM tasks ORDER BY id").all();
const before = records(oldDb), after = records(db); assert.deepEqual(after, before);
const identity = db.prepare("SELECT count(*) n FROM local_media_identity").get().n;
const target = db.prepare("SELECT id FROM tasks WHERE video_id=? AND state='completed'").get("re6uDq4hysSOFH") || db.prepare("SELECT id FROM tasks WHERE state='completed' AND media_status='present' LIMIT 1").get(); db.close(); oldDb.close();
const base = process.env.IWARA_TEST_ORIGIN || "http://127.0.0.1:18777";
const unauthorized = await fetch(base + "/api/playlist?pageSize=1"); assert.equal(unauthorized.status, 401);
const list = await (await fetch(base + "/api/playlist?contextId=" + target.id + "&contextSize=1&profile=local", { headers: { "x-iwara-access-token": config.lanAccessToken } })).json();
const item = list.items.find(item => item.id === target.id); assert.ok(item);
assert.equal((await fetch(base + "/media/" + item.id, { method: "HEAD" })).status, 401);
const head = await fetch(base + item.streamUrl, { method: "HEAD" }); assert.equal(head.status, 200); const size = Number(head.headers.get("content-length"));
for (const range of ["bytes=0-1023", "bytes=-1024", "bytes=" + (size - 1024) + "-"]) {
  const response = await fetch(base + item.streamUrl, { headers: { Range: range } }); assert.equal(response.status, 206); assert.equal((await response.arrayBuffer()).byteLength, 1024);
}
assert.equal((await fetch(base + item.streamUrl, { headers: { Range: "bytes=" + size + "-" } })).status, 416);
const cover = await fetch(base + item.coverUrl); assert.equal(cover.status, 200); assert.equal(cover.headers.get("content-type"), "image/jpeg"); await cover.arrayBuffer();
const backup = await validateBackup(path.join(config.dataRoot, "backups", "2026-10-03"));
console.log(JSON.stringify({ ok: true, records: after.length, unchangedIdsFlagsAndPlayback: true, unchangedToken: true, fingerprints: identity, deniedWithoutTicket: true, authorizedHeadAndRanges: true, cover: true, dailyBackupRecords: backup.tasks }));
