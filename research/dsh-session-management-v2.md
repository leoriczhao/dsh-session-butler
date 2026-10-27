# DSH 会话管理能力面调研 v2（2026-10-27）

> 取代第一版：`docs/dsh-host-apis.md`、`docs/dsh-web-ui.md`（保留作源码索引，但结论以本文为准；打包契约 `docs/dsh-packaging-contract.md` 独立且仍有效）。
>
> 本文回答一个问题：**对于「会话管理插件」需要的每个能力，DSH 分别在 agent tool / 人类命令 / Web Remote / Client UI / Host Service / CLI / 存储与 HTTP 这 7 个表面上提供了什么，第三方 npm 插件能用什么、必须自建什么。**
>
> **独立复核**：`research/v2-verification.md`（fresh-context verifier，15 条 claim：13 CONFIRMED / 1 WRONG / 1 NEEDS-NUANCE；本文已按复核结果修正，并在 §8.2 记录 v2 自身的错误）。
>
> 第一版失败的两个根因（本文全程规避）：
> 1. **表面混淆**：把「GUI 有 fork 按钮」当成「fork 是可用能力」，没有区分模型可调用的 **tool** 面 → 用户问「从一个会话新建会话的工具在哪里」时无法回答。
> 2. **版本口径混淆**：把当前 checkout HEAD（`dsh-v0.2.1-rc.3-1533-g22ddee3792`，比 rc.3 发布标签晚 1533 个提交）的行为当成 `0.2.1-rc.3` 发布版事实 → 至少 2 处结论对发布版不成立（见 §8）。

---

## 0. TL;DR

1. **「从一个会话新建会话」在 agent tool 面确实不存在。** DSH 没有任何 `session_create` / `session_fork` / `new_session` 工具。最接近的 `subagent_fork` 是**带父会话已完成轮次 seed 的子代理委派**（结果回传父会话），不是用户可见、可切换的平级会话。
2. **该能力在 Remote/UI 面存在，且 GUI 有 3 个入口**：`session.fork`（Web Remote，冷会话可 fork、`atSeq` 截断）+ 侧栏会话行「…」菜单「分叉会话」+ 全局快捷键；**会话页每条已完成轮末尾还有「在新对话中分支」按钮，按该轮 `atSeq` 分叉（可选择分叉点）**；Host 面还有 `ctx.sessions.fork`（仅 live）。
3. **唯一真正缺失的产品能力是删除**（tool / command / Remote / Host API / HTTP / CLI 全无，已发布版与 HEAD 一致）；「从会话新建会话」只缺 **agent tool 面**（GUI 入口齐全）。
4. **第三方 npm 插件能新增的只有：Host 服务/工具/人类命令/Client slot/Host HTTP 路由。** **不能**新增 `ctx.remote.*` 命名空间（构建期 Typert codegen + 固定的 `api-remotes` 静态装配）。
5. **版本差异必须按「已发布 rc 通道」vs「开发 HEAD」区分**（不是 rc.3 vs HEAD）：已发布的 **rc.2 / rc.3 / rc.4 的 fork 都写 `parentSession`**；HEAD（2026-10-23 `b096659` 之后）才改为不带血缘。`/api/session.markdown` 也是 HEAD 新增（已发布 rc.3/rc.4 都没有）。另外 **npm dist-tags：latest=rc.2、next=rc.4**，rc.3 不是当前发布指针。
6. **`engines.dsh` 下限已定为 `>=0.2.1-rc.2 <0.3.0-0`**：M1–M3 实际用到的 Host/Client API 全部存在于 rc.2 发布包（§5.4 审计），因此不再用 rc.3 把 npm `latest` 用户排除在外。

---

## 1. 调研方法与版本基线

### 1.1 两条基线

| 基线 | 标识 | 用途 | 怎么验证 |
|---|---|---|---|
| **REL = 已发布 rc 通道** | npm `@deepseek-ai/*@0.2.1-rc.{2,3,4}` tarball。**dist-tags 实测（2026-10-27）：latest=rc.2、next=rc.4**；rc.3 不是发布指针 | 插件用户实际安装的 DSH；兼容声明据此 | `npm pack <pkg>@0.2.1-rc.x` 后直接读产物；关键差异点对 rc.2/rc.3/rc.4 抽查 |
| **HEAD = 运行中的开发 checkout** | `git describe = dsh-v0.2.1-rc.3-1533-g22ddee3792`；进程 `node --import tsx/esm apps/cli/src/bin.ts web --no-open`（cwd=checkout） | 当前 GUI 行为、live inspect | 进程表 + `git describe` + live `cordis_inspect_query` |

**注意**：三者 `package.json.version` 都标 `0.2.1-rc.3`（HEAD 未 bump），但代码不同；**「rc.3」既不是 HEAD、也不是 npm 的 latest**。本文所有版本敏感事实都标 `REL` / `HEAD`，不再写裸「rc.3」。

**表面代号**（与版本代号区分）：T=Agent tool、C=人类命令、RM=Web Remote、UI=Client UI、HS=Host Service、X=CLI、S=存储/HTTP。

### 1.2 证据等级

- **A（产物/可执行实证）**：npm 发布包产物、live inspect、实际命令输出。
- **B（源码 + 行号）**：checkout 源码；仅对 H 成立，需对照 R。
- **C（官方文档/注释）**：如 `docs/tool-catalog.md`、bundle 注释。
- **U（未知）**：没有验证路径时标 U，不写成结论。

### 1.3 七个表面

| 代号 | 表面 | 谁消费 |
|---|---|---|
| T | Agent tool（`ctx.tools`，模型可调用） | 模型 |
| C | 人类命令（`ctx.commands`，composer `/xxx`） | 用户 |
| RM | Web Remote（`ctx.remote.*`，浏览器→Host） | Client 插件/页面 |
| UI | Client UI（slot/组件） | 用户 |
| HS | Host Service（`ctx.*`，进程内） | Host 插件 |
| X | CLI（`dsh ...`） | 用户/脚本 |
| S | 存储与 HTTP 路由（磁盘布局、`/api/*`） | 兜底 |

---

## 2. 运行时事实快照（本机 web profile）

来源：`pnpm dsh --profile web --dump-config`、live `cordis_inspect_query`、`~/.dsh/profiles/web/package.json`、`~/.dsh/sessions/**`。

### 2.1 组合与装载

