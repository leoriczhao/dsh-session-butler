# Threadloom 架构（基础版）

> 状态：基础工作（M0）。本文件是**已核实的 DSH 事实** + **目标架构**，不是已完成功能的描述。
> 事实来源（均已逐行核对 DSH 源码与 live Host Service 注册表，版本 `0.2.1-rc.3`）：
> [`dsh-host-apis.md`](./dsh-host-apis.md)、[`dsh-web-ui.md`](./dsh-web-ui.md)、[`dsh-packaging-contract.md`](./dsh-packaging-contract.md)。
> 产品决策见 [`decisions.md`](./decisions.md)，发布流程见 [`publishing.md`](./publishing.md)。

## 0. TL;DR

1. **不要重做 DSH 已有的能力。** 已发布 rc 通道（rc.2/rc.3/rc.4，抽查一致）与 HEAD 都提供 rename、pin/unpin、archive/unarchive、fork、export（Host Service + Web Remote + GUI 都有）。fork 的 UI 入口有 3 个：会话页已完成轮末尾「在新对话中分支」（传 `atSeq`，可选分叉轮）、侧栏行菜单「分叉会话」、全局快捷键。Threadloom 的真正价值是**统一管理面 + 删除/回收站 + 详情/血缘 + 批量操作**；fork 剩余缺口（tool 面、轮中任意截断、Esc Esc/`/side`）见 D-014/D-015。
2. **唯一必须自补的 Host 能力是「删除」**：DSH 没有官方删除 API（设计 note 明确"等真实消费者再加"）。插件侧用「回收站优先 + 跨进程写租约 + 目录移动」实现，长期向上游补 `SessionPersistence.delete()`。
3. **Web 半不能新增 `@Remote` 命名空间**（Typert 构建期生成、客户端命名空间固定）。删除/回收站走 **`ctx.webServer` 前缀路由 + 同源相对 fetch**，这是已发布第三方插件的生产级做法。
4. **UI 入口 = keyed `main` 面板 + `sidebar.panellist` 行**，与官方 Plugins 页同构；页面通过宿主注入的 standard hooks 拿列表/workspace/权限数据，复用 `ctx.remote.session.*` / `ctx.remote.workspace.*` 完成已有操作。
5. **包形态 = 普通 npm 包**：`dsh.bundle.patch` + Host ESM 入口 + `dsh.client` 浏览器半 + 顶层 `engines.dsh`；浏览器半是 `window.__ModuleLoader__.load({id, factory})` 经典脚本，React 等 11 个 platform seed 必须 external。

## 1. 事实基线（0.2.1-rc.3，已核实）

### 1.1 能力矩阵（摘要）

| 能力 | 现状 | Threadloom 的处理 |
|---|---|---|
| 列表 / 搜索 | Host `sessionQuery.listSessions/filterSessions`；Web `session.list` / GUI 侧栏；内容全文搜索默认关闭（`openAt: never`） | 管理页复用 `remote.session.list` + 客户端 standard hooks；内容检索作为可选能力（profile 开启 sqlite FTS 时启用，见 D-007） |
| 详情 | 无单一 DTO；由 header + `sessionPersistence.stat` + projection cache + `traceSession` 组合 | Host 侧组装 detail DTO |
| 改名 | ✅ `sessionTitle.rename`（live）；Web `session.rename`（自动 resume 冷会话） | 复用 Remote |
| 置顶 / 归档 | ✅ `workspaceRegistry.pin/unpin/archive/unarchive`；归档是**逻辑标记**，文件不动，`stopActivity` 可停运行中工作 | 复用 Remote；不移动文件、不重做状态机 |
| 删除 | ❌ 无任何官方 API / 命令 / 路由 / 事件 | **自建**：回收站 + 永久删除 + 子代理级联（D-003/D-004/D-005） |
| fork（分叉会话） | ✅ `session.fork`（`atSeq` 截断、冷会话可）；UI 有 3 个入口，其中**会话页每轮末尾的分支按钮可按完成轮选 `atSeq`**；**tool 面没有对应工具**。版本差异：已发布 rc（rc.2/3/4）的 fork 写 `parentSession`，HEAD 不写 | 复用 Remote；工具面缺口见 D-015；剩余交互缺口（轮中截断、Esc Esc、`/side`）见 D-014；级联只按 `origin==='subagent'`（D-004） |
| 导出 | ✅ `/export`、`/api/session.export`、`/api/session.markdown` | 二期复用 HTTP 路由/格式化函数 |
| 跨 workspace 移动 | ❌ 实际不可行（header 不可变；`attachSession` 要求 cwd realpath 匹配） | 明确非目标（D-012） |
| 内容搜索 | 🟡 需要 profile 开启 `session-query-sqlite` 索引 | 可选降级，不默认自建索引 |
| 运行中会话 | 🟡 归档支持 `stopActivity`；删除无 | 拒绝直接删除，先归档再删（D-005） |

