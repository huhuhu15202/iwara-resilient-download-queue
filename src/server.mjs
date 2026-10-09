import http from "node:http";
import { createReadStream } from "node:fs";
import { readFile, realpath, stat } from "node:fs/promises";
import { createHash, randomBytes, randomInt, randomUUID, timingSafeEqual } from "node:crypto";
import { networkInterfaces } from "node:os";
import path from "node:path";
import { CoverCache } from "./cover-cache.mjs";
import { issueResourceTicket, verifyResourceTicket } from "./resource-ticket.mjs";
import { desktopLibraryEnhancementScript } from "./desktop-library-ui.mjs";
import { libraryReturnStateScript } from "./library-return-state.mjs";
import { playbackExperienceScript } from "./playback-experience-ui.mjs";
import { YoutubeDownloader } from "./youtube-downloader.mjs";
import { receiveHan1meArchive } from "./han1me-archive.mjs";
import { classifyMediaSource } from "./media-source.mjs";
import { repositoryOwnsPath } from "./storage-repositories.mjs";

const SERVICE_VERSION = "1.16.1";

function normalizeAddress(address = "") {
  const value = String(address || "").trim().toLowerCase();
  return value.startsWith("::ffff:") ? value.slice(7) : value;
}

export function isLoopbackAddress(address = "") {
  const value = normalizeAddress(address);
  return value === "127.0.0.1" || value === "::1" || value === "localhost";
}

function isPrivateAddress(address = "") {
  const value = normalizeAddress(address).replace(/^\[|\]$/g, "");
  if (isLoopbackAddress(value) || value === "0.0.0.0") return true;
  if (/^(10|192\.168|169\.254)\./.test(value)) return true;
  const tailscaleOctet = /^100\.(\d{1,3})\./.exec(value)?.[1];
  if (tailscaleOctet != null && Number(tailscaleOctet) >= 64 && Number(tailscaleOctet) <= 127) return true;
  if (/^172\.(1[6-9]|2[0-9]|3[0-1])\./.test(value)) return true;
  return value.startsWith("fe80:") || value.startsWith("fc") || value.startsWith("fd");
}

function requestHostName(host = "") {
  const value = String(host || "").trim().toLowerCase();
  if (value.startsWith("[")) return value.slice(1, value.indexOf("]"));
  return value.split(":")[0];
}

export function allowedOrigin(origin, requestHost = "") {
  if (!origin) return true;
  try {
    const parsed = new URL(origin);
    if (parsed.protocol === "chrome-extension:" && parsed.hostname === "dhdgffkkebhmkfjojejmpbldmpobfkfo") return true;
    if (["127.0.0.1", "localhost"].includes(parsed.hostname)) return true;
    if (parsed.protocol === "http:" && (isPrivateAddress(parsed.hostname) || parsed.hostname === requestHostName(requestHost))) return true;
    return parsed.protocol === "https:" && (parsed.hostname === "iwara.tv" || parsed.hostname.endsWith(".iwara.tv"));
  } catch {
    return false;
  }
}

function tokenMatches(expected, candidate) {
  const left = Buffer.from(String(expected || ""));
  const right = Buffer.from(String(candidate || ""));
  return left.length > 0 && left.length === right.length && timingSafeEqual(left, right);
}

function requestCookies(header = "") {
  return Object.fromEntries(String(header || "").split(";").map(part => {
    const index = part.indexOf("=");
    return index > 0 ? [part.slice(0, index).trim(), part.slice(index + 1).trim()] : ["", ""];
  }).filter(([name]) => name));
}

export function authorizeRequest(request, url, accessToken = "") {
  const token = String(accessToken || "").trim();
  if (!token || isLoopbackAddress(request.socket?.remoteAddress || "")) return { ok: true, viaQuery: false };
  const resource = /^\/(media|cover)\/([^/]+)$/.exec(url?.pathname || "");
  if (resource && ["GET", "HEAD"].includes(request.method || "GET")) {
    let taskId = "";
    try { taskId = decodeURIComponent(resource[2]); } catch { return { ok: false, viaQuery: false }; }
    if (verifyResourceTicket(token, resource[1], taskId, url.searchParams.get("ticket"))) {
      return { ok: true, viaQuery: false, viaTicket: true };
    }
  }
  const queryToken = url?.searchParams?.get("access_token") || url?.searchParams?.get("token") || "";
  const headerToken = request.headers["x-iwara-access-token"] || "";
  const cookieToken = requestCookies(request.headers.cookie || "").iwara_lan_token || "";
  const candidate = headerToken || cookieToken || queryToken;
  return { ok: tokenMatches(token, candidate), viaQuery: Boolean(queryToken && tokenMatches(token, queryToken)) };
}

export function authorizeBatchDownloadRequest(request, url, accessToken = "", jobs = new Map(), now = Date.now()) {
  const match = /^\/batch-download\/([a-f0-9]{36})\.zip$/i.exec(url.pathname);
  const job = match ? jobs.get(match[1]) : null;
  if (request.method === "GET" && job && job.expiresAt > now) return { ok: true, viaCapability: true };
  return authorizeRequest(request, url, accessToken);
}

export function partitionMobileDownloadBatches(items, batchLimit = 4_500_000_000) {
  if (!Number.isSafeInteger(batchLimit) || batchLimit <= 0) throw new RangeError("mobile batch limit must be a positive safe integer");
  const groups = [];
  let group = null;
  for (const item of items) {
    if (!Number.isSafeInteger(item?.size) || item.size <= 0 || item.size > batchLimit) {
      throw new RangeError("mobile media size must fit within one batch");
    }
    if (!group || group.totalBytes + item.size > batchLimit) {
      group = { items: [], totalBytes: 0 };
      groups.push(group);
    }
    group.items.push(item);
    group.totalBytes += item.size;
  }
  return groups;
}

function normalizePlaybackProfile(value = "") {
  return String(value || "").toLowerCase() === "remote" ? "remote" : "local";
}

function withResourceUrls(payload, accessToken, profile = "local") {
  const token = String(accessToken || "").trim();
  const playbackProfile = normalizePlaybackProfile(profile);
  return {
    ...payload,
    playbackProfile,
    items: (payload.items || []).map(item => {
      const mediaTicket = issueResourceTicket(token, "media", item.id);
      const coverTicket = issueResourceTicket(token, "cover", item.id);
      const mediaQuery = new URLSearchParams();
      if (mediaTicket) mediaQuery.set("ticket", mediaTicket);
      // Keep the selected mode explicit on the media request.  This matters
      // for a Tailscale client: without profile=local, the server correctly
      // auto-detects the host as remote and would silently switch back to 480p.
      mediaQuery.set("profile", playbackProfile);
      const downloadQuery = new URLSearchParams(mediaQuery);
      downloadQuery.set("download", "1");
      const coverQuery = coverTicket ? `?ticket=${encodeURIComponent(coverTicket)}` : "";
      return {
        ...item,
        playbackProfile,
        streamUrl: `/media/${encodeURIComponent(item.id)}${mediaQuery.toString() ? `?${mediaQuery}` : ""}`,
        downloadUrl: `/media/${encodeURIComponent(item.id)}?${downloadQuery}`,
        coverUrl: `/cover/${encodeURIComponent(item.id)}${coverQuery}`
      };
    })
  };
}

function isTailscaleAddress(address = "") {
  const value = normalizeAddress(address);
  const match = /^100\.(\d{1,3})\./.exec(value);
  return Boolean(match && Number(match[1]) >= 64 && Number(match[1]) <= 127);
}

function requestPlaybackProfile(request, url) {
  const explicit = url?.searchParams?.get("profile");
  if (explicit) return normalizePlaybackProfile(explicit);
  // A Tailscale URL is the remote entry point even when the user opens the
  // plain /playlist link from an older bookmark. LAN 192.168.x links keep the
  // original file, while Cloudflare/FRP callers can opt in with profile=remote.
  return isTailscaleAddress(requestHostName(request?.headers?.host || "")) ? "remote" : "local";
}

function localLanAddresses() {
  const addresses = [];
  for (const entries of Object.values(networkInterfaces())) {
    for (const entry of entries || []) {
      if (!entry || entry.internal) continue;
      const address = String(entry.address || "").trim();
      if (address && !address.includes(":") && isPrivateAddress(address)) addresses.push(address);
    }
  }
  return [...new Set(addresses)];
}

function tailscaleAddresses() {
  return localLanAddresses().filter(isTailscaleAddress);
}

function sendJson(response, status, payload, origin = "", requestHost = "") {
  const body = JSON.stringify(payload);
  const headers = {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    // The ledger API is an internal data endpoint.  Keep it uncached and
    // explicitly inline so Chrome does not try to treat it as a download.
    "cache-control": "no-store",
    "content-disposition": "inline",
    "x-content-type-options": "nosniff"
  };
  if (origin && allowedOrigin(origin, requestHost)) {
    headers["access-control-allow-origin"] = origin;
    headers["vary"] = "Origin";
  }
  response.writeHead(status, headers);
  response.end(body);
}

async function readJson(request, maxBytes = 1024 * 1024) {
  const chunks = [];
  let length = 0;
  for await (const chunk of request) {
    length += chunk.length;
    if (length > maxBytes) {
      request.resume();
      const error = new Error("JSON 请求超过大小限制");
      error.statusCode = 413;
      throw error;
    }
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

async function readUrlEncoded(request, maxBytes = 64 * 1024) {
  const chunks = [];
  let length = 0;
  for await (const chunk of request) {
    length += chunk.length;
    if (length > maxBytes) {
      request.resume();
      const error = new Error("批量下载请求过大，请减少所选视频数量");
      error.statusCode = 413;
      throw error;
    }
    chunks.push(chunk);
  }
  return new URLSearchParams(Buffer.concat(chunks).toString("utf8"));
}

const ZIP_CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < table.length; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    table[index] = value >>> 0;
  }
  return table;
})();

function zipCrc32Update(crc, chunk) {
  let value = crc >>> 0;
  for (const byte of chunk) value = ZIP_CRC_TABLE[(value ^ byte) & 0xff] ^ (value >>> 8);
  return value >>> 0;
}

function zipDosDateTime(value) {
  const date = new Date(value || 0);
  const year = Math.min(2107, Math.max(1980, date.getFullYear() || 1980));
  return {
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2),
    date: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate()
  };
}

function zip64Extra(...values) {
  const extra = Buffer.alloc(4 + values.length * 8);
  extra.writeUInt16LE(0x0001, 0);
  extra.writeUInt16LE(values.length * 8, 2);
  values.forEach((value, index) => extra.writeBigUInt64LE(BigInt(value), 4 + index * 8));
  return extra;
}

async function sha256File(filePath) {
  const digest = createHash("sha256");
  const before = await stat(filePath);
  for await (const chunk of createReadStream(filePath)) digest.update(chunk);
  const after = await stat(filePath);
  if (before.size !== after.size || before.mtimeMs !== after.mtimeMs) throw new Error("文件在指纹核对期间发生变化");
  return { size: after.size, mtimeMs: after.mtimeMs, sha256: digest.digest("hex") };
}

function storedZipContentLength(files) {
  let length = 98; // ZIP64 EOCD, locator, and classic EOCD records.
  for (const file of files) {
    const nameLength = Buffer.byteLength(file.archiveName.replaceAll("\\", "/"), "utf8");
    length += Number(file.size) + 148 + nameLength * 2;
  }
  if (!Number.isSafeInteger(length)) throw new Error("ZIP 文件总大小超出浏览器可安全下载范围");
  return length;
}

async function streamStoredZip(response, files, onProgress = () => {}) {
  const entries = [];
  let offset = 0n;
  let bytesSent = 0;
  const flags = 0x0808; // UTF-8 names plus data descriptors.
  const writeChunk = async chunk => {
    await writeResponseChunk(response, chunk);
    bytesSent += chunk.length;
    onProgress(bytesSent);
  };

  for (const file of files) {
    const name = Buffer.from(file.archiveName.replaceAll("\\", "/"), "utf8");
    const { time, date } = zipDosDateTime(file.mtimeMs);
    const localOffset = offset;
    const extra = zip64Extra(file.size, file.size);
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(45, 4);
    header.writeUInt16LE(flags, 6);
    header.writeUInt16LE(0, 8); // STORE: copy bytes as-is, no compression.
    header.writeUInt16LE(time, 10);
    header.writeUInt16LE(date, 12);
    header.writeUInt32LE(0, 14); // CRC is written in the trailing descriptor.
    header.writeUInt32LE(0xffffffff, 18);
    header.writeUInt32LE(0xffffffff, 22);
    header.writeUInt16LE(name.length, 26);
    header.writeUInt16LE(extra.length, 28);
    await writeChunk(header);
    await writeChunk(name);
    await writeChunk(extra);
    offset += BigInt(header.length + name.length + extra.length);

    let crc = 0xffffffff;
    let size = 0n;
    const chunks = file.data != null ? [Buffer.from(file.data)] : createReadStream(file.path);
    for await (const chunk of chunks) {
      crc = zipCrc32Update(crc, chunk);
      size += BigInt(chunk.length);
      await writeChunk(chunk);
      offset += BigInt(chunk.length);
    }
    if (size !== BigInt(file.size)) throw new Error(`文件在打包期间发生变化: ${file.archiveName}`);
    crc = (crc ^ 0xffffffff) >>> 0;
    const descriptor = Buffer.alloc(24);
    descriptor.writeUInt32LE(0x08074b50, 0);
    descriptor.writeUInt32LE(crc, 4);
    descriptor.writeBigUInt64LE(size, 8);
    descriptor.writeBigUInt64LE(size, 16);
    await writeChunk(descriptor);
    offset += BigInt(descriptor.length);
    entries.push({ name, extra: zip64Extra(size, size, localOffset), crc, localOffset, size, time, date });
  }

  const centralOffset = offset;
  for (const entry of entries) {
    const header = Buffer.alloc(46);
    header.writeUInt32LE(0x02014b50, 0);
    header.writeUInt16LE(45, 4);
    header.writeUInt16LE(45, 6);
    header.writeUInt16LE(flags, 8);
    header.writeUInt16LE(0, 10);
    header.writeUInt16LE(entry.time, 12);
    header.writeUInt16LE(entry.date, 14);
    header.writeUInt32LE(entry.crc, 16);
    header.writeUInt32LE(0xffffffff, 20);
    header.writeUInt32LE(0xffffffff, 24);
    header.writeUInt16LE(entry.name.length, 28);
    header.writeUInt16LE(entry.extra.length, 30);
    header.writeUInt16LE(0, 32);
    header.writeUInt16LE(0, 34);
    header.writeUInt16LE(0, 36);
    header.writeUInt32LE(0, 38);
    header.writeUInt32LE(0xffffffff, 42);
    await writeChunk(header);
    await writeChunk(entry.name);
    await writeChunk(entry.extra);
    offset += BigInt(header.length + entry.name.length + entry.extra.length);
  }

  const centralSize = offset - centralOffset;
  const zip64Offset = offset;
  const zip64End = Buffer.alloc(56);
  zip64End.writeUInt32LE(0x06064b50, 0);
  zip64End.writeBigUInt64LE(44n, 4);
  zip64End.writeUInt16LE(45, 12);
  zip64End.writeUInt16LE(45, 14);
  zip64End.writeUInt32LE(0, 16);
  zip64End.writeUInt32LE(0, 20);
  zip64End.writeBigUInt64LE(BigInt(entries.length), 24);
  zip64End.writeBigUInt64LE(BigInt(entries.length), 32);
  zip64End.writeBigUInt64LE(centralSize, 40);
  zip64End.writeBigUInt64LE(centralOffset, 48);
  await writeChunk(zip64End);

  const locator = Buffer.alloc(20);
  locator.writeUInt32LE(0x07064b50, 0);
  locator.writeUInt32LE(0, 4);
  locator.writeBigUInt64LE(zip64Offset, 8);
  locator.writeUInt32LE(1, 16);
  await writeChunk(locator);

  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(0xffff, 8);
  end.writeUInt16LE(0xffff, 10);
  end.writeUInt32LE(0xffffffff, 12);
  end.writeUInt32LE(0xffffffff, 16);
  end.writeUInt16LE(0, 20);
  await writeChunk(end);
  response.end();
}

function lanLoginHtml() {
  return `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><title>登录本地播放列表</title>
<style>*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;background:#f2f6fc;color:#203654;font:16px/1.5 system-ui,"Microsoft YaHei",sans-serif;padding:20px}.panel{width:min(440px,100%);background:#fff;border:1px solid #d9e4f1;border-radius:20px;padding:26px;box-shadow:0 16px 48px #183b641c}h1{font-size:22px;margin:0 0 8px}p{color:#697b91;margin:0 0 20px}input,button{width:100%;min-height:50px;border-radius:12px;font:inherit}input{border:1px solid #cbd8e7;padding:12px 14px;margin-bottom:12px}button{border:0;background:#276ac2;color:#fff;font-weight:700}#message{min-height:24px;margin-top:12px;color:#b34040;font-size:14px}</style>
<main class="panel"><h1>登录 Iwara 本地播放列表</h1><p>输入电脑控制面板提供的局域网访问令牌。登录后此浏览器会记住访问状态。</p><form id="login"><input id="token" type="password" autocomplete="current-password" placeholder="粘贴访问令牌" required><button>登录并打开播放列表</button><div id="message" role="status"></div></form></main>
<script>const input=document.getElementById('token'),message=document.getElementById('message');const params=new URLSearchParams(location.search);input.value=params.get('access_token')||params.get('token')||'';document.getElementById('login').addEventListener('submit',async event=>{event.preventDefault();message.textContent='正在验证…';try{const response=await fetch('/api/login',{method:'POST',headers:{'content-type':'application/json'},credentials:'same-origin',body:JSON.stringify({token:input.value})});const data=await response.json();if(!response.ok)throw Error(data.error||'令牌无效');try{sessionStorage.setItem('iwaraAccessToken',input.value)}catch{}const target=new URL(location.href);target.searchParams.delete('access_token');target.searchParams.delete('token');location.replace(target.pathname+target.search+target.hash)}catch(error){message.textContent=error.message==='令牌无效'?'令牌不正确，请从电脑控制面板重新复制局域网链接。':'登录失败：'+error.message}});</script></html>`;
}

function authBootstrapScript() {
  return `(function(){let token='';try{const pageUrl=new URL(location.href);token=pageUrl.searchParams.get('access_token')||pageUrl.searchParams.get('token')||sessionStorage.getItem('iwaraAccessToken')||'';if(token){sessionStorage.setItem('iwaraAccessToken',token);if(pageUrl.searchParams.has('access_token')||pageUrl.searchParams.has('token')){pageUrl.searchParams.delete('access_token');pageUrl.searchParams.delete('token');history.replaceState(history.state,'',pageUrl.pathname+pageUrl.search+pageUrl.hash)}}}catch{}if(!token)return;const originalFetch=window.fetch.bind(window);window.fetch=(input,init={})=>{try{const raw=input instanceof Request?input.url:String(input);const requestUrl=new URL(raw,location.href);const needsToken=requestUrl.pathname.startsWith('/api/')||requestUrl.pathname==='/playlist-data';if(requestUrl.origin===location.origin&&needsToken&&requestUrl.pathname!=='/api/login'){const headers=new Headers(input instanceof Request?input.headers:undefined);new Headers(init.headers).forEach((value,key)=>headers.set(key,value));headers.set('x-iwara-access-token',token);init={...init,headers,credentials:'same-origin'}}}catch{}return originalFetch(input,init)};const originalBeacon=navigator.sendBeacon?.bind(navigator);if(originalBeacon)navigator.sendBeacon=(input,data)=>{try{const beaconUrl=new URL(String(input),location.href);if(beaconUrl.origin===location.origin&&beaconUrl.pathname.startsWith('/api/')&&!beaconUrl.searchParams.has('access_token'))beaconUrl.searchParams.set('access_token',token);return originalBeacon(beaconUrl.pathname+beaconUrl.search,data)}catch{return originalBeacon(input,data)}}})();`;
}

function presenceClientScript(page) {
  return `const __iwaraPresencePage=${JSON.stringify(String(page || "page"))};
let __iwaraPresenceId='';try{__iwaraPresenceId=sessionStorage.getItem('iwara-presence-id')||'';if(!__iwaraPresenceId){__iwaraPresenceId=(crypto.randomUUID?crypto.randomUUID():Math.random().toString(36).slice(2));sessionStorage.setItem('iwara-presence-id',__iwaraPresenceId)}}catch{__iwaraPresenceId=Math.random().toString(36).slice(2)}
function __iwaraPresence(active=true){const body=JSON.stringify({clientId:__iwaraPresenceId,page:__iwaraPresencePage,active});try{if(!active&&navigator.sendBeacon&&navigator.sendBeacon('/api/presence',new Blob([body],{type:'application/json'})))return}catch{}fetch('/api/presence',{method:'POST',headers:{'content-type':'application/json'},body,keepalive:!active}).catch(()=>{})}
__iwaraPresence();const __iwaraPresenceTimer=setInterval(()=>__iwaraPresence(),10000);window.addEventListener('pagehide',()=>{clearInterval(__iwaraPresenceTimer);__iwaraPresence(false)},{once:true});`;
}