profile bundles（9 个）：`@deepseek-ai/dsh-base`、`@deepseek-ai/dsh-web-app`、`@deepseek-ai/dsh-experimental-plugin-market-bundle`、`@deepseek-ai/dsh-subagent-codex`、`dsh-opencode-session`、`@deepseek-ai/dsh-experimental-agent-team-profile`、`dshmarket`、`dsh-claude-style`、`dsh-intelligent-ui` + 用户 patch。

与本文相关的 Host 行（composed config 行号来自本次 dump）：

| 行 | 状态 | 说明 |
|---|---|---|
| `session-query-sqlite` | 挂载，`path: ':memory:'`, **`openAt: never`** | 它同时提供 `ctx.sessionQuery`（composed config 里没有单独的 `session-query` 行）；内容全文检索默认关闭，web-app patch 注释明确「opt-in」 |
| `session-log-download`（包 `@deepseek-ai/dsh-session-log-export`） | 挂载 | `/export` 命令（**ZIP 下载**，不是 Markdown）+ `/api/session.export`；行 id 是 `session-log-download`，别按包名找 |
| `workspace` / `workspace-controller` / `workspace-files` | 挂载（web-app 层） | pin/archive/workspace 能力可用；headless/acp **没有** |
| `session-query-sqlite` 提供 `ctx.sessionQuery` | base/web-app 挂载 | 精确读/列表/血缘可用 |
| `session-title`、`session-projection-cache` | 挂载 | rename、列表投影 hints |
| `tool-session-query` / `session-search` bundle | **未挂载** | 5 个只读会话工具在当前 profile 不可用 |
| `tool-subagent`（spawn） + `tool-subagent`（`toolName: subagent_fork`） | 挂载（preset 的 delegation group） | `subagent` / `subagent_fork` 工具可用 |

### 2.2 当前会话的 tool 面实测

`cordis_inspect_query(Tool.listTools)` 返回的本会话工具里 **没有任何 `session_*` 工具**，也没有 `create_session` / `fork_session` / `delete_session`。会话相关工具仅：

- `subagent`、`subagent_fork`、`subagent_codex`（子代理）
- `spawn_teammate` / `team_task_*` / `wait_agent`（Agent Teams；当前 profile 挂了 `@deepseek-ai/dsh-experimental-agent-team-profile`，因此本会话可见）
- `list_agents` / `send_message` / `interrupt_agent`（**本 profile 里是 Agent Teams 版本**：`@deepseek-ai/dsh-experimental-agent-team-profile` 顶层禁用了 subagent-control 的同名工具；`list_agents` 列的是 team members，不是「本父会话的委派子代理」。子代理控制面在当前 profile 实际不可用）

### 2.3 live Client slot 树

来源：Lead 侧 `cordis_inspect_query(platform=client, provider=Slots, listSubTree)` 成功一次；独立复核者（research-verifier）环境两次 10s 超时，另用 HEAD 源码 + `lib/` 构建产物交叉确认同一组槽位（见 `research/v2-verification.md`）。

| Slot | 类型 | 现状/用途 |
|---|---|---|
| `main` | **keyed** | 中栏整页；`already taken: conversation`。第三方插件可用自己的 key 注册管理页（dshmarket 生产例证） |
| `sidebar.panellist` | list | 侧栏固定入口行（插件页/市场页用） |
| `sidebar.workspaces.session.menu.item` | list | 会话行「…」菜单项；官方已注册 pin/rename/fork/archive/session-id |
| `sidebar.workspaces.session.row.action` | list | 会话行 hover 快捷按钮 |
| `sidebar.session.row.leading` / `.trailing` / `.hover` | list | 行装饰/hover 卡扩展位 |
| `settings.section` / `settings.general.item` / `settings.plugins.tab` | list | 设置页扩展 |
| `shell.overlay` | list | 全局浮层（确认框等） |
| `conversation.composer.dock` / `conversation.chat.*` | 多种 | 会话内 UI 扩展 |
| `workspace.toast` | **keyed** | 已占用 key 列表是本文件里的 `ToastKind`（archive/fork/pin 提示） |

会话数据在 Client 侧的标准读法：`useSessions` / `useWorkspaces` / `useSessionAccess` 等 root standard hooks + `ctx.sessions`/`ctx.workspaces` 客户端服务；写操作走 `ctx.remote.session.*` / `ctx.remote.workspace.*`（见 §3/§4）。

---

## 3. 核心矩阵：能力 × 表面

图例：✅ 存在且第三方可用 · ⚠️ 存在但有条件/仅官方内部 · ❌ 不存在 · — 不适用。版本列 `REL` = 已发布 rc 通道（rc.2/rc.3/rc.4），`HEAD` = 开发 checkout；`REL=HEAD` 表示抽查一致。