### 1.2 工具面（agent tools）现状

DSH 的工具面（`ctx.tools` → 模型可见工具）里**没有**「从会话创建会话」的工具。逐个核实 `docs/tool-catalog.md` + 当前进程 `Tool` inspect 结果：

| 工具 | 实际语义 | 能否当「从会话新建会话」用 |
|---|---|---|
| `session_search` / `session_trace` / `session_event_*`（`@deepseek-ai/dsh-tool-session-query`，opt-in） | 只读检索/追踪 | ❌ 只读 |
| `subagent`（spawn 后端） | 委派一个干净子代理会话 | ❌ 空会话，不是从会话派生 |
| `subagent_fork`（alias，`@deepseek-ai/dsh-subagent-fork-in-process`） | 委派一个子代理会话，seed = 父会话**已完成轮次**的快照（不含当前进行中轮） | ⚠️ 机制最接近，但它是**子代理委派**：结果回传给父会话，不是用户可见/可切换的平级会话 |
| `subagent_codex` / `spawn_teammate` / `workflow` / `ralph` | 外部/团队/工作流子会话 | ❌ 都不是用户语义的「新会话」 |
| （无） | `session_create` / `session_fork` / `new_session` 这类工具**不存在** | — |

`fork` 能力存在于 **Web Remote `session.fork`**（Client 可调，自动 resume 冷会话）、**Host `ctx.sessions.fork`（仅 live）** 和 **GUI**（会话页轮末分支按钮 / 侧栏菜单 / 快捷键），但都不是 tool。结论：**工具面上「会话 → 新会话」是空白**，Threadloom 可以补，且与 `subagent_fork` 的委派语义不同（输出应是新的、可切换的平级会话 id）。

**Threadloom 的工具边界（M3 已收敛）**：

- 已实现（0.1.0）：只读 `session_butler_list`（含过滤/分页）、`session_butler_detail`；
- 二期候选（D-015 deferred）：`session_butler_fork`（默认对**当前** live 会话、最近完成轮分叉；可选 `at_seq`）、`session_butler_new`（按当前会话的 cwd/workspace/preset 新建空会话）；技术路径同 Remote（`sessionQuery.observeSession` → `buildForkSeed` → `ctx.agents.create` → `workspace.attachSession`），需要额外的当前会话/授权语义；
- 删除类写操作**不**作为工具暴露（D-003），只走管理页/命令面。

### 1.3 关键约束

