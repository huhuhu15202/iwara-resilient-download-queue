import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync, backup as sqliteBackup } from "node:sqlite";

const root = await mkdtemp(path.join(tmpdir(), "iwara-engine-smoke-"));
const dbPath = path.join(root, "source.sqlite");
const backupPath = path.join(root, "backup.sqlite");
let db;
let backupDb;
try {
  db = new DatabaseSync(dbPath);
  db.exec("CREATE TABLE smoke (id INTEGER PRIMARY KEY, value TEXT); INSERT INTO smoke(value) VALUES ('ok');");
  assert.equal(db.prepare("SELECT value FROM smoke WHERE id=1").get().value, "ok");
  await sqliteBackup(db, backupPath);
  backupDb = new DatabaseSync(backupPath);
  assert.equal(backupDb.prepare("SELECT value FROM smoke WHERE id=1").get().value, "ok");
  const bytes = (await readFile(backupPath)).byteLength;
  assert.ok(bytes > 0);
  console.log(`ENGINE_SMOKE_OK backup_bytes=${bytes}`);
} finally {
  backupDb?.close();
  db?.close();
  await rm(root, { recursive: true, force: true });
}
