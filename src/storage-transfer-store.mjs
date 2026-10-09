import { randomUUID } from "node:crypto";

const now = () => new Date().toISOString();
const json = value => JSON.stringify(value ?? null);

/** Additive persistence for repository inventory and resumable mobile transfers. */
export class StorageTransferStore {
  constructor(db) {
    this.db = db;
    db.exec(`
      CREATE TABLE IF NOT EXISTS media_download_history (
        source TEXT NOT NULL, source_id TEXT NOT NULL, task_id TEXT NOT NULL DEFAULT '',
        metadata_json TEXT NOT NULL DEFAULT '{}', first_seen_at TEXT NOT NULL, last_seen_at TEXT NOT NULL,
        PRIMARY KEY(source, source_id)
      );
      CREATE TABLE IF NOT EXISTS media_file_inventory (
        id INTEGER PRIMARY KEY AUTOINCREMENT, source TEXT NOT NULL, source_id TEXT NOT NULL,
        task_id TEXT NOT NULL DEFAULT '', role TEXT NOT NULL DEFAULT 'media', repository_id TEXT NOT NULL, relative_path TEXT NOT NULL,
        filename TEXT NOT NULL, size INTEGER NOT NULL, sha256 TEXT NOT NULL, quality TEXT NOT NULL DEFAULT '',
        state TEXT NOT NULL DEFAULT 'available', metadata_json TEXT NOT NULL DEFAULT '{}', updated_at TEXT NOT NULL,
        UNIQUE(repository_id, relative_path)
      );
      CREATE INDEX IF NOT EXISTS idx_media_inventory_identity ON media_file_inventory(source,source_id,state);
      CREATE INDEX IF NOT EXISTS idx_media_inventory_hash ON media_file_inventory(sha256,size,state);
      CREATE TABLE IF NOT EXISTS media_transfer_jobs (
        id TEXT PRIMARY KEY, direction TEXT NOT NULL, source TEXT NOT NULL, state TEXT NOT NULL,
        repository_id TEXT NOT NULL DEFAULT '', config_version TEXT NOT NULL DEFAULT '',
        request_key TEXT NOT NULL DEFAULT '', payload_json TEXT NOT NULL DEFAULT '{}',
        error TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_media_transfer_request_key ON media_transfer_jobs(request_key) WHERE request_key <> '';
      CREATE TABLE IF NOT EXISTS media_transfer_batches (
        id TEXT PRIMARY KEY, transfer_id TEXT NOT NULL REFERENCES media_transfer_jobs(id) ON DELETE CASCADE,
        batch_no INTEGER NOT NULL, state TEXT NOT NULL, total_bytes INTEGER NOT NULL DEFAULT 0,
        payload_json TEXT NOT NULL DEFAULT '{}', error TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        UNIQUE(transfer_id,batch_no)
      );
      CREATE TABLE IF NOT EXISTS media_transfer_files (
        id INTEGER PRIMARY KEY AUTOINCREMENT, transfer_id TEXT NOT NULL REFERENCES media_transfer_jobs(id) ON DELETE CASCADE,
        batch_id TEXT NOT NULL REFERENCES media_transfer_batches(id) ON DELETE CASCADE,
        source TEXT NOT NULL, source_id TEXT NOT NULL, task_id TEXT NOT NULL DEFAULT '',
        role TEXT NOT NULL, relative_path TEXT NOT NULL, size INTEGER NOT NULL, sha256 TEXT NOT NULL,
        repository_id TEXT NOT NULL DEFAULT '', state TEXT NOT NULL, receipt_json TEXT NOT NULL DEFAULT '{}',
        error TEXT NOT NULL DEFAULT '', updated_at TEXT NOT NULL,
        UNIQUE(batch_id,source,source_id,role,relative_path)
      );
      CREATE INDEX IF NOT EXISTS idx_media_transfer_files_state ON media_transfer_files(transfer_id,batch_id,state);
    `);
    const inventoryColumns = new Set(db.prepare("PRAGMA table_info(media_file_inventory)").all().map(column => column.name));
    if (!inventoryColumns.has("role")) db.exec("ALTER TABLE media_file_inventory ADD COLUMN role TEXT NOT NULL DEFAULT 'media'");
    const existing = db.prepare("SELECT value FROM meta WHERE key='storage_service_id'").get();
    if (!existing) db.prepare("INSERT INTO meta(key,value) VALUES('storage_service_id',?)").run(randomUUID());
  }

  get serviceId() { return this.db.prepare("SELECT value FROM meta WHERE key='storage_service_id'").get()?.value || ''; }

