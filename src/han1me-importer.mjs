import { createHash, randomUUID } from "node:crypto";
import { lstat, readFile, readdir, realpath, rename, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { fullFingerprint, sampleFingerprint } from "./mobile-library.mjs";
import { downloadFilterMessage, extractDownloadFilterIds, matchesDownloadFilter } from "./download-filter.mjs";

const MEDIA_EXTENSIONS = new Set([".mp4", ".webm", ".mkv", ".mov", ".avi", ".m4v"]);
const MIN_MEDIA_BYTES = 65_536;
const MAX_INFO_JSON_BYTES = 2 * 1024 * 1024;

async function walkMediaFiles(root) {
  const files = [];
  const pending = [root];
  while (pending.length) {
    const directory = pending.pop();
    let entries;
    try { entries = await readdir(directory, { withFileTypes: true }); }
    catch (error) { if (["ENOENT", "ENOTDIR"].includes(error.code)) continue; throw error; }
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) pending.push(file);
      else if (entry.isFile() && MEDIA_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) files.push(file);
    }
  }
  return files;
}

function inside(root, file) {
  const relative = path.relative(root, file);
  return Boolean(relative) && !relative.startsWith("..") && !path.isAbsolute(relative);
}

function cleanText(value, maxLength = 500) {
  if (typeof value !== "string") return "";
  return value.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, maxLength);
}

function cleanUploadTime(value) {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const text = String(value).trim();
  return text && Number.isFinite(Date.parse(text)) ? text.slice(0, 80) : null;
}

function cleanViews(value) {
  if (value == null || value === "") return null;
  const number = typeof value === "string" ? Number(value.replace(/[,\s]/g, "")) : Number(value);
  return Number.isSafeInteger(number) && number >= 0 ? number : null;
}

function parseInfoJson(data) {
  const title = cleanText(data?.title) || cleanText(data?.chineseTitle);
  const artist = data?.artist;
  const author = cleanText(typeof artist === "string" ? artist : artist?.name)
    || cleanText(typeof data?.author === "string" ? data.author : data?.author?.name)
    || cleanText(typeof data?.uploader === "string" ? data.uploader : data?.uploader?.name);
  const rawTags = Array.isArray(data?.tags) ? data.tags : typeof data?.tags === "string" ? data.tags.split(/[,，、]/) : [];
  const tags = [...new Set(rawTags.map(tag => cleanText(tag, 120)).filter(Boolean))].slice(0, 100);
  const views = cleanViews(data?.views ?? data?.viewCount ?? data?.playCount);
  const uploadTime = cleanUploadTime(data?.uploadTime ?? data?.uploadDate);
  const folderId = path.basename(path.dirname(data?.__sidecarPath || ""));
  const sourceId = [data?.id, data?.videoId, folderId]
    .map(value => cleanText(String(value ?? ""), 80))
    .find(value => /^\d{1,30}$/.test(value)) || "";
  return {
    title, author, uploadTime, tags, views, sourceId, pixivIds: extractDownloadFilterIds(data).pixiv,
    sidecarFields: {
      title: Boolean(title), author: Boolean(author), uploadTime: Boolean(uploadTime),
      tags: Array.isArray(data?.tags) || typeof data?.tags === "string",
      views: views != null, sourceId: Boolean(sourceId)
    }
  };
}

async function metadataFor(file, root) {
  const baseName = path.parse(file).name;
  const authorPrefix = /^\[([^\]]{1,100})\]\s*/.exec(baseName)?.[1]?.trim() || "";
  const fallbackTitle = baseName
    .replace(/(?:[_\s-]+)(?:source|480p|540p|720p|1080p|1440p|2160p|2k|4k)$/i, "")
    .trim() || baseName;
  const relativeDirectory = path.relative(root, path.dirname(file));
  const relativeDirectories = relativeDirectory.split(/[\\/]/).filter(Boolean);
  const folderAuthor = relativeDirectories.find(part => !/^\d+$/.test(part)) || "";
  const folderId = path.basename(path.dirname(file));
  const inferredAuthor = authorPrefix || folderAuthor;
  const fallback = { title: fallbackTitle, author: inferredAuthor, authorSource: authorPrefix ? "filename_prefix" : folderAuthor ? "folder_name" : "", uploadTime: null, tags: [], views: null, pixivIds: [],
    sourceId: /^\d{1,30}$/.test(folderId) ? folderId : "", sidecarFound: false };
  const infoPath = path.join(path.dirname(file), "info.json");
  try {
    const safeInfoPath = await realpath(infoPath);
    if (!inside(root, safeInfoPath)) return fallback;
    const infoStat = await stat(safeInfoPath);
    if (!infoStat.isFile() || infoStat.size > MAX_INFO_JSON_BYTES) return fallback;
    const data = JSON.parse(await readFile(safeInfoPath, "utf8"));
    const parsed = parseInfoJson({ ...data, __sidecarPath: safeInfoPath });
    return {
      ...fallback,
      title: parsed.title || fallback.title,
      author: parsed.author || fallback.author,
      authorSource: parsed.author ? "info_json" : fallback.authorSource,
      uploadTime: parsed.uploadTime,
      tags: parsed.tags,
      views: parsed.views,
      pixivIds: parsed.pixivIds,
      sourceId: parsed.sourceId || fallback.sourceId,
      sidecarFields: parsed.sidecarFields,
      sidecarFound: true,
      sidecarUpdatedAt: infoStat.mtime.toISOString()
    };
  } catch (error) {
    if (["ENOENT", "ENOTDIR"].includes(error.code)) return fallback;
    return { ...fallback, sidecarError: String(error.code || error.message).slice(0, 180) };
  }
}

