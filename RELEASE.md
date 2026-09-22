# v0.31.1 — Pi 0.87 Context-Edit Persistence

## Overview

This patch release publishes **Flow 0.31.1** and **Teammate 2.7.1** on top of
v0.31.0. All `@earendil-works/pi-*` packages are pinned to **0.87.0**, and the
mid-turn auto-prune machinery now persists its replacements through Pi 0.87's
`context_edit` session entries instead of relying solely on the custom prune
journal.

**Cockpit 0.24.0** ships unchanged; **Settings-Core 0.2.2**,
**Backend-Core 0.1.4**, **Backends 0.1.4**, **Fabric 0.1.0**, and
**Fabric-Core 0.1.0** are likewise unchanged.

## Highlights

### Flow 0.31.1

- **Pi 0.87 upgrade** — `@earendil-works/pi-agent-core`, `pi-ai`,
  `pi-coding-agent`, and `pi-tui` are pinned to `0.87.0`. The Devin transport
  migrated to `TranscriptContext`, recovering the system prompt and tool set
  through `getCurrentSystemPrompt`/`getCurrentTools` (`src/providers/devin/
  transport.ts`).
- **Durable auto-prunes** — recorded tool-result prunes are committed at the
  `turn_end` boundary as append-only `context_edit` session entries, resolved
  by callId to the projected source entry and carrying byte-identical
  replacement content (`src/compaction/auto-compaction.ts`,
  `src/extension/index.ts`). The host projection now replays them across
  turns, resume, fork, branch navigation, and compaction preparation, so
  `prepareCompaction` and threshold estimation see the pruned sizes.
- **Confirmation-based commit tracking** — a prune is only treated as
  committed after the projection is observed serving the replacement bytes;
  unobserved drafts are re-emitted (bounded by `MAX_CONTEXT_EDIT_DRAFTS`) so a
  dropped boundary batch self-heals, while file-backed spill/minimal
  replacements stay on the journal where resume-time path revalidation lives.
- **new-context unchanged** — it keeps the `ctx.compact()` pipeline because
  boundary compaction drafts commit silently without emitting
  `session_compact`, which downstream goal/advisor/knowhow/loop listeners and
  third-party extensions rely on.

### Teammate 2.7.1

- **Fork-snapshot whitelist** — accepts the 0.87 `context_edit` and `usage`
  entry types instead of failing closed (`src/runs/fork-snapshot.ts`).
- **History projection parity** — `projectChain` applies branch-local
  `context_edit` entries (null omits the target, object replacements swap
  content, string replacements wrap into a text block for assistant/tool
  results), scoped to the surviving range of the latest compaction exactly
  like the host's `buildSessionProjection` (`src/transcript/session-history.ts`).

## Verification

- `npm run test:compaction` — 399/399 (includes the new turn_end boundary
  draft test covering spill exclusion, unconfirmed re-emission, observed
  commit retirement, and journal removal).
- `pi-maestro-teammate` session-history suite — 7/7 (includes the new
  context_edit projection test).
- `tsc -p tsconfig.build.json` clean for pi-maestro-flow, pi-maestro-teammate,
  and pi-cockpit.
- Publish shasum parity: `pi-maestro-teammate@2.7.1` dry-run shasum
  `e504682dcfe88e51c89440bfd9bec4cb19e87d9e` matches the registry
  `dist.shasum` byte-for-byte.

## Package versions

| Package | Version | Published |
|---|---|---|
| pi-maestro-flow | 0.31.1 | yes |
| pi-maestro-teammate | 2.7.1 | yes |
| pi-cockpit | 0.24.0 | unchanged |
| pi-maestro-settings-core | 0.2.2 | unchanged |
| pi-maestro-backend-core | 0.1.4 | unchanged |
| pi-maestro-backends | 0.1.4 | unchanged |
| pi-maestro-fabric | 0.1.0 | unchanged |
| pi-maestro-fabric-core | 0.1.0 | unchanged |

## Scope

3 commits since v0.31.0, 12 files changed (+12,277 / −15,337, dominated by the
`package-lock.json` refresh for the pi 0.87 pin set).

## Install / upgrade

```bash
npm install -g pi-maestro-flow@0.31.1
```

Requires Pi ≥ 0.87.0 on the host (`@earendil-works/pi-*` are peer deps with
`*` ranges; the new `context_edit` write path only activates on a 0.87 host).
