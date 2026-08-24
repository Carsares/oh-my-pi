import { beforeEach, describe, expect, it, vi } from "vitest";
import { initI18n } from "../i18n.js";
import { captureExpandedProcessGroups, createProcessDetailsGroup } from "./process-group.js";

beforeEach(async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({ ok: true, status: 200, json: async () => ({}) })),
  );
  await initI18n();
  document.body.replaceChildren();
});

describe("process details expansion", () => {
  it("survives a history redraw while an assistant response is streaming", () => {
    const messages = document.createElement("div");
    const first = createProcessDetailsGroup();
    const second = createProcessDetailsGroup();
    messages.append(first.wrapper, second.wrapper);

    second.wrapper.querySelector("button").click();
    const expandedGroups = captureExpandedProcessGroups(messages);

    messages.replaceChildren();
    messages.append(
      createProcessDetailsGroup({ expanded: expandedGroups.has(0) }).wrapper,
      createProcessDetailsGroup({ expanded: expandedGroups.has(1) }).wrapper,
    );

    expect(messages.children[0].classList.contains("expanded")).toBe(false);
    expect(messages.children[1].classList.contains("expanded")).toBe(true);
    expect(messages.children[1].querySelector("button").getAttribute("aria-expanded")).toBe("true");
  });
});