| # | 能力 | T 工具 | C 命令 | RM Remote | UI 入口 | HS Host Service | X CLI | S 存储/HTTP | 版本 | 第三方插件可用性 |
|---|---|---|---|---|---|---|---|---|---|---|
| 1 | 列表（可见会话） | ❌ | ❌ | ✅ `session/list`（无分页游标，返回全部可见；标题在 projections hints） | ✅ 侧栏分组列表 | ✅ `sessionQuery.listSessions/filterSessions` | ❌ | S：`~/.dsh/sessions/<project>/<session>/` | REL=HEAD | ✅ 全可用；Client 页面也可用 hooks/Remote |
| 2 | 标题/workspace 名搜索 | ❌ | ❌ | ❌（`session/search` 是内容检索，见行 3） | ✅ Client 本地按 title/workspace 过滤（`toLowerCase().includes`，已发布版与 HEAD 都有） | ✅ `filterSessions`（cwd 等元数据） | ❌ | — | REL=HEAD | ✅ 标题搜索可用（Client 侧）；Host 侧无标题过滤 API |
| 3 | 内容全文检索 | ❌ | ❌ | ⚠️ `session/search`（默认 `SESSION_QUERY_SEARCH_DISABLED`） | ⚠️ 侧栏搜索框调用该 Remote；失败则 error 态 | ⚠️ `sessionQuery.searchSessions/searchEvents`（需后端） | ❌ | — | REL=HEAD | ✅ 需在 profile 开启 `session-query-sqlite` `openAt: first-search`；插件可探测降级 |
| 4 | 详情（header/大小/轮数/token/preset/模型/血缘） | ❌（`subagent`/team 工具只给子代理） | ❌ | ✅ `session/projections`、`session/page`、`session/follow`；**无 trace/detail 专用 Remote**（血缘只能从 `session/list` 的 `parentSessionId`/`origin` + 投影组合，或由插件 Host 侧提供） | ✅ 会话页/行 hover（官方 UI 已有详情展示） | ✅ `sessionQuery.readSession/readSurface/readTitleSnapshots/traceSession`、`sessionPersistence.stat`、`sessionProjectionCache` | ❌ | S：header 行 + 投影缓存 | REL=HEAD | ✅ Host 侧组装 detail；Client 侧读 projections；第三方若要独立详情需自建桥/工具 |
| 5 | 改名 | ❌ | ❌ | ✅ `session/rename`（冷会话自动 resume） | ✅ 行菜单「重命名」/双击 | ✅ `sessionTitle.rename(session,title)`（仅 live） | ❌ | — | REL=HEAD | ✅ Remote 直接可用 |
| 6 | 置顶/取消 | ❌ | ❌ | ✅ `workspace/pinSession`、`workspace/unpinSession` | ✅ 行菜单 | ✅ `workspaceRegistry.pinSession/unpinSession`（REL：仅 web-app；HEAD：web+sdk） | ❌ | S：`~/.dsh/storages/workspace.json` | **REL≠HEAD**（workspace 挂载层） | ✅ Remote 直接可用；无 workspace 服务的组合需自建 |
| 7 | 归档/取消 | ❌ | ❌ | ✅ `workspace/archiveSession`（`stopActivity`）、`workspace/unarchiveSession` | ✅ 行菜单 + 运行中确认 | ✅ `workspaceRegistry.archiveSession(sessionId,{stopActivity})` | ❌ | S：`workspace.json` 的 `archivedSessionIds`（**文件不动**） | **REL≠HEAD**（workspace 挂载层） | ✅ Remote 直接可用；注意归档是逻辑隐藏 |
| 8 | **删除** | ❌ | ❌ | ❌ | ❌ | ❌（`SessionPersistence` 只有 create/open/flush/stat/list；`workspaceRegistry.delete` 只删 workspace 元数据） | ❌ | ❌（无删除路由；`/api/session.delete` 仅测试里的假路由） | REL=HEAD | **必须插件自建**（回收站 + 目录移动） |
| 9 | 新建空会话 | ❌ | ❌ | ✅ `session/create`（workspaceId/cwd/sessionId/agentPreset） | ✅ 侧栏「+」/hero | ✅ `ctx.agents.create` / `ctx.sessions.create` | ❌（`--resume` 是 app 参数，不是新建） | — | REL=HEAD | ✅ Remote/Client 可用；工具面必须自建 |
| 10 | **从会话新建会话（fork）** | ❌（`subagent_fork` 是委派子代理，不是平级新会话） | ❌ | ✅ `session/fork`（`atSeq`；冷会话可） | ✅ **3 个入口**：会话页已完成轮尾部「在新对话中分支」（传该轮 `atSeq`，可选择分叉轮）、侧栏行菜单「分叉会话」、全局快捷键 | ✅ `ctx.sessions.fork(source,boundary,childId?)`（仅 live；返回 `Session`，非 `SessionForkResult`） | ❌ | S：复制事件前缀生成新会话目录 | **REL≠HEAD**：REL（rc.2/rc.3/rc.4）fork 写 `parentSession`；HEAD 不写 | Remote/UI 可用；**tool 面必须插件自建** |
| 11 | 导出 | ❌ | ✅ `/export`（`session-log-export`，**ZIP 下载**） | ⚠️ 无 Remote；HTTP `/api/session.export`（ZIP） | ✅ composer `/export`；Markdown 复制是 **HEAD 独有的会话页 Header 动作** | ⚠️ ZIP：`sessionQuery.readSession` + 官方 archive 实现可参考；Markdown 格式化函数 `formatSessionMarkdown` **仅 HEAD** | ❌ | ✅ `/api/session.export`（REL/HEAD）；`/api/session.markdown`（**仅 HEAD**） | **REL≠HEAD** | ZIP 可复用；Markdown 仅 HEAD；批量导出需自建 |
| 12 | 打开/续聊 | ❌（`subagent` 可续聊子代理） | ❌ | ✅ `session/prompt`（内部 resume）、`session/follow` | ✅ 点会话行 | ✅ `ctx.agents.resume` | ⚠️ 仅 app 自有参数（如 tui 的 `--resume`），不是统一 CLI 子命令 | — | REL=HEAD | Remote 可用 |
| 13 | 停止运行中工作 | ❌ | ❌ | ✅ `session/cancel`（当前 prompt 的 cancel）；归档 `stopActivity` | ✅ 归档确认框 | ✅ `agent.cancel`、subagent drain、`workspaceRegistry.archiveSession({stopActivity})` | ❌ | — | REL=HEAD | Host 可编排；删除运行中无官方支持 |
| 14 | 子代理血缘/浏览 | ⚠️ **当前 profile 不可用**：`list_agents` 被 Agent Teams 版本占用（列 team members）；subagent-control 同名工具被 profile patch 禁用 | ❌ | ⚠️ 无专门 Remote；`session/list` 行含 `parentSessionId`/`origin:'subagent'` | ✅ 列表缩进仅对 `origin==='subagent'`（HEAD；REL 看 parent） | ✅ `subagents.listChildren/listDescendants`、`sessionQuery.traceSession` | ❌ | S：header `parentSession`/`origin` | REL≠HEAD（缩进判定） | Host 全可用；Client 需自行组合；tool 面取决于 profile |
| 15 | 跨 workspace 移动 | ❌ | ❌ | ❌ | ❌ | ❌（header 不可变；`attachSession` 要求 cwd realpath 匹配） | ❌ | — | REL=HEAD | **不可做**（除非复制/重放，语义是迁移不是移动） |

