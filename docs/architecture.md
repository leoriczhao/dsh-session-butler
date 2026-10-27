# Threadloom 架构（基础版）

> 状态：基础工作（M0）。本文件是**已核实的 DSH 事实** + **目标架构**，不是已完成功能的描述。
> 事实来源（均已逐行核对 DSH 源码与 live Host Service 注册表，版本 `0.2.1-rc.3`）：
> [`dsh-host-apis.md`](./dsh-host-apis.md)、[`dsh-web-ui.md`](./dsh-web-ui.md)、[`dsh-packaging-contract.md`](./dsh-packaging-contract.md)。
> 产品决策见 [`decisions.md`](./decisions.md)，发布流程见 [`publishing.md`](./publishing.md)。

## 0. TL;DR

1. **不要重做 DSH 已有的能力。** `0.2.1-rc.3` 已经提供 rename、pin/unpin、archive/unarchive、fork、export（Host Service + Web Remote + GUI 行菜单都有）。Threadloom 的真正价值是**统一管理面 + 删除/回收站 + 详情/血缘 + 批量操作**。
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
| fork | ✅ Web `session.fork`（`atSeq` 截断；fork **不写 parentSession**） | 二期 UI；不纳入血缘级联 |
| 导出 | ✅ `/export`、`/api/session.export`、`/api/session.markdown` | 二期复用 HTTP 路由/格式化函数 |
| 跨 workspace 移动 | ❌ 实际不可行（header 不可变；`attachSession` 要求 cwd realpath 匹配） | 明确非目标（D-012） |
| 内容搜索 | 🟡 需要 profile 开启 `session-query-sqlite` 索引 | 可选降级，不默认自建索引 |
| 运行中会话 | 🟡 归档支持 `stopActivity`；删除无 | 拒绝直接删除，先归档再删（D-005） |

### 1.2 关键约束

- **服务可用性**：`sessionQuery`/`sessionPersistence`/`sessionTitle`/`storageDomain` 属于 base；`workspaceRegistry` 只在 web-app / sdk-app，headless / acp 没有。必须用 `ctx.get(...)` 探测可选能力。
- **归档语义**：只写 `~/.dsh/storages/workspace.json` 的 `archivedSessionIds`，文件原地不动；归档会话在 Web 侧不可打开，子代理后代被 `agent/pre-step` 门禁冻结；**不级联标记**子会话。
- **血缘**：`header.parentSession` + `header.origin === 'subagent'`。fork 是独立会话（`isSeeded: true`，不写 parent），**不能**沿 `parentSession` 级联误删历史 fork。
- **无删除事件**：`api-session/removed` 只对 live session dispose 发出，冷会话删除没有任何客户端推送 → 管理页操作后自行刷新。
- **存储重构期**：`Session` / `SessionPersistence` 有 proposed 的整体重构。插件只走公开 Service、不解析 `session.v4.jsonl.zstd`、不 import 具体实现包；删除前用 `stat().location` 的 kind 判断（`jsonl` 才按目录删，其他形态拒绝）。
- **兼容判定**：只认顶层 `engines.dsh`；`dsh.engines.dsh` 静默失效。当前声明 `>=0.2.1-rc.3 <0.3.0`。

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
   ├── ctx.provide('sessionButler')  ← Host Service（list/detail/trash/restore/purge）
   ├── ctx.commands.register('/session-butler')   ← 无 UI 也能用
   ├── ctx.tools.register(list/detail 只读)        ← 二期，写操作不进模型面
   └── ctx.webServer.register(prefix '/session-butler/api') + connection.requestRejection