  recordHistory(source, sourceId, { taskId = '', metadata = {} } = {}) {
    const timestamp = now();
    this.db.prepare(`INSERT INTO media_download_history(source,source_id,task_id,metadata_json,first_seen_at,last_seen_at)
      VALUES(?,?,?,?,?,?) ON CONFLICT(source,source_id) DO UPDATE SET
      task_id=CASE WHEN excluded.task_id='' THEN media_download_history.task_id ELSE excluded.task_id END,
      metadata_json=CASE WHEN excluded.metadata_json='{}' THEN media_download_history.metadata_json ELSE excluded.metadata_json END,
      last_seen_at=excluded.last_seen_at`).run(source, sourceId, taskId, json(metadata), timestamp, timestamp);
  }

  listHistory(source = '') {
    const rows = source
      ? this.db.prepare('SELECT * FROM media_download_history WHERE source=? ORDER BY source_id').all(source)
      : this.db.prepare('SELECT * FROM media_download_history ORDER BY source,source_id').all();
    return rows.map(row => ({ source: row.source, sourceId: row.source_id, taskId: row.task_id,
      metadata: JSON.parse(row.metadata_json), firstSeenAt: row.first_seen_at, lastSeenAt: row.last_seen_at }));
  }

  summary() {
    const count = sql => Number(this.db.prepare(sql).get()?.count || 0);
    const groupCounts = sql => Object.fromEntries(this.db.prepare(sql).all().map(row => [row.state, Number(row.count)]));
    return {
      historyCount: count('SELECT COUNT(*) count FROM media_download_history'),
      inventoryCount: count('SELECT COUNT(*) count FROM media_file_inventory WHERE state=\'available\''),
      conflictCount: count('SELECT COUNT(*) count FROM media_transfer_files WHERE state=\'conflict\''),
      jobs: groupCounts('SELECT state,COUNT(*) count FROM media_transfer_jobs GROUP BY state'),
      batches: groupCounts('SELECT state,COUNT(*) count FROM media_transfer_batches GROUP BY state')
    };
  }

  upsertInventory(item) {
    const timestamp = now();
    this.db.prepare(`INSERT INTO media_file_inventory(source,source_id,task_id,role,repository_id,relative_path,filename,size,sha256,quality,state,metadata_json,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(repository_id,relative_path) DO UPDATE SET
      source=excluded.source,source_id=excluded.source_id,task_id=excluded.task_id,role=excluded.role,filename=excluded.filename,
      size=excluded.size,sha256=excluded.sha256,quality=excluded.quality,state=excluded.state,
      metadata_json=excluded.metadata_json,updated_at=excluded.updated_at`)
      .run(item.source, item.sourceId, item.taskId || '', item.role || 'media', item.repositoryId, item.relativePath, item.filename,
        item.size, item.sha256, item.quality || '', item.state || 'available', json(item.metadata), timestamp);
  }

  checkInventory(requested) {
    const findIdentity = this.db.prepare(`SELECT repository_id,relative_path,filename,size,sha256,quality,state,role FROM media_file_inventory
      WHERE source=? AND source_id=? AND role=? AND state='available'`);
    const findContent = this.db.prepare(`SELECT repository_id,relative_path,filename,size,sha256,quality,state FROM media_file_inventory
      WHERE sha256=? AND size=? AND state='available'`);
    return requested.map(file => {
      const identityRows = findIdentity.all(file.source, file.sourceId, file.role || 'media');
      const matching = identityRows.filter(row => row.size === file.size && row.sha256 === file.sha256);
      if (matching.length) return { ...file, status: 'present', copies: matching.map(row => ({ repositoryId: row.repository_id, relativePath: row.relative_path, filename: row.filename, size: row.size, sha256: row.sha256, quality: row.quality, role: row.role })) };
      if (identityRows.some(row => row.relative_path === file.relativePath)) return { ...file, status: 'conflict', reason: '同一文件路径已存在，但内容长度或 SHA-256 不同' };
      const sameContent = findContent.all(file.sha256, file.size);
      if (sameContent.length) return { ...file, status: 'content_match_other_identity', copies: sameContent.map(row => ({ repositoryId: row.repository_id, filename: row.filename, size: row.size, sha256: row.sha256 })) };
      return { ...file, status: 'missing' };
    });
  }

