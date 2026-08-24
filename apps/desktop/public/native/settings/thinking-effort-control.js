// Wires the thinking-effort radio group in the settings General tab. Persists
// the default thinking level to Pi settings and also applies it to the current
// session so the visible composer stays in sync.

import { onLocaleChange, t } from "../../i18n.js";
import { randomId } from "../utils/random-id.js";

function formatThinkingLevelLabel(level) {
  const key = `settings.thinkingLevels.${level}`;
  const label = t(key);
  return label === key ? level : label;
}

function runtimeResponseData(response) {
  return response?.response?.data ?? response?.data ?? response;
}

export function setupThinkingEffortControl({
  runtime,
  getTarget,
  configGateway,
  onError,
  onRuntimeLevelChanged,
}) {
  const radioGroup = document.getElementById("thinking-effort");
  const levelName = document.getElementById("thinking-effort-name");
  const thumb = document.getElementById("thinking-effort-marker");
  if (!radioGroup) return;

  const buttons = Array.from(radioGroup.querySelectorAll(".thinking-effort-dot"));
  const levels = buttons.map((btn) => btn.dataset.level).filter(Boolean);
  let hasUserChangedLevel = false;

  function updateUI(level) {
    const index = levels.indexOf(level);
    if (index === -1) return;

    // Update checked and active state.
    for (let i = 0; i < buttons.length; i++) {
      const isActive = i === index;
      buttons[i].checked = isActive;
      buttons[i].classList.toggle("active", isActive);
    }

    // Update level name display
    if (levelName) {
      levelName.dataset.thinkingLevel = level;
      levelName.textContent = formatThinkingLevelLabel(level);
    }

    // Move thumb to the selected position. The thumb has real width (it's a
    // pill, not a point), so anchor it to the button's left edge, centered
    // within the button's own width — not the button's center point, which
    // would push the pill half its width to the right of the target dot.
    if (thumb && buttons[index]) {
      const button = buttons[index];
      const thumbOffset = button.offsetLeft + (button.offsetWidth - thumb.offsetWidth) / 2;
      thumb.style.left = `${thumbOffset}px`;
    }
  }

  async function setThinkingLevel(level) {
    hasUserChangedLevel = true;
    try {
      if (configGateway) {
        const response = await configGateway.call("set_default_thinking_level", {
          level,
          scope: "global",
        });
        if (!response?.ok) throw new Error(response?.error || "Failed to save thinking level");
      }

      // The Settings control owns the persisted default. Applying that default
      // to the current runtime is best-effort and must not make a successful
      // save look like it failed or let a slow initial read restore stale UI.
      updateUI(level);
    } catch (error) {
      onError?.(error);
      return;
    }

    const target = getTarget?.();
    if (runtime && target) {
      try {
        const availableResponse = await runtime.request(
          { type: "get_available_thinking_levels" },
          target,
        );
        const availableLevels = runtimeResponseData(availableResponse)?.levels;
        if (Array.isArray(availableLevels) && availableLevels.includes(level)) {
          await runtime.request({ type: "set_thinking_level", level }, target, {
            idempotencyKey: randomId(),
          });
          onRuntimeLevelChanged?.(level, target);
        }
      } catch (error) {
        console.warn(
          "[Native] Saved default thinking level but could not apply it to session:",
          error,
        );
      }
    }
  }

  async function loadDefaultThinkingLevel() {
    if (!configGateway) return;
    try {
      const response = await configGateway.call("get_default_thinking_level", { scope: "global" });
      if (!hasUserChangedLevel && response?.ok && response.data?.level) {
        updateUI(response.data.level);
      }
    } catch (error) {
      onError?.(error);
    }
  }

  // Wire click handlers
  for (const button of buttons) {
    button.addEventListener("click", () => {
      const level = button.dataset.level;
      if (level) {
        setThinkingLevel(level).catch((error) => onError?.(error));
      }
    });
  }

  // Keyboard navigation for radio group
  radioGroup.addEventListener("keydown", (event) => {
    const currentIndex = buttons.findIndex((btn) => btn.checked);
    let nextIndex = currentIndex;

    if (event.key === "ArrowRight" || event.key === "ArrowDown") {
      event.preventDefault();
      nextIndex = (currentIndex + 1) % buttons.length;
    } else if (event.key === "ArrowLeft" || event.key === "ArrowUp") {
      event.preventDefault();
      nextIndex = (currentIndex - 1 + buttons.length) % buttons.length;
    } else {
      return;
    }

    const nextLevel = levels[nextIndex];
    if (nextLevel) {
      buttons[nextIndex].focus();
      setThinkingLevel(nextLevel).catch((error) => onError?.(error));
    }
  });

  const unsubscribeLocale = onLocaleChange(() => {
    const currentLevel =
      levelName?.dataset.thinkingLevel ||
      levels.find((_, i) => {
        return buttons[i]?.checked;
      });
    if (currentLevel) updateUI(currentLevel);
  });

  void loadDefaultThinkingLevel();

  return { updateUI, destroy: unsubscribeLocale };
}
