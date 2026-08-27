import { t } from "../../i18n.js";
import { setupContextViz } from "../../ui/context-viz.js";

// Mirrors OMP's DEFAULT_COMPACTION_SETTINGS.keepRecentTokens. Below this
// boundary prepareCompaction() has no older context to summarize.
export const MIN_COMPACTABLE_CONTEXT_TOKENS = 20_000;

const CONTEXT_FIELDS = [
  "systemPromptTokens",
  "systemToolsTokens",
  "systemContextTokens",
  "skillsTokens",
  "messagesTokens",
];

export function setupContextUsage({
  tokenUsageEl = document.getElementById("token-usage"),
  contextViz = document.getElementById("context-viz"),
  contextBar = document.getElementById("context-bar"),
  contextLegend = document.getElementById("context-legend"),
  contextVizUsed = document.getElementById("context-viz-used"),
  contextVizTotal = document.getElementById("context-viz-total"),
  sessionInputEl = document.getElementById("context-session-input"),
  sessionOutputEl = document.getElementById("context-session-output"),
  sessionCacheEl = document.getElementById("context-session-cache"),
  sessionCostEl = document.getElementById("context-session-cost"),
  compactButton = document.getElementById("compact-context-btn"),
} = {}) {
  let breakdown = null;
  let contextWindowSize = 0;
  let sessionUsage = emptySessionUsage();
  let compacting = false;
  let working = false;

  function effectiveBreakdown() {
    if (!breakdown) return null;
    return {
      ...breakdown,
      contextWindow: contextWindowSize || breakdown.contextWindow,
    };
  }

  const viz = setupContextViz({
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
    getContextBreakdown: effectiveBreakdown,
    getSessionUsage: () => sessionUsage,
  });

  function setContextBreakdown(nextBreakdown) {
    breakdown = normalizeBreakdown(nextBreakdown);
    contextWindowSize = Number(breakdown?.contextWindow) || 0;
    renderTrigger();
    updateOpenPopover();
  }

  function setContextWindowSize(nextContextWindowSize) {
    contextWindowSize = finiteAmount(nextContextWindowSize);
    renderTrigger();
    updateOpenPopover();
  }

  function setSessionUsage(nextUsage) {
    sessionUsage = normalizeSessionUsage(nextUsage);
    updateOpenPopover();
  }

  function clear() {
    breakdown = null;
    contextWindowSize = 0;
    sessionUsage = emptySessionUsage();
    tokenUsageEl?.classList.remove("visible", "warning", "critical");
    if (tokenUsageEl) {
      tokenUsageEl.title = t("usage.contextTitle");
      tokenUsageEl.setAttribute("aria-label", t("usage.contextTitle"));
      tokenUsageEl
        .querySelector(".context-usage-ring")
        ?.style.setProperty("--context-percent", "0");
    }
    viz.hide({ force: true });
    renderCompactButton();
  }

  function renderCompactButton() {
    if (!compactButton) return;
    compactButton.hidden = usedTokens() <= MIN_COMPACTABLE_CONTEXT_TOKENS;
    compactButton.classList.toggle("compacting", compacting);
    compactButton.disabled = compacting || working;
    compactButton.setAttribute("aria-busy", String(compacting));
    const label = compactButton.querySelector(".compact-btn-label");
    if (label) label.textContent = t(compacting ? "input.compacting" : "input.compact");
    const description = t(compacting ? "input.compacting" : "input.compactDesc");
    compactButton.title = description;
    compactButton.setAttribute("aria-label", description);
  }

  function renderTrigger() {
    renderCompactButton();
    if (!tokenUsageEl) return;
    tokenUsageEl.classList.remove("warning", "critical");
    const currentBreakdown = effectiveBreakdown();
    if (!currentBreakdown || currentBreakdown.contextWindow <= 0) {
      tokenUsageEl.classList.remove("visible");
      viz.hide({ force: true });
      return;
    }

    const percent = (currentBreakdown.usedTokens / currentBreakdown.contextWindow) * 100;
    if (percent >= 80) tokenUsageEl.classList.add("critical");
    else if (percent >= 60) tokenUsageEl.classList.add("warning");
    tokenUsageEl.classList.add("visible");
    tokenUsageEl
      .querySelector(".context-usage-ring")
      ?.style.setProperty("--context-percent", String(Math.min(100, Math.max(0, percent))));
    const description = t("context.triggerLabel", { pct: Math.max(0, percent).toFixed(1) });
    tokenUsageEl.title = description;
    tokenUsageEl.setAttribute("aria-label", description);
  }

  function updateOpenPopover() {
    if (!contextViz?.classList.contains("hidden")) viz.update();
  }

  function usedTokens() {
    return finiteAmount(breakdown?.usedTokens);
  }

  return {
    clear,
    get canCompact() {
      return usedTokens() > MIN_COMPACTABLE_CONTEXT_TOKENS;
    },
    setCompacting(value) {
      compacting = Boolean(value);
      renderCompactButton();
    },
    setWorking(value) {
      working = Boolean(value);
      renderCompactButton();
    },
    setContextBreakdown,
    setContextWindowSize,
    setSessionUsage,
    get breakdown() {
      return breakdown;
    },
    get sessionUsage() {
      return sessionUsage;
    },
  };
}

function normalizeBreakdown(value) {
  if (!value || typeof value !== "object") return null;
  const result = {
    contextWindow: finiteAmount(value.contextWindow),
    usedTokens: finiteAmount(value.usedTokens),
  };
  for (const field of CONTEXT_FIELDS) result[field] = finiteAmount(value[field]);
  return result;
}

function normalizeSessionUsage(value) {
  return {
    input: finiteAmount(value?.input),
    output: finiteAmount(value?.output),
    cacheRead: finiteAmount(value?.cacheRead),
    cacheWrite: finiteAmount(value?.cacheWrite),
    cost: finiteAmount(value?.cost),
  };
}

function emptySessionUsage() {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
}

function finiteAmount(value) {
  const amount = Number(value);
  return Number.isFinite(amount) && amount > 0 ? amount : 0;
}
