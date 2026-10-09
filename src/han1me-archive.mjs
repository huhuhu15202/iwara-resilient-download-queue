import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { lstat, mkdir, mkdtemp, open, realpath, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import yauzl from "yauzl";

const MAX_ARCHIVE_BYTES = 64 * 1024 ** 3;
const MAX_UNCOMPRESSED_BYTES = 64 * 1024 ** 3;
const MAX_ENTRY_COUNT = 4_000;
const MAX_MANIFEST_BYTES = 4 * 1024 * 1024;
const MAX_CODE_COUNT = 1_000;
const MIN_VIDEO_BYTES = 65_536;
const MEDIA_EXTENSIONS = new Set([".mp4", ".webm", ".mkv", ".mov", ".avi", ".m4v"]);
let commitTail = Promise.resolve();

function archiveError(statusCode, message) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function safeArchivePath(value) {
  if (typeof value !== "string" || value.length > 512 || value.includes("\\") || value.includes("\0")) return null;
  const parts = value.split("/");
  if (!parts.length || parts.some(part => !part || part === "." || part === ".." || /^[a-z]:/i.test(part))) return null;
  if (parts.length === 1 && parts[0] === "manifest.json") return { manifest: true, path: value };
  if (parts.length !== 2 || !/^\d{1,30}$/.test(parts[0])) return null;
  const filename = parts[1];
  if (filename.startsWith(".") || /[<>:"|?*\u0000-\u001f\u007f]/.test(filename)) return null;
  if (/[ .]$/.test(filename) || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i.test(filename)) return null;
  const extension = path.extname(filename).toLowerCase();
  if (!MEDIA_EXTENSIONS.has(extension) && extension !== ".png" && filename.toLowerCase() !== "info.json") return null;
  return { code: parts[0], filename, extension, path: value };
}

function openZip(file) {
  return new Promise((resolve, reject) => {
    yauzl.open(file, {
      lazyEntries: true,
      decodeStrings: true,
      validateEntrySizes: true,
      strictFileNames: true,
      autoClose: false,
    }, (error, zip) => error ? reject(archiveError(400, "上传内容不是有效的 ZIP 包")) : resolve(zip));
  });
}

function openEntry(zip, entry) {
  return new Promise((resolve, reject) => {
    zip.openReadStream(entry, (error, stream) => error ? reject(error) : resolve(stream));
  });
}

async function readSmallEntry(zip, entry, maximumBytes) {
  const stream = await openEntry(zip, entry);
  const chunks = [];
  let bytes = 0;
  for await (const chunk of stream) {
    bytes += chunk.length;
    if (bytes > maximumBytes) throw archiveError(413, "归档清单超过大小限制");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, bytes).toString("utf8");
}

async function extractEntry(zip, entry, destination, limits) {
  const stream = await openEntry(zip, entry);
  const digest = createHash("sha256");
  let size = 0;
  const hasher = new Transform({
    transform(chunk, _encoding, callback) {
      size += chunk.length;
      limits.total += chunk.length;
      if (size > MAX_UNCOMPRESSED_BYTES || limits.total > MAX_UNCOMPRESSED_BYTES) {
        callback(archiveError(413, "归档解压后的数据超过大小限制"));
        return;
      }
      digest.update(chunk);
      callback(null, chunk);
    },
  });
  await mkdir(path.dirname(destination), { recursive: true });
  await pipeline(stream, hasher, createWriteStream(destination, { flags: "wx" }));
  return { path: entry.fileName, size, sha256: digest.digest("hex") };
}

function validateManifest(manifest, files, { compareHashes = true } = {}) {
  if (!manifest || manifest.type !== "han1meviewer-archive" || ![1, 2].includes(manifest.version) || !Array.isArray(manifest.videos) || !Array.isArray(manifest.files)) {
    throw archiveError(400, "归档清单格式不受支持");
  }
  if (manifest.version === 2 && (!/^[a-f0-9-]{36}$/i.test(manifest.transferId || "") || manifest.files.some(file =>
      !["han1", "iwara"].includes(file.source) || !String(file.sourceId || "") ||
      !["media", "cover", "metadata"].includes(file.role)))) {
    throw archiveError(400, "v2 归档缺少有效的传输或逐文件来源身份");
  }
  if (manifest.videos.length < 1 || manifest.videos.length > MAX_CODE_COUNT || manifest.files.length !== files.length) {
    throw archiveError(400, "归档清单中的视频或文件数量无效");
  }
  const expectedFiles = new Map();
  for (const file of manifest.files) {
    const safe = safeArchivePath(file?.path);
    if (!safe || safe.manifest || !Number.isSafeInteger(file.size) || file.size < 0 || !/^[a-f0-9]{64}$/.test(file.sha256 || "") || expectedFiles.has(file.path)) {
      throw archiveError(400, "归档清单包含无效文件信息");
    }
    expectedFiles.set(file.path, file);
  }
  const videoCodes = new Set();
  for (const video of manifest.videos) {
    const code = String(video?.code ?? "");
    if (!/^\d{1,30}$/.test(code) || videoCodes.has(code)) throw archiveError(400, "归档清单包含无效或重复的视频编号");
    videoCodes.add(code);
  }
  const codeSet = new Set();
  const mediaByCode = new Map();
  const infoByCode = new Set();
  for (const actual of files) {
    const safe = safeArchivePath(actual.path);
    const expected = expectedFiles.get(actual.path);
    if (!safe || safe.manifest || !expected || expected.size !== actual.size ||
        (compareHashes && expected.sha256 !== actual.sha256)) {
      throw archiveError(400, "归档文件与清单校验不一致");
    }
    codeSet.add(safe.code);
    if (MEDIA_EXTENSIONS.has(safe.extension)) {
      if (actual.size < MIN_VIDEO_BYTES) throw archiveError(400, `视频 ${safe.code} 文件长度不足，拒绝归档`);
      mediaByCode.set(safe.code, (mediaByCode.get(safe.code) || 0) + 1);
    }
    if (safe.filename.toLowerCase() === "info.json") infoByCode.add(safe.code);
  }
  if (codeSet.size !== videoCodes.size || [...videoCodes].some(code => !codeSet.has(code))) {
    throw archiveError(400, "归档清单的视频编号与文件目录不一致");
  }
  for (const code of videoCodes) {
    if (!mediaByCode.get(code) || !infoByCode.has(code)) throw archiveError(400, `视频 ${code} 缺少媒体文件或 info.json`);
  }
  return [...videoCodes];
}

async function sha256File(file) {
  const hash = createHash("sha256");
  let size = 0;
  const handle = await open(file, "r");
  try {
    const stream = handle.createReadStream({ autoClose: false });
    for await (const chunk of stream) {
      size += chunk.length;
      hash.update(chunk);
    }
  } finally {
    await handle.close();
  }
  return { size, sha256: hash.digest("hex") };
}

async function exists(file) {
  try { return await lstat(file); }
  catch (error) { if (error.code === "ENOENT") return null; throw error; }
}

async function commitFiles(root, staging, codes, extractedFiles) {
  const plan = [];
  const targetPaths = new Set();
  let alreadyPresentCount = 0;
  let preservedSidecarCount = 0;
  for (const file of extractedFiles) {
    const code = file.path.split("/")[0];
    const relativeName = file.path.slice(code.length + 1);
    const source = path.join(staging, code, relativeName);
    const targetDirectory = path.join(root, code);
    const directoryInfo = await exists(targetDirectory);
    if (directoryInfo && (!directoryInfo.isDirectory() || directoryInfo.isSymbolicLink())) {
      throw archiveError(409, `电脑上的编号目录 ${code} 不是安全目录，未覆盖任何内容`);
    }
    const target = path.join(targetDirectory, relativeName);
    const targetKey = path.resolve(target).toLocaleLowerCase("en-US");
    if (targetPaths.has(targetKey)) {
      throw archiveError(409, `归档中的文件名在 Windows 上会冲突：${file.path}，未覆盖任何内容`);
    }
    targetPaths.add(targetKey);
    const targetInfo = await exists(target);
    if (!targetInfo) {
      plan.push({ source, target, action: "move", file });
      continue;
    }
    if (!targetInfo.isFile() || targetInfo.isSymbolicLink()) {
      throw archiveError(409, `电脑上的文件 ${file.path} 类型冲突，未覆盖任何内容`);
    }
    const targetHash = await sha256File(target);
    if (targetHash.size === file.size && targetHash.sha256 === file.sha256) {
      alreadyPresentCount += 1;
      plan.push({ source, target, action: "skip", file });
      continue;
    }
    const extension = path.extname(relativeName).toLowerCase();
    if (extension === ".png" || relativeName.toLowerCase() === "info.json") {
      throw archiveError(409, `电脑上已有同名但内容不同的资料文件 ${file.path}；为避免丢弃新 JSON 或封面，未确认本批归档`);
    }
    throw archiveError(409, `电脑上已有同名但内容不同的视频 ${file.path}，未覆盖任何内容`);
  }

  for (const code of codes) await mkdir(path.join(root, code), { recursive: true });
  for (const item of plan) {
    if (item.action === "move") await rename(item.source, item.target);
    else await rm(item.source, { force: true });
  }
  return { alreadyPresentCount, preservedSidecarCount, addedFileCount: plan.filter(item => item.action === "move").length,
    files: plan.map(item => ({
      source: item.file.source || "han1",
      sourceId: String(item.file.sourceId || item.file.path.split("/")[0]),
      taskId: item.file.taskId || "",
      role: item.file.role || (MEDIA_EXTENSIONS.has(path.extname(item.file.path).toLowerCase()) ? "media" : path.extname(item.file.path).toLowerCase() === ".png" ? "cover" : "metadata"),
      relativePath: item.file.path,
      filename: path.basename(item.target),
      size: item.file.size,
      sha256: item.file.sha256,
      state: "saved"
    })) };
}

async function commitFilesSerially(root, staging, codes, extractedFiles) {
  let release;
  const previous = commitTail;
  commitTail = new Promise(resolve => { release = resolve; });
  await previous;
  try { return await commitFiles(root, staging, codes, extractedFiles); }
  finally { release(); }
}

async function saveRequestBody(request, destination, maximumBytes) {
  const output = createWriteStream(destination, { flags: "wx" });
  let bytes = 0;
  const limiter = new Transform({
    transform(chunk, _encoding, callback) {
      bytes += chunk.length;
      if (bytes > maximumBytes) callback(archiveError(413, "上传归档超过 64 GiB 限制"));
      else callback(null, chunk);
    },
  });
  await pipeline(request, limiter, output);
  if (bytes === 0) throw archiveError(400, "上传归档为空");
  return bytes;
}

export async function receiveHan1meArchive(request, configuredRoot, { expectedTransferId = "", expectedFiles = null } = {}) {
  if (!configuredRoot) throw archiveError(503, "Han1me 视频目录未配置");
  const root = path.resolve(configuredRoot);
  await mkdir(root, { recursive: true });
  const rootReal = await realpath(root);
  const rootInfo = await stat(rootReal);
  if (!rootInfo.isDirectory()) throw archiveError(503, "Han1me 视频目录不可用");
  const tempRoot = await mkdtemp(path.join(path.dirname(rootReal), ".han1me-archive-"));
  const zipPath = path.join(tempRoot, "archive.zip");
  const stagingRoot = path.join(tempRoot, "files");
  await mkdir(stagingRoot);
  let zip;
  try {
    const archiveBytes = await saveRequestBody(request, zipPath, MAX_ARCHIVE_BYTES);
    zip = await openZip(zipPath);
    const seenPaths = new Set();
    const seenWindowsPaths = new Set();
    const archiveEntries = [];
    let totalUncompressedBytes = 0;
    await new Promise((resolve, reject) => {
      let entryCount = 0;
      let settled = false;
      const fail = error => { if (!settled) { settled = true; reject(error); } };
      zip.on("error", fail);
      zip.once("end", () => { if (!settled) { settled = true; resolve(); } });
      zip.on("entry", entry => {
        (async () => {
          entryCount += 1;
          if (entryCount > MAX_ENTRY_COUNT) throw archiveError(413, "归档文件数量超过限制");
          const safe = safeArchivePath(entry.fileName);
          const windowsPath = entry.fileName.toLocaleLowerCase("en-US");
          if (!safe || seenPaths.has(entry.fileName) || seenWindowsPaths.has(windowsPath) || entry.fileName.endsWith("/")) {
            throw archiveError(400, "归档包含不允许的路径或重复文件");
          }
          seenPaths.add(entry.fileName);
          seenWindowsPaths.add(windowsPath);
          if (entry.uncompressedSize > MAX_UNCOMPRESSED_BYTES - totalUncompressedBytes) throw archiveError(413, "归档解压后的数据超过大小限制");
          totalUncompressedBytes += entry.uncompressedSize;
          if (safe.manifest && entry.uncompressedSize > MAX_MANIFEST_BYTES) throw archiveError(413, "归档清单超过大小限制");
          const unixMode = (entry.externalFileAttributes >>> 16) & 0xffff;
          if ((unixMode & 0o170000) === 0o120000) throw archiveError(400, "归档不能包含符号链接");
          archiveEntries.push({ entry, safe });
          zip.readEntry();
        })().catch(fail);
      });
      zip.readEntry();
    });
    const manifestArchiveEntry = archiveEntries.find(({ safe }) => safe.manifest)?.entry;
    if (!manifestArchiveEntry) throw archiveError(400, "归档缺少 manifest.json");
    const manifestText = await readSmallEntry(zip, manifestArchiveEntry, MAX_MANIFEST_BYTES);
    let manifest;
    try { manifest = JSON.parse(manifestText); }
    catch { throw archiveError(400, "manifest.json 不是有效 JSON"); }
    if (expectedTransferId && (manifest.version !== 2 || manifest.transferId !== expectedTransferId)) {
      throw archiveError(409, "ZIP 清单未绑定当前 v2 传输任务");
    }
    if (Array.isArray(expectedFiles)) {
      const incoming = new Map(manifest.files.map(file => [`${file.source}\u0000${file.sourceId}\u0000${file.role}\u0000${file.path}\u0000${file.size}\u0000${file.sha256}`, file]));
      if (incoming.size !== expectedFiles.length || expectedFiles.some(file =>
          !incoming.has(`${file.source}\u0000${file.sourceId}\u0000${file.role}\u0000${file.relativePath}\u0000${file.size}\u0000${file.sha256}`))) {
        throw archiveError(409, "ZIP 文件集合与冻结的传输批次不同");
      }
    }
    const payloadEntries = archiveEntries.filter(({ safe }) => !safe.manifest);
    const codes = validateManifest(manifest, payloadEntries.map(({ entry }) => ({
      path: entry.fileName,
      size: entry.uncompressedSize,
    })), { compareHashes: false });
    const extractedFiles = [];
    const extractedLimits = { total: 0 };
    for (const { entry, safe } of payloadEntries) {
      const destination = path.join(stagingRoot, safe.code, safe.filename);
      extractedFiles.push(await extractEntry(zip, entry, destination, extractedLimits));
    }
    validateManifest(manifest, extractedFiles);
    const manifestFiles = new Map(manifest.files.map(file => [file.path, file]));
    for (const file of extractedFiles) Object.assign(file, manifestFiles.get(file.path) || {});
    await mkdir(rootReal, { recursive: true });
    const committed = await commitFilesSerially(rootReal, stagingRoot, codes, extractedFiles);
    return {
      ok: true,
      manifestVersion: manifest.version,
      transferId: manifest.version === 2 ? manifest.transferId : "",
      codes,
      codeCount: codes.length,
      archiveBytes,
      fileCount: extractedFiles.length,
      ...committed,
    };
  } catch (error) {
    if (error.statusCode) throw error;
    throw archiveError(400, `归档校验或解压失败：${String(error.code || error.message).slice(0, 180)}`);
  } finally {
    zip?.close();
    await rm(tempRoot, { recursive: true, force: true });
  }
}