function missingMetadata(task) {
  return !task.title || !task.author || !task.uploadTime || !Array.isArray(task.tags) || task.tags.length === 0 ||
    (Array.isArray(task.tags) && task.tags.length > 0 && !task.tagsUpdatedAt) ||
    (task.views == null && task.viewCount == null);
}

async function videoCodeForFile(file, root) {
  let directory = path.dirname(file);
  let code = "";
  while (inside(root, directory)) {
    const folderCode = path.basename(directory);
    if (/^\d{1,30}$/.test(folderCode)) code = folderCode;
    directory = path.dirname(directory);
  }
  return code || (await metadataFor(file, root)).sourceId || "";
}

function applyMissingMetadata(task, metadata) {
  let changed = false;
  if (!task.title && metadata.title) { task.title = metadata.title; changed = true; }
  if (!task.author && metadata.author) { task.author = metadata.author; changed = true; }
  if (!task.uploadTime && metadata.uploadTime) { task.uploadTime = metadata.uploadTime; changed = true; }
  if (metadata.tags.length) {
    const currentTags = Array.isArray(task.tags) ? task.tags.map(tag => String(tag?.name ?? tag?.title ?? tag?.label ?? tag ?? "").trim()).filter(Boolean) : [];
    if (!currentTags.length) {
      task.tags = metadata.tags;
      changed = true;
    }
    const sourceTags = new Set(metadata.tags);
    const sameTags = currentTags.length === sourceTags.size && currentTags.every(tag => sourceTags.has(tag));
    if (!task.tagsUpdatedAt && metadata.sidecarUpdatedAt && (!currentTags.length || sameTags)) {
      task.tagsUpdatedAt = metadata.sidecarUpdatedAt;
      task.tagsSource = "han1me_info_json";
      changed = true;
    }
  }
  if (task.views == null && task.viewCount == null && metadata.views != null) {
    task.views = metadata.views;
    task.viewCount = metadata.views;
    if (metadata.sidecarUpdatedAt) task.viewsUpdatedAt = metadata.sidecarUpdatedAt;
    changed = true;
  }
  return changed;
}

function mergeDuplicateMetadata(task, metadata) {
  let changed = false;
  const supplied = metadata.sidecarFields || {};
  if (supplied.title && metadata.title && task.title !== metadata.title) { task.title = metadata.title; changed = true; }
  if ((supplied.author || ["", "本地导入", "未知作者"].includes(String(task.author || "").trim())) && metadata.author && task.author !== metadata.author) {
    task.author = metadata.author;
    changed = true;
  }
  if (supplied.uploadTime && metadata.uploadTime && task.uploadTime !== metadata.uploadTime) { task.uploadTime = metadata.uploadTime; changed = true; }
  if (supplied.tags && metadata.tags.length) {
    const currentTags = Array.isArray(task.tags) ? task.tags.map(tag => String(tag?.name ?? tag?.title ?? tag?.label ?? tag ?? "").trim()).filter(Boolean) : [];
    if (JSON.stringify(currentTags) !== JSON.stringify(metadata.tags)) { task.tags = metadata.tags; changed = true; }
    if (metadata.sidecarUpdatedAt && task.tagsUpdatedAt !== metadata.sidecarUpdatedAt) {
      task.tagsUpdatedAt = metadata.sidecarUpdatedAt;
      task.tagsSource = "han1me_info_json";
      changed = true;
    }
  }
  if (supplied.views && metadata.views != null && (task.views !== metadata.views || task.viewCount !== metadata.views)) {
    task.views = metadata.views;
    task.viewCount = metadata.views;
    if (metadata.sidecarUpdatedAt) task.viewsUpdatedAt = metadata.sidecarUpdatedAt;
    changed = true;
  }
  return changed;
}

