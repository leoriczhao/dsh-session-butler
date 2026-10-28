# 决策记录（ADR）

> 格式：每条决策记录 **背景 / 决策 / 理由 / 影响 / 状态**。
> 状态：`accepted`（已定）、`proposed`（建议，待用户确认）、`open`（待决）、`superseded`。
> 事实依据见 [`architecture.md`](./architecture.md) 与三份调研文档。

## 已定决策

### D-001 范围重定位：不重做 DSH 已有能力 · accepted

- **背景**：产品调研（`research/codex-session-management.md`）写于早期，假设 DSH 缺少改名/置顶/归档。经已发布包与 live service 核实：rename、pin/unpin、archive/unarchive、fork、export 均已有（Host Service + Web Remote + GUI）。fork 的 UI 入口有 3 个（会话页轮末「在新对话中分支」可按完成轮选 `atSeq`、侧栏行菜单、全局快捷键），剩余缺口是 **tool 面**与轮中截断/Esc Esc/`/side`——见 D-014/D-015。
- **决策**：Threadloom 的 MVP 聚焦 **统一管理页（列表/检索/详情/批量）+ 删除/回收站 + 命令面**；已有能力通过官方 Remote/Host Service 复用，不重写状态机。
- **影响**：README、`docs/usage.md`、里程碑（M1–M3）按此重排；「归档 = 移动目录」的假设作废。

### D-002 包身份与发布渠道 · accepted

- **背景**：用户选择。
- **决策**：
  - npm 包名 **`dsh-session-butler`**（unscoped，npm 上可用）；产品显示名 **Threadloom**（`locale/*.json` 的 `meta.title`）。
  - 发布到 **npmjs 公共 registry**；MIT 许可证；首版 `0.1.0`。
  - 兼容声明：顶层 `engines.dsh: ">=0.2.1-rc.2 <0.3.0-0"`（起初按 rc.3；后按 M1–M3 实际用到的 API 在 rc.2 发布包上逐项审计，全部存在，故降到 rc.2 以覆盖 npm `latest`）；**不写** `dsh.engines`。
- **影响**：`package.json`、`cordis.patch.yml`（行 `name` 必须是裸包名）、构建产物中的模块 id、locale、文档统一使用该包名；GitHub 仓库地址待发布前补 `repository`/`homepage`/`bugs`。

### D-003 删除采用「插件侧回收站优先」 · accepted

- **背景**：DSH 无官方删除 API，且设计 note 明确"等真实消费者再加"（`SessionPersistence.delete()` 于 2026-06-20 被移除）。存储层处于 proposed 重构期。
- **决策**：
  - M1 在插件侧实现：`sessionQuery` 定位 → 路径/kind 校验 → `sessionPersistence.open(id,'write')` 跨进程写租约探测 → 同盘 `rename` 到 `~/.dsh/session-butler/trash/<id>/` → `storageDomain` 记录 → 清理 pin/archive 状态。
  - 回收站目录与索引由插件自持；保留期由 `trashRetentionDays` 控制（默认 30 天，`0` = 不自动清理）。
  - 永久删除（purge）需要回收站记录 + 完整 session id 确认；`permanentDelete` 默认 `disabled`。
  - 范围澄清：D-003 的「写操作不进工具面」只约束**删除/清除**；创建/分叉会话（非破坏性）可作为工具暴露，见 D-015。
  - 同时向上游提交 issue/PR 建议：`SessionPersistence.delete()` + `session/deleted` 事件 + 缓存/客户端失效钩子。上游落地后插件切换过去，删除目录的代码删除。
- **理由**：在无官方 API 的前提下，回收站优先把不可逆操作降到最低；租约探测避免删除其他进程正在写的会话；`kind === 'jsonl'` 判断让存储在重构后安全失败而不是误删。
- **影响**：插件需要文件系统能力（`node:fs` / `dshHomePath`），需要有 fixture 测试；存储重构时可能失效（有稳定错误码兜底）。
- **实现备注（M1）**：回收站使用**镜像 sessions 树的目录布局 + 每会话 sidecar JSON 元数据**（原子 temp+rename 写入），暂不引入 `storageDomain`：它要求 zod schema 与额外的运行时依赖，而回收站元数据只由本插件读写；M2 若需要跨进程变更通知/查询再评估迁移到 domain。