function dashboardHtml() {
  return `<!doctype html><html lang="zh-CN"><meta charset="utf-8">
<meta name="viewport" content="width=device-width">
<title>Iwara 稳定下载队列</title>
<style>
*{box-sizing:border-box}body{font:14px/1.5 "Segoe UI","Microsoft YaHei",system-ui;margin:0;background:#f3f6fb;color:#253247}main{max-width:1540px;margin:auto;padding:28px}
h1{font-size:27px;letter-spacing:.2px;margin:0 0 8px;color:#17365f}.hint{color:#63738a;margin:0 0 20px}.hint a{text-decoration:none}
.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(125px,1fr));gap:12px;margin-bottom:16px}
.card{background:#fff;padding:14px 16px;border:1px solid #dce5f0;border-radius:14px;cursor:pointer;color:#52627a;box-shadow:0 4px 14px rgba(45,76,120,.06);text-align:left}
.card:hover,.card.active{border-color:#5b8def;background:#eef5ff;box-shadow:0 6px 18px rgba(49,101,185,.12)}.card b{display:block;font-size:22px;color:#1e5fae;margin-bottom:2px}
.current{background:#fff;border:1px solid #d9e5f2;border-left:5px solid #5b8def;padding:13px 16px;border-radius:12px;margin:10px 0;box-shadow:0 3px 12px rgba(45,76,120,.05)}#presenceStatus{color:#63738a;font-size:13px;margin:4px 0 10px;padding-left:2px}
.filters{display:grid;grid-template-columns:minmax(260px,2fr) repeat(4,minmax(145px,1fr));gap:10px;margin:18px 0 14px;background:#fff;padding:14px;border:1px solid #dfe7f1;border-radius:14px}
input,select,button{font:inherit;border:1px solid #cbd7e6;border-radius:9px;padding:9px 11px;background:#fff;color:#33445c;min-height:38px}
input:focus,select:focus{outline:3px solid #dceaff;border-color:#5b8def}button{cursor:pointer;font-weight:600}button:hover{border-color:#5b8def;background:#eef5ff}button:disabled{opacity:.45;cursor:not-allowed}
.table-wrap{overflow:auto;border:1px solid #dce5ef;border-radius:14px;background:#fff;box-shadow:0 5px 18px rgba(45,76,120,.06)}
table{width:100%;border-collapse:separate;border-spacing:0;background:#fff;min-width:1420px;table-layout:fixed}th,td{padding:11px 12px;border-bottom:1px solid #e8eef5;text-align:left;vertical-align:top;overflow-wrap:anywhere}
th{position:sticky;top:0;z-index:1;background:#edf4fc;color:#36516f;white-space:nowrap;font-weight:700}tbody tr:hover{background:#f7faff}
th:nth-child(1){width:82px}th:nth-child(2){width:310px}th:nth-child(3){width:180px}th:nth-child(4),th:nth-child(5){width:155px}th:nth-child(6){width:105px}th:nth-child(7){width:62px}th:nth-child(8){width:245px}th:nth-child(9){width:185px}
.title b{display:block;color:#203957;font-size:14px}.muted{color:#7a899d;font-size:12px;margin-top:3px}
td.completed{color:#25835a;font-weight:700}td.failed{color:#c74444;font-weight:700}td.downloading{color:#246ec2;font-weight:700}td.queued,td.resolving,td.finalizing{color:#a66b06;font-weight:700}
.present{color:#25835a}.missing,.size_mismatch{color:#c74444}.progress{height:8px;background:#e7eef7;border-radius:8px;overflow:hidden;margin-top:8px}.progress i{display:block;height:100%;background:linear-gradient(90deg,#5b8def,#6bb7ee)}
.actions{display:flex;gap:6px;flex-wrap:wrap}.actions a{text-decoration:none}.actions button{padding:6px 9px;min-height:32px;font-size:12px}.quick-actions{display:inline-flex;gap:7px;align-items:center;flex-wrap:wrap;vertical-align:middle;margin-left:6px}.quick-actions a{text-decoration:none}.lan-links{display:inline-flex;gap:6px;flex-wrap:wrap;vertical-align:middle;margin-left:6px}.lan-links button{padding:5px 9px;min-height:30px;font-size:12px}.lan-links a{padding:5px 9px;border:1px solid #cbd7e6;border-radius:9px;background:#fff;color:#33445c;text-decoration:none;font-size:12px;font-weight:600}.lan-links a:hover{border-color:#5b8def;background:#eef5ff}
.pager{display:flex;justify-content:space-between;gap:14px;align-items:center;margin-top:14px;background:#fff;border:1px solid #dfe7f1;border-radius:12px;padding:12px 14px}.pager>span:last-child{display:flex;gap:7px;flex-wrap:wrap}.empty{text-align:center;color:#7a899d;padding:34px}
.modal-backdrop{position:fixed;inset:0;z-index:20;background:rgba(35,50,71,.35);display:none;align-items:center;justify-content:center;padding:18px}.modal-backdrop.open{display:flex}.modal{width:min(980px,100%);max-height:90vh;overflow:auto;background:#f8fbff;border-radius:18px;padding:20px;box-shadow:0 24px 70px rgba(29,52,84,.3)}.modal h2{margin:0 0 5px;color:#17365f}.modal-tools{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin:14px 0}.modal-tools input{min-width:240px;flex:1}.author-grid{display:grid;gap:8px}.author-row{display:grid;grid-template-columns:32px minmax(190px,1fr) 110px 125px minmax(210px,1.2fr);gap:9px;align-items:center;background:#fff;border:1px solid #dfe7f1;border-radius:11px;padding:9px 11px}.author-row input[type=checkbox]{min-height:auto;width:18px;height:18px}.author-row input[type=text]{width:100%}.modal-actions{position:sticky;bottom:-20px;display:flex;justify-content:flex-end;gap:8px;background:#f8fbff;padding:14px 0 0}.preview{white-space:pre-wrap;background:#eef5ff;border-radius:10px;padding:11px 13px;color:#36516f;margin-top:12px}.repo-list{display:grid;gap:10px;margin:14px 0}.repo-card{background:#fff;border:1px solid #dbe5f0;border-radius:13px;padding:13px}.repo-card-head{display:flex;justify-content:space-between;gap:12px;align-items:center;margin-bottom:10px}.repo-card-head b{color:#254667}.repo-fields{display:grid;grid-template-columns:1fr 1fr 1.3fr;gap:9px}.repo-fields label{display:grid;gap:4px;color:#6d7d91;font-size:12px}.repo-fields label.path-field{grid-column:1/-1}.repo-fields input,.repo-fields select{width:100%;min-width:0}.repo-flags{display:flex;gap:13px;flex-wrap:wrap;align-items:center;margin-top:10px;color:#53657b}.repo-flags label{display:inline-flex;gap:5px;align-items:center;font-size:12px}.repo-flags input{min-height:auto;width:16px;height:16px}.repo-empty{padding:24px;text-align:center;color:#71829a;border:1px dashed #cbd7e6;border-radius:12px}
.control-panel-backdrop{position:fixed;inset:0;z-index:15;background:rgba(35,50,71,.22);display:none;align-items:flex-start;justify-content:flex-end;padding:18px}.control-panel-backdrop.open{display:flex}.control-panel{width:min(520px,calc(100vw - 28px));max-height:calc(100vh - 36px);overflow:auto;background:#f8fbff;border:1px solid #d8e5f2;border-radius:18px;padding:20px;box-shadow:0 24px 70px rgba(29,52,84,.3)}.control-panel h2{margin:0;color:#17365f}.control-panel p{margin:5px 0 14px;color:#63738a}.control-panel-tools{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px}.control-panel-tools button,.control-panel-tools a{width:100%}.control-panel-tools a button{width:100%}.retry-category-tools{grid-column:1/-1;display:grid;grid-template-columns:minmax(0,1fr) auto;gap:8px;align-items:center;min-width:0}.retry-category-tools select{width:100%;min-width:0}.retry-category-tools button{width:auto!important}.control-panel-foot{display:flex;justify-content:flex-end;margin-top:14px}.control-panel .lan-links{display:flex;margin:12px 0 0}
@media(max-width:900px){main{padding:14px}.filters{grid-template-columns:1fr 1fr}.filters input{grid-column:1/-1}.pager{align-items:flex-start;flex-direction:column}h1{font-size:23px}}
@media(max-width:700px){.author-row{grid-template-columns:28px 1fr}.author-row>*:nth-child(n+3){grid-column:2}.filters{grid-template-columns:1fr}.cards{grid-template-columns:1fr 1fr}}
@media(max-width:700px){.filters{grid-template-columns:minmax(0,1fr);min-width:0}.filters>*{width:100%;min-width:0;max-width:100%}.table-wrap{overflow:visible;border:0;background:transparent;box-shadow:none}table{display:block;width:100%;min-width:0;background:transparent}thead{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}tbody{display:grid;gap:10px}tbody tr{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));grid-template-areas:"status attempts" "title title" "author upload" "record file" "note note" "actions actions";gap:0 12px;padding:8px 12px;background:#fff;border:1px solid #dce5ef;border-radius:13px;box-shadow:0 4px 14px rgba(45,76,120,.06)}tbody td{display:block;min-width:0;padding:4px 0;border-bottom:1px solid #e8eef5;font-size:12px;line-height:1.25;overflow-wrap:anywhere}tbody td::before{content:attr(data-label);display:inline;margin-right:5px;color:#71829a;font-size:10px;line-height:inherit;font-weight:700}tbody td:nth-child(1){grid-area:status}tbody td:nth-child(2){grid-area:title}tbody td:nth-child(3){grid-area:author}tbody td:nth-child(4){grid-area:upload}tbody td:nth-child(5){grid-area:record}tbody td:nth-child(6){grid-area:file}tbody td:nth-child(7){grid-area:attempts}tbody td:nth-child(8){grid-area:note}tbody td:nth-child(9){grid-area:actions;padding-bottom:0;border-bottom:0}tbody td:nth-child(2)::before,tbody td:nth-child(8)::before,tbody td:nth-child(9)::before{display:block;margin:0 0 2px}.title b{display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:2;overflow:hidden;font-size:12px;line-height:1.25}.title .muted{margin-top:1px;font-size:10px}tbody td:nth-child(3),tbody td:nth-child(4),tbody td:nth-child(5),tbody td:nth-child(6){font-size:11px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}tbody td:nth-child(6) .muted{display:inline;margin:0 0 0 4px;font-size:inherit}.ledger-message{display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:2;overflow:hidden;font-size:11px;line-height:1.25}tbody td:nth-child(8) .muted{margin-top:1px;font-size:10px;line-height:1.2;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.actions{gap:6px}.actions button{min-height:28px;padding:4px 6px;font-size:11px;white-space:normal}.empty{grid-column:1/-1;display:block}}
</style><main><h1>Iwara 稳定下载台账</h1><nav class="top-actions" aria-label="快捷操作"><button onclick="openControlPanel()">控制面板</button><button onclick="openDownloadDirectory()">打开视频目录</button><a href="/playlist" target="_blank" rel="noopener">打开本地播放列表</a><span id="quickLanLinks" class="lan-links" aria-live="polite"><span>正在读取播放链接…</span></span></nav>
<div class="cards" id="cards"></div><div id="current"></div><div id="presenceStatus" aria-live="polite"></div><div id="metadataProgress"></div>
<div class="filters">
  <input id="query" placeholder="搜索标题、作者、标签或视频 ID">
  <select id="stateFilter"><option value="all">全部状态</option></select>
  <select id="authorFilter"><option value="all">全部作者</option></select>
  <select id="sortBy">
    <option value="updatedAt">按最近记录</option><option value="uploadTime">按上传日期</option>
    <option value="title">按标题</option><option value="author">按作者</option>
    <option value="state">按状态</option><option value="attempts">按尝试次数</option>
  </select>
  <select id="direction"><option value="desc">降序</option><option value="asc">升序</option></select>
</div>
<div class="table-wrap"><table><thead><tr><th>状态</th><th>标题 / 视频 ID</th><th>作者</th><th>上传日期</th><th>记录日期</th><th>文件</th><th>尝试</th><th>说明</th><th>操作</th></tr></thead><tbody id="rows"></tbody></table></div>
<div class="pager"><span id="summary"></span><span><button id="previous">上一页</button> <button id="next">下一页</button></span></div>
<div id="controlPanel" class="control-panel-backdrop" onclick="if(event.target===this)closeControlPanel()"><section class="control-panel">
  <h2>控制面板</h2>
  <p>常用管理、补齐和服务操作集中在这里；列表主界面仅保留筛选与翻页。</p>
  <div class="control-panel-tools">
    <a href="/IwaraResilientQueue.user.js"><button>安装 / 更新网页脚本</button></a>
    <button onclick="openStorageRepositories()">电脑仓库设置</button>
    <button onclick="openAuthorClassification()">按作者整理视频</button>
    <button onclick="queueViews()">同步缺失播放量</button>
    <button onclick="refreshAllViews()">更新全部播放量</button>
    <button onclick="queueTags()">同步缺失标签</button>
    <button onclick="refreshAllTags()">更新全部标签</button>
    <button onclick="retryMetadata()">重试补齐失败项</button>
    <button onclick="verifyFiles()">检查文件</button>
    <button onclick="shutdown()">停止服务</button>
  </div>
  <div class="control-panel-foot"><button onclick="closeControlPanel()">关闭控制面板</button></div>
</section></div>
<div id="storageRepositoryModal" class="modal-backdrop" onclick="if(event.target===this)closeStorageRepositories()"><section class="modal" style="width:min(1040px,100%)"><h2>电脑仓库设置</h2><p>仓库真实路径只在这台电脑显示。接收/下载仓库必须同时启用扫描和媒体提供。保存不会移动文件；新配置待生效，服务空闲后按原启动流程重启。</p><div id="storageRepositoryNotice" class="preview">读取仓库配置中…</div><div class="modal-tools"><button onclick="addStorageRepository()">添加仓库</button></div><div id="storageRepositoryRows" class="repo-list"></div><div class="modal-actions"><button onclick="closeStorageRepositories()">取消</button><button onclick="validateStorageRepositories()">验证目录</button><button onclick="saveStorageRepositories()">保存配置</button></div></section></div>
<div id="authorModal" class="modal-backdrop" onclick="if(event.target===this)closeAuthorClassification()"><section class="modal">
  <h2>按作者整理已下载视频</h2>
  <div class="hint">只显示已完成视频超过 10 个的作者。勾选作者并填写分类目录；多个作者使用相同目录名，就会合并到同一个目录。先预览，确认后才移动当前根目录中的视频；以后新下载也自动归类。</div>
  <div class="modal-tools"><button onclick="toggleAllAuthors(true)">全选</button><button onclick="toggleAllAuthors(false)">清空选择</button><input id="mergeFolder" placeholder="给勾选作者设置同一个分类目录"><button onclick="setMergedFolder()">合并到此目录</button></div>
  <div id="authorRows" class="author-grid"></div>
  <div id="classificationPreview" class="preview">尚未预览。</div>
  <div class="modal-actions"><button onclick="closeAuthorClassification()">关闭</button><button onclick="previewAuthorClassification()">预览移动</button><button id="applyClassification" onclick="applyAuthorClassification()" disabled>确认整理</button></div>
</section></div>
<script>
${authBootstrapScript()}
const esc=s=>String(s??'').replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
async function loadQuickLanLinks(){const target=el('quickLanLinks');if(!target)return;target.replaceChildren();try{const r=await fetch('/api/lan-info',{cache:'no-store'}),data=await r.json();if(!r.ok)throw Error(data.error||r.status);const local=(data.urls||[]).find(url=>url.includes('://10.')||url.includes('://192.168.'))||(data.urls||[])[0];const remote=(data.remoteUrls||[])[0];const tailscaleOnline=Boolean(data.tailscale?.online);const entries=[local?{url:local,label:'局域网原画 · 复制'}:null,remote?{url:remote,label:'远程480p · 复制'}:null].filter(Boolean);if(!entries.length)target.textContent=data.enabled?'未发现可用播放地址':'局域网播放未开启';entries.forEach(({url,label})=>{const copy=document.createElement('button');copy.type='button';copy.title='点击复制完整播放地址：'+url;copy.textContent=label;copy.onclick=async()=>{const original=label;try{if(navigator.clipboard?.writeText)await navigator.clipboard.writeText(url);else{const area=document.createElement('textarea');area.value=url;area.style.position='fixed';area.style.opacity='0';document.body.append(area);area.focus();area.select();if(!document.execCommand('copy'))throw Error('copy failed');area.remove()}copy.textContent='已复制';setTimeout(()=>copy.textContent=original,1600)}catch{copy.textContent='复制失败';setTimeout(()=>copy.textContent=original,1600)}};target.append(copy)});const state=document.createElement('span');state.className='tailscale-state';state.textContent='Tailscale '+(tailscaleOnline?'在线':'离线');target.append(state);}catch(error){target.textContent='播放链接读取失败';target.title=error.message}}
let storageRepositoryRevision='',storageRepositories=[];
function closeStorageRepositories(){el('storageRepositoryModal').classList.remove('open')}
function renderStorageRepositories(){const host=el('storageRepositoryRows');if(!storageRepositories.length){host.innerHTML='<div class="repo-empty">尚未配置仓库。添加目录后可按来源和用途分配。</div>';return}host.innerHTML=storageRepositories.map((repository,index)=>{const roles=[['download','新下载落盘'],['receive','接收手机归档'],['scan','扫描入账'],['serve','在线播放/发送到手机']];const roleHtml=roles.map(([role,label])=>'<label><input type="checkbox" data-repo-index="'+index+'" data-repo-role="'+role+'" '+(repository.roles.includes(role)?'checked':'')+'> '+label+'</label>').join('');return '<article class="repo-card" data-repo-card="'+index+'"><div class="repo-card-head"><b>仓库 '+(index+1)+' · '+esc(repository.name||repository.id||'未命名')+'</b><button type="button" onclick="removeStorageRepository('+index+')">移除</button></div><div class="repo-fields"><label>稳定 ID<input data-repo-field="id" value="'+esc(repository.id||'')+'" maxlength="64"></label><label>显示名称<input data-repo-field="name" value="'+esc(repository.name||'')+'" maxlength="100"></label><label>媒体来源<select data-repo-field="source"><option value="iwara" '+(repository.source==='iwara'?'selected':'')+'>Iwara</option><option value="han1" '+(repository.source==='han1'?'selected':'')+'>Han1</option><option value="other" '+(repository.source==='other'?'selected':'')+'>其他</option></select></label><label class="path-field">电脑目录路径<input data-repo-field="path" value="'+esc(repository.path||'')+'" placeholder="例如 F:\\Video\\Han" spellcheck="false"></label><label>优先级（数值越小越优先）<input data-repo-field="priority" type="number" min="0" step="1" value="'+Number(repository.priority||0)+'"></label><label>最低保留空间（GiB）<input data-repo-field="minimumFreeGiB" type="number" min="0" step="0.5" value="'+(Number(repository.minimumFreeBytes||0)/1073741824)+'"></label></div><div class="repo-flags"><label><input type="checkbox" data-repo-field="enabled" '+(repository.enabled?'checked':'')+'> 启用仓库</label>'+roleHtml+'</div></article>'}).join('')}
function addStorageRepository(){storageRepositories.push({id:'new-repository-'+(storageRepositories.length+1),name:'新媒体仓库',path:'',source:'iwara',enabled:true,roles:['scan','serve'],priority:storageRepositories.length*10,minimumFreeBytes:0});renderStorageRepositories()}
function removeStorageRepository(index){if(!confirm('仅从配置中移除/停用该仓库？不会删除目录、文件或台账记录。'))return;storageRepositories.splice(index,1);renderStorageRepositories()}
function storageRepositoryValue(){return [...el('storageRepositoryRows').querySelectorAll('[data-repo-card]')].map(card=>{const value=key=>card.querySelector('[data-repo-field="'+key+'"]');const roles=[...card.querySelectorAll('[data-repo-role]:checked')].map(box=>box.dataset.repoRole);return {id:value('id').value.trim(),name:value('name').value.trim(),path:value('path').value.trim(),source:value('source').value,enabled:value('enabled').checked,roles,priority:Number(value('priority').value),minimumFreeBytes:Math.round(Number(value('minimumFreeGiB').value)*1073741824)}})}
async function openStorageRepositories(){closeControlPanel();el('storageRepositoryModal').classList.add('open');const notice=el('storageRepositoryNotice');notice.textContent='读取配置中…';try{const r=await fetch('/api/storage/repositories',{cache:'no-store'}),data=await r.json();if(!r.ok)throw Error(data.error||r.status);storageRepositoryRevision=data.revision;storageRepositories=data.repositories||[];renderStorageRepositories();notice.textContent=(data.pendingRestart?'当前有待生效配置。':'当前配置已生效。')+(data.environmentLocks?.length?' 环境变量覆盖：'+data.environmentLocks.map(x=>x.variable).join('、')+'；受覆盖项目只读。':'')}catch(e){notice.textContent='无法读取：'+e.message}}
async function validateStorageRepositories(){const notice=el('storageRepositoryNotice');try{notice.textContent='正在验证路径和读写权限…';const r=await fetch('/api/storage/repositories/validate',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({repositories:storageRepositoryValue()})});const data=await r.json();if(!r.ok)throw Error(data.error||r.status);notice.textContent='目录验证通过：'+data.repositories.length+' 个仓库。未移动或扫描任何文件。'}catch(e){notice.textContent='验证未通过：'+e.message}}
async function saveStorageRepositories(){const notice=el('storageRepositoryNotice');try{notice.textContent='正在安全保存…';const r=await fetch('/api/storage/repositories',{method:'PUT',headers:{'content-type':'application/json'},body:JSON.stringify({repositories:storageRepositoryValue(),revision:storageRepositoryRevision})});const data=await r.json();if(!r.ok)throw Error(data.error||r.status);storageRepositoryRevision=data.revision;storageRepositories=data.repositories||[];renderStorageRepositories();notice.textContent='已安全保存；这是待生效配置。当前任务不受影响，服务空闲后按原启动流程重启即可。'}catch(e){notice.textContent='保存失败：'+e.message}}
const stateNames={queued:'等待中',resolving:'解析中',downloading:'下载中',finalizing:'文件入库',completed:'已完成',failed:'已失败',filtered:'过滤拦截'};
const fileNames={present:'正常',missing:'文件缺失',size_mismatch:'大小异常',unknown:'未检查'};
const errorNames={tls_certificate:'CDN 证书或主机名不匹配',tls_handshake:'TLS 握手失败',source_exhausted:'可用 CDN 均已尝试',not_found:'旧记录：资源未找到（未确认视频删除）',access_or_expired:'旧记录：地址过期或拒绝访问',video_missing:'视频资料接口确认不存在',permission_denied:'当前账号没有视频访问权限',cdn_not_found:'CDN 链接失效，需重新解析',link_expired:'签名链接过期或被 CDN 拒绝',rate_limited:'请求过于频繁',invalid_media:'CDN 返回空文件或错误页',timeout:'下载超时',network:'网络连接失败',permission:'权限不足',source_unavailable:'没有可用视频源',download_filtered:'命中永久下载过滤名单',unknown:'其他错误'};
let summaryData={counts:{},metadataCounts:{},currents:[],metadataCurrents:[],current:null,total:0},ledger={tasks:[],authors:[],total:0,page:1,pageSize:50},page=1,loading=false,pendingLoad=false,inputTimer,authorCandidates=[],classificationPreview=null;const pageSize=50;
const el=id=>document.getElementById(id);
const _dashboardQuickStyle=document.createElement('style');_dashboardQuickStyle.textContent='.top-actions{display:flex!important;gap:8px;align-items:center;flex-wrap:nowrap;overflow-x:auto;margin:0 0 20px;white-space:nowrap;padding-bottom:2px}.top-actions>button,.top-actions>a,.top-actions .lan-links button{height:38px;min-height:38px;box-sizing:border-box;padding:9px 12px;font-size:14px;line-height:18px;display:inline-flex;align-items:center;justify-content:center;white-space:nowrap;flex:0 0 auto}.top-actions>a{border:1px solid #cbd7e6;border-radius:9px;background:#fff;color:#33445c;text-decoration:none;font-weight:600}.top-actions>a:hover{border-color:#5b8def;background:#eef5ff}.top-actions .lan-links{display:contents!important;margin:0}.top-actions .lan-links>span{padding:8px 10px;color:#71829a;white-space:nowrap}.top-actions .tailscale-state{padding:8px 10px;color:#71829a;font-size:12px;white-space:nowrap}';document.head.append(_dashboardQuickStyle);
function openControlPanel(){el('controlPanel').classList.add('open')}
function closeControlPanel(){el('controlPanel').classList.remove('open')}
const dateText=value=>{if(!value)return '—';const d=new Date(value);return Number.isNaN(d.getTime())?'—':d.toLocaleString('zh-CN',{hour12:false})};
const authorText=t=>t.alias?(t.alias+(t.author&&t.author!==t.alias?' (@'+t.author+')':'')):(t.author||'—');
const bytes=value=>{const n=Number(value||0);if(!n)return '—';const units=['B','KiB','MiB','GiB'];let i=0,v=n;while(v>=1024&&i<units.length-1){v/=1024;i++}return v.toFixed(i?1:0)+' '+units[i]};
const progressText=t=>{const done=Number(t.completedLength||0),total=Number(t.totalLength||0),speed=Number(t.downloadSpeed||0),pct=total?Math.min(100,done/total*100):0,eta=speed&&total>done?Math.ceil((total-done)/speed):0;return{pct,text:bytes(done)+' / '+bytes(total)+(speed?' · '+bytes(speed)+'/s':'')+(eta?' · 约 '+eta+' 秒':'')}};
async function retry(id){await fetch('/api/retry/'+id,{method:'POST'});await load()}
async function redownload(id){if(confirm('记录对应的文件缺失，确定重新下载？')){await fetch('/api/redownload/'+id,{method:'POST'});await load()}}
async function verifyFiles(){closeControlPanel();const r=await(await fetch('/api/verify-files',{method:'POST'})).json();alert('检查完成：正常 '+r.present+'，缺失 '+r.missing+'，大小异常 '+r.sizeMismatch);await load()}
async function openDownloadDirectory(){closeControlPanel();const r=await fetch('/api/open-download-directory',{method:'POST'});if(!r.ok){const body=await r.json();alert('打开目录失败：'+(body.error||r.status))}}
async function showLanAccess(){closeControlPanel();const target=el('lanInfo');target.className='lan-links';target.replaceChildren();try{const r=await fetch('/api/lan-info',{cache:'no-store'});const data=await r.json();if(!r.ok)throw Error(data.error||r.status);if(!data.enabled){target.textContent='局域网未开启（将 serviceHost 改为 0.0.0.0 后重启）';openControlPanel();return}const entries=[...(data.urls||[]).map((url,index)=>({url,label:'局域网 '+(index+1)})),...(data.remoteUrls||[]).map((url,index)=>({url,label:'远程480p '+(index+1)}))];if(!entries.length){target.textContent='未发现局域网 IPv4 地址，请查看服务日志';openControlPanel();return}entries.forEach(({url,label})=>{try{label=new URL(url).host+(new URL(url).searchParams.get('profile')==='remote'?' · 远程480p':'')}catch{}const copy=document.createElement('button');copy.type='button';copy.title='点击复制完整播放地址';copy.textContent=label;copy.onclick=async()=>{try{if(navigator.clipboard?.writeText)await navigator.clipboard.writeText(url);else{const area=document.createElement('textarea');area.value=url;area.style.position='fixed';area.style.opacity='0';document.body.append(area);area.focus();area.select();if(!document.execCommand('copy'))throw Error('copy failed');area.remove()}copy.textContent='已复制';setTimeout(()=>copy.textContent=label,1600)}catch{copy.textContent='复制失败';setTimeout(()=>copy.textContent=label,1600)}};const open=document.createElement('a');open.href=url;open.target='_blank';open.rel='noopener';open.textContent='打开';target.append(copy,open)});openControlPanel()}catch(e){target.textContent='读取局域网链接失败：'+e.message;openControlPanel()}}
async function retryMetadata(){closeControlPanel();const r=await(await fetch('/api/enrich/retry-failed',{method:'POST'})).json();alert('已将 '+r.count+' 条补齐失败记录放回队列');await load()}
async function retryFailedCategory(){const category=document.getElementById('retryCategory')?.value||'all';const r=await(await fetch('/api/retry-category',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({category})})).json();if(!r.ok&&r.error)throw Error(r.error);alert('已将 '+Number(r.queued||0)+' 条「'+category+'」失败任务放回下载队列');closeControlPanel();await load()}
async function queueViews(){closeControlPanel();const r=await(await fetch('/api/enrich/queue-views',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({})})).json();alert('已加入 '+r.queued+' 条播放量同步任务'+(r.remaining?'，尚有 '+r.remaining+' 条待加入':'')+'。保持任一 Iwara 视频页打开，网页脚本会以最多 8 个并发逐步处理。');await load()}
async function refreshAllViews(){closeControlPanel();if(!confirm('将重新读取所有已下载视频的播放量，保持任一 Iwara 视频页打开即可处理。确认继续？'))return;const r=await(await fetch('/api/enrich/refresh-views',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({})})).json();alert('已加入 '+r.queued+' 条全部播放量更新任务'+(r.remaining?'，尚有 '+r.remaining+' 条待加入':'')+'。网页脚本将使用独立的 8 并发播放量队列。');await load()}
async function queueTags(){closeControlPanel();const r=await(await fetch('/api/enrich/queue-tags',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({})})).json();alert('已加入 '+r.queued+' 条标签同步任务'+(r.remaining?'，尚有 '+r.remaining+' 条待加入':'')+'。保持任一 Iwara 视频页打开即可逐步处理。');await load()}
async function refreshAllTags(){closeControlPanel();if(!confirm('将重新读取所有已下载视频的标签，保持任一 Iwara 视频页打开即可处理。确认继续？'))return;const r=await(await fetch('/api/enrich/refresh-tags',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({})})).json();alert('已加入 '+r.queued+' 条全部标签更新任务'+(r.remaining?'，尚有 '+r.remaining+' 条待加入':'')+'。网页脚本将使用独立的元数据队列。');await load()}
async function history(id){const list=await(await fetch('/api/attempts/'+id)).json();alert(list.length?list.map(x=>dateText(x.createdAt)+' · 第'+x.attemptNo+'次 · '+x.phase+' · '+x.outcome+(x.sourceHost?' · '+x.sourceHost:'')+(x.message?'\\n'+x.message:'')).join('\\n\\n'):'尚无尝试明细')}
async function shutdown(){closeControlPanel();if(confirm('停止稳定下载服务？当前任务下次启动时会重新解析。')){await fetch('/api/shutdown',{method:'POST'});document.body.innerHTML='<main><h1>服务已停止</h1><p>需要下载时重新双击启动文件即可。</p></main>'}}
function selectedAuthorRules(){return [...document.querySelectorAll('.author-choice:checked')].map(box=>({author:box.dataset.author,folder:document.querySelector('.author-folder[data-author="'+CSS.escape(box.dataset.author)+'"]').value.trim()}))}
function invalidateClassificationPreview(){classificationPreview=null;el('applyClassification').disabled=true;el('classificationPreview').textContent='选择已更改，请重新预览。'}
async function openAuthorClassification(){closeControlPanel();const r=await fetch('/api/author-categories?minCount=10');const data=await r.json();if(!r.ok){alert(data.error||r.status);return}authorCandidates=data.candidates||[];el('authorRows').innerHTML=authorCandidates.length?authorCandidates.map(a=>'<label class="author-row"><input class="author-choice" type="checkbox" data-author="'+esc(a.author)+'" '+(a.category?'checked':'')+' onchange="invalidateClassificationPreview()"><span><b>'+esc(a.alias||a.author)+'</b><div class="muted">@'+esc(a.author)+'</div></span><span>已完成 '+a.completedCount+'</span><span>未分类 '+a.unclassifiedCount+'</span><input class="author-folder" type="text" data-author="'+esc(a.author)+'" value="'+esc(a.category||a.alias||a.author)+'" oninput="invalidateClassificationPreview()" aria-label="分类目录"></label>').join(''):'<div class="empty">目前没有超过 10 个已完成视频的作者</div>';el('classificationPreview').textContent='尚未预览。';el('applyClassification').disabled=true;el('authorModal').classList.add('open')}
function closeAuthorClassification(){el('authorModal').classList.remove('open')}
function toggleAllAuthors(checked){document.querySelectorAll('.author-choice').forEach(box=>box.checked=checked);invalidateClassificationPreview()}
function setMergedFolder(){const folder=el('mergeFolder').value.trim();if(!folder){alert('请先填写合并后的分类目录名');return}document.querySelectorAll('.author-choice:checked').forEach(box=>{document.querySelector('.author-folder[data-author="'+CSS.escape(box.dataset.author)+'"]').value=folder});invalidateClassificationPreview()}
async function previewAuthorClassification(){const rules=selectedAuthorRules();const r=await fetch('/api/author-categories/preview',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({minCount:10,rules})});const data=await r.json();if(!r.ok){alert(data.error||r.status);return}classificationPreview=data;el('classificationPreview').textContent='将保存 '+data.rules.length+' 条作者规则，移动 '+data.moveCount+' 个根目录视频。\\n已在分类目录：'+data.alreadyClassifiedCount+'；文件缺失：'+data.missingCount+'；目标重名：'+data.collisionCount+'。'+(data.collisionCount?'\\n重名文件会自动保留并追加序号，不会覆盖。':'');el('applyClassification').disabled=false}
async function applyAuthorClassification(){if(!classificationPreview)return;if(!confirm('确认按预览结果整理视频？文件会移动到 Video 下的分类目录，但不会删除。'))return;el('applyClassification').disabled=true;const r=await fetch('/api/author-categories/apply',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({minCount:10,rules:selectedAuthorRules()})});const data=await r.json();if(!r.ok){alert(data.error||r.status);return}alert('整理完成：移动 '+data.moved+' 个，跳过 '+data.skipped+' 个，缺失 '+data.missing+' 个，失败 '+data.errors.length+' 个。');closeAuthorClassification();await load()}
function setState(value){el('stateFilter').value=value;page=1;load()}
 function render(){
  el('cards').innerHTML='<button class="card '+(el('stateFilter').value==='all'?'active':'')+'" onclick="setState(\\'all\\')"><b>'+summaryData.total+'</b>全部记录</button>'+
    Object.entries(summaryData.counts).map(([k,v])=>'<button class="card '+(el('stateFilter').value===k?'active':'')+'" onclick="setState(\\''+k+'\\')"><b>'+v+'</b>'+esc(stateNames[k]||k)+'</button>').join('');
  const currents=summaryData.currents||[];
  el('current').innerHTML=currents.map((t,index)=>{const p=progressText(t);return '<div class="current">活动任务 '+(index+1)+' / '+summaryData.maxConcurrentTasks+'：<b>'+esc(t.title||t.videoId)+'</b> · '+esc(t.message)+'<div class="muted">'+esc(p.text)+'</div><div class="progress"><i style="width:'+p.pct+'%"></i></div></div>'}).join('');
  const presence=summaryData.webPresence||{};const presenceText=presence.active?'网页已激活（'+Number(presence.clients||1)+' 个页面）':'后台常驻（网页关闭仍可访问）';el('presenceStatus').textContent='后台状态：'+presenceText;
  const m=summaryData.metadataCounts||{},v=summaryData.viewCounts||{},g=summaryData.tagCounts||{},remaining=Number(m.pending||0)+Number(m.retry||0)+Number(m.enriching||0),baseEnrichmentEnabled=summaryData.importedMetadataEnrichmentEnabled!==false;
  const metadataNow=(summaryData.metadataCurrents||[]).map(t=>t.videoId).join('、');
  const baseLine=baseEnrichmentEnabled?'已有文件基础资料：已补齐 <b>'+Number(m.complete||0)+'</b> · 待处理 '+remaining+' · 失败 '+Number(m.failed||0)+(metadataNow?' · 当前 '+esc(metadataNow):'')+'<br>':'已有文件基础资料：已暂停，不再占用下载队列<br>';
  el('metadataProgress').innerHTML=(remaining||m.failed||v.missing||g.missing||!baseEnrichmentEnabled)?'<div class="current">'+baseLine+'播放量：已同步 <b>'+Number(v.complete||0)+'</b> · 缺失 '+Number(v.missing||0)+' · 排队 '+Number(v.pending||0)+' · 同步失败 '+Number(v.failed||0)+'<br>标签：已同步 <b>'+Number(g.complete||0)+'</b> · 缺失 '+Number(g.missing||0)+' · 排队 '+Number(g.pending||0)+' · 同步失败 '+Number(g.failed||0)+'<div class="muted">下载最多 '+summaryData.maxConcurrentDownloads+' 个；资料补齐最多 '+summaryData.maxConcurrentMetadataTasks+' 个，二者互不占用。</div></div>':'';
  const pages=Math.max(1,Math.ceil(ledger.total/pageSize));page=Math.min(page,pages);
  el('rows').innerHTML=ledger.tasks.length?ledger.tasks.map(t=>'<tr><td data-label="状态" class="'+esc(t.state)+'">'+esc(stateNames[t.state]||t.state)+'</td>'+
    '<td data-label="标题" class="title"><b>'+esc(t.title||'标题尚未取得')+'</b><div class="muted">'+esc(t.videoId)+'</div></td>'+
    '<td data-label="作者">'+esc(authorText(t))+'</td><td data-label="上传">'+esc(dateText(t.uploadTime))+'</td><td data-label="记录">'+esc(dateText(t.updatedAt))+'</td>'+
    '<td data-label="文件" class="'+esc(t.fileStatus||'unknown')+'">'+esc(fileNames[t.fileStatus]||'—')+'<div class="muted">'+esc(bytes(t.actualFileSize||t.totalLength))+'</div></td>'+
    '<td data-label="尝试">'+Number(t.attempts||0)+'</td><td data-label="说明" title="'+esc(t.message)+'"><span class="ledger-message">'+esc(t.message)+'</span>'+(t.metadataMessage?'<div class="muted">元数据：'+esc(t.metadataMessage)+'</div>':'')+(t.lastErrorCategory?'<div class="muted">错误分类：'+esc(errorNames[t.lastErrorCategory]||t.lastErrorCategory)+'</div>':'')+'</td><td data-label="操作"><div class="actions">'+
    (t.state==='completed'?'<a href="/playlist?play='+encodeURIComponent(t.id)+'&view=focus" target="_blank"><button>播放</button></a> ':'')+
    (t.sourcePage?'<a href="'+esc(t.sourcePage)+'" target="_blank"><button>打开原网页</button></a> ':'')+
    (t.state==='failed'?'<button onclick="retry(\\''+t.id+'\\')">重试</button>':'')+
    (t.state==='completed'&&t.fileStatus&&t.fileStatus!=='present'?'<button onclick="redownload(\\''+t.id+'\\')">重新下载</button>':'')+'</div></td></tr>').join(''):
    '<tr><td colspan="10" class="empty">没有符合条件的记录</td></tr>';
  el('summary').textContent='共 '+ledger.total+' 条 · 第 '+page+' / '+pages+' 页';
  el('previous').disabled=page<=1;el('next').disabled=page>=pages;
}
async function load(){if(loading){pendingLoad=true;return}loading=true;try{
  const params=new URLSearchParams({query:el('query').value.trim(),state:el('stateFilter').value,author:el('authorFilter').value,sort:el('sortBy').value,direction:el('direction').value,page:String(page),pageSize:String(pageSize)});
  [summaryData,ledger]=await Promise.all([(await fetch('/api/status')).json(),(await fetch('/api/ledger?'+params)).json()]);
  const oldState=el('stateFilter').value;el('stateFilter').innerHTML='<option value="all">全部状态</option>'+Object.keys(summaryData.counts).map(k=>'<option value="'+esc(k)+'">'+esc(stateNames[k]||k)+'</option>').join('');el('stateFilter').value=oldState;
  const oldAuthor=el('authorFilter').value;el('authorFilter').innerHTML='<option value="all">全部作者</option>'+ledger.authors.map(a=>'<option value="'+esc(a.author)+'">'+esc(a.alias?a.alias+' (@'+a.author+')':a.author)+' · '+a.count+'</option>').join('');el('authorFilter').value=ledger.authors.some(a=>a.author===oldAuthor)?oldAuthor:'all';
  render();}finally{loading=false;if(pendingLoad){pendingLoad=false;load()}}
}
el('query').addEventListener('input',()=>{clearTimeout(inputTimer);inputTimer=setTimeout(()=>{page=1;load()},250)});
['stateFilter','authorFilter','sortBy','direction'].forEach(id=>el(id).addEventListener('change',()=>{page=1;load()}));
el('previous').onclick=()=>{if(page>1){page--;load()}};el('next').onclick=()=>{page++;load()};
const retryTools=document.querySelector('.control-panel-tools');if(retryTools){const wrap=document.createElement('div');wrap.className='retry-category-tools';wrap.innerHTML='<select id="retryCategory" aria-label="失败分类"><option value="all">全部失败</option><option value="source_exhausted">链接耗尽</option><option value="source_unavailable">无可用 Source</option><option value="video_missing">视频接口确认不存在</option><option value="permission_denied">视频访问权限不足</option><option value="cdn_not_found">CDN 链接失效</option><option value="link_expired">签名链接过期</option><option value="rate_limited">请求限流</option><option value="invalid_media">空文件或错误页</option><option value="not_found">旧记录：资源未找到</option><option value="access_or_expired">旧记录：地址拒绝或过期</option><option value="network">网络错误</option><option value="timeout">超时</option></select><button onclick="retryFailedCategory()">按分类重试</button>';retryTools.append(wrap)}${presenceClientScript("dashboard")}load();loadQuickLanLinks();setInterval(load,2000)</script></main></html>`;
}

