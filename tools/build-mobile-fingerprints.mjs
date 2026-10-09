// Independent, resumable catalogue fingerprint job. It never loads/saves the
// production task store: only mobile_media_identity may be written.
import { DatabaseSync } from 'node:sqlite';
import { open, readFile, rename, stat, unlink, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { MobileLibrary } from '../src/mobile-library.mjs';

export const DEFAULT_DATA = 'F:/IwaraVideos/R18/ServiceData';
export const DEFAULT_ROOT = 'J:/Video';
export const DEFAULT_RATE = 32 * 1024 * 1024;

export function isAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; }
}

export async function readProgress(file) {
  try { return JSON.parse(await readFile(file, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

export async function acquireLock(file) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const handle = await open(file, 'wx');
      await handle.writeFile(JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
      await handle.close();
      return async () => {
        const owner = await readProgress(file);
        if (owner?.pid === process.pid) await unlink(file).catch(error => { if (error.code !== 'ENOENT') throw error; });
      };
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      let owner;
      try { owner = await readProgress(file); }
      catch (parseError) {
        // A second launcher must not remove a lock that is being initialized.
        if (Date.now() - (await stat(file)).mtimeMs < 30_000) throw new Error('指纹扫描器正在启动，禁止重复启动');
      }
      if (isAlive(owner?.pid)) throw new Error(`指纹扫描已在进程 ${owner.pid} 运行，禁止重复启动`);
      await unlink(file).catch(removeError => { if (removeError.code !== 'ENOENT') throw removeError; });
    }
  }
  throw new Error('无法取得指纹扫描锁');
}

export async function atomicJson(file, value) {
  const temporary = `${file}.${process.pid}.tmp`;
  try {
    const handle = await open(temporary, 'w');
    try { await handle.writeFile(JSON.stringify(value)); await handle.sync(); }
    finally { await handle.close(); }
    await rename(temporary, file);
  } finally { await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
}

export function loadTasksReadOnly(file, root) {
  const reader = new DatabaseSync(file, { readOnly: true });
  try {
    reader.exec('PRAGMA busy_timeout=5000;');
    const rows = reader.prepare("SELECT id,data_json FROM tasks WHERE state='completed'").all();
    const cached = new Set(reader.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='local_file_fingerprints'").get()
      ? reader.prepare('SELECT path FROM local_file_fingerprints').all().map(row => path.resolve(row.path).toLowerCase()) : []);
    const tasks = [];
    let excluded = 0;
    for (const row of rows) {
      const task = JSON.parse(row.data_json);
      if (task.id !== row.id) throw new Error('台账任务主键与 JSON 不一致，停止扫描');
      const relative = task.destination ? path.relative(path.resolve(root), path.resolve(task.destination)) : '';
      if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) { excluded += 1; continue; }
      tasks.push(task);
    }
    // Verified legacy identities are cheap: establish those 77 first.
    tasks.sort((left, right) => Number(cached.has(path.resolve(right.destination).toLowerCase())) - Number(cached.has(path.resolve(left.destination).toLowerCase())));
    return { tasks, excluded, completed: rows.length };
  } finally { reader.close(); }
}

export async function runScan({ dbFile, root, dataDirectory, bytesPerSecond = DEFAULT_RATE, logger = console.log } = {}) {
  await mkdir(dataDirectory, { recursive: true });
  const progressFile = path.join(dataDirectory, 'mobile-fingerprint-progress.json');
  const lockFile = path.join(dataDirectory, 'mobile-fingerprint.lock');
  const stopFile = path.join(dataDirectory, 'mobile-fingerprint-stop.request');
  const progress = await readProgress(progressFile);
  if (progress?.running && isAlive(progress.pid)) throw new Error(`已有指纹工作任务 ${progress.pid}，禁止重复运行`);
  const release = await acquireLock(lockFile);
  let writer; let library; let timer; let finishing = false; let publishing = Promise.resolve();
  let excluded = 0; let completed = 0; let lastLogged = -1; let lastLogAt = 0;
  const startedAt = new Date().toISOString();
  const sanitized = () => {
    const current = library?.status() || { running: true, total: 0, ready: 0, failed: 0, bytesHashed: 0, current: '', lastScanAt: null, issues: [] };
    return {
      pid: process.pid, running: !finishing && current.running, total: current.total,
      ready: current.ready, pending: current.pending ?? current.total - current.ready,
      failed: current.failed, bytesHashed: current.bytesHashed,
      current: path.basename(current.current || ''), lastScanAt: current.lastScanAt,
      issues: current.issues.map(issue => ({ taskId: issue.taskId, reason: String(issue.reason || '').replace(/[A-Za-z]:[\\/][^\n]*/g, '[本地文件]') })),
      excluded, completed, sampleVersion: 1, bytesPerSecond, startedAt, updatedAt: new Date().toISOString()
    };
  };
  const publish = () => {
    publishing = publishing.then(async () => {
      const value = sanitized(); await atomicJson(progressFile, value);
      if (value.ready >= lastLogged + 25 || Date.now() - lastLogAt > 60_000 || finishing) {
        logger(JSON.stringify({ at: value.updatedAt, pid: value.pid, running: value.running, ready: value.ready, total: value.total,
          failed: value.failed, bytesHashed: value.bytesHashed, excluded: value.excluded }));
        lastLogged = value.ready; lastLogAt = Date.now();
      }
    }).catch(error => logger(`统计进度发布失败：${error.code || error.message}`));
    return publishing;
  };
  const requestStop = () => { library?.controller?.abort(); };
  process.on('SIGINT', requestStop); process.on('SIGTERM', requestStop);
  try {
    // Publish a live PID before any potentially slow preflight I/O.
    await atomicJson(progressFile, sanitized());
    const snapshot = loadTasksReadOnly(dbFile, root); excluded = snapshot.excluded; completed = snapshot.completed;
    writer = new DatabaseSync(dbFile);
    writer.exec('PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON; PRAGMA synchronous=FULL;');
    library = new MobileLibrary({ store: { db: writer, state: { tasks: snapshot.tasks } }, root,
      exportRoot: path.join(dataDirectory, 'mobile-exports'), bytesPerSecond, manageDownloadJobs: false });
    await unlink(stopFile).catch(error => { if (error.code !== 'ENOENT') throw error; });
    const scan = library.scan(); await publish();
    timer = setInterval(async () => {
      try { await stat(stopFile); requestStop(); } catch (error) { if (error.code !== 'ENOENT') logger(`停止请求检查失败：${error.code || error.message}`); }
      void publish();
    }, 2000);
    timer.unref();
    await scan;
    finishing = true; clearInterval(timer); await publish();
    return sanitized();
  } catch (error) {
    logger(`指纹扫描停止：${error.code || error.message}`); finishing = true;
    if (library) { library.progress.failed += 1; library.progress.issues.push({ taskId: null, reason: error.code || 'SCAN_FAILED' }); }
    await publish(); throw error;
  } finally {
    if (timer) clearInterval(timer);
    process.off('SIGINT', requestStop); process.off('SIGTERM', requestStop);
    await library?.stop(); await publishing; writer?.close(); await release();
  }
}

const main = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (main) {
  const args = process.argv.slice(2); const argument = (name, fallback) => {
    const index = args.indexOf(name); return index === -1 ? fallback : args[index + 1];
  };
  const dataDirectory = argument('--data-dir', DEFAULT_DATA);
  const dbFile = argument('--db', path.join(dataDirectory, 'ledger.sqlite'));
  const root = argument('--root', DEFAULT_ROOT);
  try {
    if (args.includes('--status')) {
      const current = await readProgress(path.join(dataDirectory, 'mobile-fingerprint-progress.json'));
      console.log(JSON.stringify(current ? { ...current, processAlive: isAlive(current.pid) } : { running: false, ready: 0 }));
    } else await runScan({ dbFile, root, dataDirectory });
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
