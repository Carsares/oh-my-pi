# Desktop to OMP compatibility contract

This document freezes the integration boundary between the Picot desktop app
under `apps/desktop` and the OMP runtime in this repository. The desktop adapts
to the existing OMP CLI, RPC, persistence, Skill, and Plugin contracts. The
integration does not add Pi-compatible aliases to OMP.

## Runtime architecture

```text
Picot WebView -> Rust HostServer -> bundled OMP subprocess -> stdio RPC
```

The OMP binary must be built from the same checkout and bundled with the
desktop application. A globally installed `pi` or `omp` is never part of the
runtime contract.

## Compatibility matrix

| Surface | Picot 0.4.2 assumption | OMP 18.0.4 contract | Desktop adaptation |
| --- | --- | --- | --- |
| Binary | downloaded `pi` release | repository-built `omp` | build and stage OMP from this checkout |
| RPC commands | `get_commands` | `get_available_commands` | send the OMP command |
| Branching | `fork` | `branch` | send `branch` and preserve the response shape |
| Thinking levels | `get_available_thinking_levels` | `get_available_models` returns `thinking.efforts` | derive levels from selected model metadata |
| Queue count | `pendingMessageCount` | `queuedMessageCount` | consume the OMP field only where needed |
| User agent root | `~/.pi/agent` | `~/.omp/agent` or `PI_CODING_AGENT_DIR` | resolve one OMP root and share it across all desktop services |
| Project config | `<cwd>/.pi` | `<cwd>/.omp` | use the OMP project directory |
| Settings | `settings.json` | `config.yml` | use OMP settings APIs or the OMP YAML contract |
| Models | `models.json` | `models.yml` | use the OMP model registry contract |
| Credentials | `auth.json` | OMP credential storage in `agent.db` | use OMP credential APIs; never write `auth.json` |
| Sessions | Pi JSONL under `~/.pi/agent/sessions` | OMP v3 JSONL in the resolved sessions directory | point the Rust read model at the OMP directory without rewriting files |
| Skills | Pi settings and `.pi` discovery | OMP Skill discovery and settings | adapt inventory and mutations to OMP semantics |
| Packages | `pi list/install/remove/update` | `omp plugin ...` and marketplace APIs | adapt the existing package UI to OMP Plugins |

## Compatibility fixtures

- `apps/desktop/tests/fixtures/omp-rpc/18.0.4/contract.json` records the
  RPC commands and state fields the desktop depends on.
- `apps/desktop/tests/fixtures/omp-session/v3/branched-session.jsonl` records
  the persisted OMP session entries the Rust session reader must accept.

The fixtures are acceptance inputs, not a second implementation of the OMP
protocol. When OMP changes, update the desktop adapter first and update a
fixture only after reviewing the observable contract change.

## Scope boundary

This integration preserves existing Picot workflows using existing OMP
capabilities. It does not add prompt or Skill path restrictions, automatic Pi
data migration, Pi command aliases, fallback runtime paths, or a second
configuration store for OMP-owned data.