补充：
- **`session/list` 没有真正实现分页游标**（REL/HEAD 请求字段保留、实现签名 `list(_request, signal)` 未使用），返回全部可见会话（按活动时间）。v1 说「游标分页」是过度解读。
- **`SessionSummary` 不含 title**（含 `agentAvailable/formatStatus/sessionId/updatedAt/running/blank/parentSessionId/origin/cwd/projections`）；标题来自投影 hints（`sessionProjectionCache.cachedSnapshot`）或 Client 投影 store。v1 的「会话名搜索」要落到 Client 本地过滤/投影，不要以为 Remote 直接返回 title。
- **workspace 状态没有 unary list Remote**；只能 `workspace/follow` 流：首帧 `baseline`（`items` + `archivedSessionIds` + `pinnedSessionIds`），随后 `replace/upsert/...` 增量。

---

## 4. 逐表面详解（第三方插件能做什么）

### 4.1 T｜Agent tool 面

**现有 shipped 工具里与会话相关的全部**（`docs/tool-catalog.md` 是生成物，覆盖所有 shipped `tool-*` 包；REL/HEAD 差异处已注）：

| 工具 | 包 | 语义 | 是否「会话→新会话」 |
|---|---|---|---|
| `session_search` / `session_trace` / `session_event_search` / `session_event_trace` / `session_event_read` | `@deepseek-ai/dsh-tool-session-query`（**opt-in**） | 只读检索/追踪 | ❌ |
| `subagent` | `@deepseek-ai/dsh-tool-subagent`（provider spawn） | 委派干净子代理 | ❌ |
| `subagent_fork` | 同上（第二实例，provider `fork`，`subagent-fork-in-process`） | 委派子代理，seed=父会话**已完成轮次**（不含进行中轮） | ⚠️ 机制接近，但结果回传父会话，不是平级/可切换会话 |
| `subagent_codex` | 同族外部后端 | 外部子代理 | ❌ |
| `spawn_teammate` / team tasks | `@deepseek-ai/dsh-experimental-tool-agent-team` | Agent Teams 成员会话 | ❌ |
| `workflow` / `ralph` | `@deepseek-ai/dsh-tool-workflow` / `dsh-tool-ralph` | 子代理编排 | ❌ |
| `create_goal` / `schedule_create` | 各自包 | 会话内状态，不是会话 | ❌ |

**缺口**：没有 `session_create` / `session_fork` / `delete_session` / `session_archive` 等会话生命周期工具。

**第三方注册工具契约**（插件 row 内）：

```ts
import { defineTool } from '@deepseek-ai/dsh-tools'
export const inject = ['tools']
export function apply(ctx: Context) {
  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'session_butler_fork',
    description: 'Fork the calling conversation into a new top-level session.',
    // parameters = ParameterSchemaSpec（JSON-Schema 风格，不是 schemastery z.object）
    parameters: {
      at_seq: { type: 'integer', description: 'Inclusive event seq to cut at; omit for the latest completed turn.' },
    },
    // output 必填：schema + render
    output: { schema: { type: 'object', properties: { sessionId: { type: 'string' } }, required: ['sessionId'] },
              render: value => value },
    async execute(args, execCtx) { /* execCtx.agent.session 是调用方会话 */ },
  })), 'session-butler: tools')
}
```

证据：`packages/core/tools/src/schema.ts:484-516`（`defineTool` 契约）、`packages/experimental/tool-session-query/src/index.ts:65-120`（真实调用：`parameters: {...}`、`output: TEXT_OUTPUT`、`execute(args, exec)`、`presentCall`）。工具的作用域是调用方 Agent 上下文；写操作默认不注册（我们的 D-003 约定），创建/分叉可作为非破坏性工具（D-015）。

### 4.2 C｜人类命令面

现有 `/xxx` 命令（shipped **Host** 注册点）：`/compact`、`/feedback`、`/goal`、`/export`、`/plan`（plan-mode）、`/permission`（permission-presets）；Client 侧另有 `commandUi` 的 `file` 动作（`ui-conversation`，不是 Host 命令）。
- **没有** `/rename`、`/pin`、`/archive`、`/delete`、`/fork`、`/resume` 命令。
- 第三方插件可注册命令：`ctx.commands.register({ definitionId, name, description, handler })`（证据：`packages/compaction/command-compact/src/index.ts:95-125`；`/plan` 见 `packages/plan/plan-mode/src/index.ts:233`；`/permission` 见 `packages/interaction/permission-presets/src/index.ts:255`）。命令只在有 Agent 的 composer 里可执行（`commands/execute` 需要 `agentId`），不适合冷会话管理；作为 UI 之外的补充面可用。

### 4.3 RM｜Web Remote 面

**关键约束**：Remote 命名空间清单在 **DSH 仓库构建期**生成，并由 `api/remotes` 的 **静态 import 列表**装配：

- `@Remote` 装饰器 → `scripts/generate-typert.ts` → `typert.remote-client.d.ts` → `api-remotes/src/client/index.ts` 逐个 import（证据：`packages/api/remotes/src/client/index.ts:1-30`，`docs/api-gateway.md:102-120`）。
- **标准装配链不可扩展**：client 侧的 `ctx.remote.*` 方法表来自宿主构建产物，不是运行时发现；发布的第三方包无法把自己的命名空间加进 `api-remotes`。因此 Threadloom 的客户端页面**不应**依赖 `ctx.remote.sessionButler.*`。
- **旁路（存在但不承诺稳定）**：`ctx.remote.$mount(contribution)`（`packages/api/gateway/src/client/index.ts:214-221`）与 Host `ctx.typert.register` 是公开方法，`@deepseek-ai/dsh-typert-generator` 也已发布 npm——理论上可自产 typert 产物再挂载，但没有文档化契约、跨版本风险高，**不作为插件方案**。

已发布版实际可用命名空间（`api-remotes` 装配 + 各包 `lib/typert.remote-client.d.ts` 实证；rc.2/rc.3/rc.4 抽查为同一集合）：

- `session/*`：create、fork、list、search、rename、page、projections、follow、prompt、cancel、attachment、selectModel、modelCatalog、updateQueue、control、openWorkspacePath 等 19 个；**无 delete、无 archive/pin**。
- `workspace/*`：archiveSession、unarchiveSession、pinSession、unpinSession、create、delete（workspace 元数据）、rename、insertBefore、insertSessionBefore、follow、initializeDefault；**无 session delete**。
- `commands/*`：list、execute。
- `subagents/*`：prompt、interruptByParent（当前 profile 的 `list_agents`/`send_message`/`interrupt_agent` 工具由 Agent Teams 版本提供，不在此命名空间下）。
- 其余：pluginManager、pluginMarket、goals、schedule、llm、settings 等（与会话管理弱相关）。

