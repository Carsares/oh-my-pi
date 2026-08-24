import { onLocaleChange, t } from "../i18n.js";

const DEFAULT_MIN_WIDTH = 260;
const DEFAULT_MAX_WIDTH = 560;

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function readStoredWidth(storageKey) {
  if (!storageKey) return null;
  const stored = Number.parseInt(localStorage.getItem(storageKey) || "", 10);
  return Number.isFinite(stored) ? stored : null;
}

export function setupResizablePanel(
  panel,
  {
    storageKey,
    defaultWidth,
    minWidth = DEFAULT_MIN_WIDTH,
    maxWidth = DEFAULT_MAX_WIDTH,
    // 'right' = panel is on the right edge (drag handle on left, drag left to grow)
    // 'left'  = panel is on the left edge (drag handle on right, drag right to grow)
    side = "right",
  },
) {
  if (!panel) return () => {};

  panel.classList.add("app-side-panel", "is-resizable");
  const initialWidth = clamp(readStoredWidth(storageKey) ?? defaultWidth, minWidth, maxWidth);
  setPanelWidth(panel, initialWidth, storageKey);

  const handle =
    panel.querySelector(".app-side-panel-resize-handle") || document.createElement("div");
  handle.className =
    side === "left"
      ? "app-side-panel-resize-handle app-side-panel-resize-handle--right-edge"
      : "app-side-panel-resize-handle";
  handle.setAttribute("role", "separator");
  handle.setAttribute("aria-orientation", "vertical");
  const applyHandleTitle = () => {
    handle.setAttribute("title", t("migrated.ui.resizablePanel.title.resizePanel"));
  };
  applyHandleTitle();
  const unsubscribeLocaleChange = onLocaleChange(applyHandleTitle);
  if (!handle.parentElement) {
    panel.append(handle);
  }

  let startX = 0;
  let startWidth = initialWidth;

  const onPointerMove = (event) => {
    // For right-edge panels: drag left (clientX decreases) → grow width → startX - clientX > 0
    // For left-edge panels:  drag right (clientX increases) → grow width → clientX - startX > 0
    const delta = side === "left" ? event.clientX - startX : startX - event.clientX;
    const nextWidth = clamp(startWidth + delta, minWidth, maxWidth);
    setPanelWidth(panel, nextWidth, storageKey);
  };

  const onPointerUp = () => {
    document.body.classList.remove("is-resizing-side-panel");
    document.removeEventListener("pointermove", onPointerMove);
    document.removeEventListener("pointerup", onPointerUp);
  };

  const onPointerDown = (event) => {
    event.preventDefault();
    startX = event.clientX;
    startWidth = Number.parseInt(panel.style.getPropertyValue("--panel-width"), 10) || initialWidth;
    document.body.classList.add("is-resizing-side-panel");
    document.addEventListener("pointermove", onPointerMove);
    document.addEventListener("pointerup", onPointerUp);
  };

  handle.addEventListener("pointerdown", onPointerDown);

  return () => {
    handle.removeEventListener("pointerdown", onPointerDown);
    document.removeEventListener("pointermove", onPointerMove);
    document.removeEventListener("pointerup", onPointerUp);
    document.body.classList.remove("is-resizing-side-panel");
    unsubscribeLocaleChange();
  };
}

function setPanelWidth(panel, width, storageKey) {
  panel.style.setProperty("--panel-width", `${Math.round(width)}px`);
  if (storageKey) {
    localStorage.setItem(storageKey, String(Math.round(width)));
  }
}
