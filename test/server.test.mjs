import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { Script } from "node:vm";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  allowedOrigin,
  authorizeRequest,
  createServer,
  isLoopbackAddress
} from "../src/server.mjs";
import { issueResourceTicket, verifyResourceTicket, RESOURCE_TICKET_LIFETIME_MS } from "../src/resource-ticket.mjs";

function request(port, path, headers = {}, method = "GET") {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: "127.0.0.1", port, path, headers, method }, response => {
      const chunks = [];
      response.on("data", chunk => chunks.push(chunk));
      response.on("end", () => resolve({
        status: response.statusCode,
        headers: response.headers,
        raw: Buffer.concat(chunks),
        body: Buffer.concat(chunks).toString("utf8")
      }));
    });
    req.on("error", reject);
    req.end();
  });
}

test("LAN origin and token helpers only accept private/authorized clients", () => {
  assert.equal(isLoopbackAddress("::ffff:127.0.0.1"), true);
  assert.equal(isLoopbackAddress("192.168.1.10"), false);
  assert.equal(allowedOrigin("http://192.168.1.10:18777", "192.168.1.10:18777"), true);
  assert.equal(allowedOrigin("https://example.com", "192.168.1.10:18777"), false);

  const url = new URL("http://192.168.1.10:18777/playlist");
  const remote = address => ({ socket: { remoteAddress: address }, headers: {} });
  assert.equal(authorizeRequest(remote("192.168.1.20"), url, "secret").ok, false);
  assert.equal(authorizeRequest({ socket: { remoteAddress: "192.168.1.20" }, headers: { "x-iwara-access-token": "secret" } }, url, "secret").ok, true);
  assert.equal(authorizeRequest({ socket: { remoteAddress: "192.168.1.20" }, headers: { cookie: "iwara_lan_token=secret" } }, url, "secret").ok, true);
  assert.equal(authorizeRequest({ socket: { remoteAddress: "192.168.1.20" }, headers: {} }, new URL("http://x/?access_token=secret"), "secret").viaQuery, true);
  assert.equal(authorizeRequest(remote("127.0.0.1"), url, "secret").ok, true);
});

test("resource tickets authorize only their video asset and expire after twelve hours", () => {
  const now = 1_800_000_000_000;
  const ticket = issueResourceTicket("secret", "media", "video-a", now);
  assert.equal(verifyResourceTicket("secret", "media", "video-a", ticket, now + 1000), true);
  assert.equal(verifyResourceTicket("secret", "cover", "video-a", ticket, now), false);
  assert.equal(verifyResourceTicket("secret", "media", "video-b", ticket, now), false);
  assert.equal(verifyResourceTicket("other", "media", "video-a", ticket, now), false);
  assert.equal(verifyResourceTicket("secret", "media", "video-a", ticket, now + RESOURCE_TICKET_LIFETIME_MS + 1), false);
  const remote = method => ({ socket: { remoteAddress: "192.168.1.20" }, method, headers: {} });
  const url = new URL(`http://192.168.1.10:18777/media/video-a?ticket=${ticket}`);
  assert.equal(authorizeRequest(remote("GET"), url, "secret").ok, false); // mocked clock is in the past
  const live = issueResourceTicket("secret", "media", "video-a");
  url.searchParams.set("ticket", live);
  assert.equal(authorizeRequest(remote("GET"), url, "secret").ok, true);
  assert.equal(authorizeRequest(remote("HEAD"), url, "secret").ok, true);
  assert.equal(authorizeRequest(remote("POST"), url, "secret").ok, false);
  assert.equal(authorizeRequest(remote("GET"), new URL(`http://x/api/ledger?ticket=${live}`), "secret").ok, false);
});

test("LAN info endpoint is available on the local service", async () => {
  const scheduler = { status: () => ({ ok: true }) };
  const service = createServer({
    scheduler,
    host: "127.0.0.1",
    port: 0,
    accessToken: "secret",
    onShutdown: () => {}
  });
  await service.listen();
  const port = service.server.address().port;
  try {
    const response = await request(port, "/api/lan-info");
    assert.equal(response.status, 200);
    const payload = JSON.parse(response.body);
    assert.equal(payload.enabled, true);
    assert.equal(payload.port, 0);
  } finally {
    await service.close();
  }
});

test("playlist resource URLs and media ranges work without changing the stored video", async () => {
  const temp = await mkdtemp(path.join(tmpdir(), "iwara-media-range-"));
  const filePath = path.join(temp, "sample.mp4");
  const bytes = Buffer.alloc(8192);
  bytes.write("ftyp", 4);
  await writeFile(filePath, bytes);
  const scheduler = {
    status: () => ({ ok: true }),
    playlist: async () => ({ total: 1, page: 1, pageSize: 30, items: [{ id: "video-a", title: "sample" }] }),
    mediaPath: async id => {
      if (id !== "video-a") throw new Error("本地视频不存在");
      return { path: filePath, name: "sample.mp4" };
    }
  };
  const service = createServer({ scheduler, host: "127.0.0.1", port: 0, accessToken: "secret", onShutdown: () => {} });
  await service.listen();
  const port = service.server.address().port;
  try {
    const list = await request(port, "/playlist-data?pageSize=30");
    assert.equal(list.status, 200);
    const item = JSON.parse(list.body).items[0];
    assert.match(item.streamUrl, /^\/media\/video-a\?ticket=/);
    assert.match(item.coverUrl, /^\/cover\/video-a\?ticket=/);
    assert.equal(item.streamUrl.includes("secret"), false);
    const page = await request(port, "/playlist");
    assert.equal(page.status, 200);
    const script = /<script>([\s\S]*?)<\/script>/.exec(page.body)?.[1];
    assert.ok(script);
    assert.doesNotThrow(() => new Script(script));
    const head = await request(port, item.streamUrl, { range: "bytes=100-" }, "HEAD");
    assert.equal(head.status, 206);
    assert.equal(head.headers["content-range"], "bytes 100-8191/8192");
    assert.equal(head.raw.length, 0);
    const open = await request(port, item.streamUrl, { range: "bytes=100-" });
    assert.equal(open.status, 206);
    assert.equal(open.raw.length, 8092);
    const suffix = await request(port, item.streamUrl, { range: "bytes=-200" });
    assert.equal(suffix.status, 206);
    assert.equal(suffix.raw.length, 200);
    assert.equal(suffix.headers["content-range"], "bytes 7992-8191/8192");
    const multiple = await request(port, item.streamUrl, { range: "bytes=0-3,100-103" });
    assert.equal(multiple.status, 206);
    assert.match(multiple.headers["content-type"], /^multipart\/byteranges; boundary=/);
    assert.equal(multiple.raw.length, Number(multiple.headers["content-length"]));
    assert.match(multiple.body, /Content-Range: bytes 0-3\/8192/);
    assert.match(multiple.body, /Content-Range: bytes 100-103\/8192/);
    const invalid = await request(port, item.streamUrl, { range: "bytes=9000-" });
    assert.equal(invalid.status, 416);
    const emptySuffix = await request(port, item.streamUrl, { range: "bytes=-0" });
    assert.equal(emptySuffix.status, 416);
    const diagnostics = await request(port, "/api/media-diagnostics/video-a?since=0");
    assert.equal(diagnostics.status, 200);
    assert.equal(JSON.parse(diagnostics.body).events.at(-1).status, 416);
    await rm(filePath);
    assert.equal((await request(port, item.streamUrl)).status, 404);
    assert.equal((await request(port, item.coverUrl)).status, 404);
  } finally {
    await service.close();
    await rm(temp, { recursive: true, force: true });
  }
});
