import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { initI18n } from "../../i18n.js";
import { setupContextUsage } from "./context-usage.js";

const enMessages = JSON.parse(readFileSync(join(process.cwd(), "public/locales/en.json"), "utf8"));

function renderFixture() {
  document.body.innerHTML = `
    <span class="context-usage-anchor">
      <button class="context-usage-button" id="token-usage" aria-expanded="false">
        <span class="context-usage-ring"></span>
      </button>
      <div class="context-viz hidden" id="context-viz">
        <strong id="context-viz-used"></strong>
        <span id="context-viz-total"></span>
        <div class="context-bar" id="context-bar"></div>
        <div class="context-legend" id="context-legend"></div>
        <span id="context-session-input"></span>
        <span id="context-session-output"></span>
        <span id="context-session-cache"></span>
        <span id="context-session-cost"></span>
        <button id="compact-context-btn"><span class="compact-btn-label"></span></button>
      </div>
    </span>
  `;
}

function setPopulatedStats(control) {
  control.setContextBreakdown({
    usedTokens: 40_000,
    contextWindow: 160_000,
    systemPromptTokens: 2_000,
    systemToolsTokens: 8_000,
    systemContextTokens: 4_000,
    skillsTokens: 6_000,
    messagesTokens: 20_000,
  });
  control.setSessionUsage({
    input: 100,
    output: 42,
    cacheRead: 300,
    cacheWrite: 100,
    cost: 0.01234,
  });
}

describe("context usage control", () => {
  beforeEach(async () => {
    renderFixture();
    globalThis.fetch = vi.fn(async (input) => {
      if (String(input).includes("/locales/en.json")) {
        return new Response(JSON.stringify(enMessages));
      }
      return new Response(JSON.stringify({}), { status: 404 });
    });
    await initI18n();
  });

  afterEach(() => {
    vi.useRealTimers();
    document.body.replaceChildren();
    vi.restoreAllMocks();
  });

  it("renders a ring and the authoritative context and session breakdown", () => {
    const control = setupContextUsage();
    setPopulatedStats(control);

    const trigger = document.getElementById("token-usage");
    expect(trigger.classList.contains("visible")).toBe(true);
    expect(trigger.textContent.trim()).toBe("");
    expect(trigger.getAttribute("aria-label")).toBe("Context usage: 25.0%");
    expect(
      trigger.querySelector(".context-usage-ring").style.getPropertyValue("--context-percent"),
    ).toBe("25");

    trigger.click();

    expect(document.getElementById("context-viz").classList.contains("hidden")).toBe(false);
    expect(document.getElementById("context-viz-used").textContent).toBe("25.0% used");
    expect(document.getElementById("context-viz-total").textContent).toBe("40.0k / 160.0k");
    const rows = [...document.querySelectorAll(".context-legend-item")].map(
      (item) => item.textContent,
    );
    expect(rows).toEqual([
      "System prompt2.0k · 5.0%",
      "System tools8.0k · 20.0%",
      "System context4.0k · 10.0%",
      "Skills6.0k · 15.0%",
      "Messages20.0k · 50.0%",
    ]);
    expect(document.getElementById("context-session-input").textContent).toBe("500");
    expect(document.getElementById("context-session-output").textContent).toBe("42");
    expect(document.getElementById("context-session-cache").textContent).toBe("60.0%");
    expect(document.getElementById("context-session-cost").textContent).toBe("$0.0123");
  });

  it("opens upward on hover and remains open while the pointer enters the popover", () => {
    vi.useFakeTimers();
    const control = setupContextUsage();
    setPopulatedStats(control);
    const trigger = document.getElementById("token-usage");
    const popover = document.getElementById("context-viz");
    vi.spyOn(trigger, "getBoundingClientRect").mockReturnValue({
      top: 700,
      right: 900,
      bottom: 728,
      left: 872,
      width: 28,
      height: 28,
      x: 872,
      y: 700,
      toJSON: () => ({}),
    });

    trigger.dispatchEvent(new MouseEvent("mouseenter"));
    expect(popover.classList.contains("hidden")).toBe(false);
    expect(popover.style.top).toBe("auto");
    expect(popover.style.bottom).not.toBe("");

    trigger.dispatchEvent(new MouseEvent("mouseleave"));
    popover.dispatchEvent(new MouseEvent("mouseenter"));
    vi.advanceTimersByTime(100);
    expect(popover.classList.contains("hidden")).toBe(false);

    popover.dispatchEvent(new MouseEvent("mouseleave"));
    vi.advanceTimersByTime(100);
    expect(popover.classList.contains("hidden")).toBe(true);
  });

  it("preserves click-to-toggle behavior", () => {
    const control = setupContextUsage();
    setPopulatedStats(control);
    const trigger = document.getElementById("token-usage");
    const popover = document.getElementById("context-viz");

    trigger.click();
    expect(popover.classList.contains("hidden")).toBe(false);
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    trigger.click();
    expect(popover.classList.contains("hidden")).toBe(true);
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
  });

  it("only enables Compact when the current provider context is large enough", () => {
    const control = setupContextUsage();
    const button = document.getElementById("compact-context-btn");

    control.setContextBreakdown({ usedTokens: 17_402, contextWindow: 1_000_000 });
    expect(button.hidden).toBe(true);

    control.setContextBreakdown({ usedTokens: 25_000, contextWindow: 128_000 });
    expect(button.hidden).toBe(false);
    expect(button.disabled).toBe(false);

    control.setWorking(true);
    expect(button.disabled).toBe(true);
    control.setWorking(false);
    control.setCompacting(true);
    expect(button.disabled).toBe(true);
    expect(button.classList.contains("compacting")).toBe(true);
    expect(button.getAttribute("aria-busy")).toBe("true");
  });
});