function sidecarMetadataMessage(metadata) {
  if (!metadata.sidecarFound) {
    return `Han1me 本地文件导入；${metadata.sidecarError ? `info.json 读取失败（${metadata.sidecarError}），` : "未找到 info.json，"}标题和作者由文件名/目录名推定，上传日期、标签和播放量未提供`;
  }
  const fields = metadata.sidecarFields || {};
  const read = [];
  if (fields.sourceId) read.push("视频编号");
  if (fields.title) read.push("标题");
  if (fields.author) read.push("作者");
  if (fields.uploadTime) read.push("上传日期");
  if (fields.tags && metadata.tags.length) read.push("标签");
  if (fields.views) read.push("播放量");
  if (!fields.author && metadata.author) read.push(`作者由${metadata.authorSource === "filename_prefix" ? "文件名前缀" : "文件夹名"}推定`);
  const missing = [];
  if (!fields.author && !metadata.author) missing.push("作者");
  if (!fields.uploadTime) missing.push("上传日期");
  if (!fields.tags || !metadata.tags.length) missing.push("标签");
  if (!fields.views) missing.push("播放量");
  return `已从同目录 info.json 读取：${read.join("、") || "未发现可用资料"}${missing.length ? `；JSON 未提供${missing.join("、")}` : ""}`;
}

export class Han1meImporter {
  constructor({ store, mobileLibrary, root, roots = [], historyRoots = [], onImported = () => {}, bytesPerSecond = 32 * 1024 * 1024,
    scanIntervalMs = 15_000, stabilityMs = 15_000, minBytes = MIN_MEDIA_BYTES, onError = console.warn, downloadFilter = {} }) {
    this.store = store;
    this.mobileLibrary = mobileLibrary;
    const configuredRoots = [root, ...(Array.isArray(roots) ? roots : []), ...(Array.isArray(historyRoots) ? historyRoots : [])]
      .filter(value => typeof value === "string" && value.trim())
      .map(value => path.resolve(value));
    this.roots = [...new Map(configuredRoots.map(value => [value.toLocaleLowerCase(), value])).values()];
    // Keep `root` as the primary destination for the existing archive-upload API.
    this.root = this.roots[0] || "";
    this.onImported = onImported;
    this.bytesPerSecond = bytesPerSecond;
    this.scanIntervalMs = scanIntervalMs;
    this.stabilityMs = stabilityMs;
    this.minBytes = minBytes;
    this.onError = onError;
    this.downloadFilter = downloadFilter;
    this.observed = new Map();
    this.pending = null;
    this.controller = null;
    this.closed = false;
    this.timer = null;
    this.state = { running: false, rootAvailable: false, availableRootCount: 0,
      roots: this.roots.map(rootPath => ({ path: rootPath, available: false })),
      lastScanAt: null, imported: 0, relinked: 0, merged: 0, metadataUpdated: 0, duplicates: 0,
      filtered: 0, ambiguous: 0, pendingFiles: 0, failed: 0, current: "", issues: [] };
  }

  status() {
    return { enabled: this.roots.length > 0, rootCount: this.roots.length, ...this.state,
      roots: this.state.roots.map(item => ({ ...item })), issues: this.state.issues.slice(-10) };
  }

  async mediaRoots() {
    if (!this.roots.length) throw new Error("Han1me 视频目录未配置");
    const available = [];
    const unavailable = [];
    for (const configuredRoot of this.roots) {
      try {
        const resolvedRoot = await realpath(configuredRoot);
        if (!(await stat(resolvedRoot)).isDirectory()) {
          unavailable.push(path.basename(configuredRoot));
          continue;
        }
        if (!available.some(rootPath => rootPath.toLocaleLowerCase() === resolvedRoot.toLocaleLowerCase())) {
          available.push(resolvedRoot);
        }
      } catch (error) {
        if (!["ENOENT", "ENOTDIR"].includes(error.code)) throw error;
        unavailable.push(path.basename(configuredRoot));
      }
    }
    if (unavailable.length) {
      throw new Error(`Han1me 同步目录不完整或不可用：${[...new Set(unavailable)].join("、")}`);
    }
    if (!available.length) throw new Error("所有 Han1me 视频目录当前都不可用");
    return available;
  }

  async mediaFilesByRoot() {
    const roots = await this.mediaRoots();
    const result = [];
    for (const rootPath of roots) result.push({ root: rootPath, files: await walkMediaFiles(rootPath) });
    return result;
  }

  async downloadCodes() {
    const rootFiles = await this.mediaFilesByRoot();
    const codes = new Set();
    let videoFileCount = 0;

    for (const { root, files } of rootFiles) {
      for (const file of files) {
        let info;
        try { info = await stat(file); }
        catch (error) { if (error.code === "ENOENT") continue; throw error; }
        if (!info.isFile() || info.size < this.minBytes) continue;
        videoFileCount += 1;
        const code = await videoCodeForFile(file, root);
        if (/^\d{1,30}$/.test(code)) codes.add(code);
      }
    }

    return {
      codes: [...codes].sort((left, right) => left.localeCompare(right, "en", { numeric: true })),
      codeCount: codes.size,
      videoFileCount,
      generatedAt: new Date().toISOString()
    };
  }

  async missingViewCountCodes() {
    const rootFiles = await this.mediaFilesByRoot();
    const candidates = new Map();
    for (const { root, files } of rootFiles) {
      for (const file of files) {
        const code = await videoCodeForFile(file, root);
        if (!/^\d{1,30}$/.test(code) || candidates.has(code)) continue;
        candidates.set(code, { file, root });
      }
    }

    const codes = [];
    for (const [code, { file, root }] of candidates) {
      const metadata = await metadataFor(file, root);
      if (metadata.views == null) codes.push(code);
    }
    return codes.sort((left, right) => left.localeCompare(right, "en", { numeric: true }));
  }

