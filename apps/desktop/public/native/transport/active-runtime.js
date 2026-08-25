function isRuntimeTarget(target) {
  return Boolean(
    target?.workspaceId &&
      target?.sessionId &&
      target?.instanceId &&
      target.instanceId !== "pending-bootstrap",
  );
}

function activeRuntimeUrl(location) {
  return new URL("/v2/active-runtime", location.origin);
}

export async function getActiveRuntime({
  fetchImpl = window.fetch.bind(window),
  location = window.location,
} = {}) {
  const response = await fetchImpl(activeRuntimeUrl(location));
  if (!response.ok) throw new Error("Active runtime request failed");
  const { target } = await response.json();
  return isRuntimeTarget(target) ? target : null;
}

export async function setActiveRuntime(
  target,
  { fetchImpl = window.fetch.bind(window), location = window.location } = {},
) {
  if (!isRuntimeTarget(target)) return false;
  const response = await fetchImpl(activeRuntimeUrl(location), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(target),
  });
  if (!response.ok) throw new Error("Active runtime update failed");
  return true;
}

export function setupActiveRuntimeTracking({
  getTarget,
  eventTarget = window,
  setActive = setActiveRuntime,
  onError,
} = {}) {
  const sync = async () => {
    try {
      return await setActive(getTarget?.());
    } catch (error) {
      onError?.(error);
      return false;
    }
  };
  const handleFocus = () => void sync();
  eventTarget.addEventListener("focus", handleFocus);
  return {
    sync,
    destroy: () => eventTarget.removeEventListener("focus", handleFocus),
  };
}