### D-004 级联只沿 `origin === 'subagent'`，fork 永不级联 · accepted

- **背景**：DSH 血缘 = `header.parentSession` + `header.origin === 'subagent'`。**fork 的版本行为不一致**：已发布 rc 通道（rc.2/rc.3/rc.4）的 fork 都写 `parentSession`；HEAD（2026-10-23 `b096659` 起）改为普通 fork 不带血缘。插件必须在运行时按 `origin` 判定，不能按版本号假设。
- **决策**：删除/归档级联只处理 `origin === 'subagent'` 且 `parentSession` 链可达的会话；fork 视为独立会话。删除前展示"将删除 N 个派生会话"。
- **影响**：`lineage.ts` 交叉验证 `subagents.listDescendants` 与 `sessionQuery.traceSession`；测试覆盖「fork 不被级联」。

### D-005 运行中会话：拒绝直接删除，可先归档再删 · accepted

- **背景**：DSH 归档支持 `stopActivity`（先归档、再停 turn/subagent/job/schedule）；删除没有任何官方的运行中处理。
- **决策**：`trash` 遇到 live/running 会话返回 `session-running`，并提供「先归档（stopActivity）再删除」的编排入口；不 dispose 其他会话的 Agent（无公开 API）。
- **影响**：管理页对运行中会话先弹归档确认；命令面提供 `--stop` 显式选项。

### D-006 归档不改文件、不搬运 · accepted

- **背景**：DSH 归档是逻辑标记（`archivedSessionIds`），文件原地不动；归档会话在 Web 侧不可打开、子代理后代被门禁冻结，且**不级联标记**子会话。
- **决策**：Threadloom 的归档/取消归档完全复用官方服务；不实现"归档目录"式搬运（会绕开状态机）；UI 文案明确「归档 = 从列表隐藏，可恢复」。
- **影响**：管理页归档行为与侧栏一致；不做"归档即移动存储"。

### D-007 内容搜索：MVP 只做标题/元数据，内容检索作为可选能力 · proposed

- **背景**：`sessionQuery.searchSessions` 依赖 `session-query-sqlite`，base 默认 `openAt: never`，内容搜索会抛 `SESSION_QUERY_SEARCH_DISABLED`；自建索引成本高且会引入持久 DB。
- **决策（建议）**：MVP 的搜索 = 标题 + workspace + 时间/preset/运行状态过滤（`remote.session.search` 只匹配标题/workspace 名）；检测到 profile 已开启 sqlite FTS 时，额外提供内容搜索入口，并处理 `SESSION_QUERY_SEARCH_DISABLED` / 索引失败。不在插件里默认改 profile 配置。
- **待确认**：是否接受"首版无内容级检索"。

### D-008 Web→Host 删除桥：webServer 前缀路由 + 同源 fetch · accepted

- **背景**：发布到 npm 的外部插件无法新增 Typert `@Remote`（构建期 codegen + 客户端固定命名空间）；`commands.execute` 需要激活的 Agent/Session，不适合冷会话管理。
- **决策**：Host 用 `ctx.webServer.register({kind:'prefix', path:'/session-butler/api'})`，首行 `ctx.connection.requestRejection(req)`；Client 用 document-relative `fetch('session-butler/api/…')`；JSON 限长、owner-only、稳定错误码。备选（不采用）：exact `connection.fetch` 路由（仅 `/api` 路径、owner-only，灵活性低）、通用 RPC、commands 桥。
- **影响**：桥的契约由本项目自持并有测试；错误码表进 `shared/errors.ts`；后续若 DSH 开放第三方 Remote 再迁移。

### D-009 UI 入口：keyed `main` 面板 + `sidebar.panellist` 行 · accepted

- **背景**：宿主公开契约中唯一"一键直达的整页目的地"是 `main` 槽 + 侧栏 panellist 入口（官方 Plugins 页、dshmarket 同构）。替换 `sidebar.workspaces` 会破坏既有搜索/分组/行菜单。
- **决策**：注册 `main` 槽（`key: 'session-butler'`）作为管理页，`sidebar.panellist`（`id: 'session-butler'`）作为入口；两者同一 effect 生命周期，先 page 后 row；浮层走 `shell.overlay`。
- **影响**：M2 实现；页面布局抄 `ui-plugin-manager`，只使用 `--dsw-alias-*` token。

### D-010 构建工具：tsc（Host）+ esbuild（Client），单文件 classic script · accepted