  async missingVideoMetadataCodes() {
    const rootFiles = await this.mediaFilesByRoot();
    const candidates = new Map();
    for (const { root, files } of rootFiles) {
      for (const file of files) {
        const code = await videoCodeForFile(file, root);
        if (!/^\d{1,30}$/.test(code) || candidates.has(code)) continue;
        candidates.set(code, { file, root });
      }
    }

    const codes = [];
    for (const [code, { file, root }] of candidates) {
      const metadata = await metadataFor(file, root);
      // Only an author stored in info.json is authoritative. Filename/folder
      // guesses remain useful for display, but must not suppress a real lookup.
      if (metadata.authorSource !== "info_json" || !metadata.uploadTime || !metadata.tags.length) codes.push(code);
    }
    return codes.sort((left, right) => left.localeCompare(right, "en", { numeric: true }));
  }

  async applyVideoMetadata(entries) {
    if (!Array.isArray(entries) || entries.length > 1000) throw new Error("视频元数据回填请求格式无效或数量过多");
    const roots = await this.mediaRoots();
    const updates = new Map();
    for (const entry of entries) {
      const code = String(entry?.code ?? "");
      if (!/^\d{1,30}$/.test(code)) throw new Error("视频元数据回填包含无效的视频编号");
      const author = cleanText(entry?.author, 300);
      const uploadTime = cleanUploadTime(entry?.uploadTime);
      if (entry?.uploadTime != null && entry.uploadTime !== "" && !uploadTime) {
        throw new Error("视频元数据回填包含无效的上传日期");
      }
      if (entry?.tags != null && !Array.isArray(entry.tags)) throw new Error("视频元数据标签格式无效");
      const tags = [...new Set((entry?.tags || []).map(tag => cleanText(tag, 120)).filter(Boolean))].slice(0, 100);
      if (!author && !uploadTime && !tags.length) throw new Error("视频元数据回填没有可用字段");
      updates.set(code, { author, uploadTime, tags });
    }

    const updatedCodes = [];
    const skippedCodes = [];
    for (const [code, incoming] of updates) {
      let changedInAnyRoot = false;
      for (const root of roots) {
        const directory = path.join(root, code);
        let safeDirectory;
        try { safeDirectory = await realpath(directory); }
        catch (error) {
          if (["ENOENT", "ENOTDIR"].includes(error.code)) continue;
          throw error;
        }
        if (!inside(root, safeDirectory) || safeDirectory !== path.resolve(directory)) continue;

        const infoPath = path.join(safeDirectory, "info.json");
        let info;
        try {
          const entry = await lstat(infoPath);
          if (!entry.isFile() || entry.size > MAX_INFO_JSON_BYTES) continue;
          const safeInfoPath = await realpath(infoPath);
          if (!inside(root, safeInfoPath)) continue;
          info = JSON.parse(await readFile(safeInfoPath, "utf8"));
          if (!info || typeof info !== "object" || Array.isArray(info)) continue;
        } catch (error) {
          if (["ENOENT", "ENOTDIR"].includes(error.code) || error instanceof SyntaxError) continue;
          throw error;
        }

        const current = parseInfoJson(info);
        let changed = false;
        if (!current.author && incoming.author) { info.author = incoming.author; changed = true; }
        if (!current.uploadTime && incoming.uploadTime) { info.uploadTime = incoming.uploadTime; changed = true; }
        if (!current.tags.length && incoming.tags.length) { info.tags = incoming.tags; changed = true; }
        if (!changed) continue;

        info.metadataSource = "han1meview";
        info.metadataUpdatedAt = new Date().toISOString();
        const temporaryPath = path.join(safeDirectory, `.info-${randomUUID()}.tmp`);
        try {
          await writeFile(temporaryPath, `${JSON.stringify(info, null, 2)}\n`, { flag: "wx" });
          await rename(temporaryPath, infoPath);
          changedInAnyRoot = true;
        } finally {
          await unlink(temporaryPath).catch(() => {});
        }
      }
      (changedInAnyRoot ? updatedCodes : skippedCodes).push(code);
    }
    return { updatedCount: updatedCodes.length, skippedCount: skippedCodes.length, updatedCodes, skippedCodes };
  }

