import { createHash, randomBytes } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createServer } from "../src/server.mjs";

const port = Number(process.argv[2] || 18879);
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error("Invalid isolated test port");
const root = await mkdtemp(path.join(os.tmpdir(), "iwara-mobile-random-e2e-"));
const tasks = [];
const byId = new Map();
const sizes = [128 * 1024, 256 * 1024, 768 * 1024, 1536 * 1024, 3 * 1024 * 1024, 4 * 1024 * 1024];

for (let index = 0; index < 25; index += 1) {
  const isInterruptFixture = index === 24;
  const isHan = index % 2 === 1;
  const id = isInterruptFixture ? "fixture-local-interrupt" : `fixture-${isHan ? "han" : "iwara"}-${String(index).padStart(2, "0")}`;
  const videoId = isInterruptFixture ? "local-interrupt-fixture" : isHan ? `han1meview-${910000 + index}` : `iwara-fixture-${String(index).padStart(2, "0")}`;
  const destination = path.join(root, `隔离样例-${id}.mp4`);
  const bytes = randomBytes(isInterruptFixture ? 64 * 1024 * 1024 : sizes[index % sizes.length]);
  await writeFile(destination, bytes, { flag: "wx" });
  const digest = createHash("sha256").update(bytes).digest("hex");
  const task = {
    id,
    videoId,
    sourcePlatform: isInterruptFixture ? "local_import" : isHan ? "han1meview" : "iwara",
    sourcePage: isInterruptFixture || isHan ? "" : `https://www.iwara.tv/video/${videoId}`,
    localOnly: isInterruptFixture,
    title: `Android isolated transfer fixture ${id} sha256=${digest}`,
    author: isHan ? "Fixture Han Author" : "Fixture Iwara Author",
    state: "completed",
    fileStatus: "present",
    destination,
    tags: isHan ? ["隔离测试", "fixture-han", "transfer-test"] : ["隔离测试", "fixture-iwara", "transfer-test"],
    completedAt: new Date().toISOString(),
    views: 1234 + index
  };
  tasks.push(task);
  byId.set(id, task);
}

const scheduler = {
  config: { downloadRoot: root, externalMediaRoots: [] },
  store: { state: { tasks } },
  setWebPresence() {},
  mediaPath: async id => {
    const task = byId.get(id);
    if (!task) throw new Error("isolated fixture missing");
    return { path: task.destination, name: path.basename(task.destination) };
  }
};
const service = createServer({ scheduler, host: "0.0.0.0", port, accessToken: "mobile-e2e-only-token", mobileLibrary: {}, onShutdown: () => { void cleanup(); } });
let closing = false;
async function cleanup() {
  if (closing) return;
  closing = true;
  try { await service.close(); } finally { await rm(root, { recursive: true, force: true }); }
}

process.once("SIGINT", () => { void cleanup().finally(() => process.exit(0)); });
process.once("SIGTERM", () => { void cleanup().finally(() => process.exit(0)); });
await service.listen();
console.log(`Isolated Android random-download sender listening on 0.0.0.0:${port}; synthetic files only; token=mobile-e2e-only-token`);
