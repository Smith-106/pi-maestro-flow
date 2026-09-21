# v0.31.0 — Fabric Placement, Compaction Reliability & Fluent TUI

## Overview

This feature release publishes **Flow 0.31.0**, **Teammate 2.7.0**, and
**Cockpit 0.24.0** on top of v0.30.0, and publishes two new packages for the
first time: **Fabric-Core 0.1.0** and **Fabric 0.1.0**. **Settings-Core 0.2.2**,
**Backend-Core 0.1.4**, and **Backends 0.1.4** ship supporting changes. The
external engine requirement is now a floor instead of an exact pin:
`maestro-flow@>=0.5.87`.

The release lands the multi-host Fabric runtime — route-bound HTTPS channels,
Connector enrollment over outbound WSS, chunked artifact transfer, and
route-pinned teammate placement — alongside compaction wake reliability and
per-model absolute thresholds, a corrected SSH tool schema, RPC/headless
settings fields, classifier prompt optimization, and the published Fluent TUI.

## Highlights

### Flow 0.31.0

- **Fabric remote-placement runtime** — durable admission, route-bound HTTPS
  channels, Connector enrollment and challenge proof, outbound-WSS transport,
  HMAC-signed route tickets, chunked artifact transfer with per-chunk digests,
  session-scoped MCP mounts, and Gateway-mounted Connector Hub with CLI
  controls.
- **Compaction wake reliability** — recovery wakes drained by Pi's follow-up
  queue (which emits `agent_start` without `before_agent_start`) are promoted
  to `turn-started` at the settled boundary from exact branch-marker evidence;
  superseding user input cancels the wake instead of deadlocking it (#29).
- **Per-model compaction thresholds** — `compaction.modelThresholds` accepts
  absolute token overrides keyed by `provider/id` (bare `id` fallback);
  invalid values fall back to the derived threshold (#28).
- **Payload-based compaction** — a generic `payloadLimitBytes` budget replaces
  the image byte cap, triggers on protected-region oversize, persists through
  the TUI, and runs unconditionally ahead of token pressure.
- **SSH tool schema fix** — the root `Type.Union` that serialized to
  `{ properties: {} }` for GLM/Kimi is flattened to a single `Type.Object`
  with runtime field validation, and imported hosts reuse existing
  known_hosts fingerprint pins (#30).
- **RPC/headless settings fields** — configuration commands accept
  `--field=value` arguments through the existing mutation pipeline; purely
  interactive overlays emit explicit degradation notices under RPC.
- **Classifier and providers** — shared rules with JEV classification,
  per-model thinking defaults, Devin account login with Cascade transport,
  API key pools with extracted header presets, disabled-provider suspension,
  and model-failover implicit-sweep exclusions.
- **Gateway and tunnels** — managed tunnel profiles and config UI, tunnel MCP
  access controls, isolated browser control, child-abort delivery before IPC
  close, durable Fabric store recovery, and remote Gateway agent projection.
- **Install-surface hardening** — the root manifest no longer registers a
  skills-only `pi` block, so Git-URL installation is a visible no-op rather
  than silently missing Flow extensions (#22); `.pi` skill/agent mirrors
  resynced against `maestro-flow` 0.5.87 including the corrected
  `run recall search` syntax (#24).
- **Assorted fixes** — scoped workspace search enforcement, serialized usage
  history writes, RSC table column counting, large-record argument-stack
  overflow, plan-mode file-editing gating, artifact switching, and LSP
  file-URI normalization.

### Teammate 2.7.0

- **Fabric placement** — route-pinned teammate backend, source-side
  single-attempt runtime port, and the Gateway Agent Endpoint bridge; dispatch
  threads placement through the Fabric route resolver.
- **Reliability** — retries and heartbeats aligned with host capabilities,
  background status heartbeat configuration, hardened stale-child IPC
  replies, console suppression while the TUI owns the screen, external agent
  projections, and standalone agent discovery isolation.

### Cockpit 0.24.0

- **Performance** — single-build zen stack, render memoization, patch-health
  registry, terminal theme integration, and cross-extension ownership
  contract tests.
- **Viewport correctness** — duplicated-line detection at viewport
  boundaries, preserved boundary redraws, and disabled self-evolve status
  hidden.

### Fabric 0.1.0 / Fabric-Core 0.1.0 (first publish)

- **Fabric-Core** — versioned pure contracts and state validation: ready and
  safe capability projections plus Phase 3-6 contract definitions.
- **Fabric** — host-independent connection kernel: Phase 2 kernel, durable
  admission, route-bound HTTPS channels, Connector lifecycle, artifact
  transfer, and production device placement.

### Settings-Core 0.2.2 / Backend-Core 0.1.4 / Backends 0.1.4

- `supportsCustomOverlay` replaces `ctx.ui.custom` presence checks for
  headless/RPC capability detection.
- Fabric teammate backend with route-pinned endpoints, single-attempt start
  semantics, provenance stripping, and production device placement.

## Package version table

| Package | Previous | New |
|---|---|---|
| pi-maestro-flow | 0.30.0 | 0.31.0 |
| pi-maestro-teammate | 2.6.2 | 2.7.0 |
| pi-cockpit | 0.23.0 | 0.24.0 |
| pi-maestro-settings-core | 0.2.1 | 0.2.2 |
| pi-maestro-backend-core | 0.1.3 | 0.1.4 |
| pi-maestro-backends | 0.1.3 | 0.1.4 |
| pi-maestro-fabric | — | 0.1.0 (first publish) |
| pi-maestro-fabric-core | — | 0.1.0 (first publish) |
| maestro-flow (engine) | 0.5.86 (exact) | >=0.5.87 (floor) |

## Stats

- **132 commits** on top of baseline tag `v0.30.0` before the release
  metadata commit.
- **701 files changed**, **+130,080 / -9,013** lines (includes pi-fluent-tui
  platform binaries and spikes).

## Install / Upgrade

```bash
pi install npm:pi-maestro-flow@0.31.0
```

This pulls the published companions `pi-maestro-teammate@2.7.0`,
`pi-cockpit@0.24.0`, `pi-maestro-settings-core@0.2.2`,
`pi-maestro-backend-core@0.1.4`, `pi-maestro-backends@0.1.4`,
`pi-maestro-fabric@0.1.0`, and `pi-maestro-fabric-core@0.1.0`, and requires
`maestro-flow@>=0.5.87`.