  async applyViewCounts(entries) {
    if (!Array.isArray(entries) || entries.length > 1000) throw new Error("播放量回填请求格式无效或数量过多");
    const roots = await this.mediaRoots();
    const updates = new Map();
    for (const entry of entries) {
      const code = String(entry?.code ?? "");
      const views = Number(entry?.views);
      if (!/^\d{1,30}$/.test(code) || !Number.isSafeInteger(views) || views < 0) {
        throw new Error("播放量回填包含无效的视频编号或数值");
      }
      updates.set(code, views);
    }

    const updatedCodes = [];
    const skippedCodes = [];
    for (const [code, views] of updates) {
      let changedInAnyRoot = false;
      for (const root of roots) {
        const directory = path.join(root, code);
        let safeDirectory;
        try { safeDirectory = await realpath(directory); }
        catch (error) {
          if (["ENOENT", "ENOTDIR"].includes(error.code)) continue;
          throw error;
        }
        if (!inside(root, safeDirectory) || safeDirectory !== path.resolve(directory)) continue;

        const infoPath = path.join(safeDirectory, "info.json");
        let info = { id: code, videoId: code, videoCode: code };
        try {
          const entry = await lstat(infoPath);
          if (!entry.isFile() || entry.size > MAX_INFO_JSON_BYTES) continue;
          const safeInfoPath = await realpath(infoPath);
          if (!inside(root, safeInfoPath)) continue;
          info = JSON.parse(await readFile(safeInfoPath, "utf8"));
          if (!info || typeof info !== "object" || Array.isArray(info)) continue;
          if (cleanViews(info.views ?? info.viewCount ?? info.playCount) != null) continue;
        } catch (error) {
          if (error instanceof SyntaxError) continue;
          if (error.code !== "ENOENT" && error.code !== "ENOTDIR") throw error;
        }

        const now = new Date().toISOString();
        info.id ??= code;
        info.videoId ??= code;
        info.videoCode ??= code;
        info.views = views;
        info.viewCount = views;
        info.viewsUpdatedAt = now;
        const temporaryPath = path.join(safeDirectory, `.info-${randomUUID()}.tmp`);
        try {
          await writeFile(temporaryPath, `${JSON.stringify(info, null, 2)}\n`, { flag: "wx" });
          await rename(temporaryPath, infoPath);
          changedInAnyRoot = true;
        } finally {
          await unlink(temporaryPath).catch(() => {});
        }
      }
      (changedInAnyRoot ? updatedCodes : skippedCodes).push(code);
    }
    return { updatedCount: updatedCodes.length, skippedCount: skippedCodes.length, updatedCodes, skippedCodes };
  }

  start() {
    if (!this.roots.length || this.closed || this.timer) return;
    void this.scan();
    this.timer = setInterval(() => void this.scan(), this.scanIntervalMs);
    this.timer.unref?.();
  }

  scan() {
    if (this.closed || !this.roots.length) return Promise.resolve(this.status());
    if (this.pending) return this.pending;
    this.state.running = true;
    this.controller = new AbortController();
    this.pending = this.run(this.controller.signal).catch(error => {
      if (!this.closed) {
        this.state.failed += 1;
        this.state.issues.push(String(error.code || error.message).slice(0, 300));
        this.onError(`[Han1me 导入] ${error.code || error.message}`);
      }
      return this.status();
    }).finally(() => {
      this.state.running = false;
      this.state.current = "";
      this.state.lastScanAt = new Date().toISOString();
      this.pending = null;
      this.controller = null;
    });
    return this.pending;
  }

