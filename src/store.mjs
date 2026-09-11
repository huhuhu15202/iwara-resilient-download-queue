import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

export class JsonStore {
  constructor(filePath) {
    this.filePath = filePath;
    this.state = { version: 1, tasks: [] };
    this.writeChain = Promise.resolve();
    this.loaded = false;
  }

  async load() {
    if (this.loaded) return this.state;
    await mkdir(path.dirname(this.filePath), { recursive: true });
    try {
      const parsed = JSON.parse(await readFile(this.filePath, "utf8"));
      if (parsed?.version === 1 && Array.isArray(parsed.tasks)) {
        this.state = parsed;
      }
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    this.loaded = true;
    return this.state;
  }

  async save() {
    const snapshot = JSON.stringify(this.state, null, 2);
    const tempPath = `${this.filePath}.tmp`;
    this.writeChain = this.writeChain.then(async () => {
      await writeFile(tempPath, snapshot, "utf8");
      await rename(tempPath, this.filePath);
    });
    return this.writeChain;
  }
}
