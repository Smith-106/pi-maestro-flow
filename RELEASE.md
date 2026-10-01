# v0.31.3 — Native Pi Host & Reliable Tool Lifecycles

## Overview

Flow **0.31.3**, Teammate **2.7.2**, Cockpit **0.24.1**, Settings-Core
**0.2.3**, and Backends **0.1.5** align Maestro with Pi's native host and
harden parallel completion, remote interaction, recovery, and tool rendering.
The validation baseline is **Pi 0.99.0**. Legacy **0.87–0.98** compatibility
remains explicitly version-gated; optional host peers keep their `*` ranges.
Missing native APIs do not authorize a second legacy runtime on a native host.

## Highlights

### Native host ownership

- **Host-owned tools and discovery** — native Pi owns its tool loadout and
  `tool_search`. Maestro annotates its own tools with namespaces/exposure and
  honors explicit CLI selection rather than re-enabling disabled discovery
  (`src/tools/native-tool-policy.ts`). The legacy BM25 discovery path is only
  registered on legacy hosts.
- **Native model and classifier runtime** — provider operations and classifier
  calls use the bound host model registry on native Pi; child agents inherit
  native runtime setup. Legacy paths remain version-gated, rather than silently
  substituting for unavailable native capabilities.
- **Native MCP and keyboard handling** — Pi 0.99+ keeps the native `/mcp`
  manager and keyboard ownership. `/maestro-mcp-migrate` previews legacy config
  mappings and requires approval before migration; disable `builtin:mcp` before
  migrating because native startup reads `mcp.json` first. Unsupported mappings
  are blocked, not silently discarded (`src/mcp/native-migration.ts`).

### Reliable tools and Cockpit

- **Native Quiet mode** — compact official built-in definitions, including
  PowerShell when already available, without changing execution/parameters or
  activating additional tools. Self-owned rendering avoids duplicate host
  shells, preserves official renderer lifecycle cleanup, and switches between
  compact and official rendering live (`pi-cockpit/src/quiet-tools.ts`).
- **Honest lifecycle/error presentation** — Maestro renderers honor the host's
  canonical error context. Ordinary teammate calls show a running placeholder
  until a partial/final result takes ownership, avoiding both blank execution
  and duplicate progress rows; expert strategy headers remain distinct.
- **Boundaries remain explicit** — the first resumed-history render can still
  use official renderers before native post-bind decoration. Detectable
  third-party tool overrides are skipped; execution-only `baseToolsOverride`
  cannot be identified through the public API. Other extensions own their tool
  styles. Legacy Quiet wrappers may still require `/reload` when turned off.
- **UI ownership** — active-agent display and session/widget ownership are
  hardened; the Footer no longer duplicates background-shell status (use the
  background jobs overlay).

### Teammate completion and exact targets

- **Parallel completion durability** — reserve completion state per task,
  group it under the parent dispatch, buffer early publications, and fence
  foreground/detached delivery and nested completion. Durability uses the
  configured coordinator; a local non-durable path remains explicit
  (`src/extension/parallel-completion.ts`).
- **Exact Desktop identity** — workspace publications expose the Desktop
  session, endpoint, process generation, and normalized cwd identity, validated against
  the publishing session/workspace. Clients can target that identity instead
  of guessing from a window label (`src/sessions/workspace-peer-core.ts`).
- **Monitoring and result boundaries** — strengthen remote/proxy result
  envelopes, error details, and runtime monitoring so real failures are not
  masked by a successful-looking reply.

### Remote decisions and recovery

- **Ask cancellation race** — optional external Ask transports race the local
  TUI, settle once, and cancel the losing surface. Local cancellation closes
  remote requests; Mobile cancellation also closes the local Ask wizard
  (`src/ask-transport.ts`, `src/tools/ask.ts`).
- **Plan transport seam** — optional `pi-maestro-flow/plan-transport` supports
  remote confirm/review decisions and revision-checked edits, racing the local
  TUI with cancellation/abort cleanup. This is an integration API, not a claim
  that every Desktop/Mobile client already implements a Plan UI.
- **Addressable compaction evidence** — dropped tool results gain categorized,
  bounded receipts with exact `session://<sessionId>/entry/<entryId>` recovery
  references and previews. Recovery focus follows live actor/Todo/Goal/Plan
  progress; read the specific evidence needed instead of repeating exploration
  or re-decomposing an already-running Plan (`src/compaction/evidence-index.ts`,
  `src/compaction/recovery-focus.ts`).
- **Run-response parity** — align session orchestration with v3 operation
  identities and cancellation fences.

### Search, review, SSH, tunnels, and routing

- **`search` replaces `ffgrep`** — scoped content searches use the shared FFF
  index; root-wide plain/regex searches use bounded ripgrep, also available as
  an index-unavailable fallback. Literal/regex/fuzzy and lines/files/count
  output are supported; fuzzy still requires the index. Narrow path/glob when
  results are limited or timed out (`src/tools/fff.ts`, `src/tools/search-rg.ts`).
