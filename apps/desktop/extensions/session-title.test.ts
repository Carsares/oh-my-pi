// ABOUTME: Covers transcript shaping and defensive cleanup of model-generated titles.
// ABOUTME: Prevents title UI wrappers and malformed output from reaching session metadata.

import { describe, expect, it, vi } from "vitest";
import { buildTitleTranscript, generateTitleForPrompt } from "./session-title";

const titleGenerator = vi.hoisted(() => ({
  generateSessionTitle: vi.fn(),
}));
vi.mock("@oh-my-pi/pi-coding-agent", () => ({
  SessionManager: { open: vi.fn() },
  settings: {},
}));
vi.mock("@oh-my-pi/pi-coding-agent/utils/title-generator", () => titleGenerator);

describe("session title generation", () => {
  it("builds a transcript from user and assistant text while excluding tool results", () => {
    expect(
      buildTitleTranscript([
        { type: "message", message: { role: "user", content: "Fix the login redirect" } },
        {
          type: "message",
          message: { role: "assistant", content: [{ type: "text", text: "I'll inspect it." }] },
        },
        { type: "message", message: { role: "toolResult", content: "secret output" } },
      ]),
    ).toBe("User: Fix the login redirect\n\nAssistant: I'll inspect it.");
  });

  it("delegates title generation to OMP's native title pipeline", async () => {
    titleGenerator.generateSessionTitle.mockResolvedValue("Native title");
    const modelRegistry = {} as never;
    const model = { provider: "test", id: "model" } as never;

    await expect(
      generateTitleForPrompt("Fix the login redirect", {
        modelRegistry,
        model,
        sessionId: "session-1",
      }),
    ).resolves.toBe("Native title");
    expect(titleGenerator.generateSessionTitle).toHaveBeenCalledWith(
      "Fix the login redirect",
      modelRegistry,
      {},
      "session-1",
      model,
      undefined,
      undefined,
      undefined,
    );
  });
});