- **背景**：Host 需要 ESM + 类型声明；Client 必须是 `window.__ModuleLoader__.load` 经典脚本，React 等 11 个 platform seed 必须 external，首版不做动态拆包。
- **决策**：Host 用 `tsc -p tsconfig.host.json`；Client 用 `esbuild` 打成 CJS，再以 banner/footer 包装成工厂；构建脚本自检产物头尾、无顶层 ESM、无 `import()`。不引入 tsdown（依赖更多，包装行为需额外验证）。
- **影响**：升级 DSH 时同步核对 `scripts/build-client.mjs` 里的 platform seed 列表；动态拆包（`require.async` 改写）留到确有需要时。

### D-011 兼容策略：顶层 `engines.dsh` 独占判定 + 可选能力探测 · accepted

- **背景**：`evaluatePluginCompatibility` 只读顶层 `engines.dsh`；存在时忽略 dsh peers。`workspaceRegistry` 不在 base。
- **决策**：顶层 `engines.dsh` 声明 `>=0.2.1-rc.2 <0.3.0-0`（经 API 审计，见 D-002/Q7）；peerDependencies 只声明 `@deepseek-ai/cordis` / `@deepseek-ai/schemastery`（optional），不声明 `@deepseek-ai/dsh*` peers；Host 侧全部通过 Service 契约访问，可选服务 `ctx.get` 探测；不 import 具体实现包。
- **影响**：DSH 升级时先跑 verify；发现 API 变化收紧范围而非放宽。

### D-015 工具面缺少「会话 → 新会话」，由 Threadloom 补工具 · accepted（0.1.2 实现）

- **背景**：核实 `docs/tool-catalog.md` 与本进程 `Tool` inspect：DSH 没有任何 `session_create` / `session_fork` / `new_session` 工具。`subagent_fork` 只是「带已完成轮次 seed 的子代理委派」，结果回传父会话，不是用户可见/可切换的新会话；`fork` 存在于 Web Remote、Host `ctx.sessions.fork`（live only）与 GUI（会话页轮末分支 / 侧栏菜单 / 快捷键），但都不是 tool。
- **决策（建议）**：Threadloom M3 注册工具：`session_butler_fork`（当前会话，默认最近完成轮，支持 `at_seq`）、`session_butler_new`（继承 cwd/workspace/preset 的空会话）、只读 `session_butler_list` / `session_butler_detail`。新会话必须出现在同 workspace 且可被 UI 切换；返回 child session id。删除等破坏性写操作仍不作为工具（D-003 不变）。
- **技术路径**：复用 Remote fork 的实现路径（`sessionQuery.observeSession` → `buildForkSeed` → `ctx.agents.create` → `workspace.attachSession`），或 live 场景用 `ctx.sessions.fork` + resume；工具默认只操作调用方当前会话，任意 session id 需显式参数与用户确认。
- **M3 收敛（2026-10-28）**：M3 只交付只读 `session_butler_list` / `session_butler_detail`（D-018）；`session_butler_fork` / `session_butler_new` **不进入 0.1.0**，留作二期候选。原因：写工具需要额外的会话切换/父会话授权语义（若允许任意 session id 则风险高），且当前工具面无 fork 属于产品缺口而非发布阻塞。D-015 的技术路径保留，待二期重新确认 ①–③。
- **0.1.2 实现（2026-10-28，二期）**：产品复盘确认这是**必做项**（用户两次提醒「dsh 没有从会话新建会话的工具」「为啥要走 UI」），不再延后。
  - 注册 `session_butler_new`（无参数；`sessionController.create({cwd, agentPreset})`，cwd/preset 取自 `exec.agent.session.header`）与 `session_butler_fork`（可选 `atSeq`；`sessionController.fork({sessionId, atSeq})`，行为同 Web Remote `session.fork`：默认最近已完成轮、精确包含边界、子会话出现在同 workspace 并可被 UI 切换）。
  - 授权语义收敛为「**只操作调用方自己的会话**」：fork 的 source 固定为 `exec.agent.session.id`，new 不接受 cwd/workspace/目标 id 参数；模型不能借此操作任意会话或任意路径。
  - 能力按组合探测：只有存在 `sessionController` 时才注册这两个工具（Web profile 有；headless/ACP 可能没有），两个方法分别探测；`tools` 服务缺失时全部工具不注册。
  - 删除/回收站/恢复仍是破坏性写操作，继续不进入工具面（D-003 不变）。