- **OpenCodeReview** — `open-code-review` wraps the separately installed `ocr`
  CLI: `preview`/`rules` resolve files and rules without an OCR-side LLM;
  `review` runs OCR-managed review with runtime model credentials injected;
  `health` checks CLI/model connectivity. Configure the review model through
  `/api-manager open-code-review`; reviewer guidance distinguishes delegated
  evidence from host-side review (`optional/OCR-SETUP.md`).
- **SSH host forms and localization** — add structured host add/edit forms and
  localized manager prompts (`src/ssh-manager/host-form.ts`).
- **Experimental OpenAI Secure Tunnel** — support control-plane-managed
  endpoints with optional `publicUrl`. Managed profiles still require
  authenticated Gateway HTTP; fixed-origin profiles retain OAuth origin checks
  (`src/gateway/config.ts`).
- **Model-routing reliability** — harden benchmark selection, availability,
  model failover, and evidence boundaries; native provider failure accounting
  uses the provider associated with the actual operation rather than guessing
  from a virtual session selection.

## Package versions

| Package | Version | Release scope |
|---|---|---|
| pi-maestro-flow | 0.31.3 | updated |
| pi-maestro-teammate | 2.7.2 | updated |
| pi-cockpit | 0.24.1 | updated |
| pi-maestro-settings-core | 0.2.3 | updated |
| pi-maestro-backends | 0.1.5 | updated |
| pi-maestro-backend-core | 0.1.4 | unchanged |
| pi-maestro-fabric | 0.1.0 | unchanged |
| pi-maestro-fabric-core | 0.1.0 | unchanged |
| pi-fluent-tui | 0.1.2 | unchanged |

The external engine dependency remains **`maestro-flow >=0.5.87`**, not an
exact pin. The release preparation environment has **0.5.87** installed;
registry latest was **0.5.89** at preparation time. The release operator will
check the latest resolution in a fresh registry smoke before tagging.

The DSH SDK is now an **optional peer** (`*`): install
`@deepseek-ai/dsh-sdk-client` manually when using DSH. The development baseline
is **0.1.0-rc.6**; ordinary Pi users do not need that SDK.

## Scope

The release includes **30 commits after `v0.31.2`**: 29 implementation
commits plus the release preparation commit containing the user-approved
native Quiet/tool-lifecycle changes and focused gate repairs.

Final range: **326 files changed, +33,450 / −14,604 lines**.

## Verification

All applicable release gates passed. Existing passing results were reused;
only affected boundaries and previously blocked targets were revalidated.

- All applicable non-packed release targets passed using retained passing
  results and focused repairs, rather than rerunning unchanged passing suites.
- Settings-Core: 33/33; Backends: 162 passing with 10 existing environment-gated
  exclusions. Teammate's original 21 failures and 62 cancelled outcomes were
  covered by passing targeted repairs; its 11 existing exclusions remain.
- Cockpit ownership/integration: 38/38; a subsequent teardown correction and
  injected shutdown-failure regression passed 8/8 targeted checks. The original
  native-host/Quiet checks passed 33/33 and were reused.
- Flow package typecheck passed; request-scope checks passed 9/9, native renderer
  lifecycle 1/1, and 19 additional changed-file checks 247/247. The remaining
  applicable non-packed release scripts passed. Existing platform exclusions
  on Windows were retained (7 Bash, 1 Plan, and 1 session case); no assertions
  were skipped and the fresh-install budget remains 600 seconds.
- Independent reviews covered the original renderer changes, gate repairs,
  and managed-install fixtures. Cleanup and postinstall-budget findings were
  corrected; the affected checks passed.
- Documentation-site TypeScript/Vite build passed; final scope copy was checked
  for consistency.
- `test:packed`: 1/1, including real tarball installation, Flow and Smart Search
  postinstall, declaration resolution, optional-peer absence, and real Pi RPC.
- `test:packed-todo`: 1/1, including real Flow companion registration and root/
  child tool discovery. Its install suppresses peers like Pi's managed installer;
  unrelated optional runtime setup is covered by the full packed-consumer gate.
  Local Flow postinstall has a separate 30-second allowance; installation retains
  its 600-second budget.

Publication uses the exact dry-run tarballs with registry SHA verification.
The release tag is created only after fresh HOME/USERPROFILE installation and
registry-backed Pi RPC/tool-catalog smoke pass.

## Install / upgrade

Requires **Node.js ≥ 22.19.0**. Use **Pi 0.99.0** as the validation baseline;
legacy Pi **0.87–0.98** uses version-gated compatibility paths.

```bash
npm install -g --ignore-scripts @earendil-works/pi-coding-agent
pi install npm:pi-maestro-flow@0.31.3
pi list
```

Close running Pi processes before upgrading, then restart Pi. Flow-managed
companion registrations migrate automatically; preserved local development
overrides must be upgraded or removed explicitly to match this suite.
