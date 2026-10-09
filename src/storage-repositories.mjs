import { access, realpath, stat, constants } from "node:fs/promises";
import path from "node:path";

const VALID_SOURCES = new Set(["iwara", "han1", "other"]);
const VALID_ROLES = new Set(["scan", "serve", "receive", "download"]);
const WINDOWS_ROOT_RE = /^[a-z]:\\?$/i;

function uniquePath(values) {
  const seen = new Set();
  return values.filter(value => {
    if (!value) return false;
    const key = path.resolve(value).toLocaleLowerCase("en-US");
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function legacyEntry(id, name, root, source, roles, priority, minimumFreeBytes = 0) {
  if (!String(root || "").trim()) return null;
  return { id, name, path: path.resolve(root), source, enabled: true, roles, priority, minimumFreeBytes };
}

export function repositoriesFromLegacyConfig(config) {
  const entries = [];
  entries.push(legacyEntry("iwara-primary", "Iwara 主仓库", config.downloadRoot, "iwara", ["download", "scan", "serve"], 10, Number(config.downloadMinimumFreeBytes) || 0));
  entries.push(legacyEntry("iwara-fallback", "Iwara 备用仓库", config.fallbackDownloadRoot, "iwara", ["download", "scan", "serve"], 20, Number(config.downloadMinimumFreeBytes) || 0));
  const hanRoots = uniquePath([...(config.han1meHistoryRoots || []), config.han1meDownloadRoot]);
  let hanHistoryIndex = 0;
  let mediaIndex = 0;
  for (const root of uniquePath(config.externalMediaRoots || [])) {
    if (hanRoots.some(hanRoot => path.resolve(hanRoot).toLocaleLowerCase("en-US") === path.resolve(root).toLocaleLowerCase("en-US"))) continue;
    if ([config.downloadRoot, config.fallbackDownloadRoot].some(known => known && path.resolve(known).toLocaleLowerCase("en-US") === path.resolve(root).toLocaleLowerCase("en-US"))) continue;
    const name = /han.?ime/i.test(path.basename(root));
    entries.push(legacyEntry(name ? `han-history-${++hanHistoryIndex}` : `media-${++mediaIndex}`, name ? "Han 扫描仓库" : "媒体扫描仓库", root, name ? "han1" : "iwara", ["scan", "serve"], 30 + entries.length));
  }
  for (const root of hanRoots) {
    const receiving = config.han1meDownloadRoot && path.resolve(root).toLocaleLowerCase("en-US") === path.resolve(config.han1meDownloadRoot).toLocaleLowerCase("en-US");
    if (receiving) continue;
    entries.push(legacyEntry(`han-history-${++hanHistoryIndex}`, "Han 历史仓库", root, "han1", ["scan", "serve"], 40 + entries.length));
  }
  entries.push(legacyEntry("han-receive", "Han 接收仓库", config.han1meDownloadRoot, "han1", ["receive", "scan", "serve"], 5, Number(config.downloadMinimumFreeBytes) || 0));
  return entries.filter(Boolean);
}

export function normalizeStorageRepositories(config) {
  const source = Array.isArray(config.storageRepositories) && config.storageRepositories.length
    ? config.storageRepositories
    : repositoriesFromLegacyConfig(config);
  const seenIds = new Set();
  return source.map((item, index) => {
    const id = String(item.id || "").trim();
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(id) || seenIds.has(id)) throw new Error("仓库 ID 无效或重复");
    seenIds.add(id);
    const roles = [...new Set(Array.isArray(item.roles) ? item.roles.map(String) : [])];
    if (roles.some(role => !VALID_ROLES.has(role))) throw new Error(`仓库 ${item.name || id} 包含未知角色`);
    const sourceName = String(item.source || "").trim().toLowerCase();
    if (!VALID_SOURCES.has(sourceName)) throw new Error(`仓库 ${item.name || id} 的来源无效`);
    const root = String(item.path || "").trim();
    if (!root) throw new Error(`仓库 ${item.name || id} 缺少路径`);
    const resolved = path.resolve(root);
    if (WINDOWS_ROOT_RE.test(resolved)) throw new Error(`仓库 ${item.name || id} 不能指向盘符根目录`);
    const reserve = Number(item.minimumFreeBytes ?? 0);
    if (!Number.isSafeInteger(reserve) || reserve < 0) throw new Error(`仓库 ${item.name || id} 的剩余空间限制无效`);
    if ((roles.includes("download") || roles.includes("receive")) &&
        (!roles.includes("scan") || !roles.includes("serve"))) {
      throw new Error(`仓库 ${item.name || id} 用于下载或接收时必须同时启用扫描和媒体提供`);
    }
    const priority = Number(item.priority ?? index * 10);
    if (!Number.isSafeInteger(priority) || priority < 0) throw new Error(`仓库 ${item.name || id} 的优先级无效`);
    return {
      id,
      name: String(item.name || id).trim().slice(0, 100),
      path: resolved,
      source: sourceName,
      enabled: item.enabled !== false,
      roles,
      priority,
      minimumFreeBytes: reserve,
    };
  }).sort((a, b) => a.priority - b.priority || a.id.localeCompare(b.id));
}

export function repositoryRevision(repositories) {
  const normalized = normalizeStorageRepositories({ storageRepositories: repositories });
  return normalized.map(({ id, name, path: root, source, enabled, roles, priority, minimumFreeBytes }) =>
    [id, name, root.toLocaleLowerCase("en-US"), source, enabled, [...roles].sort(), priority, minimumFreeBytes]);
}

export async function validateStorageRepositories(repositories) {
  const normalized = normalizeStorageRepositories({ storageRepositories: repositories });
  const active = normalized.filter(repository => repository.enabled);
  if (!active.length) throw new Error("至少启用一个仓库");
  const paths = new Map();
  const canonicalPaths = new Map();
  for (const repository of active) {
    const pathKey = repository.path.toLocaleLowerCase("en-US");
    const prior = paths.get(pathKey);
    if (prior) throw new Error(`仓库路径重复：${repository.name} 与 ${prior.name}`);
    paths.set(pathKey, repository);
    let canonical;
    try { canonical = await realpath(repository.path); }
    catch { throw new Error(`仓库路径不存在或不可访问：${repository.name}`); }
    const info = await stat(canonical);
    if (!info.isDirectory()) throw new Error(`仓库不是目录：${repository.name}`);
    const canonicalKey = path.resolve(canonical).toLocaleLowerCase("en-US");
    const canonicalPrior = canonicalPaths.get(canonicalKey);
    if (canonicalPrior) throw new Error(`两个仓库实际指向同一目录：${repository.name} 与 ${canonicalPrior.name}`);
    canonicalPaths.set(canonicalKey, repository);
    const requireRead = repository.roles.includes("scan") || repository.roles.includes("serve");
    const requireWrite = repository.roles.includes("download") || repository.roles.includes("receive");
    await access(canonical, requireRead && requireWrite
      ? constants.R_OK | constants.W_OK
      : requireWrite ? constants.W_OK : constants.R_OK);
  }
  for (let i = 0; i < active.length; i++) {
    for (let j = i + 1; j < active.length; j++) {
      const left = active[i]; const right = active[j];
      const nested = left.path.toLocaleLowerCase("en-US").startsWith(right.path.toLocaleLowerCase("en-US") + path.sep) ||
        right.path.toLocaleLowerCase("en-US").startsWith(left.path.toLocaleLowerCase("en-US") + path.sep);
      if (nested && left.source === right.source &&
          (left.roles.includes("receive") || right.roles.includes("receive"))) {
        throw new Error(`同一来源的嵌套接收仓库存在歧义：${left.name} 与 ${right.name}`);
      }
    }
  }
  return normalized;
}

export function repositoryOwnsPath(repositories, filePath, requiredRole = "scan") {
  const file = path.resolve(filePath).toLocaleLowerCase("en-US");
  return normalizeStorageRepositories({ storageRepositories: repositories })
    .filter(repository => repository.enabled && repository.roles.includes(requiredRole))
    .filter(repository => {
      const root = repository.path.toLocaleLowerCase("en-US");
      const relative = path.relative(root, file);
      return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
    })
    .sort((a, b) => b.path.length - a.path.length || a.priority - b.priority)[0] || null;
}

export function applyRepositoriesToLegacyConfig(config, repositories) {
  const allRepositories = normalizeStorageRepositories({ storageRepositories: repositories });
  const active = allRepositories.filter(repository => repository.enabled);
  const downloads = active.filter(repository => repository.source === "iwara" && repository.roles.includes("download"));
  const receive = active.filter(repository => repository.source === "han1" && repository.roles.includes("receive"));
  const hanRoots = active.filter(repository => repository.source === "han1" && repository.roles.includes("scan"));
  const primary = downloads[0]?.path || config.downloadRoot;
  const fallback = downloads.find(repository => repository.path !== primary)?.path || "";
  const receiveRoot = receive[0]?.path || "";
  const mediaRoots = active.filter(repository => repository.roles.includes("scan") || repository.roles.includes("serve"))
    .map(repository => repository.path);
  return {
    ...config,
    // Keep disabled entries in the durable configuration so they can be
    // re-enabled later without reconstructing their settings.
    storageRepositories: allRepositories,
    downloadRoot: primary,
    fallbackDownloadRoot: fallback,
    externalMediaRoots: uniquePath(mediaRoots.filter(root => path.resolve(root).toLocaleLowerCase("en-US") !== path.resolve(primary).toLocaleLowerCase("en-US"))),
    han1meDownloadRoot: receiveRoot,
    han1meHistoryRoots: uniquePath(hanRoots.map(repository => repository.path)),
  };
}
