// Host control gateway: sends `host_request` frames over the native /v2/ws
// protocol and resolves the matching `host_response`. This is the write-capable
// counterpart to the read-only HostDataGateway — it covers plugin management
// and opening external links, which run the embedded OMP CLI on the Rust host.
//
// Requests are correlated by a `host-` prefixed requestId; frames that don't
// match a pending request are ignored (other gateways share the same adapter).
export class HostControlGateway {
  #adapter;
  #generation = 0;
  #nextRequestId = 1;
  #pending = new Map();

  constructor(adapter) {
    this.#adapter = adapter;
    adapter.setReceiver((frame) => this.#receive(frame));
    adapter.setConnectionListener?.((connected) => {
      if (!connected) this.#disconnect();
    });
  }

  #request(operation, parameters = {}) {
    const requestId = `host-${this.#nextRequestId++}`;
    const generation = this.#generation;
    return new Promise((resolve, reject) => {
      this.#pending.set(requestId, { resolve, reject, generation });
      try {
        this.#adapter.send({
          type: "host_request",
          requestId,
          operation,
          ...parameters,
        });
      } catch (error) {
        this.#pending.delete(requestId);
        reject(error);
      }
    });
  }

  async listOmpPlugins(cwd = "") {
    const frame = await this.#request("list_omp_plugins", { cwd });
    const plugins = frame?.plugins;
    return {
      npm: Array.isArray(plugins?.npm) ? plugins.npm : [],
      marketplace: Array.isArray(plugins?.marketplace) ? plugins.marketplace : [],
    };
  }

  async installOmpPlugin(pluginSource, { cwd = "" } = {}) {
    await this.#request("install_omp_plugin", { pluginSource, cwd });
  }

  async uninstallOmpPlugin(pluginId, { kind = "npm", scope = "user", cwd = "" } = {}) {
    await this.#request("uninstall_omp_plugin", { pluginId, kind, scope, cwd });
  }

  async updateOmpPlugin(pluginId, { kind = "npm", scope = "user", cwd = "" } = {}) {
    await this.#request("update_omp_plugin", { pluginId, kind, scope, cwd });
  }

  async setOmpPluginEnabled(pluginId, enabled, { kind = "npm", scope = "user", cwd = "" } = {}) {
    await this.#request("set_omp_plugin_enabled", { pluginId, kind, scope, enabled, cwd });
  }

  async skillManagementRequest(request, { cwd = "" } = {}) {
    const frame = await this.#request("skill_management_request", { request, cwd });
    return frame?.data ?? frame;
  }

  async configManagementRequest(request, { cwd = "" } = {}) {
    const frame = await this.#request("config_management_request", { request, cwd });
    return frame?.data ?? frame;
  }

  async restartRuntime(workspaceId, sessionId) {
    const frame = await this.#request("restart_runtime", { workspaceId, sessionId });
    return frame?.instanceId ?? null;
  }

  async listInstalledApps() {
    const frame = await this.#request("list_installed_apps");
    return Array.isArray(frame?.apps) ? frame.apps : [];
  }

  async openInApp(path, { appName = null, command = null } = {}) {
    await this.#request("open_in_app", { path, appName, command });
  }

  async openExternal(url) {
    await this.#request("open_external", { url });
  }

  // Permanently deletes saved sessions (by id) from disk. Best effort: the
  // response's `errors` lists ids that could not be removed; callers should
  // only drop successfully-deleted ids from local state.
  async deleteSessions(sessionIds) {
    const frame = await this.#request("delete_sessions", { sessionIds });
    return {
      deleted: Array.isArray(frame?.deleted) ? frame.deleted : [],
      errors: Array.isArray(frame?.errors) ? frame.errors : [],
    };
  }

  // Skills install flow: pick a local source directory, scan it for skill
  // candidates, then add selected roots to OMP's config.yml.
  async pickSkillSource(workspaceId) {
    return this.#request("pick_skill_source", { workspaceId });
  }

  async scanSkillInstallSource(sourceId, workspaceId) {
    return this.#request("skill_scan_install_source", { sourceId, workspaceId });
  }

  async installSkillLinks(request) {
    return this.#request("skill_install_links", request);
  }

  #receive(frame) {
    const pending = this.#pending.get(frame?.requestId);
    if (!pending || pending.generation !== this.#generation) return;
    this.#pending.delete(frame.requestId);
    if (frame.error) pending.reject(new Error(frame.error.message ?? String(frame.error)));
    else pending.resolve(frame);
  }

  #disconnect() {
    this.#generation += 1;
    for (const pending of this.#pending.values()) {
      pending.reject(new Error("Host disconnected before the control request completed"));
    }
    this.#pending.clear();
  }
}
