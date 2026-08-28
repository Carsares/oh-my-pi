import { t } from "../i18n.js";

export const CONTEXT_CATEGORIES = [
  { field: "systemPromptTokens", key: "system-prompt", label: "context.systemPrompt" },
  { field: "systemContextTokens", key: "system-context", label: "context.systemContext" },
  { field: "systemToolsTokens", key: "system-tools", label: "context.systemTools" },
  { field: "skillsTokens", key: "skills", label: "context.skills" },
  { field: "messagesTokens", key: "messages", label: "context.messages" },
];

export function setupContextViz({
  tokenUsageEl,
  contextViz,
  contextBar,
  contextLegend,
  contextVizUsed,
  contextVizTotal,
  sessionInputEl,
  sessionOutputEl,
  sessionCacheEl,
  sessionCostEl,
  getContextBreakdown,
  getSessionUsage,
}) {
  if (!tokenUsageEl || !contextViz) {
    return { update: () => false, show: () => false, hide: () => {} };
  }

  let pinned = false;
  let hoveringTrigger = false;
  let hoveringPopover = false;
  let hideTimer = 0;

  function updateContextViz() {
    const breakdown = getContextBreakdown?.();
    const contextWindow = finiteAmount(breakdown?.contextWindow);
    if (!breakdown || contextWindow <= 0) return false;

    const usedTokens = finiteAmount(breakdown.usedTokens);
    const percent = (usedTokens / contextWindow) * 100;
    const categories = CONTEXT_CATEGORIES.map((category) => ({
      ...category,
      label: t(category.label),
      tokens: finiteAmount(breakdown[category.field]),
    }));
    const availableTokens = Math.max(0, contextWindow - usedTokens);

    if (contextVizUsed)
      contextVizUsed.textContent = t("context.used", { pct: formatPercent(percent) });
    if (contextVizTotal) {
      contextVizTotal.textContent = t("context.total", {
        used: formatTokens(usedTokens),
        total: formatTokens(contextWindow),
      });
    }

    if (contextBar) {
      contextBar.replaceChildren();
      for (const category of [...categories, { key: "available", tokens: availableTokens }]) {
        if (category.tokens <= 0) continue;
        const segment = document.createElement("span");
        segment.className = `context-bar-segment context-color-${category.key}`;
        segment.style.width = `${Math.min(100, (category.tokens / contextWindow) * 100)}%`;
        segment.setAttribute("aria-hidden", "true");
        contextBar.appendChild(segment);
      }
      contextBar.setAttribute("aria-valuenow", String(Math.min(100, Math.round(percent))));
      contextBar.setAttribute("aria-valuetext", t("context.used", { pct: formatPercent(percent) }));
    }

    if (contextLegend) {
      contextLegend.replaceChildren();
      for (const category of categories) {
        const item = document.createElement("div");
        item.className = "context-legend-item";

        const label = document.createElement("span");
        label.className = "context-legend-label";
        const dot = document.createElement("span");
        dot.className = `context-legend-dot context-color-${category.key}`;
        dot.setAttribute("aria-hidden", "true");
        label.append(dot, category.label);

        const value = document.createElement("span");
        value.className = "context-legend-value";
        value.textContent = t("context.categoryValue", {
          tokens: formatTokens(category.tokens),
          pct: formatPercent(usedTokens > 0 ? (category.tokens / usedTokens) * 100 : 0),
        });
        item.append(label, value);
        contextLegend.appendChild(item);
      }
    }

    const sessionUsage = getSessionUsage?.() ?? {};
    const input = finiteAmount(sessionUsage.input);
    const cacheRead = finiteAmount(sessionUsage.cacheRead);
    const cacheWrite = finiteAmount(sessionUsage.cacheWrite);
    const totalInput = input + cacheRead + cacheWrite;
    if (sessionInputEl) sessionInputEl.textContent = formatTokens(totalInput);
    if (sessionOutputEl) sessionOutputEl.textContent = formatTokens(sessionUsage.output);
    if (sessionCacheEl) {
      sessionCacheEl.textContent =
        totalInput > 0 ? `${formatPercent((cacheRead / totalInput) * 100)}%` : "--";
    }
    if (sessionCostEl) sessionCostEl.textContent = `$${finiteAmount(sessionUsage.cost).toFixed(4)}`;
    return true;
  }

  if (contextViz.parentElement && contextViz.parentElement !== document.body) {
    document.body.appendChild(contextViz);
  }

  function positionPopover() {
    const rect = tokenUsageEl.getBoundingClientRect();
    // Fixed portal geometry keeps the upward popover aligned with the toolbar trigger.
    const gap = 8;
    contextViz.style.position = "fixed";
    contextViz.style.top = "auto";
    contextViz.style.bottom = `${Math.max(gap, window.innerHeight - rect.top + gap)}px`;
    contextViz.style.right = `${Math.max(gap, window.innerWidth - rect.right)}px`;
    contextViz.style.left = "auto";
  }

  function show() {
    if (!updateContextViz()) return false;
    contextViz.classList.remove("hidden");
    tokenUsageEl.setAttribute("aria-expanded", "true");
    positionPopover();
    return true;
  }

  function hide({ force = false } = {}) {
    if (pinned && !force) return;
    if (force) pinned = false;
    contextViz.classList.add("hidden");
    tokenUsageEl.setAttribute("aria-expanded", "false");
  }

  function hideLater() {
    window.clearTimeout(hideTimer);
    hideTimer = window.setTimeout(() => {
      const focused =
        document.activeElement === tokenUsageEl || contextViz.contains(document.activeElement);
      if (!hoveringTrigger && !hoveringPopover && !focused) hide();
    }, 80);
  }

  tokenUsageEl.addEventListener("mouseenter", () => {
    hoveringTrigger = true;
    window.clearTimeout(hideTimer);
    show();
  });
  tokenUsageEl.addEventListener("mouseleave", () => {
    hoveringTrigger = false;
    hideLater();
  });
  contextViz.addEventListener("mouseenter", () => {
    hoveringPopover = true;
    window.clearTimeout(hideTimer);
  });
  contextViz.addEventListener("mouseleave", () => {
    hoveringPopover = false;
    hideLater();
  });
  tokenUsageEl.addEventListener("focus", show);
  tokenUsageEl.addEventListener("blur", hideLater);
  contextViz.addEventListener("focusout", hideLater);

  tokenUsageEl.addEventListener("click", (event) => {
    event.stopPropagation();
    if (contextViz.classList.contains("hidden")) {
      pinned = show();
    } else if (pinned) {
      hide({ force: true });
    } else {
      pinned = true;
    }
  });

  document.addEventListener("click", (event) => {
    if (!contextViz.contains(event.target) && event.target !== tokenUsageEl) hide({ force: true });
  });
  document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape" || contextViz.classList.contains("hidden")) return;
    hide({ force: true });
    tokenUsageEl.focus();
  });
  window.addEventListener("resize", () => {
    if (!contextViz.classList.contains("hidden")) positionPopover();
  });

  return { update: updateContextViz, show, hide };
}

export function formatTokens(value) {
  const tokens = finiteAmount(value);
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`;
  if (tokens >= 1_000) return `${(tokens / 1_000).toFixed(1)}k`;
  return String(tokens);
}

function formatPercent(value) {
  const percent = Number(value);
  return Number.isFinite(percent) ? Math.max(0, percent).toFixed(1) : "0.0";
}

function finiteAmount(value) {
  const amount = Number(value);
  return Number.isFinite(amount) && amount > 0 ? amount : 0;
}
