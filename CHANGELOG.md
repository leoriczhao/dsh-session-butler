# Changelog

All notable changes to this project are documented in this file.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added — foundation (package scaffolding, no user-facing feature yet)

- Publishable DSH plugin package `dsh-session-butler` (display name Threadloom):
  npm manifest with `dsh.bundle.patch` + `dsh.client`, top-level `engines.dsh`,
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