  createTransfer({ id = randomUUID(), direction, source, repositoryId = '', configVersion = '', requestKey = '', payload = {}, batches = [] }) {
    const timestamp = now();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      if (requestKey) {
        const prior = this.db.prepare('SELECT id FROM media_transfer_jobs WHERE request_key=?').get(requestKey);
        if (prior) {
          const existing = this.getTransfer(prior.id);
          const identity = file => [file.source || source, file.sourceId || '', file.taskId || '', file.role || 'media',
            file.relativePath || file.filename || '', Number(file.size), String(file.sha256 || '').toLowerCase()].join('\u0000');
          const expectedFiles = batches.flatMap(batch => batch.files || []).map(identity).sort();
          const existingFiles = existing.batches.flatMap(batch => batch.files).map(identity).sort();
          if (existing.direction !== direction || existing.source !== source || existing.repositoryId !== repositoryId ||
              expectedFiles.length !== existingFiles.length || expectedFiles.some((item, index) => item !== existingFiles[index])) {
            throw Object.assign(new Error('幂等请求键已绑定到不同的冻结文件清单'), { statusCode: 409 });
          }
          this.db.exec('COMMIT'); return existing;
        }
      }
      this.db.prepare(`INSERT INTO media_transfer_jobs(id,direction,source,state,repository_id,config_version,request_key,payload_json,created_at,updated_at)
        VALUES(?,?,?,'preparing',?,?,?,?,?,?)`).run(id, direction, source, repositoryId, configVersion, requestKey, json(payload), timestamp, timestamp);
      const insertBatch = this.db.prepare(`INSERT INTO media_transfer_batches(id,transfer_id,batch_no,state,total_bytes,payload_json,created_at,updated_at)
        VALUES(?,?,?,'preparing',?,?,?,?)`);
      const insertFile = this.db.prepare(`INSERT INTO media_transfer_files(transfer_id,batch_id,source,source_id,task_id,role,relative_path,size,sha256,repository_id,state,receipt_json,updated_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,'pending','{}',?)`);
      for (const [index, batch] of batches.entries()) {
        const batchId = batch.id || randomUUID();
        insertBatch.run(batchId, id, Number(batch.batchNo ?? index + 1), Number(batch.totalBytes || 0), json(batch.payload), timestamp, timestamp);
        for (const file of batch.files || []) insertFile.run(id, batchId, file.source || source, file.sourceId || '', file.taskId || '', file.role || 'media', file.relativePath || file.filename || '', Number(file.size), file.sha256 || '', file.repositoryId || repositoryId, timestamp);
      }
      this.db.exec('COMMIT');
      return this.getTransfer(id);
    } catch (error) { try { this.db.exec('ROLLBACK'); } catch {} throw error; }
  }

  getTransfer(id) {
    const transfer = this.db.prepare('SELECT * FROM media_transfer_jobs WHERE id=?').get(id);
    if (!transfer) return null;
    const batches = this.db.prepare('SELECT * FROM media_transfer_batches WHERE transfer_id=? ORDER BY batch_no').all(id).map(batch => ({
      id: batch.id, batchNo: batch.batch_no, state: batch.state, totalBytes: batch.total_bytes,
      payload: JSON.parse(batch.payload_json), error: batch.error,
      files: this.db.prepare('SELECT * FROM media_transfer_files WHERE batch_id=? ORDER BY id').all(batch.id).map(file => ({
        source: file.source, sourceId: file.source_id, taskId: file.task_id, role: file.role,
        relativePath: file.relative_path, size: file.size, sha256: file.sha256, repositoryId: file.repository_id,
        state: file.state, receipt: JSON.parse(file.receipt_json), error: file.error
      }))
    }));
    return { id: transfer.id, direction: transfer.direction, source: transfer.source, state: transfer.state,
      repositoryId: transfer.repository_id, configVersion: transfer.config_version,
      payload: JSON.parse(transfer.payload_json), error: transfer.error,
      createdAt: transfer.created_at, updatedAt: transfer.updated_at, batches };
  }

  getTransferByRequestKey(requestKey) {
    const row = this.db.prepare("SELECT id FROM media_transfer_jobs WHERE request_key=?").get(requestKey);
    return row ? this.getTransfer(row.id) : null;
  }

  confirmFiles(transferId, batchId, receipts) {
    const timestamp = now();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const batch = this.db.prepare('SELECT id FROM media_transfer_batches WHERE id=? AND transfer_id=?').get(batchId, transferId);
      if (!batch) throw new Error('传输批次不存在');
      const update = this.db.prepare(`UPDATE media_transfer_files SET
        state=CASE WHEN state='indexed' AND ?<>'indexed' THEN state ELSE ? END,
        receipt_json=CASE WHEN state='indexed' AND ?<>'indexed' THEN receipt_json ELSE ? END,
        error=CASE WHEN state='indexed' AND ?<>'indexed' THEN error ELSE ? END,updated_at=?
        WHERE transfer_id=? AND batch_id=? AND source=? AND source_id=? AND role=? AND relative_path=? AND size=? AND sha256=?`);
      for (const receipt of receipts) {
        if (!['saved', 'indexed', 'failed', 'filtered', 'conflict'].includes(receipt.state)) throw new Error('文件回执状态无效');
        const result = update.run(receipt.state, receipt.state, receipt.state, json(receipt), receipt.state,
          String(receipt.error || '').slice(0, 500), timestamp,
          transferId, batchId, receipt.source, receipt.sourceId, receipt.role, receipt.relativePath,
          Number(receipt.size), receipt.sha256);
        if (result.changes !== 1) throw new Error('回执与冻结的文件清单不匹配');
      }
      const remaining = Number(this.db.prepare("SELECT COUNT(*) count FROM media_transfer_files WHERE transfer_id=? AND batch_id=? AND state NOT IN ('indexed','filtered')").get(transferId, batchId).count);
      const failures = Number(this.db.prepare("SELECT COUNT(*) count FROM media_transfer_files WHERE transfer_id=? AND batch_id=? AND state IN ('failed','conflict')").get(transferId, batchId).count);
      const batchState = failures ? 'failed' : remaining ? 'verifying' : 'confirmed';
      this.db.prepare('UPDATE media_transfer_batches SET state=?,updated_at=? WHERE id=?').run(batchState, timestamp, batchId);
      const allRemaining = Number(this.db.prepare("SELECT COUNT(*) count FROM media_transfer_batches WHERE transfer_id=? AND state NOT IN ('confirmed','failed','cancelled')").get(transferId).count);
      const jobState = failures ? 'failed' : allRemaining ? 'transferring' : 'confirmed';
      this.db.prepare('UPDATE media_transfer_jobs SET state=?,updated_at=? WHERE id=?').run(jobState, timestamp, transferId);
      this.db.exec('COMMIT');
      return this.getTransfer(transferId);
    } catch (error) { try { this.db.exec('ROLLBACK'); } catch {} throw error; }
  }

  setBatchState(transferId, batchId, state, error = "") {
    if (!["preparing", "transferring", "verifying", "failed", "cancelled", "confirmed"].includes(state)) throw new Error("传输批次状态无效");
    const timestamp = now();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const update = this.db.prepare("UPDATE media_transfer_batches SET state=?,error=?,updated_at=? WHERE id=? AND transfer_id=?")
        .run(state, String(error).slice(0, 500), timestamp, batchId, transferId);
      if (update.changes !== 1) throw new Error("传输批次不存在");
      const jobState = state === "failed" ? "failed" : state === "cancelled" ? "cancelled"
        : state === "confirmed" ? "confirmed" : state === "transferring" ? "transferring" : "verifying";
      this.db.prepare("UPDATE media_transfer_jobs SET state=?,error=?,updated_at=? WHERE id=?")
        .run(jobState, String(error).slice(0, 500), timestamp, transferId);
      this.db.exec("COMMIT");
      return this.getTransfer(transferId);
    } catch (cause) { try { this.db.exec("ROLLBACK"); } catch {} throw cause; }
  }

  setBatchPayload(transferId, batchId, payload) {
    const result = this.db.prepare("UPDATE media_transfer_batches SET payload_json=?,updated_at=? WHERE transfer_id=? AND id=?")
      .run(json(payload), now(), transferId, batchId);
    if (result.changes !== 1) throw new Error("传输批次不存在");
    return this.getTransfer(transferId);
  }

  cancelTransfer(id, reason = 'cancelled by client') {
    const timestamp = now();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = this.db.prepare("UPDATE media_transfer_jobs SET state='cancelled',error=?,updated_at=? WHERE id=? AND state NOT IN ('confirmed','cancelled')").run(reason.slice(0, 300), timestamp, id);
      this.db.prepare("UPDATE media_transfer_batches SET state='cancelled',error=?,updated_at=? WHERE transfer_id=? AND state NOT IN ('confirmed','cancelled')").run(reason.slice(0, 300), timestamp, id);
      this.db.exec('COMMIT');
      return result.changes > 0 ? this.getTransfer(id) : null;
    } catch (error) { try { this.db.exec('ROLLBACK'); } catch {} throw error; }
  }
}
