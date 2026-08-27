import { beforeEach, describe, expect, it, vi } from "vitest";
import { initI18n, setLocale } from "../i18n.js";
import { MessageRenderer } from "./message-renderer.js";

const enMessages = {
  messages: {
    copyMessage: "Copy message",
    thinking: "Thinking",
    attachedImage: "Attached image",
    copy: "Copy",
    copied: "Copied!",
  },
  app: {
    welcome: "Welcome to Picot",
    welcomeHint: "Type a message...",
    currentWorkspace: "Current workspace:",
  },
  shortcuts: { focusInput: "Focus input", abort: "Abort" },
  usage: {
    messageSummary: "Input {input} · Output {output} · Cache rate {cache}",
    messageInput: "Input {input}",
    messageOutput: "Output {output}",
    messageCache: "Cache rate {cache}",
    inputBreakdownTitle: "This input breakdown",
    inputBreakdownDetails: "View input details",
    systemPromptFiles: "System prompt files",
    toolsProvided: "Tools provided",
    toolsCalled: "Tools called",
    toolsUsed: "Tools used",
    skillsProvided: "Skills provided",
    skillsUsed: "Skills used",
    toolStatus: {
      requested: "Requested",
      started: "Running",
      completed: "Succeeded",
      failed: "Failed",
    },
  },
  context: {
    used: "{pct}% used",
    total: "{used} / {total}",
    systemPrompt: "System prompt",
    systemTools: "System tools",
    systemContext: "System context",
    skills: "Skills",
    messages: "Messages",
  },
};
const zhMessages = {
  messages: {
    copyMessage: "复制消息",
    thinking: "思考中",
    attachedImage: "附件图片",
    copy: "复制",
    copied: "已复制！",
  },
  app: {
    welcome: "欢迎使用 Picot",
    welcomeHint: "输入消息...",
    currentWorkspace: "当前工作区：",
  },
  shortcuts: { focusInput: "聚焦输入", abort: "中止" },
  usage: {
    messageSummary: "输入 {input} · 输出 {output} · 缓存利用率 {cache}",
    messageInput: "输入 {input}",
    messageOutput: "输出 {output}",
    messageCache: "缓存利用率 {cache}",
    inputBreakdownTitle: "本次输入构成",
    inputBreakdownDetails: "查看本次输入详情",
    systemPromptFiles: "系统提示词文件",
    toolsProvided: "传入的工具",
    toolsCalled: "调用的工具",
    toolsUsed: "使用的工具",
    skillsProvided: "传入的技能",
    skillsUsed: "使用的技能",
    toolStatus: {
      requested: "已请求",
      started: "执行中",
      completed: "成功",
      failed: "失败",
    },
  },
};

beforeEach(async () => {
  vi.unstubAllGlobals();
  document.cookie.split(";").forEach((c) => {
    const name = c.split("=")[0].trim();
    if (name) document.cookie = `${name}=; Max-Age=0; Path=/`;
  });
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url) => {
      const u = String(url);
      if (u.includes("/locales/en.json")) {
        return { ok: true, status: 200, json: async () => enMessages };
      }
      if (u.includes("/locales/zh.json")) {
        return { ok: true, status: 200, json: async () => zhMessages };
      }
      return { ok: false, status: 404, json: async () => ({}) };
    }),
  );
  await initI18n();
});

