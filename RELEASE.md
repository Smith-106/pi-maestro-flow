# v0.31.2 — Pi 0.87 Context-Edit Persistence & Browser Navigation Policy

## Overview

This patch release publishes **Flow 0.31.2** and **Teammate 2.7.1** on top of
v0.31.0. All `@earendil-works/pi-*` packages are pinned to **0.87.0**, the
mid-turn auto-prune machinery now persists its replacements through Pi 0.87's
`context_edit` session entries instead of relying solely on the custom prune
journal, and the browser tool gains a declarative navigation policy,
accessibility-tree helpers, a one-shot CDP event waiter, and
output-overflow spill capture.

**v0.31.2 supersedes v0.31.1**: v0.31.1 was published before the browser
feature commit landed, so its tarball does not contain the browser changes.
No other behavioral difference exists between 0.31.1 and 0.31.2.

**Cockpit 0.24.0** ships unchanged; **Settings-Core 0.2.2**,
**Backend-Core 0.1.4**, **Backends 0.1.4**, **Fabric 0.1.0**, and
**Fabric-Core 0.1.0** are likewise unchanged.

## Highlights

### Flow 0.31.2

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
- **Browser navigation policy** — `app.policy {allow, deny}` on open guards
  navigation on managed/profile/cdp channels: exact hosts or `*.example.com`
  wildcards (deny wins), `tab.goto`/`page.goto` pre-check, denied main-frame
  navigations bounce to `about:blank`, denied new tabs are closed, and
  violations surface in run output. Best-effort navigation guard, not a
  network sandbox (`src/tools/browser-tool.ts`, `src/tools/browser/manager.ts`).
- **Accessibility-tree helpers** — `tab.axTree({maxNodes?})` exposes
  role/name/value plus control state and a `backendNodeId` per node;
  `tab.clickNode(id, {hoverMs?})` and `tab.typeNode(id, text, {replace?})`
  act on those ids through CDP.
- **One-shot CDP event waiter** — `tab.waitForCdp(method, {predicate?,
  timeout?})` subscribes on the page session before the triggering action.
- **Output-overflow spill** — when a run's output budget trips, the captured
  output (up to a 1 MB spill cap) is preserved to a file and the error
  carries its path instead of losing the evidence.
- **Browser SOP updates** — the embedded core SOP and helper quickref now
  document the AX tree, CDP event waiting, navigation policy, and
  no-replay failure semantics (`src/tools/sop/embedded/browser.ts`).

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
- `test/browser-tool.test.ts` — 37/37 (includes navigation-policy and
  overflow-spill coverage).
- `pi-maestro-teammate` session-history suite — 7/7 (includes the new
  context_edit projection test).
- `tsc -p tsconfig.build.json` clean for pi-maestro-flow, pi-maestro-teammate,
  and pi-cockpit.
- Publish shasum parity: `pi-maestro-teammate@2.7.1` dry-run shasum
  `e504682dcfe88e51c89440bfd9bec4cb19e87d9e` and `pi-maestro-flow@0.31.2`
  dry-run shasum `1cd5873d44ada64e07af046391a9ae6299eab09a` match the
  registry `dist.shasum` byte-for-byte.

## Package versions

| Package | Version | Published |
|---|---|---|
| pi-maestro-flow | 0.31.2 | yes (supersedes 0.31.1) |
| pi-maestro-teammate | 2.7.1 | yes |
| pi-cockpit | 0.24.0 | unchanged |
| pi-maestro-settings-core | 0.2.2 | unchanged |
| pi-maestro-backend-core | 0.1.4 | unchanged |
| pi-maestro-backends | 0.1.4 | unchanged |
| pi-maestro-fabric | 0.1.0 | unchanged |
| pi-maestro-fabric-core | 0.1.0 | unchanged |

## Scope

4 commits since v0.31.0, 17 files changed.

## Install / upgrade

```bash
npm install -g pi-maestro-flow@0.31.2
```

Requires Pi ≥ 0.87.0 on the host (`@earendil-works/pi-*` are peer deps with
`*` ranges; the new `context_edit` write path only activates on a 0.87 host).
