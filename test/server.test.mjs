import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import {
  allowedOrigin,
  authorizeRequest,
  createServer,
  isLoopbackAddress
} from "../src/server.mjs";

function request(port, path, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: "127.0.0.1", port, path, headers }, response => {
      const chunks = [];
      response.on("data", chunk => chunks.push(chunk));
      response.on("end", () => resolve({
        status: response.statusCode,
        headers: response.headers,
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
