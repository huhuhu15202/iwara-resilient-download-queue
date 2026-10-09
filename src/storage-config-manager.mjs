import { copyFile, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { applyRepositoriesToLegacyConfig, normalizeStorageRepositories, repositoryRevision, validateStorageRepositories } from "./storage-repositories.mjs";

const ENV_LOCKS = Object.freeze({
  downloadRoot: "IWARA_DOWNLOAD_ROOT",
  fallbackDownloadRoot: "IWARA_FALLBACK_DOWNLOAD_ROOT"
});

export class StorageConfigManager {
  constructor({ config, configPath, env = process.env }) {
    this.config = config;
    this.configPath = configPath;
    this.env = env;
    this.repositories = normalizeStorageRepositories(config);
    this.revision = String(config.storageRepositoriesRevision || JSON.stringify(repositoryRevision(this.repositories)));
    this.pendingRestart = false;
  }

  view() {
    const locks = Object.entries(ENV_LOCKS)
      .filter(([, key]) => String(this.env[key] || "").trim())
      .map(([field, variable]) => ({ field, variable }));
    return {
      version: 1,
      revision: this.revision,
      pendingRestart: this.pendingRestart,
      repositories: this.repositories.map(item => ({ ...item, path: item.path })),
      environmentLocks: locks
    };
  }

  async validate(repositories) {
    return validateStorageRepositories(repositories);
  }

  async save(repositories, expectedRevision) {
    if (expectedRevision !== this.revision) {
      const error = new Error("仓库配置已被其他页面修改，请重新载入后再保存");
      error.statusCode = 409;
      throw error;
    }
    const locks = Object.entries(ENV_LOCKS).filter(([, key]) => String(this.env[key] || "").trim());
    if (locks.length) {
      const error = new Error(`环境变量 ${locks.map(([, key]) => key).join("、")} 覆盖了仓库配置；请先在启动配置中修改，管理页不会覆盖它`);
      error.statusCode = 409;
      throw error;
    }
    const normalized = await validateStorageRepositories(repositories);
    const merged = applyRepositoriesToLegacyConfig(this.config, normalized);
    merged.storageRepositoriesVersion = 1;
    merged.storageRepositoriesRevision = randomUUID();
    const serialized = JSON.stringify(merged, null, 2);
    const directory = path.dirname(this.configPath);
    await mkdir(directory, { recursive: true });
    const temporary = `${this.configPath}.${process.pid}.${Date.now()}.tmp`;
    const previous = `${this.configPath}.previous`;
    try {
      try { await copyFile(this.configPath, previous); }
      catch (error) { if (error.code !== "ENOENT") throw error; }
      await writeFile(temporary, serialized, { encoding: "utf8", flag: "wx" });
      JSON.parse(await readFile(temporary, "utf8"));
      await rename(temporary, this.configPath);
    } catch (error) {
      await rm(temporary, { force: true }).catch(() => {});
      throw error;
    }
    this.config = merged;
    this.repositories = normalized;
    this.revision = merged.storageRepositoriesRevision;
    this.pendingRestart = true;
    return this.view();
  }
}