### D-014 会话内「派生/旁支」的剩余缺口，列为二期候选 · proposed

- **背景（经独立复核修正）**：fork 的 GUI 入口齐全——会话页每条**已完成轮**末尾有 branch 图标「在新对话中分支」（`ctx.sessions.fork({atSeq: 该轮 seq})`，**可按完成轮选分叉点**；已发布 `client-ui-chat@0.2.1-rc.3` 与 HEAD 都有），侧栏会话行「…」菜单有「分叉会话」（固定最近完成轮），全局快捷键 desktop `Ctrl/Cmd+Alt+F` / web `Ctrl/Cmd+Shift+F`。**v2 初稿曾错误声称「对话页内无入口、不能选分叉点」，已纠正。**
- **剩余真实缺口**：
  1. **agent tool 面没有**「会话→新会话」工具（D-015）；
  2. 只能从**已完成轮**分叉，不能切在轮中/任意消息；也没有 Codex 式「编辑上一条用户消息并从该点分叉」（Esc Esc）；
  3. 没有 `/side` 式临时旁支（不落盘、用完即弃）；
  4. 没有「派生树/血缘」视图：普通 fork 在 HEAD 不写 `parentSession`，在已发布版虽写 parent 但 UI 只把 `origin==='subagent'` 当血缘（HEAD）。
- **决策（建议）**：Threadloom MVP 不重做 fork；二期评估管理页里的「派生树视图 + 按轮分叉入口（复用官方 atSeq）」；`/side` 不承诺（需要上游会话生命周期支持）。
- **已落地（0.1.2）**：用户确认「从会话中新建会话」是必做项；按 D-015 补齐 tool 面 `session_butler_fork` / `session_butler_new`，GUI 入口继续直接用官方。

### D-012 跨 workspace 移动不做 · accepted

- **背景**：header 不可变、persistence 以 header 定目录；`workspace.entity.attachSession` 要求 cwd realpath 与 workspace path 一致。真"移动"需要改 header（非法）或重放新建。
- **决策**：MVP 与二期都不做跨 workspace 移动；若未来需要，先讨论「copy 后旧会话标记迁移」的产品语义并要上游支持。

### D-013 删除运行中会话：先归档停止，再删除 · accepted

- **决策（用户 2026-10-27 确认推荐项 A）**：trash 前若会话仍 live，先调用官方 `archiveSession({stopActivity:true})` 并等待运行工作结束（有界轮询）；成功后再执行 trash，最后清理归档/置顶状态。无 workspace 服务的组合（headless/ACP）直接返回 `session-running` 并提示先手动停止。不提供"强制停止并删除"。
- **实现（M1）**：`SessionButlerService.settleRunning`；失败回滚时对本次归档过的会话 best-effort `unarchive`。

### D-016 Web 管理面与 Host 的通信：同源前缀 POST 桥 · accepted

- **背景**：第三方 npm 插件无法新增 Typert `@Remote` 命名空间（构建期 codegen + 静态 api-remotes 导入），`$mount`/`typert.register` 属不稳定内部面。
- **决策**：Host 用 `webServer.register({kind:'prefix', path:'/session-butler/api'})` 暴露一个同源 POST 桥；Client 用 document-relative `fetch`。请求先过 `connection.requestRejection`（401/403），body 限 64 KiB，参数在 Host 重新校验；响应统一 `{ok,value|error}` 信封，领域错误固定 HTTP 200（页面展示稳定错误码），协议错误 400/404/405/413。
- **实现（M2）**：`src/host/bridge.ts` + `src/client/bridge.ts`；方法 `status/detail/trash/restore/purge/list-trash`；临时 profile 实测未认证 401、成功 200、`session-not-found`/`permanent-delete-disabled`/`trash-not-found` 领域错误。

### D-017 Host 服务的可选注入与延迟绑定 · accepted

- **背景**：Web profile 中 `webServer`/`connection`/`workspaceRegistry` 可能在插件 `apply` 之后才挂载；headless/ACP 则永远没有它们。
- **决策**：桥用 `ctx.inject(['webServer','connection'], ...)` 可选注入；`sessions`/`agents`/`workspaceRegistry` 通过 `() => ctx.get(...)` 在操作时延迟取值；命令面不依赖这些可选服务，headless 仍可 `/session-butler`。
- **影响**：`workspaceAvailable` 变成运行时能力探测（M2 实测从 false 修正为 true）；删除运行中会话在无 workspace 组合继续按 D-013 拒绝。

