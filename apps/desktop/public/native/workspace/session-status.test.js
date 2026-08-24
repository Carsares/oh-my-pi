import { describe, expect, it } from "vitest";
import { createSessionStatus } from "./session-status.js";

function t(key) {
  return key;
}

function bindUi(status, extras = {}) {
  const statusText = document.createElement("span");
  const statusIndicator = document.createElement("span");
  const composerCard = document.createElement("div");
  const abortButton = document.createElement("button");
  const sendButton = document.createElement("button");
  abortButton.classList.add("hidden");
  status.bind({
    statusText,
    statusIndicator,
    composerCard,
    abortButton,
    sendButton,
    hasPending: () => false,
    getSessionId: () => "session-a",
    ...extras,
  });
  return { abortButton, composerCard, sendButton, statusIndicator, statusText };
}

describe("createSessionStatus", () => {
  it("accepts status updates before bind without throwing", () => {
    const status = createSessionStatus({ t });
    expect(() => status.setStatus("working")).not.toThrow();
    expect(() => status.applyHostStatus("Working…")).not.toThrow();
    expect(() => status.renderStatus()).not.toThrow();
    expect(status.getKind()).toBe("working");

    const { abortButton, sendButton, statusText } = bindUi(status);
    expect(statusText.textContent).toBe("status.working");
    expect(abortButton.classList.contains("hidden")).toBe(false);
    expect(sendButton.classList.contains("hidden")).toBe(true);
  });

  it("maps host English status strings to kinds, not translated labels", () => {
    const status = createSessionStatus({ t });
    const { statusIndicator, statusText } = bindUi(status);

    status.applyHostStatus("Working...");
    expect(status.getKind()).toBe("working");
    expect(statusText.textContent).toBe("status.working");
    expect(statusIndicator.classList.contains("streaming")).toBe(true);

    status.applyHostStatus("Disconnected");
    expect(status.getKind()).toBe("disconnected");
    expect(statusText.textContent).toBe("status.disconnected");
    expect(statusIndicator.classList.contains("disconnected")).toBe(true);

    status.applyHostStatus("Connected");
    expect(status.getKind()).toBe("connected");
    expect(statusText.textContent).toBe("status.connected");

    status.applyHostStatus("Compacting context");
    expect(status.getKind()).toBe("custom");
    expect(statusText.textContent).toBe("Compacting context");
  });

  it("shows abort when an extension prompt is pending even if not working", () => {
    const status = createSessionStatus({ t });
    const { abortButton, sendButton } = bindUi(status, { hasPending: () => true });
    status.setStatus("connected");
    expect(abortButton.classList.contains("hidden")).toBe(false);
    expect(sendButton.classList.contains("hidden")).toBe(true);
  });
});
