# Changelog

All notable changes to this project are documented in this file.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added — M3 read-only tools, batch operations, enriched detail (2026-10-28)

- Host read model (`src/host/read-model.ts`): header snapshots, lineage views,
  and defensive folding of raw session events into turns/steps/message counts,
  tool calls, token totals, last activity and title.
- `SessionButlerService.detail` now returns `lineage`, `enrichment`, and folded
  `stats` (event count, log size, token totals, preset); `stat(id)` is the sole
  header source and event enrichment is best-effort, so migration-required or
  unreadable logs degrade to `enrichment: {status:'partial', reason}` instead of
  failing the detail read.
- `SessionButlerService.listSessions(filters)`: merges persisted headers, live
  sessions/agents, best-effort title snapshots, and archived/pinned sets; filters
  by query/cwd/archived/subagents, sorts by creation time, pages newest-first
  (default 25, max 100, `truncated`).
- Batch operations `trashMany` / `restoreMany` (1–50 unique ids, per-item
  isolation, aggregate `moved`/`failed`, no-op for ids already removed by a
  cascade) exposed through new bridge methods `list`, `trash-many`,
  `restore-many`.
- Agent tools `session_butler_list` / `session_butler_detail` registered
  structurally through `ctx.tools.register` (no `@deepseek-ai/dsh-tools`
  import): hand-built parameter schemas, JSON-Schema output contracts plus
  bounded text renderers; read-only by design, registered in an optional
  `tools` injection.
- Web page: multi-select on both tabs (select-all, clear, batch trash with
  migration preflight/cascade count, batch restore), a session detail dialog
  (figures, tokens, log size, lineage tree, enrichment hint), and zh/en strings.
- Tests: 16 new cases (`m3-read-model`, `m3-tools`, bridge batch/list methods,
  client batch/detail SSR renders); suite now 52. Tool schemas and sample
  outputs were validated against the real DSH `assertSupportedJsonSchema` /
  `validateJsonSchemaValue` implementation.
- Verified in a temporary Web profile (same DSH home, `tl-m3` profile removed
  afterwards): `list` paged 99 sessions (`truncated: true` at limit 3), `detail`
  returned complete enrichment for a real 5.7 MB session (11 turns / 494 steps /
  4610 observed events / token totals / title / preset) and correct
  parent↔descendant lineage for a subagent session, `trash-many` rejected all
  malformed payloads with HTTP 400 `invalid-request`, and `restore-many` reported
  an unknown id per item (`trash-not-found`) with HTTP 200 aggregate; plugin
  activation produced no tool/schema warnings.

### Added — M2 Web management page and bridge (2026-10-28)

- Host: same-origin POST bridge at `/session-butler/api` (`status`, `detail`,
  `trash`, `restore`, `purge`, `list-trash`) with `connection` browser-trust
  admission, 64 KiB body limit, and the `{ok, value|error}` envelope; domain
  failures stay HTTP 200 so the page renders stable codes.
- Client: keyed `main` panel + `sidebar.panellist` entry, session list with
  title/path/id filter, workspace/archived/subagent filters, trash tab, delete
  confirmation with cascade count, purge confirmation by exact id, zh/en locale
  dictionaries, error-code rendering; session store refresh after mutations.
- Late binding: `webServer`/`connection` mounted through optional
  `ctx.inject`, `sessions`/`agents`/`workspaceRegistry` resolved lazily so the
  plugin also activates without the Web app and `workspaceAvailable` reflects
  the live composition.
- Client build entry switched to `src/client/index.tsx`; bundle is 35 KB.
- Tests: 11 new cases (bridge protocol/auth/envelope + client registration/
  disposal/SSR render); suite now 35.
- Verified in a temporary Web profile: module graph lists the bundle, bundle is
  served (35 KB), bridge rejects unauthenticated requests (401) and returns
  real session detail/domain errors; temp profile removed afterwards.

### Added — M1 trash core (Host-side delete, 2026-10-27)

- `SessionButlerService` (exposed as `ctx.sessionButler`): trash-first delete with
  restore and confirm-gated permanent purge, subagent cascade (`origin ===
  'subagent'` only), running-session stop via `archiveSession({stopActivity:true})`,
  cross-process write-lease probe, migration-required refusal, symlink/path safety,
  and deterministic preflight-before-move with rollback.
- Trash storage mirrors the sessions tree with atomic sidecar metadata; retention
  (default 30 days) only marks entries expired, never auto-purges.
- `/session-butler list|trash|restore|purge` human command.
- Stable `ButlerError` codes in `src/shared/errors.ts`.
- Tests: 12 new `node:test` cases (trash/restore/purge gates/cascade/running/locked/
  migration/conflict/retention/current-session/orphans/command surface); suite now 23.
- Decisions Q1–Q6 and D-013 resolved as recommended (2026-10-27).

### Added — foundation (package scaffolding, no user-facing feature yet)

- Publishable DSH plugin package `dsh-session-butler` (display name Threadloom):
  npm manifest with `dsh.bundle.patch` + `dsh.client`, top-level `engines.dsh: >=0.2.1-rc.2 <0.3.0-0`
  (lowered from rc.3 after auditing every MVP-used Host/Client API against the rc.2 release),
  locale metadata (en/zh), icon, MIT license and a `.npmignore`-free `files` closure.
- Build pipeline: Host half compiled as ESM to `lib/` with declarations, Client half
  bundled as a DSH classic-script module factory at `lib/client.js`.
- Verification pipeline: `typecheck`, `build`, `node --test` artifact smoke tests, and
  `scripts/validate-package.mjs` (manifest contract + `npm pack --dry-run` closure).
- Research v2: `research/dsh-session-management-v2.md` — capability × surface matrix (agent tool / human command / Web Remote / Client UI / Host Service / CLI / storage+HTTP),
  published-rc-vs-checkout version scoping, third-party plugin availability, and a corrections log for the first-pass research.
- Independent adversarial verification of v2: `research/v2-verification.md` (15 claims checked; 1 capability-surface error and 1 over-strong claim found and corrected).
- Design and recon documentation under `docs/`:
  - `dsh-host-apis.md` — verified Host API surface (sessionQuery, persistence, title,
    workspace, subagents, commands, tools) and the delete gap.
  - `dsh-web-ui.md` — verified Web Client extension surface (slots, hooks, remotes,
    custom Host bridge, bundle contract).
  - `dsh-packaging-contract.md` — npm packaging contract, validation flow and pitfalls.
  - `architecture.md` — target architecture for the MVP.
  - `decisions.md` — resolved and open product/technical decisions.
  - `publishing.md` — release runbook.

## [0.1.0] - planned

First functional release: unified session management page (list/search/filter/detail),
trash-first delete with subagent cascade, running-session protection, and a
`/threadloom` command. Not published until the MVP acceptance checklist in
`docs/decisions.md` is met.