function playlistHtml() {
  return `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="idm-disable" content="true">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>Iwara 本地播放列表</title>
<style>
*{box-sizing:border-box}body{margin:0;background:#f2f6fb;color:#26374d;font:14px/1.5 "Segoe UI","Microsoft YaHei",system-ui}header{position:sticky;top:0;z-index:5;background:rgba(255,255,255,.96);border-bottom:1px solid #dce6f1;padding:14px 24px;display:flex;gap:16px;align-items:center;flex-wrap:wrap}header h1{font-size:21px;color:#17365f;margin:0 12px 0 0}header input{width:min(420px,60vw)}input,select,button{font:inherit;border:1px solid #cad8e8;border-radius:9px;background:#fff;color:#30445e;padding:9px 11px;min-height:38px}button{cursor:pointer;font-weight:600}button:hover{border-color:#5b8def;background:#eef5ff}.layout{max-width:1600px;margin:0 auto;padding:22px;display:grid;grid-template-columns:minmax(0,1fr) 390px;gap:20px}.layout.focus-player{grid-template-columns:minmax(0,1fr)}.layout.focus-player>section{display:none}.layout.focus-player .player{position:relative;top:0;width:min(1120px,100%);margin:0 auto;padding:18px}.layout.focus-player .player video{max-height:calc(100vh - 220px);object-fit:contain}.layout.focus-player .upnext{max-height:300px;overflow:auto}.toolbar{display:flex;gap:9px;align-items:center;flex-wrap:wrap;margin-bottom:16px}.toolbar .count{margin-left:auto;color:#71829a}.page-info{color:#71829a;white-space:nowrap}.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(210px,1fr));gap:15px}.card{background:#fff;border:1px solid #d9e4f0;border-radius:13px;overflow:hidden;cursor:pointer;box-shadow:0 4px 15px rgba(52,85,123,.07);transition:.15s}.card:hover,.card.active{border-color:#5b8def;transform:translateY(-2px);box-shadow:0 8px 22px rgba(49,101,185,.16)}.thumb{aspect-ratio:16/9;background:#dce8f4;position:relative;overflow:hidden}.thumb video{width:100%;height:100%;object-fit:cover;display:block}.badge{position:absolute;right:8px;bottom:7px;background:rgba(20,45,75,.75);color:#fff;padding:2px 6px;border-radius:5px;font-size:11px}.watch-badge{position:absolute;left:8px;bottom:7px;background:rgba(34,116,84,.86);color:#fff;padding:2px 6px;border-radius:5px;font-size:11px}.watch-badge.unwatched{background:rgba(72,92,120,.86)}.card-body{padding:10px 11px}.card-title{font-weight:700;color:#203957;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.meta{color:#72839a;font-size:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;margin-top:4px}.card-progress{height:4px;background:#e4edf7;border-radius:4px;overflow:hidden;margin-top:7px}.card-progress i{display:block;height:100%;background:#5b8def}.empty{padding:50px;text-align:center;color:#7a899d;background:#fff;border:1px dashed #cbd8e6;border-radius:14px}.player{position:sticky;top:82px;background:#fff;border:1px solid #d9e4f0;border-radius:15px;padding:13px;box-shadow:0 5px 20px rgba(52,85,123,.1);height:max-content}.player video{display:block;width:100%;aspect-ratio:16/9;background:#dce8f4;border-radius:10px}.player h2{font-size:18px;line-height:1.35;margin:13px 0 6px;color:#17365f}.player-meta{color:#657890;display:flex;flex-wrap:wrap;gap:7px 13px}.player-actions{display:flex;gap:7px;margin-top:12px;flex-wrap:wrap}.player-state{margin-top:10px;padding:8px 10px;background:#f2f7ff;border-radius:8px;color:#536985}.player-error{margin-top:10px;padding:9px 10px;background:#fff3f1;border:1px solid #f0c4bd;border-radius:8px;color:#ad3f31;white-space:pre-wrap}.upnext{border-top:1px solid #e6edf5;margin-top:15px;padding-top:12px}.upnext h3{margin:0 0 9px;font-size:14px;color:#36516f}.next-row{display:flex;gap:9px;padding:7px 4px;border-radius:8px;cursor:pointer}.next-row:hover{background:#eef5ff}.next-row video{width:92px;height:52px;aspect-ratio:auto;border-radius:5px;object-fit:cover}.next-row b{display:block;font-size:12px;line-height:1.35;max-height:34px;overflow:hidden}.next-row span{display:block;color:#7a899d;font-size:11px}.status{margin:10px 0;color:#71829a;font-size:12px;min-height:18px}.load-sentinel{height:1px;width:100%;pointer-events:none}.load-sentinel[hidden]{display:none}[id*="idm" i],[class*="idm" i],[id*="internet-download-manager" i],[class*="internet-download-manager" i]{display:none!important}@media(max-width:1050px){.layout{grid-template-columns:1fr}.player{position:relative;top:0;grid-row:1}.grid{grid-template-columns:repeat(auto-fill,minmax(190px,1fr))}}@media(max-width:600px){header{position:relative;top:auto;z-index:auto;padding:12px 14px}.layout{padding:14px}.grid{grid-template-columns:repeat(2,minmax(0,1fr));gap:10px}.card-body{padding:8px}.player{padding:9px}}</style>
 <style>.single-mode header{justify-content:flex-start}.single-mode header input,.single-mode header select,.single-mode header #randomPage,.single-mode header #queueViews,.single-mode header #scriptLink,header #queueViews,header #refreshAllViews,header #queueTags,header #refreshAllTags,header #scriptLink{display:none}.single-mode .layout{padding-top:14px}.single-mode .player{box-shadow:0 8px 28px rgba(52,85,123,.12)}.selection-controls,.card-select{display:none}body:not(.single-mode) #layout>.player,body:not(.single-mode) #toggleView{display:none}body:not(.single-mode) .layout{display:block}.mode-badge{display:inline-flex;align-items:center;padding:5px 9px;border-radius:999px;background:#eef5ff;color:#36516f;font-size:12px;font-weight:700}.mode-badge.remote{background:#fff3df;color:#8b5b08}.next-row.compact-row{align-items:center;border:1px solid #e6edf5;margin:4px 0;padding:8px 10px}.next-row.compact-row .compact-index{min-width:30px;color:#71829a}.thumb .cover-image{position:absolute;inset:0;width:100%;height:100%;object-fit:cover;z-index:1}.thumb .cover-fallback{position:absolute;inset:0;display:grid;place-items:center;color:#637a96;font-size:12px}.thumb .cover-fallback[hidden]{display:none}.thumb .badge,.thumb .watch-badge{z-index:2}.card-select{position:absolute;left:8px;top:8px;width:23px;height:23px;margin:0;z-index:4;accent-color:#4d83e6;cursor:pointer}.card.selected{border-color:#4d83e6;box-shadow:0 0 0 2px rgba(77,131,230,.18),0 8px 22px rgba(49,101,185,.16)}.selection-controls{display:inline-flex;gap:7px;align-items:center;flex-wrap:wrap}.selection-count{color:#71829a;white-space:nowrap}.tag-cloud{display:flex;gap:7px;align-items:center;flex-wrap:wrap;margin:8px 0 14px;padding:10px 12px;background:#f8fbff;border:1px solid #dfe8f3;border-radius:12px}.tag-cloud-label{color:#637a96;font-size:12px;font-weight:700;margin-right:2px}.tag-chip{border-radius:999px;padding:5px 10px;min-height:30px;font-size:12px;background:#fff;color:#36516f}.tag-chip.active{background:#eaf3ff;border-color:#5b8def;color:#1e5fae}</style>
<header><h1><a id="pageTitle" class="library-home-link" href="/playlist" title="返回播放列表首页">Iwara 本地播放列表</a></h1><span id="qualityMode" class="mode-badge"></span><button id="qualityToggle" type="button">切换画质</button><input id="query" placeholder="搜索标题、作者、标签或视频 ID"><select id="sort"><option value="updatedAt">最近下载</option><option value="title">标题</option><option value="author">作者</option><option value="uploadTime">上传日期</option><option value="views">播放量</option></select><select id="direction"><option value="desc">降序</option><option value="asc">升序</option></select><select id="watchedFilter" aria-label="观看状态"><option value="all">全部观看状态</option><option value="unwatched">未看完</option><option value="watched">已看完</option></select><button id="toggleView" type="button" aria-pressed="false">大播放视角</button><button id="randomPage" type="button">随机一页（30）</button><a href="/recommend" id="recommendLink"><button type="button">随机推荐</button></a><button id="queueViews" type="button">同步缺失播放量</button><button id="refreshAllViews" type="button">更新全部播放量</button><button id="queueTags" type="button">同步缺失标签</button><button id="refreshAllTags" type="button">更新全部标签</button><a href="/" target="_blank" id="ledgerLink"><button type="button">下载台账</button></a><a href="/IwaraResilientQueue.user.js" target="_blank" id="scriptLink"><button type="button">更新网页脚本</button></a></header><div id="tagCloud" class="tag-cloud" hidden></div>
 <div id="layout" class="layout"><section><div class="toolbar"><button id="refresh" type="button">刷新列表</button><button id="loadMore" type="button" hidden>加载更多</button><button id="selectionModeToggle" class="selection-mode-toggle" type="button" aria-pressed="false">批量下载</button><span class="selection-controls"><button id="selectAll" type="button">全选已加载</button><button id="clearSelection" type="button">清空选择</button><button id="downloadSelected" type="button" disabled>下载选中（0）</button><button id="exitSelection" type="button">完成</button><span id="selectionCount" class="selection-count">可勾选后保存本地文件</span></span><span class="count" id="count"></span><span class="page-info" id="pageInfo"></span></div><div id="grid" class="grid"></div><div id="status" class="status"></div><div id="loadSentinel" class="load-sentinel" hidden aria-hidden="true"></div></section><aside class="player"><video id="mainVideo" controls playsinline preload="metadata"></video><div id="audioOnlyBar" class="audio-only-bar" hidden><button id="audioPlayToggle" type="button">播放</button><input id="audioSeek" type="range" min="0" max="0" step="0.1" value="0" aria-label="音频播放进度"><span id="audioTime" class="audio-only-time">0:00 / 0:00</span></div><h2 id="mainTitle">选择一个视频开始播放</h2><div id="mainMeta" class="player-meta">本地文件播放 · 不依赖 Iwara 页面</div><div id="playerState" class="player-state" hidden></div><div id="playerError" class="player-error" hidden></div><div class="player-actions"><button id="resumeBtn" type="button" disabled>继续播放</button><button id="markBtn" type="button" disabled>标记已看完</button><button id="openPage" type="button" disabled>打开原网页</button><button id="prevBtn" type="button" disabled>播放上一个</button><button id="nextBtn" type="button" disabled>播放下一个</button><button id="playModeToggle" type="button" title="循环切换播放策略">播放模式：顺序播放</button></div><div class="upnext"><h3>相邻视频 <small>上下滑动加载，每次 4 条</small></h3><div id="upnext"></div></div></aside></div>
 <script>
${authBootstrapScript()}
 if(window.IntersectionObserver){const _IwaraIntersectionObserver=window.IntersectionObserver;window.IntersectionObserver=class extends _IwaraIntersectionObserver{constructor(callback,options={}){super(callback,{...options,rootMargin:'120px 0px'})}}}
const _pageJumpStyle=document.createElement('style');_pageJumpStyle.textContent='.page-jump{display:inline-flex;align-items:center;gap:5px;color:#71829a;white-space:nowrap}.page-jump input{width:64px;min-height:34px;padding:6px 8px;text-align:center}';document.head.append(_pageJumpStyle);const _downloadUiStyle=document.createElement('style');_downloadUiStyle.textContent='body:not(.selection-mode) .selection-controls,body:not(.selection-mode) .card-select{display:none!important}.selection-mode-toggle{display:none!important}@media(max-width:600px){.selection-mode-toggle{display:inline-flex!important;min-height:34px;padding:7px 10px}.selection-mode .card-select{display:block!important}.selection-mode .selection-controls{position:fixed;left:10px;right:10px;bottom:calc(8px + env(safe-area-inset-bottom,0px));z-index:40;display:grid!important;grid-template-columns:repeat(4,minmax(0,1fr));gap:6px;padding:9px;border:1px solid #cad8e8;border-radius:16px;background:rgba(255,255,255,.97);box-shadow:0 8px 30px rgba(27,52,83,.25);backdrop-filter:blur(12px)}.selection-mode .selection-controls button{min-width:0;min-height:35px;padding:6px 4px;font-size:12px;white-space:nowrap}.selection-mode #selectAll{grid-column:span 2}.selection-mode #downloadSelected{grid-column:span 2}.selection-mode #exitSelection{grid-column:4}.selection-mode .selection-count{grid-column:1/-1;text-align:center;font-size:12px}.selection-mode{padding-bottom:130px}}@media(prefers-color-scheme:dark) and (max-width:600px){.selection-mode .selection-controls{background:rgba(32,34,39,.97);border-color:#3d4654}.selection-mode .selection-controls button{background:#121417;color:#d8e6ff;border-color:#3d4654}}';document.head.append(_downloadUiStyle);const _batchDownloadStatusStyle=document.createElement('style');_batchDownloadStatusStyle.textContent='@media(max-width:600px){.selection-mode #status:not(:empty){position:fixed;left:12px;right:12px;bottom:calc(96px + env(safe-area-inset-bottom,0px));z-index:41;margin:0;padding:10px 12px;border:1px solid #cbd8e8;border-radius:12px;background:rgba(255,255,255,.97);box-shadow:0 4px 18px rgba(27,52,83,.2);color:#30445e;font-size:13px}}@media(prefers-color-scheme:dark) and (max-width:600px){.selection-mode #status:not(:empty){background:rgba(32,34,39,.97);border-color:#3d4654;color:#d8e6ff}}';document.head.append(_batchDownloadStatusStyle);
const _pageInfoNode=document.getElementById('pageInfo');
const _mobilePageToggle=document.createElement('button');_mobilePageToggle.id='mobilePageToggle';_mobilePageToggle.type='button';_mobilePageToggle.hidden=true;_mobilePageToggle.setAttribute('aria-expanded','false');_mobilePageToggle.setAttribute('aria-controls','pageJumpControls');_mobilePageToggle.title='点击跳转页码';_pageInfoNode?.before(_mobilePageToggle);
const playlistPageSize=()=>window.matchMedia('(max-width:600px)').matches?20:30;
const _libraryFilterNode=document.createElement('select');_libraryFilterNode.id='libraryFilter';_libraryFilterNode.setAttribute('aria-label','我的列表');_libraryFilterNode.innerHTML='<option value="all">全部视频（不含丢弃）</option><option value="later">稍后观看</option><option value="favorite">喜爱收藏</option><option value="queued">播放队列</option><option value="discarded">已丢弃（找回）</option>';document.getElementById('watchedFilter')?.after(_libraryFilterNode);
const _continueOption=document.querySelector('#watchedFilter option[value="unwatched"]');if(_continueOption)_continueOption.textContent='继续观看';
const _playlistExtraStyle=document.createElement('style');_playlistExtraStyle.textContent='.filter-link{border:0;background:transparent;color:#4d76ae;padding:0;min-height:0;border-radius:0;font-size:inherit;font-weight:600;vertical-align:baseline}.filter-link:hover{border-color:transparent;background:transparent;text-decoration:underline}.tag-links{display:inline-flex;gap:4px;flex-wrap:wrap;vertical-align:middle}.tag-links .filter-link{font-weight:500}.card-actions{display:flex;gap:5px;margin-top:8px}.card-actions button{min-height:30px;padding:5px 8px;font-size:12px;flex:1}.card-actions button.active,.player-actions button.active{color:#1e5fae;background:#eaf3ff;border-color:#5b8def}.layout.audio-only .player video{position:absolute;left:-10000px;width:1px;height:1px;opacity:0;pointer-events:none}';document.head.append(_playlistExtraStyle);
const _cardTagLayoutStyle=document.createElement('style');_cardTagLayoutStyle.textContent='.tag-meta{display:-webkit-box;height:34px;min-height:34px;max-height:34px;line-height:17px;white-space:normal;overflow:hidden;overflow-wrap:anywhere;-webkit-box-orient:vertical;-webkit-line-clamp:2}.tag-meta .tag-links{display:inline;gap:0;flex-wrap:initial;vertical-align:baseline}.tag-meta .filter-link{display:inline;max-width:100%;min-height:0;padding:0;line-height:inherit;white-space:normal;overflow-wrap:anywhere}';document.head.append(_cardTagLayoutStyle);
const _mobileCompactStyle=document.createElement('style');_mobileCompactStyle.textContent='@media(max-width:600px){header{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:8px;padding:10px 12px;align-items:center}header h1{grid-column:1;font-size:18px;margin:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}header .mode-badge{grid-column:2;white-space:nowrap}header #qualityToggle{grid-column:1/-1;width:100%;min-height:34px;padding:7px 9px}header input{grid-column:1/-1;width:100%;min-width:0}header #authorFilter{grid-column:1/-1;width:100%;min-width:0}header select{min-width:0;width:100%;padding:8px 9px}header #randomPage,header #queueViews,header #refreshAllViews,header #queueTags,header #refreshAllTags,header #ledgerLink,header #scriptLink{display:none!important}.tag-cloud{margin:7px 0 10px;padding:7px 8px;gap:6px;flex-wrap:nowrap;overflow-x:auto;overflow-y:hidden;max-height:50px;white-space:nowrap;scrollbar-width:thin}.tag-cloud-label{position:sticky;left:0;z-index:1;flex:0 0 auto;padding:5px 5px 5px 1px;background:inherit}.tag-chip{flex:0 0 auto;min-height:30px;padding:5px 9px}.toolbar{gap:6px;margin-bottom:10px}.toolbar #refresh,.toolbar #loadMore{min-height:34px;padding:7px 9px}.toolbar .count{margin-left:auto;font-size:12px}.page-info{font-size:12px}.page-jump{font-size:12px}.page-jump input{width:48px;min-height:32px}.grid{gap:8px}.card-body{padding:7px 8px}.card-actions{gap:4px}.card-actions button{font-size:11px;padding:4px 5px;min-height:28px}.meta{font-size:11px}.card-progress{margin-top:5px}}';document.head.append(_mobileCompactStyle);
const _authorFilterNode=document.createElement('select');_authorFilterNode.id='authorFilter';_authorFilterNode.setAttribute('aria-label','作者筛选');_authorFilterNode.innerHTML='<option value="all">全部作者</option>';document.getElementById('query')?.after(_authorFilterNode);
const _mobileLayoutStyle=document.createElement('style');_mobileLayoutStyle.textContent='@media(max-width:600px){header{position:sticky;top:0;z-index:20;display:grid;grid-template-columns:minmax(0,1fr) auto;gap:8px;padding:10px 12px;background:rgba(255,255,255,.96);backdrop-filter:blur(12px);border-bottom:1px solid #dce6f1}header h1{font-size:18px;line-height:1.2;margin:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}header .mode-badge{grid-column:2;white-space:nowrap}header #qualityToggle{grid-column:1/-1;width:100%;min-height:36px;padding:7px 10px}header>#query,header>#authorFilter,header>#sort,header>#direction,header>#watchedFilter,header>#libraryFilter{display:none!important}#mobileAppBar{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:7px;padding:8px 12px;background:rgba(248,251,255,.98);border-bottom:1px solid #dce6f1}#mobileAppBar button{min-height:36px;padding:6px 8px;font-size:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}#mobileFilterSummary{grid-column:1/-1;color:#71829a;font-size:11px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;padding:0 2px}#mobileFilterPanel{display:none;margin:8px 12px;padding:11px;border:1px solid #d9e4f0;border-radius:16px;background:rgba(255,255,255,.98);box-shadow:0 12px 28px rgba(52,85,123,.15)}#mobileFilterPanel.open{display:block}#mobileFilterPanel .mobile-filter-head{display:flex;align-items:center;justify-content:space-between;margin-bottom:9px}#mobileFilterPanel h2{font-size:14px;margin:0;color:#17365f}#mobileFilterPanel .mobile-filter-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:7px}#mobileFilterPanel .mobile-filter-item{display:flex;flex-direction:column;gap:4px;color:#71829a;font-size:11px;min-width:0}#mobileFilterPanel .mobile-filter-item:first-child,#mobileFilterPanel .mobile-filter-item:nth-child(2){grid-column:1/-1}#mobileFilterPanel input,#mobileFilterPanel select{width:100%;min-width:0;min-height:36px;padding:7px 9px;background:#fff;color:#30445e;border-color:#cad8e8}#mobileFilterPanel .mobile-filter-actions{display:flex;justify-content:flex-end;gap:7px;margin-top:10px}#mobileFilterPanel .mobile-filter-actions button{min-height:34px;padding:6px 10px;font-size:12px}.tag-cloud{margin:7px 0 9px;padding:7px 8px;gap:6px;max-height:49px;flex-wrap:nowrap;overflow-x:auto;overflow-y:hidden;white-space:nowrap;border-radius:14px}.tag-cloud.expanded{max-height:118px;flex-wrap:wrap;white-space:normal;overflow-y:auto}.tag-cloud-label{position:sticky;left:0;z-index:1;flex:0 0 auto;padding:5px 5px 5px 1px;background:inherit}.tag-chip{flex:0 0 auto;min-height:29px;padding:5px 9px}.toolbar{gap:6px;margin-bottom:9px}.toolbar #refresh,.toolbar #loadMore{min-height:34px;padding:7px 9px}.toolbar .count{margin-left:auto;font-size:11px}.page-info,.page-jump{font-size:11px}.page-jump input{width:42px;min-height:32px}.grid{gap:8px}.card{border-radius:17px}.card-body{padding:7px 8px}.card-title{font-size:13px}.card-actions{gap:4px}.card-actions button{min-width:0;min-height:29px;padding:4px 2px;font-size:0;white-space:nowrap;overflow:hidden}.card-actions button::after{font-size:11px}.card-actions button[data-action=favorite]::after{content:"☆"}.card-actions button[data-action=later]::after{content:"稍后"}.card-actions button[data-action=queue]::after{content:"队列"}.card-actions button.active[data-action=favorite]::after{content:"★"}.card-actions button.active[data-action=later]::after{content:"已稍后"}.card-actions button.active[data-action=queue]::after{content:"队列中"}.meta{font-size:11px}.card-progress{margin-top:5px}}@media(min-width:601px){#mobileAppBar,#mobileFilterPanel{display:none!important}}';document.head.append(_mobileLayoutStyle);
const _tabletTagCloudStyle=document.createElement('style');_tabletTagCloudStyle.textContent='@media(min-width:601px) and (max-width:900px){.tag-cloud{max-height:50px;flex-wrap:nowrap;overflow-x:auto;overflow-y:hidden;white-space:nowrap;scrollbar-width:thin}.tag-cloud-label{position:sticky;left:0;z-index:1;flex:0 0 auto;background:inherit}.tag-chip{flex:0 0 auto}}';document.head.append(_tabletTagCloudStyle);
const _mobileDarkStyle=document.createElement('style');_mobileDarkStyle.textContent='@media(prefers-color-scheme:dark) and (max-width:600px){body{background:#1d1f23;color:#d8e6ff}header{background:rgba(22,24,28,.96);border-bottom-color:rgba(148,163,184,.22)}header h1{color:#d8e6ff}#mobileAppBar{background:rgba(28,30,35,.96);border-bottom-color:rgba(148,163,184,.18)}#mobileAppBar button,#mobileFilterPanel button{background:#121417;color:#d8e6ff;border-color:#3d4654}#mobileFilterPanel{background:rgba(32,34,39,.98);border-color:rgba(148,163,184,.3)}#mobileFilterPanel h2{color:#d8e6ff}#mobileFilterPanel .mobile-filter-item{color:#91a4bf}#mobileFilterPanel input,#mobileFilterPanel select{background:rgba(20,22,26,.95);color:#d8e6ff;border-color:rgba(148,163,184,.35)}#mobileFilterSummary{color:#8ea0bb}.tag-cloud{background:#202226;border-color:#3d4654}.tag-chip{background:#121417;color:#d8e6ff;border-color:#3d4654}.toolbar button,.page-jump input,.page-jump button{background:#121417;color:#d8e6ff;border-color:#3d4654}.card{background:#15171b;border-color:#3d4654}.card-title{color:#d8e6ff}.meta,.toolbar .count,.page-info,.page-jump{color:#9db0ca}.card-progress{background:#2a3442}}';document.head.append(_mobileDarkStyle);
const _mobileStreamlineStyle=document.createElement('style');_mobileStreamlineStyle.textContent='@media(max-width:600px){header .mode-badge{display:none!important}header #qualityToggle{grid-column:2;width:auto;max-width:132px;min-height:36px;padding:6px 9px;font-size:12px;white-space:nowrap}#mobileSearchBar{display:block;padding:7px 12px 4px;background:#f2f6fb}#mobileSearchBar input{display:block;width:100%;min-width:0;min-height:42px;padding:9px 12px;border-radius:12px}body.single-mode #mobileSearchBar{display:none!important}#mobileAppBar{grid-template-columns:repeat(3,minmax(0,1fr));padding:6px 12px}#mobileAppBar button{min-height:40px}#mobileFilterSummary{padding-top:1px}#tagCloud[hidden]{display:none!important}.toolbar #refresh,.toolbar #loadMore{display:none!important}.toolbar{margin-top:2px}.card-actions{display:block}.card-quick-actions{grid-template-columns:repeat(2,minmax(0,1fr))}.card-actions button{min-height:44px!important}.card-actions button[data-action=later],.card-actions button[data-action=queue]{display:none!important}}@media(prefers-color-scheme:dark) and (max-width:600px){#mobileSearchBar{background:#1d1f23}#mobileSearchBar input{background:#121417;color:#d8e6ff;border-color:#3d4654}}@media(min-width:601px){#mobileSearchBar{display:none!important}}';document.head.append(_mobileStreamlineStyle);
const _mobileDensityStyle=document.createElement('style');
_mobileDensityStyle.textContent='.library-home-link{display:block;color:inherit;font:inherit;text-decoration:none;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.library-home-link:focus-visible{outline:2px solid #6b99e8;outline-offset:3px;border-radius:4px}#selectionModeToggle{align-items:center;justify-content:center;text-align:center;line-height:1.25}#mobilePageToggle{display:none}'+
 '@media(max-width:600px){#mobileAppBar{grid-template-columns:repeat(2,minmax(0,1fr))}#mobileTagsToggle,#tagCloud{display:none!important}#mobileFilterSummary[hidden]{display:none!important}.card .card-actions,.card .tag-meta{display:none!important}.toolbar{display:grid;grid-template-columns:auto minmax(0,1fr) auto;align-items:center;gap:6px;margin:0 0 10px}.toolbar #selectionModeToggle{grid-column:1;grid-row:1;min-height:44px;padding:7px 10px;font-size:12px;white-space:nowrap}.toolbar .count{grid-column:2;grid-row:1;min-width:0;margin-left:0;text-align:right;font-size:11px;white-space:nowrap}.toolbar #pageInfo{display:none!important}.toolbar #mobilePageToggle{display:inline-flex;grid-column:3;grid-row:1;align-items:center;justify-content:center;min-height:44px;padding:7px 9px;font-size:12px;white-space:nowrap}.toolbar .page-jump{display:none!important;grid-column:1/-1;grid-row:2;justify-content:flex-end;margin-top:2px}.toolbar .page-jump.mobile-open{display:flex!important}.toolbar .page-jump[hidden],#mobilePageToggle[hidden]{display:none!important}.toolbar .page-jump input,.toolbar .page-jump button{min-height:40px}.toolbar .page-jump input{width:58px}}';
document.head.append(_mobileDensityStyle);
const _cardPresentationStyle=document.createElement('style');
_cardPresentationStyle.textContent='.thumb::after{content:"";position:absolute;left:0;right:0;bottom:0;height:40px;background:linear-gradient(transparent,rgba(0,0,0,.6));pointer-events:none;z-index:1}.thumb .watch-badge{left:auto;right:7px;top:7px;bottom:auto}.cover-image.portrait-cover{object-fit:contain!important}.card-view-count{position:absolute;left:8px;bottom:7px;z-index:2;display:inline-flex;align-items:center;gap:4px;color:#fff;font-size:12px;line-height:1.2;text-shadow:0 1px 3px rgba(0,0,0,.65);pointer-events:none}.card-view-count svg{width:14px;height:14px;flex:none}.card-title{display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:2;height:40px;line-height:20px;white-space:normal;overflow:hidden;overflow-wrap:anywhere}.card-author-row{display:flex;align-items:center;gap:4px;height:18px;line-height:18px}.card-author-row .card-author{display:block;min-width:0;max-width:100%;flex:0 1 auto;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;line-height:18px}.card-upload-date{flex:none;white-space:nowrap;color:inherit}@media(max-width:600px){.card-title{height:36px;line-height:18px}.card-author-row{font-size:10px}.card-view-count{font-size:11px}}';
document.head.append(_cardPresentationStyle);
const _mobileSingleStyle=document.createElement('style');_mobileSingleStyle.textContent='@media(max-width:600px){body.single-mode #mobileAppBar,body.single-mode #mobileFilterPanel{display:none!important}}';document.head.append(_mobileSingleStyle);
const _upnextScrollStyle=document.createElement('style');_upnextScrollStyle.textContent='.single-mode .layout.focus-player .upnext{height:360px;max-height:min(360px,48vh);overflow:auto;overscroll-behavior-y:contain;-webkit-overflow-scrolling:touch;touch-action:pan-y pinch-zoom;scrollbar-width:thin;scrollbar-gutter:stable}.upnext h3 small{margin-left:5px;color:#8292a7;font-size:11px;font-weight:400}.upnext-loading,.upnext-end{padding:7px 4px;color:#8292a7;font-size:11px;text-align:center}.next-row.compact-row{min-height:68px}';document.head.append(_upnextScrollStyle);
const _mobileDownloadStyle=document.createElement('style');_mobileDownloadStyle.textContent='.card-actions [data-action="download"]{display:none!important}@media(max-width:600px){.card-actions [data-action="download"]{display:block!important;min-width:0;padding:4px 2px;font-size:11px!important}}@media(prefers-color-scheme:dark) and (max-width:600px){.card-actions [data-action="download"]{background:#121417;color:#d8e6ff;border-color:#3d4654}}';document.head.append(_mobileDownloadStyle);
const _mobileSearchBar=document.createElement('div');_mobileSearchBar.id='mobileSearchBar';
const _mobileAppBar=document.createElement('div');_mobileAppBar.id='mobileAppBar';_mobileAppBar.innerHTML='<button id="mobileFilterToggle" type="button">筛选</button><button id="mobileRefresh" type="button">随机推荐</button><button id="mobileTagsToggle" type="button">标签</button><span id="mobileFilterSummary">全部视频</span>';
const _mobileFilterPanel=document.createElement('section');_mobileFilterPanel.id='mobileFilterPanel';_mobileFilterPanel.innerHTML='<div class="mobile-filter-head"><h2>筛选与排序</h2><button id="mobileFilterClose" type="button">关闭</button></div><div class="mobile-filter-grid"></div><div class="mobile-filter-actions"><button id="mobileFilterClear" type="button">清除筛选</button><button id="mobileFilterApply" type="button">完成</button></div>';
document.querySelector('header')?.after(_mobileSearchBar,_mobileAppBar,_mobileFilterPanel);
const _mobileFilterGrid=_mobileFilterPanel.querySelector('.mobile-filter-grid'),_mobileControlLabels={authorFilter:'作者',sort:'排序字段',direction:'顺序',watchedFilter:'观看状态',libraryFilter:'我的列表'},_mobileControlWrappers=new Map(),_mobileControlIds=Object.keys(_mobileControlLabels);
_mobileControlIds.forEach(id=>{const control=document.getElementById(id);if(!control||!_mobileFilterGrid)return;const wrapper=document.createElement('label');wrapper.className='mobile-filter-item';const caption=document.createElement('span');caption.textContent=_mobileControlLabels[id];wrapper.append(caption,control);_mobileFilterGrid.append(wrapper);_mobileControlWrappers.set(id,wrapper)});
const _placeMobileControls=()=>{const mobile=window.matchMedia('(max-width: 600px)').matches,desktopLibrary=document.body.classList.contains('desktop-library-ui');const header=document.querySelector('header'),query=document.getElementById('query');_mobileControlIds.forEach(id=>{const control=document.getElementById(id),wrapper=_mobileControlWrappers.get(id);if(!control||!wrapper)return;if(mobile){wrapper.hidden=false;if(control.parentElement!==wrapper)wrapper.append(control)}else{wrapper.hidden=true;if(!desktopLibrary&&control.parentElement!==header)header?.append(control)}});if(mobile){if(query?.parentElement!==_mobileSearchBar)_mobileSearchBar.append(query)}else if(!desktopLibrary&&query?.parentElement!==header)header?.insertBefore(query,document.getElementById('authorFilter'));};_placeMobileControls();window.addEventListener('resize',_placeMobileControls);
const _updateMobileFilterSummary=()=>{const bits=[];const query=document.getElementById('query')?.value.trim();const author=document.getElementById('authorFilter');const library=document.getElementById('libraryFilter');if(query)bits.push('搜索：'+query);if(author&&author.value!=='all')bits.push('作者：'+(author.selectedOptions[0]?.textContent||author.value));if(library&&library.value!=='all')bits.push(library.selectedOptions[0]?.textContent||'');const target=document.getElementById('mobileFilterSummary');if(target){target.textContent=bits.filter(Boolean).join(' · ')||'全部视频';target.hidden=bits.length===0}};
let _mobileTagsVisible=false;document.getElementById('mobileFilterToggle')?.addEventListener('click',()=>{_mobileFilterPanel.classList.toggle('open');_updateMobileFilterSummary()});document.getElementById('mobileFilterClose')?.addEventListener('click',()=>_mobileFilterPanel.classList.remove('open'));document.getElementById('mobileFilterApply')?.addEventListener('click',()=>_mobileFilterPanel.classList.remove('open'));document.getElementById('mobileRefresh')?.addEventListener('click',()=>{if(location.pathname==='/recommend')document.getElementById('refresh')?.click();else location.href='/recommend'});document.getElementById('mobileTagsToggle')?.addEventListener('click',()=>{_mobileTagsVisible=!_mobileTagsVisible;const cloud=document.getElementById('tagCloud');if(cloud){cloud.hidden=!_mobileTagsVisible;cloud.classList.toggle('expanded',_mobileTagsVisible)}document.getElementById('mobileTagsToggle').textContent=_mobileTagsVisible?'收起标签':'标签'});document.getElementById('mobileFilterClear')?.addEventListener('click',()=>{const q=document.getElementById('query'),a=document.getElementById('authorFilter'),s=document.getElementById('sort'),d=document.getElementById('direction'),w=document.getElementById('watchedFilter'),l=document.getElementById('libraryFilter');if(q)q.value='';if(a)a.value='all';if(s)s.value='updatedAt';if(d)d.value='desc';if(w)w.value='all';if(l)l.value='all';_updateMobileFilterSummary();_mobileFilterPanel.classList.remove('open');window.setTimeout(()=>window.dispatchEvent(new Event('iwara-mobile-filter-clear')),0)});document.getElementById('query')?.addEventListener('input',_updateMobileFilterSummary);_mobileControlIds.forEach(id=>document.getElementById(id)?.addEventListener('input',_updateMobileFilterSummary));_mobileControlIds.forEach(id=>document.getElementById(id)?.addEventListener('change',_updateMobileFilterSummary));
const _audioModeButton=document.createElement('button');_audioModeButton.id='audioModeToggle';_audioModeButton.type='button';_audioModeButton.textContent='仅音频：关';_audioModeButton.title='隐藏视频画面，只保留声音播放';document.querySelector('.player-actions')?.append(_audioModeButton);
const _playerActionRoot=document.querySelector('.player-actions');
if(_playerActionRoot){
  const primary=document.createElement('div');primary.className='player-primary-actions';primary.setAttribute('aria-label','主要播放操作');
  ['prevBtn','nextBtn','audioModeToggle'].forEach(id=>{const button=document.getElementById(id);if(button)primary.append(button)});
  const more=document.createElement('details');more.className='player-more-actions';
  more.innerHTML='<summary aria-label="展开更多播放器操作">更多操作</summary><div class="player-more-menu"><section class="player-more-group"><h3>播放与记录</h3><div id="playerPlaybackActions"></div></section><section class="player-more-group"><h3>收藏与管理</h3><div id="playerLibraryActions"></div></section></div>';
  ['resumeBtn','markBtn','openPage','playModeToggle'].forEach(id=>{const button=document.getElementById(id);if(button)more.querySelector('#playerPlaybackActions').append(button)});
  _playerActionRoot.replaceChildren(primary,more);
}
const _playerActionCardStyle=document.createElement('style');
_playerActionCardStyle.textContent='.player-actions{display:block;margin-top:12px}.player-primary-actions{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:8px;padding:10px;background:#f5f8fc;border:1px solid #dce6f1;border-radius:14px}.player-primary-actions button{min-width:0;min-height:44px;padding:8px 6px;line-height:1.25;white-space:normal}.player-more-actions{margin-top:8px;border:1px solid #dce6f1;border-radius:12px;background:#f8fbff;overflow:hidden}.player-more-actions>summary,.card-more-actions>summary{display:flex;align-items:center;justify-content:center;min-height:44px;padding:8px 12px;cursor:pointer;list-style:none;font-weight:600;color:#36516f}.player-more-actions>summary::-webkit-details-marker,.card-more-actions>summary::-webkit-details-marker{display:none}.player-more-actions>summary:after,.card-more-actions>summary:after{content:"＋";margin-left:7px;color:#71829a}.player-more-actions[open]>summary:after,.card-more-actions[open]>summary:after{content:"－"}.player-more-menu{display:grid;grid-template-columns:1fr;gap:7px;padding:8px;border-top:1px solid #e6edf5}.player-more-group h3{margin:2px 0 6px;color:#637a96;font-size:12px}.player-more-group>div{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:7px}.player-more-group+.player-more-group{padding-top:7px;border-top:1px solid #e6edf5}.player-more-menu button{min-width:0;min-height:44px;padding:8px}.card-actions{display:grid;grid-template-columns:minmax(0,1fr);gap:6px;margin-top:8px}.card-quick-actions{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:6px}.card-quick-actions button,.card-more-menu button{min-width:0;min-height:44px;padding:7px 5px}.card-more-actions{border:1px solid #dce6f1;border-radius:10px;background:#f8fbff;overflow:hidden}.card-more-menu{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:6px;padding:7px;border-top:1px solid #e6edf5}.card-more-menu button{font-size:12px} @media(prefers-color-scheme:dark) and (max-width:600px){.player-primary-actions,.player-more-actions,.card-more-actions{background:#202226;border-color:#3d4654}.player-primary-actions{background:#202226}.player-more-actions>summary,.card-more-actions>summary{color:#d8e6ff}.player-more-menu,.card-more-menu,.player-more-group+.player-more-group{border-top-color:#3d4654}.player-more-group h3{color:#9db0ca}.player-more-menu button,.card-quick-actions button,.card-more-menu button{background:#121417;color:#d8e6ff;border-color:#3d4654}.card-more-menu button{color:#d8e6ff}}';
document.head.append(_playerActionCardStyle);
const _favoriteButton=document.createElement('button');_favoriteButton.id='favoriteBtn';_favoriteButton.type='button';_favoriteButton.disabled=true;_favoriteButton.textContent='☆ 喜爱';document.querySelector('.player-actions')?.append(_favoriteButton);
const _laterButton=document.createElement('button');_laterButton.id='laterBtn';_laterButton.type='button';_laterButton.disabled=true;_laterButton.textContent='稍后观看';document.querySelector('.player-actions')?.append(_laterButton);
const _queueButton=document.createElement('button');_queueButton.id='queueBtn';_queueButton.type='button';_queueButton.disabled=true;_queueButton.textContent='加入队列';document.querySelector('.player-actions')?.append(_queueButton);
const _discardButton=document.createElement('button');_discardButton.id='discardBtn';_discardButton.type='button';_discardButton.disabled=true;_discardButton.textContent='丢弃此视频';_discardButton.title='从普通播放列表隐藏；不会删除文件，可在“已丢弃（找回）”中恢复';document.querySelector('.player-actions')?.append(_discardButton);
const _playerMoreMenu=document.querySelector('#playerLibraryActions');
if(_playerMoreMenu)['favoriteBtn','laterBtn','queueBtn','discardBtn'].forEach(id=>{const button=document.getElementById(id);if(button)_playerMoreMenu.append(button)});
const _audioOnlyControlStyle=document.createElement('style');_audioOnlyControlStyle.textContent='.audio-only-bar{display:none;align-items:center;gap:9px;width:100%;padding:9px 11px;background:#eef5ff;border:1px solid #d6e3f2;border-radius:10px}.audio-only-bar[hidden]{display:none!important}.audio-only-bar button{min-height:34px;padding:6px 10px}.audio-only-bar input[type=range]{flex:1;min-width:80px;accent-color:#4d83e6}.audio-only-time{min-width:92px;text-align:right;color:#637a96;font-size:12px;font-variant-numeric:tabular-nums}.layout.audio-only .player video{position:absolute;left:-10000px;width:1px;height:1px;opacity:0;pointer-events:none}.layout.audio-only .audio-only-bar{display:flex}';document.head.append(_audioOnlyControlStyle);
if(_pageInfoNode){const _jump=document.createElement('label');_jump.id='pageJumpControls';_jump.className='page-jump';_jump.innerHTML='跳到 <input id="pageInput" type="number" min="1" step="1" inputmode="numeric" aria-label="页码"><span>页</span><button id="pageJump" type="button">确定</button>';_pageInfoNode.after(_jump);const _pageInput=_jump.querySelector('#pageInput'),_pageJumpButton=_jump.querySelector('#pageJump');_mobilePageToggle.onclick=()=>{const open=_jump.classList.toggle('mobile-open');_mobilePageToggle.setAttribute('aria-expanded',String(open));if(open){_pageInput.focus();_pageInput.select()}};const _jumpToPage=()=>{const target=Number(_pageInput.value),max=Math.max(1,Math.ceil(Number(window.__iwaraTotalItems||0)/playlistPageSize()));if(!Number.isInteger(target)||target<1||target>max){_pageInput.setCustomValidity('请输入 1 到 '+max+' 之间的页码');_pageInput.reportValidity();return}_pageInput.setCustomValidity('');_jump.classList.remove('mobile-open');_mobilePageToggle.setAttribute('aria-expanded','false');window.__iwaraJumpPage=target;window.dispatchEvent(new CustomEvent('iwara-page-jump'))};_pageJumpButton.onclick=_jumpToPage;_pageInput.onkeydown=event=>{if(event.key==='Enter'){event.preventDefault();_jumpToPage()}};new MutationObserver(()=>{const current=Number(window.__iwaraCurrentPage||1);if(document.activeElement!==_pageInput)_pageInput.value=String(current)}).observe(_pageInfoNode,{subtree:true,childList:true,characterData:true});window.addEventListener('iwara-page-jump',()=>{const target=Number(window.__iwaraJumpPage);if(Number.isInteger(target))window.__iwaraSetPage?.(target)})}
// Plyr integration intentionally disabled for now.  Keeping the native
// <video controls> element avoids an extra wrapper and lets Chrome own
// fullscreen/Picture-in-Picture behavior without the custom-player overhead.
const $=id=>document.getElementById(id), esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])), date=v=>v?new Date(v).toLocaleDateString('zh-CN'):'—', views=v=>v==null?'播放量待同步':Number(v).toLocaleString('zh-CN')+' 次播放';
function formatByteSize(value){let size=Math.max(0,Number(value)||0);if(size<1024)return size+' B';const units=['KB','MB','GB','TB'];let unit=-1;do{size/=1024;unit++}while(size>=1024&&unit<units.length-1);return size.toFixed(size>=10?0:1)+' '+units[unit]}
function compactViewCount(value){if(value==null)return '待同步';const count=Math.max(0,Number(value)||0);if(count>=1e8)return (count/1e8).toFixed(1).replace('.0','')+'亿';if(count>=1e4)return (count/1e4).toFixed(1).replace('.0','')+'万';return count.toLocaleString('zh-CN')}
const routeParams=new URLSearchParams(location.search);
let sourceFilter=['iwara','han1'].includes(routeParams.get('source'))?routeParams.get('source'):'all';
const sourceSwitch=document.createElement('div');sourceSwitch.id='sourceFilter';sourceSwitch.className='source-switch';sourceSwitch.setAttribute('role','group');sourceSwitch.setAttribute('aria-label','视频来源');sourceSwitch.innerHTML='<span class="source-switch-label">来源</span>'+[['all','全部'],['iwara','Iwara'],['han1','Han1']].map(([value,label])=>'<button type="button" data-source="'+value+'" aria-pressed="'+(value===sourceFilter)+'">'+label+'</button>').join('');$('qualityMode')?.after(sourceSwitch);
const sourceSwitchStyle=document.createElement('style');sourceSwitchStyle.textContent='.source-switch{display:inline-flex;align-items:center;gap:3px;padding:3px;background:#edf3fa;border:1px solid #dce6f1;border-radius:12px;white-space:nowrap}.source-switch-label{padding:0 5px;color:#71829a;font-size:12px;font-weight:700}.source-switch button{min-height:31px;padding:4px 10px;border-color:transparent;background:transparent;color:#637a96;font-size:12px}.source-switch button.active{background:#fff;color:#1e5fae;border-color:#d5e3f3;box-shadow:0 1px 3px rgba(34,68,108,.08)}.single-mode header #sourceFilter{display:none!important}@media(max-width:600px){header #sourceFilter{grid-column:1/-1;width:100%;display:grid;grid-template-columns:auto repeat(3,minmax(0,1fr));gap:4px}.source-switch-label{display:grid;place-items:center}.source-switch button{min-height:34px;padding:4px 5px}}@media(prefers-color-scheme:dark){.source-switch{background:#24262b;border-color:#3d4654}.source-switch-label{color:#a7b3c4}.source-switch button{background:transparent;color:#b9c9e1}.source-switch button.active{background:#17191d;color:#91baff;border-color:#46546a}}';document.head.append(sourceSwitchStyle);
function renderSourceSwitch(){sourceSwitch.querySelectorAll('button[data-source]').forEach(button=>{const active=button.dataset.source===sourceFilter;button.classList.toggle('active',active);button.setAttribute('aria-pressed',String(active))})}
function selectMediaSource(value){if(!['all','iwara','han1'].includes(value)||value===sourceFilter)return;sourceFilter=value;pageNo=1;shuffleSeed='';const author=$('authorFilter');if(author&&author.value!=='all'){$('query').value='';author.value='all'}renderSourceSwitch();if(!singleVideoMode){const url=new URL(recommendationMode?'/playlist':'/recommend',location.origin);if(sourceFilter!=='all')url.searchParams.set('source',sourceFilter);$('recommendLink').href=url.pathname+url.search}void loadAuthorFilter();void loadPopularTags();load(true)}
sourceSwitch.querySelectorAll('button[data-source]').forEach(button=>button.addEventListener('click',()=>selectMediaSource(button.dataset.source)));renderSourceSwitch();
{const recommendationUrl=new URL('/recommend',location.origin);if(sourceFilter!=='all')recommendationUrl.searchParams.set('source',sourceFilter);$('recommendLink').href=recommendationUrl.pathname+recommendationUrl.search}
document.getElementById('mobileRefresh')?.addEventListener('click',event=>{if(location.pathname==='/recommend')return;event.preventDefault();event.stopImmediatePropagation();const url=new URL('/recommend',location.origin);if(sourceFilter!=='all')url.searchParams.set('source',sourceFilter);location.href=url.pathname+url.search},true);
if(routeParams.has('library')&&['all','later','favorite','queued','discarded'].includes(routeParams.get('library'))) {_libraryFilterNode.value=routeParams.get('library');routeParams.set('page','1')}
let audioOnly=false;
try{audioOnly=localStorage.getItem('iwara-audio-only')==='1'}catch{}
function formatAudioTime(value){const seconds=Math.max(0,Math.floor(Number(value)||0));const h=Math.floor(seconds/3600),m=Math.floor((seconds%3600)/60),s=seconds%60;return h?(h+':'+String(m).padStart(2,'0')+':'+String(s).padStart(2,'0')):(m+':'+String(s).padStart(2,'0'))}
function updateAudioOnlyControls(){const v=$('mainVideo'),seek=$('audioSeek'),time=$('audioTime'),button=$('audioPlayToggle');if(!v||!seek||!time||!button)return;const duration=Number(v.duration);const current=Number(v.currentTime)||0;if(Number.isFinite(duration)&&duration>0){seek.max=String(duration);seek.value=String(Math.min(duration,current))}else{seek.max='0';seek.value='0'}time.textContent=formatAudioTime(current)+' / '+formatAudioTime(duration);button.textContent=v.paused?'播放':'暂停';button.title=v.paused?'播放音频':'暂停音频'}
function setAudioOnly(enabled){audioOnly=Boolean(enabled);$('layout')?.classList.toggle('audio-only',audioOnly);const button=$('audioModeToggle');const bar=$('audioOnlyBar');if(bar)bar.hidden=!audioOnly;if(button){button.textContent=audioOnly?'仅音频：开':'仅音频：关';button.title=audioOnly?'恢复视频画面':'隐藏视频画面，只保留声音播放'}updateAudioOnlyControls();try{localStorage.setItem('iwara-audio-only',audioOnly?'1':'0')}catch{} }
function applyPlaylistFilter(value,kind='query'){const text=String(value||'').trim();if(kind==='author'&&$('authorFilter'))$('authorFilter').value=text;if(kind==='tag'&&$('authorFilter'))$('authorFilter').value='all';$('query').value=text;pageNo=1;load(true);}
function decorateCardFilters(){if(singleVideoMode)return;document.querySelectorAll('.card').forEach((node,index)=>{
 const task=items[index];if(!task)return;
 const authorRow=node.querySelector('.card-author-row'),author=String(task.author||'').trim(),authorLabel=String(task.alias||author||'未知作者');
 const authorSignature=JSON.stringify([author,authorLabel,task.uploadTime]);if(authorRow&&node._authorSignature!==authorSignature){node._authorSignature=authorSignature;const authorElement=document.createElement(author?'button':'span');authorElement.className=author?'filter-link card-author':'card-author';authorElement.textContent=authorLabel;authorElement.title=authorLabel;if(author){authorElement.type='button';authorElement.title='只显示作者：'+author;authorElement.dataset.author=author}const uploaded=document.createElement('span');uploaded.className='card-upload-date';uploaded.textContent='· '+date(task.uploadTime);authorRow.replaceChildren(authorElement,uploaded)}
})}
async function loadAuthorFilter(){const select=$('authorFilter');if(!select)return;try{const r=await fetch('/api/playlist-authors?source='+encodeURIComponent(sourceFilter),{cache:'no-store'}),data=await r.json();if(!r.ok)throw Error(data.error||r.status);const current=select.value;select.innerHTML='<option value="all">全部作者</option>'+(Array.isArray(data.authors)?data.authors.map(item=>'<option value="'+esc(item.author)+'">'+esc(item.alias?item.alias+' (@'+item.author+')':item.author)+' · '+Number(item.count||0)+'</option>').join(''):'');if([...select.options].some(option=>option.value===current))select.value=current}catch{}}
const _originalPlaylistRender=render;render=()=>{_originalPlaylistRender();decorateCardFilters()};
async function updatePlaylistFlag(id,payload){try{const r=await fetch('/api/playlist-flags/'+encodeURIComponent(id),{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(payload)}),data=await r.json();if(!r.ok)throw Error(data.error||r.status);const task=items.find(item=>item.id===id);if(task)Object.assign(task,data);render();if(task&&items[current]?.id===id)updatePlayerFlags(task);return data}catch(error){$('status').textContent='保存播放标记失败：'+error.message;return null}}
_authorFilterNode.onchange=()=>{const value=_authorFilterNode.value||'all';$('query').value=value==='all'?'':value;pageNo=1;load(true)};
setAudioOnly(audioOnly);_audioModeButton.onclick=()=>{setAudioOnly(!audioOnly);$('status').textContent=audioOnly?'已切换为仅音频背景播放；下方控制条可拖动进度。':'已恢复视频画面。'};$('audioPlayToggle').onclick=()=>{const v=$('mainVideo');(v.paused?v.play():v.pause()).catch(()=>{});updateAudioOnlyControls()};$('audioSeek').oninput=event=>{const v=$('mainVideo');const value=Number(event.target.value);if(Number.isFinite(value))v.currentTime=value;updateAudioOnlyControls()};['timeupdate','loadedmetadata','durationchange','play','pause','ended','emptied'].forEach(event=>$('mainVideo').addEventListener(event,updateAudioOnlyControls));
if(!routeParams.has('page')&&!routeParams.has('play'))routeParams.set('page','1');
let playbackProfile=routeParams.get('profile')==='remote'?'remote':'local';
let items=[],current=-1,timer,pageNo=Math.max(1,Number(routeParams.get('page')||1)||1),totalItems=0,globalIndex=null,hasPrevious=false,hasNext=false,loading=false,loadObserver=null,pendingPlay=routeParams.get('play')||'',sourcePage=routeParams.get('from')||'',singleVideoMode=location.pathname==='/player'||Boolean(pendingPlay),playbackSaveTimer=null,lastPlaybackPosition=-1,lastPlaybackWatched=false,selectedIds=new Set(),popularTags=[],shuffleSeed=routeParams.get('shuffle')||'',nextWindowStart=-1,nextWindowEnd=-1,nextWindowLoading=false,nextWindowCooldownUntil=0,upnextScrollSuppressUntil=0,upnextProgrammaticScroll=false,upnextProgrammaticScrollTimer=0,listRequestSequence=0,listRequestController=null;
const recommendationMode=!singleVideoMode&&location.pathname==='/recommend';
const _recommendationStyle=document.createElement('style');_recommendationStyle.textContent='#recommendLink{text-decoration:none}#recommendLink button{white-space:nowrap}body.recommend-mode #randomPage,body.recommend-mode .page-jump{display:none!important}@media(max-width:600px){body:not(.recommend-mode) header #recommendLink{display:none!important}body.recommend-mode header #recommendLink{grid-column:1/-1;width:100%}body.recommend-mode header #recommendLink button{width:100%}}';document.head.append(_recommendationStyle);
if(recommendationMode){document.body.classList.add('recommend-mode');$('pageTitle').textContent='Iwara 随机推荐';const backUrl=new URL('/playlist',location.origin);if(sourceFilter!=='all')backUrl.searchParams.set('source',sourceFilter);$('recommendLink').href=backUrl.pathname+backUrl.search;$('recommendLink').querySelector('button').textContent='返回播放列表';$('randomPage').hidden=true;$('refresh').textContent='换一批推荐';$('mobileRefresh').textContent='换一批'}
const playbackModes={sequence:{label:'顺序播放',title:'按列表顺序播放，到末尾停止'},loop:{label:'顺序循环',title:'按列表顺序播放，到末尾回到第一条'},random:{label:'随机播放',title:'每次播放结束后随机选择下一条'},single:{label:'单曲循环',title:'当前视频结束后重新播放当前视频'}};
let playbackMode='sequence';
try{const savedMode=localStorage.getItem('iwara-playback-mode');if(playbackModes[savedMode])playbackMode=savedMode}catch{}
let initialLoad=true;
window.__iwaraSetPage=target=>{pageNo=Math.max(1,Number(target)||1);initialLoad=true;load(true,false)};
setInterval(()=>{window.__iwaraTotalItems=totalItems;window.__iwaraCurrentPage=pageNo},300);
try{if(!sourcePage)sourcePage=sessionStorage.getItem('iwara-playlist-source')||''}catch{}
function playlistScope(){let source=null;if(singleVideoMode&&sourcePage){try{source=new URL(sourcePage,location.origin).searchParams}catch{}}const get=(key,fallback)=>source?.has(key)?source.get(key):fallback;const library=get('library',$('libraryFilter')?.value||'all');return{query:get('query',$('query')?.value.trim()||'')||'',sort:library==='queued'?'queue':get('sort',$('sort')?.value||'updatedAt'),direction:get('direction',$('direction')?.value||'desc'),watched:get('watched',$('watchedFilter')?.value||'all'),library,profile:get('profile',playbackProfile),source:get('source',sourceFilter)}}
function sourceShuffleSeed(){if(!singleVideoMode||!sourcePage)return'';try{return new URL(sourcePage,location.origin).searchParams.get('shuffle')||''}catch{return''}}
function createShuffleSeed(){try{const values=new Uint32Array(1);crypto.getRandomValues(values);return String(values[0]||1)}catch{return String(Math.floor(Math.random()*0xffffffff)+1)}}
function shufflePageItems(list,seed){let state=2166136261;for(const char of String(seed||'')){state^=char.charCodeAt(0);state=Math.imul(state,16777619)}state>>>=0;if(!state)state=0x6d2b79f5;const random=()=>{state^=state<<13;state^=state>>>17;state^=state<<5;return(state>>>0)/4294967296};for(let i=list.length-1;i>0;i--){const j=Math.floor(random()*(i+1));[list[i],list[j]]=[list[j],list[i]]}return list}
function openStandalone(i){const t=items[i];if(!t)return;captureLibraryReturnState(i);const sourceUrl=new URL(location.href);sourceUrl.searchParams.set('profile',playbackProfile);const from=sourceUrl.pathname+sourceUrl.search;try{sessionStorage.setItem('iwara-playlist-source',from)}catch{};const q=new URLSearchParams({play:t.id,from,profile:playbackProfile});window.location.href='/player?'+q.toString()}
function backToSource(){const target=sourcePage||'/playlist';try{sessionStorage.removeItem('iwara-playlist-source')}catch{};window.location.replace(target)}
function syncListUrl(){if(singleVideoMode)return;const q=new URLSearchParams();const query=$('query').value.trim(),sort=$('sort').value,direction=$('direction').value,watched=$('watchedFilter').value,library=$('libraryFilter')?.value||'all';if(playbackProfile==='remote'||playbackProfile==='local')q.set('profile',playbackProfile);if(sourceFilter!=='all')q.set('source',sourceFilter);if(query)q.set('query',query);if(sort!=='updatedAt')q.set('sort',sort);if(direction!=='desc')q.set('direction',direction);if(watched!=='all')q.set('watched',watched);if(library!=='all')q.set('library',library);if(pageNo>1)q.set('page',String(pageNo));if(shuffleSeed)q.set('shuffle',shuffleSeed);const next=(recommendationMode?'/recommend':'/playlist')+(q.toString()?'?'+q.toString():'');history.replaceState(null,'',next)}
function applyLibraryParams(params){const scope=playlistScope(),library=scope.library;params.set('query',scope.query);params.set('source',scope.source);params.set('sort',scope.sort);params.set('direction',scope.direction);params.set('watched',scope.watched);params.set('favorite',library==='favorite'?'favorite':'all');params.set('watchLater',library==='later'?'later':'all');params.set('queue',library==='queued'?'queued':'all');params.set('discarded',library==='discarded'?'only':'exclude');params.set('profile',scope.profile);return params}
const _selectionStatusInlineStyle=document.createElement('style');_selectionStatusInlineStyle.textContent='@media(max-width:600px){.selection-mode #status:not(:empty){position:static;left:auto;right:auto;bottom:auto;z-index:auto;margin:10px 0;padding:0;border:0;border-radius:0;background:transparent;box-shadow:none;backdrop-filter:none;color:inherit;font-size:12px}}';document.head.append(_selectionStatusInlineStyle);
function renderTagCloud(){const target=$('tagCloud');if(!target)return;if(singleVideoMode||!popularTags.length){target.hidden=true;target.replaceChildren();return}const query=$('query').value.trim();target.hidden=window.matchMedia('(max-width:600px)').matches&&!_mobileTagsVisible;target.classList.toggle('expanded',_mobileTagsVisible);target.innerHTML='<span class="tag-cloud-label">高频标签</span>'+popularTags.map(item=>'<button type="button" class="tag-chip '+(query===item.tag?'active':'')+'" data-tag="'+esc(item.tag)+'">'+esc(item.tag)+' <small>'+Number(item.count||0)+'</small></button>').join('');target.querySelectorAll('.tag-chip').forEach(button=>button.addEventListener('click',()=>{const tag=button.dataset.tag||'';$('query').value=$('query').value.trim()===tag?'':tag;_updateMobileFilterSummary();load(true)}))}
async function loadPopularTags(){try{const r=await fetch('/api/playlist-tags?limit=18&source='+encodeURIComponent(sourceFilter),{cache:'no-store'});const data=await r.json();if(!r.ok)throw Error(data.error||r.status);popularTags=Array.isArray(data.tags)?data.tags:[];renderTagCloud()}catch{popularTags=[];renderTagCloud()}}
function progressInfo(t){const duration=Number(t.playbackDuration||0),position=Math.max(0,Number(t.playbackPosition||0));return{duration,position,pct:duration?Math.min(100,position/duration*100):0}}
function watchLabel(t){const p=progressInfo(t);return t.watched?'已看完':p.position>1?'未看完':'未播放'}
let coverObserver=null;
function startCover(image){const source=image.dataset.coverSrc;if(!source)return;delete image.dataset.coverSrc;const rect=image.getBoundingClientRect(),visible=rect.bottom>0&&rect.top<innerHeight;image.fetchPriority=visible?'high':'low';image.src=source+(source.includes('?')?'&':'?')+'priority='+(visible?'1':'0')}
function setCoverOrientation(image){image.classList.toggle('portrait-cover',image.naturalWidth>0&&image.naturalHeight>image.naturalWidth*1.05)}
function bindCoverStatus(root=document){if(!coverObserver&&'IntersectionObserver' in window)coverObserver=new IntersectionObserver(entries=>{for(const entry of entries)if(entry.isIntersecting){coverObserver.unobserve(entry.target);startCover(entry.target)}},{rootMargin:'160px 0px'});root.querySelectorAll('.cover-image').forEach(image=>{if(image._coverBound)return;image._coverBound=true;const fallback=image.previousElementSibling?.classList.contains('cover-fallback')?image.previousElementSibling:null;image.onload=()=>{setCoverOrientation(image);if(fallback)fallback.hidden=true;image.hidden=false};image.onerror=()=>{image.hidden=true;if(fallback)fallback.textContent='封面暂不可用'};if(image.complete&&image.naturalWidth){setCoverOrientation(image);if(fallback)fallback.hidden=true}if(image.dataset.coverSrc){if(coverObserver)coverObserver.observe(image);else startCover(image)}})}
 function card(t,i){const p=progressInfo(t),selected=selectedIds.has(t.id);return '<article class="card '+(i===current?'active ':'')+(selected?'selected':'')+'" data-index="'+i+'"><div class="thumb"><span class="cover-fallback">正在加载封面</span><img class="cover-image" data-cover-src="'+esc(t.coverUrl)+'" alt="" decoding="async"><input class="card-select" type="checkbox" data-selection-id="'+esc(t.id)+'" aria-label="选择 '+esc(t.title||t.videoId)+'" '+(selected?'checked':'')+'><span class="watch-badge '+(t.watched?'':'unwatched')+'">'+watchLabel(t)+'</span><span class="card-view-count" title="'+esc(views(t.views))+'"><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M5 3.5 12 8l-7 4.5z" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/></svg><span>'+esc(compactViewCount(t.views))+'</span></span><span class="badge">本地</span></div><div class="card-body"><div class="card-title" title="'+esc(t.title||t.videoId)+'">'+esc(t.title||t.videoId)+'</div><div class="meta card-author-row">'+esc(t.alias||t.author||'未知作者')+' · '+esc(date(t.uploadTime))+'</div><div class="card-progress"><i style="width:'+p.pct+'%"></i></div></div></article>'}
 let batchSubmitPending=false,batchStatusTimer=null;
 const batchUiJobs=new Map();
 function refreshBatchPending(){batchSubmitPending=[...batchUiJobs.values()].some(job=>job.preparing)}
 function updateBatchStatus(message=''){
  const jobs=[...batchUiJobs.values()],preparing=jobs.filter(job=>job.preparing),transferring=jobs.filter(job=>job.state==='transferring'),ready=jobs.filter(job=>job.state==='ready');
  if(preparing.length){$('status').textContent='正在准备 '+preparing.length+' 批 ZIP；准备完成后可继续选择下一批。';return}
  if(transferring.length){const job=transferring.at(-1),percent=job.total?Math.min(100,Math.floor(job.sent/job.total*100)):0;$('status').textContent='正在传输 '+transferring.length+' 批 ZIP（最近一批 '+percent+'%，'+bytes(job.sent)+' / '+bytes(job.total)+'）；可继续换一批并下载。';return}
  if(ready.length){$('status').textContent='ZIP 已准备，等待浏览器开始下载；可继续换一批并下载。';return}
  if(message)$('status').textContent=message;
 }
 function updateSelectionUi(syncCards=true){const count=selectedIds.size,button=$('downloadSelected'),label=$('selectionCount'),activeJobs=batchUiJobs.size;if(button){button.disabled=count<1||batchSubmitPending;button.textContent=batchSubmitPending?'准备中…':count>1?'打包下载（'+count+'）':'下载选中（'+count+'）';button.title=count===1?'保存已选本地视频':count>1?'一次生成免压缩 ZIP，只触发一次浏览器下载':'请先选择视频'}if(label)label.textContent=batchSubmitPending?'正在准备本批 ZIP；完成后即可提交下一批':activeJobs?'已有 '+activeJobs+' 批下载任务在准备或传输；仍可选择下一批':count?'已选择 '+count+' 个视频':'勾选视频后一次打包下载';if(syncCards)document.querySelectorAll('#grid .card').forEach(c=>{const box=c.querySelector('.card-select'),selected=selectedIds.has(c.dataset.taskId);if(box&&box.checked!==selected)box.checked=selected;if(c.classList.contains('selected')!==selected)c.classList.toggle('selected',selected)})}
 function bindSelection(){updateSelectionUi(false)}
const gridNodes=new Map();
function reconcileGrid(){
 const grid=$('grid'),wanted=new Set(items.map(item=>item.id));
 for(const [id,node] of gridNodes)if(!wanted.has(id)||node.parentNode!==grid){const image=node.querySelector('.cover-image');if(image)coverObserver?.unobserve(image);node.remove();gridNodes.delete(id)}
 if(!items.length){if(!grid.querySelector('.empty'))grid.innerHTML='<div class="empty">没有可播放的本地视频</div>';return}
 grid.querySelector('.empty')?.remove();
 items.forEach((task,index)=>{
  let node=gridNodes.get(task.id);
  if(!node){const template=document.createElement('template');template.innerHTML=card(task,index);node=template.content.firstElementChild;node.dataset.taskId=task.id;gridNodes.set(task.id,node);bindCoverStatus(node)}
  node.dataset.index=String(index);
  const signature=JSON.stringify([task.title,task.videoId,task.author,task.alias,task.uploadTime,task.views,task.watched,task.playbackPosition,task.playbackDuration]);
  if(node._signature!==signature){node._signature=signature;const p=progressInfo(task),title=node.querySelector('.card-title'),badge=node.querySelector('.watch-badge');title.textContent=task.title||task.videoId;title.title=task.title||task.videoId;badge.textContent=watchLabel(task);badge.classList.toggle('unwatched',!task.watched);node.querySelector('.card-view-count').title=views(task.views);node.querySelector('.card-view-count span').textContent=compactViewCount(task.views);node.querySelector('.card-progress i').style.width=p.pct+'%'}
  const selected=selectedIds.has(task.id),box=node.querySelector('.card-select');if(box.checked!==selected)box.checked=selected;if(node.classList.contains('selected')!==selected)node.classList.toggle('selected',selected);if(node.classList.contains('active')!==(index===current))node.classList.toggle('active',index===current);
  const position=grid.children[index];if(position!==node)grid.insertBefore(node,position||null);
 })
}
$('grid').addEventListener('click',event=>{
 const author=event.target.closest?.('[data-author]');if(author){event.preventDefault();event.stopPropagation();applyPlaylistFilter(author.dataset.author,'author');return}
 const node=event.target.closest?.('.card[data-task-id]');if(!node||event.target.closest?.('button,a,input,select,textarea')||loading)return;
 const index=items.findIndex(task=>task.id===node.dataset.taskId);if(index<0)return;
 if(singleVideoMode){select(index,event);return}
 if(document.body.classList.contains('selection-mode')){const box=node.querySelector('.card-select');box.checked=!box.checked;box.dispatchEvent(new Event('change',{bubbles:true}));return}openStandalone(index)
});
$('grid').addEventListener('change',event=>{const box=event.target.closest?.('.card-select');if(!box)return;event.stopPropagation();if(box.checked)selectedIds.add(box.dataset.selectionId);else selectedIds.delete(box.dataset.selectionId);box.closest('.card').classList.toggle('selected',box.checked);updateSelectionUi(false)});
 function startDownload(item){if(!item?.downloadUrl){$('status').textContent='该视频暂时没有可下载地址。';return}const link=document.createElement('a');link.href=item.downloadUrl;link.download='';link.rel='noopener';document.body.append(link);link.click();link.remove();$('status').textContent='已开始下载：'+(item.title||item.localFileName||item.videoId)}
 function setSelectionMode(active){document.body.classList.toggle('selection-mode',Boolean(active));$('selectionModeToggle').setAttribute('aria-pressed',String(Boolean(active)));$('selectionModeToggle').textContent=active?'取消选择':'批量下载';if(!active)selectedIds.clear();updateSelectionUi()}
  function downloadSelected(){return downloadSelectedWithoutPopup()}
  function newBatchDownloadId(){const bytes=new Uint8Array(18);if(globalThis.crypto?.getRandomValues)crypto.getRandomValues(bytes);else for(let i=0;i<bytes.length;i++)bytes[i]=Math.floor(Math.random()*256);return [...bytes].map(value=>value.toString(16).padStart(2,'0')).join('')}
  function finishBatchDownload(id,message){const job=batchUiJobs.get(id);if(!job)return;batchUiJobs.delete(id);job.frame?.remove();refreshBatchPending();updateSelectionUi();if(batchUiJobs.size)updateBatchStatus();else if(message)$('status').textContent=message;if(!batchUiJobs.size&&batchStatusTimer){clearInterval(batchStatusTimer);batchStatusTimer=null}}
  async function pollBatchDownload(id){const job=batchUiJobs.get(id);if(!job||job.polling)return;job.polling=true;try{const response=await fetch('/api/batch-download/status?id='+encodeURIComponent(id),{cache:'no-store'});if(!response.ok){if(++job.misses>25)finishBatchDownload(id,'没有检测到 ZIP 传输任务；请确认浏览器是否允许下载，然后重试。');return}job.misses=0;const state=await response.json();job.state=state.state;job.sent=Number(state.bytesSent||0);job.total=Number(state.archiveBytes||0);if(state.state==='ready'||state.state==='transferring'){job.preparing=false;refreshBatchPending();updateSelectionUi();if(state.state==='ready'&&Date.now()-job.createdAt>30000){finishBatchDownload(id,'浏览器尚未开始接收这一批 ZIP；可以重新选择并下载。');return}updateBatchStatus();return}if(state.state==='completed'){finishBatchDownload(id,'浏览器已接收一批完整 ZIP；请在浏览器下载列表中查看。');return}if(state.state==='interrupted'){finishBatchDownload(id,'一批 ZIP 传输中断（已传 '+bytes(job.sent)+' / '+bytes(job.total)+'）；可重新发起该批下载。');return}finishBatchDownload(id,'批量下载状态无效，请重新发起。')}catch{if(++job.misses>25)finishBatchDownload(id,'无法读取 ZIP 传输状态；可确认浏览器下载权限后重试。')}finally{job.polling=false}}
  function startBatchPolling(){if(batchStatusTimer)return;const pollAll=()=>{for(const id of batchUiJobs.keys())void pollBatchDownload(id)};pollAll();batchStatusTimer=setInterval(pollAll,700)}
  // Submit from the user gesture, then follow a redirect to a normal GET so mobile browsers list the transfer.
  function downloadSelectedWithoutPopup(){
   const chosen=items.filter(item=>selectedIds.has(item.id));
   if(chosen.length===1){startDownload(chosen[0]);return}
   if(chosen.length<2){$('status').textContent='请至少勾选一个视频。';return}
   if(chosen.length>100){$('status').textContent='一次最多打包 100 个视频，请分批选择。';return}
   if(batchSubmitPending)return;
   const button=$('downloadSelected'),downloadId=newBatchDownloadId();let frame=null;batchSubmitPending=true;button.disabled=true;
   $('status').textContent='正在准备 '+chosen.length+' 个视频的 ZIP 下载…';
   try{
    frame=document.createElement('iframe');
    frame.id='batchDownloadFrame-'+downloadId;frame.name=frame.id;frame.hidden=true;frame.title='批量下载';frame.setAttribute('aria-hidden','true');
    const job={id:downloadId,count:chosen.length,frame,createdAt:Date.now(),state:'preparing',preparing:true,polling:false,misses:0,sent:0,total:0};batchUiJobs.set(downloadId,job);
    frame.addEventListener('load',()=>{try{const doc=frame.contentDocument;if(doc?.title==='批量下载未开始')finishBatchDownload(downloadId,doc.body?.innerText||'批量下载失败，请返回列表重试。')}catch{}});
    document.body.append(frame);
    const form=document.createElement('form');form.method='POST';form.action='/batch-download';form.target=frame.name;form.hidden=true;
    let token='';try{token=sessionStorage.getItem('iwaraAccessToken')||''}catch{}
    for(const [name,value] of [['taskIds',JSON.stringify(chosen.map(item=>item.id))],['access_token',token],['downloadId',downloadId]]){const input=document.createElement('input');input.type='hidden';input.name=name;input.value=value;form.append(input)}
    document.body.append(form);form.submit();form.remove();
    pollBatchDownload(downloadId);startBatchPolling()
   }catch(error){if(batchUiJobs.has(downloadId))finishBatchDownload(downloadId,'批量下载未提交：'+error.message);else{refreshBatchPending();$('status').textContent='批量下载未提交：'+error.message;updateSelectionUi()}}
  }
  function render(){
   if(singleVideoMode){coverObserver?.disconnect();coverObserver=null;$('grid').replaceChildren();gridNodes.clear();$('count').textContent='';$('pageInfo').textContent='';_mobilePageToggle.hidden=true;$('loadMore').hidden=true;$('loadSentinel').hidden=true}
   else{
    reconcileGrid();
    const mobile=window.matchMedia('(max-width:600px)').matches,pageCount=Math.max(1,Math.ceil(totalItems/playlistPageSize())),visiblePage=Math.min(pageNo,pageCount);
    $('count').textContent=mobile?(recommendationMode?items.length+' 条推荐':(totalItems||items.length)+' 个'):(totalItems&&items.length<totalItems?items.length+' / ':'')+(totalItems||items.length)+' 个本地视频';$('count').title='已加载 '+items.length+' / '+(totalItems||items.length)+' 个本地视频';
    $('pageInfo').textContent=recommendationMode?(totalItems?'随机推荐 · 本批 '+items.length+' 条':'随机推荐'):(totalItems?'第 '+visiblePage+' / '+pageCount+' 页':'');
    _mobilePageToggle.hidden=recommendationMode||!totalItems;_mobilePageToggle.textContent=visiblePage+' / '+pageCount+' 页';_mobilePageToggle.setAttribute('aria-label','当前第 '+visiblePage+' 页，共 '+pageCount+' 页，点击跳页');
    const pageJump=$('pageInfo').nextElementSibling;if(pageJump)pageJump.hidden=recommendationMode;
    const more=Boolean(!recommendationMode&&!shuffleSeed&&totalItems&&pageNo<pageCount);$('loadMore').hidden=!more;$('loadSentinel').hidden=!more;
   }
   bindSelection();renderNext()
  }
function loadNextPage(){if(singleVideoMode||loading||!totalItems||pageNo>=Math.ceil(totalItems/playlistPageSize()))return;void load(false,false,pageNo+1)}
 function setupInfiniteScroll(){if(singleVideoMode)return;const sentinel=$('loadSentinel');if(!sentinel)return;loadObserver?.disconnect();if('IntersectionObserver' in window){loadObserver=new IntersectionObserver(entries=>{if(entries.some(entry=>entry.isIntersecting))loadNextPage()},{rootMargin:'120px 0px',threshold:0});loadObserver.observe(sentinel);return}const check=()=>{if(innerHeight+scrollY>=document.documentElement.scrollHeight-120)loadNextPage()};window.addEventListener('scroll',check,{passive:true});window.addEventListener('resize',check,{passive:true})}
function renderNext(resetWindow=true,preserveDirection=''){
  const node=$('upnext'),scroller=node?.closest('.upnext');if(!node)return;if(!singleVideoMode){node.innerHTML='';return}
  node.querySelectorAll('.cover-image').forEach(image=>coverObserver?.unobserve(image));
  const maxWindow=13;
  if(resetWindow||nextWindowStart<0||nextWindowEnd<0){const windowSize=Math.min(items.length,5);nextWindowStart=Math.max(0,Math.min(current-2,items.length-windowSize));nextWindowEnd=Math.min(items.length,nextWindowStart+windowSize)}
  nextWindowStart=Math.max(0,Math.min(nextWindowStart,items.length));nextWindowEnd=Math.max(nextWindowStart,Math.min(nextWindowEnd,items.length));
  if(nextWindowEnd-nextWindowStart>maxWindow){if(preserveDirection==='up')nextWindowEnd=nextWindowStart+maxWindow;else nextWindowStart=nextWindowEnd-maxWindow}
  const entries=[];for(let index=nextWindowStart;index<nextWindowEnd;index++){if(index===current)continue;const t=items[index];if(t)entries.push({t,index})}
  node.innerHTML=entries.map(({t,index})=>'<div class="next-row compact-row" data-index="'+index+'"><span class="compact-index">'+(index<current?'上一个':'下一个')+'</span><img class="cover-image" data-cover-src="'+esc(t.coverUrl)+'" alt="" decoding="async" style="width:92px;height:52px;object-fit:cover;border-radius:5px"><div><b>'+esc(t.title||t.videoId)+'</b><span>'+esc(t.alias||t.author||'未知作者')+'</span></div></div>').join('')||'<div class="meta">没有相邻视频</div>';
  bindCoverStatus(node);
  document.querySelectorAll('.next-row').forEach(c=>c.onclick=e=>select(Number(c.dataset.index),e));
  if(scroller&&(resetWindow||preserveDirection)){if(resetWindow){clearTimeout(upnextProgrammaticScrollTimer);upnextProgrammaticScroll=false;upnextScrollSuppressUntil=performance.now()+180;scroller.scrollTop=0}else{upnextScrollSuppressUntil=0;nextWindowCooldownUntil=performance.now()+320;upnextProgrammaticScroll=true;const top=preserveDirection==='up'?0:scroller.scrollHeight,behavior=matchMedia('(prefers-reduced-motion: reduce)').matches?'auto':'smooth';scroller.scrollTo({top,behavior});clearTimeout(upnextProgrammaticScrollTimer);upnextProgrammaticScrollTimer=setTimeout(()=>{upnextProgrammaticScroll=false},1500)}}
}
function moveNextWindow(direction){
  const maxWindow=13,batchSize=4,beforeStart=nextWindowStart,beforeEnd=nextWindowEnd;
  if(direction<0){nextWindowStart=Math.max(0,nextWindowStart-batchSize);nextWindowEnd=Math.min(items.length,nextWindowStart+maxWindow)}
  else{nextWindowEnd=Math.min(items.length,nextWindowEnd+batchSize);nextWindowStart=Math.max(0,nextWindowEnd-maxWindow)}
  return nextWindowStart!==beforeStart||nextWindowEnd!==beforeEnd;
}
async function loadAdjacentBatch(direction){
  if(nextWindowLoading||performance.now()<nextWindowCooldownUntil||!singleVideoMode||current<0||!items.length)return;
  nextWindowLoading=true;let marker=null;
  try{
    if(direction>0&&nextWindowEnd<items.length||direction<0&&nextWindowStart>0){if(moveNextWindow(direction)){renderNext(false,direction<0?'up':'down');return}}
    if(sourceShuffleSeed()){
      if(moveNextWindow(direction)){renderNext(false,direction<0?'up':'down');return}
      $('status').textContent=direction<0?'已经到达当前随机列表顶部':'已经到达当前随机列表末尾';return;
    }
    if(!Number.isSafeInteger(globalIndex))return;
    const absoluteStart=globalIndex-current,absoluteEnd=absoluteStart+items.length-1;
    if(direction<0&&absoluteStart<=0){$('status').textContent='已经到达列表顶部';return}if(direction>0&&absoluteEnd>=totalItems-1){$('status').textContent='已经到达列表末尾';return}
    const target=direction<0?Math.max(0,absoluteStart-2):Math.min(totalItems-1,absoluteEnd+3);
    const params=applyLibraryParams(new URLSearchParams({page:'1',pageSize:'30',contextIndex:String(target),contextSize:'5'}));
    marker=document.createElement('div');marker.className='upnext-loading';marker.textContent=direction<0?'正在加载上方 4 条…':'正在加载下方 4 条…';$('upnext').append(marker);
    const response=await fetch('/playlist-data?'+params,{cache:'no-store'}),data=await response.json();if(!response.ok)throw Error(data.error||response.status);
    const fetched=data.items||[],fetchedStart=Number.isSafeInteger(data.globalIndex)&&Number.isSafeInteger(data.currentIndex)?data.globalIndex-data.currentIndex:target;let added=0;
    if(direction>0){const additions=fetched.filter((item,index)=>fetchedStart+index>absoluteEnd).slice(0,4);added=additions.length;if(added){items=items.concat(additions);nextWindowEnd+=added;nextWindowStart=Math.max(0,nextWindowEnd-13)}}
    else{const additions=fetched.filter((item,index)=>fetchedStart+index<absoluteStart).slice(-4);added=additions.length;if(added){items=additions.concat(items);current+=added;nextWindowStart=0;nextWindowEnd=Math.min(13,nextWindowEnd+added)}}
    marker.remove();marker=null;
    if(!added){$('status').textContent=direction<0?'已经到达列表顶部':'已经到达列表末尾';return}
    renderNext(false,direction<0?'up':'down');
  }catch(error){if(marker){marker.textContent='相邻视频加载失败：'+error.message;setTimeout(()=>marker?.remove(),2600)}else $('status').textContent='相邻视频加载失败：'+error.message}
  finally{nextWindowLoading=false}
}
function bindUpnextScroll(){
  const scroller=document.querySelector('.upnext');if(!scroller||scroller.dataset.batchBound)return;scroller.dataset.batchBound='1';let touchStartY=null,lastScrollTop=scroller.scrollTop;
  const nearTop=()=>scroller.scrollTop<=34,nearBottom=()=>scroller.scrollTop+scroller.clientHeight>=scroller.scrollHeight-48;
  scroller.addEventListener('scroll',()=>{const previous=lastScrollTop;lastScrollTop=scroller.scrollTop;if(upnextProgrammaticScroll||performance.now()<upnextScrollSuppressUntil)return;if(scroller.scrollTop<previous&&nearTop())void loadAdjacentBatch(-1);else if(scroller.scrollTop>previous&&nearBottom())void loadAdjacentBatch(1)},{passive:true});
  const cancelProgrammaticScroll=()=>{if(upnextProgrammaticScroll){upnextProgrammaticScroll=false;clearTimeout(upnextProgrammaticScrollTimer)}};
  scroller.addEventListener('wheel',event=>{cancelProgrammaticScroll();if(event.deltaY<0&&nearTop())void loadAdjacentBatch(-1);else if(event.deltaY>0&&nearBottom())void loadAdjacentBatch(1)},{passive:true});
  scroller.addEventListener('touchstart',event=>{cancelProgrammaticScroll();touchStartY=event.touches?.[0]?.clientY??null},{passive:true});
  scroller.addEventListener('touchend',event=>{if(touchStartY===null)return;const endY=event.changedTouches?.[0]?.clientY??touchStartY,delta=endY-touchStartY;touchStartY=null;if(Math.abs(delta)<48||performance.now()<upnextScrollSuppressUntil)return;if(delta>0&&nearTop())void loadAdjacentBatch(-1);else if(delta<0&&nearBottom())void loadAdjacentBatch(1)},{passive:true});
}
function playerErrorText(error){const code=Number(error?.code||0);if(code===4)return '浏览器无法识别播放资源，正在核对文件服务的实际响应。';if(code===3)return '浏览器解码失败；文件可能损坏，或当前浏览器不支持其编码。';if(code===2)return '读取本地文件时网络中断，请稍后重试。';return '播放器无法打开该文件，正在检查原因。'}
function mediaHttpError(status){if(status===401)return '局域网视频请求未通过授权（HTTP 401）。请从台账复制局域网播放链接重新打开；视频地址会自动携带独立访问票据。';if(status===403)return '本地文件被拒绝访问（HTTP 403）；请检查服务权限和下载目录。';if(status===404)return '本地文件确实不存在（HTTP 404）；请检查台账中的文件位置。';if(status===416)return '手机浏览器请求的视频分段无效（HTTP 416）；请刷新播放器重试。';if(status===503)return '远程 480p 转码暂时失败（HTTP 503）；请确认 FFmpeg 可用，稍后重试或切回局域网原画模式。';if(status>=400)return '本地文件服务返回 HTTP '+status+'，暂时无法读取。';return ''}
async function explainMediaFailure(video,task){
  const token=task?.id;
  let message=playerErrorText(video?.error);
  try{
    const diagnostics=await fetch('/api/media-diagnostics/'+encodeURIComponent(token)+'?since='+Number(task.mediaStartedAt||0),{cache:'no-store'});
    if(diagnostics.status===401)message=mediaHttpError(401);
    else if(diagnostics.ok){const events=(await diagnostics.json()).events||[],failed=events.slice().reverse().find(item=>item.status>=400);if(failed)message=mediaHttpError(failed.status);else if(events.some(item=>item.aborted))message='视频传输连接中断；请重试，若持续发生请检查服务日志和手机网络。'}
    if(message!==playerErrorText(video?.error)){if(items[current]?.id===token)showPlayerError(message);return}
    const response=await fetch(task.streamUrl,{method:'HEAD',cache:'no-store'});
    if(!response.ok)message=mediaHttpError(response.status);
    else{
      const probe=await fetch(task.streamUrl,{headers:{Range:'bytes=0-1'},cache:'no-store'});
      if(probe.status!==206)message=mediaHttpError(probe.status)||'视频分段请求返回 HTTP '+probe.status+'，浏览器可能无法继续播放。';
      else message='文件服务可正常读取并返回分段数据（HTTP 206），但当前浏览器未能播放。可能是浏览器不支持该文件编码或其内置播放器处理失败；可尝试其他浏览器或 VLC/MPV。';
    }
  }catch{message='手机与本地文件服务的连接中断；请确认仍在同一局域网并重试。'}
  if(items[current]?.id===token)showPlayerError(message);
}
function showPlayerError(message){const node=$('playerError');node.textContent=message||'';node.hidden=!message}
function updatePlayerState(t){const p=progressInfo(t);const mode=t.playbackProfile==='remote'?'远程480p · ':'';const state=t.watched?'已看完':p.position>1?'未看完 · 已看到 '+Math.floor(p.position/60)+':'+String(Math.floor(p.position%60)).padStart(2,'0'):'尚未播放';$('playerState').textContent=mode+state;$('playerState').hidden=false;$('resumeBtn').disabled=!(p.position>1&&!t.watched);$('markBtn').disabled=false;$('markBtn').textContent=t.watched?'标记未看完':'标记已看完'}
function persistPlayback(force=false,watchedOverride=null){if(current<0||!items[current])return;const t=items[current],v=$('mainVideo'),duration=Number(v.duration||t.playbackDuration||0),position=Number(v.currentTime||0);if(!Number.isFinite(position)||!Number.isFinite(duration)||duration<=0)return;const watched=typeof watchedOverride==='boolean'?watchedOverride:(v.ended||position/duration>=.95);if(!force&&Math.abs(position-lastPlaybackPosition)<2&&watched===lastPlaybackWatched)return;lastPlaybackPosition=position;lastPlaybackWatched=watched;const payload={position,duration,watched};t.playbackPosition=position;t.playbackDuration=duration;t.watched=watched;updatePlayerState(t);fetch('/api/playback/'+encodeURIComponent(t.id),{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(payload),keepalive:force}).then(r=>r.ok?r.json():null).then(saved=>{if(saved){Object.assign(t,{playbackPosition:saved.playbackPosition,playbackDuration:saved.playbackDuration,watched:saved.watched,playbackUpdatedAt:saved.playbackUpdatedAt})}}).catch(()=>{})}
function schedulePlaybackSave(){clearTimeout(playbackSaveTimer);playbackSaveTimer=setTimeout(()=>persistPlayback(false),800)}
function sendPlaybackBeacon(){if(current<0||!items[current])return;const v=$('mainVideo'),duration=Number(v.duration||0),position=Number(v.currentTime||0);if(!Number.isFinite(duration)||duration<=0)return;const body=JSON.stringify({position,duration,watched:v.ended||position/duration>=.95});try{navigator.sendBeacon('/api/playback/'+encodeURIComponent(items[current].id),new Blob([body],{type:'application/json'}))}catch{persistPlayback(true)}}
const _persistPlaybackWithoutAudioGate=persistPlayback;persistPlayback=(...args)=>audioOnly?undefined:_persistPlaybackWithoutAudioGate(...args);const _sendPlaybackBeaconWithoutAudioGate=sendPlaybackBeacon;sendPlaybackBeacon=(...args)=>audioOnly?undefined:_sendPlaybackBeaconWithoutAudioGate(...args);
function updatePlaybackModeButton(){const button=$('playModeToggle'),mode=playbackModes[playbackMode]||playbackModes.sequence;if(button){button.textContent='播放模式：'+mode.label;button.title=mode.title}}
function setPlaybackMode(mode){playbackMode=playbackModes[mode]?mode:'sequence';try{localStorage.setItem('iwara-playback-mode',playbackMode)}catch{}updatePlaybackModeButton()}
function cyclePlaybackMode(){const modes=Object.keys(playbackModes),index=modes.indexOf(playbackMode);setPlaybackMode(modes[(index+1)%modes.length]);$('status').textContent='已切换为'+playbackModes[playbackMode].label}
async function loadContextIndex(targetGlobal,statusText='正在读取相邻视频…'){
  if(!singleVideoMode||!Number.isSafeInteger(targetGlobal))return false;
  const target=Math.max(0,Math.min(totalItems-1,targetGlobal));
  const p=applyLibraryParams(new URLSearchParams({page:'1',pageSize:'30',contextIndex:String(target),contextSize:'5'}));
  $('status').textContent=statusText;
  try{
    const r=await fetch('/playlist-data?'+p,{cache:'no-store'}),d=await r.json();
    if(!r.ok)throw Error(d.error||r.status);
    items=d.items||[];totalItems=Number(d.total??totalItems);globalIndex=Number.isSafeInteger(d.globalIndex)?d.globalIndex:target;hasPrevious=Boolean(d.hasPrevious);hasNext=Boolean(d.hasNext);current=Number.isSafeInteger(d.currentIndex)?d.currentIndex:0;
    showPlayerError(d.playerError?.message||'');render();
    if(items.length){select(current,null,true);$('status').textContent='已加载相邻视频；当前为'+playbackModes[playbackMode].label+'。';return true}
    current=-1;globalIndex=null;hasPrevious=false;hasNext=false;const video=$('mainVideo');video.pause();video.removeAttribute('src');video.load();$('mainTitle').textContent='当前筛选中没有更多视频';$('mainMeta').textContent='可切换筛选，或到“已丢弃（找回）”中恢复视频。';$('playerState').hidden=true;updatePlayerFlags(null);$('status').textContent=statusText||'当前筛选中没有更多视频。';
  }catch(error){$('status').textContent='读取相邻视频失败：'+error.message}
  return false
}
async function playRandomNext(){
  if(!singleVideoMode)return;
  if(totalItems<=1){$('status').textContent='可随机播放的视频不足。';return}
  const previousId=items[current]?.id,shuffleSeedForSource=sourceShuffleSeed();
  if(shuffleSeedForSource){const candidates=items.filter(item=>item.id!==previousId);if(!candidates.length){$('status').textContent='当前随机页只有一个视频，无法切换到其他项。';return}current=items.indexOf(candidates[Math.floor(Math.random()*candidates.length)]);globalIndex=current;hasPrevious=current>0;hasNext=current<items.length-1;render();select(current,null,true);$('status').textContent='已在当前随机页随机切换。';return}
  const previousGlobal=Number.isSafeInteger(globalIndex)?globalIndex:-1;let target=Math.floor(Math.random()*totalItems);if(totalItems>1&&target===previousGlobal)target=(target+1)%totalItems;
  const p=applyLibraryParams(new URLSearchParams({page:'1',pageSize:'30',contextIndex:String(target),contextSize:'5'}));
  $('status').textContent='正在随机选择下一条视频…';
  try{
    const r=await fetch('/playlist-data?'+p,{cache:'no-store'}),d=await r.json();
    if(!r.ok)throw Error(d.error||r.status);
    items=d.items||[];totalItems=Number(d.total||totalItems);pageNo=Number(d.page||1);current=Number.isSafeInteger(d.currentIndex)?d.currentIndex:0;globalIndex=Number.isSafeInteger(d.globalIndex)?d.globalIndex:target;hasPrevious=Boolean(d.hasPrevious);hasNext=Boolean(d.hasNext);
    showPlayerError(d.playerError?.message||'');render();select(current,null,true);$('status').textContent='已随机播放下一条视频。';
  }catch(error){$('status').textContent='随机选择失败：'+error.message}
}
async function handlePlaybackEnded(){
  persistPlayback(true);
  if(playbackMode==='single'){
    const video=$('mainVideo');video.currentTime=0;video.play().catch(()=>{});return;
  }
  if(playbackMode==='random'){await playRandomNext();return}
  if(current<items.length-1){select(current+1,null,true);return}
  if(hasNext){await navigateAdjacent(1);return}
  if(playbackMode==='loop'&&totalItems>0){if(sourceShuffleSeed()){select(0,null,true);$('status').textContent='顺序循环：已回到当前随机页的第一条视频。';return}await loadContextIndex(0,'顺序循环：正在回到第一条视频…');return}
  $('status').textContent='顺序播放已到列表末尾。';
}
async function navigateAdjacent(direction){
  const target=current+direction;
  if(target>=0&&target<items.length){select(target,null,true);return}
  if(sourceShuffleSeed())return;
  if(!singleVideoMode||!Number.isSafeInteger(globalIndex))return;
  const targetGlobal=globalIndex+direction;
  if(targetGlobal<0||targetGlobal>=totalItems)return;
  const p=applyLibraryParams(new URLSearchParams({page:'1',pageSize:'30',contextIndex:String(targetGlobal),contextSize:'5'}));
  $('status').textContent='正在读取相邻视频…';
  try{
    const r=await fetch('/playlist-data?'+p,{cache:'no-store'}),d=await r.json();
    if(!r.ok)throw Error(d.error||r.status);
    items=d.items||[];totalItems=Number(d.total||totalItems);globalIndex=Number.isSafeInteger(d.globalIndex)?d.globalIndex:targetGlobal;hasPrevious=Boolean(d.hasPrevious);hasNext=Boolean(d.hasNext);current=Number.isSafeInteger(d.currentIndex)?d.currentIndex:0;
    showPlayerError(d.playerError?.message||'');render();if(items.length)select(current,null,true);$('status').textContent='已加载相邻视频；只保留当前视频和少量切换项。';
  }catch(error){$('status').textContent='读取相邻视频失败：'+error.message}
}
function updateMediaSessionPlaybackState(){const session=navigator.mediaSession,video=$('mainVideo');if(!session)return;try{session.playbackState=video?.getAttribute('src')?(video.paused?'paused':'playing'):'none'}catch{}}
function updateMediaSessionTrack(task){const session=navigator.mediaSession;if(!session)return;try{session.metadata=task&&typeof MediaMetadata==='function'?new MediaMetadata({title:String(task.title||task.videoId||'Iwara 视频'),artist:String(task.alias||task.author||'未知作者'),album:'Iwara 本地播放列表'}):null}catch{}updateMediaSessionPlaybackState()}
function handleMediaPrevious(){if(current<0||!items[current])return;if(current>0||hasPrevious){void navigateAdjacent(-1);return}const video=$('mainVideo');if(video){try{video.currentTime=0;video.play().catch(()=>{})}catch{}}}
function handleMediaNext(){if(current>=0&&items[current])void navigateAdjacent(1)}
function registerMediaSessionActions(){const session=navigator.mediaSession;if(!session?.setActionHandler)return;try{session.setActionHandler('previoustrack',handleMediaPrevious)}catch{}try{session.setActionHandler('nexttrack',handleMediaNext)}catch{}}
function select(i,event,fromUser=false){
  if(event){event.preventDefault();event.stopPropagation()}if(!items[i])return;
  if(current>=0&&current!==i){persistPlayback(true);if(Number.isSafeInteger(globalIndex))globalIndex+=i-current}
  current=i;if(sourceShuffleSeed()){hasPrevious=current>0;hasNext=current<items.length-1}else if(Number.isSafeInteger(globalIndex)){hasPrevious=globalIndex>0;hasNext=globalIndex<totalItems-1}
  lastPlaybackPosition=-1;lastPlaybackWatched=false;const t=items[i],v=$('mainVideo');if(event||fromUser){v.muted=false;v.autoplay=false}
  if(singleVideoMode){const q=new URLSearchParams(location.search);q.set('play',t.id);history.replaceState(null,'','/player?'+q.toString())}
  showPlayerError('');$('playerState').hidden=false;updatePlayerState(t);t.mediaStartedAt=Date.now();v.src=t.streamUrl;v.load();v.addEventListener('loadedmetadata',function restore(){const p=progressInfo(t);if(!t.watched&&p.position>1&&p.position<v.duration-1){try{v.currentTime=p.position}catch{}}updatePlayerState(t)},{once:true});v.play().catch(()=>{});
  $('mainTitle').textContent=t.title||t.videoId;updateMediaSessionTrack(t);$('mainMeta').innerHTML='<span>'+esc(t.alias||t.author||'未知作者')+'</span><span>'+esc(date(t.uploadTime))+'</span><span>'+esc(views(t.views))+'</span><span>标签：'+esc(Array.isArray(t.tags)&&t.tags.length?t.tags.join(' · '):'暂无标签')+'</span><span>'+esc(t.localFileName||'本地文件')+'</span>';$('openPage').disabled=!t.sourcePage;$('openPage').onclick=()=>window.open(t.sourcePage,'_blank','noopener');$('resumeBtn').onclick=()=>{const p=progressInfo(t);if(p.position>0){try{v.currentTime=p.position}catch{};v.play().catch(()=>{})}};$('markBtn').onclick=()=>{t.watched=!t.watched;persistPlayback(true,t.watched);updatePlayerState(t);render()};
  $('prevBtn').disabled=current<0||(!hasPrevious&&current<=0);$('prevBtn').onclick=()=>navigateAdjacent(-1);$('nextBtn').disabled=current<0||(!hasNext&&current>=items.length-1);$('nextBtn').onclick=()=>navigateAdjacent(1);document.querySelectorAll('.card').forEach(c=>c.classList.toggle('active',Number(c.dataset.index)===current));renderNext()
}
 async function load(reset=true,randomize=recommendationMode,nextPage=null){
   if(loading&&!reset)return;clearTimeout(timer);listRequestController?.abort();const sequence=++listRequestSequence;const controller=new AbortController();listRequestController=controller;
   if(initialLoad&&!singleVideoMode&&libraryReturnState){const state=libraryReturnState;libraryReturnState=null;restoreLibraryReturnState(state);return}
   if(reset){if(!(initialLoad&&!randomize&&!singleVideoMode))pageNo=1;if(randomize)shuffleSeed=createShuffleSeed();else if(!initialLoad&&!singleVideoMode)shuffleSeed='';current=-1;globalIndex=null;hasPrevious=false;hasNext=false;selectedIds.clear();updateSelectionUi()}
  loading=true;const targetPlay=pendingPlay;
   $('status').textContent=targetPlay?'正在打开指定本地视频…':(recommendationMode?'正在从整个列表抽取随机推荐…':(randomize?'正在随机读取一页视频…':'正在读取本地列表…'));
   const scope=playlistScope();let sourceParams=null,sourcePath='';try{if(targetPlay&&sourcePage){const sourceUrl=new URL(sourcePage,location.origin);sourceParams=sourceUrl.searchParams;sourcePath=sourceUrl.pathname}}catch{}const shuffledPlayback=Boolean(targetPlay&&sourceParams?.get('shuffle'));const recommendationPlayback=Boolean(shuffledPlayback&&sourcePath==='/recommend');const requestedPage=shuffledPlayback?Math.max(1,Number(sourceParams.get('page')||1)||1):(nextPage||pageNo);const p=new URLSearchParams({query:scope.query,source:scope.source,sort:scope.sort,direction:scope.direction,watched:scope.watched,favorite:scope.library==='favorite'?'favorite':'all',watchLater:scope.library==='later'?'later':'all',queue:scope.library==='queued'?'queued':'all',discarded:scope.library==='discarded'?'only':'exclude',page:String(requestedPage),pageSize:String(playlistPageSize()),profile:scope.profile});
   if(recommendationMode||recommendationPlayback){p.set('randomSample','1');p.set('randomSeed',recommendationPlayback?sourceParams.get('shuffle'):shuffleSeed)}else if(targetPlay&&!shuffledPlayback){p.set('contextId',targetPlay);p.set('contextSize','5')}else if(randomize)p.set('randomPage','1');
  try{
    const r=await fetch('/playlist-data?'+p,{cache:'no-store',signal:controller.signal}),d=await r.json();if(sequence!==listRequestSequence)return;if(!r.ok)throw Error(d.error||r.status);if(d.playbackProfile==='remote'||d.playbackProfile==='local')setPlaybackProfile(d.playbackProfile);
    totalItems=Number(d.total||0);pageNo=Number(d.page||requestedPage);items=[...new Map((reset?(d.items||[]):items.concat(d.items||[])).map(item=>[item.id,item])).values()];if(!targetPlay&&shuffleSeed)items=shufflePageItems(items,shuffleSeed);
    if(targetPlay){
      pendingPlay='';if(d.playerError)showPlayerError(d.playerError.message);if(shuffledPlayback){items=shufflePageItems(items,String(sourceParams.get('shuffle')));current=items.findIndex(item=>item.id===targetPlay);globalIndex=current>=0?current:null;hasPrevious=current>0;hasNext=current>=0&&current<items.length-1;if(current<0)showPlayerError('视频不在来源随机页中，可能列表已变化；请返回列表重新打开。')}else{globalIndex=Number.isSafeInteger(d.globalIndex)?d.globalIndex:null;hasPrevious=Boolean(d.hasPrevious);hasNext=Boolean(d.hasNext);current=Number.isSafeInteger(d.currentIndex)&&d.currentIndex>=0?d.currentIndex:0}setViewMode('focus');$('mainVideo').muted=true;$('mainVideo').autoplay=true;render();
      if(items.length){select(Math.min(current,items.length-1));$('status').textContent='已打开独立播放器；播放列表已释放，仅保留相邻视频切换。'}else $('status').textContent=d.playerError?.message||'找不到对应的本地文件，可能已移动或缺失。'
     }else{$('status').textContent=(randomize?(recommendationMode?'已为你换好一批随机推荐，共 '+items.length+' 条；可点击“换一批推荐”继续发现。':'本次已随机打开第 '+pageNo+' 页，并打乱了本页顺序；封面由本地服务按需生成。'):'本地源已就绪；封面由本地服务加载，播放状态会自动保存。')+(playbackProfile==='remote'?' 当前为远程 480p 转码模式。':'');render();syncListUrl()}
  }catch(e){if(sequence===listRequestSequence&&e.name!=='AbortError')$('status').textContent='读取失败：'+e.message}finally{if(sequence===listRequestSequence){loading=false;initialLoad=false;listRequestController=null}}
}
function setViewMode(mode){const focus=singleVideoMode||mode==='focus';$('layout').classList.toggle('focus-player',focus);const button=$('toggleView');button.textContent=singleVideoMode?'返回播放列表':(focus?'返回列表':'大播放视角');button.setAttribute('aria-pressed',String(focus));try{if(!singleVideoMode)localStorage.setItem('iwara-player-view',focus?'focus':'split')}catch{}}
function updatePlayerFlags(t){const favorite=$('favoriteBtn'),later=$('laterBtn'),queue=$('queueBtn'),discard=$('discardBtn');if(!t){[favorite,later,queue,discard].forEach(button=>{if(button)button.disabled=true});return}if(favorite){favorite.disabled=false;favorite.textContent=t.favorite?'★ 已喜爱':'☆ 喜爱';favorite.classList.toggle('active',Boolean(t.favorite));favorite.onclick=()=>void updatePlaylistFlag(t.id,{favorite:!t.favorite})}if(later){later.disabled=false;later.textContent=t.watchLater?'已加入稍后':'稍后观看';later.classList.toggle('active',Boolean(t.watchLater));later.onclick=()=>void updatePlaylistFlag(t.id,{watchLater:!t.watchLater})}if(queue){queue.disabled=false;queue.textContent=t.queuePosition?'移出队列':'加入队列';queue.classList.toggle('active',Boolean(t.queuePosition));queue.onclick=()=>void updatePlaylistFlag(t.id,{queued:!t.queuePosition})}if(discard){discard.disabled=false;discard.textContent=t.discarded?'恢复视频':'丢弃此视频';discard.title=t.discarded?'从已丢弃列表恢复；不会移动或删除文件':'从普通播放列表隐藏；不会删除文件，可在“已丢弃（找回）”中恢复';discard.classList.toggle('active',Boolean(t.discarded));discard.onclick=()=>void toggleCurrentDiscard()}}
async function toggleCurrentDiscard(){const task=items[current];if(!task)return;persistPlayback(true);const discarded=!task.discarded,oldIndex=current,oldGlobal=globalIndex,button=$('discardBtn');if(button)button.disabled=true;const saved=await updatePlaylistFlag(task.id,{discarded});if(!saved){updatePlayerFlags(task);return}const message=discarded?'已丢弃此视频，正在切换到下一条…':'已恢复此视频，正在切换到下一条…';if(!singleVideoMode){const target=Math.max(0,oldIndex);await load(true,false);if(items.length){select(Math.min(target,items.length-1),null,true);$('status').textContent=message}return}if(sourceShuffleSeed()){items=items.filter(item=>item.id!==task.id);totalItems=Math.max(0,totalItems-1);if(!items.length){current=-1;globalIndex=null;hasPrevious=false;hasNext=false;const video=$('mainVideo');video.pause();video.removeAttribute('src');video.load();$('mainTitle').textContent='当前随机页没有更多视频';$('mainMeta').textContent='返回列表刷新随机页，或调整筛选条件。';$('playerState').hidden=true;render();updatePlayerFlags(null);$('status').textContent=message;return}current=Math.min(oldIndex,items.length-1);globalIndex=current;hasPrevious=current>0;hasNext=current<items.length-1;render();select(current,null,true);$('status').textContent=message;return}await loadContextIndex(Number.isSafeInteger(oldGlobal)?Math.max(0,oldGlobal):0,message)}
const _selectWithFlags=select;select=(...args)=>{const result=_selectWithFlags(...args);updatePlayerFlags(items[current]);return result};
async function queueViews(){const r=await(await fetch('/api/enrich/queue-views',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({})})).json();$('status').textContent='已加入 '+Number(r.queued||0)+' 条播放量同步任务'+(r.remaining?'，尚有 '+r.remaining+' 条待加入':'')+'；保持任一 Iwara 视频页打开即可逐步处理。'}
async function refreshAllViews(){if(!confirm('将重新读取所有已下载视频的播放量，保持任一 Iwara 视频页打开即可处理。确认继续？'))return;const r=await(await fetch('/api/enrich/refresh-views',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({})})).json();$('status').textContent='已加入 '+Number(r.queued||0)+' 条全部播放量更新任务'+(r.remaining?'，尚有 '+r.remaining+' 条待加入':'')+'；网页脚本将使用独立的 8 并发播放量队列。'}
async function queueTags(){const r=await(await fetch('/api/enrich/queue-tags',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({})})).json();$('status').textContent='已加入 '+Number(r.queued||0)+' 条标签同步任务'+(r.remaining?'，尚有 '+r.remaining+' 条待加入':'')+'；保持任一 Iwara 视频页打开即可逐步处理。'}
async function refreshAllTags(){if(!confirm('将重新读取所有已下载视频的标签，保持任一 Iwara 视频页打开即可处理。确认继续？'))return;const r=await(await fetch('/api/enrich/refresh-tags',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({})})).json();$('status').textContent='已加入 '+Number(r.queued||0)+' 条全部标签更新任务'+(r.remaining?'，尚有 '+r.remaining+' 条待加入':'')+'；网页脚本将使用独立的元数据队列。'}
function stripIdmPanels(root=document){for(const node of root.querySelectorAll?.('*')||[]){const marker=(node.id||'')+' '+(typeof node.className==='string'?node.className:'');if(/\bidm\b|internet-download-manager|download-manager/i.test(marker)&&node!==document.body&&node!==document.documentElement)node.remove()}}
 function setPlaybackProfile(profile){
  playbackProfile=profile==='remote'?'remote':'local';
  const badge=$('qualityMode'),toggle=$('qualityToggle'),home=$('pageTitle');
  const homeParams=new URLSearchParams({profile:playbackProfile});
  try{const accessToken=sessionStorage.getItem('iwaraAccessToken');if(accessToken)homeParams.set('access_token',accessToken)}catch{}
  if(home)home.href='/playlist?'+homeParams.toString();
  if(badge){badge.textContent=playbackProfile==='remote'?'远程 480p':'局域网原画';badge.classList.toggle('remote',playbackProfile==='remote')}
  if(toggle){const mobile=window.matchMedia('(max-width:600px)').matches;toggle.textContent=mobile?(playbackProfile==='remote'?'远程 480p':'局域网原画'):(playbackProfile==='remote'?'切换原画':'切换远程480p');toggle.title=playbackProfile==='remote'?'切换回局域网原画':'使用远程 480p 转码'}
 }
 function togglePlaybackProfile(){const q=new URLSearchParams(location.search);q.set('profile',playbackProfile==='remote'?'local':'remote');location.href=location.pathname+'?'+q.toString()}
 ${libraryReturnStateScript()}
  setPlaybackProfile(playbackProfile);$('qualityToggle').onclick=togglePlaybackProfile;const _mobileBreakpoint=window.matchMedia('(max-width:600px)'),_onMobileBreakpointChange=()=>{setPlaybackProfile(playbackProfile);renderTagCloud();if(!singleVideoMode)void load(true,false)};if(_mobileBreakpoint.addEventListener)_mobileBreakpoint.addEventListener('change',_onMobileBreakpointChange);else _mobileBreakpoint.addListener?.(_onMobileBreakpointChange);stripIdmPanels();new MutationObserver(mutations=>mutations.forEach(m=>m.addedNodes.forEach(n=>{if(n.nodeType===1){stripIdmPanels(n);const marker=(n.id||'')+' '+(typeof n.className==='string'?n.className:'');if(/\bidm\b|internet-download-manager|download-manager/i.test(marker))n.remove()}}))).observe(document.documentElement,{subtree:true,childList:true});
  $('toggleView').onclick=()=>{if(singleVideoMode){backToSource();return}const isFocus=$('layout').classList.contains('focus-player');setViewMode(isFocus?'split':'focus')};$('randomPage').onclick=()=>load(true,true);$('queueViews').onclick=queueViews;$('refresh').onclick=()=>load(true,recommendationMode);$('loadMore').onclick=loadNextPage;$('selectionModeToggle').onclick=()=>setSelectionMode(!document.body.classList.contains('selection-mode'));$('exitSelection').onclick=()=>setSelectionMode(false);$('selectAll').onclick=()=>{items.forEach(item=>selectedIds.add(item.id));render()};$('clearSelection').onclick=()=>{selectedIds.clear();render()};$('downloadSelected').onclick=downloadSelected;$('query').oninput=()=>{clearTimeout(timer);timer=setTimeout(()=>load(true),250)};['sort','direction','watchedFilter'].forEach(id=>$(id).onchange=()=>load(true));$('mainVideo').onended=()=>{persistPlayback(true);if(current<items.length-1)select(current+1);else if(hasNext)navigateAdjacent(1)};$('mainVideo').ontimeupdate=schedulePlaybackSave;$('mainVideo').onpause=()=>persistPlayback(true);$('mainVideo').onerror=()=>{const task=items[current];if(task)void explainMediaFailure($('mainVideo'),task)};$('mainVideo').onloadeddata=()=>showPlayerError('');window.addEventListener('pagehide',()=>{sendPlaybackBeacon()},{once:true});window.addEventListener('beforeunload',sendPlaybackBeacon,{once:true});if(!singleVideoMode){$('query').value=routeParams.get('query')||'';$('sort').value=routeParams.get('sort')||'updatedAt';$('direction').value=routeParams.get('direction')||'desc';$('watchedFilter').value=routeParams.get('watched')||'all'}document.body.classList.toggle('single-mode',singleVideoMode);if(singleVideoMode){setViewMode('focus');if(pendingPlay)load(true,false);else{render();$('status').textContent='请从播放列表选择一个视频。'}}else{try{setViewMode(localStorage.getItem('iwara-player-view')||'split')}catch{setViewMode('split')}setupInfiniteScroll();load(true,recommendationMode?!routeParams.has('shuffle'):!(routeParams.has('page')||routeParams.has('query')||routeParams.has('sort')||routeParams.has('direction')||routeParams.has('watched')))}
setPlaybackMode(playbackMode);$('playModeToggle').onclick=cyclePlaybackMode;$('refreshAllViews').onclick=refreshAllViews;$('mainVideo').onended=handlePlaybackEnded;bindUpnextScroll();registerMediaSessionActions();['play','playing','pause','emptied','loadedmetadata'].forEach(event=>$('mainVideo').addEventListener(event,updateMediaSessionPlaybackState));const _selectWithAudio=select;select=(i,event,fromUser=false)=>{const result=_selectWithAudio(i,event,fromUser);$('mainVideo').muted=false;return result};$('mainVideo').addEventListener('loadedmetadata',()=>{$('mainVideo').muted=false});const _nativeVideoStyle=document.createElement('style');_nativeVideoStyle.textContent='.player video::-webkit-media-controls-panel,.player video::-webkit-media-controls-enclosure,.player video::-webkit-media-controls-overlay-enclosure{background:transparent!important;background-color:transparent!important;background-image:none!important}';document.head.append(_nativeVideoStyle);
 $('query').addEventListener('input',renderTagCloud);void loadPopularTags();
 if($('queueTags'))$('queueTags').onclick=queueTags;if($('refreshAllTags'))$('refreshAllTags').onclick=refreshAllTags;
 void loadAuthorFilter();
 if(!singleVideoMode&&$('libraryFilter'))$('libraryFilter').value=routeParams.get('library')||'all';$('libraryFilter')?.addEventListener('change',()=>load(true));window.addEventListener('iwara-mobile-filter-clear',()=>load(true));_updateMobileFilterSummary();
 ${desktopLibraryEnhancementScript()}
 ${playbackExperienceScript()}
 ${presenceClientScript("playlist")}
 </script></html>`;
}

