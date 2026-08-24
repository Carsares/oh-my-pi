export function reconcileSnapshotTarget(currentTarget, snapshotTarget) {
  if (!snapshotTarget) return currentTarget;
  if (
    snapshotTarget.workspaceId !== currentTarget.workspaceId ||
    snapshotTarget.instanceId !== currentTarget.instanceId
  ) {
    throw new Error("Snapshot target does not belong to the current runtime");
  }
  // If the sessionId differs and this is NOT a session_bound promotion
  // (temporary- prefix → real id), treat as stale and keep current target.
  if (
    snapshotTarget.sessionId !== currentTarget.sessionId &&
    !currentTarget.sessionId.startsWith("temporary-")
  ) {
    return currentTarget;
  }
  return snapshotTarget;
}
