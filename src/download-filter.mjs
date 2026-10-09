const DEFAULT_BLOCKED_TAGS = Object.freeze([
  "futa", "futanari", "fata", "扶她", "扶他", "ふたなり"
]);

function list(value) {
  return Array.isArray(value) ? value : [];
}

function normalized(value) {
  return String(value ?? "").normalize("NFKC").trim().toLocaleLowerCase("en-US");
}

function numericId(value) {
  const text = String(value ?? "").trim();
  if (/^\d{3,30}$/.test(text)) return text;
  const urlMatch = /(?:artworks|illust_id|illust)\/(\d{3,30})/i.exec(text)
    || /[?&](?:illust_id|pixiv_id|id)=(\d{3,30})(?:&|$)/i.exec(text);
  return urlMatch?.[1] || "";
}

function collectTaggedIds(value, result = { han1me: [], pixiv: [] }, depth = 0, context = "") {
  if (!value || typeof value !== "object" || depth > 4) return result;
  if (Array.isArray(value)) {
    for (const item of value.slice(0, 100)) {
      if (context === "pixiv") {
        const id = numericId(item);
        if (id) result.pixiv.push(id);
      }
      collectTaggedIds(item, result, depth + 1, context);
    }
    return result;
  }
  for (const [key, raw] of Object.entries(value).slice(0, 200)) {
    const pixivContext = /pixiv|illustration|illust(?:ration)?[_-]?id|^p[_-]?id$|^pid$/i.test(key);
    if (pixivContext || (context === "pixiv" && /^(?:id|url|link|value)$/i.test(key))) {
      for (const item of Array.isArray(raw) ? raw : [raw]) {
        const id = numericId(item);
        if (id) result.pixiv.push(id);
      }
    }
    const hanContext = /han.?ime|han1me/i.test(key);
    if (hanContext) {
      for (const item of Array.isArray(raw) ? raw : [raw]) {
        const id = numericId(item);
        if (id) result.han1me.push(id);
      }
    }
    if (raw && typeof raw === "object") collectTaggedIds(raw, result, depth + 1, pixivContext ? "pixiv" : hanContext ? "han1me" : context);
  }
  return result;
}

export function extractDownloadFilterIds(value) {
  return collectTaggedIds(value);
}

function blockedTag(tag, blockedTags) {
  const value = normalized(tag).replace(/^#+/, "");
  if (!value) return false;
  for (const blocked of blockedTags) {
    const needle = normalized(blocked).replace(/^#+/, "");
    if (!needle) continue;
    if (/[\u3040-\u30ff\u3400-\u9fff]/u.test(needle)) {
      if (value === needle || value.includes(needle)) return true;
    } else {
      const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      if (new RegExp(`(?:^|[^a-z0-9])${escaped}(?:[a-z0-9]*)(?:$|[^a-z0-9])`, "i").test(value)) return true;
    }
  }
  return false;
}

export function defaultDownloadFilter() {
  return {
    version: 1,
    blockedTags: [...DEFAULT_BLOCKED_TAGS],
    han1meIds: [],
    pixivIds: [],
    iwaraVideoIds: []
  };
}

export function matchesDownloadFilter({ videoId = "", sourcePlatform = "", metadata = null, tags = [] } = {}, filter = {}) {
  const policy = { ...defaultDownloadFilter(), ...(filter && typeof filter === "object" ? filter : {}) };
  const id = normalized(videoId);
  const han1meIds = new Set(list(policy.han1meIds).map(value => numericId(value)).filter(Boolean));
  const pixivIds = new Set(list(policy.pixivIds).map(value => numericId(value)).filter(Boolean));
  const iwaraIds = new Set(list(policy.iwaraVideoIds).map(normalized).filter(Boolean));

  const hanVideoId = /^han1meview-(\d{3,30})$/i.exec(id)?.[1]
    || (/^han1meview$/i.test(sourcePlatform) ? numericId(videoId) : "");
  if (hanVideoId && han1meIds.has(hanVideoId)) return { type: "han1me_id", value: hanVideoId };
  if (iwaraIds.has(id)) return { type: "iwara_video_id", value: id };

  const foundIds = extractDownloadFilterIds(metadata);
  if (/^han1meview$/i.test(sourcePlatform)) {
    const sourceId = numericId(metadata?.sourceId ?? metadata?.id ?? metadata?.videoId);
    if (sourceId) foundIds.han1me.push(sourceId);
  }
  const matchedHanId = foundIds.han1me.find(value => han1meIds.has(value));
  if (matchedHanId) return { type: "han1me_id", value: matchedHanId };
  const matchedPixivId = foundIds.pixiv.find(value => pixivIds.has(value));
  if (matchedPixivId) return { type: "pixiv_id", value: matchedPixivId };

  const blockedTags = list(policy.blockedTags);
  const candidateTags = [
    ...list(tags),
    ...list(metadata?.tags),
    ...list(metadata?.Tags)
  ].map(item => typeof item === "string" ? item : (item?.name ?? item?.title ?? item?.label ?? item?.id ?? ""));
  const matchedTag = candidateTags.find(tag => blockedTag(tag, blockedTags));
  if (matchedTag) return { type: "tag", value: String(matchedTag).trim().slice(0, 120) };
  return null;
}

export function downloadFilterMessage(match) {
  if (!match) return "";
  const kind = match.type === "tag" ? "标签" : match.type === "pixiv_id" ? "Pixiv 编号" : match.type === "han1me_id" ? "Han1me 编号" : "视频编号";
  return `命中永久下载过滤名单（${kind}：${match.value}）`;
}