**第三方替代方案**（生产例证）：
1. Host `ctx.webServer.register({ kind:'prefix', path:'/xxx/api', handler })` + 首行 `ctx.connection.requestRejection(req)`，Client 同源相对 `fetch('xxx/api/...')` —— dsh-intelligent-ui 生产实现（`src/index.mjs:31`、`src/host/service.mjs:54-58`、`src/client/host/pane.jsx:60`）。
2. exact `ctx.connection.fetch.register({path, methods, requestBody, fetch})`（仅 owner；file-upload 官方同款）。
3. `ctx.connection.rpc.handle` 通用 RPC。
4. commands 桥（需要 Agent，不适合冷会话）。

### 4.4 UI｜Client UI 面

- 页面：keyed `main` slot（key 自定，如 `session-butler`）+ `sidebar.panellist` 入口；live slot 树已确认二者均开放，dshmarket 生产实现即此方案。
- 会话行增强：`sidebar.workspaces.session.menu.item` / `.row.action`（官方已占 pin/rename/fork/archive/session-id；注意 order）。
- 数据：root standard hooks（`useSessions`/`useWorkspaces`/`useSessionAccess`/`usePanelInfo`）+ `ctx.sessions`/`ctx.workspaces`/`ctx.uiWorkspace`；写操作走官方 Remote。
- 样式：`--dsw-alias-*` token；组件请自写/复制（官方 practice 不建议第三方 require primitives 包）。
- bundle 契约（REL/HEAD 一致）：`dsh.client.platform:"web"` + `exports["./client"]` + classic script `window.__ModuleLoader__.load({ id: 包名, factory })`；**动态 client bundle 对 baseline 模块隐式 external**（11 个 platform seed，含 react/react-dom/jsx-runtime），`dsh.client.external` 只用于**精确声明的非 baseline** 请求。

### 4.5 HS｜Host Service 面（插件最可靠的能力来源）

- base 恒有：`sessionQuery`、`sessionPersistence`、`sessionTitle`、`sessionProjections`、`sessionProjectionCache`、`agents`、`sessions`、`commands`、`tools`、`storageDomain`、`fs` 等（live inspect 确认）。
- 只在 web-app（HEAD 还有 sdk-app）才挂，必须 `ctx.get` 探测：`workspaceRegistry`、`workspaceController`、webServer/connection。区别：**已发布 rc（rc.2/rc.3/rc.4）只有 web-app 挂 workspace**；HEAD 的 sdk-app patch 在 `89619e67` 后也挂了（rc 侧 sdk-app 未逐一复核，标 U）。session-log-export 由独立行提供（行 id `session-log-download`），需看组合。
- headless/acp：无 workspace 服务、无 Web 服务；插件必须降级。
- 缺口：无任何 session 删除原语（REL/HEAD 一致；`SessionPersistence` 方法清单见 §3 行 8）。

### 4.6 X｜CLI 面

`dsh` 的 launcher 入口（`apps/cli/src/args.ts:20-70`、`--help` 实测 HEAD；发布版行为同）：
1. `dsh --profile <name> [app flags]`：启动 profile；`web` 的 flags 只有 host/port/tls/public-url/no-open 等；**没有 session 管理子命令**。
2. `dsh plugin --profile <name> <pnpm args>`：插件安装/版本例外管理。
3. 诊断/管理 flags：`--dump-config`、`--dump-config-schema`、`--dump-default-config`、`--from-default-profile`（与插件开发/运维相关，但不是会话能力）。
- 会话相关只有 app 自身参数（如 tui 的 `--resume <session>`，`apps/cli/src/args.ts:97` 注释示例），且**没有** list/archive/delete/fork 子命令。
- 第三方插件**不能**新增 `dsh` CLI 子命令（CLI 在 profile boot 前解析，无插件 seam）；只能注册 slash 命令 / 工具 / 页面。

### 4.7 S｜存储与 HTTP 路由

- 磁盘：`~/.dsh/sessions/<escaped-project>/<session-dir>/session.v4.jsonl.zstd` + `session.lock`；`<session-dir>` **命名混用**：本机 66 个 `session-<uuid>` + 42 个裸 `<uuid>`（不要假设固定前缀）。header 为 JSONL 首事件（v4）：`{type:'session',version:4,id,createdAt,cwd,isSeeded,delegationDepth,agentPreset,parentSession?,origin?}`（实测本机）。归档/置顶状态在 `~/.dsh/storages/workspace.json`。
- 官方 HTTP：`/api/session.export`（ZIP，REL/HEAD）、`/api/session.markdown`（**仅 HEAD**）；其余 `/api/*` 走 connection RPC（请求经 Typert 校验），不是随便注册的 REST。
- 第三方插件可用 `ctx.webServer` 自建路由；删除/回收站只能自己动目录（`storageDomain` 记录元数据 + 同盘 rename）。

---

## 5. 专项：「从一个会话中新建会话」

### 5.1 各表面结论

| 表面 | 是否存在 | 精确定位 |
|---|---|---|
| **Agent Tool** | ❌ | 无 `session_fork`/`session_create`。`subagent_fork` 是子代理委派（见 §5.2） |
| 人类命令 | ❌ | 无 `/fork`、`/new` |
| Web Remote | ✅ | `session/fork`（`atSeq?`、`allowMigration?`；冷会话可用，内部 `sessionQuery.observeSession`→`buildForkSeed`→`agents.create`→workspace attach）；`session/create`（新建空会话） |
| Client UI | ✅ | **3 个入口**：① 会话页每条**已完成轮**末尾的 branch 图标「在新对话中分支」（`ctx.sessions.fork({atSeq: 该轮 seq})`，**可按完成轮选择分叉点**）；② 侧栏会话行 hover →「…」→「分叉会话」（固定最近完成轮）；③ 全局快捷键 desktop `Ctrl/Cmd+Alt+F`、web `Ctrl/Cmd+Shift+F`；命令面板别名 `fork session`。限制：只能从**已完成轮**分叉（不能切在轮中），没有 Codex 式 Esc Esc 编辑上一条再分叉 / `/side` |
| Host Service | ✅ | `ctx.sessions.fork(source,boundary,childId?)`（仅 live，**返回 `Session`**；与 Remote 的冷路径实现不同）；`ctx.agents.create` 可建 Agent 会话 |
| CLI | ❌ | 无 `dsh fork/session create` |
| 存储/HTTP | ⚠️ | 只能复制事件前缀写新会话（等价实现），无官方删除/复制端点 |