const MEDIA_MIME_TYPES = new Map([
  [".mp4", "video/mp4"],
  [".webm", "video/webm"],
  [".mkv", "video/x-matroska"],
  [".mov", "video/quicktime"],
  [".avi", "video/x-msvideo"],
  [".m4v", "video/x-m4v"]
]);

export function mediaContentType(filePath) {
  return MEDIA_MIME_TYPES.get(path.extname(String(filePath || "")).toLowerCase()) || "application/octet-stream";
}

function pipeMediaFile(response, filePath, options = {}) {
  const stream = createReadStream(filePath, options);
  stream.on("error", error => {
    if (!response.headersSent) sendJson(response, 500, { error: "读取本地视频失败" });
    else response.destroy(error);
  });
  response.on("close", () => stream.destroy());
  stream.pipe(response);
}

function parseMediaRanges(value, total) {
  if (!String(value || "").startsWith("bytes=")) return null;
  const parts = value.slice(6).split(",");
  if (!parts.length || parts.length > 4) return null;
  const ranges = [];
  for (const part of parts) {
    const match = /^(\d*)-(\d*)$/.exec(part.trim());
    if (!match || (!match[1] && !match[2])) return null;
    const suffix = !match[1];
    const start = suffix ? Math.max(0, total - Number(match[2])) : Number(match[1]);
    const end = suffix ? total - 1 : (match[2] ? Math.min(Number(match[2]), total - 1) : total - 1);
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start || start >= total) return null;
    ranges.push({ start, end });
  }
  return ranges;
}