### D-018 agent 工具：结构化注册 + 只读边界 · accepted

- **背景**：已发布 npm 插件不能 import `@deepseek-ai/dsh-tools`（实现包不在 peer 依赖内），也不能依赖 Typert 的静态 codegen；工具必须按 `ctx.tools.register(definition)` 的结构化契约注册。
- **决策**：`host/tools.ts` 手写完整的 tool definition：`name` / `description` / `parameters` / `output:{schema, render}` / `execute`。`parameters` 必须是**对象根 JSON Schema**：`host/schema.ts` 的 `compileParameterSchema` 把逐属性 `required:true` 的编写 DSL 编译成 `{type:'object', properties, required?}`（与 `defineTool` 的编译结果一致），因为 `ctx.tools.register` 把 `parameters` 原样发给 provider。`output.schema` 与编译后的 `parameters` 都只使用 DSH 支持的 JSON Schema 子集（`type/properties/required/additionalProperties/items/enum/const/oneOf`），并用真实 `assertSupportedJsonSchema` + `validateJsonSchemaValue` 校验过 schema 与真实输出值。
- **边界**：`session_butler_list` / `session_butler_detail` 只读；**破坏性写操作（删除/回收站/恢复）不注册为工具**，避免模型误删/误移。0.1.2 按 D-015 增补**非破坏性**的 `session_butler_new` / `session_butler_fork`（只创建新会话，不删除/不移动旧会话）。工具在 `ctx.inject(['tools'], …)` 中注册，缺失时插件其余能力不受影响。
- **实现（M3）**：`registerButlerTools(tools, read)` 返回 disposer；测试直接对 `createListTool/createDetailTool` 断言参数校验、过滤转发、文本渲染与截断说明。
- **回归（0.1.1，2026-10-28）**：首版把编写 DSL 的属性表直接当 `parameters` 注册，`ToolsService.register` 只校验 `output.schema`、不校验 `parameters`，于是插件能正常激活，但每次 native function calling 请求都被 provider 以 `Invalid schema for function ...: got 'type: null'` 整体拒绝。修复为注册前编译成对象根 schema，并加 `host/schema.ts` 单测锁住根 `type:'object'`、`required` 提升与 DSL 误用拒绝。

### D-019 列表/详情数据源：stat + 事件折叠，不依赖 projection cache · accepted

- **背景**：rc.2 release 组合与 Web 组合的 projection 键不一致（`sessionStats`/`tokenUsage` 等不可假定存在）；详情又需要轮数/token/大小等统计。
- **决策**：
  - 列表 = `sessionPersistence.list()` + live `sessions.list()`/`agents.list()` + best-effort `readTitleSnapshots` + `workspaceRegistry` 的归档/置顶集合；过滤/排序/分页在 Host 侧。
  - 详情 = `sessionPersistence.stat(id)` 提供 header/formatStatus/eventCount/sizeBytes；`traceSession` 提供血缘；**best-effort** `observeSession({projectionMode:'none'})` 后折叠原始事件得到统计。
  - 事件读取失败或迁移中 → `enrichment:{status:'partial',reason}`，详情仍返回 header/lineage；绝不因统计失败而让详情整体失败。
- **实现（M3）**：`src/host/read-model.ts`（`summarizeSessionEvents` 防御性窄化，跳过畸形事件）+ `service.detail`/`listSessions`；桥/工具/页面共用。

### D-020 批量操作：逐项独立、去重、级联 no-op 成功 · accepted

- **决策**：`trashMany` / `restoreMany` 接收 1–50 个非空字符串 id（Host 侧去重）；每项独立执行，单项失败写入 `items[].error`，不影响其余项；`moved`/`failed` 为聚合结果。级联已提前移走的 id 在后续显式条目中返回 `ok:true, moved:[]` 的 no-op，而不是重复失败。
- **实现（M3）**：桥 `trash-many`/`restore-many`；Web 页多选 + 批量确认；测试覆盖部分失败、重复/级联重叠、空数组、超 50、混合类型。

