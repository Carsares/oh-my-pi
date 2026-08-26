import { describe, expect, it } from "vitest";
import { HostControlGateway } from "./control-gateway.js";
import { createInMemoryRuntimeAdapter } from "./runtime-gateway.js";

describe("HostControlGateway", () => {
  it("lists OMP plugins via a host_request", async () => {
    const adapter = createInMemoryRuntimeAdapter();
    const control = new HostControlGateway(adapter);
    const response = control.listOmpPlugins("/tmp/project");
    const sent = adapter.takeSent();
    expect(sent).toMatchObject({
      type: "host_request",
      operation: "list_omp_plugins",
      cwd: "/tmp/project",
    });
    adapter.receive({
      type: "host_response",
      requestId: sent.requestId,
      operation: "list_omp_plugins",
      plugins: { npm: [{ name: "example" }], marketplace: [] },
    });
    await expect(response).resolves.toEqual({ npm: [{ name: "example" }], marketplace: [] });
  });

  it("sends OMP plugin install and uninstall requests", async () => {
    const adapter = createInMemoryRuntimeAdapter();
    const control = new HostControlGateway(adapter);
    const install = control.installOmpPlugin("npm:foo", { cwd: "/tmp/project" });
    const installFrame = adapter.takeSent();
    expect(installFrame).toMatchObject({
      type: "host_request",
      operation: "install_omp_plugin",
      pluginSource: "npm:foo",
      cwd: "/tmp/project",
    });
    adapter.receive({ type: "host_response", requestId: installFrame.requestId, ok: true });
    await expect(install).resolves.toBeUndefined();

    const remove = control.uninstallOmpPlugin("foo");
    const removeFrame = adapter.takeSent();
    expect(removeFrame).toMatchObject({
      operation: "uninstall_omp_plugin",
      pluginId: "foo",
      kind: "npm",
      scope: "user",
    });
    adapter.receive({ type: "host_response", requestId: removeFrame.requestId, ok: true });
    await expect(remove).resolves.toBeUndefined();
  });

  it("rejects the request when the host returns an error", async () => {
    const adapter = createInMemoryRuntimeAdapter();
    const control = new HostControlGateway(adapter);
    const response = control.installOmpPlugin("npm:bad");
    const sent = adapter.takeSent();
    adapter.receive({
      type: "host_response",
      requestId: sent.requestId,
      error: { message: "npm is not installed" },
    });
    await expect(response).rejects.toThrow("npm is not installed");
  });

  it("passes marketplace scope on uninstall", async () => {
    const adapter = createInMemoryRuntimeAdapter();
    const control = new HostControlGateway(adapter);
    const remove = control.uninstallOmpPlugin("foo@official", {
      kind: "marketplace",
      scope: "project",
      cwd: "/tmp/project",
    });
    const removeFrame = adapter.takeSent();
    expect(removeFrame).toMatchObject({
      operation: "uninstall_omp_plugin",
      pluginId: "foo@official",
      kind: "marketplace",
      scope: "project",
      cwd: "/tmp/project",
    });
    adapter.receive({ type: "host_response", requestId: removeFrame.requestId, ok: true });
    await expect(remove).resolves.toBeUndefined();
  });

  it("sends plugin identity for an update request", async () => {
    const adapter = createInMemoryRuntimeAdapter();
    const control = new HostControlGateway(adapter);
    const response = control.updateOmpPlugin("foo", { cwd: "/tmp/project" });
    const sent = adapter.takeSent();
    expect(sent).toMatchObject({
      type: "host_request",
      operation: "update_omp_plugin",
      pluginId: "foo",
      kind: "npm",
      scope: "user",
      cwd: "/tmp/project",
    });
    adapter.receive({ type: "host_response", requestId: sent.requestId, ok: true });
    await expect(response).resolves.toBeUndefined();
  });

  it("sends the desired OMP plugin enabled state", async () => {
    const adapter = createInMemoryRuntimeAdapter();
    const control = new HostControlGateway(adapter);
    const response = control.setOmpPluginEnabled("foo@official", false, {
      kind: "marketplace",
      scope: "project",
      cwd: "/tmp",
    });
    const sent = adapter.takeSent();
    expect(sent).toMatchObject({
      type: "host_request",
      operation: "set_omp_plugin_enabled",
      pluginId: "foo@official",
      kind: "marketplace",
      scope: "project",
      enabled: false,
      cwd: "/tmp",
    });
    adapter.receive({
      type: "host_response",
      requestId: sent.requestId,
      operation: "set_omp_plugin_enabled",
      ok: true,
    });
    await expect(response).resolves.toBeUndefined();
  });

  it("sends workspace-neutral configuration requests through the Host", async () => {
    const adapter = createInMemoryRuntimeAdapter();
    const control = new HostControlGateway(adapter);
    const response = control.configManagementRequest({
      operation: "list_model_catalog",
      params: {},
    });
    const sent = adapter.takeSent();
    expect(sent).toMatchObject({
      type: "host_request",
      operation: "config_management_request",
      request: { operation: "list_model_catalog", params: {} },
      cwd: "",
    });
    adapter.receive({
      type: "host_response",
      requestId: sent.requestId,
      operation: "config_management_request",
      data: { ok: true, data: { providers: [] } },
    });
    await expect(response).resolves.toEqual({ ok: true, data: { providers: [] } });
  });

  it("returns the new instance id after a runtime restart", async () => {
    const adapter = createInMemoryRuntimeAdapter();
    const control = new HostControlGateway(adapter);
    const response = control.restartRuntime("ws-1", "s-1");
    const sent = adapter.takeSent();
    expect(sent).toMatchObject({
      type: "host_request",
      operation: "restart_runtime",
      workspaceId: "ws-1",
      sessionId: "s-1",
    });
    adapter.receive({
      type: "host_response",
      requestId: sent.requestId,
      operation: "restart_runtime",
      instanceId: "instance-new",
    });
    await expect(response).resolves.toBe("instance-new");
  });

  it("lists installed external apps", async () => {
    const adapter = createInMemoryRuntimeAdapter();
    const control = new HostControlGateway(adapter);
    const response = control.listInstalledApps();
    const sent = adapter.takeSent();
    expect(sent).toMatchObject({ type: "host_request", operation: "list_installed_apps" });
    adapter.receive({
      type: "host_response",
      requestId: sent.requestId,
      operation: "list_installed_apps",
      apps: [{ id: "vscode", label: "VS Code" }],
    });
    await expect(response).resolves.toEqual([{ id: "vscode", label: "VS Code" }]);
  });

  it("opens a workspace in an external app", async () => {
    const adapter = createInMemoryRuntimeAdapter();
    const control = new HostControlGateway(adapter);
    const response = control.openInApp("/tmp/picot", { appName: "Visual Studio Code" });
    const sent = adapter.takeSent();
    expect(sent).toMatchObject({
      type: "host_request",
      operation: "open_in_app",
      path: "/tmp/picot",
      appName: "Visual Studio Code",
      command: null,
    });
    adapter.receive({ type: "host_response", requestId: sent.requestId, ok: true });
    await expect(response).resolves.toBeUndefined();
  });

  it("deletes sessions by id and normalizes the deleted/errors arrays", async () => {
    const adapter = createInMemoryRuntimeAdapter();
    const control = new HostControlGateway(adapter);
    const response = control.deleteSessions(["s-1", "s-2"]);
    const sent = adapter.takeSent();
    expect(sent).toMatchObject({
      type: "host_request",
      operation: "delete_sessions",
      sessionIds: ["s-1", "s-2"],
    });
    adapter.receive({
      type: "host_response",
      requestId: sent.requestId,
      operation: "delete_sessions",
      deleted: ["s-1"],
      errors: ["s-2"],
    });
    await expect(response).resolves.toEqual({ deleted: ["s-1"], errors: ["s-2"] });
  });

  it("rejects pending requests on disconnect", async () => {
    const adapter = createInMemoryRuntimeAdapter();
    const control = new HostControlGateway(adapter);
    const response = control.openExternal("https://example.com");
    adapter.disconnect();
    await expect(response).rejects.toThrow("disconnected");
  });
});
