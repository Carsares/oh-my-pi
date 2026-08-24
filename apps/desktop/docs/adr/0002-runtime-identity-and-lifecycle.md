# ADR 0002: Stable runtime identity and one live session per process

- Status: Accepted
- Date: 2026-07-14

## Context

Pi's `new_session` and `switch_session` commands replace the live session inside a process. Using a
port or session path as identity makes concurrent sessions ambiguous and makes restart or suspension
change browser routing.

## Decision

Clients address a runtime with opaque `workspaceId`, Pi `sessionId`, and random `instanceId`. A new
session temporarily uses a Host ID until Pi persists its formal ID. Canonical paths remain private to
the Host registry. Every command validates agreement among all three IDs.

One process owns one live session for its lifetime. New, resumed, forked, and cloned sessions start a
new process; no live process receives identity-replacing `new_session` or `switch_session`. Tree
navigation may change the active branch within that same session through Pi-owned behavior.

Background idle instances suspend after 30 minutes, with at most eight warm idle instances retained
by LRU. Visible, working, queued, retrying, compacting, and dialog-blocked instances never suspend.
Resume preserves `sessionId` and assigns a new `instanceId`. Crash recovery restores persisted session
state only and never replays an unfinished prompt or tool execution.
Closing the runtime RPC stream unregisters that instance immediately, so it cannot remain marked as
working or be reused after its Pi process exits. Reopening starts a fresh process from persisted state.

Mutations require idempotency keys. Acceptance and completion are separate; a lost outcome is surfaced
as unknown and is never automatically retried.

Historical session names remain Pi-owned metadata. The native sidebar invokes the bundled
`picot-config` adapter through the active RPC process; that adapter validates the target against
`SessionManager.listAll()`, opens the canonical managed session with `SessionManager.open()`, and
appends the name through `appendSessionInfo()`. Active-session rename continues to use Pi's native
`set_session_name` RPC so live in-memory state stays synchronized.

## Consequences

- URLs survive process replacement and contain no local paths or ports.
- Fork and clone preserve the source process, route, queue, and UI.
- Runtime snapshots and monotonically sequenced events are required for reconnect recovery.