### D-021 D3 定位：完整管理台以「库/详情/续聊/分叉/组织」为核心，删除/回收站降为「清理」模块 · proposed（待用户确认）

- **背景**：用户要求 D3「要做就做完整」，并质疑「删除/回收站是否该作为下一版核心」。Codex 桌面 UI 实机显示：删除位于右键菜单最底部、无快捷键、无回收站；行内主生命周期动作是归档（可恢复，Ctrl+Shift+A）。
- **决策**：D3 的核心能力 = Library（检索/分组/预览）+ Detail（血缘/成本/产物）+ Resume（打开/续聊）+ Fork（工具/面板）+ Organize（置顶/归档/标签/备注）；删除/回收站作为 **Cleanup** 模块（默认 `permanentDelete=disabled`），成功指标是「误删=0、可恢复=100%、live 误删=0」，而不是删除量。
- **证据**：`research/2026-10-28-codex-desktop-ui-audit.md` §3/§9；`research/codex-session-management.md` §E；`docs/decisions.md` D-003/D-005/D-013。

### D-022 插件管理集成：复用 DSH Plugins 页 + `settings.plugins.tab` + 运行期健康，不重做插件管理 · proposed（待用户确认）

- **背景**：DSH 已有插件管理（Plugins 设置页、插件详情/启停/卸载、`plugin-inventory` 的 fiberPhase/diagnostic、`dsh plugin` 转发 pnpm、`ctx.remote.settings` 配置读写）；Threadloom 此前的详情页/图标/描述/README 已由该机制展示（`docs/evidence/plugin-detail.png`）。
- **决策**：
  - 安装/启停/卸载/版本/README 交给 DSH，插件不重做；
  - 配置保持**单源**（profile patch / Config）：优先让 Config 字段 `.volatile()` 走 DSH 原生表单；否则设置 tab 只读展示 + 复制 patch 片段，不建第二配置源；
  - 在 Plugins 设置页注册一个 `settings.plugins.tab`（独立 id、inject 等待声明、旧版本静默降级），承载健康/诊断/入口设置；
  - 运行期健康由 `/session-butler/api/status` 自报（桥/存储/后端/计数），补 `plugin-inventory` 看不到的功能级状态；
  - 破坏性动作仅人类 UI；agent 工具保持只读/创建/分叉。
- **证据**：`packages/client/ui-settings-plugins`、`packages/client/ui-settings-plugin-inventory`、`packages/host/plugin-inventory/src/types.ts`、`packages/boot/settings-controller`/`packages/settings/settings`、`apps/cli/src/args.ts`（plugin 子命令）；`docs/d3-console-design.md` §8。

## 待确认问题（发布前必须收敛）

| # | 问题 | 建议默认 |
|---|---|---|
| Q1 ✅（已定 2026-10-27） | 回收站默认保留期？ | **30 天（`trashRetentionDays=30`）**；到期仅在列表中标记 `expired`，不自动 purge。 |
| Q2 ✅（已定 2026-10-27） | 永久删除是否默认开启？ | **默认 `disabled`**；用户在 profile 配置里显式改 `confirm` 后可用，且必须二次输入完整 session id。 |
| Q3 ✅（已定 2026-10-27） | 归档是否级联子会话？ | **不级联**（保持 DSH 官方语义）；UI 提示"子会话仍在列表中"。 |
| Q4 ✅（已定 2026-10-27） | 首版是否接受无内容级检索？ | **接受**（D-007）：首版标题 + workspace/时间/preset/状态过滤，内容检索二期。 |
| Q5 ✅（已定 2026-10-27） | 是否提供 CLI 入口？ | **不做 `dsh` CLI 子命令**（插件无法扩展 dsh CLI）；首版用 `/session-butler` 命令 + Web 管理页；独立 bin 留待二期评估。 |
| Q6 ✅（已定 2026-10-27） | 迁移中（formatStatus=migration-required）的会话删除策略？ | **拒绝并提示先打开完成迁移**（`session-migration-required`），级联中任一子会话迁移未完成同样整体拒绝。 |
| Q7 ✅（已定 2026-10-27） | `engines.dsh` 下限要不要从 `>=0.2.1-rc.3` 降到 `>=0.2.1-rc.2`？ | **已定：降到 rc.2。** 审计了 M1–M3 实际用到的 30+ Host/Client API（sessionQuery/persistence/title、workspaceRegistry/attachSession、agents/agentDefaultModel、sessions、commands、tools/defineTool、webServer/connection、storageDomain、dshHomePath、projectionCache；remote.session/workspace、slots、row menu/branch、standard hooks、client module contract、11 platform modules），全部存在于 rc.2 发布包；未使用的 HEAD-only 能力（markdown 导出等）不影响下限。 |