describe("MessageRenderer streaming markdown preview", () => {
  let container;
  let renderer;

  beforeEach(() => {
    container = document.createElement("div");
    renderer = new MessageRenderer(container);
  });

  it("renders markdown live during streaming updates", () => {
    const el = renderer.renderAssistantMessage({ content: "" }, true);
    renderer.updateStreamingMessage(el, "hello **bold te");

    const content = el.querySelector(".message-content");
    expect(content.innerHTML).toContain("<strong>bold te</strong>");
  });

  it("finalizes from the raw text, not the rendered DOM", () => {
    const el = renderer.renderAssistantMessage({ content: "" }, true);
    renderer.updateStreamingMessage(el, "a **bold** word and `code`");
    renderer.finalizeStreamingMessage(el);

    const content = el.querySelector(".message-content");
    expect(content.innerHTML).toContain("<strong>bold</strong>");
    expect(content.innerHTML).toContain("<code>code</code>");
  });

  it("preserves streamed text when message_end carries only tool_use blocks", () => {
    // Regression: task ends with content=[{type:"tool_use"}], which yields
    // text="" from splitStreamingContent. Previously this overwrote
    // _streamingRawText with "" and cleared the contentDiv.
    const el = renderer.renderAssistantMessage({ content: "" }, true);
    renderer.updateStreamingMessage(el, "I will call a tool now.");
    // Simulate message_end passing full content that has no text blocks
    renderer.updateStreamingMessage(el, [{ type: "tool_use", id: "x", name: "bash", input: {} }]);
    renderer.finalizeStreamingMessage(el);

    const content = el.querySelector(".message-content");
    expect(content.textContent.trim()).toBe("I will call a tool now.");
    // Footer exists because there is copyable text
    expect(el.querySelector(".message-copy-btn")).not.toBeNull();
  });

  it("does not add a copy footer to empty finalized streaming messages", () => {
    const el = renderer.renderAssistantMessage({ content: "" }, true);

    renderer.finalizeStreamingMessage(el);

    expect(el.querySelector(".message-footer")).toBeNull();
    expect(el.querySelector(".message-copy-btn")).toBeNull();
  });

  it("renders token usage and cache rate when a streaming response completes", () => {
    const el = renderer.renderAssistantMessage({ content: "" }, true);
    renderer.updateStreamingMessage(el, "Done");

    renderer.finalizeStreamingMessage(el, {
      input: 200,
      output: 120,
      cacheRead: 800,
      cacheWrite: 100,
      cost: { total: 0.0042 },
    });

    expect(el.querySelector("[data-message-usage-summary]").textContent).toBe(
      "Input 1.1k · Output 120 · Cache rate 80.0%",
    );
    expect(el.querySelector(".message-footer").textContent).toContain("$0.0042");
  });

  it("renders usage for restored assistant messages", () => {
    const el = renderer.renderAssistantMessage(
      {
        content: "Restored answer",
        usage: { input: 0, output: 42, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } },
      },
      false,
      true,
    );

    expect(el.querySelector("[data-message-usage-summary]").textContent).toBe(
      "Input 0 · Output 42 · Cache rate --",
    );
  });

  it("opens the saved input breakdown instead of reading current session state", () => {
    const el = renderer.renderAssistantMessage(
      {
        content: "Restored answer",
        usage: { input: 100, output: 20, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } },
        contextSnapshot: {
          contextBreakdown: {
            contextWindow: 1000,
            usedTokens: 640,
            systemPromptTokens: 100,
            systemToolsTokens: 200,
            systemContextTokens: 80,
            skillsTokens: 60,
            messagesTokens: 200,
          },
          usedTools: ["read"],
          usedSkills: ["review"],
        },
      },
      false,
      true,
    );

    el.querySelector("[data-message-usage-input]").click();

    expect(document.querySelector(".message-context-viz").textContent).toContain("System tools");
    expect(document.querySelector(".message-context-viz").textContent).toContain("read");
    expect(document.querySelector(".message-context-viz").textContent).toContain("review");
  });

  it("opens full provenance details and emits file previews", () => {
    const el = renderer.renderAssistantMessage(
      {
        content: "Restored answer",
        usage: { input: 100, output: 20, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } },
        contextSnapshot: {
          contextBreakdown: {
            contextWindow: 1000,
            usedTokens: 640,
            systemPromptTokens: 100,
            systemToolsTokens: 200,
            systemContextTokens: 80,
            skillsTokens: 60,
            messagesTokens: 200,
          },
          systemPromptFiles: [
            { name: "AGENTS.md", path: "/workspace/AGENTS.md", category: "context" },
          ],
          providedTools: ["read", "bash"],
          toolCalls: [{ name: "read", callId: "call-1", status: "completed" }],
          providedSkills: [{ name: "review", path: "/workspace/skills/review/SKILL.md" }],
        },
      },
      false,
      true,
    );

    const previews = [];
    container.addEventListener("previewfile", (event) => previews.push(event.detail.path));
    el.querySelector("[data-message-usage-input]").click();
    renderer._messageContextPopup.popup.querySelector(".message-context-details-btn").click();

    const popup = renderer._messageContextPopup.popup;
    expect(popup.textContent).toContain("System prompt files");
    expect(popup.textContent).toContain("Tools provided");
    expect(popup.textContent).toContain("Succeeded");
    expect(popup.textContent).toContain("Skills provided");
    expect(popup.textContent).not.toContain("/workspace/skills/review/SKILL.md");
    expect(popup.querySelector(".message-context-skill span")).toBeNull();
    popup.querySelector(".message-context-file").click();
    expect(previews).toEqual(["/workspace/AGENTS.md"]);
  });

  it("restores an open context popup after history messages are re-rendered", () => {
    const snapshot = {
      contextBreakdown: {
        contextWindow: 1000,
        usedTokens: 640,
        systemPromptTokens: 100,
        systemToolsTokens: 200,
        systemContextTokens: 80,
        skillsTokens: 60,
        messagesTokens: 200,
      },
      providedSkills: [{ name: "review", path: "/workspace/skills/review/SKILL.md" }],
    };
    const oldElement = renderer.renderAssistantMessage(
      {
        content: "Restored answer",
        usage: { input: 100, output: 20, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } },
        contextSnapshot: snapshot,
      },
      false,
      true,
      null,
      "assistant-1",
    );
    oldElement.querySelector("[data-message-usage-input]").click();
    renderer._messageContextPopup.popup.querySelector(".message-context-details-btn").click();
    const popupState = renderer.captureMessageContextPopupState();

    renderer.clear();
    const newElement = renderer.renderAssistantMessage(
      {
        content: "Restored answer",
        usage: { input: 100, output: 20, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } },
        contextSnapshot: snapshot,
      },
      false,
      true,
      null,
      "assistant-1",
    );

    expect(renderer.restoreMessageContextPopupState(popupState)).toBe(true);
    expect(renderer._messageContextPopup.button).toBe(
      newElement.querySelector("[data-message-usage-input]"),
    );
    expect(renderer._messageContextPopup.details).toBe(true);
    expect(renderer._messageContextPopup.popup.textContent).toContain("Skills provided");
  });

  it("keeps a partial code block previewing as a code block", () => {
    const el = renderer.renderAssistantMessage({ content: "" }, true);
    renderer.updateStreamingMessage(el, "```js\nconst a = 1;");

    const content = el.querySelector(".message-content");
    expect(content.querySelector(".code-block-wrapper")).not.toBeNull();
    expect(content.textContent).toContain("const a = 1;");
  });

  it("preserves the thinking block while streaming text", () => {
    const el = renderer.renderAssistantMessage({ content: "" }, true);
    renderer.updateStreamingThinking(el, "pondering...");
    renderer.updateStreamingMessage(el, "some *italic");

    expect(el.querySelector(".streaming-thinking")).not.toBeNull();
    expect(el.querySelector(".streaming-text").innerHTML).toContain("<em>italic</em>");
  });

  it("does not render raw HTML from streamed text", () => {
    const el = renderer.renderAssistantMessage({ content: "" }, true);
    renderer.updateStreamingMessage(el, "`<script>alert(1)</script>`");

    const content = el.querySelector(".message-content");
    expect(content.querySelector("script")).toBeNull();
  });

  it("copies assistant text without thinking label or content", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });

    const el = renderer.renderAssistantMessage(
      {
        content: [
          { type: "thinking", thinking: "private reasoning" },
          { type: "text", text: "Visible answer" },
        ],
      },
      false,
      true,
    );

    el.querySelector(".message-copy-btn").click();

    expect(writeText).toHaveBeenCalledWith("Visible answer");
  });

  it("removes unsafe HTML attributes and URL schemes from user markdown", () => {
    const el = renderer.renderUserMessage({
      content:
        '<img src="javascript:alert(1)" onerror="alert(2)"><a href="javascript:alert(3)">link</a>',
    });

    expect(el.querySelector("script")).toBeNull();
    expect(el.querySelector("img").getAttribute("src")).toBeNull();
    expect(el.querySelector("img").getAttribute("onerror")).toBeNull();
    expect(el.querySelector("a").getAttribute("href")).toBeNull();
  });

  it("renders a fork action for user messages with an entry id", () => {
    const events = [];
    container.addEventListener("messagefork", (event) => events.push(event.detail));

    renderer.renderUserMessage({ content: "Try this path", entryId: "entry-user-1" }, true);
    container.querySelector(".message-fork-btn").click();

    expect(events).toEqual([{ entryId: "entry-user-1" }]);
  });

  it("highlights keyword matches across rendered messages", () => {
    renderer.renderUserMessage({ content: "Alpha beta gamma" }, true);
    renderer.renderAssistantMessage({ content: "Beta appears twice: beta." }, false, true);

    const count = renderer.highlightSearchQuery("beta");
    const marks = container.querySelectorAll("mark");

    expect(count).toBe(3);
    expect(marks).toHaveLength(3);
    expect(marks[0].textContent.toLowerCase()).toBe("beta");
  });

  it("scrolls the first highlighted match into view", () => {
    renderer.renderAssistantMessage({ content: "jump to keyword" }, false, true);

    let scrolled = false;
    Element.prototype.scrollIntoView = () => {
      scrolled = true;
    };

    const count = renderer.highlightSearchQuery("keyword");

    expect(count).toBe(1);
    expect(scrolled).toBe(true);
  });

  it("can force-scroll after rendering session history", async () => {
    const originalRequestAnimationFrame = globalThis.requestAnimationFrame;
    globalThis.requestAnimationFrame = (callback) => {
      callback();
      return 0;
    };
    Object.defineProperty(container, "scrollHeight", { configurable: true, value: 1200 });

    try {
      renderer.forceScrollToBottom();

      expect(container.scrollTop).toBe(1200);
    } finally {
      globalThis.requestAnimationFrame = originalRequestAnimationFrame;
    }
  });

  it("stops auto-scrolling when the user scrolls up within the old near-bottom threshold", () => {
    const originalRequestAnimationFrame = globalThis.requestAnimationFrame;
    globalThis.requestAnimationFrame = (callback) => {
      callback();
      return 0;
    };
    Object.defineProperties(container, {
      clientHeight: { configurable: true, value: 600 },
      scrollHeight: { configurable: true, value: 650 },
    });
    container.scrollTop = 0;

    try {
      container.dispatchEvent(new Event("scroll"));
      renderer.scrollToBottom();

      expect(container.scrollTop).toBe(0);
    } finally {
      globalThis.requestAnimationFrame = originalRequestAnimationFrame;
    }
  });
});