function writeResponseChunk(response, chunk) {
  if (response.destroyed) return Promise.reject(new Error("连接已关闭"));
  if (response.write(chunk)) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const cleanup = () => { response.off("drain", onDrain); response.off("close", onClose); };
    const onDrain = () => { cleanup(); resolve(); };
    const onClose = () => { cleanup(); reject(new Error("连接已关闭")); };
    response.once("drain", onDrain);
    response.once("close", onClose);
  });
}

async function sendMultipartRanges(response, filePath, contentType, ranges, total, boundary) {
  try {
    for (const { start, end } of ranges) {
      await writeResponseChunk(response, `--${boundary}\r\nContent-Type: ${contentType}\r\nContent-Range: bytes ${start}-${end}/${total}\r\n\r\n`);
      for await (const chunk of createReadStream(filePath, { start, end })) await writeResponseChunk(response, chunk);
      await writeResponseChunk(response, "\r\n");
    }
    response.end(`--${boundary}--\r\n`);
  } catch (error) {
    response.destroy(error);
  }
}

async function serveLocalMedia(request, response, scheduler, encodedId, transcodeCache = null, profile = "local", download = false) {
  let lease = null;
  const release = () => { lease?.release?.(); lease = null; };
  response.once("finish", release);
  response.once("close", release);
  try {
    const taskId = decodeURIComponent(encodedId);
    const remote = normalizePlaybackProfile(profile) === "remote" && transcodeCache;
    if (remote && transcodeCache.acquire) lease = await transcodeCache.acquire(taskId, scheduler);
    const media = lease?.media || (remote ? await transcodeCache.get(taskId, scheduler) : await scheduler.mediaPath(taskId));
    if (response.destroyed || response.writableEnded) { release(); return; }
    const info = await stat(media.path);
    const total = info.size;
    const baseHeaders = {
      "content-type": mediaContentType(media.path),
      "accept-ranges": "bytes",
      "cache-control": "private, max-age=3600",
      "x-iwara-playback-profile": media.profile || "original",
      "content-disposition": `${download ? "attachment" : "inline"}; filename*=UTF-8''${encodeURIComponent(media.name)}`
    };
    const range = request.headers.range;
    if (!range) {
      response.writeHead(200, { ...baseHeaders, "content-length": total });
      if (request.method === "HEAD") return response.end();
      pipeMediaFile(response, media.path);
      return;
    }
    const ranges = parseMediaRanges(range, total);
    if (!ranges) {
      response.writeHead(416, { "content-range": `bytes */${total}` });
      return response.end();
    }
    if (ranges.length > 1) {
      const boundary = `iwara-${randomBytes(8).toString("hex")}`;
      const contentType = baseHeaders["content-type"];
      const closing = `--${boundary}--\r\n`;
      const length = ranges.reduce((sum, { start, end }) => sum
        + Buffer.byteLength(`--${boundary}\r\nContent-Type: ${contentType}\r\nContent-Range: bytes ${start}-${end}/${total}\r\n\r\n`)
        + end - start + 1 + 2, Buffer.byteLength(closing));
      response.writeHead(206, {
        ...baseHeaders,
        "content-type": `multipart/byteranges; boundary=${boundary}`,
        "content-length": length
      });
      if (request.method === "HEAD") return response.end();
      await sendMultipartRanges(response, media.path, contentType, ranges, total, boundary);
      return;
    }
    const { start, end: boundedEnd } = ranges[0];
    response.writeHead(206, {
      ...baseHeaders,
      "content-length": boundedEnd - start + 1,
      "content-range": `bytes ${start}-${boundedEnd}/${total}`
    });
    if (request.method === "HEAD") return response.end();
    pipeMediaFile(response, media.path, { start, end: boundedEnd });
  } catch (error) {
    release();
    if (response.destroyed || response.writableEnded) return;
    const status = error.message === "本地视频不存在" || error.code === "ENOENT"
      ? 404
      : error.code === "REMOTE_TRANSCODE_FAILED" || error.message.includes("远程转码") || error.message.includes("FFmpeg")
        ? 503
        : 403;
    sendJson(response, status, { error: error.message });
  }
}