  async run(signal) {
    const now = Date.now();
    const rootFiles = [];
    const rootStatuses = [];
    for (const configuredRoot of this.roots) {
      try {
        const root = await realpath(configuredRoot);
        const files = await walkMediaFiles(root);
        rootFiles.push({ root, files });
        rootStatuses.push({ path: configuredRoot, available: true, fileCount: files.length });
      } catch (error) {
        if (!["ENOENT", "ENOTDIR"].includes(error.code)) {
          this.state.failed += 1;
          this.state.issues.push(`${path.basename(configuredRoot)}: ${String(error.code || error.message).slice(0, 220)}`);
          this.state.issues = this.state.issues.slice(-10);
          this.onError(`[Han1me 导入] ${path.basename(configuredRoot)}: ${error.code || error.message}`);
        }
        rootStatuses.push({ path: configuredRoot, available: false, fileCount: 0 });
      }
    }
    this.state.roots = rootStatuses;
    this.state.availableRootCount = rootFiles.length;
    this.state.rootAvailable = rootFiles.length === this.roots.length;
    if (!rootFiles.length) { this.state.pendingFiles = 0; return this.status(); }

    const fileEntries = [];
    const currentPaths = new Set();
    for (const { root, files } of rootFiles) {
      for (const file of files) {
        const key = file.toLocaleLowerCase();
        if (currentPaths.has(key)) continue;
        currentPaths.add(key);
        fileEntries.push({ file, root });
      }
    }
    for (const key of this.observed.keys()) if (!currentPaths.has(key)) this.observed.delete(key);
    const taskByPath = new Map(this.store.state.tasks.filter(task => task.destination)
      .map(task => [path.resolve(task.destination).toLocaleLowerCase(), task]));
    const hanTaskByVideoId = new Map(this.store.state.tasks
      .filter(task => task.sourcePlatform === "han1meview" && String(task.videoId || "").startsWith("han1meview-"))
      .map(task => [task.videoId, task]));
    let waiting = 0;
    const candidates = [];
    for (const { file, root } of fileEntries) {
      const resolved = path.resolve(file);
      if (!inside(root, resolved)) continue;
      const folderId = path.basename(path.dirname(resolved));
      const knownTask = taskByPath.get(resolved.toLocaleLowerCase()) ||
        (/^\d{1,30}$/.test(folderId) ? hanTaskByVideoId.get(`han1meview-${folderId}`) : null);
      if (knownTask) {
        if (knownTask.sourcePlatform === "han1meview" && missingMetadata(knownTask)) {
          let info;
          try { info = await stat(resolved); } catch (error) { if (error.code === "ENOENT") continue; throw error; }
          const infoPath = path.join(path.dirname(resolved), "info.json");
          let sidecarSignature = "missing";
          try {
            const sidecarStat = await stat(infoPath);
            sidecarSignature = `${sidecarStat.size}:${sidecarStat.mtimeMs}`;
          } catch (error) {
            if (! ["ENOENT", "ENOTDIR"].includes(error.code)) throw error;
          }
          const signature = `${info.size}:${info.mtimeMs}:${sidecarSignature}`;
          const previous = this.observed.get(resolved.toLocaleLowerCase());
          if (!previous?.handled || previous.signature !== signature) {
            candidates.push({ file: resolved, root, size: info.size, mtimeMs: info.mtimeMs, signature, existingTask: knownTask });
          }
        }
        continue;
      }
      let info;
      try { info = await stat(resolved); }
      catch (error) { if (error.code === "ENOENT") continue; throw error; }
      if (!info.isFile() || info.size < this.minBytes) continue;
      const key = resolved.toLocaleLowerCase();
      const previous = this.observed.get(key);
      if (!previous || previous.size !== info.size || previous.mtimeMs !== info.mtimeMs) {
        this.observed.set(key, { size: info.size, mtimeMs: info.mtimeMs, firstSeenAt: now });
        waiting += 1;
        continue;
      }
      if (previous.handled) continue;
      if (now - previous.firstSeenAt < this.stabilityMs) { waiting += 1; continue; }
      candidates.push({ file: resolved, root, size: info.size, mtimeMs: info.mtimeMs, signature: `${info.size}:${info.mtimeMs}` });
    }
    this.state.pendingFiles = waiting;
    for (const candidate of candidates) {
      if (this.closed || signal.aborted) break;
      this.state.current = path.basename(candidate.file);
      try {
        if (candidate.existingTask) {
          const metadata = await metadataFor(candidate.file, candidate.root);
          if (applyMissingMetadata(candidate.existingTask, metadata)) {
            candidate.existingTask.updatedAt = new Date().toISOString();
            if (metadata.sidecarFound) {
              candidate.existingTask.metadataMessage = metadata.views == null
                ? "已从 Han1me 文件夹 info.json 补齐缺失元数据；来源 JSON 未提供播放量"
                : "已从 Han1me 文件夹 info.json 补齐缺失元数据";
              if (candidate.existingTask.author && candidate.existingTask.uploadTime && candidate.existingTask.tags?.length) {
                candidate.existingTask.metadataStatus = "complete";
              }
            } else if (metadata.authorSource === "filename_prefix") {
              candidate.existingTask.metadataMessage = `未找到 info.json；已从文件名前缀补齐作者「${metadata.author}」，未改动已有资料；上传日期、标签和播放量仍缺失`;
            } else if (metadata.authorSource === "folder_name") {
              candidate.existingTask.metadataMessage = `未找到 info.json；已从所属文件夹补齐作者「${metadata.author}」，未改动已有资料；上传日期、标签和播放量仍缺失`;
            } else if (metadata.sidecarError) {
              candidate.existingTask.metadataMessage = `info.json 读取失败（${metadata.sidecarError}）；仅按已有信息保留记录`;
            }
            await this.store.save();
            this.onImported(candidate.existingTask);
            this.state.metadataUpdated += 1;
          } else if (!metadata.sidecarFound && candidate.existingTask.metadataMessage?.startsWith("已从 Han1me 文件夹 info.json 补齐")) {
            candidate.existingTask.metadataMessage = metadata.sidecarError
              ? `info.json 读取失败（${metadata.sidecarError}）；作者等旧值未验证，缺少的上传日期和标签仍留空`
              : "同目录未找到 info.json；作者按文件名推定，上传日期和标签仍缺失；未伪造播放量";
            await this.store.save();
          }
          this.observed.set(candidate.file.toLocaleLowerCase(), { ...candidate, firstSeenAt: now, handled: true });
          continue;
        }
        const outcome = await this.importFile(candidate.file, candidate.root, candidate, signal);
        if (outcome === "imported") this.state.imported += 1;
        else if (outcome === "relinked") this.state.relinked += 1;
        else if (outcome === "merged") this.state.merged += 1;
        else if (outcome === "duplicate") this.state.duplicates += 1;
        else if (outcome === "filtered") this.state.filtered += 1;
        else if (outcome === "ambiguous") this.state.ambiguous += 1;
        this.observed.set(candidate.file.toLocaleLowerCase(), { ...candidate, firstSeenAt: now, handled: true });
      } catch (error) {
        if (signal.aborted) break;
        this.state.failed += 1;
        this.state.issues.push(`${path.basename(candidate.file)}: ${String(error.code || error.message).slice(0, 220)}`);
        this.state.issues = this.state.issues.slice(-10);
        this.onError(`[Han1me 导入] ${path.basename(candidate.file)}: ${error.code || error.message}`);
      }
    }
    return this.status();
  }

