// ABOUTME: Owns the session-aggregate cost row in the header and publishes
// ABOUTME: token totals for the combined context pill. Completely separate from
// ABOUTME: the current-context (lastUsage) lifecycle so a successful Compact can
// ABOUTME: invalidate stale context without fabricating usage.

function formatCost(amount) {
  return Number.isFinite(amount) ? amount.toFixed(4) : "0.0000";
}

function finiteAmount(value) {
  const amount = Number(value);
  return Number.isFinite(amount) && amount > 0 ? amount : 0;
}

function sum(prev, next) {
  return finiteAmount(prev) + finiteAmount(next);
}

/**
 * Build a header status bar that renders session-aggregate cost
 * (sourced only from `hydrateSessionStats` and post-hydration `applyLiveUsage`)
 * and notifies the caller of token totals for the combined usage pill.
 *
 * Aggregate totals are intentionally not derived from `lastUsage`/history
 * replay: repeated mirror syncs and history rendering must never increment
 * them. Only the authoritative `get_session_stats` hydration and new live
 * assistant completions for the same active session contribute.
 *
 * @param {{sessionCostEl:HTMLElement, t:(k,p?)=>string, onTotalsChange?:(totals:{input:number,output:number,cacheRead:number,cacheWrite:number,cost:number})=>void}} deps
 * @returns {{applyLiveUsage, hydrateSessionStats, reset}}
 */
export function createHeaderStatusBar({ sessionCostEl, t, onTotalsChange } = {}) {
  const totals = {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    cost: 0,
  };
  let hydratedSessionFile = null;
  let hasHydrated = false;

  function renderAggregate() {
    if (totals.cost > 0) {
      sessionCostEl.textContent = t("usage.costSub", { amount: `$${formatCost(totals.cost)}` });
      sessionCostEl.classList.add("visible");
    } else {
      sessionCostEl.replaceChildren();
      sessionCostEl.classList.remove("visible");
    }
    onTotalsChange?.({ ...totals });
  }

  function reset() {
    totals.input = 0;
    totals.output = 0;
    totals.cacheRead = 0;
    totals.cacheWrite = 0;
    totals.cost = 0;
    hydratedSessionFile = null;
    hasHydrated = false;
    renderAggregate();
  }

  function hydrateSessionStats({ sessionFile, tokens, cost } = {}) {
    // The authoritative aggregate. Re-hydrating the same session replaces
    // (never accumulates) so repeated mirror syncs cannot double-count.
    // A missing identity is not safe to apply because it could belong to a
    // previous session after an in-place switch.
    if (!sessionFile) return false;
    if (hydratedSessionFile && sessionFile !== hydratedSessionFile) return false;
    hydratedSessionFile = sessionFile;
    hasHydrated = true;
    // `tokens: null` is the authoritative zero state for a session with no
    // assistant usage yet; it must not leave stale totals on screen.
    totals.input = Number.isFinite(tokens?.input) ? Math.max(0, tokens.input) : 0;
    totals.output = Number.isFinite(tokens?.output) ? Math.max(0, tokens.output) : 0;
    totals.cacheRead = Number.isFinite(tokens?.cacheRead) ? Math.max(0, tokens.cacheRead) : 0;
    totals.cacheWrite = Number.isFinite(tokens?.cacheWrite) ? Math.max(0, tokens.cacheWrite) : 0;
    totals.cost = Number.isFinite(cost?.total) ? Math.max(0, cost.total) : 0;
    renderAggregate();
    return true;
  }

  function applyLiveUsage(
    { input, output, cacheRead, cacheWrite, cost } = {},
    { sessionFile } = {},
  ) {
    // Live usage is accepted only after the active session identity has been
    // authoritatively hydrated. Unknown identities and the reset-to-hydration
    // race are deliberately dropped; the caller requests a fresh hydration
    // instead of risking cross-session or replay double-counting.
    if (!sessionFile || !hasHydrated || sessionFile !== hydratedSessionFile) return false;
    totals.input = sum(totals.input, finiteAmount(input));
    totals.output = sum(totals.output, finiteAmount(output));
    totals.cacheRead = sum(totals.cacheRead, finiteAmount(cacheRead));
    totals.cacheWrite = sum(totals.cacheWrite, finiteAmount(cacheWrite));
    totals.cost = sum(totals.cost, finiteAmount(cost?.total));
    renderAggregate();
    return true;
  }

  return { applyLiveUsage, hydrateSessionStats, reset };
}