## 发布门禁（MVP acceptance checklist）

- [x] `pnpm run verify` 全绿（typecheck + build + 52 tests + package validation）
- [x] M1 删除核心在 fixture 上通过：trash/restore/purge/级联/锁冲突/运行中拒绝（`tests/m1-delete.test.mjs`）
- [x] M2 桥/页面：临时 profile 实测 bundle 分发、认证 401、status/list/detail 与领域错误；页面 SSR + 装配测试通过。
- [x] M4 真实浏览器验收（2026-10-28，临时 profile）：首轮发现 M2 客户端单 `main` 注入导致 `sidebar.panellist` 未声明时报错并使插件 failed，已改为两个独立注入；修复后无控制台/页面错误，列表/筛选/详情弹窗/行删除确认/批量确认均渲染正常。
- [x] M3 只读工具 + 批量 + 详情补全：工具 schema 用真实 DSH 校验器验证；`m3-read-model`/`m3-tools`/bridge/client 用例覆盖列表分页、详情部分 enrichment、批量逐项结果、批量 UI 渲染。
- [x] M3 临时 profile（`tl-m3`，已删除）实测：`list` 分页/`truncated`、真实大会话 `detail`（turns/steps/events/token/title/血缘）完整、`trash-many` 非法负载 400、`restore-many` 逐项 `trash-not-found`；启动无工具 schema 警告。
- [x] 临时 profile 用绝对路径 link 安装并 `--dump-config` 校验：隔离 `DSH_HOME=/tmp/tl-m4/home` 的 `tl-iso` profile 实测（命令与结果固化在 `docs/publishing.md` 阶段 C）。
- [x] `npm pack` 产物在干净目录安装后 `exports` 全部可解析：安装 optional peer（`@deepseek-ai/cordis@4.0.5`、`@deepseek-ai/schemastery@3.18.5`）后 Host 导入成功；client bundle 在 `window.__ModuleLoader__` 沙箱内注册成功。
- [x] 隔离 `DSH_HOME` 内完整写入闭环：页面移入回收站（`0` sessions / `1` trash entry）→ 恢复（`0` trash / `1` session），永久删除按默认配置禁用；证据 `docs/evidence/web-*.png`。
- [x] locale（zh/en）、icon、detail 文档在插件页正确显示：隔离 profile 的 Plugins 页实测 Threadloom 图标/名称/版本/id/描述，详情页渲染 `docs/usage.md` 全文；管理页与导航在 zh/en 浏览器 locale 下均正常（证据 `docs/evidence/plugin-detail.png`）。
- [x] running/archived/subagent 边界：M1 running 拒绝 + 归档不级联、M3 detail 子代理 lineage 已覆盖；`fork` 按 D-015 延期，不阻塞 0.1.0。
- [x] CHANGELOG、版本号 `0.1.0`、`engines.dsh` 与本地 DSH `0.2.1-rc.3` 一致；`npm latest` 仍为 rc.2 且下限覆盖 rc.2。
- [x] 仓库与元数据：源码已托管到 `https://github.com/leoriczhao/dsh-session-butler`，`package.json` 补齐 `author`/`repository`/`homepage`/`bugs`，README 文档链接改为 GitHub 绝对地址。
- [x] 发布 `0.1.0`（2026-10-28）：npm `latest` 指向 `0.1.0`；`npm view` 核对 `engines`/`dsh`/`repository`/`homepage`/`bugs`/`license` 全部正确。
- [x] registry 全新安装复验：隔离 `DSH_HOME` 的 `tl-reg` profile 用 `dsh plugin add dsh-session-butler@0.1.0` 安装，`--dump-config` 含 `session-butler` 行，Web 管理页与插件详情页启动无 console/page error。
- [x] Git tag `v0.1.0` + GitHub Release 已发布；`main` 分支与 `origin` 同步。
- 备注：npm README 是发布 tarball 的只读快照，发布后更新的 README 状态不会回写 0.1.0 页面；如需刷新，用 0.1.1 等下一个版本携带。
