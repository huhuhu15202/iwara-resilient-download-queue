export class Aria2Client {
  constructor({ url, secret = "", fetchImpl = fetch }) {
    this.url = url;
    this.secret = secret;
    this.fetchImpl = fetchImpl;
    this.sequence = 0;
  }

  async call(method, params = []) {
    const rpcParams = this.secret ? [`token:${this.secret}`, ...params] : params;
    const response = await this.fetchImpl(this.url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: String(++this.sequence),
        method: `aria2.${method}`,
        params: rpcParams
      })
    });
    if (!response.ok) {
      throw new Error(`aria2 RPC HTTP ${response.status}`);
    }
    const payload = await response.json();
    if (payload.error) {
      throw new Error(payload.error.message || JSON.stringify(payload.error));
    }
    return payload.result;
  }

  getVersion() {
    return this.call("getVersion");
  }

  changeGlobalOption(options) {
    return this.call("changeGlobalOption", [options]);
  }

  addUri(url, options) {
    return this.call("addUri", [[url], options]);
  }

  tellStatus(gid) {
    return this.call("tellStatus", [gid, [
      "gid", "status", "totalLength", "completedLength",
      "downloadSpeed", "errorCode", "errorMessage", "files"
    ]]);
  }

  async listStatuses() {
    const fields = ["gid", "status", "errorCode", "errorMessage"];
    const [active, waiting, stopped] = await Promise.all([
      this.call("tellActive", [fields]),
      this.call("tellWaiting", [0, 10000, fields]),
      this.call("tellStopped", [0, 10000, fields])
    ]);
    return [...active, ...waiting, ...stopped];
  }

  async forget(gid) {
    try {
      await this.call("forceRemove", [gid]);
    } catch {
      // Stopped tasks cannot be force-removed.
    }
    try {
      await this.call("removeDownloadResult", [gid]);
    } catch {
      // A result may already have been removed.
    }
  }
}
