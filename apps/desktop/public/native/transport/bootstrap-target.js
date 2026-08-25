const RUNTIME_UNAVAILABLE_MESSAGE = "This Picot runtime is stopped or unavailable";

export function createBootstrapError(route, status, code, sessionNotFoundMessage) {
  const message =
    code === "session_not_found" ? sessionNotFoundMessage : RUNTIME_UNAVAILABLE_MESSAGE;
  const error = new Error(message);
  error.status = status;
  error.code = code;
  error.sessionLoadKey = `session-load:${route.workspaceId}:${route.sessionId}:${code || status}`;
  return error;
}

/**
 * Resolve the runtime target for a session route.
 *
 * Temporary session ids are process-local: they are intentionally never
 * persisted. A route can therefore outlive the host process that created it
 * after an app update, crash, or a second Picot instance starts. In that one
 * case, recover by creating a new temporary runtime for the same workspace.
 */
export async function resolveBootstrapTarget({ route, requestTarget, spawnTemporarySession }) {
  try {
    return await requestTarget(route);
  } catch (error) {
    if (!isMissingTemporarySession(route, error)) throw error;
    return spawnTemporarySession(route.workspaceId);
  }
}

function isMissingTemporarySession(route, error) {
  return route?.sessionId?.startsWith("temporary-") && error?.status === 404;
}
