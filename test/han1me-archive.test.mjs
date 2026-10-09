import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import http from "node:http";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { deflateRawSync } from "node:zlib";
import { createServer, authorizeRequest } from "../src/server.mjs";
import { receiveHan1meArchive } from "../src/han1me-archive.mjs";
import { SQLiteStore } from "../src/sqlite-store.mjs";
import { StorageTransferStore } from "../src/storage-transfer-store.mjs";

const crcTable = new Uint32Array(256);
for (let n = 0; n < 256; n++) {
  let value = n;
  for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  crcTable[n] = value >>> 0;
}

function crc32(buffer) {
  let value = 0xffffffff;
  for (const byte of buffer) value = crcTable[(value ^ byte) & 0xff] ^ (value >>> 8);
  return (value ^ 0xffffffff) >>> 0;
}

function zipStored(files, useDataDescriptor = false) {
  const local = [];
  const central = [];
  let offset = 0;
  for (const [name, contents] of files) {
    const filename = Buffer.from(name, "utf8");
    const data = Buffer.isBuffer(contents) ? contents : Buffer.from(contents);
    const compressed = useDataDescriptor ? deflateRawSync(data, { level: 0 }) : data;
    const crc = crc32(data);
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(useDataDescriptor ? 0x0808 : 0x0800, 6);
    header.writeUInt16LE(useDataDescriptor ? 8 : 0, 8);
    header.writeUInt32LE(useDataDescriptor ? 0 : crc, 14);
    header.writeUInt32LE(useDataDescriptor ? 0 : compressed.length, 18);
    header.writeUInt32LE(useDataDescriptor ? 0 : data.length, 22);
    header.writeUInt16LE(filename.length, 26);
    header.writeUInt16LE(0, 28);
    local.push(header, filename, compressed);
    if (useDataDescriptor) {
      const descriptor = Buffer.alloc(16);
      descriptor.writeUInt32LE(0x08074b50, 0);
      descriptor.writeUInt32LE(crc, 4);
      descriptor.writeUInt32LE(compressed.length, 8);
      descriptor.writeUInt32LE(data.length, 12);
      local.push(descriptor);
    }

    const directory = Buffer.alloc(46);
    directory.writeUInt32LE(0x02014b50, 0);
    directory.writeUInt16LE(0x0314, 4);
    directory.writeUInt16LE(20, 6);
    directory.writeUInt16LE(useDataDescriptor ? 0x0808 : 0x0800, 8);
    directory.writeUInt16LE(useDataDescriptor ? 8 : 0, 10);
    directory.writeUInt32LE(crc, 16);
    directory.writeUInt32LE(compressed.length, 20);
    directory.writeUInt32LE(data.length, 24);
    directory.writeUInt16LE(filename.length, 28);
    directory.writeUInt16LE(0, 30);
    directory.writeUInt16LE(0, 32);
    directory.writeUInt16LE(0, 34);
    directory.writeUInt16LE(0, 36);
    directory.writeUInt32LE(0x81a40000, 38);
    directory.writeUInt32LE(offset, 42);
    central.push(directory, filename);
    offset += header.length + filename.length + compressed.length + (useDataDescriptor ? 16 : 0);
  }
  const directoryBytes = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(directoryBytes.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, directoryBytes, end]);
}

function hash(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

function validArchive(code = "123456", tamperHash = false, includeWindowsCaseCollision = false) {
  const video = Buffer.alloc(65_536, 0x2a);
  const cover = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3]);
  const info = Buffer.from(JSON.stringify({ id: code, title: "归档测试", artist: "Codex" }));
  const files = [
    { path: `${code}/video_1080p.mp4`, contents: video },
    { path: `${code}/cover.png`, contents: cover },
    { path: `${code}/info.json`, contents: info },
  ];
  if (includeWindowsCaseCollision) {
    files.splice(1, 0, { path: `${code}/VIDEO_1080P.MP4`, contents: video });
  }
  const manifest = {
    type: "han1meviewer-archive",
    version: 1,
    createdAt: new Date().toISOString(),
    videos: [{ code, title: "归档测试" }],
    files: files.map(file => ({ path: file.path, size: file.contents.length, sha256: hash(file.contents) })),
  };
  if (tamperHash) manifest.files[0].sha256 = "0".repeat(64);
  return {
    video,
    cover,
    info,
    zip: zipStored([
      ...files.map(file => [file.path, file.contents]),
      ["manifest.json", JSON.stringify(manifest)],
    ], true),
  };
}

