# Changelog

All notable changes to this project are documented in this file.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added — D3.0: 与 DSH 插件管理集成 + 功能级健康快照 (2026-10-28)

- **配置表单**：配置字段全部声明为 DSH `.volatile()`，Plugins 页的插件行出现「配置」入口，`plugins.row.config` 渲染表单并写回 profile patch（单源，无第二配置存储）。新增 `liveSettleTimeoutMs`（默认 3000）与 `inlineMenuEnabled`（默认 true）。
- **插件页贡献**：`plugins.bundle.config` 显示状态区块，`plugins.detail.badge`/`plugins.detail.section` 提供健康徽标与诊断详情；宿主未声明 slot 时静默跳过（兼容 rc.2 组合）。
- **入口内联、可关**：客户端经 DSH `configForms` 读取 volatile 配置，`inlineMenuEnabled=false` 时热注销会话行 "..." 菜单的两项贡献；不注册任何侧栏常驻入口。
- **健康快照**：`/session-butler/api/status` 扩展为 `{ ok, version, host, bridge, storage, backends, counts, errors }`；`service.health()` 探测回收站/会话目录可写性、可选后端能力，并保留最近 20 条桥错误；管理页轮询同一接口。
- **测试**：配置 volatile 句柄、插件页 slot 注册/清理、健康快照与桥 status 断言；`pnpm run verify` 59 tests + 57 package checks 全绿。

### Fixed — D3.0 real-browser verification (2026-10-28)

- **行配置页崩溃**：`plugins.row.config` 的 owner 传入的是 `{ state, mutate }` 页面表单，而不是 `ConfigForm` 实例；首版调用 `form.getSnapshot()` 触发 `TypeError`，配置页只渲染出诊断区块。组件改为读 `form.state`、调用 `form.mutate(ops, snapshot.revision)`（隔离 0.2.2 + Playwright 发现）。
- **配置不热生效**：volatile 配置值在 Host service 构造时被取成纯值，保存后 `/status` 仍返回旧值。service 的 4 个配置项（retention/cascade/permanentDelete/settle）改为**使用点读取**，由 `index.ts` 传 `() => readConfigValue(config.x)`；保存后无需重启即生效。
- **真实浏览器验收**（隔离 `DSH_HOME` + Playwright Chromium，DSH 0.2.2-alpha.2）：bundle 页健康徽标/状态区块显示 **Healthy**；行配置页出现 5 个字段，保存 `trashRetentionDays: 45 → 60` 写回 profile `cordis.patch.yml` 且 `/session-butler/api/status` 立即返回 60；`inlineMenuEnabled` 取消后会话行菜单项即时消失、恢复后重新出现；主管理页无 console/page error。证据：`docs/evidence/plugin-health-bundle.png`、`plugin-row-config.png`、`inline-session-menu.png`。

### Changed — Codex 式入口修订（D-023，2026-10-29）

- **删除侧栏「会话管理」按钮**：ChatGPT/Codex 没有常驻会话管理按钮；`sidebar.panellist` 注册已移除。
- **会话行 "..." 菜单内联**：新增 `sidebar.workspaces.session.menu.item` 两个贡献——`会话详情…`（order 460）与 `会话库…`（order 470），带分隔线、复制宿主菜单 cell 样式（`ui-primitives` 的 Menu.module.css 视觉契约）。
- **面板打开方式**：`inject: ['layout']` + `ctx.layout.selectPanel('session-butler')`；菜单项与 Plugins 页 bundle 区块的「打开会话库」按钮共用 `src/client/navigation.ts` 的一次性请求总线，面板消费后按需切 Tab/打开详情。
- **配置字段**：`panelEntryEnabled` → `inlineMenuEnabled`（默认 true）。
- **真实浏览器验收**：侧栏无「会话管理」；菜单出现 `会话详情…`/`会话库…`；点击详情打开面板并弹出详情；从菜单与插件页均可打开 Library；`inlineMenuEnabled` 实时增删菜单项；无 console/page error。证据：`docs/evidence/inline-session-menu.png`、`inline-detail-panel.png`。

### Fixed — 配置入口不可见（D-024，2026-10-29）