### 5.2 `subagent_fork` ≠ 用户语义的「新会话」

REL/HEAD 一致（`@deepseek-ai/dsh-subagent-fork-in-process` README；rc.3/HEAD 包实测）：
- seed = 父会话**最后一个完成 turn** 的前缀；当前进行中的 turn 永远不包含；父会话之后的轮次不会传给子会话；
- 子是**子代理 Agent**：结果通过 `send_message`/完成通知回父会话，不是可切换的平级会话；带 `origin:'subagent'` 血缘；
- 选择 fork provider 是「这个子任务要接着本对话做」的委派语义，不是「另开一个会话」。

### 5.3 版本差异（重要）

| 事实 | REL = 已发布 rc 通道（rc.2/rc.3/rc.4） | HEAD = 开发 checkout |
|---|---|---|
| `session/fork` 子会话的 `parentSession` | **写入** = 源 session id（**rc.2、rc.3、rc.4 的 session-controller 包均为 `parentSession: source.header.id`**；核心 `Sessions.fork` 也写） | **不写**（2026-10-23 `b096659 fix(session): make ordinary forks independent of source lineage`） |
| Client 列表缩进判定 | 任何有 `parentSessionId` 的行按血缘缩进 | 仅 `origin === 'subagent'` 的行缩进；历史普通 fork 即使带 parent id 也不缩进 |
| `/api/session.markdown` | ❌（rc.3/rc.4 包实测无；rc.2 未单独验证，标 U） | ✅ |
| 会话页 Markdown 复制 Header 动作 | ❌ | ✅ |
| `formatSessionMarkdown` 可复用 | ❌（已发布包 grep 0 命中） | ✅ |
| `workspaceRegistry` 所在层 | **仅 web-app**（rc.3 sdk-app patch 无 workspace 行；rc.2/rc.4 未逐一复核，标 U） | web-app **+ sdk-app**（`89619e67` 之后） |
| 其余矩阵行 | 一致（本次对发布包逐项核对） | — |

**对 Threadloom 的直接约束**：
1. 级联删除/归档**只能**用 `origin === 'subagent'` 判定，绝对不能按 `parentSession`（D-004 正确，但 v1 的「fork 不写 parent」理由对**所有已发布版**都不成立，需修正）。
2. **版本故事不是「rc.3 内两种行为」**：今天已发布的 rc.2/rc.3/rc.4 全部是「fork 带 parent」；HEAD 才是新行为。插件应运行时探测（`origin` 优先 + 对 parent 做防御），不要按版本号假设。
3. **兼容下限已重估并落地**：§5.4 对 M1–M3 实际用到的 API 做了 rc.2 发布包审计，全部存在 → `engines.dsh` 已改为 `>=0.2.1-rc.2 <0.3.0-0`（Q7 关闭）。
4. 不要使用 `/api/session.markdown` / `formatSessionMarkdown` 作为已发布版可用能力。

---

### 5.4 rc.2 API 审计（Threadloom M1–M3 实际用到的 API）

结论：**全部存在于 `0.2.1-rc.2` 发布包** → `engines.dsh` 下限从 rc.3 下调为 `>=0.2.1-rc.2 <0.3.0-0`（覆盖 npm `latest`）。审计对象是 `/tmp/rel2/*@0.2.1-rc.2` 的解压产物（`lib/types` d.ts 与 bundle js）。

| 表面 | API | rc.2 证据 | 用途 |
|---|---|---|---|
| HS | `sessionQuery`: observeSession / listSessions / filterSessions / readSession / readTitleSnapshots / traceSession / listEvents / filterEvents / readSurface | rc.2 `dsh-session-query` d.ts:47-150 | 列表/详情/血缘/冷会话读取 |
| HS | `sessionPersistence`: open / stat / list | rc.2 d.ts:112-159 | 跨进程写租约探测、路径与大小 |
| HS | `sessionTitle.rename(session,title)` | rc.2 d.ts:141 | 改名（可选 Host 路径） |
| HS | `workspaceRegistry`: archiveSession / unarchiveSession / pinSession / unpinSession / resolveByPath；`Workspace.attachSession` | rc.2 `dsh-workspace` d.ts:146-265、entity.d.ts:71 | 归档/置顶/回收站清状态/fork attach |
| HS | `subagents.listChildren / listDescendants` | rc.2 `dsh-subagent` d.ts:228,245 | 子代理级联 |
| HS | `agents.create / resume / get / list`；`Agent.status` / `cancel` | rc.2 `dsh-agent` d.ts:278/286/343/357、runtime-types:147/157 | fork 工具、运行中判定、停止 |
| HS | `agentDefaultModel.currentSelection` | rc.2 `dsh-agent-default-model` d.ts:42 | fork 工具的模型选择（对齐 Remote 实现） |
| HS | `sessions.get / list / fork` | rc.2 `dsh-session` d.ts:414-513 | live 判定、可选 fork 路径 |
| HS | `commands.register` | rc.2 `dsh-commands` d.ts:94 | `/session-butler` 命令面 |
| HS | `tools.register` + `defineTool`（`ParameterSchemaSpec`、必填 `output`） | rc.2 `dsh-tools` index.d.ts:117、schema.d.ts:178-248 | agent 工具 |
| HS | `sessionProjectionCache.cachedSnapshot` | rc.2 d.ts:94 | 列表/详情投影 |
| HS | `webServer.register`（exact/prefix） | rc.2 `dsh-host-webserver` d.ts:31-35,174 | 删除/回收站 HTTP 桥 |
| HS | `connection.requestRejection` | rc.2 `dsh-client-connection` rpc.d.ts:185 | 桥的请求鉴权 |
| HS | `storageDomain.open` | rc.2 `dsh-storage-domain` d.ts:83 | 回收站索引 |
| HS | `dshHomePath`（app-boot 提供） | rc.2 `dsh-app-boot` lib/index.js:4526 | 回收站根目录 |
| RM | `remote.session` 19 个方法（list/search/rename/fork/create/page/projections/follow/cancel…） | rc.2 `api-session-controller` remote-client.d.ts | 管理页读写 |
| RM | `remote.workspace` 11 个方法（archive/unarchive/pin/unpin/follow…） | rc.2 `api-workspace-controller` remote-client.d.ts | 归档/置顶 |
| UI | slots：`main`(keyed)、`sidebar.panellist`、`sidebar.workspaces.session.menu.item`、`.row.action`、`shell.overlay` | rc.2 `client-ui-layout` d.ts:53、`client-ui-sidebar`、`client-ui-workspace` 构建产物 | 管理页/入口/浮层 |
| UI | 行菜单 pin/rename/fork/archive/session-id；`menu.fork`=「分叉会话」 | rc.2 `client-ui-workspace` lib/client.js | 复用现有会话操作 |
| UI | 会话页每完成轮 branch/`atSeq` 分叉 | rc.2 `client-ui-chat` lib/client.js（`message.branch`） | fork 入口 |
| UI | standard hooks：`useSessions`/`usePanelInfo`(ui-layout)、`useWorkspaces`/`useSessionAccess`/`useSessionStatus`(ui-workspace) | rc.2 各 client 构建产物/类型 | 页面数据 |
| 构建 | client module 契约：`window.__ModuleLoader__`、`dsh.client`、`loaded without registering` | rc.2 `dsh-client-modules` lib | 发布契约 |
| 构建 | `PLATFORM_MODULES` 11 个且与 HEAD 完全一致 | rc.2 `dsh-client-web` platform.d.ts:7 | client bundle external 列表 |
| 构建 | `@deepseek-ai/dsh-client-locale` 包存在 | npm `@0.2.1-rc.2` 可解析 | `dsh.client.inject` |