async function receive(root, zip) {
  return receiveHan1meArchive(Readable.from([zip]), root);
}

function postArchive(port, zip, contentType = "application/zip") {
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: "127.0.0.1",
      port,
      path: "/api/mobile/han1me-archive",
      method: "POST",
      headers: { "content-type": contentType, "content-length": zip.length },
    }, response => {
      const chunks = [];
      response.on("data", chunk => chunks.push(chunk));
      response.on("end", () => resolve({ status: response.statusCode, body: Buffer.concat(chunks).toString("utf8") }));
    });
    req.on("error", reject);
    req.end(zip);
  });
}

function apiRequest(port, pathname, method, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const payload = Buffer.isBuffer(body) ? body : body == null ? null : Buffer.from(JSON.stringify(body));
    const requestHeaders = { ...headers };
    if (payload) requestHeaders["content-length"] = payload.length;
    if (body != null && !requestHeaders["content-type"]) requestHeaders["content-type"] = Buffer.isBuffer(body) ? "application/zip" : "application/json";
    const req = http.request({ hostname: "127.0.0.1", port, path: pathname, method, headers: requestHeaders }, response => {
      const chunks = [];
      response.on("data", chunk => chunks.push(chunk));
      response.on("end", () => resolve({ status: response.statusCode, body: Buffer.concat(chunks).toString("utf8") }));
    });
    req.on("error", reject);
    req.end(payload);
  });
}

function v2Archive(code, transferId) {
  const files = [
    { path: `${code}/video.mp4`, contents: Buffer.alloc(65_536, 0x35), role: "media" },
    { path: `${code}/cover.png`, contents: Buffer.from("isolated-cover"), role: "cover" },
    { path: `${code}/info.json`, contents: Buffer.from(JSON.stringify({ id: code, title: "v2 isolated", artist: "test" })), role: "metadata" },
  ];
  const manifest = {
    type: "han1meviewer-archive", version: 2, transferId,
    videos: [{ code, title: "v2 isolated" }],
    files: files.map(file => ({
      source: "han1", sourceId: code, taskId: "", role: file.role, path: file.path,
      size: file.contents.length, sha256: hash(file.contents),
    })),
  };
  return {
    files,
    zip: zipStored([...files.map(file => [file.path, file.contents]), ["manifest.json", JSON.stringify(manifest)]], true),
  };
}