```

### 3.1 模块划分（M1 落地时）

| 模块 | 职责 |
|---|---|
| `host/capabilities.ts` | 统一探测可选服务，产出 `Capabilities` 快照；缺失时给出降级说明 |
| `host/service.ts` | `SessionButlerService`：`list` / `detail` / `trash` / `restore` / `purge` / `listTrash`；所有变更操作入口，路由/命令/工具都调它 |
| `host/resolve.ts` | id 寻址、路径校验（`basename === id`、位于 sessions root 下、无 symlink 逃逸） |
| `host/trash-store.ts` | 回收站目录 `~/.dsh/session-butler/trash/<id>/` + `storageDomain` 索引条目（id、原路径、删除时间、header 快照、descendantIds） |
| `host/delete.ts` | 删除管线（见 §3.3）：preflight → flush/lock → move → record → cascade |
| `host/lineage.ts` | 子代理后代枚举：`subagents.listDescendants` ∩ `sessionQuery.traceSession`，仅 `origin === 'subagent'` |
| `host/bridge.ts` | HTTP 前缀路由：方法分发、JSON 限长、owner-only、稳定错误码 |
| `host/commands.ts` | `/session-butler …` 命令面（list/show/trash/restore/purge/archive） |
| `host/tools.ts` | 只读 agent 工具（list/detail）；写操作不暴露给模型 |
| `shared/identity.ts` | 稳定标识（已实现） |
| `shared/errors.ts` | 稳定错误码联合：`session-not-found` / `session-running` / `session-locked` / `session-unresolved-path` / `storage-unsupported` / `trash-corrupt` / `forbidden` / `invalid-request` / `internal` |

### 3.2 数据来源

- **列表**：Host `sessionQuery.listSessions/filterSessions`（含 live + persisted）+ `workspaceRegistry` 分组（可选）+ `sessionProjectionCache.cachedSnapshot(['title','sessionStats','tokenUsage',...])` 补齐行数据。
- **详情**：header（`sessionQuery`）+ `sessionPersistence.stat`（大小/路径/formatStatus）+ 投影（轮数/token/preset/model）+ `traceSession`（ancestors/descendants）+ 运行状态（`agents.get(id).status`）。
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

### 3.4 HTTP 桥（Web → Host 删除能力）

外部 npm 插件无法新增 Typert `@Remote`，因此：

- Host：`ctx.webServer.register({ kind: 'prefix', path: '/session-butler/api', handler })`；handler 首行 `ctx.connection.requestRejection(req)`，随后只接受 owner 连接、`POST`、`application/json`、限长 body（如 64 KiB）；
- Client：**document-relative** `fetch('session-butler/api/trash', ...)`（无前导 `/`，兼容反向代理挂载）；
- 信封：`{ ok: true, value } | { ok: false, error: { code, message, details? } }`；
- 方法（M1）：`list` / `detail` / `trash` / `restore` / `purge` / `listTrash`；
- 不做流式；不做通用 RPC；所有参数在 Host 侧重新校验（客户端不可信）。

### 3.5 命令与工具面

- 命令：`/session-butler list|show|trash|restore|purge|archive|unarchive`（`ctx.commands.register`），让无管理页的场景（CLI/其他客户端）也能用；
- 工具：`session_butler_list` / `session_butler_detail` 只读；写操作**不**注册为 agent 工具，避免模型误删。

## 4. Client 半架构（目标）

```
src/client/index.ts        # apply/inject：slots/locale/sessions/workspaces/uiSession/uiWorkspace/layout/remote...
   ├── ctx.slots.inject('main', () => ctx.slots.register({name:'main', key:'session-butler', locale}, Page))
   ├── ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({name:'sidebar.panellist', id:'session-butler', order, label, locale}, Icon))
   └── ctx.slots.inject('shell.overlay', ...)   # 确认框/重命名框
src/client/page.tsx        # 列表/筛选/详情抽屉/批量选择；布局抄 ui-plugin-manager
src/client/data.ts         # standard hooks + sessions/workspaces/remote 组合
src/client/bridge.ts       # document-relative fetch 封装（错误码 → 文案）
```

关键不变量：

1. page 与 sidebar row **同一 effect 生命周期**：先注册 page，再注册 row；卸载逆序。row 在 page 不在时点击会抛 `main panel "..." is not registered`。
2. 面板 key / sidebar id 用 `session-butler`，与包名命名空间隔离；`PANEL_ID` 来自 `shared/identity.ts`。
3. 页面自己负责布局（`main` 槽只给中栏容器）：照抄 Plugin Manager 的 `page`/`pageBody` 骨架与主题 token（`--dsw-alias-*`）。
4. client bundle 只能 `require` 11 个 platform seed + `dsh.client.external`；其他宿主能力一律走 Cordis 服务；首版单文件，不用动态 `import()` 拆包。
5. 文案走 Client locale 服务 + 包 `locale/*.json` 双层；中英文都要齐。

## 5. 里程碑

| 阶段 | 内容 | 验收 |
|---|---|---|
| **M0（已完成）** | 包脚手架、构建/打包/校验管线、配置、展示资源、三份调研 + 架构/决策/发布文档 | `pnpm run verify` 全绿；`npm pack` 清单闭环 |
| M1 | Host 删除核心：capabilities/resolve/trash/delete + storageDomain + 单元/集成测试（临时 `DSH_HOME` fixture） | 不接 UI 也能通过临时 profile 命令验证 trash/restore/purge/级联 |
| M2 | Web 管理页：main panel + sidebar 入口 + bridge 客户端 + 列表/筛选/详情 | 临时 profile 安装后页面可用；危险操作确认/错误码可见 |
| M3 | 命令 + 只读工具 + 批量操作 + 回收站页面 | 无 UI 场景可用；模型只能读 |
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

- 调研：[`dsh-host-apis.md`](./dsh-host-apis.md) · [`dsh-web-ui.md`](./dsh-web-ui.md) · [`dsh-packaging-contract.md`](./dsh-packaging-contract.md) · [`../research/codex-session-management.md`](../research/codex-session-management.md)
- 决策：[`decisions.md`](./decisions.md) · 发布：[`publishing.md`](./publishing.md) · 用户文档：[`usage.md`](./usage.md)