async function serveLocalCover(request, response, scheduler, cache, encodedId) {
  try {
    const controller = new AbortController();
    response.once("close", () => controller.abort());
    const url = new URL(request.url, "http://localhost");
    const priority = url.searchParams.get("priority") === "1" ? 1 : 0;
    const taskId = decodeURIComponent(encodedId);
    const task = scheduler.store?.state?.tasks?.find(item => item.id === taskId);
    const coverPath = task?.coverPath ? path.resolve(task.coverPath) : "";
    const mediaRoots = [scheduler.config?.downloadRoot, ...(Array.isArray(scheduler.config?.externalMediaRoots) ? scheduler.config.externalMediaRoots : [])]
      .filter(Boolean).map(root => path.resolve(root));
    const coverAllowed = coverPath && mediaRoots.some(mediaRoot => {
      const relative = path.relative(mediaRoot, coverPath);
      return Boolean(relative) && !relative.startsWith("..") && !path.isAbsolute(relative);
    });
    if (coverAllowed && path.extname(coverPath).toLowerCase() === ".png") {
      const info = await stat(coverPath);
      if (info.isFile()) {
        response.writeHead(200, {
          "content-type": "image/png",
          "content-length": info.size,
          "cache-control": "private, no-store",
          "x-content-type-options": "nosniff"
        });
        if (request.method === "HEAD") response.end();
        else createReadStream(coverPath).pipe(response);
        return;
      }
    }
    const image = await cache.get(taskId, scheduler, { signal: controller.signal, priority });
    if (response.destroyed) return;
    response.writeHead(200, {
      "content-type": "image/jpeg",
      "content-length": image.length,
      "cache-control": "private, no-store",
      "x-content-type-options": "nosniff"
    });
    response.end(request.method === "HEAD" ? undefined : image);
  } catch (error) {
    if (response.destroyed) return;
    const status = error.message === "本地视频不存在" || error.code === "ENOENT" ? 404 : 503;
    sendJson(response, status, { error: status === 404 ? "本地视频不存在" : "封面暂时无法生成" });
  }
}

