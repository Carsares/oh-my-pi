import { describe, expect, it } from "vitest";
import { canAdjustModelThinking } from "./thinking-control.js";

describe("canAdjustModelThinking", () => {
  it("enables adjustment only when a reasoning model declares effort levels", () => {
    expect(
      canAdjustModelThinking({
        reasoning: true,
        thinking: { mode: "effort", efforts: ["low", "high", "max"] },
      }),
    ).toBe(true);
    expect(canAdjustModelThinking({ reasoning: false })).toBe(false);
    expect(canAdjustModelThinking({ reasoning: true })).toBe(false);
    expect(canAdjustModelThinking({ reasoning: true, thinking: { efforts: [] } })).toBe(false);
  });
});