- **服务可用性**：`sessionQuery`/`sessionPersistence`/`sessionTitle`/`storageDomain` 属于 base；`workspaceRegistry` 在 **R=rc.3 只有 web-app**，HEAD 的 sdk-app 也挂（`89619e67` 之后），headless/acp 没有。必须用 `ctx.get(...)` 探测可选能力。
- **归档语义**：只写 `~/.dsh/storages/workspace.json` 的 `archivedSessionIds`，文件原地不动；归档会话在 Web 侧不可打开，子代理后代被 `agent/pre-step` 门禁冻结；**不级联标记**子会话。
- **血缘**：`header.parentSession` + `header.origin === 'subagent'`。**fork 的版本行为不一致**：已发布 rc 通道（rc.2/rc.3/rc.4）的 fork 都写 `parentSession`；HEAD（2026-10-23 提交 `b096659` 起）改为不写。因此级联**只能**按 `origin === 'subagent'`，绝不能按 `parentSession`（否则在已发布版上会误伤 fork）。详见 `research/dsh-session-management-v2.md` §5.3。
- **无删除事件**：`api-session/removed` 只对 live session dispose 发出，冷会话删除没有任何客户端推送 → 管理页操作后自行刷新。
- **存储重构期**：`Session` / `SessionPersistence` 有 proposed 的整体重构。插件只走公开 Service、不解析 `session.v4.jsonl.zstd`、不 import 具体实现包；删除前用 `stat().location` 的 kind 判断（`jsonl` 才按目录删，其他形态拒绝）。
- **兼容判定**：只认顶层 `engines.dsh`；`dsh.engines.dsh` 静默失效。当前声明 `>=0.2.1-rc.2 <0.3.0-0`（M1–M3 用到的 Host/Client API 已逐项在 rc.2 发布包上审计，见 `research/dsh-session-management-v2.md` §5.4）。

## 2. 包结构

单 npm 包，双端产物（详见 [`dsh-packaging-contract.md`](./dsh-packaging-contract.md) §2/§6）：

```
dsh-session-butler/
├── package.json              # dsh.bundle.patch / dsh.client / engines.dsh / exports / files
├── cordis.patch.yml          # 插入 loader 行：id=session-butler, name=裸包名
├── icon.svg                  # 展示图标（≤256 KiB）
├── locale/{en,zh}.json       # meta.title / meta.description / meta.detail
├── README.md · CHANGELOG.md · LICENSE
├── docs/usage.md             # meta.detail 目标（随包发布）
├── src/
│   ├── index.ts              # Host 入口：name / inject / Config / apply
│   ├── config.ts             # Schemastery Config（已实现）
│   ├── shared/identity.ts    # 稳定标识：包名、行 id、panel id、API 前缀
│   ├── host/                 # M1+：service / capabilities / trash / bridge / commands / tools
│   └── client/               # M2+：apply、管理页、数据 hook、bridge 客户端
├── scripts/{build-client,validate-package,clean}.mjs
├── tests/                    # node:test 产物冒烟 + manifest 契约
└── lib/                      # 构建产物（发布，不提交）
    ├── index.js + types/**    # Host ESM + d.ts
    └── client.js (+map)       # Client classic-script 工厂
```

**构建**：Host 用 `tsc`（NodeNext ESM + declaration）→ `lib/`；Client 用 `esbuild` 打成 CJS + banner/footer 包装成 `window.__ModuleLoader__.load(...)` 单文件。选择 esbuild 而非 tsdown：依赖更少、包装头部完全可控；后续若需要动态拆包再迁移（见 D-010）。

## 3. Host 半架构（目标）

```
src/index.ts ── apply(ctx, config)
   ├── inject: ['sessionQuery','sessionPersistence','storageDomain','commands','tools']
   ├── 可选探测: ctx.get('workspaceRegistry'|'sessionTitle'|'subagents'|'agents')
   ├── ctx.provide('sessionButler')  ← Host Service（listSessions/detail/trash/restore/purge/batch）
   ├── ctx.commands.register('/session-butler')   ← 无 UI 也能用
   ├── ctx.tools.register(session_butler_list/detail 只读)  ← M3，写操作不进模型面
   └── ctx.webServer.register(prefix '/session-butler/api') + connection.requestRejection
```

### 3.1 模块划分（M1 落地时）