  async mergeDuplicateTask(task, { safePath, fileStat, fingerprint, sample, metadata }) {
    const before = structuredClone(task);
    let metadataChanged = mergeDuplicateMetadata(task, metadata);
    if (metadata.sourceId) {
      const hanVideoId = `han1meview-${metadata.sourceId}`;
      const currentIsLocal = !task.videoId || /^local-/.test(String(task.videoId)) || /^han1meview-local-/.test(String(task.videoId));
      const idConflict = this.store.state.tasks.some(candidate => candidate !== task && candidate.videoId === hanVideoId);
      if (currentIsLocal && !idConflict && task.videoId !== hanVideoId) {
        task.videoId = hanVideoId;
        task.sourcePlatform = "han1meview";
        metadataChanged = true;
      } else if (idConflict && task.han1meId !== metadata.sourceId) {
        task.han1meId = metadata.sourceId;
        metadataChanged = true;
        this.state.issues.push(`${path.basename(safePath)}: Han1me 编号 ${metadata.sourceId} 已被其他台账记录占用，保留原 videoId 并另存 han1meId`);
        this.state.issues = this.state.issues.slice(-10);
      }
    }

    const pathChanged = path.resolve(task.destination || "").toLocaleLowerCase() !== safePath.toLocaleLowerCase();
    task.destination = safePath;
    task.fileStatus = "present";
    task.actualFileSize = String(fileStat.size);
    task.mediaCheckedAt = fileStat.mtime.toISOString();
    if (pathChanged) task.message = "已通过完整 SHA-256 匹配 Han1me 副本；保留原台账任务和完成状态";
    task.metadataMessage = `已按完整文件指纹合并到既有台账（保留原任务、下载状态和观看记录）；${sidecarMetadataMessage(metadata)}`;
    if (metadataChanged || pathChanged || before.metadataMessage !== task.metadataMessage || before.fileStatus !== task.fileStatus) {
      task.updatedAt = new Date().toISOString();
    }

    this.store.db.exec("BEGIN IMMEDIATE");
    try {
      const serialized = this.store.upsertTask(task);
      const identityUpdate = this.store.db.prepare(`
        UPDATE mobile_media_identity SET path=?,size=?,mtime_ms=?,sha256=?,sample_sha256=? WHERE task_id=?
      `).run(safePath, fileStat.size, fileStat.mtimeMs, fingerprint.sha256, sample, task.id);
      if (Number(identityUpdate.changes) !== 1) throw new Error("完整指纹命中但移动端文件身份记录更新失败");
      this.store.db.exec("COMMIT");
      this.store.snapshots.set(task.id, serialized);
    } catch (error) {
      try { this.store.db.exec("ROLLBACK"); } catch { /* keep the original error */ }
      for (const key of Object.keys(task)) delete task[key];
      Object.assign(task, before);
      throw error;
    }
    this.onImported(task);
    return metadataChanged || pathChanged;
  }

