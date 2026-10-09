// Private local recovery snapshot; never print the configuration or tokens.
import { readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import { BackupManager, validateBackup } from "../src/backup-manager.mjs";

const config = JSON.parse(await readFile(path.resolve(import.meta.dirname, "../config.json"), "utf8"));
if (process.argv[2] === "--verify") {
  const directory = path.resolve(process.argv[3] || "");
  const { tasks } = await validateBackup(directory);
  console.log(JSON.stringify({ ok: true, directory, tasks }));
} else {
  const db = new DatabaseSync(path.join(config.dataRoot, "ledger.sqlite"), { readOnly: true });
  try {
    const manager = new BackupManager({ db, root: path.join(config.dataRoot, "backups"), config });
    const label = `before-backend-upgrade-${new Date().toISOString().replace(/[:.]/g, "-")}`;
    console.log(JSON.stringify(await manager.runOnce(label)));
  } finally { db.close(); }
}