test("Han1me archive extracts video, PNG and info.json and repeated upload is idempotent", async () => {
  const parent = await mkdtemp(path.join(tmpdir(), "iwara-han1me-archive-"));
  const root = path.join(parent, "hanime_download");
  const archive = validArchive();
  try {
    const first = await receive(root, archive.zip);
    assert.deepEqual(first.codes, ["123456"]);
    assert.equal(first.codeCount, 1);
    assert.equal(first.fileCount, 3);
    assert.equal(first.addedFileCount, 3);
    assert.deepEqual(await readFile(path.join(root, "123456", "video_1080p.mp4")), archive.video);
    assert.deepEqual(await readFile(path.join(root, "123456", "cover.png")), archive.cover);
    assert.deepEqual(await readFile(path.join(root, "123456", "info.json")), archive.info);

    const repeated = await receive(root, archive.zip);
    assert.deepEqual(repeated.codes, ["123456"]);
    assert.equal(repeated.addedFileCount, 0);
    assert.equal(repeated.alreadyPresentCount, 3);
    assert.deepEqual((await readdir(root)).sort(), ["123456"]);
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test("Han1me archive rejects traversal, mismatched hashes, and media collisions without overwriting", async () => {
  const parent = await mkdtemp(path.join(tmpdir(), "iwara-han1me-archive-"));
  const root = path.join(parent, "hanime_download");
  const archive = validArchive();
  try {
    const traversal = zipStored([["../outside.mp4", Buffer.alloc(65_536)], ["manifest.json", "{}"]]);
    await assert.rejects(receive(root, traversal), /invalid relative path|不允许的路径/);
    await assert.rejects(
      receive(root, zipStored([["123456/CON.png", Buffer.from("reserved")], ["manifest.json", "{}"]])),
      /不允许的路径/,
    );
    await assert.rejects(receive(root, validArchive("123456", false, true).zip), /重复文件/);
    await assert.rejects(readFile(path.join(parent, "outside.mp4")), error => error.code === "ENOENT");

    await assert.rejects(receive(root, validArchive("123456", true).zip));
    assert.deepEqual(await readdir(root).catch(() => []), []);

    await mkdir(path.join(root, "123456"), { recursive: true });
    await writeFile(path.join(root, "123456", "video_1080p.mp4"), Buffer.alloc(65_536, 0x55));
    await assert.rejects(receive(root, archive.zip), /同名但内容不同/);
    assert.deepEqual(await readFile(path.join(root, "123456", "video_1080p.mp4")), Buffer.alloc(65_536, 0x55));
    assert.equal(await readFile(path.join(root, "123456", "info.json")).then(() => true, () => false), false);
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test("LAN archive endpoint stores files and retains the existing mobile code-sync route", async () => {
  const parent = await mkdtemp(path.join(tmpdir(), "iwara-han1me-archive-api-"));
  const root = path.join(parent, "hanime_download");
  const archive = validArchive("987654");
  let scans = 0;
  const importer = {
    root,
    status: () => ({ enabled: true }),
    scan: async () => { scans += 1; return {}; },
    downloadCodes: async () => ({ codes: ["987654", "987655"], codeCount: 2, videoFileCount: 2 }),
    stop: async () => {},
  };
  const service = createServer({
    scheduler: { status: () => ({ ok: true }) },
    han1meImporter: importer,
    host: "127.0.0.1",
    port: 0,
    accessToken: "secret",
    onShutdown() {},
  });
  await service.listen();
  const port = service.server.address().port;
  try {
    const unsupported = await postArchive(port, archive.zip, "application/octet-stream");
    assert.equal(unsupported.status, 415);
    const uploaded = await postArchive(port, archive.zip);
    assert.equal(uploaded.status, 200);
    assert.deepEqual(JSON.parse(uploaded.body).codes, ["987654"]);
    assert.deepEqual(await readFile(path.join(root, "987654", "video_1080p.mp4")), archive.video);
    const nextBatch = validArchive("987655");
    const uploadedNextBatch = await postArchive(port, nextBatch.zip);
    assert.equal(uploadedNextBatch.status, 200);
    assert.deepEqual(JSON.parse(uploadedNextBatch.body).codes, ["987655"]);
    assert.deepEqual(await readFile(path.join(root, "987655", "video_1080p.mp4")), nextBatch.video);
    await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(scans, 2);
    const synchronized = await new Promise((resolve, reject) => {
      http.get({ hostname: "127.0.0.1", port, path: "/api/mobile/han1me-download-codes" }, response => {
        const chunks = [];
        response.on("data", chunk => chunks.push(chunk));
        response.on("end", () => resolve({ status: response.statusCode, body: Buffer.concat(chunks).toString("utf8") }));
      }).on("error", reject);
    });
    assert.equal(synchronized.status, 200);
    assert.deepEqual(JSON.parse(synchronized.body).codes, ["987654", "987655"]);
  } finally {
    await service.close();
    await rm(parent, { recursive: true, force: true });
  }
});

test("Han v2 HTTP upload verifies the frozen ZIP, indexes files against a ledger row, and persists its receipt", async () => {
  const parent = await mkdtemp(path.join(tmpdir(), "iwara-han-v2-http-"));
  const root = path.join(parent, "han-receive");
  const code = "567890123";
  const repository = { id: "han-isolated", name: "isolated", path: root, source: "han1", enabled: true,
    roles: ["receive", "scan", "serve"], priority: 1, minimumFreeBytes: 0 };
  const db = new SQLiteStore({ filePath: path.join(parent, "ledger.sqlite"), legacyJsonPath: path.join(parent, "none.json"), backupRoot: path.join(parent, "backups") });
  await db.load();
  db.state.tasks.push({ id: "fixture-task", videoId: `han1meview-${code}`, sourcePlatform: "han1meview", state: "completed", title: "isolated fixture" });
  const transfers = new StorageTransferStore(db.db);
  const importer = { scan: async () => ({}), stop: async () => {} };
  const service = createServer({
    scheduler: { status: () => ({}), config: { storageRepositories: [repository] }, store: db },
    storageTransferStore: transfers, han1meImporter: importer, host: "127.0.0.1", port: 0,
    accessToken: "isolated-only-token", onShutdown() {},
  });
  await service.listen();
  const port = service.server.address().port;
  try {
    const archiveFiles = v2Archive(code, "00000000-0000-4000-8000-000000000000").files;
    const files = archiveFiles.map(file => ({ source: "han1", sourceId: code, taskId: "", role: file.role,
      relativePath: file.path, size: file.contents.length, sha256: hash(file.contents) }));
    const created = await apiRequest(port, "/api/mobile/transfers", "POST", {
      direction: "upload", source: "han1", repositoryId: repository.id, requestKey: "isolated-v2-upload", files,
    }, { "x-iwara-access-token": "isolated-only-token" });
    assert.equal(created.status, 201, created.body);
    const plan = JSON.parse(created.body);
    const archive = v2Archive(code, plan.id);
    const batch = plan.batches[0];
    const uploaded = await apiRequest(port, `/api/mobile/transfers/${plan.id}/batches/${batch.id}/archive`, "PUT", archive.zip,
      { "content-type": "application/zip", "x-iwara-access-token": "isolated-only-token" });
    assert.equal(uploaded.status, 200, uploaded.body);
    assert.equal(JSON.parse(uploaded.body).saved, true);

    const recovered = await apiRequest(port, `/api/mobile/transfers/${plan.id}`, "GET", null,
      { "x-iwara-access-token": "isolated-only-token" });
    assert.equal(recovered.status, 200, recovered.body);
    const result = JSON.parse(recovered.body);
    assert.equal(result.state, "confirmed");
    assert.deepEqual(result.batches[0].files.map(file => file.state), ["indexed", "indexed", "indexed"]);
    assert.equal(result.batches[0].payload.archiveBytes, archive.zip.length);
    for (const file of archive.files) assert.deepEqual(await readFile(path.join(root, file.path)), file.contents);
    assert.deepEqual((await readdir(parent)).filter(name => name.startsWith(".han1me-archive-") || name.startsWith(".han1me-")), [],
      "the temporary ZIP and extraction tree are removed after commit");
  } finally {
    await service.close();
    db.close();
    await rm(parent, { recursive: true, force: true });
  }
});

test("mobile archive uploads still require the LAN token for non-loopback clients", () => {
  const request = { method: "POST", socket: { remoteAddress: "192.168.1.55" }, headers: {} };
  const url = new URL("http://192.168.1.10:18777/api/mobile/han1me-archive");
  assert.equal(authorizeRequest(request, url, "secret").ok, false);
  assert.equal(authorizeRequest({ ...request, headers: { "x-iwara-access-token": "secret" } }, url, "secret").ok, true);
});