| 模块 | 职责 |
|---|---|
| `host/ports.ts` | 所有 Host/Client 依赖的结构化端口类型（不 import `@deepseek-ai/dsh-*`）；`ButlerHostContext` 抽象 `get/provide/effect/inject` |
| `host/locate.ts` | id 寻址、路径校验（`basename === id`、位于 sessions root 下、无 symlink 逃逸）、`locateAll` |
| `host/lineage.ts` | 子代理后代枚举：`sessionQuery.traceSession`，仅 `origin === 'subagent'`；`subagentDescendants` 过滤 fork |
| `host/trash-store.ts` | 回收站目录 `~/.dsh/session-butler/trash/<id>/` + 原子 sidecar 元数据（id、原路径、删除时间、header 快照、descendantIds） |
| `host/service.ts` | `SessionButlerService`：`listSessions` / `detail` / `trash` / `restore` / `purge` / `listTrash` / `trashMany` / `restoreMany`；删除管线也在本模块（见 §3.3） |
| `host/read-model.ts` | 只读投影：header 快照、血缘树、事件折叠（turn/step/token/tool/title），供 list/detail/工具/桥共用 |
| `host/tools.ts` | 只读 agent 工具（`session_butler_list` / `session_butler_detail`）；输出 schema + render，写操作不暴露给模型 |
| `host/bridge.ts` | HTTP 前缀路由：方法分发、JSON 限长、owner-only、稳定错误码 |
| `host/command.ts` | `/session-butler …` 命令面（list/trash/restore/purge） |
| `host/fs.ts` | 有界读写、原子 rename、JSON sidecar 工具 |
| `shared/identity.ts` | 稳定标识（已实现） |
| `shared/errors.ts` | 稳定错误码联合：`session-not-found` / `session-running` / `session-locked` / `session-unresolved-path` / `storage-unsupported` / `trash-corrupt` / `forbidden` / `invalid-request` / `internal` |

### 3.2 数据来源

- **列表**：`sessionPersistence.list()`（持久化 header）+ `sessions.list()` / `agents.list()` 补 live 行 + best-effort `readTitleSnapshots(ids)` 补标题；`workspaceRegistry.archivedSessionIds/pinnedSessionIds` 补归档/置顶。过滤（query/cwd/归档/子代理）、排序（createdAt 倒序）、分页（默认 25，上限 100）都在 Host 侧完成。
- **详情**：`sessionPersistence.stat(id)` 是唯一 header 来源（对 `migration-required` 同样可用）；`traceSession` 取祖先/后代；随后 **best-effort** `observeSession(id,{projectionMode:'none'})` 并折叠原始事件（`turn/end`、`step/end`、`user/message`、`assistant/message.usage`、`tool/call`、`tool/result`、`session/title`）得到轮数/步骤/token/活动时间/标题。
- **不去依赖 projection cache**：rc.2 release 组合与 Web 组合的 projection 键不一致，`detail` 只信 stat + 事件；事件读取失败（或迁移中）返回 `enrichment: {status:'partial', reason}` 而不是整体失败。列表/详情/工具/桥共用这套只读投影。
- **回收站**：自有 `storageDomain`；不依赖 DSH 的归档集合。
- **一致性**：列表以 `sessionQuery` 为准；删除操作完成后清 `pinned/archived` 状态由官方服务提供（`workspaceRegistry` 可选）。

### 3.3 删除管线（核心）

状态机：`active → trashed → (restored → active) | (purged)`

```
trash(id, { cascade }):
  1. resolve(id)                     # 存在性、header、location.kind
  2. 运行中检查                       # sessions/agents 存在 → 拒绝 session-running
  3. 路径校验                         # location.kind === 'jsonl'，basename === id，realpath 在 sessions root 内
  4. open(id, 'write') → close()      # 跨进程写租约探测；失败 → session-locked
  5. descendants = lineage(id) ∩ origin==='subagent'（cascade 时）
  6. rename(原目录 → trash/<id>/)     # 同盘原子移动
  7. storageDomain 记录 {id, originalPath, deletedAt, header, descendants}
  8. unarchive/unpin（若 workspaceRegistry 存在）
  9. 级联：对 descendants 逐个执行 1–8（失败则整体回滚描述，不静默吞）
restore(id): 校验 trash 记录 → rename 回原路径 → 清记录 → 返回需要恢复的 descendants
purge(id):   trash 记录存在 → rm -rf trash/<id> → 删除记录（permanentDelete=confirm 时需完整 id）
```

