// ==UserScript==
// @name              Iwara Download Tool
// @description       Download Iwara videos through a resilient local queue
// @name:ja           Iwara バッチダウンローダー
// @description:ja    Iwara 動画バッチをダウンロード
// @name:zh-CN        Iwara 批量下载工具
// @description:zh-CN 批量下载 Iwara 视频
// @icon              https://www.google.com/s2/favicons?sz=64&domain=iwara.tv
// @namespace         https://github.com/dawn-lc/
// @author            dawn-lc, local resilient queue patch
// @license           Apache-2.0
// @copyright         2026, Dawnlc (https://dawnlc.me/)
// @connect           iwara.tv
// @connect           *.iwara.*
// @connect           localhost
// @connect           127.0.0.1
// @connect           *
// @include           *://*iwara*/*
// @grant             GM_getValue
// @grant             GM_setValue
// @grant             GM_listValues
// @grant             GM_deleteValue
// @grant             GM_addValueChangeListener
// @grant             GM_addStyle
// @grant             GM_setClipboard
// @grant             GM_download
// @grant             GM_xmlhttpRequest
// @grant             GM_openInTab
// @grant             GM_info
// @grant             unsafeWindow
// @grant             window.close
// @run-at            document-start
// @noframes
// @version           3.3.130
// ==/UserScript==
"use strict";
(() => {
  const __iwaraQueueSniffParams = (() => {
    try { return new URL(unsafeWindow.location.href).searchParams; } catch { return null; }
  })();
  const __iwaraQueueSniffEnabled = __iwaraQueueSniffParams?.get("__iwara_queue_sniff") === "1";
  const __iwaraQueueSniffCandidates = [];
  const __iwaraQueueSniffSeen = new Set();
  const __iwaraQueueViewSyncSent = new Set();
  function __iwaraQueueCurrentVideoId() {
    try {
      const match = /^\/video\/([^/?#]+)/i.exec(unsafeWindow.location.pathname || "");
      return match ? decodeURIComponent(match[1]) : "";
    } catch {
      return "";
    }
  }
  function __iwaraQueueReadViewCount() {
    try {
      const nodes = unsafeWindow.document.querySelectorAll(".stats__number[title], [class*='stats__number'][title]");
      for (const node of nodes) {
        if (!node.querySelector("svg[data-icon='eye'], svg.fa-eye, [data-icon='eye']")) continue;
        const raw = node.getAttribute("title") || node.textContent || "";
        const digits = String(raw).replace(/[^0-9]/g, "");
        if (digits) return Number(digits);
      }
    } catch {}
    return null;
  }
  function __iwaraQueueSyncCurrentPageViews() {
    const videoId = __iwaraQueueCurrentVideoId();
    if (!videoId) return;
    let tries = 0;
    const poll = () => {
      const views = __iwaraQueueReadViewCount();
      if (Number.isSafeInteger(views) && views >= 0) {
        const key = `${videoId}:${views}`;
        if (__iwaraQueueViewSyncSent.has(key)) return;
        __iwaraQueueViewSyncSent.add(key);
        try {
          GM_xmlhttpRequest({
            method: "POST",
            url: "http://127.0.0.1:18777/api/views",
            headers: { "Content-Type": "application/json" },
            data: JSON.stringify({ videoId, views }),
            timeout: 10_000
          });
        } catch {}
        return;
      }
      if (tries++ < 20) unsafeWindow.setTimeout(poll, 1_000);
    };
    unsafeWindow.setTimeout(poll, 800);
  }
  function __iwaraQueueMediaKind(url, contentType = "") {
    const raw = String(url || "");
    if (!raw || /^(?:blob|data):/i.test(raw)) return "";
    const type = String(contentType || "").toLowerCase();
    let parsed = null;
    let pathname = raw.toLowerCase();
    let filename = "";
    try {
      parsed = new URL(raw, unsafeWindow.location.href);
      pathname = parsed.pathname.toLowerCase();
      // Iwara's CDN uses /view?filename=..._Source.mp4 instead of putting the
      // media extension in the request path.  Native <video> requests and
      // PerformanceObserver entries do not expose a response MIME type here,
      // so the filename query parameter is the reliable format hint.
      filename = String(parsed.searchParams.get("filename") || "").toLowerCase();
    } catch {}
    if (parsed && /(^|\.)iwara\.(tv|zip|shop|ai)$/i.test(parsed.hostname) && /^\/video\/[^/]+\/?$/i.test(parsed.pathname)) return "";
    const mediaHint = `${pathname} ${filename}`;
    if (/mpegurl/.test(type) || /\.m3u8(?:$|[?#])/i.test(mediaHint)) return "hls";
    if (/dash\+xml/.test(type) || /\.mpd(?:$|[?#])/i.test(mediaHint)) return "dash";
    if (/^video\//.test(type) || /\.(?:mp4|webm|m4v|mov)(?:$|[?#])/i.test(mediaHint)) return "direct";
    return "";
  }
  function __iwaraQueueRecordMedia(url, contentType = "", source = "network") {
    if (!__iwaraQueueSniffEnabled) return;
    let absolute = String(url || "");
    try { absolute = new URL(absolute, unsafeWindow.location.href).href; } catch {}
    const kind = __iwaraQueueMediaKind(absolute, contentType);
    if (!kind || __iwaraQueueSniffSeen.has(absolute)) return;
    __iwaraQueueSniffSeen.add(absolute);
    __iwaraQueueSniffCandidates.push({ url: absolute, contentType: String(contentType || ""), kind, source, at: Date.now() });
  }
  if (__iwaraQueueSniffEnabled) {
    try {
      const originalFetch = unsafeWindow.fetch;
      if (typeof originalFetch === "function") {
        unsafeWindow.fetch = async function(input, init) {
          const requestUrl = typeof input === "string" ? input : input?.url;
          __iwaraQueueRecordMedia(requestUrl, "", "fetch-request");
          const response = await originalFetch.apply(this, arguments);
          try { __iwaraQueueRecordMedia(response.url || requestUrl, response.headers?.get?.("content-type") || "", "fetch-response"); } catch {}
          return response;
        };
      }
    } catch {}
    try {
      const originalOpen = unsafeWindow.XMLHttpRequest.prototype.open;
      unsafeWindow.XMLHttpRequest.prototype.open = function(method, url) {
        this.__iwaraQueueUrl = url;
        __iwaraQueueRecordMedia(url, "", "xhr-request");
        this.addEventListener("load", () => {
          try { __iwaraQueueRecordMedia(this.responseURL || this.__iwaraQueueUrl, this.getResponseHeader("content-type") || "", "xhr-response"); } catch {}
        }, { once: true });
        return originalOpen.apply(this, arguments);
      };
    } catch {}
    try {
      const observer = new unsafeWindow.PerformanceObserver(list => {
        for (const entry of list.getEntries()) __iwaraQueueRecordMedia(entry.name, "", "performance");
      });
      observer.observe({ type: "resource", buffered: true });
    } catch {}
  }
  var __create = Object.create;
  var __defProp = Object.defineProperty;
  var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
  var __getOwnPropNames = Object.getOwnPropertyNames;
  var __getProtoOf = Object.getPrototypeOf;
  var __hasOwnProp = Object.prototype.hasOwnProperty;
  var __commonJS = (cb, mod) => function __require() {
    try {
      return mod || (0, cb[__getOwnPropNames(cb)[0]])((mod = { exports: {} }).exports, mod), mod.exports;
    } catch (e) {
      throw mod = 0, e;
    }
  };
  var __copyProps = (to, from, except, desc) => {
    if (from && typeof from === "object" || typeof from === "function") {
      for (let key of __getOwnPropNames(from))
        if (!__hasOwnProp.call(to, key) && key !== except)
          __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
    }
    return to;
  };
  var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
    isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
    mod
  ));
  var require_dayjs_min = __commonJS({
    "node_modules/dayjs/dayjs.min.js"(exports, module) {
      "use strict";
      (function(k2, g2) {
        typeof exports == "object" && typeof module < "u" ? module.exports = g2() : typeof define == "function" && define.amd ? define(g2) : (k2 = typeof globalThis < "u" ? globalThis : k2 || self).dayjs = g2();
      })(exports, (function() {
        "use strict";
        var k2 = 1e3, g2 = 6e4, U = 36e5, A2 = "millisecond", w2 = "second", O2 = "minute", b2 = "hour", M2 = "day", L2 = "week", m2 = "month", F2 = "quarter", y2 = "year", _ = "date", J = "Invalid Date", V2 = /^(\d{4})[-/]?(\d{1,2})?[-/]?(\d{0,2})[Tt\s]*(\d{1,2})?:?(\d{1,2})?:?(\d{1,2})?[.:]?(\d+)?$/, q = /\[([^\]]+)]|YYYY|YY|M{1,4}|D{1,2}|d{1,4}|H{1,2}|h{1,2}|a|A|m{1,2}|s{1,2}|Z{1,2}|SSS/g, B2 = { name: "en", weekdays: "Sunday_Monday_Tuesday_Wednesday_Thursday_Friday_Saturday".split("_"), months: "January_February_March_April_May_June_July_August_September_October_November_December".split("_"), ordinal: function(i) {
          var n = ["th", "st", "nd", "rd"], t = i % 100;
          return "[" + i + (n[(t - 20) % 10] || n[t] || n[0]) + "]";
        } }, I2 = function(i, n, t) {
          var r = String(i);
          return !r || r.length >= n ? i : "" + Array(n + 1 - r.length).join(t) + i;
        }, E2 = { s: I2, z: function(i) {
          var n = -i.utcOffset(), t = Math.abs(n), r = Math.floor(t / 60), e = t % 60;
          return (n <= 0 ? "+" : "-") + I2(r, 2, "0") + ":" + I2(e, 2, "0");
        }, m: function i(n, t) {
          if (n.date() < t.date()) return -i(t, n);
          var r = 12 * (t.year() - n.year()) + (t.month() - n.month()), e = n.clone().add(r, m2), s = t - e < 0, u = n.clone().add(r + (s ? -1 : 1), m2);
          return +(-(r + (t - e) / (s ? e - u : u - e)) || 0);
        }, a: function(i) {
          return i < 0 ? Math.ceil(i) || 0 : Math.floor(i);
        }, p: function(i) {
          return { M: m2, y: y2, w: L2, d: M2, D: _, h: b2, m: O2, s: w2, ms: A2, Q: F2 }[i] || String(i || "").toLowerCase().replace(/s$/, "");
        }, u: function(i) {
          return i === void 0;
        } }, T2 = "en", D2 = {};
        D2[T2] = B2;
        var Z = "$isDayjsObject", N = function(i) {
          return i instanceof C2 || !(!i || !i[Z]);
        }, W2 = function i(n, t, r) {
          var e;
          if (!n) return T2;
          if (typeof n == "string") {
            var s = n.toLowerCase();
            D2[s] && (e = s), t && (D2[s] = t, e = s);
            var u = n.split("-");
            if (!e && u.length > 1) return i(u[0]);
          } else {
            var o = n.name;
            D2[o] = n, e = o;
          }
          return !r && e && (T2 = e), e || !r && T2;
        }, f2 = function(i, n) {
          if (N(i)) return i.clone();
          var t = typeof n == "object" ? n : {};
          return t.date = i, t.args = arguments, new C2(t);
        }, a2 = E2;
        a2.l = W2, a2.i = N, a2.w = function(i, n) {
          return f2(i, { locale: n.$L, utc: n.$u, x: n.$x, $offset: n.$offset });
        };
        var C2 = (function() {
          function i(t) {
            this.$L = W2(t.locale, null, true), this.parse(t), this.$x = this.$x || t.x || {}, this[Z] = true;
          }
          var n = i.prototype;
          return n.parse = function(t) {
            this.$d = (function(r) {
              var e = r.date, s = r.utc;
              if (e === null) return new Date(NaN);
              if (a2.u(e)) return new Date();
              if (e instanceof Date) return new Date(e);
              if (typeof e == "string" && !/Z$/i.test(e)) {
                var u = e.match(V2);
                if (u) {
                  var o = u[2] - 1 || 0, c = (u[7] || "0").substring(0, 3);
                  return s ? new Date(Date.UTC(u[1], o, u[3] || 1, u[4] || 0, u[5] || 0, u[6] || 0, c)) : new Date(u[1], o, u[3] || 1, u[4] || 0, u[5] || 0, u[6] || 0, c);
                }
              }
              return new Date(e);
            })(t), this.init();
          }, n.init = function() {
            var t = this.$d;
            this.$y = t.getFullYear(), this.$M = t.getMonth(), this.$D = t.getDate(), this.$W = t.getDay(), this.$H = t.getHours(), this.$m = t.getMinutes(), this.$s = t.getSeconds(), this.$ms = t.getMilliseconds();
          }, n.$utils = function() {
            return a2;
          }, n.isValid = function() {
            return this.$d.toString() !== J;
          }, n.isSame = function(t, r) {
            var e = f2(t);
            return this.startOf(r) <= e && e <= this.endOf(r);
          }, n.isAfter = function(t, r) {
            return f2(t) < this.startOf(r);
          }, n.isBefore = function(t, r) {
            return this.endOf(r) < f2(t);
          }, n.$g = function(t, r, e) {
            return a2.u(t) ? this[r] : this.set(e, t);
          }, n.unix = function() {
            return Math.floor(this.valueOf() / 1e3);
          }, n.valueOf = function() {
            return this.$d.getTime();
          }, n.startOf = function(t, r) {
            var e = this, s = !!a2.u(r) || r, u = a2.p(t), o = function(S2, $) {
              var v2 = a2.w(e.$u ? Date.UTC(e.$y, $, S2) : new Date(e.$y, $, S2), e);
              return s ? v2 : v2.endOf(M2);
            }, c = function(S2, $) {
              return a2.w(e.toDate()[S2].apply(e.toDate("s"), (s ? [0, 0, 0, 0] : [23, 59, 59, 999]).slice($)), e);
            }, h2 = this.$W, d = this.$M, l2 = this.$D, Y = "set" + (this.$u ? "UTC" : "");
            switch (u) {
              case y2:
                return s ? o(1, 0) : o(31, 11);
              case m2:
                return s ? o(1, d) : o(0, d + 1);
              case L2:
                var p2 = this.$locale().weekStart || 0, H = (h2 < p2 ? h2 + 7 : h2) - p2;
                return o(s ? l2 - H : l2 + (6 - H), d);
              case M2:
              case _:
                return c(Y + "Hours", 0);
              case b2:
                return c(Y + "Minutes", 1);
              case O2:
                return c(Y + "Seconds", 2);
              case w2:
                return c(Y + "Milliseconds", 3);
              default:
                return this.clone();
            }
          }, n.endOf = function(t) {
            return this.startOf(t, false);
          }, n.$set = function(t, r) {
            var e, s = a2.p(t), u = "set" + (this.$u ? "UTC" : ""), o = (e = {}, e[M2] = u + "Date", e[_] = u + "Date", e[m2] = u + "Month", e[y2] = u + "FullYear", e[b2] = u + "Hours", e[O2] = u + "Minutes", e[w2] = u + "Seconds", e[A2] = u + "Milliseconds", e)[s], c = s === M2 ? this.$D + (r - this.$W) : r;
            if (s === m2 || s === y2) {
              var h2 = this.clone().set(_, 1);
              h2.$d[o](c), h2.init(), this.$d = h2.set(_, Math.min(this.$D, h2.daysInMonth())).$d;
            } else o && this.$d[o](c);
            return this.init(), this;
          }, n.set = function(t, r) {
            return this.clone().$set(t, r);
          }, n.get = function(t) {
            return this[a2.p(t)]();
          }, n.add = function(t, r) {
            var e, s = this;
            t = Number(t);
            var u = a2.p(r), o = function(d) {
              var l2 = f2(s);
              return a2.w(l2.date(l2.date() + Math.round(d * t)), s);
            };
            if (u === m2) return this.set(m2, this.$M + t);
            if (u === y2) return this.set(y2, this.$y + t);
            if (u === M2) return o(1);
            if (u === L2) return o(7);
            var c = (e = {}, e[O2] = g2, e[b2] = U, e[w2] = k2, e)[u] || 1, h2 = this.$d.getTime() + t * c;
            return a2.w(h2, this);
          }, n.subtract = function(t, r) {
            return this.add(-1 * t, r);
          }, n.format = function(t) {
            var r = this, e = this.$locale();
            if (!this.isValid()) return e.invalidDate || J;
            var s = t || "YYYY-MM-DDTHH:mm:ssZ", u = a2.z(this), o = this.$H, c = this.$m, h2 = this.$M, d = e.weekdays, l2 = e.months, Y = e.meridiem, p2 = function($, v2, x2, j2) {
              return $ && ($[v2] || $(r, s)) || x2[v2].slice(0, j2);
            }, H = function($) {
              return a2.s(o % 12 || 12, $, "0");
            }, S2 = Y || function($, v2, x2) {
              var j2 = $ < 12 ? "AM" : "PM";
              return x2 ? j2.toLowerCase() : j2;
            };
            return s.replace(q, (function($, v2) {
              return v2 || (function(x2) {
                switch (x2) {
                  case "YY":
                    return String(r.$y).slice(-2);
                  case "YYYY":
                    return a2.s(r.$y, 4, "0");
                  case "M":
                    return h2 + 1;
                  case "MM":
                    return a2.s(h2 + 1, 2, "0");
                  case "MMM":
                    return p2(e.monthsShort, h2, l2, 3);
                  case "MMMM":
                    return p2(l2, h2);
                  case "D":
                    return r.$D;
                  case "DD":
                    return a2.s(r.$D, 2, "0");
                  case "d":
                    return String(r.$W);
                  case "dd":
                    return p2(e.weekdaysMin, r.$W, d, 2);
                  case "ddd":
                    return p2(e.weekdaysShort, r.$W, d, 3);
                  case "dddd":
                    return d[r.$W];
                  case "H":
                    return String(o);
                  case "HH":
                    return a2.s(o, 2, "0");
                  case "h":
                    return H(1);
                  case "hh":
                    return H(2);
                  case "a":
                    return S2(o, c, true);
                  case "A":
                    return S2(o, c, false);
                  case "m":
                    return String(c);
                  case "mm":
                    return a2.s(c, 2, "0");
                  case "s":
                    return String(r.$s);
                  case "ss":
                    return a2.s(r.$s, 2, "0");
                  case "SSS":
                    return a2.s(r.$ms, 3, "0");
                  case "Z":
                    return u;
                }
                return null;
              })($) || u.replace(":", "");
            }));
          }, n.utcOffset = function() {
            return 15 * -Math.round(this.$d.getTimezoneOffset() / 15);
          }, n.diff = function(t, r, e) {
            var s, u = this, o = a2.p(r), c = f2(t), h2 = (c.utcOffset() - this.utcOffset()) * g2, d = this - c, l2 = function() {
              return a2.m(u, c);
            };
            switch (o) {
              case y2:
                s = l2() / 12;
                break;
              case m2:
                s = l2();
                break;
              case F2:
                s = l2() / 3;
                break;
              case L2:
                s = (d - h2) / 6048e5;
                break;
              case M2:
                s = (d - h2) / 864e5;
                break;
              case b2:
                s = d / U;
                break;
              case O2:
                s = d / g2;
                break;
              case w2:
                s = d / k2;
                break;
              default:
                s = d;
            }
            return e ? s : a2.a(s);
          }, n.daysInMonth = function() {
            return this.endOf(m2).$D;
          }, n.$locale = function() {
            return D2[this.$L];
          }, n.locale = function(t, r) {
            if (!t) return this.$L;
            var e = this.clone(), s = W2(t, r, true);
            return s && (e.$L = s), e;
          }, n.clone = function() {
            return a2.w(this.$d, this);
          }, n.toDate = function() {
            return new Date(this.valueOf());
          }, n.toJSON = function() {
            return this.isValid() ? this.toISOString() : null;
          }, n.toISOString = function() {
            return this.$d.toISOString();
          }, n.toString = function() {
            return this.$d.toUTCString();
          }, i;
        })(), z = C2.prototype;
        return f2.prototype = z, [["$ms", A2], ["$s", w2], ["$m", O2], ["$H", b2], ["$W", M2], ["$M", m2], ["$y", y2], ["$D", _]].forEach((function(i) {
          z[i[1]] = function(n) {
            return this.$g(n, i[0], i[1]);
          };
        })), f2.extend = function(i, n) {
          return i.$i || (i(n, C2, f2), i.$i = true), f2;
        }, f2.locale = W2, f2.isDayjs = N, f2.unix = function(i) {
          return f2(1e3 * i);
        }, f2.en = D2[T2], f2.Ls = D2, f2.p = {}, f2;
      }));
    }
  });
  var site_default = {
    officialDomains: [
      "iwara.tv",
      "iwara.zip",
      "iwara.shop",
      "iwara.ai"
    ],
    supportedDomains: [
      "iwara.tv",
      "iwara.ai"
    ],
    apiEndpoint: "api.iwara.tv",
    syncStartPage: 6e3,
    maxFindPages: 64
  };
  if (unsafeWindow.IwaraDownloadTool) {
    throw `Script is already running`;
  }
  unsafeWindow.IwaraDownloadTool = true;
  var domain = window.location.hostname;
  var isOfficial = site_default.officialDomains.some(
    (d) => domain === d || domain.endsWith("." + d)
  );
  if (!isOfficial && domain.includes("iwara")) {
    XMLHttpRequest.prototype.open = function() {
      throw new Error("Blocked");
    };
    unsafeWindow.fetch = () => Promise.reject();
    unsafeWindow.WebSocket = function() {
      throw new Error("Blocked");
    };
    const i18n = {
      zh: "警告：当前网站不是 Iwara 官方网站，可能存在钓鱼或仿冒风险，请勿输入账号、密码或其他敏感信息。是否继续访问？",
      en: "Warning: This website is not an official Iwara website and may be a phishing or impersonation site. Do not enter your account, password, or any sensitive information. Continue anyway?",
      ja: "警告: 現在のサイトは Iwara の公式サイトではなく、フィッシングサイトまたは偽装サイトの可能性があります。アカウント、パスワード、その他の機密情報を入力しないでください。続行しますか？"
    };
    const lang = navigator.language?.replace("-", "_").toLowerCase().split("_")[0];
    if (!confirm(i18n[lang] || i18n.en)) {
      unsafeWindow.document.documentElement?.remove();
      unsafeWindow.stop();
      unsafeWindow.close();
      unsafeWindow.location.href = "about:blank";
      throw new Error("Blocked");
    } else {
      throw "Not official";
    }
  }
  var rainbow_default = "@keyframes rainbow-horizontal{0%{background-position:0% 0%}to{background-position:200% 0%}}@keyframes rainbow-vertical{0%{background-position:0% 0%}to{background-position:0% 200%}}.rainbow-text{background-image:linear-gradient(to right,#ff4040,#ffff40,#40ff40,#40ffff,#4040ff,#ff40ff,#ff4040);background-size:200% 100%;background-clip:text;-webkit-background-clip:text;-webkit-text-fill-color:transparent;animation:rainbow-horizontal .8s infinite linear;font-weight:700}";
  var menu_default = '#pluginMenu{z-index:2147483644;position:fixed;top:50%;right:0;padding:10px 26px;background-color:var(--body-dark);border:1px solid var(--text);border-radius:5px;box-shadow:0 0 10px var(--text);transform:translate(calc(100% - 26px)) translateY(-50%);transition:transform .3s ease-in-out}#pluginMenu:not(.expanded){overflow:visible}#pluginMenu:not(.expanded):before{content:"";mask:url(data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgLTk2MCA5NjAgOTYwIj48cGF0aCBkPSJNNTYwLTI0MCAzMjAtNDgwbDI0MC0yNDAgNTYgNTYtMTg0IDE4NCAxODQgMTg0LTU2IDU2WiIvPjwvc3ZnPg==) no-repeat center;-webkit-mask:url(data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgLTk2MCA5NjAgOTYwIj48cGF0aCBkPSJNNTYwLTI0MCAzMjAtNDgwbDI0MC0yNDAgNTYgNTYtMTg0IDE4NCAxODQgMTg0LTU2IDU2WiIvPjwvc3ZnPg==) no-repeat center;background-color:var(--text);width:24px;height:24px;position:absolute;left:0;top:50%;line-height:0;transform:translateY(-50%)}#pluginMenu.expanded{transform:translate(0) translateY(-50%)}#pluginMenu ul{list-style:none;margin:0;padding:0}#pluginMenu li{padding:5px 10px;cursor:pointer;text-align:center;user-select:none;color:var(--text)}#pluginMenu li:hover{background-color:var(--primary-dark);border-radius:3px}@media(max-width:720px){#pluginMenu{padding:8px 18px;transform:translate(calc(100% - 18px)) translateY(-50%)}#pluginMenu:not(.expanded):before{width:20px;height:20px}#pluginMenu.expanded{transform:translate(0) translateY(-50%)}#pluginMenu li{padding:12px 16px;font-size:15px;min-width:44px;min-height:44px;display:flex;align-items:center;justify-content:center;white-space:nowrap}}@media(max-width:480px){#pluginMenu{padding:6px 14px;transform:translate(calc(100% - 14px)) translateY(-50%)}#pluginMenu:not(.expanded):before{width:18px;height:18px}#pluginMenu li{padding:14px 18px;font-size:14px}}@media(pointer:coarse){#pluginMenu{padding:12px 34px;transform:translate(calc(100% - 34px)) translateY(-50%)}#pluginMenu:not(.expanded):before{width:28px;height:28px;left:3px}#pluginMenu.expanded{transform:translate(0) translateY(-50%)}#pluginMenu li{padding:14px 22px;font-size:15px;min-width:48px;min-height:48px;display:flex;align-items:center;justify-content:center;white-space:nowrap}#pluginMenu li:nth-child(odd){background-color:var(--body-dark)}#pluginMenu li:nth-child(2n){background-color:var(--body)}#pluginMenu li:active{background-color:var(--primary-dark)!important;border-radius:3px}}';
  var config_default = '#pluginConfig{color:var(--text);position:fixed;top:0;left:0;width:100%;height:100%;background-color:#000000bf;z-index:2147483646;display:flex;flex-direction:column;align-items:center;justify-content:center}#pluginConfig .main{background-color:var(--body);padding:24px;margin:10px;overflow-y:auto;width:480px}#pluginConfig .buttonList{display:flex;flex-direction:row;justify-content:center}@media(max-width:640px){#pluginConfig .main{width:100%;height:80%}}#pluginConfig button{background-color:var(--primary);margin:0 20px;padding:10px 20px;color:var(--primary-text);font-size:18px;border:none;border-radius:4px;cursor:pointer}#pluginConfig button{background-color:var(--primary)}#pluginConfig button[disabled]{background-color:var(--muted);cursor:not-allowed}#pluginConfig p{display:flex;flex-direction:column;margin-top:10px;margin-bottom:0}#pluginConfig fieldset{border:none;margin:10px 0 0;padding:0;display:flex;justify-content:space-between;flex-wrap:nowrap}#pluginConfig fieldset>legend{margin:0 0 5px;padding:0}#pluginConfig fieldset>label{text-align:center}#pluginConfig p label{display:flex;flex-direction:column;margin:5px 0 0}#pluginConfig .inputRadioLine{display:flex;align-items:center;flex-direction:row;justify-content:space-between}#pluginConfig input[type=text],#pluginConfig input[type=password]{outline:none;border-top:none;border-right:none;border-left:none;border-image:initial;border-bottom:1px solid var(--muted);line-height:1;height:30px;box-sizing:border-box;width:100%;background-color:var(--body);color:var(--text)}#pluginConfig input[type=checkbox].switch{outline:none;appearance:none;-webkit-appearance:none;-moz-appearance:none;position:relative;width:40px;height:20px;background:var(--muted);border-radius:10px;transition:border-color .2s,background-color .2s}#pluginConfig input[type=checkbox].switch:after{content:"";display:inline-block;width:40%;height:80%;border-radius:50%;background:var(--white);box-shadow:0,0,2px,var(--muted);transition:.2s;top:2px;position:absolute;right:55%}#pluginConfig input[type=checkbox].switch:checked{background:var(--success)}#pluginConfig input[type=checkbox].switch:checked:after{content:"";position:absolute;right:2px;top:2px}';
  var overlay_default = "#pluginOverlay{position:fixed;top:0;left:0;width:100%;height:100%;background-color:#000000bf;z-index:2147483645;display:flex;flex-direction:column;align-items:center;justify-content:center}#pluginOverlay .main{color:var(--text);font-size:24px;width:60%;background-color:var(--body);padding:24px;margin:10px;overflow-y:auto}@media(max-width:640px){#pluginOverlay .main{width:100%}}#pluginOverlay button{padding:10px 20px;color:var(--primary-text);font-size:18px;border:none;border-radius:4px;cursor:pointer}#pluginOverlay button{background-color:var(--primary)}#pluginOverlay button[disabled]{background-color:var(--muted);cursor:not-allowed}#pluginOverlay .checkbox{width:32px;height:32px;margin:0 4px 0 0;padding:0}#pluginOverlay .checkbox-container{display:flex;align-items:center;margin:0 0 10px}#pluginOverlay .checkbox-label{color:var(--text);font-size:32px;font-weight:700;margin-left:10px;display:flex;align-items:center}";
  var videoCard_default = ".fixed-bottom-right{position:fixed;bottom:0;right:0;background-color:var(--body);color:var(--text);border-top:1px solid var(--primary);border-left:1px solid var(--primary);border-top-left-radius:6px;padding:2px 5px;margin:0;user-select:none;z-index:102}.downloaded{bottom:46px;right:2px;border-radius:2px;position:absolute;padding:3px 5px;background-color:#000c;pointer-events:none}.follow{bottom:24px;right:2px;border-radius:2px;position:absolute;padding:3px 5px;background-color:#000c;pointer-events:none}.selectButton{accent-color:var(--primary);position:absolute;width:38px;height:38px;right:0;cursor:pointer;z-index:102;top:22px}.deleteButton{accent-color:var(--danger);position:absolute;width:38px;height:38px;left:0;cursor:pointer;z-index:101;border:none;padding:0;margin:3px;top:22px}";
  var toast_default = ".toast h3{margin:0 0 10px}.toast p{margin:0}.offscreen-container{position:absolute;visibility:hidden;pointer-events:none;max-width:480px}.toast-container{isolation:isolate;position:fixed;z-index:2147483647;display:flex;flex-direction:column;box-sizing:border-box;transition:transform calc(.6 * var(--toast-rate) * 1s) ease,opacity calc(.6 * var(--toast-rate) * 1s) ease}.toast-container.toast-top{top:0}.toast-container.toast-bottom{bottom:0}.toast-container.toast-left{left:0;align-items:flex-start}.toast-container.toast-center{left:50%;transform:translate(-50%);align-items:center}.toast-container.toast-right{right:0;align-items:flex-end}#toast-container-top-left .toast{margin:10px 0 0 10px;transform-origin:left center}#toast-container-top-center .toast{margin:10px 0 0;transform-origin:top}#toast-container-top-right .toast{margin:10px 10px 0 0;transform-origin:right center}#toast-container-bottom-left .toast{margin:0 0 10px 10px;transform-origin:left center}#toast-container-bottom-center .toast{margin:0 0 10px;transform-origin:bottom}#toast-container-bottom-right .toast{margin:0 10px 10px 0;transform-origin:right center}.toast{--toast-rate: 1;--toast-translate: 0;--toast-scale: 1;position:relative;transition:transform calc(.4s * var(--toast-rate)) cubic-bezier(.34,1.56,.64,1),opacity calc(.3s * var(--toast-rate)) ease,max-height calc(.3s * var(--toast-rate)) ease;transform:translate3d(0,var(--toast-translate),0) scale(var(--toast-scale));max-width:480px;max-height:0px;opacity:0;will-change:transform,opacity;backface-visibility:hidden;contain:content;border-radius:6px;box-shadow:0 4px 8px #00000040}.toast-close{position:absolute;color:var(--text);top:5px;right:5px;cursor:pointer;font-size:18px;font-weight:700;line-height:18px;z-index:2147483648;transform-origin:center center}.toast-content{border-radius:6px;padding:14px 18px;max-width:100%;box-sizing:border-box;background:var(--primary);color:var(--primary-text);cursor:pointer;white-space:normal;word-break:break-all;overflow:hidden;position:relative}.toast-progress{position:absolute;bottom:0;left:0;right:0;height:4px;background:#fffc;transform:scaleX(1);animation:toast-progress var(--toast-duration, 2s) linear forwards;will-change:transform;backface-visibility:hidden}@keyframes toast-progress{0%{transform:scaleX(1)}to{transform:scaleX(0)}}.toast:hover{z-index:2147483648;--toast-scale: 1.15}.toast-container.toast-left .toast .toast-content .toast-progress{transform-origin:left}.toast-container.toast-center .toast .toast-content .toast-progress{transform-origin:center}.toast-container.toast-right .toast .toast-content .toast-progress{transform-origin:right}.toast.show{opacity:1;max-height:var(--toast-height)}.toast.hide{opacity:0;max-height:0px}";
  var beautify_default = ".page-profile__content *>.col-6.col-sm-4.col-lg-3,.moreFromUser__item,.moreLikeThis__item{margin-bottom:2%}@media(max-width:720px){.page-videoList__item{padding:0 6px 0 2px!important}}.videoTeaser{display:flex;flex-direction:column;height:100%;border-radius:6px;border:2px solid color-mix(in srgb,var(--text) 20%,transparent);overflow:hidden;transition:background-color .2s ease,border-color .2s ease;background-color:var(--body-alt)}.videoTeaser:hover{background-color:color-mix(in srgb,var(--body-alt) 90%,var(--text))}.videoTeaser__content{display:flex;flex-direction:column;flex:1;padding:2%}.videoTeaser__title{padding-left:2%;padding-right:2%}.videoTeaser__bottom{margin-top:auto!important;height:auto!important;padding-bottom:2%;padding-left:2%;padding-right:2%}";
  var widescreen_default = ".container,.container-fluid{max-width:85%!important}.videoTeaser__title,.videoTeaser__byline{line-clamp:1!important;-webkit-line-clamp:1!important}@media(max-width:720px){.container,.container-fluid{max-width:100%!important}.videoTeaser__title,.videoTeaser__byline{line-clamp:2!important;-webkit-line-clamp:2!important}}";
  var ConvertibleNumber = Symbol("ConvertibleNumber");
  var PositiveInteger = Symbol("PositiveInteger");
  var NegativeInteger = Symbol("NegativeInteger");
  var PositiveFloat = Symbol("PositiveFloat");
  var NegativeFloat = Symbol("NegativeFloat");
  var emojiBase = String.raw`\p{Emoji}(?:\p{EMod}|[\u{E0020}-\u{E007E}]+\u{E007F}|\uFE0F?\u20E3?)`;
  var emojiRegex = new RegExp(String.raw`\p{RI}{2}|(?![#*\d](?!\uFE0F?\u20E3))${emojiBase}(?:\u200D${emojiBase})*`, "gu");
  var isNull = (obj) => obj === null;
  var isUndefined = (obj) => typeof obj === "undefined";
  var isNullOrUndefined = (obj) => isUndefined(obj) || isNull(obj);
  var isObject = (obj) => !isNullOrUndefined(obj) && typeof obj === "object" && !Array.isArray(obj);
  var isString = (obj) => !isNullOrUndefined(obj) && typeof obj === "string";
  var isNumber = (obj) => !isNullOrUndefined(obj) && typeof obj === "number";
  var isArray = (obj) => Array.isArray(obj);
  var isElement = (obj) => !isNullOrUndefined(obj) && obj instanceof Element;
  var isNode = (obj) => !isNullOrUndefined(obj) && obj instanceof Node;
  var isNotEmpty = (obj) => {
    if (isNullOrUndefined(obj)) {
      return false;
    }
    if (Array.isArray(obj)) {
      return obj.some(isNotEmpty);
    }
    if (isString(obj)) {
      return !obj.isEmpty();
    }
    if (isNumber(obj)) {
      return !Number.isNaN(obj);
    }
    if (isElement(obj) || isNode(obj)) {
      return true;
    }
    if (isObject(obj)) {
      return Object.values(obj).some(isNotEmpty);
    }
    return true;
  };
  var isVideoInfo = (obj) => {
    if (obj === null || typeof obj !== "object") return false;
    const info = obj;
    return isInitVideoInfo(info) || isFullVideoInfo(info) || isPartialVideoInfo(info) || isCacheVideoInfo(info) || isFailVideoInfo(info);
  };
  var hasValidID = (info) => isString(info.ID) && isNotEmpty(info.ID);
  var isInitVideoInfo = (info) => !isNullOrUndefined(info) && info.Type === "init" && hasValidID(info);
  var isFullVideoInfo = (info) => !isNullOrUndefined(info) && info.Type === "full" && hasValidID(info) && isNumber(info.UploadTime) && isString(info.Title) && isNotEmpty(info.Title) && isString(info.FileName) && isNotEmpty(info.FileName) && isNumber(info.Size) && isArray(info.Tags) && typeof info.Liked === "boolean" && typeof info.Following === "boolean" && typeof info.Friend === "boolean" && isString(info.Author) && isNotEmpty(info.Author) && isString(info.AuthorID) && isNotEmpty(info.AuthorID) && typeof info.Private === "boolean" && typeof info.Unlisted === "boolean" && isString(info.DownloadQuality) && typeof info.External === "boolean" && isString(info.DownloadUrl) && isNotEmpty(info.DownloadUrl) && isObject(info.RAW);
  var isPartialVideoInfo = (info) => !isNullOrUndefined(info) && info.Type === "partial" && hasValidID(info) && isNumber(info.UploadTime) && isString(info.Title) && isNotEmpty(info.Title) && isArray(info.Tags) && typeof info.Liked === "boolean" && isString(info.Author) && isNotEmpty(info.Author) && isString(info.AuthorID) && isNotEmpty(info.AuthorID) && typeof info.Private === "boolean" && typeof info.Unlisted === "boolean" && typeof info.External === "boolean" && isObject(info.RAW);
  var isCacheVideoInfo = (info) => !isNullOrUndefined(info) && info.Type === "cache" && hasValidID(info) && isObject(info.RAW);
  var isFailVideoInfo = (info) => !isNullOrUndefined(info) && info.Type === "fail" && hasValidID(info);
  var assertVideoInfoType = (info) => {
    switch (info.Type) {
      case "init":
        return info;
      case "full":
        return info;
      case "partial":
        return info;
      case "cache":
        return info;
      case "fail":
        return info;
      default:
        throw new Error(`未知的 VideoInfo 类型: ${info.Type}`);
    }
  };
  function isConvertibleToNumber(obj, includeInfinity = false) {
    if (isNullOrUndefined(obj)) {
      return false;
    }
    if (isString(obj)) {
      return obj.isConvertibleToNumber(includeInfinity);
    }
    if (isNumber(obj)) {
      return isNaN(obj) ? false : includeInfinity ? true : isFinite(obj);
    }
    return false;
  }
  Number.isConvertibleNumber = (value, includeInfinity = false) => {
    if (isNullOrUndefined(value)) {
      return false;
    }
    if (isString(value)) {
      return value.isConvertibleToNumber(includeInfinity);
    }
    if (isNumber(value)) {
      return isNaN(value) ? false : includeInfinity ? true : isFinite(value);
    }
    return false;
  };
  Number.isPositiveInteger = (value) => typeof value === "number" && Number.isInteger(value) && value > 0;
  Number.isNegativeInteger = (value) => typeof value === "number" && Number.isInteger(value) && value < 0;
  Number.isPositiveFloat = (value) => typeof value === "number" && !Number.isInteger(value) && value > 0;
  Number.isNegativeFloat = (value) => typeof value === "number" && !Number.isInteger(value) && value < 0;
  Number.toPositiveInteger = (value) => {
    if (!Number.isPositiveInteger(value)) {
      throw new Error("值必须为正整数");
    }
    return value;
  };
  Number.toNegativeInteger = (value) => {
    if (!Number.isNegativeInteger(value)) {
      throw new Error("值必须为负整数");
    }
    return value;
  };
  Number.toPositiveFloat = (value) => {
    if (!Number.isPositiveFloat(value)) {
      throw new Error("值必须为正浮点数");
    }
    return value;
  };
  Number.toNegativeFloat = (value) => {
    if (!Number.isNegativeFloat(value)) {
      throw new Error("值必须为负浮点数");
    }
    return value;
  };
  Array.prototype.any = function() {
    return this.filter((i) => !isNullOrUndefined(i)).length > 0;
  };
  Array.prototype.unique = function(prop) {
    if (isNullOrUndefined(prop)) {
      const seen = new Set();
      return this.filter((item) => {
        if (seen.has(item)) return false;
        seen.add(item);
        return true;
      });
    } else {
      const seen = new Map();
      const nanSymbol = Symbol();
      return this.filter((item) => {
        const rawKey = item[prop];
        const key = isNumber(rawKey) && Number.isNaN(rawKey) ? nanSymbol : rawKey;
        if (seen.has(key)) return false;
        seen.set(key, true);
        return true;
      });
    }
  };
  Array.prototype.union = function(that, prop) {
    return [...this, ...that].unique(prop);
  };
  Array.prototype.intersect = function(that, prop) {
    return this.filter(
      (item) => that.some((t) => isNullOrUndefined(prop) ? t === item : t[prop] === item[prop])
    ).unique(prop);
  };
  Array.prototype.difference = function(that, prop) {
    return this.filter(
      (item) => !that.some((t) => isNullOrUndefined(prop) ? t === item : t[prop] === item[prop])
    ).unique(prop);
  };
  Array.prototype.complement = function(that, prop) {
    return this.union(that, prop).difference(this.intersect(that, prop), prop);
  };
  String.prototype.isEmpty = function() {
    return !isNullOrUndefined(this) && this.length === 0;
  };
  String.prototype.isConvertibleToNumber = function(includeInfinity = false) {
    const trimmed = this.trim();
    if (trimmed === "") return false;
    return Number.isConvertibleNumber(Number(trimmed), includeInfinity);
  };
  String.prototype.reversed = function() {
    const segmenter = new Intl.Segmenter(navigator.language, { granularity: "grapheme" });
    return [...segmenter.segment(this.toString())].reverse().join("");
  };
  String.prototype.among = function(start, end, greedy = false, reverse = false) {
    if (this.isEmpty() || start.isEmpty() || end.isEmpty()) return "";
    if (!reverse) {
      const startIndex = this.indexOf(start);
      if (startIndex === -1) return "";
      const adjustedStartIndex = startIndex + start.length;
      const endIndex = greedy ? this.lastIndexOf(end) : this.indexOf(end, adjustedStartIndex);
      if (endIndex === -1 || endIndex < adjustedStartIndex) return "";
      return this.slice(adjustedStartIndex, endIndex);
    } else {
      const endIndex = this.lastIndexOf(end);
      if (endIndex === -1) return "";
      const adjustedEndIndex = endIndex - end.length;
      const startIndex = greedy ? this.indexOf(start) : this.lastIndexOf(start, adjustedEndIndex);
      if (startIndex === -1 || startIndex + start.length > adjustedEndIndex) return "";
      return this.slice(startIndex + start.length, endIndex);
    }
  };
  String.prototype.splitLimit = function(separator, limit) {
    if (this.isEmpty() || isNullOrUndefined(separator)) {
      throw new Error("Empty");
    }
    let body = this.split(separator);
    return limit ? body.slice(0, limit).concat(body.slice(limit).join(separator)) : body;
  };
  String.prototype.truncate = function(maxLength) {
    return this.length > maxLength ? this.substring(0, maxLength) : this.toString();
  };
  String.prototype.trimHead = function(prefix) {
    return this.startsWith(prefix) ? this.slice(prefix.length) : this.toString();
  };
  String.prototype.trimTail = function(suffix) {
    return this.endsWith(suffix) ? this.slice(0, -suffix.length) : this.toString();
  };
  String.prototype.replaceEmojis = function(replace) {
    return this.replaceAll(emojiRegex, replace ?? "");
  };
  String.prototype.toURL = function() {
    try {
      return new URL(this.toString());
    } catch (error) {
      if (error instanceof TypeError && this.toString().startsWith("//")) {
        return new URL(unsafeWindow.location.protocol + this.toString());
      }
      throw error;
    }
  };
  function throttle(fn, delay2, { leading = true, trailing = true } = {}) {
    let lastCall = 0;
    let timer = null;
    const throttled = function(...args) {
      const now = Date.now();
      if (!lastCall && !leading) {
        lastCall = now;
      }
      const remaining = delay2 - (now - lastCall);
      if (remaining <= 0) {
        if (timer) {
          clearTimeout(timer);
          timer = null;
        }
        lastCall = now;
        fn.apply(this, args);
      } else if (trailing && !timer) {
        timer = setTimeout(() => {
          lastCall = leading ? Date.now() : 0;
          timer = null;
          fn.apply(this, args);
        }, remaining);
      }
    };
    throttled.cancel = () => {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      lastCall = 0;
    };
    return throttled;
  }
  function debounce(fn, delay2, { immediate = false } = {}) {
    let timer = null;
    const debounced = function(...args) {
      const callNow = immediate && !timer;
      if (timer) {
        clearTimeout(timer);
      }
      timer = setTimeout(() => {
        timer = null;
        if (!immediate) {
          fn.apply(this, args);
        }
      }, delay2);
      if (callNow) {
        fn.apply(this, args);
      }
    };
    debounced.cancel = () => {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
    };
    return debounced;
  }
  function delay(time) {
    return new Promise((resolve) => setTimeout(resolve, time));
  }
  function hasProperty(element, property) {
    return property in element;
  }
  function hasOwnProperty(element, prop) {
    return prop in element;
  }
  function hasFunction(obj, method) {
    return isObject(obj) && method in obj && typeof obj[method] === "function";
  }
  ;
  function UUID() {
    return isNullOrUndefined(crypto) ? Array.from({ length: 8 }, () => ((1 + Math.random()) * 65536 | 0).toString(16).substring(1)).join("") : crypto.randomUUID().replaceAll("-", "");
  }
  function stringify(data) {
    switch (typeof data) {
      case "undefined":
        return "undefined";
      case "boolean":
        return data ? "true" : "false";
      case "number":
        return String(data);
      case "string":
        return data;
      case "symbol":
        return data.toString();
      case "function":
        return data.toString();
      case "object":
        if (isNull(data)) {
          return "null";
        }
        if (data instanceof Error) {
          return data.toString();
        }
        if (data instanceof Date) {
          return data.toISOString();
        }
        return JSON.stringify(data, null, 2);
      default:
        return "unknown";
    }
  }
  function prune(data) {
    if (isElement(data) || isNode(data)) {
      return data;
    }
    if (Array.isArray(data)) {
      return data.map((item) => prune(item)).filter(isNotEmpty);
    }
    if (isObject(data)) {
      const result = Object.fromEntries(
        Object.entries(data).filter(([, v2]) => isNotEmpty(v2)).map(([k2, v2]) => [k2, prune(v2)]).filter(([, v2]) => isNotEmpty(v2))
      );
      return result;
    }
    return data;
  }
  String.prototype.replaceVariable = function(replacements, prefix = "%#", suffix = "#%") {
    function escapeRegex(str) {
      return str.replace(/[\.\*\+\?\^\$\{\}\(\)\|\[\]\\]/g, "\\$&");
    }
    let current = this.toString();
    prefix = escapeRegex(prefix);
    suffix = escapeRegex(suffix);
    const seen = new Set();
    const patterns = Object.keys(replacements).map((key) => {
      const escKey = escapeRegex(key);
      return {
        value: replacements[key],
        placeholderRegex: new RegExp(`${prefix}${escKey}(?=(?::.*?${suffix}|${suffix}))(?::.*?)?${suffix}`, "gs"),
        placeholderFormatRegex: new RegExp(`(?<=${prefix}${escKey}(?=(?::.*?${suffix}|${suffix})):).*?(?=${suffix})`, "gs")
      };
    });
    while (true) {
      if (seen.has(current)) {
        console.warn("检测到循环替换！", `终止于: ${current}`);
        break;
      }
      seen.add(current);
      let next = current;
      for (const { value, placeholderRegex, placeholderFormatRegex } of patterns) {
        if (placeholderRegex.test(next)) {
          let format = next.match(placeholderFormatRegex);
          if (!isNullOrUndefined(format) && format.any() && !format[0].isEmpty() && hasFunction(value, "format")) {
            next = next.replace(placeholderRegex, stringify(value.format(format[0])));
          } else {
            next = next.replace(placeholderRegex, stringify(value instanceof Date ? value.format("YYYY-MM-DD") : value));
          }
        }
      }
      if (current === next) break;
      current = next;
    }
    return current;
  };
  var en_default = {
    appName: "Iwara Download Tool",
    language: "Language: ",
    downloadPriority: "Download Quality: ",
    downloadPath: "Download Path: ",
    downloadProxy: "Download Proxy: ",
    downloadProxyUsername: "Download Proxy Username: ",
    downloadProxyPassword: "Download Proxy Password: ",
    aria2Path: "Aria2 RPC: ",
    aria2Token: "Aria2 Token: ",
    iwaradlPath: "iwaradl RPC: ",
    iwaradlToken: "iwaradl Token: ",
    mediaCenterApi: "MediaCenter API: ",
    mediaCenterApiKey: "MediaCenter API Key: ",
    mediaCenterInfo: "→ MediaCenter ←",
    experimentalFeatures: "Experimental Features",
    enableUnsafeMode: "Unsafe Mode (Use at your own risk)",
    enableBeautify: "Beautify",
    enableWidescreen: "Widescreen Adaptation",
    save: "Save",
    reset: "Reset",
    ok: "OK",
    delete: "Delete",
    deleteSucceed: "Deletion successful!",
    isDebug: "Debug Mode",
    downloadType: "Download Type",
    browserDownload: "Browser Download",
    iwaradlDownload: "iwaradl Download",
    autoFollow: "Automatically follow the selected video author",
    autoLike: "Automatically like the selected videos",
    addUnlistedAndPrivate: "Force display unlisted and private videos (requires following the author)",
    filterUnlistedAndPrivate: "Filter unlisted and private videos on subscriptions page (mutually exclusive with force display)",
    autoCollapseMenu: "Auto Collapse Menu",
    checkDownloadLink: "Check third-party cloud storage download links",
    checkPriority: "Check download quality",
    autoDownloadMetadata: "Auto-download metadata",
    filterLikedVideos: "Filter liked videos on timeline",
    videoMetadata: "Video Metadata",
    autoInjectCheckbox: "Automatically inject selection box",
    autoCopySaveFileName: "Automatically copy the filename generated by rules",
    configurationIncompatible: "Initialization or configuration file incompatible, please reconfigure!",
    browserDownloadNotEnabled: "Download feature not enabled!",
    browserDownloadNotWhitelisted: "Requested file extension not whitelisted!",
    browserDownloadNotPermitted: "Download feature enabled, but permission not granted!",
    browserDownloadNotSupported: "Current browser/version does not support download functionality!",
    browserDownloadNotSucceeded: "Download did not start or failed!",
    browserDownloadUnknownError: "Unknown error, possibly due to invalid download parameters. Please check if the filename is valid!",
    browserDownloadTimeout: "Download timed out. Please check your network connection!",
    variable: "View available variables",
    iwaradlLink: "→ iwaradl Official Website ←",
    settings: "Open Settings",
    downloadThis: "Download current video",
    manualDownload: "Manual Download",
    aria2TaskCheck: "Aria2 Task Restart",
    reverseSelect: "Reverse selection on this page",
    deselectThis: "Deselect on this page",
    deselectAll: "Deselect all",
    selectThis: "Select all on this page",
    selected: "Selected",
    downloadSelected: "Download selected",
    injectCheckbox: "Toggle selection box",
    configError: "There is an error in the script configuration. Please modify.",
    alreadyKnowHowToUse: "I already know how to use it!!!",
    notice: [
      "Loading Complete"
    ],
    useHelpForBase: [
      "Please read the usage guide carefully!",
      {
        nodeType: "br"
      },
      "Click the gray sidebar on the webpage to expand the script menu, then click the functions in the menu according to your needs."
    ],
    useHelpForInjectCheckbox: "Open any page with video cards, and the script will inject checkboxes on the video cards. Click the checkbox or hover over the video card and press space to select this video.",
    useHelpForCheckDownloadLink: 'Enabling "%#checkDownloadLink#%" will check the video description and comments before downloading. If third-party cloud storage links are found, a prompt will appear allowing you to visit the video page.',
    useHelpForManualDownload: [
      'To use manual download, provide the video ID. For batch manual download, use "|" to separate video IDs.',
      {
        nodeType: "br"
      },
      "Example: AeGUIRO2D5vQ6F|qQsUMJa19LcK3L"
    ],
    useHelpForBugreport: [
      "To report bugs or usage issues, please visit: ",
      {
        nodeType: "a",
        childs: "Github",
        attributes: {
          href: "https://github.com/IwaraEnhance/IwaraDownloadTool/"
        }
      }
    ],
    tryRestartingDownload: "→ Click here to restart download ←",
    tryReparseDownload: "→ Click here to reparse ←",
    openVideoLink: "→ Visit Video Page ←",
    queueYoutubeDownload: "→ Download this YouTube video locally ←",
    youtubeDownloadQueued: "YouTube video added to the local download queue",
    youtubeDownloadAlreadyQueued: "This YouTube video is already queued or downloaded",
    youtubeDownloadQueueFailed: "Local YouTube download could not be queued:",
    copySucceed: "Copy succeeded!",
    pushTaskSucceed: "Task pushed successfully!",
    exportConfig: "Export Configuration",
    importConfig: "Import Configuration",
    exportConfigSucceed: "Configuration exported to clipboard!",
    importConfigFail: "Configuration import failed!",
    connectionTest: "Connection Test",
    settingsCheck: "Settings Check",
    createTask: "Create Task",
    downloadPathError: "Download path error!",
    browserDownloadModeError: "Please enable the browser API download mode in the script manager!",
    downloadQualityError: "Specified quality download URL not found!",
    findedDownloadLink: "Possible third-party cloud storage link found!",
    allCompleted: "All parsing completed!",
    following: "Following",
    downloaded: "Downloaded",
    parsingProgress: "Parsing Progress: ",
    manualDownloadTips: 'For individual downloads, input the video ID here. For batch downloads, separate video IDs with "|". Example: AeGUIRO2D5vQ6F|qQsUMJa19LcK3L',
    noAvailableVideoSource: "No available video sources",
    videoSourceNotAvailable: "Video source URL unavailable",
    getVideoSourceFailed: "Failed to get video source",
    downloadFailed: "Download failed!",
    pushTaskFailed: "Failed to push download task!",
    parsingFailed: "Failed to parse video information!",
    autoFollowFailed: "Failed to auto-follow the video author!",
    autoLikeFailed: "Failed to auto-like the video!",
    aria2TaskRestartError: "An error occurred while reading or analyzing download tasks that need to be restarted!",
    noAria2TasksNeedRestart: "No download tasks found that need to be restarted!",
    duplicateTaskAnalysisError: "An error occurred while analyzing duplicate download tasks!"
  };
  var ja_default = {
    appName: "Iwara バッチダウンロードツール",
    language: "言語: ",
    downloadPriority: "ダウンロード画質: ",
    downloadPath: "ダウンロード先: ",
    downloadProxy: "ダウンロードプロキシ: ",
    downloadProxyUsername: "ダウンロードプロキシユーザー名: ",
    downloadProxyPassword: "ダウンロードプロキシパスワード: ",
    aria2Path: "Aria2 RPC: ",
    aria2Token: "Aria2 トークン: ",
    iwaradlPath: "iwaradl RPC: ",
    iwaradlToken: "iwaradl トークン: ",
    mediaCenterApi: "MediaCenter API: ",
    mediaCenterApiKey: "MediaCenter API キー: ",
    mediaCenterInfo: "→ MediaCenter ←",
    experimentalFeatures: "実験的機能",
    enableUnsafeMode: "アンセーフモード（自己責任で使用）",
    enableBeautify: "美化",
    enableWidescreen: "ワイドスクリーン適応",
    save: "保存",
    reset: "リセット",
    ok: "OK",
    delete: "削除",
    deleteSucceed: "削除成功！",
    isDebug: "デバッグモード",
    downloadType: "ダウンロード方式",
    browserDownload: "ブラウザダウンロード",
    iwaradlDownload: "iwaradlダウンロード",
    autoFollow: "選択した動画の作者を自動フォロー",
    autoLike: "選択した動画を自動いいね",
    addUnlistedAndPrivate: "非公開・限定公開動画を強制表示（作者のフォローが必要）",
    filterUnlistedAndPrivate: "購読ページの非公開・限定公開動画をフィルタリング（強制表示とは排他）",
    autoCollapseMenu: "メニューを自動で折りたたむ",
    checkDownloadLink: "サードパーティクラウドストレージのダウンロードリンクをチェック",
    checkPriority: "ダウンロード画質チェック",
    autoDownloadMetadata: "動画メタデータを自動ダウンロード",
    filterLikedVideos: "タイムライン上のいいね済み動画をフィルタリング",
    videoMetadata: "動画メタデータ",
    autoInjectCheckbox: "選択ボックスを自動注入",
    autoCopySaveFileName: "ルールに基づいて生成されたファイル名を自動コピー",
    configurationIncompatible: "初期化または設定ファイルが互換性がありません。再設定してください！",
    browserDownloadNotEnabled: "ダウンロード機能が有効になっていません！",
    browserDownloadNotWhitelisted: "要求されたファイル拡張子がホワイトリストに登録されていません！",
    browserDownloadNotPermitted: "ダウンロード機能は有効ですが、権限が付与されていません！",
    browserDownloadNotSupported: "現在のブラウザ/バージョンはダウンロード機能をサポートしていません！",
    browserDownloadNotSucceeded: "ダウンロードが開始されなかったか失敗しました！",
    browserDownloadUnknownError: "不明なエラー。ダウンロード時に提供されたパラメータに問題がある可能性があります。ファイル名が有効か確認してください！",
    browserDownloadTimeout: "ダウンロードがタイムアウトしました。ネットワーク環境を確認してください！",
    variable: "→ 利用可能な変数を表示 ←",
    iwaradlLink: "→ iwaradl 公式サイト ←",
    settings: "設定を開く",
    downloadThis: "現在の動画をダウンロード",
    manualDownload: "手動ダウンロード",
    aria2TaskCheck: "Aria2タスク再起動",
    reverseSelect: "このページで選択を反転",
    deselectThis: "このページの選択を解除",
    deselectAll: "すべての選択を解除",
    selectThis: "このページをすべて選択",
    selected: "選択済み",
    downloadSelected: "選択したものをダウンロード",
    injectCheckbox: "選択ボックスを切り替え",
    configError: "スクリプト設定にエラーがあります。修正してください。",
    alreadyKnowHowToUse: "使用方法を理解しました!!!（このページは一度だけ表示されます）",
    notice: [
      "読み込み完了"
    ],
    useHelpForBase: [
      "使用ガイドをよくお読みください！",
      {
        nodeType: "br"
      },
      "ウェブページのサイドにある灰色のサイドバーをクリックしてスクリプトメニューを展開し、必要に応じてメニューの機能をクリックしてください。"
    ],
    useHelpForInjectCheckbox: "動画カードがある任意のページを開くと、スクリプトは動画カードにチェックボックスを注入します。チェックボックスをクリックするか、動画カードにマウスをホバーしてスペースキーを押すと、この動画が選択されます。",
    useHelpForCheckDownloadLink: '"%#checkDownloadLink#%"機能を有効にすると、動画をダウンロードする前に動画の説明とコメントをチェックします。サードパーティクラウドストレージのダウンロードリンクが見つかった場合、プロンプトが表示され、動画ページを開くことができます。',
    useHelpForManualDownload: [
      "手動ダウンロード機能を使用するには、動画IDを提供する必要があります。バッチ手動ダウンロードの場合は、「|」で区切った動画IDを提供してください。",
      {
        nodeType: "br"
      },
      "例: AeGUIRO2D5vQ6F|qQsUMJa19LcK3L"
    ],
    useHelpForBugreport: [
      "バグや使用上の問題を報告する場合は、以下にアクセスしてください: ",
      {
        nodeType: "a",
        childs: "Github",
        attributes: {
          href: "https://github.com/IwaraEnhance/IwaraDownloadTool/"
        }
      }
    ],
    tryRestartingDownload: "→ ここをクリックしてダウンロードを再開 ←",
    tryReparseDownload: "→ ここをクリックして再解析 ←",
    openVideoLink: "→ 動画ページへ ←",
    queueYoutubeDownload: "→ この YouTube 動画をローカルにダウンロード ←",
    youtubeDownloadQueued: "YouTube 動画をローカルダウンロードキューに追加しました",
    youtubeDownloadAlreadyQueued: "この YouTube 動画は既にキューにあるか、ダウンロード済みです",
    youtubeDownloadQueueFailed: "ローカル YouTube ダウンロードを登録できませんでした：",
    copySucceed: "コピー成功！",
    pushTaskSucceed: "ダウンロードタスクのプッシュ成功！",
    exportConfig: "設定をエクスポート",
    importConfig: "設定をインポート",
    exportConfigSucceed: "設定がクリップボードにエクスポートされました！",
    importConfigFail: "設定のインポートに失敗しました！",
    connectionTest: "接続テスト",
    settingsCheck: "設定チェック",
    createTask: "タスク作成",
    downloadPathError: "ダウンロードパスエラー！",
    browserDownloadModeError: "スクリプトマネージャーのブラウザAPIダウンロードモードを有効にしてください！",
    downloadQualityError: "指定された画質のダウンロードURLが見つかりません！",
    findedDownloadLink: "サードパーティクラウドストレージのダウンロードリンクを発見！",
    allCompleted: "すべての解析完了！",
    following: "フォロー中",
    downloaded: "ダウンロード済み",
    parsingProgress: "解析進捗: ",
    manualDownloadTips: "個別ダウンロードはここに動画IDを直接入力してください。バッチダウンロードは「|」で区切った動画IDを提供してください。例: AeGUIRO2D5vQ6F|qQsUMJa19LcK3L",
    noAvailableVideoSource: "利用可能な動画ソースがありません",
    videoSourceNotAvailable: "動画ソースURLが利用できません",
    getVideoSourceFailed: "動画ソースの取得に失敗しました",
    downloadFailed: "ダウンロード失敗！",
    pushTaskFailed: "ダウンロードタスクのプッシュに失敗！",
    parsingFailed: "動画情報の解析に失敗！",
    autoFollowFailed: "動画作者の自動フォローに失敗！",
    autoLikeFailed: "動画の自動いいねに失敗！",
    aria2TaskRestartError: "再起動が必要なダウンロードタスクの読み取りまたは分析中にエラーが発生しました！",
    noAria2TasksNeedRestart: "再起動が必要なダウンロードタスクは見つかりませんでした！",
    duplicateTaskAnalysisError: "重複したダウンロードタスクの分析中にエラーが発生しました！"
  };
  var zh_cn_default = {
    appName: "Iwara 批量下载工具",
    language: "语言: ",
    downloadPriority: "下载画质: ",
    downloadPath: "下载到: ",
    downloadProxy: "下载代理: ",
    downloadProxyUsername: "下载代理用户名: ",
    downloadProxyPassword: "下载代理密码: ",
    aria2Path: "Aria2 RPC: ",
    aria2Token: "Aria2 密钥: ",
    iwaradlPath: "iwaradl RPC: ",
    iwaradlToken: "iwaradl 密钥: ",
    mediaCenterApi: "MediaCenter API: ",
    mediaCenterApiKey: "MediaCenter API 密钥: ",
    mediaCenterInfo: "→ MediaCenter项目 ←",
    experimentalFeatures: "实验性功能",
    enableUnsafeMode: "激进模式（风险自行承担）",
    enableBeautify: "美化",
    enableWidescreen: "宽屏适配",
    save: "保存",
    reset: "重置",
    ok: "确定",
    delete: "删除",
    deleteSucceed: "删除成功！",
    isDebug: "调试模式",
    downloadType: "下载方式",
    browserDownload: "浏览器下载",
    iwaradlDownload: "iwaradl下载",
    autoFollow: "自动关注选中的视频作者",
    autoLike: "自动点赞选中的视频",
    addUnlistedAndPrivate: "不公开和私有视频强制显示(需关注作者)",
    filterUnlistedAndPrivate: "过滤订阅页中的不公开和私有视频(与强制显示互斥)",
    autoCollapseMenu: "菜单自动收起",
    checkDownloadLink: "第三方网盘下载地址检查",
    checkPriority: "下载画质检查",
    autoDownloadMetadata: "自动下载视频元数据",
    filterLikedVideos: "过滤时间线上的已喜欢视频",
    videoMetadata: "视频元数据",
    autoInjectCheckbox: "自动注入选择框",
    autoCopySaveFileName: "自动复制根据规则生成的文件名",
    configurationIncompatible: "初始化或配置文件不兼容，请重新配置！",
    browserDownloadNotEnabled: "未启用下载功能！",
    browserDownloadNotWhitelisted: "请求的文件扩展名未列入白名单！",
    browserDownloadNotPermitted: "下载功能已启用，但未授予下载权限！",
    browserDownloadNotSupported: "目前浏览器/版本不支持下载功能！",
    browserDownloadNotSucceeded: "下载未开始或失败！",
    browserDownloadUnknownError: "未知错误，有可能是下载时提供的参数存在问题，请检查文件名是否合法！",
    browserDownloadTimeout: "下载超时，请检查网络环境是否正常！",
    variable: "→ 查看可用变量 ←",
    iwaradlLink: "→ iwaradl 官网 ←",
    settings: "打开设置",
    downloadThis: "下载当前视频",
    manualDownload: "手动下载",
    aria2TaskCheck: "Aria2任务重启",
    reverseSelect: "本页反向选中",
    deselectThis: "取消本页选中",
    deselectAll: "取消所有选中",
    selectThis: "本页全部选中",
    downloadSelected: "下载所选",
    selected: "已选中",
    injectCheckbox: "开关选择框",
    configError: "脚本配置中存在错误，请修改。",
    alreadyKnowHowToUse: "我已知晓如何使用!!!（此页面仅显示一次）",
    notice: [
      "加载完成"
    ],
    useHelpForBase: [
      "请认真阅读使用指南！",
      {
        nodeType: "br"
      },
      "点击网页侧边的灰色侧栏展开脚本菜单，根据需求点击菜单中的功能。"
    ],
    useHelpForInjectCheckbox: "打开任意存在视频卡片的页面，脚本会在视频卡片上注入复选框，点击复选框或鼠标悬浮在视频卡片上按空格将会勾选此视频。",
    useHelpForCheckDownloadLink: "开启“%#checkDownloadLink#%”功能会在下载视频前会检查视频简介以及评论，如果在其中发现疑似第三方网盘下载链接，将会弹出提示，您可以点击提示打开视频页面。",
    useHelpForManualDownload: [
      "使用手动下载功能需要提供视频ID，如需批量手动下载请提供使用“|”分割的视频ID。",
      {
        nodeType: "br"
      },
      "例如: AeGUIRO2D5vQ6F|qQsUMJa19LcK3L"
    ],
    useHelpForBugreport: [
      "反馈遇到的BUG、使用问题等请前往: ",
      {
        nodeType: "a",
        childs: "Github",
        attributes: {
          href: "https://github.com/IwaraEnhance/IwaraDownloadTool/"
        }
      }
    ],
    tryRestartingDownload: "→ 点击此处重新下载 ←",
    tryReparseDownload: "→ 点击此处重新解析 ←",
    openVideoLink: "→ 进入视频页面 ←",
    queueYoutubeDownload: "→ 点击使用本机下载 YouTube 视频 ←",
    youtubeDownloadQueued: "YouTube 视频已加入本机下载队列",
    youtubeDownloadAlreadyQueued: "这个 YouTube 视频已经在队列中或已下载",
    youtubeDownloadQueueFailed: "无法加入本机 YouTube 下载队列：",
    copySucceed: "复制成功！",
    pushTaskSucceed: "推送下载任务成功",
    pushTaskFail: "推送下载任务失败",
    exportConfig: "导出配置",
    importConfig: "导入配置",
    exportConfigSucceed: "配置已导出至剪切板！",
    importConfigFail: "配置导入失败！",
    connectionTest: "连接测试",
    settingsCheck: "配置检查",
    createTask: "创建任务",
    downloadPathError: "下载路径错误!",
    browserDownloadModeError: "请启用脚本管理器的浏览器API下载模式!",
    downloadQualityError: "未找到指定的画质下载地址!",
    findedDownloadLink: "发现疑似第三方网盘下载地址!",
    allCompleted: "全部解析完成！",
    following: "已关注",
    downloaded: "已下载",
    parsingProgress: "解析进度: ",
    manualDownloadTips: "单独下载请直接在此处输入视频ID, 批量下载请提供使用“|”分割的视频ID, 例如: AeGUIRO2D5vQ6F|qQsUMJa19LcK3L",
    noAvailableVideoSource: "没有可供下载的视频源",
    videoSourceNotAvailable: "视频源地址不可用",
    getVideoSourceFailed: "获取视频源失败",
    downloadFailed: "下载失败！",
    pushTaskFailed: "推送下载任务失败！",
    parsingFailed: "视频信息解析失败！",
    autoFollowFailed: "自动关注视频作者失败！",
    autoLikeFailed: "自动点赞视频失败！",
    aria2TaskRestartError: "读取或分析需要重启的下载任务时出现错误！",
    noAria2TasksNeedRestart: "未发现需要重启的下载任务！",
    duplicateTaskAnalysisError: "分析重复的的下载任务时出现错误！"
  };
  var i18nList = {
    en: en_default,
    ja: ja_default,
    zh: zh_cn_default
  };
  var originalFetch = unsafeWindow.fetch;
  var originalHistoryPushState = unsafeWindow.history.pushState;
  var originalHistoryReplaceState = unsafeWindow.history.replaceState;
  var originalNodeAppendChild = unsafeWindow.Node.prototype.appendChild;
  var originalNodeRemoveChild = unsafeWindow.Node.prototype.removeChild;
  var originalElementRemove = unsafeWindow.Element.prototype.remove;
  var originalAddEventListener = unsafeWindow.EventTarget.prototype.addEventListener;
  var originalRemoveEventListener = unsafeWindow.EventTarget.prototype.removeEventListener;
  var originalStorageSetItem = unsafeWindow.Storage.prototype.setItem;
  var originalStorageRemoveItem = unsafeWindow.Storage.prototype.removeItem;
  var originalStorageClear = unsafeWindow.Storage.prototype.clear;
  var originalConsole = {
    log: unsafeWindow.console.log.bind(unsafeWindow.console),
    info: unsafeWindow.console.info.bind(unsafeWindow.console),
    warn: unsafeWindow.console.warn.bind(unsafeWindow.console),
    error: unsafeWindow.console.error.bind(unsafeWindow.console),
    debug: unsafeWindow.console.debug.bind(unsafeWindow.console),
    trace: unsafeWindow.console.trace.bind(unsafeWindow.console),
    dir: unsafeWindow.console.dir.bind(unsafeWindow.console),
    table: unsafeWindow.console.table?.bind(unsafeWindow.console)
  };
  var DownloadType = ((DownloadType2) => {
    DownloadType2[DownloadType2["Aria2"] = 0] = "Aria2";
    DownloadType2[DownloadType2["Iwaradl"] = 1] = "Iwaradl";
    DownloadType2[DownloadType2["Browser"] = 2] = "Browser";
    DownloadType2[DownloadType2["Others"] = 3] = "Others";
    return DownloadType2;
  })(DownloadType || {});
  var PageType = ((PageType2) => {
    PageType2["Video"] = "video";
    PageType2["Image"] = "image";
    PageType2["VideoList"] = "videoList";
    PageType2["ImageList"] = "imageList";
    PageType2["Forum"] = "forum";
    PageType2["ForumSection"] = "forumSection";
    PageType2["ForumThread"] = "forumThread";
    PageType2["Page"] = "page";
    PageType2["Home"] = "home";
    PageType2["Profile"] = "profile";
    PageType2["Subscriptions"] = "subscriptions";
    PageType2["Playlist"] = "playlist";
    PageType2["Favorites"] = "favorites";
    PageType2["Search"] = "search";
    PageType2["Account"] = "account";
    return PageType2;
  })(PageType || {});
  var ToastType = ((ToastType2) => {
    ToastType2[ToastType2["Log"] = 0] = "Log";
    ToastType2[ToastType2["Info"] = 1] = "Info";
    ToastType2[ToastType2["Warn"] = 2] = "Warn";
    ToastType2[ToastType2["Error"] = 3] = "Error";
    return ToastType2;
  })(ToastType || {});
  var MessageType = ((MessageType2) => {
    MessageType2[MessageType2["Close"] = 0] = "Close";
    MessageType2[MessageType2["Request"] = 1] = "Request";
    MessageType2[MessageType2["Receive"] = 2] = "Receive";
    MessageType2[MessageType2["Set"] = 3] = "Set";
    MessageType2[MessageType2["Del"] = 4] = "Del";
    return MessageType2;
  })(MessageType || {});
  var VersionState = ((VersionState2) => {
    VersionState2[VersionState2["Low"] = 0] = "Low";
    VersionState2[VersionState2["Equal"] = 1] = "Equal";
    VersionState2[VersionState2["High"] = 2] = "High";
    return VersionState2;
  })(VersionState || {});
  var DEFAULT_CONFIG = {
    language: "zh",
    autoFollow: false,
    autoLike: false,
    autoCopySaveFileName: false,
    autoDownloadMetadata: false,
    enableUnsafeMode: false,
    enableBeautify: false,
    enableWidescreen: false,
    experimentalFeatures: false,
    autoInjectCheckbox: true,
    checkDownloadLink: false,
    filterLikedVideos: false,
    checkPriority: true,
    addUnlistedAndPrivate: false,
    filterUnlistedAndPrivate: false,
    autoCollapseMenu: true,
    downloadPriority: "Source",
    downloadType: 3,
    downloadPath: "/Iwara/%#AUTHOR#%/%#TITLE#%[%#ID#%].mp4",
    downloadProxy: "",
    downloadProxyUsername: "",
    downloadProxyPassword: "",
    aria2Path: "http://127.0.0.1:6800/jsonrpc",
    aria2Token: "",
    iwaradlPath: "http://127.0.0.1:23456/api/tasks",
    iwaradlToken: "",
    mediaCenterApi: "http://127.0.0.1:3000",
    mediaCenterApiKey: "",
    priority: {
      "Source": 100,
      "540": 99,
      "360": 98,
      "preview": 1
    }
  };
  var Config = class _Config {
    static instance;
    configChange;
    authorization;
    language = DEFAULT_CONFIG.language;
    autoFollow = DEFAULT_CONFIG.autoFollow;
    autoLike = DEFAULT_CONFIG.autoLike;
    autoDownloadMetadata = DEFAULT_CONFIG.autoDownloadMetadata;
    addUnlistedAndPrivate = DEFAULT_CONFIG.addUnlistedAndPrivate;
    filterUnlistedAndPrivate = DEFAULT_CONFIG.filterUnlistedAndPrivate;
    autoCollapseMenu = DEFAULT_CONFIG.autoCollapseMenu;
    enableUnsafeMode = DEFAULT_CONFIG.enableUnsafeMode;
    enableBeautify = DEFAULT_CONFIG.enableBeautify;
    enableWidescreen = DEFAULT_CONFIG.enableWidescreen;
    experimentalFeatures = DEFAULT_CONFIG.experimentalFeatures;
    autoInjectCheckbox = DEFAULT_CONFIG.autoInjectCheckbox;
    autoCopySaveFileName = DEFAULT_CONFIG.autoCopySaveFileName;
    filterLikedVideos = DEFAULT_CONFIG.filterLikedVideos;
    checkDownloadLink = DEFAULT_CONFIG.checkDownloadLink;
    checkPriority = DEFAULT_CONFIG.checkPriority;
    downloadPriority = DEFAULT_CONFIG.downloadPriority;
    downloadType = DEFAULT_CONFIG.downloadType;
    downloadPath = DEFAULT_CONFIG.downloadPath;
    downloadProxy = DEFAULT_CONFIG.downloadProxy;
    downloadProxyUsername = DEFAULT_CONFIG.downloadProxyUsername;
    downloadProxyPassword = DEFAULT_CONFIG.downloadProxyPassword;
    aria2Path = DEFAULT_CONFIG.aria2Path;
    aria2Token = DEFAULT_CONFIG.aria2Token;
    iwaradlPath = DEFAULT_CONFIG.iwaradlPath;
    iwaradlToken = DEFAULT_CONFIG.iwaradlToken;
    mediaCenterApi = DEFAULT_CONFIG.mediaCenterApi;
    mediaCenterApiKey = DEFAULT_CONFIG.mediaCenterApiKey;
    priority = DEFAULT_CONFIG.priority;
    constructor(importConfig2) {
      let body = new Proxy(this, {
        get: function(target, property) {
          if (property === "configChange") {
            return target.configChange;
          }
          let value = GM_getValue(property, target[property]);
          if (property === "language") {
            return _Config.getLanguage(value);
          }
          GM_getValue("isDebug") && originalConsole.debug(`[Debug] get: ${property} ${/password/i.test(property) || /token/i.test(property) || /authorization/i.test(property) ? "凭证已隐藏" : stringify(value)}`);
          return value;
        },
        set: function(target, property, value) {
          if (property === "configChange") {
            target.configChange = value;
            return true;
          }
          GM_setValue(property, value);
          GM_getValue("isDebug") && originalConsole.debug(`[Debug] set: ${property} ${/password/i.test(property) || /token/i.test(property) || /authorization/i.test(property) ? "凭证已隐藏" : stringify(value)}`);
          if (!isNullOrUndefined(target.configChange)) target.configChange(property);
          return true;
        }
      });
      for (const key of Object.keys(DEFAULT_CONFIG)) {
        GM_addValueChangeListener(
          key,
          (name, old_value, new_value, remote) => {
            if (remote && !isNullOrUndefined(body.configChange)) body.configChange(name);
          }
        );
      }
      if (!isNullOrUndefined(importConfig2)) {
        Object.assign(body, importConfig2);
      }
      return body;
    }
    static getInstance() {
      if (isNullOrUndefined(_Config.instance)) _Config.instance = new _Config();
      return _Config.instance;
    }
    static destroyInstance() {
      _Config.instance = void 0;
    }
    static initInstance(importConfig2) {
      _Config.instance = new _Config(importConfig2 ?? DEFAULT_CONFIG);
    }
    static resolveLanguage(lang) {
      const normalized = lang.replace("-", "_").toLowerCase();
      if (i18nList[normalized]) return normalized;
      const main2 = normalized.split("_")[0];
      if (i18nList[main2]) return main2;
      return void 0;
    }
    static getLanguage(value) {
      const candidates = [value, navigator.language, ...navigator.languages ?? []];
      for (const lang of candidates) {
        if (!lang) continue;
        const resolved = _Config.resolveLanguage(lang);
        if (resolved) return resolved;
      }
      return DEFAULT_CONFIG.language;
    }
  };
  var config = Config.getInstance();
  var Path = class {
    fullPath;
    directory;
    fullName;
    type;
    extension;
    baseName;
    constructor(input, validate = true) {
      if (input === "") {
        throw new Error("路径不能为空");
      }
      if (this.isUNC(input)) {
        throw new Error("不接受UNC路径");
      }
      const detectedType = this.detectPathType(input);
      if (validate) this.validatePath(input, detectedType);
      const normalized = this.normalizePath(input, detectedType);
      const directory = this.extractDirectory(normalized, detectedType);
      const fileName = this.extractFileName(normalized, detectedType);
      const { baseName, extension } = this.extractBaseAndExtension(fileName);
      this.type = detectedType;
      this.fullPath = normalized;
      this.directory = directory;
      this.fullName = fileName;
      this.baseName = baseName;
      this.extension = extension;
    }
    isUNC(path) {
      return path.startsWith("\\\\");
    }
    detectPathType(path) {
      if (/^[A-Za-z]:[\\/]/.test(path)) {
        return "Windows";
      }
      if (path.startsWith("/")) {
        return "Unix";
      }
      return "Relative";
    }
    validatePath(path, type) {
      const invalidChars = /[<>:"|?*]/;
      if (type === "Windows") {
        if (!/^[A-Za-z]:[\\/]/.test(path)) {
          throw new Error("无效的Windows路径格式");
        }
        const segments = path.split(/[\\/]/);
        for (let i = 1; i < segments.length; i++) {
          let segment = segments[i];
          let variables = [...segment.matchAll(/%#(.*?)#%/g)].map((match) => {
            let variable = match[1].split(":");
            if (variable.length > 1) {
              if (invalidChars.test(variable[1])) {
                throw new Error(`路径变量格式化参数 "${variable[1]}" 含有非法字符`);
              }
            }
            return match[1];
          });
          for (let index = 0; index < variables.length; index++) {
            const variable = variables[index];
            segment = segment.replaceAll(variable, "");
          }
          if (invalidChars.test(segment)) {
            throw new Error(`路径段 "${segments[i]}" 含有非法字符`);
          }
        }
      } else if (type === "Unix") {
        if (path.indexOf("\0") !== -1) {
          throw new Error("路径中包含非法空字符");
        }
      } else if (type === "Relative") {
        if (path.indexOf("\0") !== -1) {
          throw new Error("路径中包含非法空字符");
        }
        if (invalidChars.test(path)) {
          throw new Error("路径含有非法字符");
        }
      }
    }
    normalizePath(path, type) {
      const sep = type === "Windows" ? "\\" : "/";
      if (type === "Windows") {
        path = path.replace(/\//g, "\\");
        path = path.replace(/\\+/g, "\\");
      } else {
        path = path.replace(/\\/g, "/");
        path = path.replace(/\/+/g, "/");
      }
      let segments;
      if (type === "Windows") {
        segments = path.split("\\");
      } else {
        segments = path.split("/");
      }
      let isAbsolute = false;
      let prefix = "";
      if (type === "Windows") {
        if (/^[A-Za-z]:$/.test(segments[0])) {
          isAbsolute = true;
          prefix = segments[0];
          segments = segments.slice(1);
        }
      } else if (type === "Unix") {
        if (path.startsWith("/")) {
          isAbsolute = true;
          if (segments[0] === "") {
            segments = segments.slice(1);
          }
        }
      } else {
        isAbsolute = false;
      }
      const resolvedSegments = this.resolveSegments(segments, isAbsolute);
      let normalized = "";
      if (type === "Windows") {
        normalized = prefix ? prefix + sep + resolvedSegments.join(sep) : resolvedSegments.join(sep);
        if (prefix && normalized === prefix) {
          normalized += sep;
        }
      } else if (type === "Unix") {
        normalized = (isAbsolute ? sep : "") + resolvedSegments.join(sep);
        if (isAbsolute && normalized === "") {
          normalized = sep;
        }
      } else {
        normalized = resolvedSegments.join(sep);
      }
      return normalized;
    }
    resolveSegments(segments, isAbsolute) {
      const stack = [];
      for (const segment of segments) {
        if (segment === "" || segment === ".") continue;
        if (segment === "..") {
          if (stack.length > 0 && stack[stack.length - 1] !== "..") {
            stack.pop();
          } else {
            if (isAbsolute) {
              throw new Error("绝对路径不能越界");
            } else {
              stack.push("..");
            }
          }
        } else {
          stack.push(segment);
        }
      }
      return stack;
    }
    extractDirectory(path, type) {
      const sep = type === "Windows" ? "\\" : "/";
      if (type === "Windows" && /^[A-Za-z]:\\$/.test(path)) {
        return path;
      }
      if (type === "Unix" && path === "/") {
        return path;
      }
      const lastIndex = path.lastIndexOf(sep);
      return lastIndex === -1 ? "" : path.substring(0, lastIndex);
    }
    extractFileName(path, type) {
      const sep = type === "Windows" ? "\\" : "/";
      const lastIndex = path.lastIndexOf(sep);
      return lastIndex === -1 ? path : path.substring(lastIndex + 1);
    }
    extractBaseAndExtension(fileName) {
      const lastDot = fileName.lastIndexOf(".");
      if (lastDot <= 0) {
        return { baseName: fileName, extension: "" };
      }
      const baseName = fileName.substring(0, lastDot);
      const extension = fileName.substring(lastDot + 1);
      return { baseName, extension };
    }
  };
  var Version = class _Version {
    major;
    minor;
    patch;
    preRelease;
    buildMetadata;
    constructor(versionString) {
      if (!versionString || typeof versionString !== "string") {
        throw new Error("Invalid version string");
      }
      const dashIndex = versionString.indexOf("-");
      const plusIndex = versionString.indexOf("+");
      let version, preRelease, buildMetadata;
      if (dashIndex === -1 && plusIndex === -1) {
        version = versionString;
        preRelease = "";
        buildMetadata = "";
      } else if (plusIndex !== -1 && (dashIndex === -1 || plusIndex < dashIndex)) {
        version = versionString.substring(0, plusIndex);
        preRelease = "";
        buildMetadata = versionString.substring(plusIndex + 1);
      } else {
        version = versionString.substring(0, dashIndex);
        const rest = versionString.substring(dashIndex + 1);
        const buildSep = rest.indexOf("+");
        if (buildSep !== -1) {
          preRelease = rest.substring(0, buildSep);
          buildMetadata = rest.substring(buildSep + 1);
        } else {
          preRelease = rest;
          buildMetadata = "";
        }
      }
      const versionParts = version.split(".").map(Number);
      if (versionParts.some(isNaN)) {
        throw new Error("Version string contains invalid numbers");
      }
      this.major = versionParts[0] || 0;
      this.minor = versionParts.length > 1 ? versionParts[1] : 0;
      this.patch = versionParts.length > 2 ? versionParts[2] : 0;
      this.preRelease = preRelease ? preRelease.split(".") : [];
      this.buildMetadata = buildMetadata || "";
    }
    static compareValues(a2, b2) {
      if (a2 < b2) return 0;
      if (a2 > b2) return 2;
      return 1;
    }
    compare(other) {
      let state = _Version.compareValues(this.major, other.major);
      if (state !== 1) return state;
      state = _Version.compareValues(this.minor, other.minor);
      if (state !== 1) return state;
      state = _Version.compareValues(this.patch, other.patch);
      if (state !== 1) return state;
      if (this.preRelease.length === 0 && other.preRelease.length > 0) {
        return 2;
      }
      if (this.preRelease.length > 0 && other.preRelease.length === 0) {
        return 0;
      }
      const maxLen = Math.max(this.preRelease.length, other.preRelease.length);
      for (let i = 0; i < maxLen; i++) {
        if (i >= this.preRelease.length) return 0;
        if (i >= other.preRelease.length) return 2;
        const pre1 = this.preRelease[i];
        const pre2 = other.preRelease[i];
        const isNum1 = !isNaN(+pre1);
        const isNum2 = !isNaN(+pre2);
        if (isNum1 && !isNum2) return 0;
        if (!isNum1 && isNum2) return 2;
        const val1 = isNum1 ? +pre1 : pre1;
        const val2 = isNum2 ? +pre2 : pre2;
        if (val1 < val2) return 0;
        if (val1 > val2) return 2;
      }
      return 1;
    }
    toString() {
      const version = `${this.major}.${this.minor}.${this.patch}`;
      const preRelease = this.preRelease.length ? `-${this.preRelease.join(".")}` : "";
      const buildMetadata = this.buildMetadata ? `+${this.buildMetadata}` : "";
      return `${version}${preRelease}${buildMetadata}`;
    }
  };
  var Dictionary = class extends Map {
    constructor(data = []) {
      super(data);
    }
    toArray() {
      return Array.from(this);
    }
    keysArray() {
      return Array.from(this.keys());
    }
    valuesArray() {
      return Array.from(this.values());
    }
  };
  var GMSyncDictionary = class _GMSyncDictionary extends Dictionary {
    onSet;
    onDel;
    onSync;
    name;
    listenerId = null;
    static BATCH_THRESHOLD = 10;
    constructor(name, initial = [], validator = isVideoInfo) {
      let stored = initial.any() ? initial : GM_getValue(name, initial);
      try {
        super(stored.filter(([_, value]) => validator(value)));
      } catch (error) {
        super();
      }
      this.name = name;
      this.saveToStorage();
      this.setupValueChangeListener();
    }
    setupValueChangeListener() {
      if (this.listenerId !== null) {
        GM_removeValueChangeListener(this.listenerId);
      }
      this.listenerId = GM_addValueChangeListener(
        this.name,
        (key, oldValue, newValue, remote) => {
          if (key === this.name && remote) {
            this.handleRemoteChange(newValue);
          }
        }
      );
    }
    handleRemoteChange(newValue) {
      if (isNullOrUndefined(newValue)) {
        super.clear();
        this.onSync?.();
        return;
      }
      const currentKeys = new Set(this.keys());
      const addedOrUpdated = [];
      const deleted = [];
      for (const [key, value] of newValue) {
        if (!currentKeys.has(key)) {
          addedOrUpdated.push([key, value]);
        } else {
          const currentValue = this.get(key);
          if (currentValue !== value) {
            addedOrUpdated.push([key, value]);
          }
          currentKeys.delete(key);
        }
      }
      for (const key of currentKeys) {
        deleted.push(key);
      }
      const totalChanges = addedOrUpdated.length + deleted.length;
      if (totalChanges > _GMSyncDictionary.BATCH_THRESHOLD) {
        super.clear();
        for (const [key, value] of newValue) {
          super.set(key, value);
        }
        this.onSync?.();
      } else {
        for (const [key, value] of addedOrUpdated) {
          super.set(key, value);
          this.onSet?.(key, value);
        }
        for (const key of deleted) {
          super.delete(key);
          this.onDel?.(key);
        }
      }
    }
    saveToStorage() {
      GM_setValue(this.name, this.toArray());
    }
    set(key, value) {
      super.set(key, value);
      this.saveToStorage();
      this.onSet?.(key, value);
      return this;
    }
    delete(key) {
      const result = super.delete(key);
      if (result) {
        this.saveToStorage();
        this.onDel?.(key);
      }
      return result;
    }
    clear() {
      super.clear();
      this.saveToStorage();
      this.onSync?.();
    }
    get(key) {
      return super.get(key);
    }
    has(key) {
      return super.has(key);
    }
    get size() {
      return super.size;
    }
    destroy() {
      if (this.listenerId !== null) {
        GM_removeValueChangeListener(this.listenerId);
        this.listenerId = null;
      }
    }
  };
  var SyncDictionary = class extends Dictionary {
    onSet;
    onDel;
    onSync;
    timestamp;
    lifetime;
    id;
    channel;
    constructor(channelName, initial = []) {
      const hasInitial = prune(initial).any();
      super(hasInitial ? initial : void 0);
      this.timestamp = hasInitial ? Date.now() : 0;
      this.lifetime = hasInitial ? performance.now() : 0;
      this.id = UUID();
      this.channel = new BroadcastChannel(channelName);
      this.channel.onmessage = ({ data: msg }) => this.handleMessage(msg);
      this.channel.postMessage({ type: "sync", id: this.id, timestamp: this.timestamp, lifetime: this.lifetime });
    }
    setTimestamp(timestamp) {
      this.timestamp = timestamp ?? Date.now();
      this.lifetime = performance.now();
    }
    set(key, value) {
      this.setTimestamp();
      super.set(key, value);
      this.channel.postMessage({ type: "set", key, value, timestamp: this.timestamp, lifetime: this.lifetime, id: this.id });
      this.onSet?.(key, value);
      return this;
    }
    delete(key) {
      this.setTimestamp();
      const existed = super.delete(key);
      if (existed) {
        this.onDel?.(key);
        this.channel.postMessage({ type: "delete", key, timestamp: this.timestamp, lifetime: this.lifetime, id: this.id });
      }
      return existed;
    }
    clear() {
      this.setTimestamp();
      super.clear();
      this.channel.postMessage({ timestamp: this.timestamp, lifetime: this.lifetime, id: this.id, type: "state", state: super.toArray() });
      this.onSync?.();
    }
    handleMessage(msg) {
      if (msg.id === this.id) return;
      if (msg.type === "sync") {
        this.channel.postMessage({ timestamp: this.timestamp, lifetime: this.lifetime, id: this.id, type: "state", state: super.toArray() });
        return;
      }
      if (msg.timestamp === this.timestamp && msg.lifetime === this.lifetime) return;
      if (msg.timestamp < this.timestamp || msg.lifetime < this.lifetime) return;
      switch (msg.type) {
        case "state": {
          super.clear();
          for (let index = 0; index < msg.state.length; index++) {
            const [key, value] = msg.state[index];
            super.set(key, value);
          }
          this.setTimestamp(msg.timestamp);
          this.onSync?.();
          break;
        }
        case "set": {
          const { key, value } = msg;
          super.set(key, value);
          this.setTimestamp(msg.timestamp);
          this.onSet?.(key, value);
          break;
        }
        case "delete": {
          const { key } = msg;
          if (super.delete(key)) {
            this.setTimestamp(msg.timestamp);
            this.onDel?.(key);
          }
          break;
        }
      }
    }
  };
  var MultiPage = class {
    pageId;
    onLastPage;
    onPageJoin;
    onPageLeave;
    channel;
    beforeUnloadHandler;
    constructor() {
      this.pageId = UUID();
      GM_saveTab({ id: this.pageId });
      this.channel = new BroadcastChannel("page-status-channel");
      this.channel.onmessage = (event) => this.handleMessage(event.data);
      this.channel.postMessage({ type: "join", id: this.pageId });
      this.beforeUnloadHandler = () => {
        this.channel.postMessage({ type: "leave", id: this.pageId });
        originalRemoveEventListener.call(unsafeWindow.document, "beforeunload", this.beforeUnloadHandler);
      };
      originalAddEventListener.call(unsafeWindow.document, "beforeunload", this.beforeUnloadHandler);
    }
    suicide() {
      this.channel.postMessage({ type: "suicide", id: this.pageId });
    }
    handleMessage(message) {
      switch (message.type) {
        case "suicide":
          if (this.pageId !== message.id) unsafeWindow.close();
          break;
        case "join":
          this.onPageJoin?.(message.id);
          break;
        case "leave":
          this.onPageLeave?.(message.id);
          GM_getTabs((tabs) => {
            if (Object.keys(tabs).length > 1) return;
            this.onLastPage?.();
          });
          break;
      }
    }
  };
  var D = (e, n) => n.some((t) => e instanceof t);
  var w, b;
  function C() {
    return w || (w = [IDBDatabase, IDBObjectStore, IDBIndex, IDBCursor, IDBTransaction]);
  }
  function x() {
    return b || (b = [IDBCursor.prototype.advance, IDBCursor.prototype.continue, IDBCursor.prototype.continuePrimaryKey]);
  }
  var I = new WeakMap(), l = new WeakMap(), f = new WeakMap();
  function V(e) {
    const n = new Promise((t, r) => {
      const i = () => {
        e.removeEventListener("success", c), e.removeEventListener("error", o);
      }, c = () => {
        t(a(e.result)), i();
      }, o = () => {
        r(e.error), i();
      };
      e.addEventListener("success", c), e.addEventListener("error", o);
    });
    return f.set(n, e), n;
  }
  function S(e) {
    if (I.has(e)) return;
    const n = new Promise((t, r) => {
      const i = () => {
        e.removeEventListener("complete", c), e.removeEventListener("error", o), e.removeEventListener("abort", o);
      }, c = () => {
        t(), i();
      }, o = () => {
        r(e.error || new DOMException("AbortError", "AbortError")), i();
      };
      e.addEventListener("complete", c), e.addEventListener("error", o), e.addEventListener("abort", o);
    });
    I.set(e, n);
  }
  var y = { get(e, n, t) {
    if (e instanceof IDBTransaction) {
      if (n === "done") return I.get(e);
      if (n === "store") return t.objectStoreNames[1] ? void 0 : t.objectStore(t.objectStoreNames[0]);
    }
    return a(e[n]);
  }, set(e, n, t) {
    return e[n] = t, true;
  }, has(e, n) {
    return e instanceof IDBTransaction && (n === "done" || n === "store") ? true : n in e;
  } };
  function E(e) {
    y = e(y);
  }
  function T(e) {
    return x().includes(e) ? function(...n) {
      return e.apply(h(this), n), a(this.request);
    } : function(...n) {
      return a(e.apply(h(this), n));
    };
  }
  function j(e) {
    return typeof e == "function" ? T(e) : (e instanceof IDBTransaction && S(e), D(e, C()) ? new Proxy(e, y) : e);
  }
  function a(e) {
    if (e instanceof IDBRequest) return V(e);
    if (l.has(e)) return l.get(e);
    const n = j(e);
    return n !== e && (l.set(e, n), f.set(n, e)), n;
  }
  var h = (e) => f.get(e);
  function A(e, n, { blocked: t, upgrade: r, blocking: i, terminated: c } = {}) {
    const o = indexedDB.open(e, n), d = a(o);
    return r && o.addEventListener("upgradeneeded", (s) => {
      r(a(o.result), s.oldVersion, s.newVersion, a(o.transaction), s);
    }), t && o.addEventListener("blocked", (s) => t(s.oldVersion, s.newVersion, s)), d.then((s) => {
      c && s.addEventListener("close", () => c()), i && s.addEventListener("versionchange", (u) => i(u.oldVersion, u.newVersion, u));
    }).catch(() => {
    }), d;
  }
  function O(e, { blocked: n } = {}) {
    const t = indexedDB.deleteDatabase(e);
    return n && t.addEventListener("blocked", (r) => n(r.oldVersion, r)), a(t).then(() => {
    });
  }
  var v = ["get", "getKey", "getAll", "getAllKeys", "count"], W = ["put", "add", "delete", "clear"], m = new Map();
  function M(e, n) {
    if (!(e instanceof IDBDatabase && !(n in e) && typeof n == "string")) return;
    if (m.get(n)) return m.get(n);
    const t = n.replace(/FromIndex$/, ""), r = n !== t, i = W.includes(t);
    if (!(t in (r ? IDBIndex : IDBObjectStore).prototype) || !(i || v.includes(t))) return;
    const c = async function(o, ...d) {
      const s = this.transaction(o, i ? "readwrite" : "readonly");
      let u = s.store;
      return r && (u = u.index(d.shift())), (await Promise.all([u[t](...d), i && s.done]))[0];
    };
    return m.set(n, c), c;
  }
  E((e) => ({ ...e, get: (n, t, r) => M(n, t) || e.get(n, t, r), has: (n, t) => !!M(n, t) || e.has(n, t) }));
  var p = ["continue", "continuePrimaryKey", "advance"], P = {}, B = new WeakMap(), L = new WeakMap(), F = { get(e, n) {
    if (!p.includes(n)) return e[n];
    let t = P[n];
    return t || (t = P[n] = function(...r) {
      B.set(this, L.get(this)[n](...r));
    }), t;
  } };
  async function* k(...e) {
    let n = this;
    if (n instanceof IDBCursor || (n = await n.openCursor(...e)), !n) return;
    n = n;
    const t = new Proxy(n, F);
    for (L.set(t, n), f.set(t, h(n)); n; ) yield t, n = await (B.get(t) || n.continue()), B.delete(t);
  }
  function g(e, n) {
    return n === Symbol.asyncIterator && D(e, [IDBIndex, IDBObjectStore, IDBCursor]) || n === "iterate" && D(e, [IDBIndex, IDBObjectStore]);
  }
  E((e) => ({ ...e, get(n, t, r) {
    return g(n, t) ? k : e.get(n, t, r);
  }, has(n, t) {
    return g(n, t) || e.has(n, t);
  } }));
  var Database = class _Database {
    static instance;
    dbPromise;
    constructor() {
      this.dbPromise = A("IwaraDownloadTool", 22, {
        upgrade(db2, oldVersion, newVersion, transaction) {
          if (!db2.objectStoreNames.contains("follows")) {
            const followsStore = db2.createObjectStore("follows", { keyPath: "id" });
            followsStore.createIndex("id", "id", { unique: true });
            followsStore.createIndex("username", "username", { unique: true });
            followsStore.createIndex("name", "name");
            followsStore.createIndex("friend", "friend");
            followsStore.createIndex("following", "following");
            followsStore.createIndex("followedBy", "followedBy");
          }
          if (!db2.objectStoreNames.contains("friends")) {
            const friendsStore = db2.createObjectStore("friends", { keyPath: "id" });
            friendsStore.createIndex("id", "id", { unique: true });
            friendsStore.createIndex("username", "username", { unique: true });
            friendsStore.createIndex("name", "name");
            friendsStore.createIndex("friend", "friend");
            friendsStore.createIndex("following", "following");
            friendsStore.createIndex("followedBy", "followedBy");
          }
          if (!db2.objectStoreNames.contains("videos")) {
            const videosStore = db2.createObjectStore("videos", { keyPath: "ID" });
            videosStore.createIndex("ID", "ID", { unique: true });
            videosStore.createIndex("UploadTime", "UploadTime");
            videosStore.createIndex("Private", "Private");
            videosStore.createIndex("Unlisted", "Unlisted");
            videosStore.createIndex("Type", "Type");
          }
          if (!db2.objectStoreNames.contains("idmap")) {
            const idmapStore = db2.createObjectStore("idmap", { keyPath: "ID" });
            idmapStore.createIndex("ID", "ID", { unique: true });
          }
          if (oldVersion < 21 && db2.objectStoreNames.contains("caches")) {
            db2.deleteObjectStore("caches");
          }
          if (oldVersion < 22 && db2.objectStoreNames.contains("pairs")) {
            db2.deleteObjectStore("pairs");
          }
        }
      });
    }
    async getDB() {
      return this.dbPromise;
    }
    async follows() {
      const db2 = await this.getDB();
      return db2.transaction("follows", "readwrite").objectStore("follows");
    }
    async friends() {
      const db2 = await this.getDB();
      return db2.transaction("friends", "readwrite").objectStore("friends");
    }
    async videos() {
      const db2 = await this.getDB();
      return db2.transaction("videos", "readwrite").objectStore("videos");
    }
    async idmap() {
      const db2 = await this.getDB();
      return db2.transaction("idmap", "readwrite").objectStore("idmap");
    }
    async getFollows() {
      const store = await this.follows();
      return store.getAll();
    }
    async getFriends() {
      const store = await this.friends();
      return store.getAll();
    }
    async getVideos() {
      const store = await this.videos();
      return store.getAll();
    }
    async getIdmap() {
      const store = await this.idmap();
      return store.getAll();
    }
    async getFollowByUsername(username) {
      const db2 = await this.getDB();
      const tx = db2.transaction("follows", "readonly");
      const index = tx.store.index("username");
      return index.get(username);
    }
    async getFollowById(id) {
      const db2 = await this.getDB();
      return db2.get("follows", id);
    }
    async getVideoById(id) {
      const db2 = await this.getDB();
      return db2.get("videos", id);
    }
    async getVideosByIds(ids) {
      const db2 = await this.getDB();
      const tx = db2.transaction("videos", "readonly");
      const store = tx.store;
      const results = [];
      for (const id of ids) {
        const video = await store.get(id);
        if (video) {
          results.push(video);
        }
      }
      return results;
    }
    async countVideos(predicate) {
      const db2 = await this.getDB();
      const tx = db2.transaction("videos", "readonly");
      const store = tx.store;
      let cursor = await store.openCursor();
      let count = 0;
      while (cursor) {
        if (!predicate || predicate(cursor.value)) count++;
        cursor = await cursor.continue();
      }
      return count;
    }
    async *iterateVideosBatched(batchSize = 500, predicate, sortBy, direction = "next") {
      let lastIndexKey = void 0;
      let lastPrimaryKey = void 0;
      let hasMore = true;
      while (hasMore) {
        const db2 = await this.getDB();
        const tx = db2.transaction("videos", "readonly");
        const store = tx.store;
        const source = sortBy ? store.index(sortBy) : store;
        let cursor;
        if (lastIndexKey !== void 0) {
          if (direction === "prev") {
            const range = IDBKeyRange.upperBound(lastIndexKey, false);
            cursor = await source.openCursor(range, direction);
            while (cursor && cursor.key === lastIndexKey && cursor.primaryKey >= lastPrimaryKey) {
              cursor = await cursor.continue();
            }
          } else {
            const range = IDBKeyRange.lowerBound(lastIndexKey, false);
            cursor = await source.openCursor(range, direction);
            while (cursor && cursor.key === lastIndexKey && cursor.primaryKey <= lastPrimaryKey) {
              cursor = await cursor.continue();
            }
          }
        } else {
          cursor = await source.openCursor(null, direction);
        }
        const batch = [];
        while (cursor && batch.length < batchSize) {
          const video = cursor.value;
          if (!predicate || predicate(video)) {
            batch.push(video);
          }
          lastIndexKey = cursor.key;
          lastPrimaryKey = cursor.primaryKey;
          cursor = await cursor.continue();
        }
        hasMore = cursor !== null;
        yield batch;
      }
    }
    async *iterateVideoKeysBatched(batchSize = 5e3) {
      let lastKey = void 0;
      let hasMore = true;
      while (hasMore) {
        const db2 = await this.getDB();
        const tx = db2.transaction("videos", "readonly");
        const store = tx.store;
        let cursor;
        if (lastKey !== void 0) {
          const range = IDBKeyRange.lowerBound(lastKey, true);
          cursor = await store.openKeyCursor(range, "next");
        } else {
          cursor = await store.openKeyCursor(null, "next");
        }
        const batch = [];
        while (cursor && batch.length < batchSize) {
          batch.push(cursor.primaryKey);
          lastKey = cursor.primaryKey;
          cursor = await cursor.continue();
        }
        hasMore = cursor !== null;
        yield batch;
      }
    }
    async *iterateTableBatched(table, batchSize = 500) {
      let lastKey = void 0;
      let hasMore = true;
      while (hasMore) {
        const db2 = await this.getDB();
        const tx = db2.transaction(table, "readonly");
        const store = tx.store;
        let cursor;
        if (lastKey !== void 0) {
          const range = IDBKeyRange.lowerBound(lastKey, true);
          cursor = await store.openCursor(range, "next");
        } else {
          cursor = await store.openCursor(null, "next");
        }
        const batch = [];
        while (cursor && batch.length < batchSize) {
          batch.push(cursor.value);
          lastKey = cursor.primaryKey;
          cursor = await cursor.continue();
        }
        hasMore = cursor !== null;
        yield batch;
      }
    }
    async putVideo(video) {
      const db2 = await this.getDB();
      await db2.put("videos", video);
    }
    async bulkPutVideos(videos) {
      const db2 = await this.getDB();
      const tx = db2.transaction("videos", "readwrite");
      const store = tx.store;
      for (const video of videos) {
        await store.put(video);
      }
      await tx.done;
    }
    async putFollow(user) {
      const db2 = await this.getDB();
      await db2.put("follows", user);
    }
    async putFriend(user) {
      const db2 = await this.getDB();
      await db2.put("friends", user);
    }
    async deleteFollow(id) {
      const db2 = await this.getDB();
      await db2.delete("follows", id);
    }
    async deleteFriend(id) {
      const db2 = await this.getDB();
      await db2.delete("friends", id);
    }
    async getFilteredVideos(startTime, endTime) {
      if (isNullOrUndefined(startTime) || isNullOrUndefined(endTime)) return [];
      const db2 = await this.getDB();
      const tx = db2.transaction("videos", "readonly");
      const store = tx.store;
      const index = store.index("UploadTime");
      const allVideos = [];
      let cursor = await index.openCursor(IDBKeyRange.bound(startTime, endTime, true, true));
      while (cursor) {
        const video = cursor.value;
        if ((video.Type === "partial" || video.Type === "full") && (video.Private || video.Unlisted) && !isNullOrUndefined(video.RAW)) {
          allVideos.push(video);
        }
        cursor = await cursor.continue();
      }
      return allVideos;
    }
    async getMediaCenterIdMap(videoId) {
      const db2 = await this.getDB();
      const entry = await db2.get("idmap", videoId);
      return entry?.href;
    }
    async putMediaCenterIdMap(videoId, mediaCenterId) {
      const db2 = await this.getDB();
      await db2.put("idmap", { ID: videoId, href: mediaCenterId });
    }
    async bulkPutMediaCenterIdMaps(entries) {
      const db2 = await this.getDB();
      const tx = db2.transaction("idmap", "readwrite");
      const store = tx.store;
      for (const { videoId, mediaCenterId } of entries) {
        await store.put({ ID: videoId, href: mediaCenterId });
      }
      await tx.done;
    }
    async getAllMediaCenterIdMaps() {
      const db2 = await this.getDB();
      const all = await db2.getAll("idmap");
      const map = new Map();
      for (const entry of all) {
        map.set(entry.ID, entry.href);
      }
      return map;
    }
    async deleteMediaCenterIdMap(videoId) {
      const db2 = await this.getDB();
      await db2.delete("idmap", videoId);
    }
    async clearAllMediaCenterIdMaps() {
      const db2 = await this.getDB();
      const tx = db2.transaction("idmap", "readwrite");
      const store = tx.store;
      let cursor = await store.openCursor();
      while (cursor) {
        await cursor.delete();
        cursor = await cursor.continue();
      }
      await tx.done;
    }
    async downloadTextFile(filename, content, mimeType, mode = "auto", gmTimeout = 30 * 1e3) {
      const blob = new Blob([content], { type: mimeType });
      const url = URL.createObjectURL(blob);
      const triggerBrowserDownload = () => {
        const a2 = document.createElement("a");
        a2.href = url;
        a2.download = filename;
        document.body.appendChild(a2);
        a2.click();
        a2.remove();
        setTimeout(() => URL.revokeObjectURL(url), 60 * 1e3);
      };
      const isFirefox = () => /Firefox/i.test(navigator.userAgent);
      const useGm = (mode === "gm" || mode === "auto" && !isFirefox()) && typeof GM_download === "function";
      if (useGm) {
        try {
          await new Promise((resolve, reject) => {
            let settled = false;
            const timer = setTimeout(() => {
              if (settled) return;
              settled = true;
              reject(new Error(`下载 ${filename} 超时（GM_download 未响应）`));
            }, gmTimeout);
            GM_download({
              url,
              name: filename,
              saveAs: false,
              onload: () => {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                URL.revokeObjectURL(url);
                resolve();
              },
              onerror: (err) => {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                reject(new Error(`下载 ${filename} 失败: ${err.error}${err.details ? ` - ${err.details}` : ""}`));
              },
              ontimeout: () => {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                reject(new Error(`下载 ${filename} 超时`));
              }
            });
          });
          return;
        } catch (error) {
          if (mode === "auto") {
            console.warn(`[db] GM_download 不可用，回退浏览器原生下载: ${error.message}`);
            triggerBrowserDownload();
            return;
          }
          URL.revokeObjectURL(url);
          throw error;
        }
      }
      triggerBrowserDownload();
    }
    async exportToJsonFiles(table, options = {}) {
      const { batchSize = 500, prefix = table, pretty = true, onProgress, downloadMode = "auto", gmTimeout } = options;
      const db2 = await this.getDB();
      const total = await db2.count(table);
      const totalBatches = Math.ceil(total / batchSize);
      let fileCount = 0;
      for await (const batch of this.iterateTableBatched(table, batchSize)) {
        fileCount++;
        const content = JSON.stringify(batch, null, pretty ? 2 : void 0);
        const filename = `${prefix}_${String(fileCount).padStart(3, "0")}.json`;
        await this.downloadTextFile(filename, content, "application/json;charset=utf-8", downloadMode, gmTimeout);
        onProgress?.(fileCount, totalBatches);
      }
      return fileCount;
    }
    async exportAllToJsonFiles(options = {}) {
      const tables = ["videos", "follows", "friends", "idmap"];
      const result = {};
      for (const table of tables) {
        result[table] = await this.exportToJsonFiles(table, options);
      }
      return result;
    }
    static getInstance() {
      if (isNullOrUndefined(_Database.instance)) {
        _Database.instance = new _Database();
      }
      return _Database.instance;
    }
    static destroyInstance() {
      _Database.instance = void 0;
    }
    async delete() {
      const db2 = await this.getDB();
      db2.close();
      await O("IwaraDownloadTool");
    }
  };
  var db = Database.getInstance();
  var import_dayjs = __toESM(require_dayjs_min(), 1);
  Date.prototype.format = function(format) {
    return (0, import_dayjs.default)(this).format(format);
  };
  Date.prototype.add = function({ years = 0, months = 0, days = 0, hours = 0, minutes = 0, seconds = 0, ms = 0 } = {}) {
    return (0, import_dayjs.default)(this).add(years, "year").add(months, "month").add(days, "day").add(hours, "hour").add(minutes, "minute").add(seconds, "second").add(ms, "millisecond").toDate();
  };
  Date.prototype.sub = function({ years = 0, months = 0, days = 0, hours = 0, minutes = 0, seconds = 0, ms = 0 } = {}) {
    return (0, import_dayjs.default)(this).subtract(years, "year").subtract(months, "month").subtract(days, "day").subtract(hours, "hour").subtract(minutes, "minute").subtract(seconds, "second").subtract(ms, "millisecond").toDate();
  };
  function gmFetch(url, init) {
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method: init.method,
        url,
        headers: init.headers || {},
        data: init.body || void 0,
        onload: (res) => {
          const headers = new Headers();
          for (const line of String(res.responseHeaders || "").split(/\r?\n/)) {
            const index = line.indexOf(":");
            if (index > 0 && /^(retry-after|content-type)$/i.test(line.slice(0, index).trim())) headers.append(line.slice(0, index).trim(), line.slice(index + 1).trim());
          }
          resolve(new Response(res.responseText, { status: res.status, statusText: res.statusText, headers }));
        },
        onerror: (err) => reject(new Error(
          err?.error ?? err?.statusText ?? "GM_xmlhttpRequest network error"
        )),
        ontimeout: () => reject(new Error("Request timeout"))
      });
    });
  }
  function queueHttpFailure(response, stage, reason = "") {
    const retryAfter = response?.headers?.get("retry-after") || "";
    const delay = /^\d+$/.test(retryAfter) ? Number(retryAfter) * 1000 : Math.max(0, Date.parse(retryAfter) - Date.now()) || 0;
    return { stage, httpStatus: response?.status || null, reason, retryAfterMs: Math.min(60_000, delay) };
  }
  var unlimitedFetch = async (input, init = {}, retryOptions) => {
    const { force = false, retry = false, maxRetries = 3, retryDelay = 3e3, successStatus = [200, 201], failStatus = [403, 404], onRetry, onFail } = retryOptions ?? {};
    const url = typeof input === "string" ? input : input.url;
    const useGM = force || new URL(url).hostname !== unsafeWindow.location.hostname;
    const execFetch = () => useGM ? gmFetch(url, init) : originalFetch(input, init);
    if (!retry) return execFetch();
    const okStatus = Array.isArray(successStatus) ? successStatus : [successStatus];
    const failCodes = Array.isArray(failStatus) ? failStatus : [failStatus];
    let response = await execFetch();
    for (let attempt = 1; attempt < maxRetries; attempt++) {
      if (okStatus.includes(response.status)) return response;
      if (failCodes.includes(response.status)) break;
      await onRetry?.(response);
      await delay(retryDelay);
      response = await execFetch();
    }
    await onFail?.(response);
    return response;
  };
  var findElement = (element, condition) => {
    while (!isNullOrUndefined(element) && !element.matches(condition)) {
      if (isNullOrUndefined(element.parentElement)) return void 0;
      element = element.parentElement;
    }
    return element.querySelectorAll(condition).length > 1 ? void 0 : element;
  };
  var renderNode = (renderCode) => {
    let code = prune(renderCode);
    if (isNullOrUndefined(code)) throw new Error("RenderCode null");
    if (typeof code === "string") {
      return document.createTextNode(code.replaceVariable(i18nList[config.language]));
    }
    if (renderCode instanceof Node) {
      return code;
    }
    if (typeof renderCode !== "object" || !renderCode.nodeType) {
      throw new Error("Invalid arguments");
    }
    const { nodeType, attributes, events, className, childs } = renderCode;
    const node = document.createElement(nodeType);
    if (!isNullOrUndefined(events) && Object.keys(events).length > 0) {
      Object.entries(events).forEach(([eventName, eventHandler]) => originalAddEventListener.call(node, eventName, eventHandler));
    }
    if (!isNullOrUndefined(attributes) && Object.keys(attributes).length > 0) {
      Object.entries(attributes).forEach(([key, value]) => {
        node.setAttribute(key, value);
        node[key] = value;
      });
    }
    if (!isNullOrUndefined(className) && className.length > 0) {
      node.classList.add(...typeof className === "string" ? [className] : className);
    }
    if (!isNullOrUndefined(childs)) {
      node.append(...(isArray(childs) ? childs : [childs]).filter((child) => !isNullOrUndefined(child)).map(renderNode));
    }
    return node;
  };
  var activeToasts = new Dictionary();
  var toastTimeouts = new Map();
  var toastContainers = new Map();
  var offscreenContainer = document.createElement("div");
  offscreenContainer.classList.add("offscreen-container");
  var camelToKebab = (str) => str.replace(/([A-Z])/g, "-$1").toLowerCase();
  var MIN_PROGRESS_DURATION = 3e3;
  var getContainer = (gravity, position) => {
    const containerId = `toast-container-${gravity}-${position}`;
    let container = toastContainers.get(containerId);
    if (isNullOrUndefined(container)) {
      container = document.createElement("div");
      container.id = containerId;
      container.classList.add(
        "toast-container",
        `toast-${gravity}`,
        `toast-${position}`
      );
      document.body.appendChild(container);
      toastContainers.set(containerId, container);
    }
    return container;
  };
  var addTimeout = (toast, callback) => {
    if (isNullOrUndefined(toast.options.duration)) return;
    delTimeout(toast);
    const duration = toast.options.duration;
    const timeoutId = window.setTimeout(() => {
      callback();
      delTimeout(toast);
    }, duration);
    toastTimeouts.set(toast, timeoutId);
    if (!toast.showProgress) return;
    if (isNullOrUndefined(toast.progress)) return;
    const progress = toast.progress;
    progress.style.setProperty("--toast-duration", `${duration}ms`);
    progress.style.animation = "none";
    void progress.offsetWidth;
    progress.style.animation = "";
    progress.style.animationPlayState = "running";
  };
  var delTimeout = (toast) => {
    const timeoutId = toastTimeouts.get(toast);
    if (!isNullOrUndefined(timeoutId)) {
      clearTimeout(timeoutId);
      toastTimeouts.delete(toast);
    }
    if (!toast.showProgress) return;
    if (!isNullOrUndefined(toast.progress)) {
      toast.progress.style.animationPlayState = "paused";
    }
  };
  var Toast = class _Toast {
    static defaults = {
      gravity: "top",
      position: "left",
      stopOnFocus: true,
      oldestFirst: true,
      showProgress: false,
      rate: 1
    };
    id;
    options;
    root;
    element;
    gravity;
    position;
    oldestFirst;
    stopOnFocus;
    showProgress;
    content;
    progress;
    mouseOverHandler;
    mouseLeaveHandler;
    closeButtonHandler;
    animationEndHandler;
    clickHandler;
    closeButton;
    hidden = false;
    constructor(options) {
      this.id = options.id ?? UUID();
      this.options = {
        ..._Toast.defaults,
        ...options,
        id: this.id
      };
      this.root = getContainer(this.options.gravity, this.options.position);
      this.gravity = this.options.gravity;
      this.position = this.options.position;
      this.stopOnFocus = this.options.stopOnFocus;
      this.oldestFirst = this.options.oldestFirst;
      this.showProgress = options.showProgress ?? (!isNullOrUndefined(this.options.duration) && this.options.duration > 0 && this.options.duration >= MIN_PROGRESS_DURATION);
      this.element = document.createElement("div");
      if (this.options.rate !== 1) {
        this.element.style.setProperty("--toast-rate", String(this.options.rate));
      }
      this.applyBaseStyles().addCloseButton().createContent().ensureCloseMethod().bindEvents();
      activeToasts.set(this.id, this);
    }
    applyBaseStyles() {
      this.element.classList.add("toast");
      if (this.options.className) {
        const classes = Array.isArray(this.options.className) ? this.options.className : [this.options.className];
        classes.forEach((cls) => this.element.classList.add(cls));
      }
      return this;
    }
    createContent() {
      this.content = document.createElement("div");
      this.content.classList.add("toast-content");
      if (this.options.text) {
        this.content.textContent = this.options.text;
      }
      if (this.options.node) {
        this.content.appendChild(this.options.node);
      }
      if (this.options.style) {
        this.applyStyles(this.content, this.options.style);
      }
      if (this.showProgress) {
        this.progress = document.createElement("div");
        this.progress.classList.add("toast-progress");
        this.content.appendChild(this.progress);
      }
      this.element.appendChild(this.content);
      return this;
    }
    addCloseButton() {
      if (this.options.close) {
        this.closeButton = document.createElement("span");
        this.closeButton.className = "toast-close";
        this.closeButton.textContent = "🗙";
        this.closeButtonHandler = () => this.hide("close-button");
        this.closeButton.addEventListener("click", this.closeButtonHandler);
        this.element.appendChild(this.closeButton);
      }
      return this;
    }
    setToastRect() {
      if (!this.element.classList.contains("show")) offscreenContainer.appendChild(this.element);
      this.element.style.removeProperty("--toast-height");
      this.element.style.removeProperty("--toast-width");
      this.element.style.setProperty("max-height", "none", "important");
      this.element.style.setProperty("max-width", `${this.root.getBoundingClientRect().width}px`, "important");
      const { height, width } = this.element.getBoundingClientRect();
      this.element.style.setProperty("--toast-height", `${height}px`);
      this.element.style.setProperty("--toast-width", `${width}px`);
      this.element.style.removeProperty("max-height");
      this.element.style.removeProperty("max-width");
      if (!this.element.classList.contains("show")) offscreenContainer.removeChild(this.element);
      return this;
    }
    ensureCloseMethod() {
      if (isNullOrUndefined(this.options.duration) && isNullOrUndefined(this.options.close) && isNullOrUndefined(this.options.onClick)) {
        this.options.onClick = () => this.hide("other");
      }
      return this;
    }
    bindEvents() {
      if (this.stopOnFocus && !isNullOrUndefined(this.options.duration) && this.options.duration > 0) {
        this.mouseOverHandler = () => delTimeout(this);
        this.mouseLeaveHandler = () => addTimeout(this, () => this.hide("timeout"));
        this.element.addEventListener("mouseover", this.mouseOverHandler);
        this.element.addEventListener("mouseleave", this.mouseLeaveHandler);
      }
      if (!isNullOrUndefined(this.options.onClick)) {
        this.clickHandler = this.options.onClick.bind(this);
        this.element.addEventListener("click", this.clickHandler);
      }
      return this;
    }
    applyStyles(element, styles) {
      for (const key in styles) {
        const value = styles[key];
        const property = camelToKebab(key);
        if (isNullOrUndefined(value)) {
          element.style.removeProperty(property);
          continue;
        }
        const important = value.includes("!important");
        const cleanValue = value.replace(/\s*!important\s*/, "").trim();
        element.style.setProperty(property, cleanValue, important ? "important" : "");
      }
    }
    toggleAnimationState(animation) {
      if (!this.element.classList.replace(animation ? "hide" : "show", animation ? "show" : "hide")) {
        this.element.classList.add(animation ? "show" : "hide");
      }
      return this;
    }
    insertToastElement() {
      if (this.oldestFirst) {
        this.root.insertBefore(this.element, this.root.firstChild);
      } else {
        this.root.appendChild(this.element);
      }
      return this;
    }
    setupAutoHide() {
      if (!isNullOrUndefined(this.options.duration) && this.options.duration > 0) {
        addTimeout(this, () => this.hide("timeout"));
      }
      return this;
    }
    show() {
      this.setToastRect().insertToastElement();
      void this.element.offsetWidth;
      this.toggleAnimationState(true).setupAutoHide();
      return this;
    }
    showToast() {
      return this.show();
    }
    removeEventListeners() {
      if (this.mouseOverHandler) {
        this.element.removeEventListener("mouseover", this.mouseOverHandler);
      }
      if (this.mouseLeaveHandler) {
        this.element.removeEventListener("mouseleave", this.mouseLeaveHandler);
      }
      if (this.clickHandler) {
        this.element.removeEventListener("click", this.clickHandler);
      }
      if (this.options.close && this.closeButton && this.closeButtonHandler) {
        this.closeButton.removeEventListener("click", this.closeButtonHandler);
      }
      return this;
    }
    hide(reason = "other") {
      if (this.hidden || !this.element) return;
      this.hidden = true;
      delTimeout(this);
      activeToasts.delete(this.id);
      let closed = false;
      const finalize = () => {
        if (closed) return;
        closed = true;
        this.element.remove();
        this.options.onClose?.call(this, new CustomEvent("toast-close", {
          detail: { reason }
        }));
      };
      this.animationEndHandler = (e) => {
        if (e.propertyName !== "max-height") return;
        this.element.removeEventListener("transitionend", this.animationEndHandler);
        finalize();
      };
      this.element.addEventListener("transitionend", this.animationEndHandler);
      const durations = getComputedStyle(this.element).transitionDuration;
      const maxMs = durations.split(",").map((s) => parseFloat(s)).filter(Number.isFinite).reduce((max, sec) => Math.max(max, sec), 0) * 1e3;
      window.setTimeout(finalize, Math.max(maxMs, 300) + 300);
      this.removeEventListeners().toggleAnimationState(false);
    }
    hideToast() {
      this.hide("other");
    }
  };
  function createToast(options) {
    return new Toast(options);
  }
  globalThis.Toast = createToast;
  globalThis.Toastify = createToast;
  (document.body ?? document.documentElement).appendChild(offscreenContainer);
  window.addEventListener("resize", debounce(() => {
    for (const [_, toast] of activeToasts) {
      toast.setToastRect();
    }
  }, 100));
  function toastNode(body, title) {
    return renderNode({
      nodeType: "div",
      childs: [
        !isNullOrUndefined(title) && !title.isEmpty() ? {
          nodeType: "h3",
          childs: `%#appName#% - ${title}`
        } : {
          nodeType: "h3",
          childs: "%#appName#%"
        },
        {
          nodeType: "p",
          childs: body
        }
      ]
    });
  }
  function getTextNode(node) {
    return node.nodeType === Node.TEXT_NODE ? node.textContent || "" : node.nodeType === Node.ELEMENT_NODE ? Array.from(node.childNodes).map(getTextNode).join("") : "";
  }
  function newToast(type, params) {
    const logFunc = {
      [2]: originalConsole.warn,
      [3]: originalConsole.error,
      [0]: originalConsole.log,
      [1]: originalConsole.info
    }[type] || originalConsole.log;
    if (isNullOrUndefined(params)) params = {};
    if (!isNullOrUndefined(params.id) && activeToasts.has(params.id)) activeToasts.get(params.id)?.hide();
    switch (type) {
      case 1:
        params = Object.assign({
          duration: 2e3,
          style: {
            background: "linear-gradient(-30deg, rgb(0, 108, 215), rgb(0, 180, 255))"
          }
        }, params);
        break;
      case 2:
        params = Object.assign({
          duration: -1,
          style: {
            background: "linear-gradient(-30deg, rgb(119, 76, 0), rgb(255, 165, 0))"
          }
        }, params);
        break;
      case 3:
        params = Object.assign({
          duration: -1,
          style: {
            background: "linear-gradient(-30deg, rgb(108, 0, 0), rgb(215, 0, 0))"
          }
        }, params);
        break;
      default:
        break;
    }
    if (!isNullOrUndefined(params.text)) {
      params.text = params.text.replaceVariable(i18nList[config.language]).toString();
    }
    logFunc((!isNullOrUndefined(params.text) ? params.text : !isNullOrUndefined(params.node) ? getTextNode(params.node) : "undefined").replaceVariable(i18nList[config.language]));
    return new Toast(params);
  }
  function getDownloadPath(videoInfo) {
    return analyzeLocalPath(
      config.downloadPath.trim().replaceVariable({
        NowTime: new Date(),
        UploadTime: new Date(videoInfo.UploadTime),
        AUTHOR: videoInfo.Author,
        ID: videoInfo.ID,
        TITLE: videoInfo.Title.normalize("NFKC").replaceEmojis("_").replaceAll(new RegExp("(\\P{Mark})(\\p{Mark}+)", "gu"), "_").replace(/^\.|[\\\\/:*?\"<>|]/img, "_").truncate(72),
        ALIAS: videoInfo.Alias.normalize("NFKC").replaceAll(new RegExp("(\\P{Mark})(\\p{Mark}+)", "gu"), "_").replace(/^\.|[\\\\/:*?\"<>|]/img, "_").truncate(64),
        QUALITY: videoInfo.DownloadQuality
      })
    );
  }
  function analyzeLocalPath(path) {
    try {
      return new Path(path);
    } catch (error) {
      let toast = newToast(
        3,
        {
          node: toastNode([
            `%#downloadPathError#%`,
            { nodeType: "br" },
            stringify(error)
          ], "%#settingsCheck#%"),
          position: "center",
          onClick() {
            toast.hide();
          }
        }
      );
      toast.show();
      throw new Error(`%#downloadPathError#% ["${path}"]`);
    }
  }
  async function EnvCheck() {
    try {
      if (GM_info.scriptHandler !== "ScriptCat" && GM_info.downloadMode !== "browser") {
        GM_getValue("isDebug") && originalConsole.debug("[Debug]", GM_info);
        throw new Error("%#browserDownloadModeError#%");
      }
    } catch (error) {
      let toast = newToast(
        3,
        {
          node: toastNode([
            `%#configError#%`,
            { nodeType: "br" },
            stringify(error)
          ], "%#settingsCheck#%"),
          position: "center",
          onClick() {
            toast.hide();
          }
        }
      );
      toast.show();
      return false;
    }
    return true;
  }
  async function localPathCheck() {
    try {
      let pathTest = analyzeLocalPath(config.downloadPath.replaceVariable({
        NowTime: new Date(),
        UploadTime: new Date(),
        AUTHOR: "test",
        ID: "test",
        TITLE: "test",
        ALIAS: "test",
        QUALITY: "test"
      }));
      if (isNullOrUndefined(pathTest)) throw "analyzeLocalPath error";
      if (pathTest.fullPath.isEmpty()) throw "analyzeLocalPath isEmpty";
    } catch (error) {
      let toast = newToast(
        3,
        {
          node: toastNode([
            `%#downloadPathError#%`,
            { nodeType: "br" },
            stringify(error)
          ], "%#settingsCheck#%"),
          position: "center",
          onClick() {
            toast.hide();
          }
        }
      );
      toast.show();
      return false;
    }
    return true;
  }
  async function aria2Check() {
    try {
      let res = await (await unlimitedFetch(config.aria2Path, {
        method: "POST",
        headers: {
          "accept": "application/json",
          "content-type": "application/json"
        },
        body: JSON.stringify({
          "jsonrpc": "2.0",
          "method": "aria2.tellActive",
          "id": UUID(),
          "params": ["token:" + config.aria2Token]
        })
      })).json();
      if (res.error) {
        throw new Error(res.error.message);
      }
    } catch (error) {
      let toast = newToast(
        3,
        {
          node: toastNode([
            `Aria2 RPC %#connectionTest#%`,
            { nodeType: "br" },
            stringify(error)
          ], "%#settingsCheck#%"),
          position: "center",
          onClick() {
            toast.hide();
          }
        }
      );
      toast.show();
      return false;
    }
    return true;
  }
  async function iwaradlCheck() {
    try {
      let res = await (await unlimitedFetch(config.iwaradlPath, {
        method: "GET",
        headers: {
          "accept": "application/json",
          "content-type": "application/json",
          "authorization": `Bearer ${config.iwaradlToken}`
        }
      })).json();
      if (!isArray(res)) {
        throw new Error(`后端未启动或无响应`);
      }
    } catch (error) {
      newToast(
        3,
        {
          node: toastNode([
            `iwaradl RPC %#connectionTest#%`,
            { nodeType: "br" },
            stringify(error)
          ], "%#settingsCheck#%"),
          position: "center",
          onClick() {
            this.hide();
          }
        }
      ).show();
      return false;
    }
    return true;
  }
  async function check() {
    if (await localPathCheck()) {
      switch (config.downloadType) {
        case 0:
          return await aria2Check();
        case 1:
          return await iwaradlCheck();
        case 2:
          return await EnvCheck();
        default:
          break;
      }
      return true;
    } else {
      return false;
    }
  }
  async function refreshToken() {
    const { authorization } = config;
    if (!isLoggedIn()) throw new Error(`Refresh token failed: Not logged in`);
    const refreshToken2 = localStorage.getItem("token") ?? authorization;
    if (isNullOrUndefined(refreshToken2) || refreshToken2.isEmpty()) {
      throw new Error(`Refresh token failed: no refresh token`);
    }
    const oldAccessToken = localStorage.getItem("accessToken");
    try {
      const res = await unlimitedFetch(
        `https://${apiEndpoint}/user/token`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${refreshToken2}`
          }
        }
      );
      if (!res.ok) {
        throw new Error(`Refresh token failed with status: ${res.status}`);
      }
      const { accessToken } = await res.json();
      if (!accessToken) {
        throw new Error(`No access token in response`);
      }
      if (!oldAccessToken || oldAccessToken !== accessToken) {
        localStorage.setItem("accessToken", accessToken);
      }
      return accessToken;
    } catch (error) {
      originalConsole.warn("Failed to refresh token:", error);
      if (!oldAccessToken?.trim()) {
        throw new Error(`Refresh token failed and no valid access token available`);
      }
      return oldAccessToken;
    }
  }
  async function getAuth(url) {
    return prune({
      "Referer": `${window.location.origin}/`,
      "Accept": "application/json",
      "Cookie": unsafeWindow.document.cookie,
      "Authorization": isLoggedIn() ? `Bearer ${localStorage.getItem("accessToken") ?? await refreshToken()}` : void 0,
      "X-Version": !isNullOrUndefined(url) && !url.isEmpty() ? await getXVersion(url) : void 0,
      "X-Site": unsafeWindow.location.hostname
    });
  }
  function getPlayload(authorization) {
    return JSON.parse(decodeURIComponent(encodeURIComponent(window.atob(authorization.split(" ").pop().split(".")[1]))));
  }
  async function getXVersion(urlString) {
    let url = urlString.toURL();
    const data = new TextEncoder().encode([url.pathname.split("/").pop(), url.searchParams.get("expires"), "mSvL05GfEmeEmsEYfGCnVpEjYgTJraJN"].join("_"));
    const hashBuffer = await crypto.subtle.digest("SHA-1", data);
    return Array.from(new Uint8Array(hashBuffer)).map((b2) => b2.toString(16).padStart(2, "0")).join("");
  }
  async function getCommentData(id, commentID, page = 0) {
    return await (await unlimitedFetch(`https://${apiEndpoint}/video/${id}/comments?page=${page}${!isNullOrUndefined(commentID) && !commentID.isEmpty() ? "&parent=" + commentID : ""}`, { headers: await getAuth() })).json();
  }
  async function getCommentDatas(id, commentID) {
    let comments = [];
    let base = await getCommentData(id, commentID);
    comments.push(...base.results);
    for (let page = 1; page < Math.ceil(base.count / base.limit); page++) {
      comments.push(...(await getCommentData(id, commentID, page)).results);
    }
    let replies = [];
    for (let index = 0; index < comments.length; index++) {
      const comment = comments[index];
      if (comment.numReplies > 0) {
        replies.push(...await getCommentDatas(id, comment.id));
      }
    }
    comments.push(...replies);
    return comments;
  }
  async function parseVideoInfo(info, includeComments = true, excludedSourceHosts = []) {
    let ID = info.ID;
    let Type = info.Type;
    let RAW = info.RAW;
    let queueFailure = { stage: "video_api" };
    try {
      switch (info.Type) {
        case "cache":
          RAW = info.RAW;
          ID = RAW.id;
          Type = "partial";
          break;
        case "init":
        case "fail":
        case "partial":
        case "full":
          GM_getValue("isDebug") && originalConsole.debug(`[debug] try parse full source`);
          let sourceResponse = await unlimitedFetch(
            `https://${apiEndpoint}/video/${info.ID}`,
            {
              headers: await getAuth()
            },
            {
              retry: true,
              maxRetries: 3,
              failStatus: [403, 404],
              retryDelay: 1e3,
              onRetry: async () => {
                await refreshToken();
              },
              onFail: async (response) => {
                GM_getValue("isDebug") && originalConsole.debug("[Debug]", `${response.url} Fail, response: ${await response.clone().text()}`);
              }
            }
          );
          if ([401, 403].includes(sourceResponse.status)) {
            try { await refreshToken(); } catch { /* Report current-account permission accurately. */ }
            sourceResponse = await unlimitedFetch(`https://${apiEndpoint}/video/${info.ID}`, { headers: await getAuth() });
          }
          queueFailure = { ...queueHttpFailure(sourceResponse, "video_api"), reason: "unverified_response" };
          let sourceResult = await sourceResponse.json();
          // HTML/proxy rejection is not proof of a removed/private Iwara video.
          if (sourceResult && typeof sourceResult === "object" && !Array.isArray(sourceResult)) queueFailure.reason = "";
          if (!sourceResponse.ok) {
            Type = "fail";
            return { ID, Type, RAW, Msg: sourceResult.message || `Iwara HTTP ${sourceResponse.status}`, Failure: queueFailure };
          }
          if (isNullOrUndefined(sourceResult.id)) {
            Type = "fail";
            return {
              ID,
              Type,
              RAW,
              Msg: sourceResult.message ?? stringify(sourceResult),
              Failure: { ...queueFailure, reason: /private|permission|unauthorized/i.test(sourceResult.message || "") ? "permission_denied" : "" }
            };
          }
          RAW = sourceResult;
          ID = RAW.id;
          Type = "full";
          break;
        default:
          Type = "fail";
          return {
            ID,
            Type,
            RAW,
            Msg: "Unknown type"
          };
      }
    } catch (error) {
      newToast(
        3,
        {
          node: toastNode([
            `${info.RAW?.title}[${ID}] %#parsingFailed#%`
          ], "%#createTask#%"),
          async onClick() {
            this.hide();
          }
        }
      ).show();
      Type = "fail";
      return {
        ID,
        Type,
        RAW,
        Msg: stringify(error),
        Failure: queueFailure
      };
    }
    let FileName;
    let Size;
    let External;
    let ExternalUrl;
    let Description;
    let DownloadQuality;
    let DownloadUrl;
    let Comments;
    let UploadTime;
    let Title;
    let Tags;
    let Liked;
    let Alias;
    let Author;
    let AuthorID;
    let Private;
    let Unlisted;
    let Following;
    let Friend;
    UploadTime = new Date(RAW.createdAt ?? 0).getTime();
    Title = RAW.title;
    Tags = RAW.tags;
    Liked = RAW.liked;
    Alias = RAW.user.name;
    Author = RAW.user.username;
    AuthorID = RAW.user.id;
    const Views = RAW.views ?? RAW.viewCount ?? RAW.numViews ?? null;
    Private = RAW.private;
    Unlisted = RAW.unlisted;
    External = !isNullOrUndefined(RAW.embedUrl) && !RAW.embedUrl.isEmpty();
    ExternalUrl = RAW.embedUrl;
    if (External) {
      Type = "fail";
      return {
        Type,
        RAW,
        ID,
        Alias,
        Author,
        AuthorID,
        Private,
        UploadTime,
        Title,
        Views,
        Tags,
        Liked,
        External,
        ExternalUrl,
        Description,
        Unlisted,
        Msg: "external Video"
      };
    }
    try {
      switch (Type) {
        case "full":
          Following = RAW.user.following;
          Friend = RAW.user.friend;
          if (Following) {
            await db.putFollow(RAW.user);
          } else {
            await db.deleteFollow(AuthorID);
          }
          if (Friend) {
            await db.putFriend(RAW.user);
          } else {
            await db.deleteFriend(AuthorID);
          }
          Description = RAW.body;
          FileName = RAW.file.name;
          Size = RAW.file.size;
          queueFailure = { stage: "source_api" };
          const fileResponse = await unlimitedFetch(RAW.fileUrl, { headers: await getAuth(RAW.fileUrl) });
          queueFailure = queueHttpFailure(fileResponse, "source_api");
          if (!fileResponse.ok) throw new Error(`媒体源接口 HTTP ${fileResponse.status}`);
          let VideoFileSource = (await fileResponse.json()).sort((a2, b2) => (!isNullOrUndefined(config.priority[b2.name]) ? config.priority[b2.name] : 0) - (!isNullOrUndefined(config.priority[a2.name]) ? config.priority[a2.name] : 0));
          if (isNullOrUndefined(VideoFileSource) || !(VideoFileSource instanceof Array) || VideoFileSource.length < 1) throw new Error(i18nList[config.language].getVideoSourceFailed.toString());
          DownloadQuality = config.checkPriority ? config.downloadPriority : VideoFileSource[0].name;
          let fileList = VideoFileSource.filter((x2) => x2.name === DownloadQuality);
          if (!fileList.any()) throw new Error(i18nList[config.language].noAvailableVideoSource.toString());
          const excludedHosts = new Set(excludedSourceHosts.map((host) => host.toLowerCase()));
          if (excludedHosts.size) {
            const untriedFiles = fileList.filter((candidate) => {
              try {
                const value = candidate.src.download;
                const url = value.startsWith("//") ? `https:${value}` : value;
                return !excludedHosts.has(new URL(url).hostname.toLowerCase());
              } catch {
                return true;
              }
            });
            if (!untriedFiles.any()) {
              throw new Error(`所有可用 CDN 源均已失败：${[...excludedHosts].join(", ")}`);
            }
            fileList = untriedFiles;
          }
          let Source = fileList[Math.floor(Math.random() * fileList.length)].src.download;
          if (isNullOrUndefined(Source) || Source.isEmpty()) throw new Error(i18nList[config.language].videoSourceNotAvailable.toString());
          DownloadUrl = decodeURIComponent(`https:${Source}`);
          GM_getValue("isDebug") && originalConsole.debug(`[debug] try parse all comment`);
          Comments = includeComments ? JSON.stringify(await getCommentDatas(ID)).normalize("NFKC") : "[]";
          return {
            Type,
            RAW,
            ID,
            Alias,
            Author,
            AuthorID,
            Private,
            UploadTime,
            Title,
            Views,
            Tags,
            Liked,
            External,
            FileName,
            DownloadQuality,
            ExternalUrl,
            Description,
            Comments,
            DownloadUrl,
            Size,
            Following,
            Unlisted,
            Friend
          };
        case "partial":
          return {
            Type,
            RAW,
            ID,
            Alias,
            Author,
            AuthorID,
            UploadTime,
            Title,
            Tags,
            Liked,
            External,
            ExternalUrl,
            Unlisted,
            Private
          };
        default:
          Type = "fail";
          return {
            Type,
            RAW,
            ID,
            Alias,
            Author,
            AuthorID,
            Private,
            UploadTime,
            Title,
            Tags,
            Liked,
            External,
            ExternalUrl,
            Description,
            Unlisted,
            Msg: "Unknown type"
          };
      }
    } catch (error) {
      Type = "fail";
      return {
        Type,
        RAW,
        ID,
        Alias,
        Author,
        AuthorID,
        Private,
        UploadTime,
        Title,
        Tags,
        Liked,
        External,
        ExternalUrl,
        Description,
        Unlisted,
        Msg: stringify(error),
        Failure: queueFailure
      };
    }
  }
  function getVideoInfoCompleteness(info) {
    switch (info.Type) {
      case "full":
        return 5;
      case "partial":
        return 4;
      case "fail":
        return 3;
      case "cache":
        return 2;
      case "init":
        return 1;
    }
  }
  function getMoreCompleteVideoInfo(a2, b2) {
    if (a2.ID !== b2.ID) throw new Error(`VideoInfo ID mismatch: "${a2.ID}" vs "${b2.ID}"`);
    const completenessA = getVideoInfoCompleteness(a2);
    const completenessB = getVideoInfoCompleteness(b2);
    return completenessB > completenessA ? b2 : a2;
  }
  async function fetchAndCachePage(page) {
    const auth = await getAuth();
    const response = await unlimitedFetch(
      `https://${apiEndpoint}/videos?sort=date&page=${page}&limit=50`,
      { headers: auth },
      {
        retry: true,
        maxRetries: 3,
        retryDelay: 3e3,
        failStatus: [403, 404, 429],
        onRetry: async () => {
          await refreshToken();
        }
      }
    );
    if (!response.ok) return false;
    const pageData = await response.json();
    const rawVideos = pageData.results;
    if (pageData.page * pageData.limit >= pageData.count) return "last";
    if (isNullOrUndefined(rawVideos) || rawVideos.length === 0) return true;
    const list = [];
    let idx = 0;
    const concurrency = 6;
    const nextParse = async () => {
      if (idx >= rawVideos.length) return;
      const i = idx++;
      try {
        const info = await parseVideoInfo({ Type: "cache", ID: rawVideos[i].id, RAW: rawVideos[i] });
        if (info.Type === "partial" || info.Type === "full") {
          list.push(info);
        }
      } catch {
      } finally {
        if (idx < rawVideos.length) await delay(100);
        await nextParse();
      }
    };
    await Promise.allSettled(
      Array.from({ length: Math.min(concurrency, rawVideos.length) }, () => nextParse())
    );
    if (list.length > 0) {
      const ids = list.map((v2) => v2.ID);
      const existing = await db.getVideosByIds(ids);
      const fullVideos = existing.filter((v2) => v2.Type === "full");
      const toUpdate = list.difference(fullVideos, "ID");
      if (toUpdate.any()) {
        await db.bulkPutVideos(toUpdate);
        originalConsole.log(`update: ${toUpdate.length} ${toUpdate[0].Title}`);
      }
    }
    return true;
  }
  async function syncAllVideosPages() {
    if (!isLoggedIn()) {
      newToast(2, {
        node: toastNode(`请先登录 iwara`, "页面遍历"),
        duration: 3e3
      }).show();
      return;
    }
    const progressNode = renderNode({
      nodeType: "p",
      childs: `正在遍历视频页面...`
    });
    const progressToast = newToast(1, {
      node: progressNode,
      duration: -1
    });
    progressToast.show();
    let succeeded = 0;
    const failedPages = [];
    let page = site_default.syncStartPage;
    while (true) {
      try {
        const result = await fetchAndCachePage(page);
        if (result === "last") {
          succeeded++;
          progressNode.firstChild.textContent = `正在遍历视频页面... 已是最后一页 (${page})，提前结束`;
          break;
        }
        if (result === false) {
          originalConsole.warn(`[SyncPages] 页面 ${page} 失败`);
          failedPages.push(page);
          await delay(5e3 + Math.random() * 1e3);
          page++;
          continue;
        }
        succeeded++;
        progressNode.firstChild.textContent = `正在遍历视频页面... 第 ${page} 页 (失败: ${failedPages.length})`;
      } catch (error) {
        originalConsole.warn(`[SyncPages] 页面 ${page} 异常:`, stringify(error));
        failedPages.push(page);
      }
      await delay(500 + Math.random() * 1e3);
      page++;
    }
    let retryFailed = [];
    if (failedPages.length > 0) {
      progressNode.firstChild.textContent = `正在重试 ${failedPages.length} 个失败页面...`;
      for (const retryPage of failedPages) {
        try {
          const result = await fetchAndCachePage(retryPage);
          if (result === false) {
            originalConsole.warn(`[SyncPages] 重试页面 ${retryPage} 仍失败`);
            retryFailed.push(retryPage);
            continue;
          }
          succeeded++;
          progressNode.firstChild.textContent = `正在重试失败页面... ${retryPage} 成功 (剩余 ${failedPages.length - retryFailed.length - (failedPages.indexOf(retryPage) + 1 - retryFailed.length)} 个待重试)`;
        } catch (error) {
          originalConsole.warn(`[SyncPages] 重试页面 ${retryPage} 异常:`, stringify(error));
          retryFailed.push(retryPage);
        }
        await delay(500 + Math.random() * 1e3);
      }
    }
    progressToast.hide();
    newToast(1, {
      text: `页面遍历完成！成功: ${succeeded} 页${retryFailed.length > 0 ? `，重试后仍失败: ${retryFailed.length} 页` : "，无失败"}`,
      close: true,
      onClick() {
        this.hide();
      }
    }).show();
    if (retryFailed.length > 0) {
      originalConsole.warn(`[SyncPages] 始终失败的页码: ${retryFailed.join(", ")}`);
    }
  }
  var GMLock = class _GMLock {
    static PREFIX = "GMLock:";
    owner;
    constructor(owner) {
      this.owner = owner;
    }
    static key(name) {
      return _GMLock.PREFIX + name;
    }
    acquire(name, ttl) {
      const key = _GMLock.key(name);
      const now = Date.now();
      const current = GM_getValue(key);
      if (current && current.owner !== this.owner && current.expires > now) return false;
      GM_setValue(key, { owner: this.owner, expires: now + ttl });
      return true;
    }
    renew(name, ttl) {
      const key = _GMLock.key(name);
      const current = GM_getValue(key);
      if (current?.owner !== this.owner) return false;
      GM_setValue(key, { owner: this.owner, expires: Date.now() + ttl });
      return true;
    }
    isHeld(name) {
      const value = GM_getValue(_GMLock.key(name));
      return !!value && value.owner === this.owner && value.expires > Date.now();
    }
    release(name) {
      const key = _GMLock.key(name);
      if (GM_getValue(key)?.owner === this.owner) {
        GM_deleteValue(key);
      }
    }
    static pruneExpired() {
      const now = Date.now();
      for (const key of GM_listValues()) {
        if (!key.startsWith(_GMLock.PREFIX)) continue;
        const value = GM_getValue(key);
        if (!value || value.expires <= now) GM_deleteValue(key);
      }
    }
  };
  async function aria2API(method, params) {
    return await (await unlimitedFetch(
      config.aria2Path,
      {
        headers: {
          "accept": "application/json",
          "content-type": "application/json"
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          method,
          id: UUID(),
          params: [`token:${config.aria2Token}`, ...params]
        }, (_, v2) => typeof v2 === "boolean" ? String(v2) : v2),
        method: "POST"
      }
    )).json();
  }
  function aria2TaskExtractVideoID(task) {
    try {
      if (isNullOrUndefined(task.files) || task.files.length !== 1) return;
      const file = task.files[0];
      if (isNullOrUndefined(file)) return;
      if (file.uris.length < 1) return;
      let downloadUrl = file.uris[0].uri.toURL();
      if (isNullOrUndefined(downloadUrl)) return;
      let videoID;
      if (downloadUrl.searchParams.has("videoid")) videoID = downloadUrl.searchParams.get("videoid");
      if (!isNullOrUndefined(videoID) && !videoID.isEmpty()) return videoID;
      if (isNullOrUndefined(file.path) || file.path.isEmpty()) return;
      let path = analyzeLocalPath(file.path);
      if (isNullOrUndefined(path.fullName) || path.fullName.isEmpty()) return;
      videoID = path.fullName.toLowerCase().among("[", "].mp4", false, true);
      if (videoID.isEmpty()) return;
      return videoID;
    } catch (error) {
      GM_getValue("isDebug") && originalConsole.debug(`[Debug] check aria2 task file fail! ${stringify(task)}`);
      return;
    }
  }
  async function aria2Download(videoInfo, overwrite = void 0) {
    const downloadUrl = buildDownloadUrl(videoInfo);
    const localPath = getDownloadPath(videoInfo);
    const downloadParams = prune({
      "allow-overwrite": true,
      "all-proxy": config.downloadProxy,
      "all-proxy-passwd": !config.downloadProxy.isEmpty() ? config.downloadProxyPassword : void 0,
      "all-proxy-user": !config.downloadProxy.isEmpty() ? config.downloadProxyUsername : void 0,
      "out": localPath.fullName,
      "dir": localPath.directory,
      "referer": window.location.hostname,
      "header": [
        "Cookie:" + unsafeWindow.document.cookie
      ]
    });
    try {
      let res = await aria2API("aria2.addUri", [[downloadUrl.href], downloadParams]);
      if (res.result.isEmpty()) throw `aria2 下载失败：${stringify(res)}`;
      newToast(
        1,
        {
          gravity: "bottom",
          node: toastNode(`${videoInfo.Title}[${videoInfo.ID}] %#pushTaskSucceed#%`)
        }
      ).show();
      enqueueAria2TrackTask(videoInfo.ID, res.result, downloadParams);
    } catch (error) {
      newToast(
        1,
        {
          gravity: "bottom",
          node: toastNode(`${videoInfo.Title}[${videoInfo.ID}] %#pushTaskFail#%`)
        }
      ).show();
    }
  }
  async function aria2TaskCheckAndRestart() {
    try {
      let stoped = prune(
        (await aria2API(
          "aria2.tellStopped",
          [
            0,
            4096,
            [
              "gid",
              "status",
              "files",
              "errorCode",
              "bittorrent"
            ]
          ]
        )).result.filter(
          (task) => isNullOrUndefined(task.bittorrent)
        ).map(
          (task) => {
            let ID = aria2TaskExtractVideoID(task);
            if (!isNullOrUndefined(ID) && !ID.isEmpty()) {
              return {
                id: ID,
                data: task
              };
            }
          }
        )
      );
      let active = prune(
        (await aria2API(
          "aria2.tellActive",
          [
            [
              "gid",
              "status",
              "files",
              "downloadSpeed",
              "completedLength",
              "totalLength",
              "bittorrent"
            ]
          ]
        )).result.filter(
          (task) => isNullOrUndefined(task.bittorrent)
        ).map(
          (task) => {
            let ID = aria2TaskExtractVideoID(task);
            if (!isNullOrUndefined(ID) && !ID.isEmpty()) {
              return {
                id: ID,
                data: task
              };
            }
          }
        )
      );
      let downloadNormalTasks = active.filter(
        (task) => isConvertibleToNumber(task.data.downloadSpeed) && Number(task.data.downloadSpeed) >= ARIA2_SLOW_SPEED_THRESHOLD
      ).unique("id");
      let downloadCompleted = stoped.filter(
        (task) => task.data.status === "complete"
        //|| task.data.errorCode === '13'
      ).unique("id");
      let downloadUncompleted = stoped.difference(downloadCompleted, "id").difference(downloadNormalTasks, "id");
      let downloadToSlowTasks = active.filter(
        (task) => {
          if (!isConvertibleToNumber(task.data.downloadSpeed) || Number(task.data.downloadSpeed) > ARIA2_SLOW_SPEED_THRESHOLD) return false;
          return Number(task.data.downloadSpeed) === 0 || getAria2Progress(task.data) <= 0.95;
        }
      ).unique("id");
      let needRestart = downloadUncompleted.union(downloadToSlowTasks, "id");
      if (needRestart.length !== 0) {
        newToast(
          2,
          {
            id: "aria2TaskCheckAndRestart",
            node: toastNode(
              [
                `发现 ${needRestart.length} 个需要重启的下载任务！`,
                { nodeType: "br" },
                "%#tryRestartingDownload#%"
              ],
              "%#aria2TaskCheck#%"
            ),
            async onClick() {
              this.hide();
              for (let i = 0; i < needRestart.length; i++) {
                const task = needRestart[i];
                let info = await parseVideoInfo({
                  Type: "init",
                  ID: task.id
                });
                if (info.Type != "full") {
                  newToast(
                    3,
                    {
                      node: toastNode([
                        `${info.Title}[${info.ID}] %#parsingFailed#%`
                      ], "%#aria2TaskCheck#%"),
                      onClick() {
                        this.hide();
                      }
                    }
                  ).show();
                  continue;
                }
                try {
                  GM_getValue("isDebug") && originalConsole.debug(`[Debug] aria2TaskCheckAndRestart: 处理任务 ${task.data.gid} 状态 ${task.data.status}`, task.data);
                  switch (task.data.status) {
                    case "waiting":
                    case "active":
                      GM_getValue("isDebug") && originalConsole.debug(`[Debug] aria2TaskCheckAndRestart: 暂停活跃任务 ${task.data.gid}`);
                      const pauseRes = await aria2API("aria2.forcePause", [task.data.gid]);
                      if (pauseRes.error) {
                        originalConsole.warn(`[aria2TaskCheckAndRestart] forcePause 失败 ${task.data.gid}:`, pauseRes.error);
                        break;
                      }
                    case "paused":
                      let localPath = getDownloadPath(info);
                      let downloadUrl = info.DownloadUrl.toURL();
                      downloadUrl.searchParams.set("videoid", info.ID);
                      downloadUrl.searchParams.set("download", localPath.fullName);
                      const oldUris = (task.data.files?.[0]?.uris ?? []).map((u) => u.uri);
                      GM_getValue("isDebug") && originalConsole.debug(
                        `[Debug] aria2TaskCheckAndRestart: 替换 URIs - 任务 ${task.data.gid}`,
                        { oldUris, newUrl: downloadUrl.href }
                      );
                      const changeRes = await aria2API("aria2.changeUri", [
                        task.data.gid,
                        1,
                        oldUris,
                        [downloadUrl.href]
                      ]);
                      if (changeRes.error) {
                        originalConsole.warn(`[aria2TaskCheckAndRestart] changeUri 失败 ${task.data.gid}:`, changeRes.error);
                        break;
                      }
                      GM_getValue("isDebug") && originalConsole.debug(`[Debug] aria2TaskCheckAndRestart: changeUri 返回`, changeRes.result);
                      GM_getValue("isDebug") && originalConsole.debug(`[Debug] aria2TaskCheckAndRestart: 恢复下载 ${task.data.gid}`);
                      const unpauseRes = await aria2API("aria2.unpause", [task.data.gid]);
                      if (unpauseRes.error) {
                        originalConsole.warn(`[aria2TaskCheckAndRestart] unpause 失败 ${task.data.gid}:`, unpauseRes.error);
                        break;
                      }
                      newToast(1, {
                        gravity: "bottom",
                        node: toastNode(`${info.Title}[${info.ID}] %#pushTaskSucceed#%`)
                      }).show();
                      break;
                    case "complete":
                    case "error":
                    case "removed":
                      aria2Download(info, true);
                      break;
                    default:
                      break;
                  }
                } catch (error) {
                  newToast(
                    3,
                    {
                      node: toastNode([
                        `${info.RAW?.title ?? info.Title}[${info.ID}] %#pushTaskFail#%`,
                        { nodeType: "br" },
                        stringify(error)
                      ], "%#aria2TaskCheck#%"),
                      onClick() {
                        this.hide();
                      }
                    }
                  ).show();
                  break;
                }
              }
            }
          }
        ).show();
      } else {
        newToast(1, {
          id: "aria2TaskCheckAndRestart",
          duration: 1e4,
          node: toastNode(
            `%#noAria2TasksNeedRestart#%`
          )
        }).show();
      }
    } catch (error) {
      newToast(3, {
        id: "aria2TaskCheckAndRestart",
        node: toastNode(
          [
            `%#aria2TaskRestartError#%`,
            { nodeType: "br" },
            stringify(error)
          ]
        )
      }).show();
    }
  }
  var ARIA2_TRACK_QUEUE_KEY = "Aria2TrackQueue";
  var ARIA2_TRACK_MANAGER_LOCK = "aria2TrackManager";
  var ARIA2_TRACK_MANAGER_TTL = 75e3;
  var ARIA2_TRACK_ELECTION_INTERVAL = 5e3;
  var ARIA2_TRACK_SCAN_INTERVAL = 6e4;
  var ARIA2_TRACK_POLL_INTERVAL = 1e3 * 10 * 3;
  var ARIA2_SLOW_SPEED_THRESHOLD = 64 * 1024;
  var aria2TrackOwner = UUID();
  var aria2TrackLock = new GMLock(aria2TrackOwner);
  var aria2TrackManagerLoopRunning = false;
  var aria2TrackWorkers = new Set();
  var aria2TrackQueue = new GMSyncDictionary(
    ARIA2_TRACK_QUEUE_KEY,
    [],
    (value) => isString(value?.videoId) && isString(value?.gid)
  );
  aria2TrackQueue.onSet = () => {
    if (aria2TrackLock.isHeld(ARIA2_TRACK_MANAGER_LOCK)) syncAria2TrackWorkers();
  };
  aria2TrackQueue.onDel = () => {
    if (aria2TrackLock.isHeld(ARIA2_TRACK_MANAGER_LOCK)) syncAria2TrackWorkers();
  };
  aria2TrackQueue.onSync = () => {
    if (aria2TrackLock.isHeld(ARIA2_TRACK_MANAGER_LOCK)) syncAria2TrackWorkers();
  };
  function buildDownloadUrl(videoInfo) {
    const localPath = getDownloadPath(videoInfo);
    const url = videoInfo.DownloadUrl.toURL();
    url.searchParams.set("videoid", videoInfo.ID);
    url.searchParams.set("download", localPath.fullName);
    return url;
  }
  function enqueueAria2TrackTask(videoId, gid, downloadParams) {
    aria2TrackQueue.set(videoId, { videoId, gid, downloadParams, addedAt: Date.now() });
  }
  function hasAria2TrackTask(videoId) {
    return aria2TrackQueue.has(videoId);
  }
  function removeAria2TrackTask(videoId) {
    aria2TrackQueue.delete(videoId);
  }
  function updateAria2TrackTaskGid(videoId, gid) {
    const task = aria2TrackQueue.get(videoId);
    if (task) aria2TrackQueue.set(videoId, { ...task, gid });
  }
  function getAria2Progress(status) {
    if (!isConvertibleToNumber(status.completedLength) || !isConvertibleToNumber(status.totalLength)) return 0;
    const total = Number(status.totalLength);
    if (total <= 0) return 0;
    return Math.min(1, Number(status.completedLength) / total);
  }
  async function processAria2TrackTask(task) {
    let info = await db.getVideoById(task.videoId);
    if (info?.Type !== "full") {
      const parsed = await parseVideoInfo({ Type: "init", ID: task.videoId, RAW: info?.RAW });
      info = getMoreCompleteVideoInfo(info ?? { Type: "init", ID: task.videoId }, parsed);
    }
    if (info.Type !== "full") {
      originalConsole.warn(`[Aria2Track] ${task.videoId} 初始化解析失败 (${info.Type})，从队列移除`);
      removeAria2TrackTask(task.videoId);
      return;
    }
    let videoInfo = info;
    let currentGid = task.gid;
    let consecutiveFailures = 0;
    while (true) {
      await delay(ARIA2_TRACK_POLL_INTERVAL);
      if (!aria2TrackLock.isHeld(ARIA2_TRACK_MANAGER_LOCK)) return;
      if (!hasAria2TrackTask(task.videoId)) return;
      try {
        const statusRes = await aria2API("aria2.tellStatus", [
          currentGid,
          ["gid", "status", "files", "downloadSpeed", "errorCode", "completedLength", "totalLength"]
        ]);
        const status = statusRes.result;
        if (!status?.status) {
          continue;
        }
        consecutiveFailures = 0;
        switch (status.status) {
          case "complete":
            GM_getValue("isDebug") && originalConsole.debug(`[Aria2Track] ${task.videoId} 下载完成`);
            if (config.experimentalFeatures) {
              await pushToMediaCenter(videoInfo);
            }
            removeAria2TrackTask(task.videoId);
            return;
          case "error":
          case "removed":
            originalConsole.warn(`[Aria2Track] ${task.videoId} 任务 ${status.status}，重新创建下载`);
            try {
              const freshInfo = await parseVideoInfo({ Type: "init", ID: task.videoId });
              if (freshInfo.Type === "full") {
                videoInfo = freshInfo;
                const newRes = await aria2API("aria2.addUri", [[buildDownloadUrl(freshInfo).href], task.downloadParams]);
                if (!newRes?.result?.isEmpty()) {
                  currentGid = newRes.result;
                  updateAria2TrackTaskGid(task.videoId, currentGid);
                }
              }
            } catch {
            }
            break;
          case "active":
            if (isConvertibleToNumber(status.downloadSpeed) && Number(status.downloadSpeed) <= ARIA2_SLOW_SPEED_THRESHOLD) {
              const speed = Number(status.downloadSpeed);
              if (speed === 0 || getAria2Progress(status) <= 0.98) {
                GM_getValue("isDebug") && originalConsole.debug(`[Aria2Track] ${task.videoId} 速度过慢，重启`);
                const freshActive = await restartAria2Task(currentGid, task.videoId, status);
                if (freshActive) videoInfo = freshActive;
              }
            }
            break;
          case "waiting":
            break;
          case "paused":
            if (await isAria2QueueFull()) {
              GM_getValue("isDebug") && originalConsole.debug(`[Aria2Track] ${task.videoId} 队列已满，暂不重启`);
            } else {
              GM_getValue("isDebug") && originalConsole.debug(`[Aria2Track] ${task.videoId} 已暂停，重启`);
              const freshPaused = await restartAria2Task(currentGid, task.videoId, status);
              if (freshPaused) videoInfo = freshPaused;
            }
            break;
        }
      } catch (error) {
        originalConsole.warn(`[Aria2Track] 追踪异常 ${currentGid}:`, stringify(error));
        consecutiveFailures++;
        if (consecutiveFailures > 5) {
          originalConsole.warn(`[Aria2Track] 任务 ${currentGid} 持续异常，从队列移除`);
          removeAria2TrackTask(task.videoId);
          return;
        }
      }
    }
  }
  function syncAria2TrackWorkers() {
    for (const task of aria2TrackQueue.valuesArray()) {
      if (aria2TrackWorkers.has(task.videoId)) continue;
      aria2TrackWorkers.add(task.videoId);
      GM_getValue("isDebug") && originalConsole.debug(`[Aria2Track] 管理器开始处理 ${task.videoId} (gid=${task.gid})`);
      processAria2TrackTask(task).finally(() => {
        aria2TrackWorkers.delete(task.videoId);
      });
    }
  }
  async function tryBecomeAria2TrackManager() {
    if (aria2TrackManagerLoopRunning) return;
    aria2TrackManagerLoopRunning = true;
    try {
      if (!aria2TrackLock.acquire(ARIA2_TRACK_MANAGER_LOCK, ARIA2_TRACK_MANAGER_TTL)) return;
      GM_getValue("isDebug") && originalConsole.debug("[Aria2Track] 本页成为管理器，接管整个队列");
      await startAria2TrackManagerLoop();
    } finally {
      aria2TrackManagerLoopRunning = false;
    }
  }
  async function startAria2TrackManagerLoop() {
    syncAria2TrackWorkers();
    while (aria2TrackLock.renew(ARIA2_TRACK_MANAGER_LOCK, ARIA2_TRACK_MANAGER_TTL)) {
      await delay(ARIA2_TRACK_MANAGER_TTL / 3);
      syncAria2TrackWorkers();
    }
    GM_getValue("isDebug") && originalConsole.debug("[Aria2Track] 管理器锁过期/被抢占，停止处理队列");
  }
  async function scanAria2TasksAndEnqueue() {
    try {
      const [actRes, stopRes] = await Promise.all([
        aria2API("aria2.tellActive", [["gid", "status", "files", "bittorrent"]]),
        aria2API("aria2.tellStopped", [0, 4096, ["gid", "status", "files", "bittorrent"]])
      ]);
      const activeRes = actRes;
      const stoppedRes = stopRes;
      const allTasks = [...activeRes.result ?? [], ...stoppedRes.result ?? []].filter((t) => isNullOrUndefined(t.bittorrent));
      for (const task of allTasks) {
        const videoId = aria2TaskExtractVideoID(task);
        if (isNullOrUndefined(videoId) || videoId.isEmpty()) continue;
        if (hasAria2TrackTask(videoId)) continue;
        const existingMapping = await db.getMediaCenterIdMap(videoId);
        if (!isNullOrUndefined(existingMapping) && !existingMapping.isEmpty()) continue;
        let info = await db.getVideoById(videoId);
        if (!info || info.Type === "cache" || info.Type === "init" || info.Type === "fail") {
          info = await parseVideoInfo({ Type: "init", ID: videoId });
        } else if (info.Type === "partial") {
          info = await parseVideoInfo(info);
        }
        if (info.Type !== "full") {
          originalConsole.warn(`[Aria2Track] 入队 ${videoId} 解析失败 (${info.Type})，跳过`);
          continue;
        }
        const localPath = getDownloadPath(info);
        const downloadParams = prune({
          "allow-overwrite": true,
          "all-proxy": config.downloadProxy,
          "all-proxy-passwd": !config.downloadProxy.isEmpty() ? config.downloadProxyPassword : void 0,
          "all-proxy-user": !config.downloadProxy.isEmpty() ? config.downloadProxyUsername : void 0,
          "out": localPath.fullName,
          "dir": localPath.directory,
          "referer": window.location.hostname,
          "header": ["Cookie:" + unsafeWindow.document.cookie]
        });
        GM_getValue("isDebug") && originalConsole.debug(`[Aria2Track] 现有任务 ${videoId} 已纳入队列 (gid=${task.gid})`);
        enqueueAria2TrackTask(videoId, task.gid, downloadParams);
      }
    } catch (error) {
      originalConsole.warn("[Aria2Track] 扫描 aria2 任务失败:", stringify(error));
    }
  }
  async function isAria2QueueFull() {
    try {
      const [statRes, optRes] = await Promise.all([
        aria2API("aria2.getGlobalStat", []),
        aria2API("aria2.getGlobalOption", [])
      ]);
      const numActive = parseInt(statRes.result?.numActive ?? "0", 10);
      const maxConcurrent = parseInt(optRes.result?.["max-concurrent-downloads"] ?? "5", 10);
      return numActive >= maxConcurrent;
    } catch {
      return false;
    }
  }
  async function restartAria2Task(gid, videoId, task) {
    try {
      const freshInfo = await parseVideoInfo({ Type: "init", ID: videoId });
      if (freshInfo.Type !== "full") {
        originalConsole.warn(`[Aria2Track] restartAria2Task ${videoId} 重新解析失败 (${freshInfo.Type})`);
        return void 0;
      }
      const oldUris = (task.files?.[0]?.uris ?? []).map((u) => u.uri);
      await aria2API("aria2.changeUri", [gid, 1, oldUris, [buildDownloadUrl(freshInfo).href]]);
      await aria2API("aria2.unpause", [gid]);
      return freshInfo;
    } catch (error) {
      originalConsole.warn(`[Aria2Track] restartAria2Task 失败 ${gid}:`, stringify(error));
      return void 0;
    }
  }
  async function pushToMediaCenter(videoInfo, mediaCenterId = void 0) {
    if (config.mediaCenterApi.isEmpty() || config.mediaCenterApiKey.isEmpty()) return false;
    const apiBase = config.mediaCenterApi.replace(/\/+$/, "");
    const authHeaders = {
      "accept": "application/json",
      "content-type": "application/json",
      "authorization": `Bearer ${config.mediaCenterApiKey}`
    };
    const downloadPath = getDownloadPath(videoInfo);
    try {
      if (isNullOrUndefined(mediaCenterId) || mediaCenterId.isEmpty()) {
        const createBody = prune({
          filePath: downloadPath.fullPath,
          fileHash: videoInfo.ID
        });
        const createRes = await unlimitedFetch(`${apiBase}/api/media`, {
          method: "POST",
          headers: authHeaders,
          body: JSON.stringify(createBody)
        });
        if (createRes.status === 409) {
          const conflict = await createRes.json();
          if (conflict.existingId && !conflict.existingId.isEmpty()) {
            mediaCenterId = conflict.existingId;
            await db.putMediaCenterIdMap(videoInfo.ID, mediaCenterId);
            GM_getValue("isDebug") && originalConsole.debug(`[MediaCenter] createMedia 409, reuse existing ${videoInfo.ID} → ${mediaCenterId}`);
          } else {
            originalConsole.warn(`[MediaCenter] createMedia 409 but no existingId for ${videoInfo.ID}: ${conflict.error}`);
            return false;
          }
        } else if (!createRes.ok) {
          originalConsole.warn(`[MediaCenter] createMedia failed for ${videoInfo.ID}: ${createRes.status} ${await createRes.text()}`);
          return false;
        } else {
          const createResult = await createRes.json();
          if (createResult.error) {
            originalConsole.warn(`[MediaCenter] createMedia error for ${videoInfo.ID}: ${createResult.error}`);
            return false;
          }
          if (!createResult.id || createResult.id.isEmpty()) {
            originalConsole.warn(`[MediaCenter] createMedia returned no id for ${videoInfo.ID}`);
            return false;
          }
          mediaCenterId = createResult.id;
          await db.putMediaCenterIdMap(videoInfo.ID, mediaCenterId);
        }
      }
      const updateBody = prune({
        filePath: downloadPath.fullPath,
        fileHash: videoInfo.ID,
        title: videoInfo.Title,
        description: videoInfo.Description ?? "",
        source: "iwara",
        author: videoInfo.Author || videoInfo.Alias,
        tags: (videoInfo.Tags ?? []).map((t) => t.id),
        duration: videoInfo.RAW?.file?.duration,
        sourceMeta: videoInfo.RAW ? JSON.stringify(videoInfo.RAW) : void 0,
        createdAt: new Date(videoInfo.UploadTime).toISOString()
      });
      const updateRes = await unlimitedFetch(`${apiBase}/api/media/${mediaCenterId}`, {
        method: "PUT",
        headers: authHeaders,
        body: JSON.stringify(updateBody)
      });
      if (!updateRes.ok) {
        originalConsole.warn(`[MediaCenter] updateMedia failed for ${videoInfo.ID}: ${updateRes.status} ${await updateRes.text()}`);
        return false;
      }
      const updateResult = await updateRes.json();
      if (updateResult.error) {
        originalConsole.warn(`[MediaCenter] updateMedia error for ${videoInfo.ID}: ${updateResult.error}`);
        return false;
      }
      if (!updateResult.media) {
        originalConsole.warn(`[MediaCenter] updateMedia returned no media for ${videoInfo.ID}`);
        return false;
      }
      GM_getValue("isDebug") && originalConsole.debug("[Debug] MediaCenter metadata pushed:", videoInfo.ID, "→", mediaCenterId);
      return true;
    } catch (error) {
      originalConsole.warn(`[MediaCenter] Push metadata error for ${videoInfo.ID}:`, stringify(error));
    }
    return false;
  }
  async function trackExistingAria2Tasks() {
    if (config.downloadType !== 0) return;
    await scanAria2TasksAndEnqueue();
    await tryBecomeAria2TrackManager();
    setInterval(() => {
      tryBecomeAria2TrackManager();
    }, ARIA2_TRACK_ELECTION_INTERVAL);
    setInterval(() => {
      scanAria2TasksAndEnqueue();
    }, ARIA2_TRACK_SCAN_INTERVAL);
    setInterval(() => {
      GMLock.pruneExpired();
    }, ARIA2_TRACK_SCAN_INTERVAL);
    originalAddEventListener.call(unsafeWindow, "pagehide", () => {
      aria2TrackLock.release(ARIA2_TRACK_MANAGER_LOCK);
    });
  }
  async function syncCachedToMediaCenter() {
    if (config.mediaCenterApi.isEmpty() || config.mediaCenterApiKey.isEmpty()) {
      newToast(2, {
        node: toastNode(`请先配置 MediaCenter API 地址和密钥`, "MediaCenter 同步"),
        duration: 3e3
      }).show();
      return;
    }
    const apiBase = config.mediaCenterApi.replace(/\/+$/, "");
    const authHeaders = {
      "accept": "application/json",
      "content-type": "application/json",
      "authorization": `Bearer ${config.mediaCenterApiKey}`
    };
    const total = await db.countVideos();
    if (total === 0) {
      newToast(1, {
        text: `没有找到缓存的视频数据`,
        duration: 3e3
      }).show();
      return;
    }
    const phaseStartTime = Date.now();
    let stepStartTime = phaseStartTime;
    const matchedMap = await db.getAllMediaCenterIdMaps();
    originalConsole.debug(`[MediaCenter] 步骤1/4 加载本地映射缓存: ${((Date.now() - stepStartTime) / 1e3).toFixed(1)}s`);
    stepStartTime = Date.now();
    const listProgressNode = renderNode({
      nodeType: "p",
      childs: `正在从 MediaCenter 拉取视频列表...`
    });
    const listProgressToast = newToast(1, {
      node: listProgressNode,
      duration: -1
    });
    listProgressToast.show();
    try {
      const listUrl = `${apiBase}/api/media?limit=0&sortBy=createdAt&sortOrder=desc`;
      const response = await unlimitedFetch(listUrl, { headers: authHeaders });
      if (!response.ok) {
        throw new Error(`拉取 MediaCenter 列表失败: ${response.status} ${await response.text()}`);
      }
      const result = await response.json();
      const items = result.items;
      originalConsole.debug(`[MediaCenter] 步骤2/4 拉取 MediaCenter 列表: ${((Date.now() - stepStartTime) / 1e3).toFixed(1)}s（${items.length} 条）`);
      stepStartTime = Date.now();
      listProgressNode.firstChild.textContent = `MediaCenter 列表拉取完成，共 ${items.length} 条记录，正在遍历本地数据库建立映射...`;
      const entriesToSave = [];
      let processedCount = 0;
      const hashToId = new Map();
      const tokenToId = new Map();
      const titleContains = [];
      for (const m2 of items) {
        if (!isNullOrUndefined(m2.fileHash) && !m2.fileHash.isEmpty()) {
          hashToId.set(m2.fileHash, m2.id);
        }
        if (!isNullOrUndefined(m2.title) && !m2.title.isEmpty()) {
          const lowerTitle = m2.title.toLowerCase();
          titleContains.push({ id: m2.id, lowerTitle });
          for (const token of lowerTitle.split(/[^a-z0-9]+/).filter((t) => t.length >= 3)) {
            if (!tokenToId.has(token)) tokenToId.set(token, m2.id);
          }
        }
      }
      const keyIterator = db.iterateVideoKeysBatched(10240);
      let idx2 = 0;
      let currentBatch = [];
      let keyBatchIter = keyIterator[Symbol.asyncIterator]();
      let prefetchDone = false;
      let prefetchPromise = null;
      const batchQueue = [];
      const prefetchNextBatch = async () => {
        const t0 = Date.now();
        const { value, done } = await keyBatchIter.next();
        originalConsole.debug(`[MediaCenter] 批次获取: ${((Date.now() - t0) / 1e3).toFixed(1)}s（${value?.length ?? 0} 条）`);
        if (done) {
          prefetchDone = true;
        } else {
          batchQueue.push(value);
        }
      };
      const ensureBatch = async () => {
        if (batchQueue.length > 0) return true;
        if (prefetchDone) return false;
        if (!prefetchPromise) {
          prefetchPromise = prefetchNextBatch().finally(() => {
            prefetchPromise = null;
          });
        }
        await prefetchPromise;
        return batchQueue.length > 0;
      };
      prefetchPromise = prefetchNextBatch().finally(() => {
        prefetchPromise = null;
      });
      const nextVideo = async () => {
        if (idx2 >= currentBatch.length) {
          if (!await ensureBatch()) return;
          currentBatch = batchQueue.shift();
          idx2 = 0;
          if (batchQueue.length < 2 && !prefetchDone && !prefetchPromise) {
            prefetchPromise = prefetchNextBatch().finally(() => {
              prefetchPromise = null;
            });
          }
        }
        const videoId = currentBatch[idx2++];
        processedCount++;
        if (Date.now() - stepStartTime >= 500 || processedCount === 1 || processedCount === total) {
          listProgressNode.firstChild.textContent = `正在匹配映射... [${processedCount}/${total}] 已映射: ${matchedMap.size}`;
        }
        if (matchedMap.has(videoId)) return nextVideo();
        if (hashToId.has(videoId)) {
          const mcId = hashToId.get(videoId);
          matchedMap.set(videoId, mcId);
          entriesToSave.push({ videoId, mediaCenterId: mcId });
          return nextVideo();
        }
        const videoIdLower = videoId.toLowerCase();
        if (tokenToId.has(videoIdLower)) {
          const mcId = tokenToId.get(videoIdLower);
          matchedMap.set(videoId, mcId);
          entriesToSave.push({ videoId, mediaCenterId: mcId });
          return nextVideo();
        }
        for (const tc of titleContains) {
          if (tc.lowerTitle.indexOf(videoIdLower) !== -1) {
            matchedMap.set(videoId, tc.id);
            entriesToSave.push({ videoId, mediaCenterId: tc.id });
            break;
          }
        }
        return nextVideo();
      };
      await Promise.allSettled(
        Array.from({ length: Math.min(64, total) }, () => nextVideo())
      );
      originalConsole.debug(`[MediaCenter] 步骤3/4 遍历数据库匹配映射: ${((Date.now() - stepStartTime) / 1e3).toFixed(1)}s（${processedCount} 条，映射 ${entriesToSave.length} 条）`);
      stepStartTime = Date.now();
      if (entriesToSave.length > 0) {
        await db.bulkPutMediaCenterIdMaps(entriesToSave);
      }
      originalConsole.debug(`[MediaCenter] 步骤4/4 保存映射到本地: ${((Date.now() - stepStartTime) / 1e3).toFixed(1)}s`);
      const totalTime = (Date.now() - phaseStartTime) / 1e3;
      listProgressNode.firstChild.textContent = `映射建立完成，共 ${matchedMap.size} 条映射（新增 ${entriesToSave.length} 条），总耗时 ${totalTime.toFixed(1)}s`;
    } catch (error) {
      originalConsole.error("[MediaCenter] 拉取列表失败:", stringify(error));
      listProgressToast.hide();
      newToast(3, {
        node: toastNode([
          `MediaCenter 列表拉取失败，请检查 API 地址和密钥`,
          { nodeType: "br" },
          stringify(error)
        ], "MediaCenter 同步"),
        duration: 1e4,
        close: true,
        onClick() {
          this.hide();
        }
      }).show();
      return;
    }
    listProgressToast.hide();
    if (matchedMap.size === 0) {
      newToast(1, {
        text: `MediaCenter 中未找到包含 fileHash 的视频记录，无法同步`,
        duration: 3e3
      }).show();
      return;
    }
    let updated = 0;
    let skipped = 0;
    let updateErrors = 0;
    const updateProgressNode = renderNode({
      nodeType: "p",
      childs: `MediaCenter 更新中... [0/${matchedMap.size}]`
    });
    const updateProgressToast = newToast(1, {
      node: updateProgressNode,
      duration: -1
    });
    updateProgressToast.show();
    const matchedIds = [...matchedMap.keys()];
    const concurrency = 6;
    let idx = 0;
    const nextUpdate = async () => {
      if (idx >= matchedIds.length) return;
      const i = idx++;
      const videoId = matchedIds[i];
      const mediaCenterId = matchedMap.get(videoId);
      try {
        let video = await db.getVideoById(videoId) ?? { Type: "init", ID: videoId };
        if (video.Type !== "full") {
          const pvideo = await parseVideoInfo(video);
          video = getMoreCompleteVideoInfo(video, pvideo);
        }
        if (video.Type === "cache" || video.Type === "init") {
          skipped++;
          return;
        }
        db.putVideo(video);
        if (await pushToMediaCenter(video, mediaCenterId)) {
          updated++;
        } else {
          updateErrors++;
        }
      } catch (error) {
        originalConsole.warn(`[MediaCenter] 同步异常 ${videoId}:`, stringify(error));
        updateErrors++;
      } finally {
        updateProgressNode.firstChild.textContent = `MediaCenter 更新中... [${updated + skipped + updateErrors}/${matchedMap.size}] 更新: ${updated} 跳过: ${skipped} 错误: ${updateErrors}`;
        if (idx < matchedIds.length) await delay(100);
        await nextUpdate();
      }
    };
    await Promise.allSettled(
      Array.from({ length: Math.min(concurrency, matchedIds.length) }, () => nextUpdate())
    );
    updateProgressToast.hide();
    newToast(1, {
      text: `MediaCenter 同步完成！已更新: ${updated}, 跳过: ${skipped}, 错误: ${updateErrors}`,
      duration: 5e3,
      close: true,
      onClick() {
        this.hide();
      }
    }).show();
  }
  var downloadLinks_default = [
    "iwara.zip",
    "pan.baidu",
    "/s/",
    "mega.nz",
    "drive.google.com",
    "aliyundrive",
    "uploadgig",
    "katfile",
    "storex",
    "subyshare",
    "rapidgator",
    "filebe",
    "filespace",
    "mexa.sh",
    "mexashare",
    "mx-sh.net",
    "icerbox",
    "alfafile",
    "1drv.ms",
    "onedrive.",
    "gofile.io",
    "workupload.com",
    "pixeldrain.",
    "dailyuploads.net",
    "katfile.com",
    "fikper.com",
    "frdl.io",
    "rg.to",
    "gigafile.nu",
    "mediafire.com"
  ];
  var DOWNLOAD_LINK_PATTERNS = downloadLinks_default;
  function checkIsHaveDownloadLink(comment) {
    if (!config.checkDownloadLink || isNullOrUndefined(comment) || comment.isEmpty()) {
      return false;
    }
    return DOWNLOAD_LINK_PATTERNS.filter((i) => comment.toLowerCase().includes(i)).any();
  }
  function iwaradlDownload(videoInfo) {
    (async function(videoInfo2) {
      try {
        let proxyURL;
        if (!config.downloadProxy.isEmpty()) {
          proxyURL = new URL(config.downloadProxy);
          proxyURL.username = config.downloadProxyUsername;
          proxyURL.password = config.downloadProxyPassword;
        }
        let downloadPathTemplate = new Path(config.downloadPath, false);
        let response = await unlimitedFetch(config.iwaradlPath, {
          method: "POST",
          headers: {
            "accept": "application/json",
            "content-type": "application/json",
            "authorization": `Bearer ${config.iwaradlToken}`
          },
          body: JSON.stringify(prune({
            "urls": [`https://www.${domain2}/video/${videoInfo2.ID}`],
            "options": {
              "proxy_url": proxyURL ? proxyURL.href : void 0,
              "cookies": unsafeWindow.document.cookie,
              "download_dir": downloadPathTemplate.directory,
              "filename_template": downloadPathTemplate.fullName
            }
          }))
        });
        if (response.ok) {
          originalConsole.log(`${videoInfo2.Title} %#pushTaskSucceed#%`);
          newToast(
            1,
            {
              node: toastNode(`${videoInfo2.Title}[${videoInfo2.ID}] %#pushTaskSucceed#%`)
            }
          ).show();
        }
      } catch (error) {
        newToast(
          3,
          {
            node: toastNode([
              `${videoInfo2.Title}[${videoInfo2.ID}] %#pushTaskFailed#% `,
              { nodeType: "br" },
              stringify(error)
            ], "%#iwaradlDownload#%"),
            onClick() {
              this.hide();
            }
          }
        ).show();
      }
    })(videoInfo);
  }
  function othersDownload(videoInfo) {
    (async function(DownloadUrl) {
      DownloadUrl.searchParams.set("download", getDownloadPath(videoInfo).fullName);
      GM_openInTab(DownloadUrl.href, { active: false, insert: true, setParent: true });
    })(videoInfo.DownloadUrl.toURL());
  }
  function browserDownloadErrorParse(error) {
    let errorInfo = stringify(error);
    if (!(error instanceof Error)) {
      errorInfo = {
        "not_enabled": `%#browserDownloadNotEnabled#%`,
        "not_whitelisted": `%#browserDownloadNotWhitelisted#%`,
        "not_permitted": `%#browserDownloadNotPermitted#%`,
        "not_supported": `%#browserDownloadNotSupported#%`,
        "not_succeeded": `%#browserDownloadNotSucceeded#% ${isNullOrUndefined(error.details) ? "UnknownError" : error.details}`
      }[error.error] || `%#browserDownloadUnknownError#%`;
    }
    return errorInfo;
  }
  function browserDownload(videoInfo) {
    (async function(videoInfo2) {
      function toastError(error) {
        let toast = newToast(
          3,
          {
            node: toastNode([
              `${videoInfo2.Title}[${videoInfo2.ID}] %#downloadFailed#%`,
              { nodeType: "br" },
              browserDownloadErrorParse(error),
              { nodeType: "br" },
              `%#tryRestartingDownload#%`
            ], "%#browserDownload#%"),
            async onClick() {
              toast.hide();
              await pushDownloadTask(videoInfo2);
            }
          }
        );
        toast.show();
      }
      GM_download({
        url: videoInfo2.DownloadUrl,
        saveAs: false,
        name: getDownloadPath(videoInfo2).fullPath,
        onerror: (err) => toastError(err),
        ontimeout: () => toastError(new Error("%#browserDownloadTimeout#%"))
      });
    })(videoInfo);
  }
  function generateMatadataURL(videoInfo) {
    const metadataContent = generateMetadataContent(videoInfo);
    const blob = new Blob([metadataContent], { type: "text/plain" });
    return URL.createObjectURL(blob);
  }
  function getMatadataPath(videoInfo) {
    const videoPath = getDownloadPath(videoInfo);
    return `${videoPath.directory}/${videoPath.baseName}.json`;
  }
  function generateMetadataContent(videoInfo) {
    const metadata = Object.assign({}, videoInfo, {
      DownloadPath: getDownloadPath(videoInfo).fullPath,
      MetaDataVersion: GM_info.script.version
    });
    return JSON.stringify(metadata, (key, value) => {
      if (value instanceof Date) {
        return value.toISOString();
      }
      return value;
    }, 2);
  }
  function browserDownloadMetadata(videoInfo) {
    const url = generateMatadataURL(videoInfo);
    function toastError(error) {
      newToast(
        3,
        {
          node: toastNode([
            `${videoInfo.Title}[${videoInfo.ID}] %#videoMetadata#% %#downloadFailed#%`,
            { nodeType: "br" },
            browserDownloadErrorParse(error)
          ], "%#browserDownload#%"),
          close: true
        }
      ).show();
    }
    GM_download({
      url,
      saveAs: false,
      name: getMatadataPath(videoInfo),
      onerror: (err) => toastError(err),
      ontimeout: () => toastError(new Error("%#browserDownloadTimeout#%")),
      onload: () => URL.revokeObjectURL(url)
    });
  }
  function othersDownloadMetadata(videoInfo) {
    const url = generateMatadataURL(videoInfo);
    const metadataFile = analyzeLocalPath(getMatadataPath(videoInfo)).fullName;
    const downloadHandle = renderNode({
      nodeType: "a",
      attributes: {
        href: url,
        download: metadataFile
      }
    });
    downloadHandle.click();
    downloadHandle.remove();
    URL.revokeObjectURL(url);
  }
  async function addDownloadTask() {
    let textArea = renderNode({
      nodeType: "textarea",
      attributes: {
        placeholder: i18nList[config.language].manualDownloadTips,
        style: "margin-bottom: 10px;",
        rows: "16",
        cols: "96"
      }
    });
    let body = renderNode({
      nodeType: "div",
      attributes: {
        id: "pluginOverlay"
      },
      childs: [
        textArea,
        {
          nodeType: "button",
          events: {
            click: (e) => {
              if (!isNullOrUndefined(textArea.value) && !textArea.value.isEmpty()) {
                let list = [];
                try {
                  list = textArea.value.split("|").map((ID) => [ID.trim(), {
                    Type: "init",
                    ID: ID.trim()
                  }]);
                } catch (error) {
                  throw new Error("解析结果不是符合预期的列表");
                }
                if (list.length > 0) {
                  analyzeDownloadTask(new Dictionary(list));
                }
              }
              body.remove();
            }
          },
          childs: i18nList[config.language].ok
        }
      ]
    });
    unsafeWindow.document.body.appendChild(body);
  }
  async function downloadTaskUnique(taskList) {
    try {
      let stoped = prune(
        (await aria2API(
          "aria2.tellStopped",
          [
            0,
            4096,
            [
              "gid",
              "status",
              "files",
              "errorCode",
              "bittorrent"
            ]
          ]
        )).result.filter(
          (task) => isNullOrUndefined(task.bittorrent)
        ).map(
          (task) => {
            let ID = aria2TaskExtractVideoID(task);
            if (!isNullOrUndefined(ID) && !ID.isEmpty()) {
              return {
                id: ID,
                data: task
              };
            }
          }
        )
      );
      let active = prune(
        (await aria2API(
          "aria2.tellActive",
          [
            [
              "gid",
              "status",
              "files",
              "downloadSpeed",
              "bittorrent"
            ]
          ]
        )).result.filter(
          (task) => isNullOrUndefined(task.bittorrent)
        ).map(
          (task) => {
            let ID = aria2TaskExtractVideoID(task);
            if (!isNullOrUndefined(ID) && !ID.isEmpty()) {
              return {
                id: ID,
                data: task
              };
            }
          }
        )
      );
      let downloadCompleted = stoped.filter(
        (task) => task.data.status === "complete"
      ).unique("id");
      let startedAndCompleted = [...active, ...downloadCompleted].map((i) => i.id);
      for (let key of taskList.keysArray().intersect(startedAndCompleted)) {
        taskList.delete(key);
      }
    } catch (error) {
      newToast(3, {
        node: toastNode(
          [
            `%#duplicateTaskAnalysisError#%`,
            { nodeType: "br" },
            stringify(error)
          ]
        )
      }).show();
    }
  }
  async function analyzeDownloadTask(taskList = selectList) {
    let size = taskList.size;
    let node = renderNode({
      nodeType: "p",
      childs: `${i18nList[config.language].parsingProgress}[${taskList.size}/${size}]`
    });
    let parsingProgressToast = newToast(1, {
      node,
      duration: -1
    });
    function updateParsingProgress() {
      node.firstChild.textContent = `${i18nList[config.language].parsingProgress}[${taskList.size}/${size}]`;
    }
    parsingProgressToast.show();
    if (config.experimentalFeatures && config.downloadType === 0) {
      await downloadTaskUnique(taskList);
      updateParsingProgress();
    }
    for (let [id, info] of taskList) {
      await pushDownloadTask(await parseVideoInfo(info));
      taskList.delete(id);
      updateParsingProgress();
      !config.enableUnsafeMode && await delay(3e3);
    }
    parsingProgressToast.hide();
    newToast(
      1,
      {
        text: `%#allCompleted#%`,
        duration: -1,
        close: true,
        onClick() {
          this.hide();
        }
      }
    ).show();
  }
  async function pushDownloadTask(videoInfo) {
    switch (videoInfo.Type) {
      case "partial":
        const partialCache = await db.getVideoById(videoInfo.ID);
        if (!isNullOrUndefined(partialCache) && partialCache.Type !== "full") await db.putVideo(videoInfo);
      case "cache":
      case "init":
        return await pushDownloadTask(await parseVideoInfo(videoInfo));
      case "fail":
        const cache = await db.getVideoById(videoInfo.ID);
        const youtubeExternal = videoInfo.External && isYoutubeExternalUrl(videoInfo.ExternalUrl);
        newToast(
          3,
          {
            close: true,
            node: toastNode([
              `${videoInfo.Title ?? videoInfo.RAW?.title ?? cache?.RAW?.title}[${videoInfo.ID}] %#parsingFailed#%`,
              { nodeType: "br" },
              videoInfo.Msg,
              { nodeType: "br" },
              youtubeExternal ? `%#queueYoutubeDownload#%` : videoInfo.External ? `%#openVideoLink#%` : `%#tryReparseDownload#%`
            ], "%#createTask#%"),
            async onClick() {
              this.hide();
              if (youtubeExternal) {
                try {
                  const result = await queueRequest("/api/youtube-downloads", {
                    method: "POST",
                    body: JSON.stringify({ url: videoInfo.ExternalUrl })
                  });
                  newToast(1, {
                    text: result.duplicate ? "%#youtubeDownloadAlreadyQueued#%" : "%#youtubeDownloadQueued#%",
                    close: true,
                    duration: 8e3
                  }).show();
                } catch (error) {
                  newToast(2, {
                    text: `%#youtubeDownloadQueueFailed#% ${error.message}`,
                    close: true,
                    duration: -1
                  }).show();
                }
              } else if (videoInfo.External && !isNullOrUndefined(videoInfo.ExternalUrl) && !videoInfo.ExternalUrl.isEmpty()) {
                GM_openInTab(videoInfo.ExternalUrl, { active: false, insert: true, setParent: true });
              } else {
                await pushDownloadTask(await parseVideoInfo({ Type: "init", ID: videoInfo.ID, RAW: videoInfo.RAW ?? cache?.RAW }));
              }
            }
          }
        ).show();
        break;
      case "full":
        await db.putVideo(videoInfo);
        const authorInfo = await db.getFollowById(videoInfo.AuthorID);
        if (config.autoFollow && (!authorInfo?.following || !videoInfo.Following)) {
          await unlimitedFetch(
            `https://${apiEndpoint}/user/${videoInfo.AuthorID}/followers`,
            {
              method: "POST",
              headers: await getAuth()
            },
            {
              retry: true,
              successStatus: 201,
              failStatus: [404],
              onFail: async (res) => {
                newToast(2, {
                  text: `${videoInfo.Alias} %#autoFollowFailed#% ${res.status}`,
                  close: true,
                  onClick() {
                    this.hide();
                  }
                }).show();
              },
              onRetry: async () => {
                await refreshToken();
              }
            }
          );
        }
        if (config.autoLike && !videoInfo.Liked) {
          await unlimitedFetch(
            `https://${apiEndpoint}/video/${videoInfo.ID}/like`,
            {
              method: "POST",
              headers: await getAuth()
            },
            {
              retry: true,
              successStatus: 201,
              failStatus: [404],
              onFail: async (res) => {
                newToast(2, {
                  text: `${videoInfo.Alias} %#autoLikeFailed#% ${res.status}`,
                  close: true,
                  onClick() {
                    this.hide();
                  }
                }).show();
              },
              onRetry: async () => {
                await refreshToken();
              }
            }
          );
        }
        if (pluginMenu.pageType !== "video" && config.checkDownloadLink && checkIsHaveDownloadLink(`${videoInfo.Description} ${videoInfo.Comments}`)) {
          let toastBody = toastNode([
            `${videoInfo.Title}[${videoInfo.ID}] %#findedDownloadLink#%`,
            { nodeType: "br" },
            `%#openVideoLink#%`
          ], "%#createTask#%");
          newToast(
            2,
            {
              node: toastBody,
              close: config.autoCopySaveFileName,
              onClick() {
                GM_openInTab(`https://www.${domain2}/video/${videoInfo.ID}`, { active: false, insert: true, setParent: true });
                if (config.autoCopySaveFileName) {
                  GM_setClipboard(getDownloadPath(videoInfo).fullName, "text");
                  toastBody.appendChild(renderNode({
                    nodeType: "p",
                    childs: "%#copySucceed#%"
                  }));
                } else {
                  this.hide();
                }
              }
            }
          ).show();
          return;
        }
        if (config.checkPriority && videoInfo.DownloadQuality !== config.downloadPriority) {
          newToast(
            2,
            {
              node: toastNode([
                `${videoInfo.Title.truncate(64)}[${videoInfo.ID}] %#downloadQualityError#%`,
                { nodeType: "br" },
                `%#tryReparseDownload#%`
              ], "%#createTask#%"),
              async onClick() {
                this.hide();
                await pushDownloadTask(await parseVideoInfo(videoInfo));
              }
            }
          ).show();
          return;
        }
        switch (config.downloadType) {
          case 0:
            aria2Download(videoInfo, true);
            break;
          case 1:
            iwaradlDownload(videoInfo);
            break;
          case 2:
            browserDownload(videoInfo);
            break;
          default:
            othersDownload(videoInfo);
            break;
        }
        if (config.autoDownloadMetadata) {
          switch (config.downloadType) {
            case 3:
              othersDownloadMetadata(videoInfo);
              break;
            case 2:
              browserDownloadMetadata(videoInfo);
              break;
            default:
              break;
          }
          GM_getValue("isDebug") && originalConsole.debug("[Debug] Download task pushed:", videoInfo);
        }
        selectList.delete(videoInfo.ID);
        break;
      default:
        GM_getValue("isDebug") && originalConsole.debug("[Debug] Unknown type:", videoInfo);
        break;
    }
  }
  async function importConfig() {
    let textArea = renderNode({
      nodeType: "textarea",
      attributes: {
        placeholder: i18nList[config.language].importConfig,
        style: "margin-bottom: 10px;",
        rows: "16",
        cols: "96"
      }
    });
    let body = renderNode({
      nodeType: "div",
      attributes: {
        id: "pluginOverlay"
      },
      childs: [
        textArea,
        {
          nodeType: "button",
          events: {
            click: (e) => {
              if (!isNullOrUndefined(textArea.value) && !textArea.value.isEmpty()) {
                try {
                  let tempConfig = JSON.parse(textArea.value);
                  if (!tempConfig || typeof tempConfig !== "object") {
                    throw "配置校验失败";
                  }
                  Config.initInstance(tempConfig);
                  unsafeWindow.location.reload();
                } catch (error) {
                  newToast(3, {
                    node: renderNode({
                      nodeType: "p",
                      childs: [
                        "%#importConfigFail#%",
                        stringify(error)
                      ]
                    })
                  }).show();
                }
              }
              body.remove();
            }
          },
          childs: i18nList[config.language].ok
        }
      ]
    });
    unsafeWindow.document.body.appendChild(body);
  }
  var queueBaseUrl = "http://127.0.0.1:18777";
  function isYoutubeExternalUrl(value) {
    try {
      const parsed = new URL(String(value || ""));
      return parsed.protocol === "https:" && [
        "youtube.com", "www.youtube.com", "m.youtube.com", "music.youtube.com",
        "youtu.be", "www.youtu.be", "youtube-nocookie.com", "www.youtube-nocookie.com"
      ].includes(parsed.hostname.toLowerCase());
    } catch {
      return false;
    }
  }
  var maxQueueWorkers = 3;
  var activeQueueWorkers = 0;
  var maxViewWorkers = 8;
  var activeViewWorkers = 0;
  var resolverTimer;
  async function queueRequest(pathname, init = {}) {
    const response = await unlimitedFetch(`${queueBaseUrl}${pathname}`, {
      ...init,
      headers: {
        "content-type": "application/json",
        ...init.headers ?? {}
      }
    }, { force: true });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload?.error ?? `Queue HTTP ${response.status}`);
    return payload;
  }
  function queuedMetadataFromInfo(info) {
    const raw = info?.RAW ?? {};
    const user = raw?.user ?? {};
    const metadata = {};
    const title = info?.Title ?? raw?.title;
    const author = info?.Author ?? user?.username;
    const alias = info?.Alias ?? user?.name;
    const uploadTime = info?.UploadTime ?? (raw?.createdAt ? Date.parse(raw.createdAt) : null);
    const views = info?.Views ?? raw?.views ?? raw?.viewCount ?? raw?.numViews;
    const tags = info?.Tags ?? raw?.tags;
    if (typeof title === "string" && title.trim()) metadata.title = title.trim();
    if (typeof author === "string" && author.trim()) metadata.author = author.trim();
    if (typeof alias === "string" && alias.trim()) metadata.alias = alias.trim();
    if (Number.isFinite(Number(uploadTime)) && Number(uploadTime) > 0) metadata.uploadTime = Number(uploadTime);
    if (views != null && Number.isFinite(Number(views))) metadata.viewCount = Number(views);
    if (Array.isArray(tags)) metadata.tags = tags.map((tag) => typeof tag === "string" ? tag : tag?.name ?? tag?.title ?? tag?.label ?? tag?.id ?? "").filter(Boolean);
    return metadata;
  }
  async function submitToResilientQueue(videoItems) {
    const items = videoItems.map((item) => typeof item === "string" ? { videoId: item } : {
      videoId: item.videoId,
      ...(item.metadata ? { metadata: item.metadata } : {})
    });
    const result = await queueRequest("/api/tasks", {
      method: "POST",
      body: JSON.stringify({ items })
    });
    if (result.accepted.length) pumpQueueWorkers();
    return result;
  }
  async function reportResolutionFailure(task, error, partialMetadata = null, failure = null) {
    await queueRequest("/api/resolve/result", {
      method: "POST",
      body: JSON.stringify({
        taskId: task.taskId,
        leaseId: task.leaseId,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
        partialMetadata,
        failure: failure || error?.Failure || { stage: "unknown" }
      })
    });
  }

  function fallbackSniffScore(candidate) {
    if (candidate.kind === "direct") return 300;
    if (candidate.kind === "hls") return 280;
    if (candidate.kind === "dash") return 260;
    return 0;
  }

  function bestFallbackMediaCandidate() {
    return [...__iwaraQueueSniffCandidates].sort((a, b) => {
      const scoreDiff = fallbackSniffScore(b) - fallbackSniffScore(a);
      return scoreDiff || a.at - b.at;
    })[0] || null;
  }

  function inspectMediaElementsForFallback() {
    for (const video of unsafeWindow.document.querySelectorAll("video")) {
      __iwaraQueueRecordMedia(video.currentSrc || video.src, video.type || "", "video-element");
      for (const source of video.querySelectorAll("source")) {
        __iwaraQueueRecordMedia(source.src, source.type || "", "source-element");
      }
    }
  }

  async function encourageFallbackPlayback() {
    const videos = [...unsafeWindow.document.querySelectorAll("video")];
    for (const video of videos) {
      try {
        video.muted = true;
        video.volume = 0;
        video.autoplay = true;
        video.preload = "auto";
        await video.play();
      } catch {}
    }
    if (!videos.length || videos.some(video => video.paused || !video.currentSrc)) {
      for (const selector of ["button[aria-label*='play' i]", ".vjs-big-play-button", ".plyr__control--overlaid", "button[class*='play' i]"]) {
        try {
          const button = unsafeWindow.document.querySelector(selector);
          if (button && !button.disabled) button.click();
        } catch {}
      }
    }
  }

  function extractTagField(raw) {
    const candidates = [
      ["tags", raw?.tags],
      ["Tags", raw?.Tags],
      ["data.tags", raw?.data?.tags],
      ["video.tags", raw?.video?.tags],
      ["metadata.tags", raw?.metadata?.tags],
      ["RAW.tags", raw?.RAW?.tags]
    ];
    const found = candidates.find(([, value]) => Array.isArray(value));
    return found
      ? { present: true, path: found[0], value: found[1] }
      : { present: false, path: "", value: [] };
  }

  async function fallbackSniffMetadata(videoId) {
    try {
      const response = await unlimitedFetch(`https://${apiEndpoint}/video/${videoId}`, {
        headers: await getAuth()
      }, { retry: true, maxRetries: 2, retryDelay: 1000 });
      const raw = await response.json();
      if (!raw?.id) return null;
      const tagField = extractTagField(raw);
      return {
        ID: raw.id,
        Title: raw.title || "",
        Author: raw.user?.username || "",
        Alias: raw.user?.name || "",
        UploadTime: raw.createdAt ? new Date(raw.createdAt).getTime() : null,
        Views: raw.views ?? raw.viewCount ?? raw.numViews ?? null,
        Tags: tagField.value,
        tagsFieldPresent: tagField.present,
        tagsFieldPath: tagField.path
      };
    } catch {
      return null;
    }
  }

  async function runBrowserFallbackSniffPage() {
    const taskId = __iwaraQueueSniffParams?.get("__iwara_task") || "";
    const leaseId = __iwaraQueueSniffParams?.get("__iwara_lease") || "";
    const videoId = __iwaraQueueSniffParams?.get("__iwara_video") || "";
    const timeoutMs = Math.max(10_000, Math.min(90_000, Number(__iwaraQueueSniffParams?.get("__iwara_timeout") || 45_000)));
    if (!taskId || !leaseId || !videoId) return;
    const cleanPage = new URL(`https://www.${domain2}/video/${videoId}`).href;
    const deadline = Date.now() + timeoutMs;
    let candidate = null;
    let firstCandidateAt = 0;
    while (Date.now() < deadline) {
      inspectMediaElementsForFallback();
      await encourageFallbackPlayback();
      candidate = bestFallbackMediaCandidate();
      if (candidate) {
        firstCandidateAt ||= Date.now();
        if (Date.now() - firstCandidateAt >= 1500) break;
      }
      await new Promise(resolve => unsafeWindow.setTimeout(resolve, 500));
    }
    try {
      if (!candidate) {
        await queueRequest("/api/resolve/result", {
          method: "POST",
          body: JSON.stringify({
            taskId,
            leaseId,
            ok: false,
            error: `网页已打开并尝试播放 ${Math.round(timeoutMs / 1000)} 秒，但未嗅探到 MP4/M3U8/MPD 媒体请求`,
            failure: { stage: "browser_sniff", reason: "no_media_request" }
          })
        });
      } else {
        const metadata = await fallbackSniffMetadata(videoId);
        const title = metadata?.Title || unsafeWindow.document.querySelector("h1")?.textContent?.trim() || unsafeWindow.document.title?.replace(/\s*[-|]\s*Iwara.*$/i, "").trim() || videoId;
        await queueRequest("/api/resolve/result", {
          method: "POST",
          body: JSON.stringify({
            taskId,
            leaseId,
            ok: true,
            video: {
              url: candidate.url,
              title,
              fileName: `${title}[${videoId}].mp4`,
              relativePath: `${title}[${videoId}].mp4`,
              mediaType: candidate.kind,
              referer: cleanPage,
              userAgent: unsafeWindow.navigator.userAgent,
              headers: {
                Referer: cleanPage,
                Origin: unsafeWindow.location.origin,
                "User-Agent": unsafeWindow.navigator.userAgent,
                Cookie: unsafeWindow.document.cookie || ""
              },
              metadata
            }
          })
        });
      }
    } finally {
      unsafeWindow.setTimeout(() => {
        try { unsafeWindow.close(); } catch {}
      }, 1200);
    }
  }

  function openBrowserFallbackSniffTab(task) {
    const url = new URL(task.sourcePage || `https://www.${domain2}/video/${task.videoId}`);
    url.searchParams.set("__iwara_queue_sniff", "1");
    url.searchParams.set("__iwara_task", task.taskId);
    url.searchParams.set("__iwara_lease", task.leaseId);
    url.searchParams.set("__iwara_video", task.videoId);
    url.searchParams.set("__iwara_timeout", String(task.sniffTimeoutMs || 45_000));
    GM_openInTab(url.href, { active: true, insert: true, setParent: true });
  }
  async function resolveOneTask() {
    if (activeQueueWorkers >= maxQueueWorkers) return;
    activeQueueWorkers += 1;
    let didWork = false;
    let leasedTask = null;
    try {
      const next = await queueRequest("/api/resolve/next");
      if (!next.task) {
        didWork = await enrichOneImportedRecord();
        return;
      }
      didWork = true;
      leasedTask = next.task;
      if (leasedTask.mode === "browser_sniff") {
        openBrowserFallbackSniffTab(leasedTask);
        leasedTask = null;
        return;
      }
      const info = await parseVideoInfo(
        { Type: "init", ID: leasedTask.videoId },
        false,
        leasedTask.avoidHosts ?? []
      );
      if (info.Type !== "full") {
        await reportResolutionFailure(
          leasedTask,
          ("Msg" in info ? info.Msg : void 0) ?? "Iwara 未返回可下载地址",
          {
            Title: info.Title || info.RAW?.title || "",
            Author: info.Author || info.RAW?.user?.username || "",
            Alias: info.Alias || info.RAW?.user?.name || "",
            UploadTime: info.UploadTime || (info.RAW?.createdAt ? new Date(info.RAW.createdAt).getTime() : null),
            Views: info.Views ?? info.RAW?.views ?? info.RAW?.viewCount ?? info.RAW?.numViews ?? null,
            Tags: info.Tags ?? info.RAW?.tags ?? []
          },
          info.Failure
        );
        leasedTask = null;
        return;
      }
      const downloadPath = getDownloadPath(info);
      const sourceAuth = await getAuth(info.DownloadUrl);
      await queueRequest("/api/resolve/result", {
        method: "POST",
        body: JSON.stringify({
          taskId: leasedTask.taskId,
          leaseId: leasedTask.leaseId,
          ok: true,
          video: {
            url: info.DownloadUrl,
            title: info.Title,
            fileName: downloadPath.fullName,
            relativePath: downloadPath.fullPath,
            referer: `https://www.${domain2}/video/${info.ID}`,
            userAgent: unsafeWindow.navigator.userAgent,
            headers: prune({
              "X-Version": sourceAuth["X-Version"],
              "X-Site": sourceAuth["X-Site"]
            }),
            metadata: {
              ID: info.ID,
              Title: info.Title,
              Author: info.Author,
              Alias: info.Alias,
              UploadTime: info.UploadTime,
              Views: info.Views ?? info.RAW?.views ?? info.RAW?.viewCount ?? info.RAW?.numViews ?? null,
              Tags: info.Tags ?? info.RAW?.tags ?? [],
              DownloadQuality: info.DownloadQuality,
              OriginalFileName: info.FileName,
              Size: info.Size
            }
          }
        })
      });
      leasedTask = null;
    } catch (error) {
      if (leasedTask) {
        try {
          await reportResolutionFailure(leasedTask, error);
        } catch {
        }
      }
    } finally {
      activeQueueWorkers -= 1;
      if (didWork) unsafeWindow.setTimeout(pumpQueueWorkers, 250);
    }
  }
  async function enrichOneImportedRecord(endpoint = "/api/enrich/next") {
    const next = await queueRequest(endpoint);
    if (!next.task) return false;
    const { taskId, leaseId, videoId } = next.task;
    let response;
    try {
      response = await unlimitedFetch(
        `https://${apiEndpoint}/video/${videoId}`,
        { headers: await getAuth() },
        {
          retry: true,
          maxRetries: 3,
          retryDelay: 1e3,
          failStatus: [403, 404],
          onRetry: async () => {
            await refreshToken();
          }
        }
      );
      const raw = await response.json();
      if (!response.ok || !raw.id || !raw.user) {
        throw new Error(raw.message ?? `Iwara HTTP ${response.status}`);
      }
      const tagField = extractTagField(raw);
      await queueRequest("/api/enrich/result", {
        method: "POST",
        body: JSON.stringify({
          taskId,
          leaseId,
          ok: true,
          metadata: {
            title: raw.title,
            author: raw.user.username,
            alias: raw.user.name,
            uploadTime: new Date(raw.createdAt ?? 0).getTime(),
            views: raw.views ?? raw.viewCount ?? raw.numViews ?? null,
            tags: tagField.value,
            tagsFieldPresent: tagField.present,
            tagsFieldPath: tagField.path
          }
        })
      });
    } catch (error) {
      await queueRequest("/api/enrich/result", {
        method: "POST",
        body: JSON.stringify({
          taskId,
          leaseId,
          ok: false,
          permanent: response?.status === 404,
          error: error instanceof Error ? error.message : String(error)
        })
      });
    }
    return true;
  }
  async function enrichOneAuthorRecord() {
    const next = await queueRequest("/api/enrich/next-authors");
    if (!next.task) return false;
    const { taskId, leaseId, videoId } = next.task;
    let response;
    try {
      response = await unlimitedFetch(
        `https://${apiEndpoint}/video/${videoId}`,
        { headers: await getAuth() },
        {
          retry: true,
          maxRetries: 3,
          retryDelay: 1e3,
          failStatus: [403, 404],
          onRetry: async () => { await refreshToken(); }
        }
      );
      const raw = await response.json();
      const author = String(raw?.user?.username || "").trim();
      const alias = String(raw?.user?.name || "").trim();
      if (!response.ok || !raw?.id || (!author && !alias)) {
        throw new Error(raw?.message || `Iwara HTTP ${response.status}：没有作者字段`);
      }
      await queueRequest("/api/enrich/authors-result", {
        method: "POST",
        body: JSON.stringify({ taskId, leaseId, ok: true, author, alias })
      });
    } catch (error) {
      await queueRequest("/api/enrich/authors-result", {
        method: "POST",
        body: JSON.stringify({
          taskId,
          leaseId,
          ok: false,
          permanent: response?.status === 404,
          error: error instanceof Error ? error.message : String(error)
        })
      });
    }
    return true;
  }
  async function updateOneViewTask() {
    if (activeViewWorkers >= maxViewWorkers) return;
    activeViewWorkers += 1;
    let didWork = false;
    try {
      // Refill missing Iwara authors first; this path writes only author fields.
      didWork = await enrichOneAuthorRecord();
      // A single bounded metadata pool services the existing tag/view queues.
      // Prefer tags so a bulk tag refresh cannot sit behind view-count work.
      if (!didWork) didWork = await enrichOneImportedRecord("/api/enrich/next-tags");
      if (!didWork) didWork = await enrichOneImportedRecord("/api/enrich/next-views");
    } catch {
    } finally {
      activeViewWorkers -= 1;
      if (didWork) unsafeWindow.setTimeout(pumpViewWorkers, 250);
    }
  }
  function pumpViewWorkers() {
    while (activeViewWorkers < maxViewWorkers) void updateOneViewTask();
  }
  function pumpQueueWorkers() {
    while (activeQueueWorkers < maxQueueWorkers) void resolveOneTask();
  }
  function startResilientQueueWorker() {
    if (resolverTimer !== void 0) return;
    pumpQueueWorkers();
    pumpViewWorkers();
    resolverTimer = unsafeWindow.setInterval(() => {
      pumpQueueWorkers();
      pumpViewWorkers();
    }, 1e3);
    unsafeWindow.addEventListener("focus", pumpQueueWorkers);
    unsafeWindow.document.addEventListener("visibilitychange", () => {
      if (!unsafeWindow.document.hidden) pumpQueueWorkers();
    });
  }
  var MONTH_MS = 30 * 24 * 60 * 60 * 1e3;
  function uninjectCheckbox(element) {
    if (element instanceof HTMLElement) {
      if (element instanceof HTMLInputElement && element.classList.contains("selectButton")) {
        element.hasAttribute("videoID") && pageSelectButtons.delete(element.getAttribute("videoID"));
      }
      if (element.querySelector("input.selectButton")) {
        element.querySelectorAll(".selectButton").forEach((i) => i.hasAttribute("videoID") && pageSelectButtons.delete(i.getAttribute("videoID")));
      }
    }
  }
  async function injectCheckbox(element) {
    const thumbnail = element.querySelector("a.videoTeaser__thumbnail");
    if (isNullOrUndefined(thumbnail)) return;
    let ID = thumbnail.href.toURL().pathname.split("/")[2];
    if (isNullOrUndefined(ID)) return;
    let info = await db.getVideoById(ID);
    const hasFullInfo = info?.Type === "full" || info?.Type === "partial";
    const authorLink = element.querySelector("a.username");
    let Title = hasFullInfo ? info?.Title : info?.RAW?.title ?? element.querySelector(".videoTeaser__title")?.getAttribute("title") ?? void 0;
    let Alias = hasFullInfo ? info?.Alias : info?.RAW?.user?.name ?? authorLink?.getAttribute("title") ?? void 0;
    let Author = hasFullInfo ? info?.Author : info?.RAW?.user?.username ?? authorLink?.href.toURL().pathname.split("/").pop();
    let UploadTime = hasFullInfo ? info?.UploadTime : info?.RAW?.createdAt ? new Date(info.RAW.createdAt).getTime() : null;
    let Views = hasFullInfo ? info?.Views : info?.RAW?.views ?? info?.RAW?.viewCount ?? info?.RAW?.numViews;
    let Tags = hasFullInfo ? info?.Tags : info?.RAW?.tags;
    let button = renderNode({
      nodeType: "input",
      attributes: {
        type: "checkbox",
        videoID: ID,
        checked: selectList.has(ID) ? true : void 0,
        videoName: Title,
        videoAlias: Alias,
        videoAuthor: Author,
        videoUploadTime: UploadTime
      },
      className: "selectButton",
      events: {
        click: (event) => {
          event.target.checked ? selectList.set(ID, {
            Type: "init",
            ID,
            Title,
            Alias,
            Author,
            UploadTime,
            Views,
            Tags
          }) : selectList.delete(ID);
          event.stopPropagation();
          event.stopImmediatePropagation();
          return false;
        }
      }
    });
    let item = thumbnail.parentElement;
    item?.style.setProperty("position", "relative");
    pageSelectButtons.set(ID, button);
    originalNodeAppendChild.call(item, button);
    if (!isNullOrUndefined(Author)) {
      const AuthorInfo = await db.getFollowByUsername(Author);
      if (AuthorInfo?.following && thumbnail.querySelector(".follow") === null) {
        originalNodeAppendChild.call(thumbnail, renderNode(
          {
            nodeType: "div",
            className: "follow",
            childs: {
              nodeType: "div",
              className: ["text", "text--white", "text--tiny", "text--bold"],
              childs: "%#following#%"
            }
          }
        ));
      }
    }
    if (!config.mediaCenterApi.isEmpty() && !config.mediaCenterApiKey.isEmpty()) {
      const mediaCenterId = await db.getMediaCenterIdMap(ID);
      if (!isNullOrUndefined(mediaCenterId) && !mediaCenterId.isEmpty() && thumbnail.querySelector(".downloaded") === null) {
        originalNodeAppendChild.call(thumbnail, renderNode(
          {
            nodeType: "div",
            className: "downloaded",
            childs: {
              nodeType: "div",
              className: ["text", "text--white", "text--tiny", "text--bold"],
              childs: "%#downloaded#%"
            }
          }
        ));
      }
    }
    if (getPageType() === "playlist") {
      let deletePlaylistItme = renderNode({
        nodeType: "button",
        attributes: {
          videoID: ID
        },
        childs: "%#delete#%",
        className: "deleteButton",
        events: {
          click: async (event) => {
            if ((await unlimitedFetch(`https://${apiEndpoint}/playlist/${unsafeWindow.location.pathname.split("/")[2]}/${ID}`, {
              method: "DELETE",
              headers: await getAuth()
            })).ok) {
              newToast(1, { text: `${Title} %#deleteSucceed#%`, close: true }).show();
              deletePlaylistItme.remove();
            }
            event.preventDefault();
            event.stopPropagation();
            event.stopImmediatePropagation();
            return false;
          }
        }
      });
      originalNodeAppendChild.call(item, deletePlaylistItme);
    }
  }
  var configEdit = class {
    source;
    target;
    interfacePage;
    interface;
    constructor(config2) {
      this.target = config2;
      this.target.configChange = (item) => {
        this.configChange.call(this, item);
      };
      this.interfacePage = renderNode({
        nodeType: "p"
      });
      let save = renderNode({
        nodeType: "button",
        childs: "%#save#%",
        attributes: {
          title: i18nList[config2.language].save
        },
        events: {
          click: async () => {
            save.disabled = !save.disabled;
            if (await check()) {
              unsafeWindow.location.reload();
            }
            save.disabled = !save.disabled;
          }
        }
      });
      let reset = renderNode({
        nodeType: "button",
        childs: "%#reset#%",
        attributes: {
          title: i18nList[config2.language].reset
        },
        events: {
          click: () => {
            GM_setValue("isFirstRun", true);
            unsafeWindow.location.reload();
          }
        }
      });
      this.interface = renderNode({
        nodeType: "div",
        attributes: {
          id: "pluginConfig"
        },
        childs: [
          {
            nodeType: "div",
            className: "main",
            childs: [
              {
                nodeType: "h2",
                childs: "%#appName#%"
              },
              {
                nodeType: "label",
                childs: [
                  "%#language#% ",
                  {
                    nodeType: "input",
                    className: "inputRadioLine",
                    attributes: {
                      name: "language",
                      type: "text",
                      value: this.target.language
                    },
                    events: {
                      change: (event) => {
                        this.target.language = event.target.value;
                      }
                    }
                  }
                ]
              },
              this.downloadTypeSelect(),
              this.interfacePage,
              this.switchButton("checkPriority"),
              this.switchButton("checkDownloadLink"),
              this.switchButton("autoFollow"),
              this.switchButton("autoLike"),
              this.switchButton("filterLikedVideos"),
              this.switchButton("autoInjectCheckbox"),
              this.switchButton("autoDownloadMetadata"),
              this.switchButton("autoCopySaveFileName"),
              this.switchButton("addUnlistedAndPrivate", void 0, (name, e) => {
                const checked = e.target.checked;
                this.target.addUnlistedAndPrivate = checked;
                if (checked) this.target.filterUnlistedAndPrivate = false;
              }),
              this.switchButton("filterUnlistedAndPrivate", void 0, (name, e) => {
                const checked = e.target.checked;
                this.target.filterUnlistedAndPrivate = checked;
                if (checked) this.target.addUnlistedAndPrivate = false;
              }),
              this.switchButton("autoCollapseMenu"),
              this.switchButton("experimentalFeatures"),
              this.switchButton("enableUnsafeMode"),
              this.switchButton("enableWidescreen"),
              this.switchButton("enableBeautify"),
              this.switchButton("isDebug", GM_getValue, (name, e) => {
                GM_setValue(name, e.target.checked);
                unsafeWindow.location.reload();
              }, false)
            ]
          },
          {
            nodeType: "p",
            className: "buttonList",
            childs: [
              reset,
              save
            ]
          }
        ]
      });
    }
    switchButton(name, get, set, defaultValue) {
      return renderNode({
        nodeType: "p",
        className: "inputRadioLine",
        childs: [
          {
            nodeType: "label",
            childs: `%#${name}#%`,
            attributes: {
              for: name
            }
          },
          {
            nodeType: "input",
            className: "switch",
            attributes: {
              type: "checkbox",
              name,
              checked: get !== void 0 ? get(name, defaultValue) : this.target[name] ?? defaultValue ?? false
            },
            events: {
              change: (e) => {
                if (set !== void 0) {
                  set(name, e);
                  return;
                } else {
                  this.target[name] = e.target.checked;
                }
              }
            }
          }
        ]
      });
    }
    inputComponent(name, type, help, get, set) {
      return renderNode({
        nodeType: "label",
        childs: [
          {
            nodeType: "span",
            childs: [
              `%#${name}#%`,
              help
            ]
          },
          {
            nodeType: "input",
            attributes: {
              name,
              type: type ?? "text",
              value: get !== void 0 ? get(name) : this.target[name]
            },
            events: {
              change: (e) => {
                if (set !== void 0) {
                  set(name, e);
                  return;
                } else {
                  this.target[name] = e.target.value;
                }
              }
            }
          }
        ]
      });
    }
    downloadTypeSelect() {
      return renderNode({
        nodeType: "fieldset",
        childs: [
          {
            nodeType: "legend",
            childs: "%#downloadType#%"
          },
          ...Object.keys(DownloadType).filter((i) => isNaN(Number(i))).map(
            (type, index) => renderNode({
              nodeType: "label",
              childs: [
                {
                  nodeType: "input",
                  attributes: {
                    type: "radio",
                    name: "downloadType",
                    value: index,
                    checked: index === Number(this.target.downloadType)
                  },
                  events: {
                    change: (e) => {
                      this.target.downloadType = Number(e.target.value);
                    }
                  }
                },
                type
              ]
            })
          )
        ]
      });
    }
    appendAll(items) {
      items.forEach((i) => originalNodeAppendChild.call(this.interfacePage, i));
    }
    configChange(item) {
      switch (item) {
        case "downloadType":
          const radios = this.interface.querySelectorAll(`[name=${item}]`);
          radios.forEach((radio) => {
            radio.checked = Number(radio.value) === Number(this.target.downloadType);
          });
          this.pageChange();
          break;
        case "checkPriority":
        case "experimentalFeatures":
          this.pageChange();
          break;
        default:
          let element = this.interface.querySelector(`[name=${item}]`);
          if (element) {
            switch (element.type) {
              case "radio":
                element.value = this.target[item];
                break;
              case "checkbox":
                element.checked = this.target[item];
                break;
              case "text":
              case "password":
                element.value = this.target[item];
                break;
              default:
                break;
            }
          }
          break;
      }
    }
    pageChange() {
      while (this.interfacePage.hasChildNodes()) {
        this.interfacePage.removeChild(this.interfacePage.firstChild);
      }
      let downloadConfigInput = [
        this.inputComponent("downloadPath", "text", renderNode({
          nodeType: "a",
          childs: "%#variable#%",
          className: "rainbow-text",
          attributes: {
            style: "float: inline-end;",
            href: "https://github.com/IwaraEnhance/IwaraDownloadTool/wiki/路径可用变量"
          }
        }))
      ];
      let proxyConfigInput = [
        this.inputComponent("downloadProxy"),
        this.inputComponent("downloadProxyUsername"),
        this.inputComponent("downloadProxyPassword", "password")
      ];
      let aria2ConfigInput = [
        this.inputComponent("aria2Path"),
        this.inputComponent("aria2Token", "password"),
        ...proxyConfigInput
      ];
      let mediaCenterConfigInput = [
        this.inputComponent("mediaCenterApi", "text", renderNode({
          nodeType: "a",
          childs: "%#mediaCenterInfo#%",
          className: "rainbow-text",
          attributes: {
            style: "float: inline-end;",
            href: "https://github.com/dawn-lc/MediaCenter"
          }
        })),
        this.inputComponent("mediaCenterApiKey", "password")
      ];
      let iwaradlConfigInput = [
        this.inputComponent("iwaradlPath", "text", renderNode({
          nodeType: "a",
          childs: "%#iwaradlLink#%",
          className: "rainbow-text",
          attributes: {
            style: "float: inline-end;",
            href: "https://github.com/Izumiko/iwaradl"
          }
        })),
        this.inputComponent("iwaradlToken", "password"),
        ...proxyConfigInput
      ];
      switch (this.target.downloadType) {
        case 0:
          this.appendAll([...downloadConfigInput, ...aria2ConfigInput]);
          if (this.target.experimentalFeatures) {
            this.appendAll(mediaCenterConfigInput);
          }
          break;
        case 1:
          this.appendAll([...downloadConfigInput, ...iwaradlConfigInput]);
          break;
        default:
          this.appendAll(downloadConfigInput);
          break;
      }
      if (this.target.checkPriority) {
        originalNodeAppendChild.call(this.interfacePage, this.inputComponent("downloadPriority"));
      }
    }
    inject() {
      if (!unsafeWindow.document.querySelector("#pluginConfig")) {
        originalNodeAppendChild.call(unsafeWindow.document.body, this.interface);
        this.configChange("downloadType");
      }
    }
  };
  var menu = class {
    observer;
    pageType;
    interface;
    interfacePage;
    isTouchDevice;
    constructor() {
      let body = new Proxy(this, {
        set: (target, prop, value) => {
          if (prop === "pageType") {
            if (isNullOrUndefined(value) || target.pageType === value) return true;
            const ok = Reflect.set(target, prop, value);
            this.pageChange();
            GM_getValue("isDebug") && originalConsole.debug(`[Debug] Page change to ${this.pageType}`);
            return ok;
          }
          return Reflect.set(target, prop, value);
        }
      });
      body.interfacePage = renderNode({
        nodeType: "ul"
      });
      body.interface = renderNode({
        nodeType: "div",
        attributes: {
          id: "pluginMenu"
        },
        childs: body.interfacePage
      });
      body.isTouchDevice = unsafeWindow.matchMedia("(pointer: coarse)").matches || (unsafeWindow.navigator.maxTouchPoints ?? 0) > 0;
      if (config.autoCollapseMenu) {
        if (body.isTouchDevice) {
          originalAddEventListener.call(body.interface, "click", (event) => {
            if (event.target === body.interface) {
              body.interface.classList.toggle("expanded");
            }
          });
          originalAddEventListener.call(unsafeWindow.document, "click", (event) => {
            if (body.interface.classList.contains("expanded") && !body.interface.contains(event.target)) {
              body.interface.classList.remove("expanded");
            }
          });
        } else {
          let mouseoutTimer = null;
          originalAddEventListener.call(body.interface, "mouseover", (event) => {
            if (mouseoutTimer !== null) {
              clearTimeout(mouseoutTimer);
              mouseoutTimer = null;
            }
            body.interface.classList.add("expanded");
          });
          originalAddEventListener.call(body.interface, "mouseout", (event) => {
            const e = event;
            const relatedTarget = e.relatedTarget;
            if (relatedTarget && body.interface.contains(relatedTarget)) {
              return;
            }
            mouseoutTimer = setTimeout(() => {
              body.interface.classList.remove("expanded");
              mouseoutTimer = null;
            }, 300);
          });
          originalAddEventListener.call(body.interface, "click", (event) => {
            if (event.target === body.interface) {
              body.interface.classList.toggle("expanded");
            }
          });
        }
      } else {
        body.interface.classList.add("expanded");
      }
      body.observer = new MutationObserver((mutationsList) => body.pageType = getPageType(mutationsList) ?? body.pageType);
      body.pageType = "page";
      return body;
    }
    button(name, click) {
      const self2 = this;
      return renderNode({
        nodeType: "li",
        childs: `%#${name}#%`,
        events: {
          click: (event) => {
            if (!isNullOrUndefined(click)) click(name, event);
            if (self2.isTouchDevice && config.autoCollapseMenu) {
              setTimeout(() => self2.interface.classList.remove("expanded"), 150);
            }
            event.stopPropagation();
            return false;
          }
        }
      });
    }
    appendAll(items) {
      items.forEach((i) => originalNodeAppendChild.call(this.interfacePage, i));
    }
    selectAll(checked) {
      unsafeWindow.document.querySelectorAll(".selectButton").forEach((element) => {
        const button = element;
        button.checked !== checked && button.click();
      });
    }
    toggleSelect() {
      unsafeWindow.document.querySelectorAll(".selectButton").forEach((element) => {
        element.click();
      });
    }
    async parseUnlistedAndPrivate() {
      if (!isLoggedIn()) return;
      const lastMonthTimestamp = Date.now() - MONTH_MS;
      const thisMonthUnlistedAndPrivateVideos = await db.getFilteredVideos(lastMonthTimestamp, Infinity);
      let parseUnlistedAndPrivateVideos = [];
      const MAX_FIND_PAGES = site_default.maxFindPages;
      let pageCount = 0;
      GM_getValue("isDebug") && originalConsole.debug(`[Debug] Starting fetch loop. MAX_PAGES=${MAX_FIND_PAGES}`);
      while (pageCount < MAX_FIND_PAGES) {
        GM_getValue("isDebug") && originalConsole.debug(`[Debug] Fetching page ${pageCount}.`);
        const response = await unlimitedFetch(
          `https://${apiEndpoint}/videos?subscribed=true&limit=50&rating=${rating()}&page=${pageCount}`,
          { method: "GET", headers: await getAuth() },
          {
            retry: true,
            retryDelay: 1e3,
            onRetry: async () => {
              await refreshToken();
            }
          }
        );
        GM_getValue("isDebug") && originalConsole.debug("[Debug] Received response, parsing JSON.");
        const data = (await response.json()).results;
        GM_getValue("isDebug") && originalConsole.debug(`[Debug] Page ${pageCount} returned ${data.length} videos.`);
        data.forEach((info) => info.user.following = true);
        const videoPromises = data.map((info) => parseVideoInfo({
          Type: "cache",
          ID: info.id,
          RAW: info
        }));
        GM_getValue("isDebug") && originalConsole.debug("[Debug] Initializing VideoInfo promises.");
        const videoInfos = await Promise.all(videoPromises);
        parseUnlistedAndPrivateVideos.push(...videoInfos);
        let test = videoInfos.filter((i) => i.Type === "partial" && (i.Private || i.Unlisted)).any();
        GM_getValue("isDebug") && originalConsole.debug("[Debug] All VideoInfo objects initialized.");
        if (test && thisMonthUnlistedAndPrivateVideos.intersect(videoInfos, "ID").any()) {
          GM_getValue("isDebug") && originalConsole.debug(`[Debug] Found private video on page ${pageCount}.`);
          break;
        }
        GM_getValue("isDebug") && originalConsole.debug(`[Debug] Latest private video not found on page ${pageCount}, continuing.`);
        pageCount++;
        GM_getValue("isDebug") && originalConsole.debug(`[Debug] Incremented page to ${pageCount}, delaying next fetch.`);
        await delay(100);
      }
      GM_getValue("isDebug") && originalConsole.debug("[Debug] Fetch loop ended. Start updating the database");
      const existingVideos = await db.getVideosByIds(parseUnlistedAndPrivateVideos.map((v2) => v2.ID));
      const toUpdate = parseUnlistedAndPrivateVideos.difference(
        existingVideos.filter((v2) => v2.Type === "full"),
        "ID"
      );
      if (toUpdate.any()) {
        GM_getValue("isDebug") && originalConsole.debug(`[Debug] Need to update ${toUpdate.length} pieces of data.`);
        await db.bulkPutVideos(toUpdate);
        GM_getValue("isDebug") && originalConsole.debug(`[Debug] Update Completed.`);
      } else {
        GM_getValue("isDebug") && originalConsole.debug(`[Debug] No need to update data.`);
      }
    }
    async pageChange() {
      while (this.interfacePage.hasChildNodes()) {
        this.interfacePage.removeChild(this.interfacePage.firstChild);
      }
      let manualDownloadButton = this.button("manualDownload", (name, event) => {
        addDownloadTask();
      });
      let settingsButton = this.button("settings", (name, event) => {
        editConfig.inject();
      });
      let exportConfigButton = this.button("exportConfig", (name, event) => {
        GM_setClipboard(stringify(config));
        newToast(
          1,
          {
            node: toastNode(i18nList[config.language].exportConfigSucceed),
            duration: 3e3,
            gravity: "bottom",
            position: "center",
            onClick() {
              this.hide();
            }
          }
        ).show();
      });
      let importConfigButton = this.button("importConfig", (name, event) => {
        importConfig();
      });
      let baseButtons = [
        manualDownloadButton,
        exportConfigButton,
        importConfigButton,
        settingsButton
      ];
      let injectCheckboxButton = this.button("injectCheckbox", (name, event) => {
        if (unsafeWindow.document.querySelector(".selectButton")) {
          unsafeWindow.document.querySelectorAll(".selectButton").forEach((element) => {
            element.remove();
          });
        } else {
          unsafeWindow.document.querySelectorAll(`.videoTeaser`).forEach((element) => {
            injectCheckbox(element);
          });
        }
      });
      let deselectAllButton = this.button("deselectAll", () => {
        for (const id of selectList.keys()) {
          selectList.delete(id);
        }
      });
      let reverseSelectButton = this.button("reverseSelect", () => this.toggleSelect());
      let selectThisButton = this.button("selectThis", () => this.selectAll(true));
      let deselectThisButton = this.button("deselectThis", () => this.selectAll(false));
      let downloadSelectedButton = this.button("downloadSelected", async () => {
        const ids = Array.from(selectList.keys());
        if (!ids.length) return;
        try {
          const result = await submitToResilientQueue(ids.map((videoId) => ({
            videoId,
            metadata: queuedMetadataFromInfo(selectList.get(videoId))
          })));
          ids.forEach((id) => selectList.delete(id));
          newToast(1, {
            text: `已加入 ${result.accepted.length} 个任务，跳过 ${result.ignored.length} 个已有记录${result.ignored.some((item) => item.metadataUpdated) ? "；已顺便补上已有记录的网页资料" : ""}`,
            close: true
          }).show();
        } catch (error) {
          newToast(3, {
            text: `稳定下载服务未启动：请先双击“启动稳定下载.cmd”`,
            close: true
          }).show();
          originalConsole.error(error);
        }
      });
      let selectButtons = [
        injectCheckboxButton,
        deselectAllButton,
        reverseSelectButton,
        selectThisButton,
        deselectThisButton,
        downloadSelectedButton
      ];
      let downloadThisButton = this.button("downloadThis", async () => {
        const match = unsafeWindow.location.pathname.match(/^\/video\/([A-Za-z0-9_-]+)/i);
        if (!match) {
          newToast(3, { text: "当前页面没有可识别的视频 ID", close: true }).show();
          return;
        }
        try {
          const cachedInfo = await db.getVideoById(match[1]);
          const result = await submitToResilientQueue([{ videoId: match[1], metadata: queuedMetadataFromInfo(cachedInfo) }]);
          newToast(1, {
            text: result.accepted.length ? "已加入稳定下载队列" : result.ignored?.[0]?.metadataUpdated ? "该视频已有记录，已补入网页资料" : "该视频已有下载记录",
            close: true
          }).show();
        } catch (error) {
          newToast(3, {
            text: `稳定下载服务未启动：请先双击“启动稳定下载.cmd”`,
            close: true
          }).show();
          originalConsole.error(error);
        }
      });
      let aria2TaskCheckButton = this.button("aria2TaskCheck", () => {
        aria2TaskCheckAndRestart();
      });
      if (config.experimentalFeatures) {
        originalNodeAppendChild.call(this.interfacePage, aria2TaskCheckButton);
      }
      switch (this.pageType) {
        case "video":
          this.appendAll([downloadThisButton, ...selectButtons, ...baseButtons]);
          break;
        case "search":
        case "profile":
        case "home":
        case "videoList":
        case "subscriptions":
        case "playlist":
        case "favorites":
        case "account":
          this.appendAll([...selectButtons, ...baseButtons]);
          break;
        case "page":
        case "forum":
        case "image":
        case "imageList":
        case "forumSection":
        case "forumThread":
        default:
          this.appendAll(baseButtons);
          break;
      }
      if (config.addUnlistedAndPrivate && !config.filterUnlistedAndPrivate && this.pageType === "videoList") {
        this.parseUnlistedAndPrivate();
      } else {
        GM_getValue("isDebug") && originalConsole.debug("[Debug] Conditions not met: addUnlistedAndPrivate or pageType mismatch.");
      }
    }
    inject() {
      try {
        this.observer.observe(unsafeWindow.document.getElementById("app"), { childList: true, subtree: true });
        if (!unsafeWindow.document.querySelector("#pluginMenu")) {
          originalNodeAppendChild.call(unsafeWindow.document.body, this.interface);
          this.pageType = getPageType() ?? this.pageType;
        }
      } catch (error) {
        originalNodeAppendChild.call(unsafeWindow.document.body, this.interface);
      }
    }
  };
  var DEBUG_SWITCH_THRESHOLD = 5;
  var waterMark = class {
    debugSwitchCount = 0;
    selected = renderNode({
      nodeType: "span",
      childs: ` %#selected#% ${selectList.size} `
    });
    debugFlag = renderNode({
      nodeType: "span",
      childs: `${GM_getValue("isDebug") ? `${i18nList[config.language].isDebug} ${GM_info.scriptHandler}` : ""}`
    });
    body = renderNode({
      nodeType: "p",
      className: "fixed-bottom-right",
      childs: [
        `%#appName#% ${GM_getValue("version")} `,
        this.selected,
        this.debugFlag
      ],
      events: {
        click: (e) => {
          if (GM_getValue("isDebug")) return;
          if (this.debugSwitchCount < DEBUG_SWITCH_THRESHOLD) {
            this.debugSwitchCount++;
            return;
          } else {
            GM_setValue("isDebug", true);
            this.debugFlag.textContent = `${GM_getValue("isDebug") ? i18nList[config.language].isDebug : ""}`;
            unsafeWindow.location.reload();
          }
        }
      }
    });
    inject() {
      originalNodeAppendChild.call(unsafeWindow.document.body, this.body);
    }
  };
  function handleAuthorizationHeader(init) {
    if (!init || !init.headers) return;
    let authorization = null;
    if (init.headers instanceof Headers) {
      authorization = init.headers.has("Authorization") ? init.headers.get("Authorization") : null;
    } else if (Array.isArray(init.headers)) {
      const index = init.headers.findIndex(([key]) => key.toLowerCase() === "authorization");
      if (index >= 0) authorization = init.headers[index][1];
    } else if (typeof init.headers === "object") {
      for (const key in init.headers) {
        if (key.toLowerCase() === "authorization") {
          authorization = init.headers[key];
          break;
        }
      }
    }
    if (!authorization) return;
    const payload = getPlayload(authorization);
    const token = authorization.split(" ").pop();
    if (payload["type"] === "refresh_token" && !isUndefined(token)) {
      localStorage.setItem("token", token);
      config.authorization = token;
      GM_getValue("isDebug") && originalConsole.debug(`[Debug] refresh_token: 凭证已隐藏`);
    }
  }
  async function handleUserTokenResponse(response) {
    const cloneResponse = response.clone();
    if (!cloneResponse.ok) return;
    const { accessToken } = await cloneResponse.json();
    const token = localStorage.getItem("accessToken");
    if (isNull(token) || token !== accessToken) {
      localStorage.setItem("accessToken", accessToken);
    }
  }
  async function handleVideosResponse(response, url) {
    const cloneResponse = response.clone();
    if (!cloneResponse.ok) return response;
    const cloneBody = await cloneResponse.json();
    const rawVideos = cloneBody.results;
    const parsePromises = rawVideos.map(
      (info) => parseVideoInfo({ Type: "cache", ID: info.id, RAW: info })
    );
    const settled = await Promise.allSettled(parsePromises);
    const list = settled.filter((i) => i.status === "fulfilled").map((i) => i.value).filter((i) => i.Type === "partial" || i.Type === "full");
    const ids = list.map((v2) => v2.ID);
    const existing = await db.getVideosByIds(ids);
    const fullVideos = existing.filter((v2) => v2.Type === "full");
    const toUpdate = list.difference(fullVideos, "ID");
    if (toUpdate.any()) {
      await db.bulkPutVideos(toUpdate);
    }
    if (config.filterLikedVideos) {
      cloneBody.results = rawVideos.filter((i) => !i.liked);
      cloneBody.limit = cloneBody.results.length;
      cloneBody.count = cloneBody.limit * (cloneBody.page + 1) + 1;
    }
    if (config.filterUnlistedAndPrivate && url.searchParams.has("subscribed")) {
      cloneBody.results = cloneBody.results.filter((i) => !i.private && !i.unlisted);
      cloneBody.limit = cloneBody.results.length;
      cloneBody.count = cloneBody.limit * (cloneBody.page + 1) + 1;
    }
    let preResponse = new Response(JSON.stringify(cloneBody), {
      status: cloneResponse.status,
      statusText: cloneResponse.statusText,
      headers: Object.fromEntries(cloneResponse.headers.entries())
    });
    if (!config.addUnlistedAndPrivate || config.filterUnlistedAndPrivate) return preResponse;
    if (url.searchParams.has("user")) return preResponse;
    if (url.searchParams.has("subscribed")) return preResponse;
    if (url.searchParams.has("sort") && url.searchParams.get("sort") !== "date") return preResponse;
    const sortedList = list.sort((a2, b2) => a2.UploadTime - b2.UploadTime);
    if (sortedList.length === 0) return preResponse;
    const minTime = sortedList[0].UploadTime;
    const maxTime = sortedList[sortedList.length - 1].UploadTime;
    const startTime = new Date(minTime).sub({ hours: 4 }).getTime();
    const endTime = new Date(maxTime).add({ hours: 4 }).getTime();
    const cacheVideos = (await db.getFilteredVideos(startTime, endTime)).filter((i) => i.Type === "partial" || i.Type === "full").sort((a2, b2) => b2.UploadTime - a2.UploadTime).map((i) => i.RAW);
    cloneBody.results.push(...cacheVideos);
    cloneBody.limit = cloneBody.results.length;
    cloneBody.count = cloneBody.limit * (cloneBody.page + 1) + 1;
    preResponse = new Response(JSON.stringify(cloneBody), {
      status: cloneResponse.status,
      statusText: cloneResponse.statusText,
      headers: Object.fromEntries(cloneResponse.headers.entries())
    });
    return preResponse;
  }
  function createInterceptedFetch() {
    return async function(input, init) {
      GM_getValue("isDebug") && originalConsole.debug(`[Debug] Fetch ${input}`);
      const url = (input instanceof Request ? input.url : input instanceof URL ? input.href : input).toURL();
      if (!isUndefined(init) && init.headers) {
        handleAuthorizationHeader(init);
      }
      return new Promise(
        (resolve, reject) => originalFetch(input, init).then(async (response) => {
          if (!url.pathname.isEmpty()) {
            const path = url.pathname.toLowerCase().split("/").slice(1);
            if (url.hostname === "apiq.iwara.tv" || url.hostname === "api.iwara.tv") {
              switch (path[0]) {
                case "user":
                  if (path[1] === "token") await handleUserTokenResponse(response);
                  break;
                case "videos":
                  return resolve(await handleVideosResponse(response, url));
                default:
                  break;
              }
            }
          }
          return resolve(response);
        }).catch((err) => reject(err))
      );
    };
  }
  var hostname = unsafeWindow.location.hostname;
  var domain2 = site_default.supportedDomains.find((d) => hostname === d || hostname.endsWith("." + d)) ?? "";
  if (!domain2) {
    throw "Not target";
  }
  switch (GM_info.scriptHandler) {
    case "Via":
    case "Tampermonkey":
    case "ScriptCat":
      break;
    default:
      throw `Not support ${GM_info.scriptHandler}`;
  }
  if (GM_getValue("isDebug")) {
    debugger;
    originalConsole.debug(stringify(GM_info));
    unsafeWindow.syncCachedToMediaCenter = syncCachedToMediaCenter;
    unsafeWindow.syncAllVideosPages = syncAllVideosPages;
    unsafeWindow.exportAllToJsonFiles = db.exportAllToJsonFiles.bind(db);
    unsafeWindow.exportToJsonFiles = db.exportToJsonFiles.bind(db);
  }
  unsafeWindow.fetch = createInterceptedFetch();
  var apiEndpoint = site_default.apiEndpoint;
  var isPageType = (type) => new Set(Object.values(PageType)).has(type);
  var isLoggedIn = () => !(unsafeWindow.localStorage.getItem("token") ?? "").isEmpty();
  var rating = () => localStorage.getItem("rating") ?? "all";
  var selectList = new GMSyncDictionary("selectList");
  var pageSelectButtons = new Dictionary();
  var mouseTarget = null;
  var pluginMenu = new menu();
  var editConfig = new configEdit(config);
  var watermark = new waterMark();
  selectList.onSet = (key) => {
    updateButtonState(key);
    updateSelected();
  };
  selectList.onDel = (key) => {
    updateButtonState(key);
    updateSelected();
  };
  selectList.onSync = () => {
    pageSelectButtons.forEach((value, key) => {
      updateButtonState(key);
    });
    updateSelected();
  };
  function getSelectButton(id) {
    return pageSelectButtons.has(id) ? pageSelectButtons.get(id) : unsafeWindow.document.querySelector(`input.selectButton[videoid="${id}"]`);
  }
  function getPageType(mutationsList) {
    if (unsafeWindow.location.pathname.toLowerCase().endsWith("/search")) {
      return "search";
    }
    const extractPageType = (page) => {
      if (isNullOrUndefined(page)) return void 0;
      if (page.classList.length < 2) return "page";
      const pageClass = page.classList[1]?.split("-").pop();
      return !isNullOrUndefined(pageClass) && isPageType(pageClass) ? pageClass : "page";
    };
    if (isNullOrUndefined(mutationsList)) {
      return extractPageType(unsafeWindow.document.querySelector(".page"));
    }
    for (const mutation of mutationsList) {
      if (mutation.type === "childList" && mutation.addedNodes.length > 0) {
        return extractPageType(Array.from(mutation.addedNodes).find((node) => node instanceof Element && node.classList.contains("page")));
      }
    }
  }
  function pageChange() {
    pluginMenu.pageType = getPageType() ?? pluginMenu.pageType;
    GM_getValue("isDebug") && originalConsole.debug("[Debug]", pageSelectButtons);
    __iwaraQueueSyncCurrentPageViews();
  }
  function updateSelected() {
    watermark.selected.textContent = ` ${i18nList[config.language].selected} ${selectList.size} `;
  }
  function updateButtonState(videoID) {
    const selectButton = getSelectButton(videoID);
    if (selectButton) selectButton.checked = selectList.has(videoID);
  }
  function hijackAddEventListener() {
    unsafeWindow.EventTarget.prototype.addEventListener = function(type, listener, options) {
      originalAddEventListener.call(this, type, listener, options);
    };
  }
  function hijackNodeAppendChild() {
    Node.prototype.appendChild = function(node) {
      if (node instanceof HTMLElement && node.classList.contains("videoTeaser")) {
        injectCheckbox(node);
      }
      return originalNodeAppendChild.call(this, node);
    };
  }
  function hijackNodeRemoveChild() {
    Node.prototype.removeChild = function(child) {
      uninjectCheckbox(child);
      return originalNodeRemoveChild.apply(this, [child]);
    };
  }
  function hijackElementRemove() {
    Element.prototype.remove = function() {
      uninjectCheckbox(this);
      return originalElementRemove.apply(this);
    };
  }
  function hijackHistoryPushState() {
    unsafeWindow.history.pushState = function(...args) {
      originalHistoryPushState.apply(this, args);
      pageChange();
    };
  }
  function hijackHistoryReplaceState() {
    unsafeWindow.history.replaceState = function(...args) {
      originalHistoryReplaceState.apply(this, args);
      pageChange();
    };
  }
  function hijackStorage() {
    unsafeWindow.Storage.prototype.setItem = function(key, value) {
      originalStorageSetItem.call(this, key, value);
      if (key === "token") pluginMenu.pageChange();
    };
    unsafeWindow.Storage.prototype.removeItem = function(key) {
      originalStorageRemoveItem.call(this, key);
      if (key === "token") pluginMenu.pageChange();
    };
    unsafeWindow.Storage.prototype.clear = function() {
      originalStorageClear.call(this);
      pluginMenu.pageChange();
    };
  }
  function firstRun() {
    GM_listValues().forEach((i) => GM_deleteValue(i));
    Config.destroyInstance();
    editConfig = new configEdit(config);
    let confirmButton = renderNode({
      nodeType: "button",
      attributes: {
        disabled: true,
        title: i18nList[config.language].ok
      },
      childs: "%#ok#%",
      events: {
        click: () => {
          GM_setValue("isFirstRun", false);
          GM_setValue("version", GM_info.script.version);
          unsafeWindow.document.querySelector("#pluginOverlay")?.remove();
          editConfig.inject();
        }
      }
    });
    originalNodeAppendChild.call(unsafeWindow.document.body, renderNode({
      nodeType: "div",
      attributes: {
        id: "pluginOverlay"
      },
      childs: [
        {
          nodeType: "div",
          className: "main",
          childs: [
            { nodeType: "p", childs: i18nList[config.language].useHelpForBase },
            { nodeType: "p", childs: "%#useHelpForInjectCheckbox#%" },
            { nodeType: "p", childs: "%#useHelpForCheckDownloadLink#%" },
            { nodeType: "p", childs: i18nList[config.language].useHelpForManualDownload },
            { nodeType: "p", childs: i18nList[config.language].useHelpForBugreport }
          ]
        },
        {
          nodeType: "div",
          className: "checkbox-container",
          childs: {
            nodeType: "label",
            className: ["checkbox-label", "rainbow-text"],
            childs: [
              {
                nodeType: "input",
                className: "checkbox",
                attributes: {
                  type: "checkbox",
                  name: "agree-checkbox"
                },
                events: {
                  change: (event) => {
                    confirmButton.disabled = !event.target.checked;
                  }
                }
              },
              "%#alreadyKnowHowToUse#%"
            ]
          }
        },
        confirmButton
      ]
    }));
  }
  async function main() {
    __iwaraQueueSyncCurrentPageViews();
    if (__iwaraQueueSniffEnabled) {
      await runBrowserFallbackSniffPage();
      return;
    }
    [rainbow_default, menu_default, config_default, overlay_default, videoCard_default, toast_default].forEach((css) => GM_addStyle(css));
    watermark.inject();
    if (new Version(GM_getValue("version", "0.0.0")).compare(new Version("3.3.0")) === 0) {
      GM_setValue("isFirstRun", true);
      alert(i18nList[config.language].configurationIncompatible);
    }
    if (GM_getValue("isFirstRun", true)) {
      firstRun();
      return;
    }
    if (new Version(GM_getValue("version", "0.0.0")).compare(new Version("3.3.22")) === 0) {
      alert(i18nList[config.language].configurationIncompatible);
      try {
        selectList.clear();
        GM_deleteValue("selectList");
        await db.delete();
        GM_setValue("version", GM_info.script.version);
        unsafeWindow.location.reload();
      } catch (error) {
        originalConsole.error(error);
      }
      return;
    }
    config.enableBeautify && GM_addStyle(beautify_default);
    config.enableWidescreen && GM_addStyle(widescreen_default);
    if (!await check()) {
      newToast(1, {
        text: `%#configError#%`,
        duration: 60 * 1e3
      }).show();
      editConfig.inject();
      return;
    }
    GM_setValue("version", GM_info.script.version);
    hijackAddEventListener();
    if (config.autoInjectCheckbox) hijackNodeAppendChild();
    hijackNodeRemoveChild();
    hijackElementRemove();
    hijackStorage();
    hijackHistoryPushState();
    hijackHistoryReplaceState();
    originalAddEventListener("mouseover", (event) => {
      mouseTarget = event.target instanceof Element ? event.target : null;
    });
    originalAddEventListener("keydown", (event) => {
      const keyboardEvent = event;
      if (keyboardEvent.code === "Space" && !isNullOrUndefined(mouseTarget)) {
        let element = findElement(mouseTarget, ".videoTeaser");
        let button = element && (element.matches(".selectButton") ? element : element.querySelector(".selectButton"));
        button && button.click();
        button && keyboardEvent.preventDefault();
      }
    });
    new MutationObserver(async (m2, o) => {
      if (m2.some((m3) => m3.type === "childList" && unsafeWindow.document.getElementById("app"))) {
        pluginMenu.inject();
        o.disconnect();
      }
    }).observe(unsafeWindow.document.body, { childList: true, subtree: true });
    startResilientQueueWorker();
    newToast(
      1,
      {
        node: toastNode(i18nList[config.language].notice),
        duration: 1e4,
        gravity: "bottom",
        position: "center",
        onClick() {
          this.hide();
        }
      }
    ).show();
    trackExistingAria2Tasks();
  }
  (unsafeWindow.document.body ? Promise.resolve() : new Promise((resolve) => originalAddEventListener.call(unsafeWindow.document, "DOMContentLoaded", resolve))).then(main);
})();