  async importFile(file, root, expected, signal) {
    const safePath = await realpath(file);
    if (!inside(root, safePath)) throw new Error("文件不在 Han1me 视频目录内");
    const before = await stat(safePath);
    if (!before.isFile() || before.size < this.minBytes) throw new Error("文件尚未复制完成或不是有效视频");
    if (before.size !== expected.size || before.mtimeMs !== expected.mtimeMs) throw new Error("文件复制过程中仍在变化");
    const metadata = await metadataFor(safePath, root);
    const filterMatch = matchesDownloadFilter({
      videoId: metadata.sourceId ? `han1meview-${metadata.sourceId}` : "",
      sourcePlatform: "han1meview",
      metadata,
      tags: metadata.tags
    }, this.downloadFilter);
    if (filterMatch) {
      this.state.issues.push(`${path.basename(safePath)}: ${downloadFilterMessage(filterMatch)}；未导入播放台账`);
      this.state.issues = this.state.issues.slice(-10);
      return "filtered";
    }
    const sample = await sampleFingerprint(safePath, before.size);
    const after = await stat(safePath);
    if (before.size !== after.size || before.mtimeMs !== after.mtimeMs) {
      throw new Error("指纹计算期间文件发生变化，将在下一轮重试");
    }

    const existingPath = this.store.state.tasks.find(task => task.destination && path.resolve(task.destination).toLocaleLowerCase() === safePath.toLocaleLowerCase());
    if (existingPath) return "existing";
    // A sample collision is only a candidate, never proof of a duplicate.
    // Confirm likely matches with full SHA-256 before declining an import.
    const sampleMatches = this.store.db.prepare("SELECT task_id,path FROM mobile_media_identity WHERE size=? AND sample_sha256=?").all(after.size, sample);
    if (sampleMatches.length) {
      const fingerprint = await fullFingerprint(safePath, { bytesPerSecond: this.bytesPerSecond, signal });
      if (fingerprint.size !== after.size || fingerprint.mtimeMs !== after.mtimeMs) throw new Error("指纹计算期间文件发生变化，将在下一轮重试");
      const exactMatches = sampleMatches.filter(match => this.store.db.prepare("SELECT sha256 FROM mobile_media_identity WHERE task_id=?").get(match.task_id)?.sha256 === fingerprint.sha256);
      if (exactMatches.length > 1) {
        const matchedTasks = exactMatches.map(match => this.store.state.tasks.find(item => item.id === match.task_id)).filter(Boolean);
        let everyRecordAlreadyHasAFile = matchedTasks.length === exactMatches.length;
        for (const matchedTask of matchedTasks) {
          if (!matchedTask.destination) { everyRecordAlreadyHasAFile = false; break; }
          try { if (!(await stat(matchedTask.destination)).isFile()) { everyRecordAlreadyHasAFile = false; break; } }
          catch (error) { if (["ENOENT", "ENOTDIR"].includes(error.code)) { everyRecordAlreadyHasAFile = false; break; } throw error; }
        }
        if (everyRecordAlreadyHasAFile) return "duplicate";
        this.state.issues.push(`${path.basename(safePath)}: 完整指纹对应多个历史记录，保留原记录等待人工确认`);
        this.state.issues = this.state.issues.slice(-10);
        return "ambiguous";
      }
      if (exactMatches.length === 1) {
        const task = this.store.state.tasks.find(item => item.id === exactMatches[0].task_id);
        if (!task) return "duplicate";
        let oldPathExists = false;
        try { oldPathExists = task.destination ? (await stat(task.destination)).isFile() : false; }
        catch (error) { if (error.code !== "ENOENT" && error.code !== "ENOTDIR") throw error; }
        if (oldPathExists) {
          const changed = await this.mergeDuplicateTask(task, { safePath, fileStat: after, fingerprint, sample, metadata });
          return changed ? "merged" : "duplicate";
        }
        task.destination = safePath;
        task.fileStatus = "present";
        task.actualFileSize = String(after.size);
        task.mediaCheckedAt = after.mtime.toISOString();
        task.message = "已通过完整文件指纹在 Han1me 目录重建本地路径，保留原台账记录";
        await this.store.save();
        this.store.db.prepare("UPDATE mobile_media_identity SET path=?,size=?,mtime_ms=?,sample_sha256=? WHERE task_id=?")
          .run(safePath, after.size, after.mtimeMs, sample, task.id);
        this.onImported(task);
        return "relinked";
      }
    }

    const relativePath = path.relative(root, safePath).replace(/\\/g, "/").toLocaleLowerCase();
    const stableKey = createHash("sha256").update(`${relativePath}|${after.size}`).digest("hex").slice(0, 24);
    const videoId = `han1meview-${metadata.sourceId || `local-${stableKey}`}`;
    const existingId = this.store.state.tasks.find(task => task.videoId === videoId);
    if (existingId) return "duplicate";
    const downloadedAt = after.mtime.toISOString();
    const task = {
      id: randomUUID(), videoId, sourcePlatform: "han1meview", sourcePage: "",
      title: metadata.title, author: metadata.author, alias: "", uploadTime: metadata.uploadTime,
      releaseDate: null, tags: metadata.tags, views: metadata.views, viewCount: metadata.views,
      state: "completed", attempts: 0, resolveFailures: 0,
      createdAt: downloadedAt, updatedAt: downloadedAt, completedAt: downloadedAt,
      completedLength: String(after.size), totalLength: String(after.size), actualFileSize: String(after.size),
      destination: safePath, fileStatus: "present", mediaCheckedAt: downloadedAt,
      ...(metadata.tags.length && metadata.sidecarUpdatedAt ? { tagsUpdatedAt: metadata.sidecarUpdatedAt, tagsSource: "han1me_info_json" } : {}),
      ...(metadata.views != null && metadata.sidecarUpdatedAt ? { viewsUpdatedAt: metadata.sidecarUpdatedAt } : {}),
      imported: true, localOnly: true, metadataStatus: "complete", metadataAttempts: 0,
      metadataMessage: sidecarMetadataMessage(metadata),
      message: "复制到 Han1me 视频目录后自动入账", gid: null,
      playbackPosition: 0, playbackDuration: 0, watched: false, favorite: false,
      watchLater: false, discarded: false, queuePosition: null
    };
    this.store.state.tasks.push(task);
    await this.store.save();
    if (!this.mobileLibrary?.enqueueDownload(task)) throw new Error("新台账已保存，但不能排队计算播放指纹；重启服务后会自动补上");
    this.onImported(task);
    return "imported";
  }

  async stop() {
    this.closed = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.controller?.abort();
    await this.pending;
  }
}