- **bundle 页标题旁新增「配置」按钮**（`plugins.detail.actions`，id `threadloom-configure`，order 100）：点击弹出 **Threadloom 设置** 对话框，5 个字段改完即保存并显示「已保存。」；不再需要先滚到 bundle 页底部找行入口。
- **共用同一份表单**：客户端 apply 时从 `ctx.get('configForms').get(rowId)` 取一次表单，对话框与 `plugins.row.config` 行配置页渲染同一 form，仍单源写 profile patch；`plugins.bundle.config` 只保留健康/统计与「打开会话库」，不内联重复表单。
- **旧 Host 兼容**：读取时 `inlineMenuEnabled` 缺失则回退旧字段 `panelEntryEnabled`，保存自动映射旧路径；重启后恢复新字段。
- **真实浏览器验收**（隔离 `DSH_HOME` + Playwright）：bundle 页标题旁「配置」按钮可见；对话框 5 字段；保存 `trashRetentionDays` → 40 写回 `cordis.patch.yml`；关闭对话框；无 console/page error。证据：`docs/evidence/plugin-configure-entry.png`、`plugin-configure-dialog.png`。

### Fixed — 创建类工具在 Web 组合中漏注册（D-025，2026-10-29）

- **现象**：真实 Web 会话中只有 `session_butler_list` / `session_butler_detail`；`session_butler_new` / `session_butler_fork` 为 `undefined`。原因是创建能力在 `inject(['tools'])` 时一次性探测，而 Web 的 `sessionController` 晚于 bundle 行挂载。
- **修复**：区分 `registerReadTools` 与 `registerCreationTools`；读工具在 `['tools']` 注入时注册，创建工具在 `['tools','sessionController']` 两者都可用时注册；控制器缺失的组合仍不暴露 new/fork。
- **测试**：`tests/m1-apply.test.mjs` 新增晚绑定用例（控制器延迟出现后注册 new/fork）；59 → 60 tests 全绿。
- **注意**：修复需要重启 DSH 进程才会出现在现有 Web 会话中。

### Fixed — 工具创建的会话未归属 Workspace（D-027，2026-10-29）

- **现象**：重启加载 D-025 后 `session_butler_new` / `session_butler_fork` 已可见；调用 `session_butler_new` 返回 id，但新会话落在侧栏「未分组」，从会话库打开后只显示「选择一个工作区开始」，没有 composer，无法续聊。
- **根因**：Host `sessionController.create` 只有请求带 `workspaceId` 时才会 `workspace.attachSession()`；工具只传 cwd/preset，child 不属于任何 Workspace；DSH 又会隐藏非当前的空白会话。
- **修复**：`session_butler_new` 优先解析调用方 Workspace（`workspaceRegistry.list()` 按 sessionIds，再按 cwd）并传 `workspaceId`；无 registry 的组合回退 `cwd`。`ButlerSessionCreation.resolveWorkspace`、`WorkspaceRegistryPort.list` 均为可选扩展，客户端无改动。
- **真实浏览器验收**（临时 3120 实例，加载新 Host 代码）：agent 调用工具创建 `session-d00fe9e4…` → 「新会话」复用该 blank → 发 hello 收到回复；侧栏归属 `dsh-session-butler` 分组。证据：`docs/evidence/tool-created-hello.png`。
- **live 复验（2026-10-29 17:28 重启后，PID 199786）**：`session_butler_new` → `session-284e19d0…`、`session_butler_fork` → `session-e3487de9…` 均写入 `workspace.json` 的 `dsh-session-butler.sessionIds`；侧栏「新会话」即该 blank（点按复用、composer 可用），fork 行可直接打开并带 17 轮历史续聊。证据：`docs/evidence/live-tool-create-reuse.png`、`live-tool-fork-open.png`。
- **测试**：`tests/m3-tools.test.mjs` + `tests/m1-apply.test.mjs` 新增 workspaceId 用例；60 → 62 tests 全绿。
- **注意**：已在 live 重启后复验，无需再次重启。

### Docs

- `docs/d3-console-design.md` D3 设计定稿 + v0.2 入口修订；`docs/decisions.md` D-021/D-022 accepted、D-023（用户纠正入口形态）、D-024（配置入口可见性）、D-025（创建工具晚绑定）、D-027（工具创建会话归属 Workspace）新增；`docs/usage.md` / `README` 更新入口、配置与工具说明。

## [0.1.2] - 2026-10-28

### Added — agent tools for "conversation → new conversation" (D-015)