describe("MessageRenderer errors", () => {
  it("deduplicates keyed session errors while preserving unkeyed errors", () => {
    const container = document.createElement("div");
    const renderer = new MessageRenderer(container);

    renderer.renderError("Session unavailable", { key: "session-load:ws-1:s-1:not-found" });
    renderer.renderError("Session unavailable again", {
      key: "session-load:ws-1:s-1:not-found",
    });
    renderer.renderError("Unkeyed error");
    renderer.renderError("Unkeyed error");

    expect(container.querySelectorAll(".error-message")).toHaveLength(3);
    expect(container.textContent).not.toContain("Session unavailable again");
  });
});

describe("MessageRenderer locale change", () => {
  let container;
  let renderer;

  beforeEach(() => {
    container = document.createElement("div");
    renderer = new MessageRenderer(container);
  });

  it("updates copy button aria-label and title on locale change without re-rendering content", async () => {
    const el = renderer.renderAssistantMessage({ content: "hello **world**" }, false);
    const copyBtn = el.querySelector(".message-copy-btn");
    expect(copyBtn.getAttribute("aria-label")).toBe("Copy message");

    const contentHtmlBefore = el.querySelector(".message-content").innerHTML;

    await setLocale("zh");

    expect(copyBtn.getAttribute("aria-label")).toBe("复制消息");
    expect(copyBtn.title).toBe("复制消息");
    // Content must not be re-rendered on locale change.
    expect(el.querySelector(".message-content").innerHTML).toBe(contentHtmlBefore);
  });

  it("updates completed message usage text when the locale changes", async () => {
    const el = renderer.renderAssistantMessage(
      {
        content: "hello",
        usage: { input: 250, output: 50, cacheRead: 750, cacheWrite: 0, cost: { total: 0 } },
      },
      false,
      true,
    );
    const summary = el.querySelector("[data-message-usage-summary]");
    expect(summary.textContent).toBe("Input 1.0k · Output 50 · Cache rate 75.0%");

    await setLocale("zh");

    expect(summary.textContent).toBe("输入 1.0k · 输出 50 · 缓存利用率 75.0%");
  });

  it("toggles thinking content within its own message element", () => {
    const el = renderer.renderAssistantMessage({
      content: [{ type: "thinking", thinking: "pondering" }],
    });
    const toggle = el.querySelector("[data-thinking-toggle]");
    const content = el.querySelector(".thinking-content");
    expect(toggle.getAttribute("id")).toBeNull();
    toggle.click();
    expect(content.classList.contains("expanded")).toBe(true);
    toggle.click();
    expect(content.classList.contains("expanded")).toBe(false);
  });

  it("updates thinking label text on locale change", async () => {
    const el = renderer.renderAssistantMessage(
      {
        content: [
          { type: "text", text: "answer" },
          { type: "thinking", thinking: "pondering" },
        ],
      },
      false,
    );
    const labelEl = el.querySelector(".thinking-label-text");
    expect(labelEl.textContent).toBe("Thinking");

    await setLocale("zh");

    expect(labelEl.textContent).toBe("思考中");
  });

  it("re-renders welcome on locale change when .welcome exists", async () => {
    renderer.renderWelcome({ workspacePath: "/home/user/project" });
    expect(container.querySelector(".welcome")).not.toBeNull();
    expect(container.textContent).toContain("Welcome to Picot");

    await setLocale("zh");

    expect(container.querySelector(".welcome")).not.toBeNull();
    expect(container.textContent).toContain("欢迎使用 Picot");
  });

  it("does not re-render streaming content on locale change and preserves _streamingRawText", async () => {
    const el = renderer.renderAssistantMessage({ content: "" }, true);
    renderer.updateStreamingMessage(el, "partial **bold** text");
    expect(el._streamingRawText).toBe("partial **bold** text");

    const contentHtmlBefore = el.querySelector(".message-content").innerHTML;

    await setLocale("zh");

    expect(el._streamingRawText).toBe("partial **bold** text");
    expect(el.querySelector(".message-content").innerHTML).toBe(contentHtmlBefore);
  });
});

describe("MessageRenderer teardown", () => {
  it("clear() keeps the renderer live so a locale change still re-renders", async () => {
    const container = document.createElement("div");
    const renderer = new MessageRenderer(container);
    renderer.renderWelcome({});
    renderer.clear();
    renderer.renderWelcome({});
    await setLocale("zh");
    expect(container.querySelector(".welcome p").textContent).toBe("欢迎使用 Picot");
  });

  it("destroy() stops locale re-renders, removes the scroll listener, and is idempotent", async () => {
    const container = document.createElement("div");
    const removeSpy = vi.spyOn(container, "removeEventListener");
    const renderer = new MessageRenderer(container);
    renderer.renderWelcome({});
    const welcomeP = container.querySelector(".welcome p");
    expect(welcomeP.textContent).toBe("Welcome to Picot");

    renderer.destroy();
    expect(() => renderer.destroy()).not.toThrow();
    expect(removeSpy).toHaveBeenCalled();
    // No re-render after destroy: the welcome stays English.
    await setLocale("zh");
    expect(welcomeP.textContent).toBe("Welcome to Picot");
  });
});