**不需要 rc.2 提供、因而未纳入审计的能力**（当前未使用）：`/api/session.markdown`、`formatSessionMarkdown`（HEAD-only）、sdk-app 的 workspace 层（HEAD-only）、session-search 实验 bundle（opt-in）。

## 6. 对 Threadloom 的落地结论

| 需求 | 复用（不用自己写） | 必须自建 |
|---|---|---|
| 列表/过滤 | Host `sessionQuery`；Client `remote.session.list` + hooks + workspace follow | 跨 workspace 统一管理页（官方无此页） |
| 详情 | Host `sessionPersistence.stat` + 投影 + `traceSession` | detail DTO 组装 |
| 改名/置顶/归档 | `remote.session.rename`、`remote.workspace.pin/unpin/archive/unarchive` | 批量操作编排 |
| **删除/回收站** | 无 | Host service：租约探测 + 目录 move/rm + 回收站索引 + 级联 + 恢复/清除 |
| **从会话新建会话（工具）** | Remote/Host fork 逻辑可参考复用 | 注册 `session_butler_fork` 工具（当前会话、可选 atSeq、返回子 session id、attach 同 workspace） |
| 命令面 | `ctx.commands.register` | `/session-butler` 命令 |
| 页面 | `main` + `sidebar.panellist` + hooks + Remote | 管理页 UI、删除桥（Host HTTP 前缀路由） |
| 导出 | `/api/session.export` ZIP 可复用；Markdown 格式化仅 HEAD | 批量导出（可选二期）；Markdown 需按运行版本探测 |

---

## 7. 风险与未知

1. **Remote 命名空间标准链不可扩展**：删除/回收站必须走自建 HTTP 桥；桥的安全性（owner-only、限长、错误码）自己负责。旁路 `$mount`/`typert.register` 存在但无稳定承诺，不采用。
2. **版本双行为（已发布 vs HEAD）**：fork 血缘（§5.3）；插件应避免依赖单一行为，按运行时探测而非版本号。
3. **存储删除原语缺失**：`SessionPersistence` 无 delete → 目录直删必须做 kind/路径校验并允许安全失败；注意本机会话目录命名混用（`session-<uuid>` 与裸 `<uuid>`）。
4. **内容检索默认关闭**：侧栏搜索框会调 Remote 内容检索并在失败时进入 error 态；插件页面应做能力探测与降级（标题过滤兜底）。
5. **workspace 服务仅 web-app（HEAD 还有 sdk-app）**：headless 场景管理页不可用，删除/列表只能 Host 侧（命令/工具）操作。
6. **兼容下限已定**：`engines.dsh = ">=0.2.1-rc.2 <0.3.0-0"`（§5.4 审计全部命中；Q7 关闭）。未来若引入 HEAD-only API（如 markdown 导出）需重新收紧并写进 README。
7. **U（未实测/未验证）**：发布版 `session/list` 是否有服务端上限、`openAt: first-search` 的首次搜索延迟、多进程写锁的精确语义、rc.2/rc.4 的 workspace 挂载层、rc.2 的 markdown 路由——本次未实测到运行时边界，不写成结论。

---

## 8. 修正记录（v1 的具体错误）

| # | v1 说法 | 实际 | 影响 |
|---|---|---|---|
| 1 | 「DSH 已有 fork」未区分表面 | GUI/Remote/Host 有，**tool 面没有**；`subagent_fork` 是子代理委派 | 直接影响范围判断与工具规划 |
| 2 | 「fork 不写 `parentSession`」 | 对**所有已发布版**（rc.2/rc.3/rc.4）都不成立（都写）；仅 HEAD 不写 | 血缘/级联逻辑的版本正确性；插件级联必须用 `origin` |
| 3 | 「`/api/session.markdown` 已有」 | **HEAD 才有**，已发布版只有 `/api/session.export` | 兼容范围不能用 |
| 4 | 「session/list 支持游标分页」 | 请求字段保留、实现未使用；一次返回全部可见会话 | 管理页分页策略 |
| 5 | 未说明 tool-session-query 是 opt-in 且当前 profile 未挂载 | 当前 profile 的 agent 没有 `session_*` 工具 | 工具面能力评估错误 |
| 6 | Web UI 结论来自源码（client inspect 超时） | Lead 侧 live slot 树获取成功（§2.3）；复核环境再次超时，但源码+构建产物交叉一致 | 可信度 |
| 7 | 未区分「官方功能存在」与「第三方插件可用」 | 新增「第三方可用性」列；Remote 不可扩展 | 架构决策 |
| 8 | 未区分版本基线 | 本文所有版本敏感事实标注 REL/HEAD | 兼容声明与测试矩阵 |

### 8.2 v2 自身经独立复核修正的错误（2026-10-27）

