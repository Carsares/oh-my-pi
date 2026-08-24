import { t } from "../../i18n.js";

const DEFAULT_DURATION_MS = 8000;

function normalizeNotification(input) {
  if (typeof input === "string") return { title: input };
  return input && typeof input === "object" ? input : { title: "Notification" };
}

export function createNotificationCenter({
  root = document.body,
  duration = DEFAULT_DURATION_MS,
} = {}) {
  let stack = root.querySelector(".native-notification-stack");
  if (!stack) {
    stack = document.createElement("div");
    stack.className = "native-notification-stack";
    stack.setAttribute("aria-live", "polite");
    stack.setAttribute("aria-relevant", "additions");
    root.appendChild(stack);
  }

  function notify(input) {
    const notification = normalizeNotification(input);
    const type = notification.type || "info";
    const card = document.createElement("div");
    card.className = `native-notification native-notification--${type}`;
    card.setAttribute("role", type === "error" ? "alert" : "status");

    const content = document.createElement("div");
    content.className = "native-notification-content";

    const title = document.createElement("div");
    title.className = "native-notification-title";
    title.textContent = notification.title || "Notification";
    content.appendChild(title);

    if (notification.message) {
      const message = document.createElement("div");
      message.className = "native-notification-message";
      message.textContent = notification.message;
      content.appendChild(message);
    }

    if (notification.detail) {
      const detail = document.createElement("div");
      detail.className = "native-notification-detail";
      detail.textContent = notification.detail;
      content.appendChild(detail);
    }

    const close = document.createElement("button");
    close.type = "button";
    close.className = "native-notification-close";
    close.setAttribute(
      "aria-label",
      t("migrated.native.notifications.notificationCenter.ariaLabel.dismissNotification"),
    );
    close.textContent = "×";

    card.appendChild(content);
    card.appendChild(close);
    stack.appendChild(card);

    let timeoutId = null;
    const dismiss = () => {
      if (timeoutId) window.clearTimeout(timeoutId);
      card.remove();
      if (!stack.children.length) stack.remove();
    };

    close.addEventListener("click", dismiss);

    const notificationDuration = notification.duration ?? duration;
    if (notificationDuration > 0) {
      timeoutId = window.setTimeout(dismiss, notificationDuration);
    }

    return { element: card, dismiss };
  }

  return { notify };
}
