import { describe, expect, it, vi } from "vitest";
import { HostConfigGateway } from "./host-config-gateway.js";

describe("HostConfigGateway", () => {
  it("preserves the ConfigGateway response contract for root-page requests", async () => {
    const configManagementRequest = vi.fn().mockResolvedValue({
      ok: true,
      data: { providers: [{ provider: "openai" }] },
    });
    const gateway = new HostConfigGateway({ configManagementRequest });

    await expect(gateway.call("list_model_catalog")).resolves.toEqual({
      ok: true,
      data: { providers: [{ provider: "openai" }] },
    });
    expect(configManagementRequest).toHaveBeenCalledWith(
      {
        operation: "list_model_catalog",
        params: {},
      },
      {},
    );
  });

  it("forwards request options to the Host control gateway", async () => {
    const configManagementRequest = vi.fn().mockResolvedValue({ ok: true, data: { results: [] } });
    const gateway = new HostConfigGateway({ configManagementRequest });

    await gateway.call(
      "check_model_health",
      { provider: "anthropic", modelId: "claude-sonnet-5" },
      { timeoutMs: 120_000 },
    );

    expect(configManagementRequest).toHaveBeenCalledWith(
      {
        operation: "check_model_health",
        params: { provider: "anthropic", modelId: "claude-sonnet-5" },
      },
      { timeoutMs: 120_000 },
    );
  });

  it("routes external URLs to the Host-owned opener", async () => {
    const openExternal = vi.fn().mockResolvedValue(undefined);
    const gateway = new HostConfigGateway({ openExternal });

    await expect(
      gateway.call("open_external", { url: "https://example.com/models" }),
    ).resolves.toEqual({ ok: true });
    expect(openExternal).toHaveBeenCalledWith("https://example.com/models");
  });
});
