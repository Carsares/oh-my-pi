# ADR 0001: Use one Rust Host and native OMP RPC

- Status: Accepted
- Date: 2026-07-14

## Context

Picot previously started an HTTP/WebSocket server inside every agent process and split runtime behavior
between that extension, a Rust broker, and browser HTTP calls. Ports consequently act as process,
session, and navigation identity, while the runtime's authoritative RPC responses were discarded.

## Decision

One Rust Host owns the application HTTP/WebSocket origin, client authorization, routing, local read
models, and process lifecycle. Every bundled OMP process runs in RPC mode and communicates only
through strict LF-delimited JSONL on stdin/stdout. A `PiRpcBridge` correlates responses and classifies
runtime events and extension UI requests. OMP processes do not bind TCP ports.

Protocol v2 is an atomic replacement. It has no v1 translation, cross-port navigation, active-port
fallback, or silent downgrade. Native OMP RPC is authoritative. A bundled extension may expose only
namespaced `picot.*` adapters for OMP-owned behavior absent from RPC.

## Consequences

- Local WebViews and authorized remote clients share one origin and one protocol.
- Runtime feature code cannot depend on paths, ports, subprocess frames, or per-process HTTP routes.
- The legacy embedded server and its duplicate runtime handlers were deleted at cutover.
- The native OMP startup path is the only supported runtime path.
