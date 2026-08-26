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
    expect(configManagementRequest).toHaveBeenCalledWith({
      operation: "list_model_catalog",
      params: {},
    });
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