不可变式：**任何一步失败都保持原状或停在上一个可恢复状态**，错误码稳定、可操作。

**M1 实现备注**：

- 目录定位：`SessionLocator` 扫描 `<dshHome>/sessions/<project>/<dir>`，以 session id 为权威（目录名可能与 id 不同前缀），候选名先精确、再试 `session-` 前缀变体；能解压 v4 header 时校验 `header.id`，并拒绝 symlink 逃逸/歧义匹配。
- 回收站布局：`<dshHome>/session-butler/trash/<project>/<dir>` + 同名 `.json` sidecar（原子写入）；restore 的目标路径由 sidecar 推导，不维护全局索引。
- 预检顺序：迁移态 → 运行态（D-013 stopActivity + 有界轮询）→ 写租约 → 目录定位 → trash 目的地占用；全部通过后才开始移动，移动失败按逆序回滚。
- 级联：`sessionQuery.traceSession` 的 descendants 中仅保留 `origin === 'subagent'`；普通 fork（已发布版带 `parentSession`）不级联。
- 命令面：`/session-butler list|trash|restore|purge`，文本结果；命令不能 trash 发起它的当前会话。

### 3.4 HTTP 桥（Web → Host 删除能力）

外部 npm 插件无法新增 Typert `@Remote`，因此：

- Host：`ctx.webServer.register({ kind: 'prefix', path: '/session-butler/api', handler })`；handler 首行 `ctx.connection.requestRejection(req)`，随后只接受 owner 连接、`POST`、`application/json`、限长 body（如 64 KiB）；
- Client：**document-relative** `fetch('session-butler/api/trash', ...)`（无前导 `/`，兼容反向代理挂载）；
- 信封：`{ ok: true, value } | { ok: false, error: { code, message, details? } }`；
- 方法（M2/M3 已实现）：`status` / `list` / `detail` / `trash` / `trash-many` / `restore` / `restore-many` / `purge` / `list-trash`；
- 协议错误用 400/404/405/413（同信封）；领域错误固定 HTTP 200 + `ok:false`，页面直接展示稳定错误码；
- 不做流式；不做通用 RPC；所有参数在 Host 侧重新校验（客户端不可信）。

**实现备注（M2）**：

- 桥在 `ctx.inject(['webServer','connection'], scope => mountBridge(scope, service))` 里挂载：headless/ACP 组合没有这两个服务，插件仍保留命令面；Web 组合在服务就绪后才注册前缀路由。
- `sessions`/`agents`/`workspaceRegistry` 用 `() => ctx.get(...)` 延迟取值，避免 Web 组合的激活顺序导致插件启动时服务尚未存在（M2 实测发现并修复）。
- 客户端 `fetch('session-butler/api/<method>')` 无前导 `/`；认证由 `connection.requestRejection({headers})` 完成，未认证请求实测 401。
- M3 新增 `list`（筛选/分页）与 `trash-many`/`restore-many`：`sessionIds` 必须是 1–50 个非空字符串，重复 id 去重；批量入口逐项独立处理，单项失败不影响其余项，`moved`/`failed` 为聚合结果。

### 3.5 命令与工具面

- 命令（M1 已实现）：`/session-butler list|trash|restore|purge`（`ctx.commands.register`），让无管理页的场景也能用；归档/取消归档直接复用官方 UI；
- 工具（M3 已实现）：`session_butler_list` / `session_butler_detail` 只读；写操作**不**注册为 agent 工具，避免模型误删。
  - 注册方式必须**结构化**：第三方已发布插件不能 import `@deepseek-ai/dsh-tools`，因此 `host/tools.ts` 手写 `{name, description, parameters, output:{schema, render}, execute}` 交给 `ctx.tools.register`；`parameters` 用逐属性 `required:true`，`output.schema` 用 DSH 支持的 JSON Schema 子集（已用真实 `assertSupportedJsonSchema` 校验）。
  - `list` 参数：`query?`/`cwd?`/`includeArchived?`/`includeSubagents?`/`limit?`；输出 `{total,truncated,sessions[]}`，render 为逐行文本（id、标题、cwd、相对时间、flags）。
  - `detail` 参数：`sessionId`（必填，精确 id）；输出 header、stats、tokens、size/eventCount、enrichment、扁平化后代（`depth`）；render 对有界后代做截断说明。
  - 工具在 `ctx.inject(['tools'], scope => …)` 里注册（headless 也可能没有 tools）；服务对象本身暴露只读方法，桥与工具共享同一实现。

