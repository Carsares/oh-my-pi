// Persistence for the "Agent Inbox → Start automatically" toggle.
//
// Storage note: Picot's host binds to an ephemeral port, so every app launch
// serves the WebView from a different `http://127.0.0.1:<port>` origin.
// localStorage is partitioned per-origin, so a value written on one launch is
// invisible on the next — the toggle appeared to "reset" on every restart.
// Cookies are scoped by domain (not port), so we persist the flag in a cookie
// exactly like `themes.js` does for the active theme.

export const SUPER_AGENT_ENABLED_STORAGE_KEY = "pi-studio-super-agent-enabled";
const SUPER_AGENT_ENABLED_COOKIE = SUPER_AGENT_ENABLED_STORAGE_KEY;
const COOKIE_MAX_AGE_SECONDS = 60 * 60 * 24 * 365 * 10; // 10 years

function readCookie(name) {
  try {
    const cookies = document.cookie ? document.cookie.split("; ") : [];
    for (const entry of cookies) {
      const eq = entry.indexOf("=");
      if (eq === -1) continue;
      if (entry.slice(0, eq) !== name) continue;
      const raw = entry.slice(eq + 1);
      try {
        return decodeURIComponent(raw);
      } catch {
        return raw;
      }
    }
  } catch {
    // document.cookie can throw in sandboxed contexts; treat as missing.
  }
  return null;
}

function writeCookie(name, value) {
  try {
    // biome-ignore lint/suspicious/noDocumentCookie: Cookie Store API is async; we need synchronous persistence.
    document.cookie = `${name}=${encodeURIComponent(value)}; Max-Age=${COOKIE_MAX_AGE_SECONDS}; Path=/; SameSite=Lax`;
  } catch {
    // ignore — same fallback as the read path
  }
}

export function isSuperAgentEnabled() {
  const cookie = readCookie(SUPER_AGENT_ENABLED_COOKIE);
  if (cookie !== null) return cookie === "true";
  // One-time fallback: migrate any legacy per-origin localStorage value.
  try {
    const legacy = localStorage.getItem(SUPER_AGENT_ENABLED_STORAGE_KEY);
    if (legacy !== null) {
      writeCookie(SUPER_AGENT_ENABLED_COOKIE, legacy);
      return legacy === "true";
    }
  } catch {
    // localStorage may be unavailable.
  }
  return false;
}

export function setSuperAgentEnabled(enabled) {
  writeCookie(SUPER_AGENT_ENABLED_COOKIE, String(Boolean(enabled)));
}
