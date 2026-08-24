import { t } from "../../i18n.js";

function activeSession(getTarget, getSessions) {
  const sessionId = getTarget()?.sessionId ?? "";
  return {
    id: sessionId,
    session: getSessions?.().find((item) => item?.id === sessionId) ?? null,
  };
}

export function setupSessionInfo({
  toggle,
  panel,
  fileValue,
  idValue,
  getTarget,
  getSessions,
  writeText = (text) => navigator.clipboard?.writeText(text),
}) {
  if (!toggle || !panel || !fileValue || !idValue) return { refresh() {} };

  // Match the Context usage popover: portal to <body> so the header's
  // horizontal scroller cannot clip the panel.
  if (panel.parentElement !== document.body) document.body.appendChild(panel);

  const refresh = () => {
    const { id, session } = activeSession(getTarget, getSessions);
    fileValue.textContent = session?.filePath || t("sessionInfo.inMemory");
    idValue.textContent = id || t("sessionInfo.unavailable");
  };

  const close = () => {
    panel.classList.add("hidden");
    toggle.setAttribute("aria-expanded", "false");
  };

  toggle.addEventListener("click", (event) => {
    event.stopPropagation();
    if (!panel.classList.contains("hidden")) {
      close();
      return;
    }
    refresh();
    const rect = toggle.getBoundingClientRect();
    panel.style.position = "fixed";
    panel.style.top = `${rect.bottom + 8}px`;
    panel.style.left = `${rect.left}px`;
    panel.style.right = "auto";
    panel.classList.remove("hidden");
    toggle.setAttribute("aria-expanded", "true");
  });

  document.addEventListener("click", (event) => {
    if (!panel.contains(event.target) && event.target !== toggle) close();
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") close();
  });

  for (const button of panel.querySelectorAll("[data-copy-session-field]")) {
    button.addEventListener("click", async () => {
      const value =
        button.dataset.copySessionField === "file" ? fileValue.textContent : idValue.textContent;
      const defaultLabel = t(
        button.dataset.copySessionField === "file" ? "sessionInfo.copyFile" : "sessionInfo.copyId",
      );
      try {
        const result = writeText?.(value);
        if (!result) throw new Error("Clipboard unavailable");
        await result;
        button.title = t("sessionInfo.copied");
        button.setAttribute("aria-label", t("sessionInfo.copied"));
      } catch {
        button.title = t("sessionInfo.copyFailed");
        button.setAttribute("aria-label", t("sessionInfo.copyFailed"));
      }
      setTimeout(() => {
        button.title = defaultLabel;
        button.setAttribute("aria-label", defaultLabel);
      }, 1500);
    });
  }

  return { refresh };
}
