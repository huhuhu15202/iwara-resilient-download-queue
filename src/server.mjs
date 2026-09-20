import http from "node:http";
import { createReadStream } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { networkInterfaces } from "node:os";
import path from "node:path";
import { CoverCache } from "./cover-cache.mjs";
import { issueResourceTicket, verifyResourceTicket } from "./resource-ticket.mjs";

const SERVICE_VERSION = "1.11.5";

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

function withResourceUrls(payload, accessToken) {
  const token = String(accessToken || "").trim();
  return {
    ...payload,
    items: (payload.items || []).map(item => {
      const mediaTicket = issueResourceTicket(token, "media", item.id);
      const coverTicket = issueResourceTicket(token, "cover", item.id);
      return {
        ...item,
        streamUrl: `/media/${encodeURIComponent(item.id)}${mediaTicket ? `?ticket=${mediaTicket}` : ""}`,
        coverUrl: `/cover/${encodeURIComponent(item.id)}${coverTicket ? `?ticket=${coverTicket}` : ""}`
      };
    })
  };
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

async function readJson(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
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
.current{background:#fff;border:1px solid #d9e5f2;border-left:5px solid #5b8def;padding:13px 16px;border-radius:12px;margin:10px 0;box-shadow:0 3px 12px rgba(45,76,120,.05)}
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
.actions{display:flex;gap:6px;flex-wrap:wrap}.actions a{text-decoration:none}.actions button{padding:6px 9px;min-height:32px;font-size:12px}.lan-links{display:inline-flex;gap:6px;flex-wrap:wrap;vertical-align:middle;margin-left:6px}.lan-links button{padding:5px 9px;min-height:30px;font-size:12px}.lan-links a{padding:5px 9px;border:1px solid #cbd7e6;border-radius:9px;background:#fff;color:#33445c;text-decoration:none;font-size:12px;font-weight:600}.lan-links a:hover{border-color:#5b8def;background:#eef5ff}
.pager{display:flex;justify-content:space-between;gap:14px;align-items:center;margin-top:14px;background:#fff;border:1px solid #dfe7f1;border-radius:12px;padding:12px 14px}.pager>span:last-child{display:flex;gap:7px;flex-wrap:wrap}.empty{text-align:center;color:#7a899d;padding:34px}
.modal-backdrop{position:fixed;inset:0;z-index:20;background:rgba(35,50,71,.35);display:none;align-items:center;justify-content:center;padding:18px}.modal-backdrop.open{display:flex}.modal{width:min(980px,100%);max-height:90vh;overflow:auto;background:#f8fbff;border-radius:18px;padding:20px;box-shadow:0 24px 70px rgba(29,52,84,.3)}.modal h2{margin:0 0 5px;color:#17365f}.modal-tools{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin:14px 0}.modal-tools input{min-width:240px;flex:1}.author-grid{display:grid;gap:8px}.author-row{display:grid;grid-template-columns:32px minmax(190px,1fr) 110px 125px minmax(210px,1.2fr);gap:9px;align-items:center;background:#fff;border:1px solid #dfe7f1;border-radius:11px;padding:9px 11px}.author-row input[type=checkbox]{min-height:auto;width:18px;height:18px}.author-row input[type=text]{width:100%}.modal-actions{position:sticky;bottom:-20px;display:flex;justify-content:flex-end;gap:8px;background:#f8fbff;padding:14px 0 0}.preview{white-space:pre-wrap;background:#eef5ff;border-radius:10px;padding:11px 13px;color:#36516f;margin-top:12px}
@media(max-width:900px){main{padding:14px}.filters{grid-template-columns:1fr 1fr}.filters input{grid-column:1/-1}.pager{align-items:flex-start;flex-direction:column}h1{font-size:23px}}
@media(max-width:700px){.author-row{grid-template-columns:28px 1fr}.author-row>*:nth-child(n+3){grid-column:2}.filters{grid-template-columns:1fr}.cards{grid-template-columns:1fr 1fr}}
</style><main><h1>Iwara 稳定下载台账</h1><p class="hint">成功与失败记录都会永久保留；同一视频 ID 不会重复下载。 <button onclick="openDownloadDirectory()">打开视频目录</button> <a href="/playlist" target="_blank"><button>打开本地播放列表</button></a> <button onclick="showLanAccess()">显示局域网播放链接</button> <a href="/IwaraResilientQueue.user.js"><button>安装 / 更新网页脚本</button></a> <span id="lanInfo"></span></p>
<div class="cards" id="cards"></div><div id="current"></div><div id="metadataProgress"></div>
<div class="filters">
  <input id="query" placeholder="搜索标题、作者或视频 ID">
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
<div class="pager"><span id="summary"></span><span><button id="previous">上一页</button> <button id="next">下一页</button> <button onclick="openAuthorClassification()">按作者整理视频</button> <button onclick="queueViews()">同步缺失播放量</button> <button onclick="retryMetadata()">重试补齐失败项</button> <button onclick="verifyFiles()">检查文件</button> <button onclick="shutdown()">停止服务</button></span></div>
<div id="authorModal" class="modal-backdrop" onclick="if(event.target===this)closeAuthorClassification()"><section class="modal">
  <h2>按作者整理已下载视频</h2>
  <div class="hint">只显示已完成视频超过 10 个的作者。勾选作者并填写分类目录；多个作者使用相同目录名，就会合并到同一个目录。先预览，确认后才移动当前根目录中的视频；以后新下载也自动归类。</div>
  <div class="modal-tools"><button onclick="toggleAllAuthors(true)">全选</button><button onclick="toggleAllAuthors(false)">清空选择</button><input id="mergeFolder" placeholder="给勾选作者设置同一个分类目录"><button onclick="setMergedFolder()">合并到此目录</button></div>
  <div id="authorRows" class="author-grid"></div>
  <div id="classificationPreview" class="preview">尚未预览。</div>
  <div class="modal-actions"><button onclick="closeAuthorClassification()">关闭</button><button onclick="previewAuthorClassification()">预览移动</button><button id="applyClassification" onclick="applyAuthorClassification()" disabled>确认整理</button></div>
</section></div>
<script>
const esc=s=>String(s??'').replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
const stateNames={queued:'等待中',resolving:'解析中',downloading:'下载中',finalizing:'文件入库',completed:'已完成',failed:'已失败'};
const fileNames={present:'正常',missing:'文件缺失',size_mismatch:'大小异常',unknown:'未检查'};
const errorNames={tls_certificate:'CDN 证书或主机名不匹配',tls_handshake:'TLS 握手失败',source_exhausted:'可用 CDN 均已尝试',not_found:'视频源不存在',access_or_expired:'地址过期或拒绝访问',timeout:'下载超时',network:'网络连接失败',permission:'权限不足',source_unavailable:'没有可用视频源',unknown:'其他错误'};
let summaryData={counts:{},metadataCounts:{},currents:[],metadataCurrents:[],current:null,total:0},ledger={tasks:[],authors:[],total:0,page:1,pageSize:50},page=1,loading=false,pendingLoad=false,inputTimer,authorCandidates=[],classificationPreview=null;const pageSize=50;
const el=id=>document.getElementById(id);
const dateText=value=>{if(!value)return '—';const d=new Date(value);return Number.isNaN(d.getTime())?'—':d.toLocaleString('zh-CN',{hour12:false})};
const authorText=t=>t.alias?(t.alias+(t.author&&t.author!==t.alias?' (@'+t.author+')':'')):(t.author||'—');
const bytes=value=>{const n=Number(value||0);if(!n)return '—';const units=['B','KiB','MiB','GiB'];let i=0,v=n;while(v>=1024&&i<units.length-1){v/=1024;i++}return v.toFixed(i?1:0)+' '+units[i]};
const progressText=t=>{const done=Number(t.completedLength||0),total=Number(t.totalLength||0),speed=Number(t.downloadSpeed||0),pct=total?Math.min(100,done/total*100):0,eta=speed&&total>done?Math.ceil((total-done)/speed):0;return{pct,text:bytes(done)+' / '+bytes(total)+(speed?' · '+bytes(speed)+'/s':'')+(eta?' · 约 '+eta+' 秒':'')}};
async function retry(id){await fetch('/api/retry/'+id,{method:'POST'});await load()}
async function redownload(id){if(confirm('记录对应的文件缺失，确定重新下载？')){await fetch('/api/redownload/'+id,{method:'POST'});await load()}}
async function verifyFiles(){const r=await(await fetch('/api/verify-files',{method:'POST'})).json();alert('检查完成：正常 '+r.present+'，缺失 '+r.missing+'，大小异常 '+r.sizeMismatch);await load()}
async function openDownloadDirectory(){const r=await fetch('/api/open-download-directory',{method:'POST'});if(!r.ok){const body=await r.json();alert('打开目录失败：'+(body.error||r.status))}}
async function showLanAccess(){const target=el('lanInfo');target.className='lan-links';target.replaceChildren();try{const r=await fetch('/api/lan-info',{cache:'no-store'});const data=await r.json();if(!r.ok)throw Error(data.error||r.status);if(!data.enabled){target.textContent='局域网未开启（将 serviceHost 改为 0.0.0.0 后重启）';return}const urls=data.urls||[];if(!urls.length){target.textContent='未发现局域网 IPv4 地址，请查看服务日志';return}urls.forEach((url,index)=>{let label='局域网 '+(index+1);try{label=new URL(url).host}catch{}const copy=document.createElement('button');copy.type='button';copy.title='点击复制完整播放地址';copy.textContent=label;copy.onclick=async()=>{try{if(navigator.clipboard?.writeText)await navigator.clipboard.writeText(url);else{const area=document.createElement('textarea');area.value=url;area.style.position='fixed';area.style.opacity='0';document.body.append(area);area.focus();area.select();if(!document.execCommand('copy'))throw Error('copy failed');area.remove()}copy.textContent='已复制';setTimeout(()=>copy.textContent=label,1600)}catch{copy.textContent='复制失败';setTimeout(()=>copy.textContent=label,1600)}};const open=document.createElement('a');open.href=url;open.target='_blank';open.rel='noopener';open.textContent='打开';target.append(copy,open)})}catch(e){target.textContent='读取局域网链接失败：'+e.message}}
async function retryMetadata(){const r=await(await fetch('/api/enrich/retry-failed',{method:'POST'})).json();alert('已将 '+r.count+' 条补齐失败记录放回队列');await load()}
async function queueViews(){const r=await(await fetch('/api/enrich/queue-views',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({})})).json();alert('已加入 '+r.queued+' 条播放量同步任务'+(r.remaining?'，尚有 '+r.remaining+' 条待加入':'')+'。保持任一 Iwara 视频页打开，网页脚本会以最多 3 个并发逐步处理。');await load()}
async function history(id){const list=await(await fetch('/api/attempts/'+id)).json();alert(list.length?list.map(x=>dateText(x.createdAt)+' · 第'+x.attemptNo+'次 · '+x.phase+' · '+x.outcome+(x.sourceHost?' · '+x.sourceHost:'')+(x.message?'\\n'+x.message:'')).join('\\n\\n'):'尚无尝试明细')}
async function shutdown(){if(confirm('停止稳定下载服务？当前任务下次启动时会重新解析。')){await fetch('/api/shutdown',{method:'POST'});document.body.innerHTML='<main><h1>服务已停止</h1><p>需要下载时重新双击启动文件即可。</p></main>'}}
function selectedAuthorRules(){return [...document.querySelectorAll('.author-choice:checked')].map(box=>({author:box.dataset.author,folder:document.querySelector('.author-folder[data-author="'+CSS.escape(box.dataset.author)+'"]').value.trim()}))}
function invalidateClassificationPreview(){classificationPreview=null;el('applyClassification').disabled=true;el('classificationPreview').textContent='选择已更改，请重新预览。'}
async function openAuthorClassification(){const r=await fetch('/api/author-categories?minCount=10');const data=await r.json();if(!r.ok){alert(data.error||r.status);return}authorCandidates=data.candidates||[];el('authorRows').innerHTML=authorCandidates.length?authorCandidates.map(a=>'<label class="author-row"><input class="author-choice" type="checkbox" data-author="'+esc(a.author)+'" '+(a.category?'checked':'')+' onchange="invalidateClassificationPreview()"><span><b>'+esc(a.alias||a.author)+'</b><div class="muted">@'+esc(a.author)+'</div></span><span>已完成 '+a.completedCount+'</span><span>未分类 '+a.unclassifiedCount+'</span><input class="author-folder" type="text" data-author="'+esc(a.author)+'" value="'+esc(a.category||a.alias||a.author)+'" oninput="invalidateClassificationPreview()" aria-label="分类目录"></label>').join(''):'<div class="empty">目前没有超过 10 个已完成视频的作者</div>';el('classificationPreview').textContent='尚未预览。';el('applyClassification').disabled=true;el('authorModal').classList.add('open')}
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
  const m=summaryData.metadataCounts||{},v=summaryData.viewCounts||{},remaining=Number(m.pending||0)+Number(m.retry||0)+Number(m.enriching||0);
  const metadataNow=(summaryData.metadataCurrents||[]).map(t=>t.videoId).join('、');
  el('metadataProgress').innerHTML=(remaining||m.failed||v.missing)?'<div class="current">已有文件元数据：已补齐 <b>'+Number(m.complete||0)+'</b> · 待处理 '+remaining+' · 失败 '+Number(m.failed||0)+(metadataNow?' · 当前 '+esc(metadataNow):'')+'<br>播放量：已同步 <b>'+Number(v.complete||0)+'</b> · 缺失 '+Number(v.missing||0)+' · 排队 '+Number(v.pending||0)+' · 同步失败 '+Number(v.failed||0)+'<div class="muted">下载和补齐合计最多 '+summaryData.maxConcurrentTasks+' 个活动任务；正常下载优先使用空位。</div></div>':'';
  const pages=Math.max(1,Math.ceil(ledger.total/pageSize));page=Math.min(page,pages);
  el('rows').innerHTML=ledger.tasks.length?ledger.tasks.map(t=>'<tr><td class="'+esc(t.state)+'">'+esc(stateNames[t.state]||t.state)+'</td>'+
    '<td class="title"><b>'+esc(t.title||'标题尚未取得')+'</b><div class="muted">'+esc(t.videoId)+'</div></td>'+
    '<td>'+esc(authorText(t))+'</td><td>'+esc(dateText(t.uploadTime))+'</td><td>'+esc(dateText(t.updatedAt))+'</td>'+
    '<td class="'+esc(t.fileStatus||'unknown')+'">'+esc(fileNames[t.fileStatus]||'—')+'<div class="muted">'+esc(bytes(t.actualFileSize||t.totalLength))+'</div></td>'+
    '<td>'+Number(t.attempts||0)+'</td><td>'+esc(t.message)+(t.metadataMessage?'<div class="muted">元数据：'+esc(t.metadataMessage)+'</div>':'')+(t.lastErrorCategory?'<div class="muted">错误分类：'+esc(errorNames[t.lastErrorCategory]||t.lastErrorCategory)+'</div>':'')+'</td><td><div class="actions">'+
    (t.state==='completed'?'<a href="/playlist?play='+encodeURIComponent(t.id)+'&view=focus" target="_blank"><button>播放</button></a> ':'')+
    (t.sourcePage?'<a href="'+esc(t.sourcePage)+'" target="_blank"><button>打开原网页</button></a> ':'')+
    (t.state==='failed'?'<button onclick="retry(\\''+t.id+'\\')">重试</button>':'')+
    (t.state==='completed'&&t.fileStatus&&t.fileStatus!=='present'?'<button onclick="redownload(\\''+t.id+'\\')">重新下载</button>':'')+'</div></td></tr>').join(''):
    '<tr><td colspan="9" class="empty">没有符合条件的记录</td></tr>';
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
load();setInterval(load,2000)</script></main></html>`;
}

function playlistHtml() {
  return `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="idm-disable" content="true">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>Iwara 本地播放列表</title>
<style>
*{box-sizing:border-box}body{margin:0;background:#f2f6fb;color:#26374d;font:14px/1.5 "Segoe UI","Microsoft YaHei",system-ui}header{position:sticky;top:0;z-index:5;background:rgba(255,255,255,.96);border-bottom:1px solid #dce6f1;padding:14px 24px;display:flex;gap:16px;align-items:center;flex-wrap:wrap}header h1{font-size:21px;color:#17365f;margin:0 12px 0 0}header input{width:min(420px,60vw)}input,select,button{font:inherit;border:1px solid #cad8e8;border-radius:9px;background:#fff;color:#30445e;padding:9px 11px;min-height:38px}button{cursor:pointer;font-weight:600}button:hover{border-color:#5b8def;background:#eef5ff}.layout{max-width:1600px;margin:0 auto;padding:22px;display:grid;grid-template-columns:minmax(0,1fr) 390px;gap:20px}.layout.focus-player{grid-template-columns:minmax(0,1fr)}.layout.focus-player>section{display:none}.layout.focus-player .player{position:relative;top:0;width:min(1120px,100%);margin:0 auto;padding:18px}.layout.focus-player .player video{max-height:calc(100vh - 220px);object-fit:contain}.layout.focus-player .upnext{max-height:300px;overflow:auto}.toolbar{display:flex;gap:9px;align-items:center;flex-wrap:wrap;margin-bottom:16px}.toolbar .count{margin-left:auto;color:#71829a}.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(210px,1fr));gap:15px}.card{background:#fff;border:1px solid #d9e4f0;border-radius:13px;overflow:hidden;cursor:pointer;box-shadow:0 4px 15px rgba(52,85,123,.07);transition:.15s}.card:hover,.card.active{border-color:#5b8def;transform:translateY(-2px);box-shadow:0 8px 22px rgba(49,101,185,.16)}.thumb{aspect-ratio:16/9;background:#dce8f4;position:relative;overflow:hidden}.thumb video{width:100%;height:100%;object-fit:cover;display:block}.badge{position:absolute;right:8px;bottom:7px;background:rgba(20,45,75,.75);color:#fff;padding:2px 6px;border-radius:5px;font-size:11px}.watch-badge{position:absolute;left:8px;bottom:7px;background:rgba(34,116,84,.86);color:#fff;padding:2px 6px;border-radius:5px;font-size:11px}.watch-badge.unwatched{background:rgba(72,92,120,.86)}.card-body{padding:10px 11px}.card-title{font-weight:700;color:#203957;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.meta{color:#72839a;font-size:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;margin-top:4px}.card-progress{height:4px;background:#e4edf7;border-radius:4px;overflow:hidden;margin-top:7px}.card-progress i{display:block;height:100%;background:#5b8def}.empty{padding:50px;text-align:center;color:#7a899d;background:#fff;border:1px dashed #cbd8e6;border-radius:14px}.player{position:sticky;top:82px;background:#fff;border:1px solid #d9e4f0;border-radius:15px;padding:13px;box-shadow:0 5px 20px rgba(52,85,123,.1);height:max-content}.player video{display:block;width:100%;aspect-ratio:16/9;background:#dce8f4;border-radius:10px}.player h2{font-size:18px;line-height:1.35;margin:13px 0 6px;color:#17365f}.player-meta{color:#657890;display:flex;flex-wrap:wrap;gap:7px 13px}.player-actions{display:flex;gap:7px;margin-top:12px;flex-wrap:wrap}.player-state{margin-top:10px;padding:8px 10px;background:#f2f7ff;border-radius:8px;color:#536985}.player-error{margin-top:10px;padding:9px 10px;background:#fff3f1;border:1px solid #f0c4bd;border-radius:8px;color:#ad3f31;white-space:pre-wrap}.upnext{border-top:1px solid #e6edf5;margin-top:15px;padding-top:12px}.upnext h3{margin:0 0 9px;font-size:14px;color:#36516f}.next-row{display:flex;gap:9px;padding:7px 4px;border-radius:8px;cursor:pointer}.next-row:hover{background:#eef5ff}.next-row video{width:92px;height:52px;aspect-ratio:auto;border-radius:5px;object-fit:cover}.next-row b{display:block;font-size:12px;line-height:1.35;max-height:34px;overflow:hidden}.next-row span{display:block;color:#7a899d;font-size:11px}.status{margin:10px 0;color:#71829a;font-size:12px;min-height:18px}.load-sentinel{height:1px;width:100%;pointer-events:none}.load-sentinel[hidden]{display:none}[id*="idm" i],[class*="idm" i],[id*="internet-download-manager" i],[class*="internet-download-manager" i]{display:none!important}@media(max-width:1050px){.layout{grid-template-columns:1fr}.player{position:relative;top:0;grid-row:1}.grid{grid-template-columns:repeat(auto-fill,minmax(190px,1fr))}}@media(max-width:600px){header{position:relative;top:auto;z-index:auto;padding:12px 14px}.layout{padding:14px}.grid{grid-template-columns:repeat(2,minmax(0,1fr));gap:10px}.card-body{padding:8px}.player{padding:9px}}</style>
 <style>.single-mode header{justify-content:flex-start}.single-mode header input,.single-mode header select,.single-mode header #randomPage,.single-mode header #queueViews,.single-mode header #scriptLink{display:none}.single-mode .layout{padding-top:14px}.single-mode .player{box-shadow:0 8px 28px rgba(52,85,123,.12)}body:not(.single-mode) #layout>.player,body:not(.single-mode) #toggleView{display:none}body:not(.single-mode) .layout{display:block}.next-row.compact-row{align-items:center;border:1px solid #e6edf5;margin:4px 0;padding:8px 10px}.next-row.compact-row .compact-index{min-width:30px;color:#71829a;font-size:12px}.thumb .cover-image{position:absolute;inset:0;width:100%;height:100%;object-fit:cover;z-index:1}.thumb .cover-fallback{position:absolute;inset:0;display:grid;place-items:center;color:#637a96;font-size:12px}.thumb .cover-fallback[hidden]{display:none}.thumb .badge,.thumb .watch-badge{z-index:2}</style>
<header><h1>Iwara 本地播放列表</h1><input id="query" placeholder="搜索标题、作者或视频 ID"><select id="sort"><option value="updatedAt">最近下载</option><option value="title">标题</option><option value="author">作者</option><option value="uploadTime">上传日期</option><option value="views">播放量</option></select><select id="direction"><option value="desc">降序</option><option value="asc">升序</option></select><select id="watchedFilter" aria-label="观看状态"><option value="all">全部观看状态</option><option value="unwatched">未看完</option><option value="watched">已看完</option></select><button id="toggleView" type="button" aria-pressed="false">大播放视角</button><button id="randomPage" type="button">随机一页（30）</button><button id="queueViews" type="button">同步缺失播放量</button><a href="/" target="_blank" id="ledgerLink"><button type="button">下载台账</button></a><a href="/IwaraResilientQueue.user.js" target="_blank" id="scriptLink"><button type="button">更新网页脚本</button></a></header>
<div id="layout" class="layout"><section><div class="toolbar"><button id="refresh" type="button">刷新列表</button><button id="loadMore" type="button" hidden>加载更多</button><span class="count" id="count"></span></div><div id="grid" class="grid"></div><div id="status" class="status"></div><div id="loadSentinel" class="load-sentinel" hidden aria-hidden="true"></div></section><aside class="player"><video id="mainVideo" controls playsinline preload="metadata"></video><h2 id="mainTitle">选择一个视频开始播放</h2><div id="mainMeta" class="player-meta">本地文件播放 · 不依赖 Iwara 页面</div><div id="playerState" class="player-state" hidden></div><div id="playerError" class="player-error" hidden></div><div class="player-actions"><button id="resumeBtn" type="button" disabled>继续播放</button><button id="markBtn" type="button" disabled>标记已看完</button><button id="openPage" type="button" disabled>打开原网页</button><button id="prevBtn" type="button" disabled>播放上一个</button><button id="nextBtn" type="button" disabled>播放下一个</button></div><div class="upnext"><h3>相邻视频</h3><div id="upnext"></div></div></aside></div>
<script>
const $=id=>document.getElementById(id), esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])), date=v=>v?new Date(v).toLocaleDateString('zh-CN'):'—', views=v=>v==null?'播放量待同步':Number(v).toLocaleString('zh-CN')+' 次播放';
const routeParams=new URLSearchParams(location.search);
let items=[],current=-1,timer,pageNo=Math.max(1,Number(routeParams.get('page')||1)||1),totalItems=0,globalIndex=null,hasPrevious=false,hasNext=false,loading=false,loadObserver=null,pendingPlay=routeParams.get('play')||'',sourcePage=routeParams.get('from')||'',singleVideoMode=location.pathname==='/player'||Boolean(pendingPlay),playbackSaveTimer=null,lastPlaybackPosition=-1,lastPlaybackWatched=false;
let initialLoad=true;
try{if(!sourcePage)sourcePage=sessionStorage.getItem('iwara-playlist-source')||''}catch{}
function openStandalone(i){const t=items[i];if(!t)return;const from=location.pathname+location.search;try{sessionStorage.setItem('iwara-playlist-source',from)}catch{};const q=new URLSearchParams({play:t.id,from});window.location.href='/player?'+q.toString()}
function backToSource(){const target=sourcePage||'/playlist';try{sessionStorage.removeItem('iwara-playlist-source')}catch{};window.location.replace(target)}
function syncListUrl(){if(singleVideoMode)return;const q=new URLSearchParams();const query=$('query').value.trim(),sort=$('sort').value,direction=$('direction').value,watched=$('watchedFilter').value;if(query)q.set('query',query);if(sort!=='updatedAt')q.set('sort',sort);if(direction!=='desc')q.set('direction',direction);if(watched!=='all')q.set('watched',watched);if(pageNo>1)q.set('page',String(pageNo));const next='/playlist'+(q.toString()?'?'+q.toString():'');history.replaceState(null,'',next)}
function progressInfo(t){const duration=Number(t.playbackDuration||0),position=Math.max(0,Number(t.playbackPosition||0));return{duration,position,pct:duration?Math.min(100,position/duration*100):0}}
function watchLabel(t){const p=progressInfo(t);return t.watched?'已看完':p.position>1?'未看完':'未播放'}
function bindCoverStatus(){document.querySelectorAll('.thumb .cover-image').forEach(image=>{const fallback=image.previousElementSibling;image.onload=()=>{fallback.hidden=true};image.onerror=()=>{image.hidden=true;fallback.textContent='封面暂不可用'};if(image.complete&&image.naturalWidth)fallback.hidden=true})}
function card(t,i){const p=progressInfo(t);return '<article class="card '+(i===current?'active':'')+'" data-index="'+i+'"><div class="thumb"><span class="cover-fallback">正在加载封面</span><img class="cover-image" src="'+esc(t.coverUrl)+'" alt="" loading="lazy"><span class="watch-badge '+(t.watched?'':'unwatched')+'">'+watchLabel(t)+'</span><span class="badge">本地</span></div><div class="card-body"><div class="card-title" title="'+esc(t.title||t.videoId)+'">'+esc(t.title||t.videoId)+'</div><div class="meta">'+esc(t.alias||t.author||'未知作者')+' · '+esc(date(t.uploadTime))+'</div><div class="meta">'+esc(views(t.views))+'</div><div class="card-progress"><i style="width:'+p.pct+'%"></i></div></div></article>'}
function render(){if(singleVideoMode){$('grid').innerHTML='';$('count').textContent='';$('loadMore').hidden=true;$('loadSentinel').hidden=true}else{$('grid').innerHTML=items.length?items.map(card).join(''):'<div class="empty">没有可播放的本地视频</div>';$('count').textContent=(totalItems&&items.length<totalItems?items.length+' / ':'')+(totalItems||items.length)+' 个本地视频';const more=Boolean(totalItems&&items.length<totalItems);$('loadMore').hidden=!more;$('loadSentinel').hidden=!more}document.querySelectorAll('.card').forEach(c=>c.onclick=e=>{const i=Number(c.dataset.index);if(singleVideoMode)select(i,e);else openStandalone(i)});renderNext();bindCoverStatus()}
function loadNextPage(){if(singleVideoMode||loading||!totalItems||items.length>=totalItems)return;pageNo+=1;void load(false)}
function setupInfiniteScroll(){if(singleVideoMode)return;const sentinel=$('loadSentinel');if(!sentinel)return;loadObserver?.disconnect();if('IntersectionObserver' in window){loadObserver=new IntersectionObserver(entries=>{if(entries.some(entry=>entry.isIntersecting))loadNextPage()},{rootMargin:'720px 0px',threshold:0});loadObserver.observe(sentinel);return}const check=()=>{if(innerHeight+scrollY>=document.documentElement.scrollHeight-720)loadNextPage()};window.addEventListener('scroll',check,{passive:true});window.addEventListener('resize',check,{passive:true})}
function renderNext(){if(!singleVideoMode){$('upnext').innerHTML='';return}const available=items.map((t,index)=>({t,index})).filter(x=>x.index!==current).sort((a,b)=>Math.abs(a.index-current)-Math.abs(b.index-current)).slice(0,4);$('upnext').innerHTML=available.map(({t,index})=>'<div class="next-row compact-row" data-index="'+index+'"><span class="compact-index">'+(index<current?'上一个':'下一个')+'</span><img class="cover-image" src="'+esc(t.coverUrl)+'" alt="" loading="lazy" style="width:92px;height:52px;object-fit:cover;border-radius:5px"><div><b>'+esc(t.title||t.videoId)+'</b><span>'+esc(t.alias||t.author||'未知作者')+'</span></div></div>').join('')||'<div class="meta">没有相邻视频</div>';document.querySelectorAll('.next-row').forEach(c=>c.onclick=e=>select(Number(c.dataset.index),e))}
function playerErrorText(error){const code=Number(error?.code||0);if(code===4)return '浏览器无法识别播放资源，正在核对文件服务的实际响应。';if(code===3)return '浏览器解码失败；文件可能损坏，或当前浏览器不支持其编码。';if(code===2)return '读取本地文件时网络中断，请稍后重试。';return '播放器无法打开该文件，正在检查原因。'}
function mediaHttpError(status){if(status===401)return '局域网视频请求未通过授权（HTTP 401）。请从台账复制局域网播放链接重新打开；视频地址会自动携带独立访问票据。';if(status===403)return '本地文件被拒绝访问（HTTP 403）；请检查服务权限和下载目录。';if(status===404)return '本地文件确实不存在（HTTP 404）；请检查台账中的文件位置。';if(status===416)return '手机浏览器请求的视频分段无效（HTTP 416）；请刷新播放器重试。';if(status>=400)return '本地文件服务返回 HTTP '+status+'，暂时无法读取。';return ''}
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
function updatePlayerState(t){const p=progressInfo(t);const state=t.watched?'已看完':p.position>1?'未看完 · 已看到 '+Math.floor(p.position/60)+':'+String(Math.floor(p.position%60)).padStart(2,'0'):'尚未播放';$('playerState').textContent=state;$('playerState').hidden=false;$('resumeBtn').disabled=!(p.position>1&&!t.watched);$('markBtn').disabled=false;$('markBtn').textContent=t.watched?'标记未看完':'标记已看完'}
function persistPlayback(force=false,watchedOverride=null){if(current<0||!items[current])return;const t=items[current],v=$('mainVideo'),duration=Number(v.duration||t.playbackDuration||0),position=Number(v.currentTime||0);if(!Number.isFinite(position)||!Number.isFinite(duration)||duration<=0)return;const watched=typeof watchedOverride==='boolean'?watchedOverride:(v.ended||position/duration>=.95);if(!force&&Math.abs(position-lastPlaybackPosition)<2&&watched===lastPlaybackWatched)return;lastPlaybackPosition=position;lastPlaybackWatched=watched;const payload={position,duration,watched};t.playbackPosition=position;t.playbackDuration=duration;t.watched=watched;updatePlayerState(t);fetch('/api/playback/'+encodeURIComponent(t.id),{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(payload),keepalive:force}).then(r=>r.ok?r.json():null).then(saved=>{if(saved){Object.assign(t,{playbackPosition:saved.playbackPosition,playbackDuration:saved.playbackDuration,watched:saved.watched,playbackUpdatedAt:saved.playbackUpdatedAt})}}).catch(()=>{})}
function schedulePlaybackSave(){clearTimeout(playbackSaveTimer);playbackSaveTimer=setTimeout(()=>persistPlayback(false),800)}
function sendPlaybackBeacon(){if(current<0||!items[current])return;const v=$('mainVideo'),duration=Number(v.duration||0),position=Number(v.currentTime||0);if(!Number.isFinite(duration)||duration<=0)return;const body=JSON.stringify({position,duration,watched:v.ended||position/duration>=.95});try{navigator.sendBeacon('/api/playback/'+encodeURIComponent(items[current].id),new Blob([body],{type:'application/json'}))}catch{persistPlayback(true)}}
async function navigateAdjacent(direction){
  const target=current+direction;
  if(target>=0&&target<items.length){select(target,null,true);return}
  if(!singleVideoMode||!Number.isSafeInteger(globalIndex))return;
  const targetGlobal=globalIndex+direction;
  if(targetGlobal<0||targetGlobal>=totalItems)return;
  const p=new URLSearchParams({sort:$('sort').value,direction:$('direction').value,watched:'all',page:'1',pageSize:'30',contextIndex:String(targetGlobal),contextSize:'5'});
  $('status').textContent='正在读取相邻视频…';
  try{
    const r=await fetch('/playlist-data?'+p,{cache:'no-store'}),d=await r.json();
    if(!r.ok)throw Error(d.error||r.status);
    items=d.items||[];totalItems=Number(d.total||totalItems);globalIndex=Number.isInteger(Number(d.globalIndex))?Number(d.globalIndex):targetGlobal;hasPrevious=Boolean(d.hasPrevious);hasNext=Boolean(d.hasNext);current=Number.isInteger(Number(d.currentIndex))?Number(d.currentIndex):0;
    showPlayerError(d.playerError?.message||'');render();if(items.length)select(current,null,true);$('status').textContent='已加载相邻视频；只保留当前视频和少量切换项。';
  }catch(error){$('status').textContent='读取相邻视频失败：'+error.message}
}
function select(i,event,fromUser=false){if(event){event.preventDefault();event.stopPropagation()}if(!items[i])return;if(current>=0&&current!==i){persistPlayback(true);if(Number.isSafeInteger(globalIndex))globalIndex+=i-current}current=i;lastPlaybackPosition=-1;lastPlaybackWatched=false;const t=items[i],v=$('mainVideo');if(event||fromUser){v.muted=false;v.autoplay=false}if(singleVideoMode){const q=new URLSearchParams(location.search);q.set('play',t.id);history.replaceState(null,'','/player?'+q.toString())}showPlayerError('');$('playerState').hidden=false;updatePlayerState(t);t.mediaStartedAt=Date.now();v.src=t.streamUrl;v.load();v.addEventListener('loadedmetadata',function restore(){const p=progressInfo(t);if(!t.watched&&p.position>1&&p.position<v.duration-1){try{v.currentTime=p.position}catch{}}updatePlayerState(t)},{once:true});v.play().catch(()=>{});$('mainTitle').textContent=t.title||t.videoId;$('mainMeta').innerHTML='<span>'+esc(t.alias||t.author||'未知作者')+'</span><span>'+esc(date(t.uploadTime))+'</span><span>'+esc(views(t.views))+'</span><span>'+esc(t.localFileName||'本地文件')+'</span>';$('openPage').disabled=!t.sourcePage;$('openPage').onclick=()=>window.open(t.sourcePage,'_blank','noopener');$('resumeBtn').onclick=()=>{const p=progressInfo(t);if(p.position>0){try{v.currentTime=p.position}catch{};v.play().catch(()=>{})}};$('markBtn').onclick=()=>{t.watched=!t.watched;persistPlayback(true,t.watched);updatePlayerState(t);render()};$('prevBtn').disabled=current<0||(!hasPrevious&&current<=0);$('prevBtn').onclick=()=>navigateAdjacent(-1);$('nextBtn').disabled=current<0||(!hasNext&&current>=items.length-1);$('nextBtn').onclick=()=>navigateAdjacent(1);document.querySelectorAll('.card').forEach(c=>c.classList.toggle('active',Number(c.dataset.index)===current));renderNext()}
async function load(reset=true,randomize=false){
  if(loading)return;clearTimeout(timer);
  if(reset){if(!(initialLoad&&!randomize&&!singleVideoMode))pageNo=1;items=[];current=-1;globalIndex=null;hasPrevious=false;hasNext=false}
  loading=true;const targetPlay=pendingPlay;
  $('status').textContent=targetPlay?'正在打开指定本地视频…':(randomize?'正在随机读取一页视频…':'正在读取本地列表…');
  const p=new URLSearchParams({query:singleVideoMode?'':$('query').value.trim(),sort:$('sort').value,direction:$('direction').value,watched:singleVideoMode?'all':$('watchedFilter').value,page:String(pageNo),pageSize:'30'});
  if(targetPlay){p.set('contextId',targetPlay);p.set('contextSize','5')}else if(randomize)p.set('randomPage','1');
  try{
    const r=await fetch('/playlist-data?'+p,{cache:'no-store'}),d=await r.json();if(!r.ok)throw Error(d.error||r.status);
    totalItems=Number(d.total||0);pageNo=Number(d.page||pageNo);items=reset?(d.items||[]):items.concat(d.items||[]);
    if(targetPlay){
      pendingPlay='';if(d.playerError)showPlayerError(d.playerError.message);globalIndex=Number.isInteger(Number(d.globalIndex))?Number(d.globalIndex):null;hasPrevious=Boolean(d.hasPrevious);hasNext=Boolean(d.hasNext);current=Number.isInteger(Number(d.currentIndex))&&Number(d.currentIndex)>=0?Number(d.currentIndex):0;setViewMode('focus');$('mainVideo').muted=true;$('mainVideo').autoplay=true;render();
      if(items.length){select(Math.min(current,items.length-1));$('status').textContent='已打开独立播放器；播放列表已释放，仅保留相邻视频切换。'}else $('status').textContent=d.playerError?.message||'找不到对应的本地文件，可能已移动或缺失。'
    }else{$('status').textContent=(randomize?'本次已随机打开第 '+pageNo+' 页；封面由本地服务按需生成。':'本地源已就绪；封面由本地服务加载，播放状态会自动保存。');render();syncListUrl()}
  }catch(e){$('status').textContent='读取失败：'+e.message}finally{loading=false;initialLoad=false}
}
function setViewMode(mode){const focus=singleVideoMode||mode==='focus';$('layout').classList.toggle('focus-player',focus);const button=$('toggleView');button.textContent=singleVideoMode?'返回播放列表':(focus?'返回列表':'大播放视角');button.setAttribute('aria-pressed',String(focus));try{if(!singleVideoMode)localStorage.setItem('iwara-player-view',focus?'focus':'split')}catch{}}
async function queueViews(){const r=await(await fetch('/api/enrich/queue-views',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({})})).json();$('status').textContent='已加入 '+Number(r.queued||0)+' 条播放量同步任务'+(r.remaining?'，尚有 '+r.remaining+' 条待加入':'')+'；保持任一 Iwara 视频页打开即可逐步处理。'}
function stripIdmPanels(root=document){for(const node of root.querySelectorAll?.('*')||[]){const marker=(node.id||'')+' '+(typeof node.className==='string'?node.className:'');if(/\bidm\b|internet-download-manager|download-manager/i.test(marker)&&node!==document.body&&node!==document.documentElement)node.remove()}}
stripIdmPanels();new MutationObserver(mutations=>mutations.forEach(m=>m.addedNodes.forEach(n=>{if(n.nodeType===1){stripIdmPanels(n);const marker=(n.id||'')+' '+(typeof n.className==='string'?n.className:'');if(/\bidm\b|internet-download-manager|download-manager/i.test(marker))n.remove()}}))).observe(document.documentElement,{subtree:true,childList:true});
 $('toggleView').onclick=()=>{if(singleVideoMode){backToSource();return}const isFocus=$('layout').classList.contains('focus-player');setViewMode(isFocus?'split':'focus')};$('randomPage').onclick=()=>load(true,true);$('queueViews').onclick=queueViews;$('refresh').onclick=()=>load(true);$('loadMore').onclick=loadNextPage;$('query').oninput=()=>{clearTimeout(timer);timer=setTimeout(()=>load(true),250)};['sort','direction','watchedFilter'].forEach(id=>$(id).onchange=()=>load(true));$('mainVideo').onended=()=>{persistPlayback(true);if(current<items.length-1)select(current+1);else if(hasNext)navigateAdjacent(1)};$('mainVideo').ontimeupdate=schedulePlaybackSave;$('mainVideo').onpause=()=>persistPlayback(true);$('mainVideo').onerror=()=>{const task=items[current];if(task)void explainMediaFailure($('mainVideo'),task)};$('mainVideo').onloadeddata=()=>showPlayerError('');window.addEventListener('pagehide',()=>{sendPlaybackBeacon()},{once:true});window.addEventListener('beforeunload',sendPlaybackBeacon,{once:true});if(!singleVideoMode){$('query').value=routeParams.get('query')||'';$('sort').value=routeParams.get('sort')||'updatedAt';$('direction').value=routeParams.get('direction')||'desc';$('watchedFilter').value=routeParams.get('watched')||'all'}document.body.classList.toggle('single-mode',singleVideoMode);if(singleVideoMode){setViewMode('focus');if(pendingPlay)load(true,false);else{render();$('status').textContent='请从播放列表选择一个视频。'}}else{try{setViewMode(localStorage.getItem('iwara-player-view')||'split')}catch{setViewMode('split')}setupInfiniteScroll();load(true,!(routeParams.has('page')||routeParams.has('query')||routeParams.has('sort')||routeParams.has('direction')||routeParams.has('watched')))}
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

async function serveLocalMedia(request, response, scheduler, encodedId) {
  try {
    const media = await scheduler.mediaPath(decodeURIComponent(encodedId));
    const info = await stat(media.path);
    const total = info.size;
    const baseHeaders = {
      "content-type": mediaContentType(media.path),
      "accept-ranges": "bytes",
      "cache-control": "private, max-age=3600",
      "content-disposition": `inline; filename*=UTF-8''${encodeURIComponent(media.name)}`
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
    sendJson(response, error.message === "本地视频不存在" || error.code === "ENOENT" ? 404 : 403, { error: error.message });
  }
}

async function serveLocalCover(request, response, scheduler, cache, encodedId) {
  try {
    const image = await cache.get(decodeURIComponent(encodedId), scheduler);
    response.writeHead(200, {
      "content-type": "image/jpeg",
      "content-length": image.length,
      "cache-control": "private, no-store",
      "x-content-type-options": "nosniff"
    });
    response.end(request.method === "HEAD" ? undefined : image);
  } catch (error) {
    const status = error.message === "本地视频不存在" || error.code === "ENOENT" ? 404 : 503;
    sendJson(response, status, { error: status === 404 ? "本地视频不存在" : "封面暂时无法生成" });
  }
}

export function createServer({ scheduler, host, port, accessToken = "", ffmpeg = null, onShutdown }) {
  const coverCache = new CoverCache({ ffmpeg });
  const mediaDiagnostics = [];
  const server = http.createServer(async (request, response) => {
    const origin = request.headers.origin || "";
    const reply = (status, payload) => sendJson(response, status, payload, origin, request.headers.host || "");
    try {
      const url = new URL(request.url, `http://${request.headers.host}`);
      if (/^\/(media|cover)\//.test(url.pathname)) {
        const remote = normalizeAddress(request.socket?.remoteAddress || "unknown");
        const range = String(request.headers.range || "-").slice(0, 120);
        const resourceId = url.pathname.startsWith("/media/") ? url.pathname.slice(7) : "";
        const startedAt = Date.now();
        const record = (status, aborted = false) => {
          if (!resourceId) return;
          mediaDiagnostics.push({ taskId: resourceId, status, aborted, range, startedAt });
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
      if (!allowedOrigin(origin, request.headers.host || "")) {
        reply(403, { error: "origin not allowed" });
        return;
      }
      const auth = authorizeRequest(request, url, accessToken);
      if (!auth.ok) {
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
      if (auth.viaQuery && request.method === "GET" && ["/", "/playlist", "/playlist.html"].includes(url.pathname)) {
        url.searchParams.delete("access_token");
        url.searchParams.delete("token");
        const location = `${url.pathname}${url.search ? `?${url.searchParams}` : ""}`;
        response.writeHead(302, {
          location,
          "cache-control": "no-store",
          "set-cookie": "iwara_lan_token=" + encodeURIComponent(String(accessToken)) + "; HttpOnly; SameSite=Strict; Path=/; Max-Age=2592000"
        });
        response.end();
        return;
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
      if (request.method === "GET" && url.pathname === "/") {
        const body = dashboardHtml();
        response.writeHead(200, {
          "content-type": "text/html; charset=utf-8",
          "cache-control": "no-store",
          "x-content-type-options": "nosniff",
          "x-frame-options": "DENY",
          "referrer-policy": "no-referrer",
          "content-security-policy": "default-src 'self'; media-src 'self' blob:; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; object-src 'none'; frame-src 'none'"
        });
        response.end(body);
      } else if (request.method === "GET" && ["/player", "/playlist", "/playlist.html"].includes(url.pathname)) {
        const body = playlistHtml();
        response.writeHead(200, {
          "content-type": "text/html; charset=utf-8",
          "cache-control": "no-store",
          "x-content-type-options": "nosniff",
          "x-frame-options": "DENY",
          "referrer-policy": "no-referrer",
          "content-security-policy": "default-src 'self'; media-src 'self' blob:; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; object-src 'none'; frame-src 'none'"
        });
        response.end(body);
      } else if ((request.method === "GET" || request.method === "HEAD") && url.pathname.startsWith("/media/")) {
        await serveLocalMedia(request, response, scheduler, url.pathname.slice("/media/".length));
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
          author: url.searchParams.get("author") || "all",
          watched: url.searchParams.get("watched") || "all",
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
        }), accessToken));
      } else if (request.method === "POST" && url.pathname === "/api/views") {
        const body = await readJson(request);
        reply(200, await scheduler.updateViewCount(body.videoId, body.views));
      } else if (request.method === "POST" && url.pathname.startsWith("/api/playback/")) {
        const taskId = decodeURIComponent(url.pathname.slice("/api/playback/".length));
        reply(200, await scheduler.updatePlayback(taskId, await readJson(request)));
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
        const urls = token
          ? localLanAddresses().map(address => `http://${address}:${port}/playlist?access_token=${encodedToken}`)
          : [];
        reply(200, { enabled: Boolean(token), urls, host, port });
      } else if (request.method === "GET" && url.pathname.startsWith("/api/media-diagnostics/")) {
        const taskId = decodeURIComponent(url.pathname.slice("/api/media-diagnostics/".length));
        const since = Number(url.searchParams.get("since") || 0);
        reply(200, { events: mediaDiagnostics.filter(item => item.taskId === taskId && item.startedAt >= since).slice(-10) });
      } else if (request.method === "GET" && url.pathname === "/api/status") {
        reply(200, scheduler.status());
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
      } else if (request.method === "GET" && url.pathname === "/api/resolve/next") {
        reply(200, { task: await scheduler.leaseNext() });
      } else if (request.method === "POST" && url.pathname === "/api/resolve/result") {
        reply(200, await scheduler.submitResolution(await readJson(request)));
      } else if (request.method === "GET" && url.pathname === "/api/enrich/next") {
        reply(200, { task: await scheduler.leaseMetadataEnrichment() });
      } else if (request.method === "POST" && url.pathname === "/api/enrich/result") {
        reply(200, await scheduler.submitMetadataEnrichment(await readJson(request)));
      } else if (request.method === "POST" && url.pathname === "/api/enrich/retry-failed") {
        reply(200, await scheduler.retryFailedMetadata());
      } else if (request.method === "POST" && url.pathname === "/api/enrich/queue-views") {
        const body = await readJson(request);
        reply(200, await scheduler.queueViewCountEnrichment(body.limit));
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
      reply(400, { error: error.message });
    }
  });
  return {
    server,
    listen: () => new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, host, resolve);
    }),
    close: () => { coverCache.clear(); return new Promise(resolve => server.close(resolve)); }
  };
}
