const STAGES = new Set(["video_api", "source_api", "cdn", "browser_sniff", "unknown"]);

export function retryAfterDelay(value, now = Date.now()) {
  const text = String(value || "").trim();
  const delay = /^\d+$/.test(text) ? Number(text) * 1000 : Date.parse(text) - now;
  return Number.isFinite(delay) ? Math.min(60_000, Math.max(0, delay)) : 0;
}

export function classifyError(message) {
  const text = String(message || "").toLowerCase();
  if (/80090322|sec_e_wrong_principal|wrong principal|target principal|目标主要名称|hostname mismatch|certificate.*(?:host|name)|sni/.test(text)) return "tls_certificate";
  if (/80090326|sec_e_illegal_message|ssl|tls|handshake|schannel|握手/.test(text)) return "tls_handshake";
  if (/\b429\b|too many requests/.test(text)) return "rate_limited";
  if (/\b404\b|not found|不存在|deleted/.test(text)) return "not_found";
  if (/\b403\b|forbidden|expired|过期/.test(text)) return "access_or_expired";
  if (/timeout|timed out|超时|无进度/.test(text)) return "timeout";
  if (/network|fetch|connect|socket|no uri available|网络/.test(text)) return "network";
  if (/private|permission|unauthorized|权限|登录/.test(text)) return "permission";
  if (/所有可用 cdn 源均已失败|all available cdn/.test(text)) return "source_exhausted";
  if (/quality|source|画质|视频源/.test(text)) return "source_unavailable";
  if (/疑似 cdn|错误页|空文件|不是有效/.test(text)) return "invalid_media";
  return "unknown";
}

export function isPermanentErrorCategory(category) {
  return category === "video_missing" || category === "permission_denied";
}

// A legacy string is not evidence that an Iwara video has been removed.
export function failurePolicy(message, detail, defaultStage = "unknown") {
  const input = detail && typeof detail === "object" ? detail : {};
  const stage = STAGES.has(input.stage) ? input.stage : defaultStage;
  const explicitStatus = Number(input.httpStatus);
  const inferredStatus = /(?:http|status(?: code)?)\s*[:=]?\s*(\d{3})\b/i.exec(String(message || ""));
  const httpStatus = Number.isInteger(explicitStatus) && explicitStatus >= 100 && explicitStatus <= 599
    ? explicitStatus : inferredStatus ? Number(inferredStatus[1]) : null;
  const reason = safeFailureMessage(input.reason || "").slice(0, 160);
  const confirmedVideoApi = stage === "video_api" && reason !== "unverified_response";
  let category = classifyError(message);
  if (httpStatus === 429) category = "rate_limited";
  else if (confirmedVideoApi && (httpStatus === 404 || httpStatus === 410 || ["not_found", "deleted"].includes(reason))) category = "video_missing";
  else if (confirmedVideoApi && ([401, 403].includes(httpStatus) || ["permission_denied", "private", "unauthorized"].includes(reason))) category = "permission_denied";
  else if (stage === "cdn" && (httpStatus === 404 || category === "not_found")) category = "cdn_not_found";
  else if (stage === "cdn" && (httpStatus === 403 || category === "access_or_expired")) category = "link_expired";
  const retryAfterMs = Math.min(60_000, Math.max(0, Number(input.retryAfterMs) || 0));
  return { stage, httpStatus, reason, category, retryAfterMs, permanent: isPermanentErrorCategory(category) };
}

export function safeFailureMessage(message) {
  // Do not write signed query strings, cookies or access tokens to attempt logs.
  return String(message || "").replace(/https?:\/\/[^\s"'<>]+/gi, value => {
    try { const url = new URL(value); return url.origin + url.pathname; } catch { return "[URL]"; }
  }).replace(/(access_token|authorization|cookie)\s*[:=]\s*[^\s;]+/gi, "$1=[redacted]").slice(0, 1000);
}
