const HAN1_PLATFORM = new Set(["han1meview", "han1me", "hanime"]);
const LOCAL_PLATFORM = new Set(["local", "local_import", "local-import"]);

export function classifyMediaSource(task = {}) {
  const platform = String(task.sourcePlatform || "").trim().toLocaleLowerCase();
  const videoId = String(task.videoId || "").trim().toLocaleLowerCase();
  if (HAN1_PLATFORM.has(platform) || videoId.startsWith("han1meview-")) return "han1";
  if (platform === "iwara" || platform === "iwara.tv") return "iwara";
  if (task.localOnly || LOCAL_PLATFORM.has(platform) || videoId.startsWith("local-")) return "other";
  try {
    const source = new URL(String(task.sourcePage || ""));
    if ((source.hostname === "iwara.tv" || source.hostname.endsWith(".iwara.tv"))
      && /^\/video\//i.test(source.pathname)) return "iwara";
  } catch {}
  return "other";
}

export function normalizeMediaSource(value) {
  return value === "iwara" || value === "han1" ? value : "all";
}
