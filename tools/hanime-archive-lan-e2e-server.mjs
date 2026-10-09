import { mkdtemp, mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { createServer as createHttpServer, request as httpRequest } from "node:http";
import os from "node:os";
import path from "node:path";
import { createServer } from "../src/server.mjs";
import { SQLiteStore } from "../src/sqlite-store.mjs";
import { StorageTransferStore } from "../src/storage-transfer-store.mjs";

const port = Number(process.argv[2] || 18880);
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error("Invalid isolated test port");
const testHost = "0.0.0.0";

const root = await mkdtemp(path.join(os.tmpdir(), "han1me-lan-roundtrip-e2e-"));
const repositoryRoot = path.join(root, "han-repository");
const legacyDirectory = path.join(repositoryRoot, "8000000000");
await mkdir(legacyDirectory, { recursive: true });
await writeFile(path.join(legacyDirectory, "legacy-fixture.mp4"), Buffer.from("isolated-fixture"), { flag: "wx" });

const testStore = new SQLiteStore({
  filePath: path.join(root, "ledger.sqlite"),
  legacyJsonPath: path.join(root, "unused-state.json"),
  backupRoot: path.join(root, "backups"),
});
await testStore.load();
const transferStore = new StorageTransferStore(testStore.db);
const repository = {
  id: "han-e2e-repository",
  name: "隔离测试仓库",
  path: repositoryRoot,
  source: "han1",
  enabled: true,
  roles: ["receive", "scan", "serve"],
  priority: 1,
  minimumFreeBytes: 0,
};

const importer = {
  root: repositoryRoot,
  status: () => ({ enabled: true, codeCount: 0, videoFileCount: 0 }),
  scan: async () => {
    const imported = [];
    for (const entry of await readdir(repositoryRoot, { withFileTypes: true })) {
      if (!entry.isDirectory() || !/^\d{1,30}$/.test(entry.name)) continue;
      for (const file of await readdir(path.join(repositoryRoot, entry.name), { withFileTypes: true })) {
        if (!file.isFile() || !/\.(?:mp4|webm|mkv|mov|avi|m4v)$/i.test(file.name)) continue;
        const mediaPath = path.join(repositoryRoot, entry.name, file.name);
        imported.push({
          id: `han-e2e-${entry.name}`,
          videoId: `han1meview-${entry.name}`,
          sourcePlatform: "han1meview",
          state: "completed",
          destination: mediaPath,
          title: file.name,
          author: "",
          alias: "",
          tags: [],
        });
      }
    }
    testStore.state.tasks = imported;
  },
  downloadCodes: async () => {
    const codes = [];
    let videoFileCount = 0;
    for (const entry of await readdir(repositoryRoot, { withFileTypes: true })) {
      if (!entry.isDirectory() || !/^\d{1,30}$/.test(entry.name)) continue;
      const files = await readdir(path.join(repositoryRoot, entry.name), { withFileTypes: true });
      const videos = files.filter(file => file.isFile() && /\.(?:mp4|webm|mkv|mov|avi|m4v)$/i.test(file.name));
      if (!videos.length) continue;
      codes.push(entry.name);
      videoFileCount += videos.length;
    }
    codes.sort();
    return { codes, codeCount: codes.length, videoFileCount };
  },
};

const scheduler = {
  config: { storageRepositories: [repository] },
  store: testStore,
  setWebPresence() {},
};
const service = createServer({
  scheduler,
  host: testHost,
  port,
  accessToken: "han1me-e2e-isolated-token",
  han1meImporter: importer,
  storageTransferStore: transferStore,
  onShutdown: () => { void cleanup(); },
});
function createForwarder({ dropResponseWhen = () => false, cutAfterBytes = 0, cutRequestWhen = () => true, testState = null } = {}) {
  return createHttpServer((incoming, outgoing) => {
    if (testState && incoming.method === "GET" && incoming.url === "/__test/e2e-state") {
      const body = Buffer.from(JSON.stringify(testState()));
      outgoing.writeHead(200, { "content-type": "application/json", "content-length": body.length, "cache-control": "no-store" });
      outgoing.end(body);
      return;
    }
    const dropThisResponse = dropResponseWhen(incoming);
    const cutThisRequest = cutAfterBytes > 0 && cutRequestWhen(incoming);
    const upstream = httpRequest({
      hostname: "127.0.0.1",
      port,
      method: incoming.method,
      path: incoming.url,
      headers: { ...incoming.headers, host: `127.0.0.1:${port}` },
    }, response => {
      if (dropThisResponse) {
        response.resume();
        response.once("end", () => outgoing.destroy());
        return;
      }
      outgoing.writeHead(response.statusCode || 502, response.headers);
      response.pipe(outgoing);
    });
    upstream.on("error", () => { if (!outgoing.destroyed) outgoing.destroy(); });

    if (!cutThisRequest) {
      incoming.pipe(upstream);
      return;
    }
    let forwarded = 0;
    let interrupted = false;
    incoming.on("data", chunk => {
      if (interrupted) return;
      const count = Math.min(chunk.length, cutAfterBytes - forwarded);
      if (count > 0) {
        upstream.write(chunk.subarray(0, count));
        forwarded += count;
      }
      if (forwarded >= cutAfterBytes) {
        interrupted = true;
        upstream.destroy(new Error("isolated test interruption"));
        outgoing.destroy();
        incoming.destroy();
      }
    });
    incoming.once("end", () => { if (!interrupted) upstream.end(); });
  });
}
let shouldDropNextArchiveResponse = true;
let droppedArchiveResponseCount = 0;
const isArchiveUpload = request => request.method === "PUT" && /\/api\/mobile\/transfers\/[^/]+\/batches\/[^/]+\/archive$/.test(request.url || "");
const dropResponseProxy = createForwarder({
  dropResponseWhen: request => {
    if (!shouldDropNextArchiveResponse || !isArchiveUpload(request)) return false;
    shouldDropNextArchiveResponse = false;
    droppedArchiveResponseCount += 1;
    console.log("Isolated test dropped one committed archive response.");
    return true;
  },
  testState: () => ({ droppedArchiveResponses: droppedArchiveResponseCount }),
});
const cutBodyProxy = createForwarder({ cutAfterBytes: 16 * 1024, cutRequestWhen: isArchiveUpload });

let closing;
function closeProxy(server) {
  return new Promise(resolve => {
    if (!server.listening) return resolve();
    server.close(resolve);
    server.closeAllConnections?.();
  });
}
async function cleanup() {
  if (closing) return closing;
  closing = (async () => {
    await Promise.all([
      service.close(),
      closeProxy(dropResponseProxy),
      closeProxy(cutBodyProxy),
    ]);
    testStore.close();
    await rm(root, { recursive: true, force: true });
  })();
  return closing;
}

process.once("SIGINT", () => { void cleanup().finally(() => process.exit(0)); });
process.once("SIGTERM", () => { void cleanup().finally(() => process.exit(0)); });
await Promise.all([
  new Promise((resolve, reject) => { dropResponseProxy.once("error", reject); dropResponseProxy.listen(port + 1, testHost, resolve); }),
  new Promise((resolve, reject) => { cutBodyProxy.once("error", reject); cutBodyProxy.listen(port + 2, testHost, resolve); }),
]);
await service.listen();
console.log(`Isolated Han archive receiver and fault-injection proxies listening on local test ports starting at ${port}; temporary synthetic repository only.`);
