// ABOUTME: Small DOM primitives shared by the native Skill Management panels.
// ABOUTME: Keeps all server-provided labels and paths in text nodes rather than HTML interpolation.

export function skillElement(tag, props = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (key === "class") node.className = value;
    else if (key === "text") node.textContent = value ?? "";
    else if (key === "dataset") Object.assign(node.dataset, value);
    else if (key.startsWith("on") && typeof value === "function") {
      node.addEventListener(key.slice(2).toLowerCase(), value);
    } else if (value !== undefined && value !== null && value !== false) {
      if (value === true) node.setAttribute(key, "");
      else node.setAttribute(key, String(value));
    }
  }
  for (const child of [].concat(children)) {
    if (child === undefined || child === null || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

export function skillStatusBadge(status) {
  return skillElement("span", {
    class: `ui-badge skill-management-status skill-management-status--${status || "unknown"}`,
    text: status || "unknown",
  });
}

export function skillDisplayName(entry) {
  return entry?.name ?? entry?.lastKnownName ?? entry?.skillId ?? "";
}

export function skillDisplayPath(entry) {
  return (
    entry?.path?.displayPath ??
    entry?.displayPath ??
    entry?.effectiveSource?.discoveredPath ??
    entry?.canonicalPath ??
    ""
  );
}

export function compactSkillPath(value) {
  if (!value) return "";
  const parts = String(value).split(/[\\/]/).filter(Boolean);
  if (parts.length <= 3) return value;
  return `.../${parts.slice(-3).join("/")}`;
}

export function renderSkillPanelMessage(container, message, kind = "empty") {
  container.replaceChildren(
    skillElement("div", {
      class: `skill-management-message skill-management-message--${kind}`,
      role: kind === "error" ? "alert" : "status",
      text: message,
    }),
  );
}