export function createServer({ scheduler, host, port, accessToken = "", ffmpeg = null, transcodeCache = null, mobileLibrary = null, han1meImporter = null, storageConfig = null, storageTransferStore = null, youtubeDownloader = null, onShutdown }) {
  const coverCache = new CoverCache({ ffmpeg });
  const mediaDiagnostics = [];
  const presenceClients = new Map();
  const batchDownloadJobs = new Map();
  const presenceTimeoutMs = 30_000;
  const sourceIdOf = task => classifyMediaSource(task) === "han1"
    ? String(task.videoId || "").replace(/^han1meview-/i, "")
    : String(task.videoId || "");
  const pathIsWithin = (root, candidate) => {
    const relative = path.relative(root, candidate);
    return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
  };
  const refreshInventory = async requested => {
    if (!storageTransferStore || !Array.isArray(requested)) return;
    const tasks = scheduler.store?.state?.tasks || [];
    for (const item of requested) {
      const repositories = (scheduler.config.storageRepositories || []).filter(repository => repository.enabled &&
        repository.source === item.source && repository.roles.includes("scan") && repository.roles.includes("serve") &&
        (!item.repositoryId || repository.id === item.repositoryId));
      if (item.source === "han1") {
        const relativePath = String(item.relativePath || "");
        const parts = relativePath.split("/");
        if (!relativePath || relativePath.includes("\\") || parts.some(part => !part || part === "." || part === "..") || parts[0] !== item.sourceId) continue;
        const indexedTask = tasks.find(task => classifyMediaSource(task) === "han1" &&
          (sourceIdOf(task) === item.sourceId || String(task.han1meId || "") === item.sourceId) && task.state === "completed");
        if (!indexedTask) continue;
        for (const repository of repositories) {
          try {
            const root = await realpath(repository.path);
            const candidate = path.resolve(root, ...parts);
            if (!pathIsWithin(root, candidate)) continue;
            const actualPath = await realpath(candidate);
            if (!pathIsWithin(root, actualPath)) continue;
            const fingerprint = await sha256File(actualPath);
            if (fingerprint.size !== Number(item.size) || fingerprint.sha256 !== item.sha256) continue;
            storageTransferStore.upsertInventory({ source: item.source, sourceId: item.sourceId,
              taskId: String(item.taskId || indexedTask.id), role: item.role || "media", repositoryId: repository.id,
              relativePath: parts.join("/"), filename: path.basename(actualPath), size: fingerprint.size,
              sha256: fingerprint.sha256, quality: "", metadata: {
                title: indexedTask.title || "", author: indexedTask.alias || indexedTask.author || "",
                uploadTime: indexedTask.uploadTime || null, views: indexedTask.views ?? indexedTask.viewCount ?? null,
                tags: indexedTask.tags || []
              } });
            break;
          } catch { /* Unavailable or changed files remain unconfirmed. */ }
        }
        continue;
      }

      // A source ID can legitimately have several quality/task rows. Prefer the frozen task ID,
      // otherwise inspect all matching rows instead of letting the last one mask the others.
      const candidates = tasks.filter(task => classifyMediaSource(task) === item.source &&
        sourceIdOf(task) === item.sourceId && task.destination && (!item.taskId || task.id === item.taskId));
      for (const task of candidates) {
        let identity;
        try { identity = scheduler.store.db.prepare("SELECT * FROM mobile_media_identity WHERE task_id=?").get(task.id); }
        catch { continue; }
        if (!identity || identity.size !== Number(item.size) || identity.sha256 !== item.sha256) continue;
        let info;
        try { info = await stat(identity.path); } catch { continue; }
        if (!info.isFile() || info.size !== identity.size || info.mtimeMs !== identity.mtime_ms) continue;
        const owner = repositoryOwnsPath(repositories, identity.path, "scan");
        if (!owner || owner.source !== item.source || !owner.roles.includes("serve")) continue;
        const relativePath = path.relative(owner.path, identity.path).split(path.sep).join("/");
        storageTransferStore.upsertInventory({ source: item.source, sourceId: item.sourceId, taskId: task.id,
          role: item.role || "media", repositoryId: owner.id, relativePath, filename: path.basename(identity.path),
          size: identity.size, sha256: identity.sha256, quality: String(task.quality || task.resolution || ""), metadata: {
            title: task.title || "", author: task.alias || task.author || "", uploadTime: task.uploadTime || null,
            views: task.views ?? task.viewCount ?? null, tags: task.tags || []
          } });
        break;
      }
    }
  };
  const repositoryAvailability = async source => {
    const repositories = scheduler.config.storageRepositories || [];
    const targets = repositories.filter(item => item.enabled && item.source === source && item.roles.includes("scan"));
    const results = await Promise.all(targets.map(async item => {
      try { const info = await stat(item.path); return { id: item.id, available: info.isDirectory() }; }
      catch { return { id: item.id, available: false }; }
    }));
    return { complete: results.length > 0 && results.every(item => item.available), results };
  };
  scheduler.setWebPresence?.(false, 0);
  const presenceTimer = setInterval(() => {
    const cutoff = Date.now() - presenceTimeoutMs;
    for (const [clientId, entry] of presenceClients) {
      if (entry.lastSeenAt < cutoff) presenceClients.delete(clientId);
    }
    scheduler.setWebPresence?.(presenceClients.size > 0, presenceClients.size);
  }, 5_000);
  presenceTimer.unref?.();
  const updatePresence = (clientId, active = true, page = "") => {
    const key = String(clientId || "").trim().slice(0, 120);
    if (!key) return { ok: false, ...scheduler.webPresenceStatus?.() };
    if (active) presenceClients.set(key, { lastSeenAt: Date.now(), page: String(page || "").slice(0, 80) });
    else presenceClients.delete(key);
    const status = scheduler.setWebPresence?.(presenceClients.size > 0, presenceClients.size)
      || { active: presenceClients.size > 0, clients: presenceClients.size, sleeping: false };
    return { ok: true, ...status };
  };
  const prepareBatchDownload = async (taskIds, requestedDownloadId = "", mobilePackage = null) => {
    const ids = [...new Set(taskIds.map(value => String(value || "").trim()).filter(Boolean))];
    if (!ids.length) throw new Error("请先选择要下载的视频");
    if (ids.length > 100) throw new Error("一次最多打包 100 个视频，请分批选择");
    const allowedRoots = [];
    const seenRoots = new Set();
    let externalRootIndex = 0;
    const addAllowedRoot = (value, primary = false) => {
      if (typeof value !== "string" || !value.trim()) return;
      const resolved = path.resolve(value);
      const key = resolved.toLocaleLowerCase();
      if (seenRoots.has(key)) return;
      seenRoots.add(key);
      let archivePrefix = "";
      if (!primary) {
        externalRootIndex += 1;
        const rootName = path.basename(resolved) || "media";
        archivePrefix = "external-" + externalRootIndex + "-" + rootName;
      }
      allowedRoots.push({ path: resolved, archivePrefix });
    };
    const configuredMediaRoots = (scheduler.config?.storageRepositories || [])
      .filter(item => item.enabled && item.roles.includes("serve"))
      .sort((left, right) => right.path.length - left.path.length || left.priority - right.priority);
    if (configuredMediaRoots.length) {
      for (const repository of configuredMediaRoots) addAllowedRoot(repository.path, repository.path === scheduler.config?.downloadRoot);
    } else {
      addAllowedRoot(scheduler.config?.downloadRoot, true);
      for (const mediaRoot of Array.isArray(scheduler.config?.externalMediaRoots) ? scheduler.config.externalMediaRoots : []) addAllowedRoot(mediaRoot);
      addAllowedRoot(scheduler.config?.han1meDownloadRoot);
    }
    if (!allowedRoots.length) throw new Error("服务未配置媒体目录，无法安全打包");
    const files = [];
    const missing = [];
    const seenPaths = new Set();
    for (const taskId of ids) {
      let media;
      try { media = await scheduler.mediaPath(taskId); }
      catch { missing.push(taskId); continue; }
      const filePath = path.resolve(media.path);
      const matchedRoot = allowedRoots.map(root => ({ root, relative: path.relative(root.path, filePath) }))
        .find(({ relative }) => relative && relative !== ".." && !relative.startsWith(".." + path.sep) && !path.isAbsolute(relative));
      if (!matchedRoot) throw new Error("所选文件位于未配置的媒体目录，已停止打包");
      const normalizedPath = filePath.toLocaleLowerCase();
      if (seenPaths.has(normalizedPath)) continue;
      seenPaths.add(normalizedPath);
      let info;
      try { info = await stat(filePath); }
      catch { missing.push(taskId); continue; }
      if (!info.isFile()) { missing.push(taskId); continue; }
      const mobileInfo = mobilePackage?.videosByTaskId?.get(taskId);
      if (mobilePackage?.protocolVersion === 2) {
        const priorIdentity = scheduler.store.db.prepare("SELECT * FROM mobile_media_identity WHERE task_id=?").get(taskId);
        let fingerprint = priorIdentity && priorIdentity.path === filePath && priorIdentity.size === info.size && priorIdentity.mtime_ms === info.mtimeMs
          ? { size: priorIdentity.size, mtimeMs: priorIdentity.mtime_ms, sha256: priorIdentity.sha256 }
          : await sha256File(filePath);
        if (fingerprint.size !== info.size || fingerprint.mtimeMs !== info.mtimeMs) throw new Error(`文件在打包时发生变化：${path.basename(filePath)}`);
        if (mobileInfo && mobileInfo.sha256 && mobileInfo.sha256 !== fingerprint.sha256) throw new Error(`文件指纹与已保存资料不符：${path.basename(filePath)}`);
        if (mobileInfo) mobileInfo.sha256 = fingerprint.sha256;
      }
      const safeName = path.basename(media.name || filePath).replace(/[\\/\u0000-\u001f]/g, "_").replace(/^\.+/, "").slice(0, 150) || "video.mp4";
      files.push({
        path: filePath,
        taskId,
        archiveName: mobilePackage
          ? `media/${String(files.length + 1).padStart(3, "0")}-${safeName}`
          : (matchedRoot.root.archivePrefix ? matchedRoot.root.archivePrefix + "/" : "") + matchedRoot.relative.split(path.sep).join("/"),
        size: info.size,
        mtimeMs: info.mtimeMs
      });
      if (mobilePackage && !mobileInfo) throw new Error("随机下载资料不完整，请重新发起");
      if (mobileInfo) mobileInfo.entryName = files.at(-1).archiveName;
    }
    if (missing.length) {
      const error = new Error(`所选项目中有 ${missing.length} 个文件缺失或不可用，请刷新列表后重试`);
      error.statusCode = 409;
      error.missing = missing;
      throw error;
    }
    const totalBytes = files.reduce((total, file) => total + file.size, 0);
    if (!Number.isSafeInteger(totalBytes)) throw new Error("所选文件总大小超出安全范围，请减少选择数量");
    if (mobilePackage) {
      const manifestVideos = files.map(file => ({ ...mobilePackage.videosByTaskId.get(file.taskId),
        sourceId: mobilePackage.videosByTaskId.get(file.taskId)?.sourceId || mobilePackage.videosByTaskId.get(file.taskId)?.videoId || "",
        name: path.basename(file.path), size: file.size, entryName: file.archiveName }));
      const manifest = {
        type: "iwara-mobile-random-batch",
        version: mobilePackage.protocolVersion === 2 ? 2 : 1,
        source: mobilePackage.source,
        transferId: mobilePackage.transferId || "",
        videos: manifestVideos,
        ...(mobilePackage.protocolVersion === 2 ? { files: manifestVideos.map(video => ({ source: video.source, sourceId: video.sourceId,
          taskId: video.taskId, role: "media", path: video.entryName, size: video.size, sha256: video.sha256 })) } : {})
      };
      const manifestBytes = Buffer.from(JSON.stringify(manifest), "utf8");
      files.unshift({ archiveName: "manifest.json", data: manifestBytes, size: manifestBytes.length, mtimeMs: Date.now() });
    }
    const now = Date.now();
    for (const [token, job] of batchDownloadJobs) if (job.expiresAt <= now) batchDownloadJobs.delete(token);
    const token = String(requestedDownloadId || "").trim() || randomBytes(18).toString("hex");
    if (!/^[a-f0-9]{36}$/i.test(token) || batchDownloadJobs.has(token)) {
      throw new Error("批量下载标识无效，请重新发起下载");
    }
    const timestamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
    const job = {
      files,
      totalBytes,
      archiveBytes: storedZipContentLength(files),
      bytesSent: 0,
      archiveName: `Iwara-batch-${timestamp}.zip`,
      expiresAt: now + (mobilePackage ? 12 * 60 * 60_000 : 15 * 60_000),
      active: false,
      completed: false,
      interrupted: false,
      fileCount: mobilePackage ? files.length - 1 : files.length
    };
    batchDownloadJobs.set(token, job);
    return {
      url: `/batch-download/${token}.zip`,
      downloadId: token,
      fileCount: job.fileCount,
      totalBytes,
      archiveBytes: job.archiveBytes,
      archiveName: job.archiveName,
      expiresInSeconds: mobilePackage ? 12 * 60 * 60 : 15 * 60
    };
  };
  const prepareMobileRandomDownload = async body => {
    if (!mobileLibrary) throw Object.assign(new Error("手机资料同步尚未启用"), { statusCode: 503 });
    const protocolVersion = Number(body.protocolVersion) === 2 ? 2 : 1;
    const requestKey = String(body.requestKey || "").trim().slice(0, 160);
    if (protocolVersion === 2 && !storageTransferStore) throw Object.assign(new Error("持久传输任务存储尚未启用"), { statusCode: 503 });
    if (protocolVersion === 2 && requestKey) {
      const prior = storageTransferStore.getTransferByRequestKey(requestKey);
      if (prior) return { ...prior.payload, transferId: prior.id,
        batches: prior.batches.map(batch => ({ ...batch.payload, batchId: batch.id, state: batch.state })) };
    }
    const transferId = protocolVersion === 2 ? randomUUID() : "";
    const source = ["all", "iwara", "han1"].includes(body.source) ? body.source : "all";
    const requested = Number(body.count ?? 20);
    if (!Number.isInteger(requested) || requested < 1 || requested > 100) {
      throw Object.assign(new Error("随机下载数量必须是 1–100 的整数"), { statusCode: 400 });
    }
    const excludeValues = Array.isArray(body.excludeTaskIds) ? body.excludeTaskIds : [];
    if (excludeValues.length > 20000) throw Object.assign(new Error("手机已下载记录过多，请先同步台账后重试"), { statusCode: 413 });
    const excluded = new Set(excludeValues.map(value => String(value || "").trim()).filter(Boolean));
    const tasks = scheduler.store?.state?.tasks;
    if (!Array.isArray(tasks)) throw Object.assign(new Error("当前服务不支持手机随机下载"), { statusCode: 503 });
    const candidates = tasks.filter(task => task.state === "completed" && task.fileStatus === "present"
      && task.destination && !task.discarded && !excluded.has(String(task.id))
      && (source === "all" || classifyMediaSource(task) === source));
    for (let index = candidates.length - 1; index > 0; index -= 1) {
      const other = randomInt(index + 1);
      [candidates[index], candidates[other]] = [candidates[other], candidates[index]];
    }
    const batchLimit = 4_500_000_000;
    const batchTarget = protocolVersion === 2 ? 1024 ** 3 : batchLimit;
    const selected = [];
    let oversizeSkipped = 0;
    let unavailableSkipped = 0;
    for (const task of candidates) {
      if (selected.length >= requested) break;
      let media;
      try { media = await scheduler.mediaPath(task.id); }
      catch { unavailableSkipped += 1; continue; }
      let info;
      try { info = await stat(media.path); }
      catch { unavailableSkipped += 1; continue; }
      if (!info.isFile() || info.size <= 0) { unavailableSkipped += 1; continue; }
      if (info.size > batchLimit) { oversizeSkipped += 1; continue; }
      let sha256 = "";
      if (protocolVersion === 2) {
        const identity = scheduler.store.db.prepare("SELECT * FROM mobile_media_identity WHERE task_id=?").get(task.id);
        if (identity && identity.path === path.resolve(media.path) && identity.size === info.size && identity.mtime_ms === info.mtimeMs) sha256 = identity.sha256;
        else {
          try { const fingerprint = await sha256File(media.path); if (fingerprint.size !== info.size || fingerprint.mtimeMs !== info.mtimeMs) throw new Error("file changed"); sha256 = fingerprint.sha256; }
          catch { unavailableSkipped += 1; continue; }
        }
      }
      const viewCount = task.viewCount ?? task.views;
      const uploadTimeValue = task.uploadTime;
      const uploadTimeParsed = typeof uploadTimeValue === "number"
        ? (uploadTimeValue < 100_000_000_000 ? uploadTimeValue * 1000 : uploadTimeValue)
        : Date.parse(uploadTimeValue);
      const completedAtParsed = Date.parse(task.completedAt);
      selected.push({
        id: String(task.id),
        size: info.size,
        video: {
          taskId: String(task.id),
          videoId: String(task.videoId || "").slice(0, 256),
          source: classifyMediaSource(task),
          sourceId: sourceIdOf(task),
          ...(protocolVersion === 2 ? { sha256 } : {}),
          title: String(task.title || "").slice(0, 512),
          author: String(task.alias || task.author || "").slice(0, 256),
          uploadTime: Number.isFinite(uploadTimeParsed) ? uploadTimeParsed : null,
          views: viewCount != null && Number.isFinite(Number(viewCount)) ? Number(viewCount) : null,
          tags: (Array.isArray(task.tags) ? task.tags : []).map(tag => (typeof tag === "string" ? tag : String(tag?.name || tag?.id || "")).slice(0, 160)).filter(Boolean).slice(0, 300),
          downloadTime: Number.isFinite(completedAtParsed) ? completedAtParsed : null
        }
      });
    }
    const groups = [];
    let group = { items: [], totalBytes: 0 };
    for (const item of selected) {
      if (group.items.length && group.totalBytes + item.size > batchTarget) { groups.push(group); group = { items: [], totalBytes: 0 }; }
      group.items.push(item); group.totalBytes += item.size;
    }
    if (group.items.length) groups.push(group);
    const batches = [];
    try {
      for (const current of groups) {
        const videosByTaskId = new Map(current.items.map(item => [item.id, item.video]));
        const batchId = protocolVersion === 2 ? randomUUID() : "";
        const prepared = await prepareBatchDownload(current.items.map(item => item.id), "", { source, videosByTaskId, protocolVersion, transferId });
        batches.push({ ...prepared, totalBytes: current.totalBytes, batchId,
          taskIds: current.items.map(item => item.id), videosByTaskId: Object.fromEntries(videosByTaskId) });
      }
    } catch (error) {
      for (const batch of batches) batchDownloadJobs.delete(batch.downloadId);
      throw error;
    }
    const result = {
      source,
      requestedCount: requested,
      selectedCount: selected.length,
      alreadyPresentCount: excluded.size,
      oversizeSkipped,
      unavailableSkipped,
      batchLimitBytes: batchTarget,
      batches
    };
    if (protocolVersion === 2) {
      const transferBatches = groups.map((group, index) => {
        const prepared = batches[index];
        return { id: prepared.batchId, batchNo: index + 1, totalBytes: group.totalBytes,
          payload: { url: prepared.url, downloadId: prepared.downloadId, archiveName: prepared.archiveName,
            archiveBytes: prepared.archiveBytes, expiresInSeconds: prepared.expiresInSeconds,
            taskIds: prepared.taskIds, source, videosByTaskId: prepared.videosByTaskId },
          files: group.items.map(item => ({ source: item.video.source, sourceId: item.video.sourceId,
            taskId: item.id, role: "media", relativePath: item.video.entryName || item.video.videoId,
            size: item.size, sha256: item.video.sha256 })) };
      });
      const transfer = storageTransferStore.createTransfer({ id: transferId, direction: "download", source,
        configVersion: "", requestKey, payload: { source, requestedCount: requested, selectedCount: selected.length,
          alreadyPresentCount: excluded.size, oversizeSkipped, unavailableSkipped, batchLimitBytes: batchTarget }, batches: transferBatches });
      result.transferId = transfer.id;
      result.batches = transfer.batches.map((batch, index) => ({ ...batches[index], batchId: batch.id, state: batch.state }));
    }
    return result;
  };
  const server = http.createServer(async (request, response) => {
    const origin = request.headers.origin || "";
    const reply = (status, payload) => sendJson(response, status, payload, origin, request.headers.host || "");
    try {
      const url = new URL(request.url, `http://${request.headers.host}`);
      if (/^\/(media|cover)\//.test(url.pathname)) {
        const remote = normalizeAddress(request.socket?.remoteAddress || "unknown");
        const range = String(request.headers.range || "-").slice(0, 120);
        const resourceId = url.pathname.startsWith("/media/") ? url.pathname.slice(7) : "";
        const profile = requestPlaybackProfile(request, url);
        const startedAt = Date.now();
        const record = (status, aborted = false) => {
          if (!resourceId) return;
          mediaDiagnostics.push({ taskId: resourceId, status, aborted, range, profile, startedAt });
          if (mediaDiagnostics.length > 200) mediaDiagnostics.shift();
        };
        let finished = false;
        response.on("finish", () => {
          finished = true;
          record(response.statusCode);
          if (response.statusCode >= 400) {
            console.warn(`[局域网资源] ${remote} ${request.method} ${url.pathname} HTTP ${response.statusCode} Range ${range}`);
          }
        });
        response.on("close", () => {
          if (!finished && !response.writableFinished) {
            record(response.statusCode, true);
            console.warn(`[局域网资源] ${remote} ${request.method} ${url.pathname} 连接中断 Range ${range}`);
          }
        });
      }
      const isDirectBatchDownload = request.method === "POST" && url.pathname === "/batch-download";
      const isBatchCapabilityGet = request.method === "GET" && authorizeBatchDownloadRequest(request, url, accessToken, batchDownloadJobs).viaCapability;
      // Mobile WebViews may submit a form or follow its redirect with an
      // opaque/custom Origin. POST uses the LAN token; the follow-up GET uses
      // its short-lived, unguessable download capability.
      if (!allowedOrigin(origin, request.headers.host || "") && !isDirectBatchDownload && !isBatchCapabilityGet) {
        reply(403, { error: "origin not allowed" });
        return;
      }
      if (request.method === "POST" && url.pathname === "/api/login") {
        const body = await readJson(request);
        if (!tokenMatches(accessToken, body.token)) {
          reply(401, { error: "令牌无效" });
          return;
        }
        response.writeHead(200, {
          "content-type": "application/json; charset=utf-8",
          "cache-control": "no-store",
          "set-cookie": "iwara_lan_token=" + encodeURIComponent(String(accessToken)) + "; HttpOnly; SameSite=Strict; Path=/; Max-Age=2592000"
        });
        response.end(JSON.stringify({ ok: true }));
        return;
      }
      const auth = isDirectBatchDownload
        ? { ok: true, viaDirectBatchDownload: true }
        : authorizeBatchDownloadRequest(request, url, accessToken, batchDownloadJobs);
      if (!auth.ok) {
        if (request.method === "GET" && ["/", "/player", "/playlist", "/playlist.html", "/recommend"].includes(url.pathname)) {
          const body = lanLoginHtml();
          response.writeHead(200, {
            "content-type": "text/html; charset=utf-8",
            "content-length": Buffer.byteLength(body),
            "cache-control": "no-store",
            "x-content-type-options": "nosniff",
            "x-frame-options": "DENY",
            "referrer-policy": "no-referrer",
            "content-security-policy": "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; object-src 'none'; frame-src 'none'"
          });
          response.end(body);
          return;
        }
        const body = JSON.stringify({ error: "需要局域网访问令牌", hint: "请使用服务日志中的局域网播放链接访问" });
        response.writeHead(401, {
          "content-type": "application/json; charset=utf-8",
          "content-length": Buffer.byteLength(body),
          "cache-control": "no-store",
          "www-authenticate": "Bearer"
        });
        response.end(body);
        return;
      }
      if (auth.viaQuery && request.method === "GET" && ["/", "/player", "/playlist", "/playlist.html", "/recommend"].includes(url.pathname)) {
        // Keep the token in the first HTML response: mobile browsers sometimes
        // drop the redirect cookie, which made subsequent playlist API calls 401.
        // The page bootstrap consumes it, stores it for this tab, then removes it
        // from the address bar and adds it to same-origin API requests.
        response.setHeader("set-cookie", "iwara_lan_token=" + encodeURIComponent(String(accessToken)) + "; HttpOnly; SameSite=Strict; Path=/; Max-Age=2592000");
      }
      if (request.method === "OPTIONS") {
        const headers = {
          "access-control-allow-headers": "content-type",
          "access-control-allow-methods": "GET,POST,OPTIONS"
        };
        if (origin) headers["access-control-allow-origin"] = origin;
        response.writeHead(204, headers);
        response.end();
        return;
      }
      if (["GET", "PUT"].includes(request.method) && url.pathname === "/api/storage/repositories" ||
          request.method === "POST" && url.pathname === "/api/storage/repositories/validate") {
        if (!isLoopbackAddress(request.socket?.remoteAddress || "")) { reply(403, { error: "仓库路径管理只允许电脑本机访问" }); return; }
        if (!storageConfig) { reply(503, { error: "仓库配置管理尚未启用" }); return; }
        if (request.method === "GET") reply(200, storageConfig.view());
        else {
          const body = await readJson(request, 1024 * 1024);
          if (!Array.isArray(body.repositories)) { reply(400, { error: "缺少仓库数组" }); return; }
          if (url.pathname.endsWith("/validate")) {
            const repositories = await storageConfig.validate(body.repositories);
            reply(200, { valid: true, repositories });
          } else {
            const result = await storageConfig.save(body.repositories, String(body.revision || ""));
            reply(200, result);
          }
        }
      } else if (request.method === "GET" && url.pathname === "/api/mobile/capabilities") {
        const repositories = (scheduler.config.storageRepositories || []).filter(item => item.enabled &&
          ["iwara", "han1"].includes(item.source) && (item.roles.includes("serve") || item.roles.includes("receive")));
        const availability = await Promise.all(repositories.map(async item => {
          try { return { id: item.id, available: (await stat(item.path)).isDirectory() }; }
          catch { return { id: item.id, available: false }; }
        }));
        reply(200, { protocolVersions: [1, 2], preferredProtocolVersion: 2,
          serviceId: storageTransferStore?.serviceId || "", batchTargetBytes: 1024 ** 3,
          batchHardLimitBytes: 4_500_000_000, repositories: repositories.map(item => ({ id: item.id,
            name: item.name, source: item.source, roles: item.roles, available: availability.find(state => state.id === item.id)?.available ?? false })) });
      } else if (request.method === "GET" && url.pathname === "/api/mobile/download-history") {
        if (!storageTransferStore) { reply(503, { error: "持久媒体历史尚未启用" }); return; }
        const source = String(url.searchParams.get("source") || "");
        if (source && !["iwara", "han1"].includes(source)) { reply(400, { error: "来源无效" }); return; }
        reply(200, { items: storageTransferStore.listHistory(source) });
      } else if (request.method === "POST" && url.pathname === "/api/mobile/inventory/check") {
        if (!storageTransferStore) { reply(503, { error: "媒体库存尚未启用" }); return; }
        const body = await readJson(request, 2 * 1024 * 1024);
        if (!Array.isArray(body.files) || body.files.length > 5000) { reply(400, { error: "文件核对清单无效" }); return; }
        const files = body.files.map(file => ({ source: String(file?.source || ""), sourceId: String(file?.sourceId || ""),
          taskId: String(file?.taskId || ""), relativePath: String(file?.relativePath || ""),
          repositoryId: String(file?.repositoryId || ""), size: Number(file?.size),
          sha256: String(file?.sha256 || "").toLowerCase(), role: String(file?.role || "media") }));
        if (files.some(file => !["iwara", "han1"].includes(file.source) || !file.sourceId ||
            !Number.isSafeInteger(file.size) || file.size < 0 || !/^[a-f0-9]{64}$/.test(file.sha256))) {
          reply(400, { error: "文件身份、长度或 SHA-256 无效" }); return;
        }
        await refreshInventory(files);
        const checked = storageTransferStore.checkInventory(files);
        const availability = new Map();
        for (const source of new Set(files.map(file => file.source))) availability.set(source, await repositoryAvailability(source));
        for (const item of checked) {
          if (item.status === "missing" && !availability.get(item.source)?.complete) {
            item.status = "unknown";
            item.reason = "至少一个启用的扫描仓库当前不可用，不能确认文件缺失";
          } else if (item.status === "present") {
            const unavailableCopy = item.copies?.some(copy => availability.get(item.source)?.results.find(repo => repo.id === copy.repositoryId)?.available === false);
            if (unavailableCopy) { item.status = "unknown"; item.reason = "文件所在仓库当前不可用"; }
          }
        }
        reply(200, { checkedAt: new Date().toISOString(), complete: [...availability.values()].every(item => item.complete), files: checked });
      } else if (request.method === "POST" && url.pathname === "/api/mobile/transfers") {
        if (!storageTransferStore) { reply(503, { error: "传输任务存储尚未启用" }); return; }
        const body = await readJson(request, 4 * 1024 * 1024);
        const direction = String(body.direction || ""); const source = String(body.source || "");
        if (!["upload", "download"].includes(direction) || !["iwara", "han1"].includes(source) || !Array.isArray(body.files) || !body.files.length || body.files.length > 5000) {
          reply(400, { error: "传输方向、来源或文件清单无效" }); return;
        }
        const repository = (scheduler.config.storageRepositories || []).find(item => item.enabled && item.id === body.repositoryId &&
          item.source === source && item.roles.includes(direction === "upload" ? "receive" : "serve"));
        if (!repository) { reply(409, { error: "指定仓库未启用或不支持该传输方向" }); return; }
        const files = body.files.map(file => ({ source: String(file?.source || source), sourceId: String(file?.sourceId || ""),
          taskId: String(file?.taskId || ""), role: String(file?.role || "media"), relativePath: String(file?.relativePath || file?.filename || ""),
          size: Number(file?.size), sha256: String(file?.sha256 || "").toLowerCase(), repositoryId: repository.id }));
        if (files.some(file => file.source !== source || !file.sourceId || !file.relativePath || file.relativePath.length > 512 ||
            file.relativePath.includes("..") || file.relativePath.includes("\\") || !Number.isSafeInteger(file.size) || file.size < 0 ||
            file.size > 4_500_000_000 || !/^[a-f0-9]{64}$/.test(file.sha256))) {
          reply(400, { error: "文件清单含有无效路径、大小或 SHA-256" }); return;
        }
        const groupedFiles = new Map();
        for (const file of files) {
          if (!groupedFiles.has(file.sourceId)) groupedFiles.set(file.sourceId, []);
          groupedFiles.get(file.sourceId).push(file);
        }
        const groups = []; let current = { files: [], totalBytes: 0 };
        for (const [sourceId, groupFiles] of groupedFiles) {
          const groupBytes = groupFiles.reduce((total, file) => total + file.size, 0);
          if (!Number.isSafeInteger(groupBytes) || groupBytes > 4_500_000_000) {
            reply(413, { error: `来源编号 ${sourceId} 的单个文件组超过批次硬上限` }); return;
          }
          if (current.files.length && current.totalBytes + groupBytes > 1024 ** 3) {
            groups.push(current); current = { files: [], totalBytes: 0 };
          }
          current.files.push(...groupFiles); current.totalBytes += groupBytes;
          if (groupBytes >= 1024 ** 3) { groups.push(current); current = { files: [], totalBytes: 0 }; }
        }
        if (current.files.length) groups.push(current);
        const transfer = storageTransferStore.createTransfer({ direction, source, repositoryId: repository.id,
          configVersion: storageConfig?.view().revision || "", requestKey: String(body.requestKey || "").slice(0, 160),
          payload: { protocolVersion: 2 }, batches: groups.map((group, index) => ({ batchNo: index + 1, totalBytes: group.totalBytes, files: group.files })) });
        reply(201, transfer);
      } else if (request.method === "GET" && /^\/api\/mobile\/transfers\/[^/]+\/batches\/[^/]+\/archive$/.test(url.pathname)) {
        if (!storageTransferStore) { reply(503, { error: "传输任务存储尚未启用" }); return; }
        const match = /^\/api\/mobile\/transfers\/([^/]+)\/batches\/([^/]+)\/archive$/.exec(url.pathname);
        const id = decodeURIComponent(match[1]); const batchId = decodeURIComponent(match[2]);
        const transfer = storageTransferStore.getTransfer(id); const batch = transfer?.batches.find(item => item.id === batchId);
        if (!transfer || !batch) { reply(404, { error: "传输任务或批次不存在" }); return; }
        if (transfer.direction !== "download") { reply(409, { error: "该批次不是电脑到手机下载任务" }); return; }
        try {
          let prepared = batch.payload;
          const currentJob = batchDownloadJobs.get(String(prepared.downloadId || ""));
          if (!currentJob || currentJob.expiresAt <= Date.now()) {
            const videosByTaskId = new Map(Object.entries(prepared.videosByTaskId || {}));
            const regenerated = await prepareBatchDownload(prepared.taskIds || [], "", {
              protocolVersion: 2, transferId: id, source: transfer.source, videosByTaskId
            });
            prepared = { ...prepared, ...regenerated, taskIds: prepared.taskIds,
              videosByTaskId: Object.fromEntries(videosByTaskId) };
            storageTransferStore.setBatchPayload(id, batchId, prepared);
          }
          response.writeHead(303, { location: prepared.url, "content-length": 0, "cache-control": "no-store" }); response.end();
        } catch (error) { reply(error.statusCode || 409, { error: error.message || "本批文件不可恢复，请重新创建随机下载批次" }); }
      } else if (request.method === "PUT" && /^\/api\/mobile\/transfers\/[^/]+\/batches\/[^/]+\/archive$/.test(url.pathname)) {
        if (!storageTransferStore) { reply(503, { error: "传输任务存储尚未启用" }); return; }
        const match = /^\/api\/mobile\/transfers\/([^/]+)\/batches\/([^/]+)\/archive$/.exec(url.pathname);
        const id = decodeURIComponent(match[1]); const batchId = decodeURIComponent(match[2]);
        const transfer = storageTransferStore.getTransfer(id);
        const batch = transfer?.batches.find(item => item.id === batchId);
        if (!transfer || !batch) { reply(404, { error: "传输任务或批次不存在" }); return; }
        if (transfer.direction !== "upload" || transfer.source !== "han1") { reply(409, { error: "当前批次不支持 Han 文件上传" }); return; }
        if (!/^application\/zip(?:\s*;|$)/i.test(String(request.headers["content-type"] || ""))) { reply(415, { error: "归档请求必须使用 application/zip" }); return; }
        const repository = (scheduler.config.storageRepositories || []).find(item => item.id === transfer.repositoryId && item.enabled && item.source === "han1" && item.roles.includes("receive"));
        if (!repository) { reply(409, { error: "传输目标仓库已经停用或不再可用" }); return; }
        storageTransferStore.setBatchState(id, batchId, "transferring");
        try {
          const result = await receiveHan1meArchive(request, repository.path, { expectedTransferId: id, expectedFiles: batch.files });
          if (result.manifestVersion !== 2 || result.transferId !== id) throw Object.assign(new Error("ZIP 清单未绑定当前 v2 传输任务"), { statusCode: 409 });
          const expected = new Map(batch.files.map(file => [`${file.source}\u0000${file.sourceId}\u0000${file.role}\u0000${file.relativePath}\u0000${file.size}\u0000${file.sha256}`, file]));
          if (result.files.length !== expected.size || result.files.some(file => !expected.has(`${file.source}\u0000${file.sourceId}\u0000${file.role}\u0000${file.relativePath}\u0000${file.size}\u0000${file.sha256}`))) {
            throw Object.assign(new Error("已验证 ZIP 文件集合与本批冻结清单不同"), { statusCode: 409 });
          }
          await han1meImporter?.scan().catch(error => console.warn("Han 归档后入账扫描失败", error.message));
          storageTransferStore.setBatchPayload(id, batchId, { ...batch.payload, archiveBytes: result.archiveBytes });
          const receipts = result.files.map(file => ({ ...file, state: "saved" }));
          const updated = storageTransferStore.confirmFiles(id, batchId, receipts);
          reply(200, { ok: true, saved: true, indexed: false, transferId: id, batchId,
            codes: result.codes, codeCount: result.codeCount, fileCount: result.fileCount,
            archiveBytes: result.archiveBytes, files: receipts, transfer: updated });
        } catch (error) {
          try { storageTransferStore.setBatchState(id, batchId, "failed", String(error.message || "归档失败")); } catch {}
          if (!response.headersSent) reply(error.statusCode || 400, { error: error.message || "归档失败", transfer: storageTransferStore.getTransfer(id) });
          else response.destroy(error);
        }
      } else if (request.method === "GET" && /^\/api\/mobile\/transfers\/[^/]+$/.test(url.pathname)) {
        if (!storageTransferStore) { reply(503, { error: "传输任务存储尚未启用" }); return; }
        const id = decodeURIComponent(url.pathname.split("/").at(-1));
        const transfer = storageTransferStore.getTransfer(id);
        if (!transfer) { reply(404, { error: "传输任务不存在" }); return; }
        if (transfer.direction === "upload") {
          const saved = transfer.batches.flatMap(batch => batch.files).filter(file => file.state === "saved");
          if (saved.length) {
            await refreshInventory(saved);
            const checked = storageTransferStore.checkInventory(saved);
            const receipts = checked.filter(item => item.status === "present").map(item => ({ ...item, state: "indexed", role: item.role,
              relativePath: transfer.batches.flatMap(batch => batch.files).find(file => file.source === item.source &&
                file.sourceId === item.sourceId && file.taskId === item.taskId && file.role === item.role &&
                file.size === item.size && file.sha256 === item.sha256)?.relativePath || "" }));
            for (const batch of transfer.batches) {
              const batchReceipts = receipts.filter(item => batch.files.some(file => file.source === item.source && file.sourceId === item.sourceId && file.role === item.role && file.relativePath === item.relativePath));
              if (batchReceipts.length) storageTransferStore.confirmFiles(id, batch.id, batchReceipts);
            }
          }
        }
        reply(200, storageTransferStore.getTransfer(id));
      } else if (request.method === "POST" && /^\/api\/mobile\/transfers\/[^/]+\/batches\/[^/]+\/confirm$/.test(url.pathname)) {
        if (!storageTransferStore) { reply(503, { error: "传输任务存储尚未启用" }); return; }
        const match = /^\/api\/mobile\/transfers\/([^/]+)\/batches\/([^/]+)\/confirm$/.exec(url.pathname);
        const id = decodeURIComponent(match[1]); const batchId = decodeURIComponent(match[2]);
        const transfer = storageTransferStore.getTransfer(id);
        if (!transfer) { reply(404, { error: "传输任务不存在" }); return; }
        const body = await readJson(request, 2 * 1024 * 1024);
        if (!Array.isArray(body.files) || body.files.length > 5000) { reply(400, { error: "文件确认清单无效" }); return; }
        let receipts = body.files;
        if (transfer.direction === "upload") {
          await refreshInventory(receipts);
          const checked = storageTransferStore.checkInventory(receipts);
          receipts = checked.map(item => ({ ...item, role: item.role,
            relativePath: body.files.find(file => file.source === item.source && file.sourceId === item.sourceId &&
              file.taskId === item.taskId && file.role === item.role && file.size === item.size && file.sha256 === item.sha256)?.relativePath || "",
            state: item.status === "present" ? "indexed" : item.status === "conflict" ? "conflict" : "saved",
            error: item.reason || "" }));
        }
        reply(200, storageTransferStore.confirmFiles(id, batchId, receipts));
      } else if (request.method === "POST" && /^\/api\/mobile\/transfers\/[^/]+\/cancel$/.test(url.pathname)) {
        if (!storageTransferStore) { reply(503, { error: "传输任务存储尚未启用" }); return; }
        const id = decodeURIComponent(url.pathname.split("/").at(-2));
        const result = storageTransferStore.cancelTransfer(id);
        if (!result) { reply(404, { error: "传输任务不存在或已完成" }); return; }
        reply(200, result);
      } else if (request.method === "GET" && url.pathname === "/") {
        const body = dashboardHtml();
        response.writeHead(200, {
          "content-type": "text/html; charset=utf-8",
          "cache-control": "no-store",
          "x-content-type-options": "nosniff",
          "x-frame-options": "DENY",
          "referrer-policy": "no-referrer",
          "content-security-policy": "default-src 'self'; media-src 'self' blob:; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; object-src 'none'; frame-src 'none'"
        });
        response.end(body);
      } else if (request.method === "GET" && ["/player", "/playlist", "/playlist.html", "/recommend"].includes(url.pathname)) {
        const body = playlistHtml();
        response.writeHead(200, {
          "content-type": "text/html; charset=utf-8",
          "cache-control": "no-store",
          "x-content-type-options": "nosniff",
          "x-frame-options": "DENY",
          "referrer-policy": "no-referrer",
          "content-security-policy": "default-src 'self'; media-src 'self' blob:; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; object-src 'none'; frame-src 'self'"
        });
        response.end(body);
      } else if (isDirectBatchDownload) {
        const sendFormError = (status, message) => {
          const escaped = String(message || "批量下载失败").replace(/[&<>"']/g, character => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" })[character]);
          const body = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>批量下载未开始</title><body style="font:16px/1.6 system-ui,'Microsoft YaHei',sans-serif;max-width:640px;margin:12vh auto;padding:24px;color:#26374d"><h2>批量下载未开始</h2><p>${escaped}</p><p>请返回播放列表，刷新后重新选择。</p></body></html>`;
          response.writeHead(status, { "content-type": "text/html; charset=utf-8", "content-length": Buffer.byteLength(body), "cache-control": "no-store", "x-content-type-options": "nosniff" });
          response.end(body);
        };
        try {
          const form = await readUrlEncoded(request);
          const requestAuth = authorizeRequest(request, url, accessToken);
          if (!requestAuth.ok && !tokenMatches(accessToken, form.get("access_token"))) {
            sendFormError(401, "需要有效的局域网访问令牌，请返回播放列表重新打开下载链接。");
            return;
          }
          let taskIds;
          try { taskIds = JSON.parse(form.get("taskIds") || "null"); }
          catch { taskIds = null; }
          if (!Array.isArray(taskIds)) {
            sendFormError(400, "批量下载请求缺少有效的视频列表。");
            return;
          }
          const prepared = await prepareBatchDownload(taskIds, form.get("downloadId") || "");
          // A POST body sent straight as an attachment is inconsistently
          // surfaced in mobile browser download managers. Redirect to a normal
          // capability-checked GET so the browser tracks a standard transfer.
          response.writeHead(303, {
            location: prepared.url,
            "content-length": 0,
            "cache-control": "no-store",
            "x-content-type-options": "nosniff"
          });
          response.end();
        } catch (error) {
          if (response.headersSent) {
            if (!response.destroyed) response.destroy(error);
          } else sendFormError(error.statusCode || 400, error.message);
        }
      } else if (request.method === "POST" && url.pathname === "/api/batch-download") {
        const body = await readJson(request);
        if (!Array.isArray(body.taskIds)) { reply(400, { error: "缺少 taskIds 列表" }); return; }
        try { reply(200, await prepareBatchDownload(body.taskIds)); }
        catch (error) { reply(error.statusCode || 400, { error: error.message, missing: error.missing || [] }); }
      } else if (request.method === "POST" && url.pathname === "/api/mobile/random-download") {
        if (!mobileLibrary) { reply(503, { error: "手机资料同步尚未启用" }); return; }
        if (!/^application\/json(?:\s*;|$)/i.test(String(request.headers["content-type"] || ""))) {
          reply(415, { error: "随机下载请求必须使用 application/json" });
          return;
        }
        try { reply(200, await prepareMobileRandomDownload(await readJson(request, 2 * 1024 * 1024))); }
        catch (error) { reply(error.statusCode || 400, { error: error.message, missing: error.missing || [] }); }
      } else if (request.method === "GET" && url.pathname === "/api/batch-download/status") {
        const id = String(url.searchParams.get("id") || "").trim();
        const job = /^[a-f0-9]{36}$/i.test(id) ? batchDownloadJobs.get(id) : null;
        if (!job || job.expiresAt <= Date.now()) {
          reply(404, { error: "批量下载状态已过期" });
          return;
        }
        reply(200, {
          state: job.completed ? "completed" : job.interrupted ? "interrupted" : job.active ? "transferring" : "ready",
          fileCount: job.fileCount ?? job.files.length,
          bytesSent: job.bytesSent,
          archiveBytes: job.archiveBytes,
          totalBytes: job.totalBytes
        });
      } else if (request.method === "GET" && url.pathname.startsWith("/batch-download/")) {
        const match = /^\/batch-download\/([a-f0-9]{36})\.zip$/i.exec(url.pathname);
        const job = match ? batchDownloadJobs.get(match[1]) : null;
        if (!job || job.expiresAt <= Date.now()) {
          if (match) batchDownloadJobs.delete(match[1]);
          reply(404, { error: "批量下载链接已过期，请重新选择并生成" });
          return;
        }
        if (job.active) { reply(409, { error: "这个批量下载已经在进行中" }); return; }
        for (const file of job.files) {
          if (!file.path) continue;
          const info = await stat(file.path).catch(() => null);
          if (!info?.isFile() || info.size !== file.size || info.mtimeMs !== file.mtimeMs) {
            batchDownloadJobs.delete(match[1]);
            reply(409, { error: `文件已变化或缺失，请刷新列表后重试：${file.archiveName}` });
            return;
          }
        }
        job.active = true;
        job.interrupted = false;
        job.completed = false;
        job.bytesSent = 0;
        response.once("finish", () => {
          job.active = false;
          job.completed = true;
          job.interrupted = false;
          job.bytesSent = job.archiveBytes;
        });
        response.once("close", () => {
          if (!response.writableFinished) {
            job.active = false;
            job.interrupted = true;
          }
        });
        response.writeHead(200, {
          "content-type": "application/zip",
          "content-disposition": `attachment; filename="Iwara-batch.zip"; filename*=UTF-8''${encodeURIComponent(job.archiveName)}`,
          "content-length": job.archiveBytes,
          "cache-control": "no-store",
          "x-content-type-options": "nosniff"
        });
        try { await streamStoredZip(response, job.files, bytesSent => { job.bytesSent = bytesSent; }); }
        catch (error) {
          console.warn(`[批量下载] 流式打包中断: ${error.message}`);
          if (!response.destroyed) response.destroy(error);
        }
      } else if ((request.method === "GET" || request.method === "HEAD") && url.pathname.startsWith("/media/")) {
        await serveLocalMedia(request, response, scheduler, url.pathname.slice("/media/".length), transcodeCache, requestPlaybackProfile(request, url), url.searchParams.get("download") === "1");
      } else if ((request.method === "GET" || request.method === "HEAD") && url.pathname.startsWith("/cover/")) {
        await serveLocalCover(request, response, scheduler, coverCache, url.pathname.slice("/cover/".length));
      } else if (request.method === "GET" && ["/api/playlist", "/playlist-data"].includes(url.pathname)) {
        // Navigating to the JSON endpoint directly in Chrome sends an HTML
        // Accept header.  Redirect that human navigation to the usable page;
        // fetch() from the playlist uses /playlist-data and still receives JSON.
        if (url.pathname === "/api/playlist" && String(request.headers.accept || "").includes("text/html")) {
          response.writeHead(302, { location: "/playlist", "cache-control": "no-store" });
          response.end();
          return;
        }
        reply(200, withResourceUrls(await scheduler.playlist({
          query: url.searchParams.get("query") || "",
          source: url.searchParams.get("source") || "all",
          author: url.searchParams.get("author") || "all",
          watched: url.searchParams.get("watched") || "all",
          favorite: url.searchParams.get("favorite") || "all",
          watchLater: url.searchParams.get("watchLater") || "all",
          queue: url.searchParams.get("queue") || "all",
          discarded: url.searchParams.get("discarded") || "exclude",
          randomSample: ["1", "true", "yes"].includes(String(url.searchParams.get("randomSample") || "").toLowerCase()),
          randomSeed: url.searchParams.get("randomSeed") || "",
          taskId: url.searchParams.get("taskId") || "",
          contextId: url.searchParams.get("contextId") || "",
          contextIndex: url.searchParams.has("contextIndex")
            ? Number(url.searchParams.get("contextIndex"))
            : null,
          contextSize: Number(url.searchParams.get("contextSize") || 5),
          sort: url.searchParams.get("sort") || "updatedAt",
          direction: url.searchParams.get("direction") || "desc",
          page: Number(url.searchParams.get("page") || 1),
          pageSize: Number(url.searchParams.get("pageSize") || 25),
          randomPage: ["1", "true", "yes"].includes(String(url.searchParams.get("randomPage") || "").toLowerCase())
        }), accessToken, requestPlaybackProfile(request, url)));
      } else if (request.method === "GET" && url.pathname === "/api/playlist-tags") {
        reply(200, { tags: typeof scheduler.playlistTags === "function"
          ? scheduler.playlistTags({ limit: Number(url.searchParams.get("limit") || 18), source: url.searchParams.get("source") || "all" })
          : [] });
      } else if (request.method === "GET" && url.pathname === "/api/playlist-authors") {
        reply(200, { authors: typeof scheduler.playlistAuthors === "function"
          ? scheduler.playlistAuthors({ source: url.searchParams.get("source") || "all" })
          : [] });
      } else if (request.method === "POST" && url.pathname === "/api/views") {
        const body = await readJson(request);
        reply(200, await scheduler.updateViewCount(body.videoId, body.views));
      } else if (request.method === "POST" && url.pathname.startsWith("/api/playlist-flags/")) {
        const taskId = decodeURIComponent(url.pathname.slice("/api/playlist-flags/".length));
        reply(200, await scheduler.updatePlaylistFlags(taskId, await readJson(request)));
      } else if (request.method === "POST" && url.pathname === "/api/retry-category") {
        const body = await readJson(request);
        reply(200, await scheduler.retryFailedByCategory(body.category || "all"));
      } else if (request.method === "POST" && url.pathname.startsWith("/api/playback/")) {
        const taskId = decodeURIComponent(url.pathname.slice("/api/playback/".length));
        reply(200, await scheduler.updatePlayback(taskId, await readJson(request)));
      } else if ((request.method === "GET" || request.method === "HEAD") && url.pathname.startsWith("/assets/plyr/")) {
        const assetName = url.pathname.slice("/assets/plyr/".length);
        const assetFiles = {
          "plyr.css": { path: path.resolve(import.meta.dirname, "vendor", "plyr", "plyr.css"), type: "text/css; charset=utf-8" },
          "plyr.polyfilled.min.js": { path: path.resolve(import.meta.dirname, "vendor", "plyr", "plyr.polyfilled.min.js"), type: "application/javascript; charset=utf-8" },
          "plyr.svg": { path: path.resolve(import.meta.dirname, "vendor", "plyr", "plyr.svg"), type: "image/svg+xml" }
        }[assetName];
        if (!assetFiles) { reply(404, { error: "asset not found" }); return; }
        const body = await readFile(assetFiles.path);
        response.writeHead(200, {
          "content-type": assetFiles.type,
          "content-length": body.length,
          "cache-control": "public, max-age=86400",
          "x-content-type-options": "nosniff"
        });
        if (request.method === "GET") response.end(body); else response.end();
      } else if (request.method === "GET" && url.pathname === "/IwaraResilientQueue.user.js") {
        const body = await readFile(path.resolve(import.meta.dirname, "..", "IwaraResilientQueue.user.js"));
        response.writeHead(200, {
          "content-type": "application/javascript; charset=utf-8",
          "content-length": body.length,
          "cache-control": "no-store"
        });
        response.end(body);
      } else if (request.method === "GET" && url.pathname === "/health") {
        reply(200, { ok: true, service: "iwara-resilient-queue", version: SERVICE_VERSION });
      } else if (request.method === "GET" && url.pathname === "/api/lan-info") {
        const token = String(accessToken || "").trim();
        const encodedToken = encodeURIComponent(token);
        const addresses = token ? localLanAddresses() : [];
        const tailscale = tailscaleAddresses();
        const urls = addresses.filter(address => !isTailscaleAddress(address))
          .map(address => `http://${address}:${port}/playlist?access_token=${encodedToken}`);
        // Put the token first so mobile browsers/QR scanners that preserve only
        // the first query parameter still authenticate successfully. Tailscale
        // hosts are auto-detected as remote when profile is omitted.
        const remoteUrls = addresses.filter(isTailscaleAddress)
          .map(address => `http://${address}:${port}/playlist?access_token=${encodedToken}&profile=remote`);
        reply(200, {
          enabled: Boolean(token), urls, remoteUrls, host, port,
          tailscale: { online: tailscale.length > 0, addresses: tailscale }
        });
      } else if (request.method === "POST" && url.pathname === "/api/presence") {
        const body = await readJson(request);
        reply(200, updatePresence(body.clientId, body.active !== false, body.page));
      } else if (request.method === "GET" && url.pathname.startsWith("/api/media-diagnostics/")) {
        const taskId = decodeURIComponent(url.pathname.slice("/api/media-diagnostics/".length));
        const since = Number(url.searchParams.get("since") || 0);
        reply(200, { events: mediaDiagnostics.filter(item => item.taskId === taskId && item.startedAt >= since).slice(-10) });
      } else if (request.method === "GET" && url.pathname === "/api/mobile/fingerprints") {
        reply(mobileLibrary ? 200 : 503, mobileLibrary?.status() || { error: '手机资料同步尚未启用' });
      } else if (request.method === "POST" && url.pathname === "/api/mobile/fingerprints") {
        if (!mobileLibrary) { reply(503, { error: '手机资料同步尚未启用' }); return; }
        void mobileLibrary.scan().catch(error => console.error('手机指纹扫描失败', error.message));
        reply(202, mobileLibrary.status());
      } else if (request.method === "GET" && url.pathname === "/api/han1me/import") {
        reply(han1meImporter?.status().enabled ? 200 : 503,
          han1meImporter?.status() || { enabled: false, error: "Han1me 导入尚未启用" });
      } else if (request.method === "POST" && url.pathname === "/api/han1me/import") {
        if (!han1meImporter?.status().enabled) { reply(503, { error: "Han1me 导入尚未启用：请在 externalMediaRoots 配置 Han1me 视频目录" }); return; }
        void han1meImporter.scan().catch(error => console.error("Han1me 导入扫描失败", error.message));
        reply(202, han1meImporter.status());
      } else if (request.method === "GET" && url.pathname === "/api/mobile/han1me-download-codes") {
        if (!han1meImporter?.status().enabled) { reply(503, { error: "Han1me 视频目录未配置" }); return; }
        reply(200, await han1meImporter.downloadCodes());
      } else if (request.method === "GET" && url.pathname === "/api/mobile/han1me-view-counts/missing") {
        if (!han1meImporter?.status().enabled) { reply(503, { error: "Han1me 视频目录未配置" }); return; }
        const codes = await han1meImporter.missingViewCountCodes();
        reply(200, { codes, codeCount: codes.length, generatedAt: new Date().toISOString() });
      } else if (request.method === "POST" && url.pathname === "/api/mobile/han1me-view-counts") {
        if (!han1meImporter?.status().enabled) { reply(503, { error: "Han1me 视频目录未配置" }); return; }
        if (!/^application\/json(?:\s*;|$)/i.test(String(request.headers["content-type"] || ""))) {
          reply(415, { error: "播放量回填请求必须使用 application/json" });
          return;
        }
        const body = await readJson(request);
        const result = await han1meImporter.applyViewCounts(body.counts);
        void han1meImporter.scan().catch(error => console.error("Han1me 播放量回填后的扫描失败", error.message));
        reply(200, { updatedCount: result.updatedCount, skippedCount: result.skippedCount });
      } else if (request.method === "GET" && url.pathname === "/api/mobile/han1me-video-metadata/missing") {
        if (!han1meImporter?.status().enabled) { reply(503, { error: "Han1me 视频目录未配置" }); return; }
        const codes = await han1meImporter.missingVideoMetadataCodes();
        reply(200, { codes, codeCount: codes.length, generatedAt: new Date().toISOString() });
      } else if (request.method === "POST" && url.pathname === "/api/mobile/han1me-video-metadata") {
        if (!han1meImporter?.status().enabled) { reply(503, { error: "Han1me 视频目录未配置" }); return; }
        if (!/^application\/json(?:\s*;|$)/i.test(String(request.headers["content-type"] || ""))) {
          reply(415, { error: "视频元数据回填请求必须使用 application/json" });
          return;
        }
        const body = await readJson(request);
        const result = await han1meImporter.applyVideoMetadata(body.videos);
        void han1meImporter.scan().catch(error => console.error("Han1me 元数据回填后的扫描失败", error.message));
        reply(200, { updatedCount: result.updatedCount, skippedCount: result.skippedCount });
      } else if (request.method === "POST" && url.pathname === "/api/mobile/han1me-archive") {
        if (!han1meImporter?.status().enabled) { reply(503, { error: "Han1me 视频目录未配置" }); return; }
        if (!/^application\/zip(?:\s*;|$)/i.test(String(request.headers["content-type"] || ""))) {
          reply(415, { error: "归档请求必须使用 application/zip" });
          return;
        }
        const outcome = await receiveHan1meArchive(request, han1meImporter.root);
        void han1meImporter.scan().catch(error => console.error("Han1me 归档后的扫描失败", error.message));
        reply(200, outcome);
      } else if (request.method === "GET" && url.pathname === "/api/mobile/catalog.sqlite") {
        if (!mobileLibrary) { reply(503, { error: '手机资料同步尚未启用' }); return; }
        const snapshot = await mobileLibrary.snapshot();
        if (response.destroyed || response.writableEnded) { await snapshot.cleanup(); return; }
        const info = await stat(snapshot.file);
        const stream = createReadStream(snapshot.file);
        let cleaned = false;
        stream.once('close', () => void snapshot.cleanup());
        const cleanup = () => { if (cleaned) return; cleaned = true; stream.destroy(); };
        response.once('finish', cleanup); response.once('close', cleanup);
        stream.once('error', error => response.destroy(error));
        response.writeHead(200, { 'content-type': 'application/vnd.sqlite3', 'content-length': info.size,
          'content-disposition': 'attachment; filename="iwara-mobile.sqlite"', 'cache-control': 'no-store',
          'x-iwara-catalog-ready': snapshot.ready, 'x-iwara-catalog-total': snapshot.count });
        stream.pipe(response);
      } else if (["GET", "HEAD"].includes(request.method) && url.pathname === "/mobile-app.apk") {
        const file = path.resolve(import.meta.dirname, '../android/output/IwaraLocal-0.3.7.apk');
        const info = await stat(file);
        response.writeHead(200, { 'content-type': 'application/vnd.android.package-archive', 'content-length': info.size,
          'content-disposition': 'attachment; filename="IwaraLocal-0.3.7.apk"', 'cache-control': 'no-store' });
        if (request.method === 'HEAD') response.end();
        else pipeMediaFile(response, file);
      } else if (request.method === "GET" && url.pathname === "/api/status") {
        const backup = scheduler.store?.backupManager?.status?.() || null;
        const fingerprint = mobileLibrary?.status?.() || null;
        const repositoryStatus = await Promise.all((scheduler.config.storageRepositories || []).map(async item => {
          let available = false;
          try { available = (await stat(item.path)).isDirectory(); } catch {}
          return { id: item.id, name: item.name, source: item.source, enabled: item.enabled,
            roles: item.roles, available };
        }));
        reply(200, {
          ...scheduler.status(),
          mobileLibrary: fingerprint,
          han1meImport: han1meImporter?.status() || null,
          storageSync: {
            configRevision: storageConfig?.view().revision || "",
            pendingRestart: Boolean(storageConfig?.view().pendingRestart),
            repositories: repositoryStatus,
            transfers: storageTransferStore?.summary?.() || null,
            fingerprints: fingerprint ? {
              running: Boolean(fingerprint.running), ready: Number(fingerprint.ready || 0),
              pending: Number(fingerprint.pending || 0), failed: Number(fingerprint.failed || 0),
              bytesHashed: Number(fingerprint.bytesHashed || 0),
            } : null,
            backup: backup ? {
              running: Boolean(backup.running), date: backup.date || null,
              lastAttemptAt: backup.lastAttemptAt || null, lastSuccessAt: backup.lastSuccessAt || null,
              failed: Boolean(backup.error),
            } : null,
          }
        });
      } else if (request.method === "GET" && url.pathname === "/api/ledger") {
        reply(200, scheduler.ledger({
          query: url.searchParams.get("query") || "",
          state: url.searchParams.get("state") || "all",
          author: url.searchParams.get("author") || "all",
          sort: url.searchParams.get("sort") || "updatedAt",
          direction: url.searchParams.get("direction") || "desc",
          page: Number(url.searchParams.get("page") || 1),
          pageSize: Number(url.searchParams.get("pageSize") || 50)
        }));
      } else if (request.method === "GET" && url.pathname === "/api/author-categories") {
        reply(200, scheduler.authorClassificationCandidates(
          Number(url.searchParams.get("minCount") || 10)
        ));
      } else if (request.method === "POST" && url.pathname === "/api/author-categories/preview") {
        const body = await readJson(request);
        reply(200, await scheduler.previewAuthorClassification(body.rules, body.minCount));
      } else if (request.method === "POST" && url.pathname === "/api/author-categories/apply") {
        const body = await readJson(request);
        reply(200, await scheduler.applyAuthorClassification(body.rules, body.minCount));
      } else if (request.method === "GET" && url.pathname.startsWith("/api/attempts/")) {
        reply(200, scheduler.attemptHistory(url.pathname.split("/").pop()));
      } else if (request.method === "POST" && url.pathname === "/api/tasks") {
        const body = await readJson(request);
        reply(202, await scheduler.enqueue(body.items || []));
      } else if (request.method === "POST" && url.pathname === "/api/youtube-downloads") {
        if (!youtubeDownloader) { reply(503, { error: "本机 YouTube 下载尚未启用" }); return; }
        const body = await readJson(request);
        const result = youtubeDownloader.enqueue(body.url);
        reply(result.duplicate ? 200 : 202, result);
      } else if (request.method === "GET" && url.pathname.startsWith("/api/youtube-downloads/")) {
        if (!youtubeDownloader) { reply(503, { error: "本机 YouTube 下载尚未启用" }); return; }
        const jobId = decodeURIComponent(url.pathname.slice("/api/youtube-downloads/".length));
        const job = youtubeDownloader.get(jobId);
        reply(job ? 200 : 404, job ? { job } : { error: "没有找到这个 YouTube 下载任务" });
      } else if (request.method === "GET" && url.pathname === "/api/resolve/next") {
        reply(200, { task: await scheduler.leaseNext() });
      } else if (request.method === "POST" && url.pathname === "/api/resolve/result") {
        reply(200, await scheduler.submitResolution(await readJson(request)));
      } else if (request.method === "GET" && url.pathname === "/api/enrich/next") {
        reply(200, { task: await scheduler.leaseMetadataEnrichment() });
      } else if (request.method === "GET" && url.pathname === "/api/enrich/next-views") {
        reply(200, { task: await scheduler.leaseMetadataEnrichment({ viewsOnly: true }) });
      } else if (request.method === "GET" && url.pathname === "/api/enrich/next-tags") {
        reply(200, { task: await scheduler.leaseMetadataEnrichment({ tagsOnly: true }) });
      } else if (request.method === "POST" && url.pathname === "/api/enrich/queue-authors") {
        const body = await readJson(request);
        reply(200, await scheduler.queueAuthorBackfill({ limit: body.limit, retryFailed: body.retryFailed === true }));
      } else if (request.method === "POST" && url.pathname === "/api/enrich/pause-authors") {
        reply(200, await scheduler.pauseAuthorBackfill());
      } else if (request.method === "GET" && url.pathname === "/api/enrich/authors-from-folders") {
        reply(200, await scheduler.backfillAuthorsFromFolders({ apply: false }));
      } else if (request.method === "POST" && url.pathname === "/api/enrich/authors-from-folders") {
        reply(200, await scheduler.backfillAuthorsFromFolders({ apply: true }));
      } else if (request.method === "GET" && url.pathname === "/api/enrich/next-authors") {
        reply(200, { task: await scheduler.leaseAuthorBackfill() });
      } else if (request.method === "POST" && url.pathname === "/api/enrich/authors-result") {
        reply(200, await scheduler.submitAuthorBackfill(await readJson(request)));
      } else if (request.method === "POST" && url.pathname === "/api/enrich/result") {
        reply(200, await scheduler.submitMetadataEnrichment(await readJson(request)));
      } else if (request.method === "POST" && url.pathname === "/api/enrich/retry-failed") {
        reply(200, await scheduler.retryFailedMetadata());
      } else if (request.method === "POST" && url.pathname === "/api/enrich/queue-views") {
        const body = await readJson(request);
        reply(200, await scheduler.queueViewCountEnrichment(body.limit));
      } else if (request.method === "POST" && url.pathname === "/api/enrich/refresh-views") {
        const body = await readJson(request);
        reply(200, await scheduler.refreshViewCountEnrichment(body.limit));
      } else if (request.method === "POST" && url.pathname === "/api/enrich/queue-tags") {
        const body = await readJson(request);
        reply(200, await scheduler.queueTagEnrichment(body.limit));
      } else if (request.method === "POST" && url.pathname === "/api/enrich/refresh-tags") {
        const body = await readJson(request);
        reply(200, await scheduler.refreshTagEnrichment(body.limit));
      } else if (request.method === "POST" && url.pathname === "/api/enrich/queue-base") {
        const body = await readJson(request);
        reply(200, await scheduler.queueBaseMetadataEnrichment(body.limit));
      } else if (request.method === "POST" && url.pathname.startsWith("/api/retry/")) {
        reply(200, await scheduler.retryTask(url.pathname.split("/").pop()));
      } else if (request.method === "POST" && url.pathname.startsWith("/api/redownload/")) {
        reply(200, await scheduler.redownloadTask(url.pathname.split("/").pop()));
      } else if (request.method === "POST" && url.pathname === "/api/verify-files") {
        reply(200, await scheduler.verifyFiles());
      } else if (request.method === "POST" && url.pathname === "/api/open-download-directory") {
        reply(200, await scheduler.openDownloadDirectory());
      } else if (request.method === "POST" && url.pathname === "/api/shutdown") {
        reply(200, { ok: true });
        setImmediate(onShutdown);
      } else {
        reply(404, { error: "not found" });
      }
    } catch (error) {
      reply(Number.isInteger(error.statusCode) ? error.statusCode : 400, { error: error.message });
    }
  });
  return {
    server,
    listen: () => new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, host, resolve);
    }),
    close: async () => {
      clearInterval(presenceTimer);
      presenceClients.clear();
      scheduler.setWebPresence?.(false, 0);
      const resources = [coverCache.clear(), transcodeCache?.close(), youtubeDownloader?.close(), han1meImporter?.stop?.()];
      const connections = new Promise(resolve => {
        // Stop paused/backpressured clients from keeping shutdown open forever.
        const deadline = setTimeout(() => server.closeAllConnections(), 5000);
        deadline.unref?.();
        server.close(() => { clearTimeout(deadline); resolve(); });
      });
      await Promise.all([...resources, connections]);
    }
  };
}