## 4. Client 半架构（M2 已实现）

```
src/client/index.tsx       # apply/inject：slots/locale/uiWorkspace/sessions
   ├── ctx.slots.inject('main', () => ctx.slots.register(
   │     {name:'main', key:'session-butler', locale, inject: actions}, Page))
   └── ctx.slots.inject('sidebar.panellist', () => ctx.slots.register(
         {name:'sidebar.panellist', id:'session-butler', order:6, label, locale}, Icon))
src/client/page.tsx        # 列表/筛选/多选批量/详情弹窗/回收站/删除确认/永久删除确认（页内 fixed 对话框）
src/client/bridge.ts       # document-relative fetch + 网关信封 + BridgeError
src/client/locale.ts       # NS='session-butler' + zh/en 字典（ctx.locale.register 运行时注册）
src/client/contract.ts     # 本地结构化端口（不 import 任何 @deepseek-ai/dsh-* 包）
```

**M2 实现备注**：

- page 与 row 通过**两个独立的 `slots.inject`** 注册：`main` 由布局插件声明，`sidebar.panellist` 由侧栏插件声明，两者不是同一个 owner。M2 最初把 row 嵌在 `inject('main')` 回调里，真实 Web 启动时 `main` 先声明、侧栏插槽尚未声明，`register` 抛 `slot "sidebar.panellist" is not declared`，整插件显示 failed；M4 首轮浏览器验收定位并改为独立注入。
- 字典先注册、槽位后注册，并用一个 effect 的 disposer 数组统一逆序释放；注册中途抛错时先回滚已注册项再抛出，避免 loader 重试时出现 `locale namespace ... already has locale`。
- 删除/永久删除确认框先用页内 `position: fixed` 对话框（状态与页面同源，避免为浮层引入跨组件 store）；若 M3 需要从会话列表行直接触发确认，再迁到 `shell.overlay`。
- 数据刷新：trash/restore（含批量）后调用 `ctx.sessions.refresh()`；回收站列表由桥重新拉取。改名/置顶/归档/取消归档不在本页重复实现（官方 UI 已覆盖）。
- M3 交互：会话/回收站两个标签页都支持多选（全选、清空、选中计数）；批量移入回收站先并行取 detail 预检迁移态与级联数，再确认；批量恢复直接执行并以聚合结果提示。详情弹窗复用同一个 `detail` 桥方法，展示统计/血缘/enrichment，不额外发起破坏性请求。

关键不变量：

1. page 与 sidebar row **同一 effect 生命周期**：两个槽位各自注册、统一逆序释放；不得把某个槽位的 `register` 嵌套进另一个槽位的 `inject` 回调（两个槽位的 owner 插件不同）。
2. 面板 key / sidebar id 用 `session-butler`，与包名命名空间隔离；`PANEL_ID` 来自 `shared/identity.ts`。
3. 页面自己负责布局（`main` 槽只给中栏容器）：照抄 Plugin Manager 的 `page`/`pageBody` 骨架与主题 token（`--dsw-alias-*`）。
4. client bundle 只能 `require` 11 个 platform seed + `dsh.client.external`；其他宿主能力一律走 Cordis 服务；首版单文件，不用动态 `import()` 拆包。
5. 文案走 Client locale 服务（运行时 `ctx.locale.register`）+ 包 `locale/*.json`（插件页 meta）；中英文都要齐。

## 5. 里程碑