- `session_butler_new`: create an empty Session beside the caller, inheriting
  its header cwd and agent preset. The caller's own session identity is the only
  input; no arbitrary cwd, workspace id, or target session id is accepted.
- `session_butler_fork`: branch the caller's current conversation into a new
  independent Session (default: latest completed turn; optional exact inclusive
  `atSeq`). Uses the Host `sessionController.fork` path — the same semantics
  as the Web Remote `session.fork` — so the child appears in the Web sidebar
  and Threadloom list and can be opened and continued.
- Both tools are advertised only when the composition provides
  `sessionController`; deletion and other destructive writes stay off the tool
  face (D-003). This closes the tool-face gap D-015 had deferred past 0.1.0/0.1.1.
- Tests: registration/execute/render coverage for both tools, including
  caller-session rejection and `atSeq` validation (suite 57 → 59).

## [0.1.1] - 2026-10-28

### Fixed — native function calling rejected the whole request (2026-10-28)

- The read-only tools registered the `defineTool` authoring property map as
  `ToolDefinition.parameters`. DSH sends `parameters` to the provider verbatim,
  so native function calling emitted an argument schema without an object root
  and the provider rejected the **entire** request:
  `Invalid schema for function 'session_butler_detail': schema must be a JSON
  Schema of 'type: "object"', got 'type: null'`. The package activated and PTC
  mode kept working, which masked the bug until a real Web-profile install.
- New `src/host/schema.ts` compiles the per-property DSL (`required: true`)
  into `{type:'object', properties, required?}` exactly like `defineTool`; both
  tools register the compiled schema. The compiler fails loudly on DSL misuse
  (object without `additionalProperties`, `required` inside `items`, `enum` on
  an array, …) instead of emitting a broken wire schema.
- Regression tests: new `tests/m3-schema.test.mjs` (4 cases: object root,
  required promotion, nested array/object/enum compilation, misuse rejection)
  and the tool-registration test now asserts the compiled shape (suite 52 → 56).
- Verified against the real DSH `0.2.2-alpha.2` validators: both parameter
  schemas pass `assertSupportedJsonSchema`, and PTC `jsonSchemaToTs` now emits
  concrete typed arguments instead of `unknown`.
- Docs: `architecture.md`, `decisions.md` (D-018 regression note) and the
  packaging contract's pitfall list now record that third-party tools must
  compile `parameters` themselves.

## [0.1.0] - 2026-10-28

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

### Fixed — real-browser activation and page readability (2026-10-28)

- Client activation bug found by the first real Web boot: the M2 client nested
  the `sidebar.panellist` registration inside `ctx.slots.inject('main', …)`.
  `main` is declared by the layout before the sidebar plugin declares
  `sidebar.panellist`, so `slots.register` threw
  `slot "sidebar.panellist" is not declared`; the loader showed
  `dsh-session-butler: failed` and the page never appeared. The two slots are
  now registered through independent `slots.inject` calls, with dictionaries
  registered first and every registration in one effect whose disposers are
  unwound in reverse on both failure and teardown (a failed activation can no
  longer leak a locale namespace into a retry).
- Readability and layout fixes from the browser pass: body/meta labels use
  `--dsw-alias-label-secondary` / `-tertiary` instead of the dimmed token, the
  session total moved from the filter row (where it clipped at 1440 px) into
  the batch bar, and an empty lineage section is no longer rendered.
- Browser acceptance (isolated `DSH_HOME`, one seeded completed session): no
  console/page errors; list/filter/count render; detail dialog renders figures;
  row trash confirmation and batch trash confirmation render; isolated write
  path completes trash → `0` sessions / `1` trash entry → restore → `1` session,
  with permanent deletion shown as disabled. Screenshots under
  `docs/evidence/`.

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

### Release — npm and GitHub (2026-10-28)

- Published `dsh-session-butler@0.1.0` to npm with `latest`; registry metadata
  verified (`dsh.bundle.patch`, `dsh.client`, `engines.dsh`, repository/homepage/
  bugs, optional peers).
- A fresh isolated `DSH_HOME` profile installed the published version with
  `dsh plugin --profile tl-reg add dsh-session-butler@0.1.0`; `--dump-config`
  contains row `session-butler`, and the Web page plus plugin detail page boot
  with no console/page errors.
- Git tag `v0.1.0` and the GitHub release point at the published source tree.
