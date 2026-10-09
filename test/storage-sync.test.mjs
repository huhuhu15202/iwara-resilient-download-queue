import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { SQLiteStore } from "../src/sqlite-store.mjs";
import { StorageTransferStore } from "../src/storage-transfer-store.mjs";
import { StorageConfigManager } from "../src/storage-config-manager.mjs";
import { normalizeStorageRepositories, applyRepositoriesToLegacyConfig, repositoryOwnsPath, validateStorageRepositories } from "../src/storage-repositories.mjs";

const sha = "a".repeat(64);
const tempRoot = () => mkdtemp(path.join(os.tmpdir(), "iwara-storage-sync-"));

test("legacy roots migrate to enabled repositories and disabled entries survive projection", async () => {
  const root = await tempRoot();
  try {
    const legacy = { downloadRoot: path.join(root, "Iwara"), fallbackDownloadRoot: path.join(root, "Backup"),
      downloadMinimumFreeBytes: 500, externalMediaRoots: [path.join(root, "HanOld")],
      han1meDownloadRoot: path.join(root, "HanReceive"), han1meHistoryRoots: [path.join(root, "HanOld")] };
    const repositories = normalizeStorageRepositories(legacy);
    assert.deepEqual(repositories.map(item => item.id), ["han-receive", "iwara-primary", "iwara-fallback", "han-history-1"]);
    repositories.find(item => item.id === "han-history-1").enabled = false;
    const next = applyRepositoriesToLegacyConfig(legacy, repositories);
    assert.equal(next.storageRepositories.some(item => item.id === "han-history-1" && !item.enabled), true);
    assert.equal(next.downloadRoot, legacy.downloadRoot);
    assert.equal(next.han1meDownloadRoot, legacy.han1meDownloadRoot);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("longest repository path owns nested files and validator rejects drive roots", async () => {
  const root = await tempRoot();
  try {
    const parent = path.join(root, "Video"); const child = path.join(parent, "hanime_download");
    await mkdir(child, { recursive: true });
    const repositories = [
      { id: "iwara", name: "Iwara", path: parent, source: "iwara", roles: ["scan", "serve", "download"], priority: 1 },
      { id: "han", name: "Han", path: child, source: "han1", roles: ["scan", "serve", "receive"], priority: 2 }
    ];
    assert.equal(repositoryOwnsPath(repositories, path.join(child, "1", "video.mp4"), "scan").id, "han");
    assert.equal((await validateStorageRepositories(repositories)).length, 2);
    await assert.rejects(() => validateStorageRepositories([{ ...repositories[0], path: "C:\\" }]), /盘符根目录/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("repository config saves atomically, preserves unknown fields and checks stale revisions", async () => {
  const root = await tempRoot();
  try {
    const configPath = path.join(root, "config.json"); const media = path.join(root, "media");
    await mkdir(media); await writeFile(configPath, JSON.stringify({ opaqueSetting: { keep: true }, downloadRoot: media }));
    const manager = new StorageConfigManager({ config: { opaqueSetting: { keep: true }, downloadRoot: media,
      fallbackDownloadRoot: "", externalMediaRoots: [], han1meDownloadRoot: "", han1meHistoryRoots: [], downloadMinimumFreeBytes: 0 }, configPath, env: {} });
    const view = manager.view();
    const saved = await manager.save(view.repositories, view.revision);
    assert.equal(saved.pendingRestart, true);
    assert.equal(JSON.parse(await readFile(configPath, "utf8")).opaqueSetting.keep, true);
    await assert.rejects(() => manager.save(view.repositories, view.revision), /其他页面修改/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("history, inventory, transfer receipts are additive and idempotent", async () => {
  const root = await tempRoot();
  let store;
  try {
    store = new SQLiteStore({ filePath: path.join(root, "ledger.sqlite"), legacyJsonPath: path.join(root, "none.json"), backupRoot: path.join(root, "backups") });
    await store.load();
    const transfers = new StorageTransferStore(store.db);
    transfers.recordHistory("han1", "408435", { taskId: "task-1", metadata: { title: "sample" } });
    transfers.upsertInventory({ source: "han1", sourceId: "408435", taskId: "task-1", repositoryId: "han", relativePath: "408435/video.mp4", filename: "video.mp4", size: 8, sha256: sha });
    assert.equal(transfers.checkInventory([{ source: "han1", sourceId: "408435", relativePath: "408435/video.mp4", size: 8, sha256: sha }])[0].status, "present");
    assert.notEqual(transfers.checkInventory([{ source: "han1", sourceId: "408435", role: "cover", relativePath: "408435/cover.png", size: 8, sha256: sha }])[0].status, "present");
    assert.equal(transfers.checkInventory([{ source: "han1", sourceId: "408435", relativePath: "408435/video.mp4", size: 9, sha256: sha }])[0].status, "conflict");
    assert.equal(transfers.checkInventory([{ source: "han1", sourceId: "408435", relativePath: "408435/another-quality.mp4", size: 7, sha256: sha }])[0].status, "missing", "a different quality path must remain uploadable");
    const frozen = { direction: "upload", source: "han1", repositoryId: "han", requestKey: "retry-1",
      batches: [{ batchNo: 1, files: [{ sourceId: "408435", role: "media", relativePath: "408435/video.mp4", size: 8, sha256: sha }] }] };
    const transfer = transfers.createTransfer(frozen);
    assert.equal(transfers.createTransfer(frozen).id, transfer.id);
    assert.throws(() => transfers.createTransfer({ ...frozen, batches: [{ batchNo: 1, files: [{ sourceId: "408435", role: "media", relativePath: "408435/video.mp4", size: 9, sha256: sha }] }] }), /不同的冻结文件清单/);
    const file = transfer.batches[0].files[0];
    const finished = transfers.confirmFiles(transfer.id, transfer.batches[0].id, [{ ...file, state: "indexed" }]);
    assert.equal(finished.state, "confirmed");
    const replayed = transfers.confirmFiles(transfer.id, transfer.batches[0].id, [{ ...file, state: "saved" }]);
    assert.equal(replayed.batches[0].files[0].state, "indexed", "a retried upload must not downgrade an indexed receipt");
    transfers.setBatchPayload(transfer.id, transfer.batches[0].id, { ...replayed.batches[0].payload, archiveBytes: 1234 });
    store.close(); store = null;
    const reopened = new SQLiteStore({ filePath: path.join(root, "ledger.sqlite"), legacyJsonPath: path.join(root, "none.json"), backupRoot: path.join(root, "backups") });
    await reopened.load();
    const recovered = new StorageTransferStore(reopened.db);
    assert.equal(recovered.getTransfer(transfer.id).batches[0].files[0].state, "indexed");
    assert.equal(recovered.getTransfer(transfer.id).batches[0].payload.archiveBytes, 1234, "batch receipt metadata survives service restart");
    assert.equal(recovered.listHistory("han1").length, 1);
    assert.deepEqual(recovered.summary(), {
      historyCount: 1,
      inventoryCount: 1,
      conflictCount: 0,
      jobs: { confirmed: 1 },
      batches: { confirmed: 1 }
    });
    reopened.close();
  } finally { store?.close(); await rm(root, { recursive: true, force: true }); }
});