| 阶段 | 内容 | 验收 |
|---|---|---|
| **M0（已完成）** | 包脚手架、构建/打包/校验管线、配置、展示资源、三份调研 + 架构/决策/发布文档 | `pnpm run verify` 全绿；`npm pack` 清单闭环 |
| M1 | Host 删除核心：capabilities/resolve/trash/delete + storageDomain + 单元/集成测试（临时 `DSH_HOME` fixture） | 不接 UI 也能通过临时 profile 命令验证 trash/restore/purge/级联 |
| **M2（已完成 2026-10-28）** | Web 管理页：main panel + sidebar 入口 + 同源 POST 桥 + 列表/筛选/回收站/删除确认；locale zh/en；SSR/装配测试 | 临时 profile 安装后：bundle 被分发、桥 401/200/领域错误实测、页面 SSR 渲染通过；浏览器内点击验证留待 M4 验收 |
| **M3（已完成 2026-10-28）** | 只读 agent 工具（list/detail）+ 批量操作 + 详情补全（轮数/token/血缘树） | `pnpm run verify` 52 tests 全绿；工具 schema 通过真实 DSH 校验；桥/页面/SSR 测试覆盖批量与详情；无 UI 场景可只用工具/命令 |
| M4 | 发布验收：`npm pack` → 临时 profile link 安装 → registry 安装复验 | 见 `docs/publishing.md` 阶段 C/E |

## 6. 兼容与升级策略

- 收窄而非放宽：DSH 升级后先跑 `pnpm run verify`，再人工核对 `engines.dsh`；必要时收紧范围，不依赖 exemption。
- 可选能力全部 `ctx.get` 探测，缺失时对应功能隐藏/降级，不抛错。
- 不 import 具体实现包（`session-persistence-jsonl` 等）；只依赖 `@deepseek-ai/cordis`/`schemastery` peer 与 Host Service 契约。
- 删除逻辑对存储形态做防御：`location.kind !== 'jsonl'` → `storage-unsupported`，等待上游 `SessionPersistence.delete()`（见 D-003 的后续项）。
- 客户端 bundle 的 platform seed 列表与 DSH 版本绑定，已在 `scripts/build-client.mjs` 显式列出；升级 DSH 时同步核对。

## 7. 风险清单

| 风险 | 影响 | 缓解 |
|---|---|---|
| 无官方删除 API，目录直删依赖当前 JSONL 布局 | 上游存储重构后失效 | kind 判断 + 稳定错误码 + 推动上游补 API |
| 跨进程：列表是每进程视角 | 多开 DSH 时看不到对方 live 会话 | 删除前 `open(id,'write')` 租约探测；拒绝无法确认的目标 |
| 删除无客户端事件 | 管理页与侧栏不同步 | 操作后主动 refresh + 本地行移除；`workspace.follow` 处理归档/置顶 |
| archive 语义与用户直觉不同（逻辑隐藏而非移动） | UI 文案误导 | 文案明确「归档 = 从列表隐藏，可恢复」；不复刻 Codex 的移动式归档 |
| fork 与血缘混淆 | 误删历史 fork | 级联只沿 `origin === 'subagent'`；测试覆盖 |
| 内容搜索默认关闭 | 用户期待落空 | UI 显示能力探测结果并给开启指引；不默认改 profile |
| 客户端依赖内部服务（sessions/workspaces/uiWorkspace） | DSH 升级可能破坏 | 版本夹紧 + 发布前 live slot 复核 + 尽量用 standard hooks |
| 在 HMR profile 中重装同版本 | `already-installed` | 发布/升级流程用 remove → install 或 Web Update |

## 8. 参考

- 调研（**以 v2 为准**）：[`dsh-session-management-v2.md`](../research/dsh-session-management-v2.md) · 打包契约 [`dsh-packaging-contract.md`](./dsh-packaging-contract.md) · 第一版存档 [`dsh-host-apis.md`](./dsh-host-apis.md) / [`dsh-web-ui.md`](./dsh-web-ui.md) · Codex 对标 [`codex-session-management.md`](../research/codex-session-management.md)
- 决策：[`decisions.md`](./decisions.md) · 发布：[`publishing.md`](./publishing.md) · 用户文档：[`usage.md`](./usage.md)