| # | v2 初稿说法 | 复核结果 | 修正 |
|---|---|---|---|
| 1 | 「对话页内没有可见按钮/菜单入口；不能选分叉点」 | **WRONG**：已发布版与 HEAD 的会话页每条**已完成轮**末尾都有 branch 图标（`message.branch`=「在新对话中分支」），传 `atSeq=data.seq`，可对完成轮选分叉点（REL `client-ui-chat@0.2.1-rc.3` 包；HEAD `TurnTailNodeView.tsx` / `MessageIconActions.tsx`） | §0 #2、§3 行 10、§5.1 已改为「3 个入口，可按完成轮分叉」；剩余缺口缩为：tool 面、轮中任意截断、Esc Esc 编辑再分叉、`/side` |
| 2 | 「rc.3 发布版 = 用户实际安装；兼容范围内两种 fork 行为都会遇到」 | **版本故事错误**：npm dist-tags `latest=rc.2`、`next=rc.4`；rc.2/rc.3/rc.4 都写 `parentSession`；HEAD 才不写 | §1.1/§5.3/§7 改为「已发布 rc 通道 vs 开发 HEAD」；新增兼容下限重估（Q7） |
| 3 | 「第三方 npm 插件无法新增 Remote 命名空间」（绝对） | **NEEDS-NUANCE**：标准 `api-remotes` 链不可扩展；但 `ctx.remote.$mount` / Host `ctx.typert.register` 是公开旁路，generator 已发布 npm | §4.3/§7 改为「标准链不可扩展；旁路存在但不承诺稳定」 |
| 4 | 表面代号 R/H 同时表示「版本」和「Remote/Host」 | 同一符号两义 | 版本改 `REL`/`HEAD`；表面改 `RM`/`HS`/`UI` |
| 5 | `session-query` 行、`session-log-export` 行 id、Agent Teams 同名工具、`/export`=Markdown、`SessionForkResult`、`defineTool` 示例、`locales.ts` 路径等 | 多处措辞/事实偏差（详见 `research/v2-verification.md` §3） | 已逐条修正 |

---

## 9. 复现命令（关键证据）

```bash
# 版本基线
cd /home/leoric/code/deepseek-harness && git describe --tags --always
ps -ef | grep "apps/cli/src/bin.ts" | grep -v grep

# 运行中 profile 组合
pnpm dsh --profile web --dump-config | grep -nE "session-query-sqlite|session-log-export|workspace$|tool-session-query|tool-subagent"
pnpm dsh --help; pnpm dsh web --help

# 发布通道事实（关键：latest 是 rc.2，不是 rc.3）
npm view @deepseek-ai/dsh dist-tags --json
npm view @deepseek-ai/dsh time --json

# REL = 已发布包实证（对 rc.2/rc.3/rc.4 抽查）
mkdir -p /tmp/rel && cd /tmp/rel
npm pack @deepseek-ai/dsh-api-session-controller@0.2.1-rc.2
npm pack @deepseek-ai/dsh-api-session-controller@0.2.1-rc.3
npm pack @deepseek-ai/dsh-api-session-controller@0.2.1-rc.4
npm pack @deepseek-ai/dsh-tool-session-query@0.2.1-rc.3
npm pack @deepseek-ai/dsh-session-persistence@0.2.1-rc.3
npm pack @deepseek-ai/dsh-experimental-session-search@0.2.1-rc.3
npm pack @deepseek-ai/dsh-client-ui-chat@0.2.1-rc.3
# 然后 grep 产物：session/* remote 方法、工具名、persistence 方法、openAt、message.branch/atSeq

# live inspect
#   cordis_inspect_query platform=host provider=Service (sessionQuery/sessionPersistence/sessionTitle/workspaceRegistry/subagents)
#   cordis_inspect_query platform=host provider=Tool     (当前会话工具清单)
#   cordis_inspect_query platform=client provider=Slots  (live slot 树)

# 磁盘
find ~/.dsh/sessions -maxdepth 3 -name "session.v4.jsonl.zstd" | head
zstd -dc <session.v4.jsonl.zstd> | head -1
cat ~/.dsh/storages/workspace.json | head -c 400
```

## 10. 证据索引

- REL 产物：`/tmp/rc3/*/package/lib/**`、`/tmp/verify/*/package/lib/**`（本次实测：remote 方法、persistence API、tool 包 README、session-search bundle patch、client ui-workspace / ui-chat bundle、session-controller fork 实现、rc.2/rc.4 对照）
- H 源码：
  - `packages/api/session-controller/src/commands.ts`（fork/create/rename/search 的 Host 实现）
  - `packages/core/session/src/index.ts:1403`（`Sessions.fork`，live only）
  - `packages/session/session-persistence/src/index.ts`（无 delete）
  - `packages/workspace/workspace/src/index.ts`（archive/pin/unarchive；workspace delete 仅删元数据）
  - `packages/client/ui-workspace/src/client/{index.ts,rows/Rows.tsx,shortcuts.ts,session-actions/*}`（行菜单/快捷键/分叉文案）
  - `packages/client/ui-workspace/src/client/locales.ts`（`menu.fork` = 分叉会话；v2 初稿路径漏了 `src/client/`）
  - `packages/client/ui-chat/src/client/chat/{TurnTailNodeView.tsx,MessageIconActions.tsx}`、`packages/client/ui-chat/src/client/apply.ts`、`src/client/locale.ts`（会话页「在新对话中分支」+ `atSeq` 分叉）
  - `packages/experimental/tool-session-query/src/index.ts`（工具注册契约）
  - `packages/subagent/subagent-fork-in-process/README.md`（seed 边界/委派语义）
  - `packages/api/remotes/src/client/index.ts` + `docs/api-gateway.md`（Remote 固定装配）
  - `packages/bundle/base/cordis.patch.yml`、`packages/bundle/web-app/cordis.patch.yml`、`packages/experimental/session-search/cordis.patch.yml`（search opt-in、workspace 只在 web）
- 第三方案例：`~/.dsh/profiles/web/node_modules/{dshmarket,dsh-intelligent-ui,dsh-claude-style}/...`
- live：本会话的 `cordis_inspect_query` 结果（Tool/Service；Slots 成功一次，复核环境两次超时，另有源码+构建产物交叉验证）
- 独立复核：`research/v2-verification.md`（15 条核对 + 误导项清单 + 复核限制）
