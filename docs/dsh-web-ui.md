# DSH Web UI 扩展面调研（Threadloom 会话管理 UI）

> ⛔ **已被取代（2026-10-27）**：本文是第一版调研，存在两个已确认的问题：① **表面混淆**（把 GUI/Remote/Host API 的「有」当成 agent tool 面的「有」）；② **版本口径混淆**（把 checkout HEAD 行为写成 `0.2.1-rc.3` 发布版事实，例如 fork 的 `parentSession`、`/api/session.markdown`）。
> 结论以 [`research/dsh-session-management-v2.md`](../research/dsh-session-management-v2.md) 为准；本文仅保留作源码索引。

> 调研对象：`/home/leoric/code/deepseek-harness`（DSH 0.2.1-rc.3，即当前 `dsh web` 进程的工作目录；`pnpm dsh web --no-open` 以 tsx 直接跑源码，见 `ps` 中 cwd）。
> 目标：回答「会话管理 UI 该怎么挂到 DSH Web 上」，给出**可直接照抄的 slot key、注册选项、props、服务签名、客户端构建约束与风险**。
> 本文只做调研；不写插件代码、不改 DSH checkout、不改 profile。

---

## 0. TL;DR（MVP 结论）

1. **MVP 推荐形态 = 独立管理页**：注册一个 keyed `main` 面板（`name:'main', key:'threadloom'`）作为页面本体，同时注册一个 `sidebar.panellist` 入口（`id:'threadloom'`，与面板 key 一致）作为侧栏导航行。这与官方 Plugins 页（`ui-plugin-manager`）和已发布的第三方插件 dshmarket 市场页完全同构，是宿主公开契约里唯一「一键直达的整页目的地」。
2. **不要**替换 `sidebar.workspaces`（single 槽已被 ui-workspace 占用，替换会连带删掉搜索/分组/行菜单/对话框）；**不要**把管理页塞进会话行菜单当主入口（行菜单适合 1 个动作，不适合列表页）。
3. **关键事实修正（与文档 `research/codex-session-management.md` 的「DSH 现状」不同）**：当前 checkout 的侧栏**已经**有 rename / pin / fork / archive / copy-session-id 的行菜单与 hover 按钮，Host 侧也已有 `session/rename`、`workspace/pinSession|unpinSession|archiveSession|unarchiveSession` 等 Remote（见 §5.3）。Threadloom 的空白点因此变为：**整页跨 workspace 列表/检索 + 详情 + 删除/回收站 + 批量操作**，而不是从零补 rename/pin/archive。
4. 列表、搜索、改名、置顶、归档/取消归档**不需要新增 Host 能力**，客户端可直接调现有 Remote；**只有「删除/回收站」需要自建 Host 桥**（外部 npm 插件无法新增 `@Remote` 命名空间，原因见 §6）。
5. 客户端插件交付契约：`package.json` 声明 `dsh.client.platform:"web"` + `exports["./client"]` + `dsh.bundle.patch`；`./client` 产物是 `window.__ModuleLoader__.load({ id, factory })` 形式的经典脚本；factory 里只能 `require` 平台种子模块（`react` 等）或 `dsh.client.external` 声明的模块，其余宿主包一律通过 Cordis 服务（`export const inject`）拿，不许 `import`（§7）。

---

## 1. 调研方法与限制

- **权威来源**：源码 checkout（宿主进程 cwd = `/home/leoric/code/deepseek-harness`）中的 slot 契约文件、客户端插件源码、构建产物，以及已安装第三方插件的真实 client bundle：
  - `/home/leoric/.dsh/profiles/web/node_modules/dshmarket/client/client.js`（1.71.1，采用「main + sidebar.panellist」整页模式）
  - `/home/leoric/.dsh/profiles/web/node_modules/dsh-intelligent-ui/lib/client.js` + `src/`（采用「Host webServer 前缀路由 + 客户端同源 fetch」自定义数据桥）
- **本次 live 校验失败（限制）**：多次调用 `cordis_inspect_query`（platform=client，provider=`Slots`/`Service`/`Builtin`/`Theme`）均 10s 超时（`Client inspect query ... timed out`）。Host 端 provider 清单能列出这些 client provider，说明页面侧 manifest 已同步过，但查询无响应——可能是页面为旧 build/连接代际问题。因此**本文 slot key 与 props 均来自源码契约**（源码、`lib/client.js` 构建产物与当前 commit 一致：`packages/client/*/lib/client.js` mtime 09:37–09:38，晚于 src 的 10-26），并在 §11 给出页面恢复后的复核命令。发布前必须复核一次 live slot 树。
- 未运行任何安装/构建/修改命令。

---

## 2. Web 客户端 UI 架构（读懂这一节才能正确挂载）

### 2.1 渲染树与槽位

Web 页面的根是一个内置 `root`（single）槽，由 `ui-layout` 的 `AppFrame` 占用，并在同一次 `register()` 里声明全部子槽（**声明即独占渲染权**）：

| 槽 key | kind | 位置/说明 | 源码 |
|---|---|---|---|
| `root` | single | 应用根；**禁止**注册（会顶掉整个 AppFrame） | `packages/client/ui-renderer/src/client/registry.ts:29-56` |
| `sidebar` | single | 整条左栏，被 `ui-sidebar` 的 `SidebarRoot` 占用 | `ui-layout/src/client/index.ts:58-68` |
| `main` | keyed | 中栏，按「当前全局面板 id」分发；key `'conversation'` 留给会话 | `ui-layout/src/client/index.ts:69-73`；`AppFrame.tsx:40-43` |
| `rightbar` | single | 右栏 | `ui-layout/src/client/index.ts:74-87` |
| `shell.bottom` | single | 三栏下方通栏 | `ui-layout/src/client/index.ts:88-94` |
| `shell.overlay` | list | 全框浮动层（可点击穿透），toast/浮层用 | `ui-layout/src/client/index.ts:95-105` |
| `shell.leading` | single | 窗口左上角窗框位（macOS 折叠侧栏时） | `ui-layout/src/client/index.ts:106-119` |

`AppFrame` 用 `renderSlot('main', {}, { entryKey: panelId ?? 'conversation' })` 渲染中栏（`AppFrame.tsx:40-43`；顶层调用 `AppFrame.tsx:246-248`）。布局服务 `ctx.layout` 提供 `selectPanel(id|null)`、`panelInfo` 等（`ui-layout/src/client/service.ts:24-68`；`selectPanel` 在 `:72-78`，未注册的 panel id 会抛错）。

### 2.2 注册模型

`ctx.slots.register(options, Component)` 一次调用同时完成四件事：贡献组件、声明子槽（`children`，声明即该 entry 独占渲染授权）、申请 store 座位（`store`）、提供业务注入面（`inject`）。核心类型在 `packages/client/ui-slots/src/index.ts`：

- 注册选项（`BaseOptions` + `KindOptions`，`:768-838`）：
  - `name`：目标槽 key（必填）；
  - keyed 槽：`key`（必填）、`priority`（同 key 同 priority 抛错，低者渲染）；
  - list 槽：`id`（必填）、`order`、`label`（string 或 thunk，按当前 locale 惰性取）、`priority`；
  - `children`：子槽声明表；
  - `store`：共享 handle（`apply` 构造）或工厂；
  - `locale`：声明后组件 props 获得框架注入的 `t` 翻译座位（必须已安装该 namespace 字典，否则渲染直接报错）；
  - `inject`：注册方业务注入面工厂（`() => ({...})`，按声明的参数推导，list 槽常见 `(props) => ...`）。
- `ctx.slots.inject(slotKey, callback)`（`ui-renderer/src/client/registry.ts:209-272`）：等该槽被声明时才执行 callback，注册随声明生命周期自动重装/销毁。**插件 UI 推荐用它包住每次 register**（dsh-intelligent-ui 的每个槽注册都这么写）。
- 组件 props = owner share（父组件 renderSlot 传的）+ keyed key props + 槽注入面 + store + **standard kit** + locale `t`（`ui-slots/src/index.ts:236-262` 的 `GlobalStandardProps`/`ScopeStandardProps`）。

### 2.3 root scope 的 standard kit（管理页的免费数据通道）

root scope 组件（如 `main` 页面）会自动收到以下 hook props，由宿主包通过 `provideRoot` 合并，**无需 import、无需声明**（hook key → prop 名规则见 `ui-slots/src/renderer.ts:42-44`）：

| prop | 类型 | 提供方 |
|---|---|---|
| `useSessions(selector)` | `SnapshotSelectorHook<SessionListState>` | `ui-session/src/client/index.ts:157-164`（`provideRoot` 在 `:697-708`） |
| `useSessionStatus(selector)` | 会话 UI 状态（running/pendingInteraction/completionUnread） | 同上 |
| `useSessionRetainInfo(id)` | 本地引用计数（不 retain、不开历史） | 同上 |
| `useSessionAccess(id, action)` | 非 owner Peer 的 endpoint 授权判断 | 同上 |
| `useWorkspaces(selector)` | `SnapshotSelectorHook<WorkspaceSnapshot>` | `ui-workspace/src/client/index.ts:72-77` |
| `useWorkspaceAccess(id, action)` | workspace endpoint 授权判断 | 同上 |
| `usePanelInfo(selector)` | `PanelInfo{activePanelId}` | `ui-layout/src/client/index.ts:48-51` |

管理页的列表/分组/归档/置顶状态都可以只靠这些 props 渲染。

---

## 3. Slot 清单（按 UI 用途分类，全部为已验证 key）

### 3.1 整页面板（MVP 选它）

| slot key | kind/scope | 注册选项 | 组件 props（owner share） |
|---|---|---|---|
| `main` | keyed / root | `key` = 面板 id；可另带 `children` / `store` / `inject` / `locale` | 无 owner props；root standard kit + `t`（若声明 locale） |
| `sidebar.panellist` | list / root | `id` 必须等于面板 key；`order`（官方 Plugins=0；dshmarket=1；建议本插件 2）；`label` 建议 thunk | `{ size: number; active: boolean }`（`ui-sidebar/src/client/contract/slots.ts:73-78`） |
| `sidebar.panellist.actions` | list / root | `id`/`order` | `{ entries, onOpen(id), onPinnedChange(id,pinned), onDismiss() }`（`ui-sidebar/src/client/contract/slots.ts:120-143`；用户可把非固定面板从侧栏 unpin 到 More 菜单，Plugins 固定，`panel-pins.ts:5`） |

证据：
- `main` 契约：`ui-layout/src/client/index.ts:69-73`；`main` 子槽声明：`:178-190`；面板互斥渲染：`AppFrame.tsx:40-43`；布局服务保留已注册面板 key（`:166-176`）。
- `sidebar.panellist` 契约：`ui-sidebar/src/client/contract/slots.ts:36`；声明：`ui-sidebar/src/client/index.ts:88`；侧栏行渲染与点击选择面板：`SidebarRoot.tsx:67-83`（`selectPanel(id)`），注入的 `selectPanel` 即 `ctx.layout.selectPanel`（`ui-sidebar/src/client/index.ts:76`）。
- 官方 Plugins 页的完整范式（**可直接照抄结构**）：`ui-plugin-manager/src/client/index.ts:82-83`（`PANEL_ID='plugins'`）、`:86`（inject 服务列表）、`:129-149`（`main` 面板注册 + 页面内子槽声明）、`:150-165`（按 activePanelId 重置视图、对外提供 `pluginNavigation`）、`:167-173`（`sidebar.panellist` 图标行）。
- 第三方 dshmarket 的同构写法（**外部插件事实标准**）：`node_modules/dshmarket/client/client.js:16508`（`SIDEBAR_PANEL_ID="dsh-market"`）、`:16721-16737`（先 `name:"main", key:SIDEBAR_PANEL_ID`，再 `name:"sidebar.panellist", id:SIDEBAR_PANEL_ID, order:1, label:()=>t("nav")`），其注释明确写道：「Opening the row selects a `main` panel, so the market renders as a page — the only one-click destination the host's public contracts allow.」

### 3.2 侧栏内嵌（不适合做管理页主入口，可做轻量增强）

| slot key | kind/scope | owner props / 用途 |
|---|---|---|
| `sidebar.workspaces` | single / root | `{ wide, expandSidebar }`；**已被 ui-workspace 占用**，替换会丢搜索/分组/行菜单/rename/archive 对话框（契约：`ui-sidebar/src/client/contract/slots.ts:39-45`；README 明确「declaring is claiming」） |
| `sidebar.workspaces.session.menu.item` | list / root | `{ sessionId, displayTitle }` + `useMenuOpenState()` hook；每项渲染一个 `role="menuitem"` button，`order` 决定位置。宿主已占 id：`pin`(100) `rename`(200) `fork`(300) `archive`(400) `session-id`(450)（`ui-workspace/src/client/contract/slots.ts:152-195`） |
| `sidebar.workspaces.session.row.action` | list / root | 同上 owner props；hover 行尾按钮。宿主已占：`archive`(100) `pin`(200)（`:196-205`） |
| `sidebar.session.row.leading` / `.trailing` / `.hover` | list（leading/trailing inline）/ root | 只有 `{ sessionId }`，用于装饰性小图标/悬浮信息，不可绑定会话（`ui-workspace/src/client/contract/slots.ts:128-151`） |
| `sidebar.toggle.badge` / `sidebar.footer.action` / `sidebar.brand.*` | single/list | 侧栏徽标、设置旁动作、品牌位（`ui-sidebar/src/client/contract/slots.ts:20-56`） |

结论：若想「在侧栏补一个入口动作」（如跳到管理页），`sidebar.workspaces.session.menu.item` 加一项 `threadloom.manage` 即可；但整页管理仍应走 §3.1。

### 3.3 设置页（二期可选）

| slot key | kind/scope | 说明 |
|---|---|---|
| `settings.section` | list / root | 每个 entry 是一个设置页；选项 `id`/`order`/`label`；owner share `{ close() }`（`ui-settings/src/client/contract/slots.ts:57-64`、`:118-126`）。设置对话框的开关状态由宿主 shell 私有——外部插件无法直接「一键打开某个 section」（dshmarket 源码注释确认） |
| `settings.plugins.tab` | list / root | Plugins 设置区里的一个 tab（`:66-73`） |
| `settings.general.item` | list / root | General 区一行偏好设置（`:92`） |
| `settings.action` | list / root | 设置内容列头部动作（`:39-44`） |

适合放「删除保留期 / 回收站策略 / 默认过滤」等配置，不适合放大列表。

### 3.4 其他可用的通配槽

- `shell.overlay`（list/root）：全部浮层（确认框、toast、批量操作条）。注册示例见 `ui-plugin-manager/src/client/index.ts:122-128`；注意该层默认点击穿透，entry 自己恢复 `pointer-events`。
- Plugins 页子槽（只有 `ui-plugin-manager` 存在时）：`plugins.tab` / `plugins.item` / `plugins.bundle.config` / `plugins.row.config` / `plugins.detail.actions|badge|section`（声明在 `ui-plugin-manager/src/client/index.ts:139-147`；契约见 `ui-plugin-manager/src/client/slot-contract.ts`）。dshmarket 就把「发现」tab 注册进 `plugins.tab`（`client.js:16807-16828`）。**不推荐**把会话管理挂到 Plugins 页——语义不符。

---

## 4. 推荐挂载方案（MVP）

### 4.1 方案对比

| 方案 | 入口 | 空间 | 适合度 | 结论 |
|---|---|---|---|---|
| (a) `main` + `sidebar.panellist` 独立页 | 侧栏固定行（可 unpin 到 More） | 中栏整页 | 列表+筛选+详情抽屉+批量操作 | **MVP 采用** |
| (b) 嵌入会话列表侧栏 | 行菜单 / row seat | 窄 | 只适合单动作 | 二期做「管理此会话」快捷项 |
| (c) 设置页 `settings.section` | Settings → 导航 | 弹窗内容列 | 配置项；列表页空间不足 | 二期配置页 |
| (d) Plugins 页 tab | Plugins 页内 tab | 中栏 | 语义不符 | 不采用 |

### 4.2 精确注册骨架（JS，第三方客户端 bundle 内）

```js
// ctx = 客户端插件 apply 的 Cordis Context；NS = 本插件 locale namespace
const PANEL_ID = 'threadloom'

// 页面本体：keyed main 槽；两者同生命周期注册
ctx.slots.inject('main', () => ctx.slots.register({
  name: 'main',
  key: PANEL_ID,                 // 与 sidebar id 相同
  locale: NS,                    // 组件 props 获得 t()
  // children: { ... }           // 可选：给页面内部留子槽（MVP 不需要）
}, Page))                        // props: { t, useSessions, useSessionStatus, useSessionAccess, useWorkspaces, useWorkspaceAccess, usePanelInfo }

// 侧栏入口：list 槽；id 必须与面板 key 一致
ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
  name: 'sidebar.panellist',
  id: PANEL_ID,
  order: 2,                      // Plugins=0, dshmarket=1
  label: () => t('panel'),       // thunk：语言切换时无需重注册
  locale: NS,
}, Icon))                        // props: { size, active, t }
```

要点与坑：

1. **两个注册放在同一 effect/同一 `ctx.effect` 生命周期里**。row 先于 page 注册或 row 残留而 page 已卸载时，用户点侧栏行会走到 `ctx.layout.selectPanel(id)` 并抛 `main panel "..." is not registered`（`ui-layout/src/client/service.ts:72-78`）。推荐顺序：先注册 page，再注册 row；卸载时先销毁 row 再销毁 page（或干脆放在同一 dispose 组里由框架逆序）。
2. 面板 id 用包名命名空间（如 `threadloom`），避免与其他插件撞 key（keyed 槽同 key 同 priority 会抛错）。
3. `usePanelInfo(info => info.activePanelId === PANEL_ID)` 判断本页是否激活；点会话行跳会话用 `ctx.uiWorkspace.openSession(sessionId)`，它会 `selectPanel(null)` 回到 Conversation（`ui-workspace/src/client/navigation.ts:293-295`、`:520`/`:552`）。`ctx.uiWorkspace` 是 ui-workspace 提供的客户端服务（`navigation.ts:195` `super(ctx,'uiWorkspace')`），dsh-intelligent-ui 也在用（`lib/client.js` `inject` 列表）。
4. **页面自己负责布局与滚动**：`main` 槽只给一个中栏容器，没有内建 padding/标题。直接照抄 Plugin Manager 页的页面骨架：`.page`（`height:100%`、`padding:0 clamp(24px,4vw,48px)`）、`.pageBody`（`flex:1; min-height:0; overflow-y:auto`、内容列 `max-width:960px`、头行 28px 顶 inset），见 `ui-plugin-manager/src/client/PluginManagerPage.module.css:1-90`；页面结构 `PluginManagerPage.tsx:1618-1700`（`<section class=page> <div class=pageBody> <header class=pageHead> ...`）。Web 版不需要 `data-window-drag`（那是 Electron 拖拽窗）。
5. 页面内需要浮层（重命名框、删除确认、回收站确认）时，注册到 `shell.overlay` 并用自己 plugin 的 state 驱动，参考 `ui-plugin-manager/src/client/index.ts:122-128`。

---

## 5. 数据来源与服务签名

### 5.1 只读列表（推荐路径，无需直接碰 remote）

```ts
// SessionListState（api/session-controller/src/client/sessions/service.ts:61-73）
interface SessionListState {
  ids: SessionId[]
  byId: Record<SessionId, SessionSummary>
  phase: 'pending' | 'ready'
  projectionsBySession: Record<SessionId, SessionProjectionSnapshot>
}
// SessionSummary（同文件 :27-59）关键字段：
// id, title?, displayTitle, cwd?, parentId?, origin?: 'subagent',
// formatStatus?: 'current'|'migration-required', running, retainedBy, blank,
// updatedAt, projectionValues?: Partial<SessionProjectionSummaryValues>
```

- 行数据：`const ids = useSessions(s => s.ids)`、`const row = useSessions(s => s.byId[id])`（选择器订阅最小切片）。
- 详情可用投影值（list row 的 `projectionValues`，均为宿主算好的值）：`title`、`sessionListMetadata{blank,lastPromptAt}`、`agentPreset`（`packages/preset/agent-preset-registry/src/types.ts:50-55`）、`modelSelection`、`tokenUsage`、`contextPressure`、`contextBreakdown`、`inbox`、`subagentCatalog`、`subagentTiming` 等（各域 `SessionProjectionMap` 合并；汇总类型定义在 `packages/session/session-projection/src/types.ts:53-67`）。
- Workspace 分组/归档/置顶集合：

```ts
// api/workspace-controller/src/client/model.ts:32-41
interface WorkspaceSnapshot {
  items: readonly WorkspaceView[]           // workspaceId, title, path, sessionIds...
  archivedSessionIds: readonly SessionId[]  // 全局归档集合
  pinnedSessionIds: readonly SessionId[]    // 全局置顶集合（最近置顶在前）
  state: 'idle'|'loading'|'error'; phase: 'pending'|'ready'; error: RemoteFailure|null
}
```
`useWorkspaces(s => s.items)`、`s => s.archivedSessionIds`、`s => s.pinnedSessionIds`。`WorkspaceView.sessionIds` 是 Host 记账的会话 id 列表（`api/workspace-controller/src/types.ts:18-25`），可与 `useSessions().byId` join 得到「workspace → 会话」。

### 5.2 客户端服务（imperative，非 React 路径）

| 服务 | 关键成员（签名以源码为准） | 源码 |
|---|---|---|
| `ctx.sessions` | `list: ObservableSnapshot<SessionListState>`、`retain(target,{source,signal?})`、`using(target,{source,signal?},op)`、`retainInfo(id)`、`refresh()`、`refreshProjections(id)`、`search(query,signal): Promise<RemoteResult<{items,hasMore}>>`、`searchResultLimit`、`create(opts)`、`fork(opts)`、`binding(id)`、`subagentAddress(id)` | 类型 `api/session-controller/src/client/contract/sessions.ts:49-190`；实现 `.../sessions/service.ts:238+`（`:270` `reflect.provide('sessions', ...)`） |
| `ctx.workspaces` | `list: {getSnapshot,subscribe}`；`archiveSession(id,{stopActivity?})`、`unarchiveSession(id)`、`pinSession(id)`、`unpinSession(id)`、`insertSessionBefore(workspaceId,sessionId,before?)`、`rename`/`delete`/`create`/`initializeDefault` | `api/workspace-controller/src/client/service.ts:47-136`（类 `:118+`） |
| `ctx.uiWorkspace` | `openSession(target)`、`openWorkspace(id,...)`、`startSession(...)`、`forkSession(...)`、`whenAccess(...)` | `client/ui-workspace/src/client/navigation.ts:195`；`openSession` `:293-295` |
| `ctx.uiSession` | `adapter.current`（当前会话 source）、`whenAccess(id,action,cb)`、`provide(...)` | `client/ui-session/src/client/index.ts:317`、`:376-379` |
| `ctx.layout` | `panelInfo: HostObservable<PanelInfo>`、`selectPanel(id|null)`、`toggleSidebar()`、`beginNavigation(): AbortSignal` | `client/ui-layout/src/client/service.ts:24-68` |

### 5.3 Host Remote 命名空间（`ctx.remote.*`）

客户端可由插件调用的命名空间是**构建期固定**的（`api/remotes/src/client/index.ts:6-30` 逐一 mount 的生成物）。与会话管理相关的命名空间/方法（签名来自生成的 `lib/typert.remote-client.d.ts`）：

```ts
// ctx.remote.session（api/session-controller/lib/typert.remote-client.d.ts:1-50）
list(_request: {cursor?: string}, signal?): Promise<RemoteResult<{items: SessionSummary[]}>>
search({query: string}, signal?): Promise<RemoteResult<{items:{sessionId,snippet}[], hasMore:boolean}>>
rename({sessionId, title}): Promise<RemoteResult<{title, seq}>>
fork({sessionId, atSeq?, allowMigration?}): Promise<RemoteResult<{sessionId}>>
create({workspaceId?|cwd?, sessionId?, agentPreset?}): Promise<RemoteResult<{sessionId, agentPreset?}>>
selectModel({sessionId, provider, model, reasoningEffort?}): Promise<RemoteResult<...>>
modelCatalog(): Promise<RemoteResult<ModelCatalog>>
page({address, cursor?, turnWindow?, ...}, signal?): Promise<RemoteResult<SessionPage>>
follow({address, ...}, signal?): RemoteStreamHandle<SessionFollowFrame>
projections({sessionId}, signal?): Promise<RemoteResult<SessionProjectionsValue|null>>
prompt/cancel/updateQueue/attachment/...（会话内操作用）

// ctx.remote.workspace（api/workspace-controller/src/index.ts:90-192）
archiveSession({sessionId}): Promise<RemoteResult<{archivedSessionIds}>>
unarchiveSession({sessionId}): Promise<RemoteResult<{archivedSessionIds}>>
pinSession({sessionId}): Promise<RemoteResult<{pinnedSessionIds}>>
unpinSession({sessionId}): Promise<RemoteResult<{pinnedSessionIds}>>
insertSessionBefore({workspaceId, sessionId, beforeSessionId?}): Promise<RemoteResult<WorkspaceValue>>
follow(signal?): RemoteStreamHandle<WorkspaceFollowFrame>   // :205-230
```

`session/list` 的 Host `SessionSummary` 字段（`api/session-controller/src/types.ts:149-162`）：`agentAvailable, formatStatus?, sessionId, updatedAt, running, blank, parentSessionId?, origin?, cwd?, projections?`；list 响应按活动时间排序，空 `_request` 即可（`src/index.ts:265-277`），支持 `cursor`（当前实现保留字段）。`session/search` 上限 `SESSION_SEARCH_RESULT_LIMIT=20`、snippet 240 codepoints（`src/types.ts:164-175`）。

**客户端依赖声明**（Cordis 服务名）：`export const inject = ['slots','locale','sessions','workspaces','uiSession','uiWorkspace','layout','remote','remote.session','remote.workspace']`。
只读列表 + 导航时至少需要 `slots`、`locale`、`layout`、`uiWorkspace`；调 remote 必须同时注入 `'remote'` 与 `'remote.<ns>'`（规则见 `docs/api-gateway.md:62`）。

### 5.4 权限（access control）

- 所有 Remote 对非 owner Peer 走 `remoteAccess` 决策；页面用 root standard hooks 渲染前判断：`useSessionAccess(sessionId, 'session/rename' | 'session/fork' | 'workspace/pinSession' | 'workspace/unpinSession' | 'workspace/archiveSession' | 'workspace/unarchiveSession')`、`useWorkspaceAccess(workspaceId, ...)`、`useRemoteAccess('session/create')`。
- endpoint 字符串已由宿主 UI 大量使用，可照抄：`ui-workspace/src/client/session-actions/*.tsx`（`ForkSession.tsx:17`、`ArchiveSession.tsx:38`、`PinSession.tsx:23`、`RenameSession.tsx:25`、`Rows.tsx:257`）。
- owner（本机 Web 页）永远放行；非 owner 页面可能被 Host 过滤或拒绝，UI 层按 hook 结果隐藏按钮，Host 仍是最终权威。

### 5.5 刷新语义（重要）

- **会话列表**：`ctx.sessions.list` 由三路共同维护，页面用 `useSessions` 自动跟随：
  1. `session/control` 快照流推送的投影帧（**标题** `title` 键走这里，`manager.ts:781-797`）；
  2. `api-session/added|removed|status|activity|error` 转发事件（Host 发射：`session-controller/src/index.ts:212-228`；Client 处理：`client/index.ts:116-123`）；
  3. 显式 `ctx.sessions.refresh()`（Host 权威重拉；冷会话的 cached hints 会合并）。
  因此 **rename/pin/archive 之后列表通常自动更新**（rename 的返回值 `{title,seq}` 也会被 Session 对象写进投影，页面若直接调 remote 则等 control 帧即可，必要时再 `refresh()`）。
- **workspace 分组/归档/置顶集合**：`ctx.workspaces.list` 由 `workspace/follow` 流帧 `baseline|replace|upsert|remove|order|archived|pinned` 维护（`workspace-controller/src/index.ts:205-230`；Client 流 `client/index.ts:63-90`、`model.ts:43-57`），unary 成功还会本地回显。故 pin/archive 后 `useWorkspaces` 自动变。
- **连接重置**：`connection/reset` 事件让缓存重拉（`client/connection/src/client/index.ts:24-32`）；插件不要缓存跨代数据。
- **自定义删除（§6）**：Host 删除冷会话不会自动触发上述两条流（`api-session/removed` 只在活会话 `session/disposed` 时发，`session-controller/src/index.ts:215-217`）。页面删除成功后必须自己 `await ctx.sessions.refresh()`；workspace 列表里残留的已删 id 用「与 `byId` join」的方式过滤即可（不要为此写 workspace registry）。

---

## 6. 自定义 Host 能力桥（删除/回收站）

### 6.1 为什么外部插件不能新增 `@Remote` 命名空间

- Remote 命名空间/方法由 DSH **构建期 Typert 生成**：`@Remote` 装饰器 → `scripts/generate-typert.ts` 用 Host 聚合 `ts.Program` 生成 `typert.host.*` / `typert.remote-client.*`；客户端只能 mount `api-remotes` 装配时选定的贡献（`docs/api-gateway.md:100-134`、`:62`；`packages/api/remotes/src/client/index.ts:6-30`）。
- 客户端不会从运行中的 Host 发现装饰器；SRC fallback 只解决 Host 分发，且 Client 会拒绝缺少 strict codec 的 SRC descriptor（`docs/api-gateway.md:136-160`）。
- 因此：**发布到 npm 的独立插件无法给 Web 端新增 `ctx.remote.threadloom`**。删除/回收站必须走其它桥。

### 6.2 可用桥对比（推荐排序）

| 桥 | Host 端 | Client 端 | 优点 | 代价 |
|---|---|---|---|---|
| **A. webServer 前缀路由**（推荐，真实第三方插件在用） | `ctx.webServer.register({kind:'prefix', path:'/threadloom/api', handler})` + 处理函数首行 `ctx.connection.requestRejection(req)` 判 401/403 | 同源 `fetch('threadloom/api/delete', {method:'POST', ...})`（**document-relative**，无前导 `/`，兼容反向代理挂载） | 最直观、JSON 自由、可流式；与 `intelligent-ui` 生产实现一致 | 自己校验 JSON/大小/CAS；无 Remote 的 typert 严格 schema；`requestRejection` 只做 Host/Origin + cookie 认证，方法级鉴权（owner-only）由连接层决定 |
| **B. exact Connection Fetch route** | `ctx.connection.fetch.register({path:'/api/threadloom/delete', methods:['POST'], requestBody:'buffered', fetch})` | `fetch('/api/threadloom/delete', ...)` | shipped 官方 seam（file-upload 就这么做）；exact route 对非 owner 恒 403 | 只有 owner 可用（对本机 Web 管理页足够） |
| **C. 通用 RPC channel** | `ctx.connection.rpc.handle('/rpc/threadloom', handler)` | `ctx.connection.rpc.call('/rpc/threadloom','delete',payload,signal)` 返回 `{ok,value}|{ok:false,error}` | 自带 RPC 信封、Peer 身份、`AbortSignal`、请求关联 | 契约更底层；需要自己处理 method 路由与错误码 |
| **D. commands 桥** | `ctx.commands.register(...)` | `ctx.remote.commands.execute(agentId, line, attachments)` | DSH skill 的 user-actions 指南提到 | **需要 Agent/Session 激活**（`execute(agent,...)`，`interaction/commands/src/index.ts:360-366`），不适合删除冷会话/管理页 |

证据：
- 方案 A 的真实实现：`dsh-intelligent-ui/src/index.mjs:31`（`web.webServer.register({kind:'prefix', path:'/intelligent-ui/api', handler})`）、`src/host/service.mjs:54-58`（先 `ctx.connection.requestRejection(req)` 再路由）、`src/client/host/pane.jsx:60` / `repair.mjs:36`（`fetch('intelligent-ui/api/state?...')` 相对路径）。
- `WebRoute` 契约：`packages/host/webserver/src/index.ts:48-58`，`register` 在 `:445`。
- 方案 B 的官方实现：`packages/client/file-upload/src/index.ts:79-86`（`ctx.connection.fetch.register({path:'/api/session/uploadFileBinary', methods:['POST'], requestBody:'streaming', fetch})`），路径常量 `src/protocol.ts:2`。接口定义：`packages/client/connection/src/rpc.ts:146-180`（`ConnectionFetchRoute`/`HostConnectionFetch`）。
- 方案 C 契约：`connection/src/rpc.ts:136-141`（`ConnectionRpcHandler`）、`:169-230`（`HostConnectionRpc.handle/intercept`）；Host 实现 `rpc-host.ts:253-277`（`handle` 挂 prefix WebRoute）与 `:279-301`（`intercept` 仅 `/api`）；Client `ClientConnectionRpc.call` 在 `connection/src/rpc.ts:295+`；`ConnectionHandle.rpc` 暴露于 `client/index.ts:149-187`。
- 方案 D：`interaction/commands/src/index.ts:285-290`（`ctx.commands.register`）、`:314-320`（`list` remote）、`:360-366`（`execute(agent,...)`）。

### 6.3 推荐接口形状（MVP：删除 + 回收站）

Host 插件（`index.js`，Node 半）建议：
1. `export const inject = ['webServer', 'connection', ...]`（Host 服务名以 Host 团队调研为准；`ctx.webServer`/`ctx.connection` 均已验证存在）；
2. 注册 `ctx.threadloom` Host service（delete/trash/listTrash/restore/purge），实现放服务里，**不要**把逻辑写进路由 handler；
3. 路由 `POST /threadloom/api/<method>`：`requestRejection` → 读限长 JSON → 调服务 → `{ ok: true, value } | { ok:false, error:{ code, message } }`；错误码用稳定字符串（如 `threadloom/session-running`、`threadloom/not-found`）；
4. Client 页面用相对 `fetch` + 同源 cookie；成功后 `await ctx.sessions.refresh()` 并本地移除行；
5. 危险操作分级（对齐 Codex）：archive（已有）→ 回收站（可恢复）→ 永久删除（UUID 强确认、级联子代理提示 N 条）。

> 注意：删除正在运行的会话属于 Host 语义问题（先停 turn 或拒绝，参考 Host `workspace/archiveSession` 对 running work 的 `workspace/session-active` 拒绝模型，`api/workspace-controller/src/index.ts:154-162`）；该决策记录在 README 待决问题中，UI 文档不擅自定案。

---

## 7. 客户端插件构建契约（发布到 npm 的关键约束）

### 7.1 `package.json`（双半 package）

```jsonc
{
  "name": "@yourscope/threadloom",
  "type": "module",
  "exports": {
    ".": "./index.js",              // Host 半（apply / Config）
    "./client": "./client.js",      // 浏览器半（bundle）
    "./locale/*.json": "./locale/*.json",
    "./icon": "./icon.svg"
  },
  "dsh": {
    "bundle": { "patch": "./cordis.patch.yml" },   // Host row 装载
    "client": {
      "platform": "web",            // 必填；只认 'web'
      "inject": ["@deepseek-ai/dsh-client-locale", "..."], // 见 7.6
      "external": []                // 非基线模块请求；见 7.4
    }
  },
  "files": ["index.js", "client.js", "cordis.patch.yml", "locale/*.json", "icon.svg"]
}
```

- 宿主扫描激活的 Loader entry，读取其包 `package.json.dsh.client`，要求 `platform === 'web'` 且 `exports["./client"]` 存在（`packages/client/modules/src/index.ts:890-925`）；`dsh.client` 字段校验规则见 `modules/src/client/manifest.ts:166-193`（`platform` 字符串、`inject`/`external` 字符串数组、`immediately` 布尔）。
- 包的 loader name 解析到包根后，`<pkg>/client` 与裸包名都会归一化到同一 row（`manifest.ts:209-220`）。
- 只有 `platform:'web'` 的包会进入 Web 图；`bundle.patch` 负责把 Host row 插进 profile（见 skill `references/host-plugin.md`）。

### 7.2 浏览器产物格式

- `client.js` 是**经典脚本**，执行时只做一件事：`window.__ModuleLoader__.load({ id: "<package name>", factory: (require) => { ...; return module.exports } })`。示例：`dshmarket/client/client.js:1`、`dsh-intelligent-ui/lib/client.js:1`。
- **懒物化**：执行 bundle 只注册 factory；模块体副作用（含 CSS 注入）在 factory 内、首次 import 时才跑并缓存（`modules/src/client/manifest.ts:1-22` 的 lazy CJS 模型注释）。factory 导出的对象须含 `apply(ctx)` 与 `inject = [...]`（Cordis 插件形态），可含 `name`、`Config`。
- `id` 必须等于包名（或 `<包名>/client`，会被 strip 归一化；否则 row 找不到 factory 报错）。
- factory 必须**无副作用**（不要在 factory 顶层碰 DOM/注册全局）；所有 CSS/style/timer/listener 用 `ctx.effect(() => {...; return dispose})` 挂在 apply 里。第三方真实写法：`dsh-intelligent-ui` 在 apply 内 `style.dataset.plugin=...; document.head.append(style); return () => style.remove()`。
- 可拆分 package-local chunk（`client.<hash>.js`，`require.async/import`），但会多一层 /plugins 路由约束；MVP 建议单文件。

### 7.3 平台模块表（能 `require` 的模块）

`client/web/src/platform.ts:8-15`：
`react`, `react/jsx-runtime`, `react-dom`, `react-dom/client`, `@deepseek-ai/cordis`, `zod`, `@tanstack/react-virtual`, `@deepseek-ai/dsh-client-store`, `@deepseek-ai/dsh-client-ui-slots`, `@deepseek-ai/dsh-client-ui-primitives`, `@deepseek-ai/dsh-client-ui-dockkit`。

其余 `@deepseek-ai/*` 运行时值一律禁止跨插件 import；构建期有「bundle purity gate」兜底（`packages/client/tsdown.client.ts:838-856`：不在基线 / 不在 `dsh.client.external` / 非 inline-safe / 非生成 `/remote` 的一律 build error；type-only import 会被擦除、不触发）。跨插件协作走 Cordis 服务。

**关于 `ui-primitives` 的取舍**：两个已发布第三方插件（dshmarket、dsh-intelligent-ui）都 `require('@deepseek-ai/dsh-client-ui-primitives')`，说明平台 seed 可用；但 DSH 官方 practice 明确建议**不要**依赖它（版本漂移、无类型检查、组件抛错会让槽位空白，见 skill `references/practices.md` 的 UI 段）。建议：**MVP 不 import**，按需从 `packages/client/ui-primitives/src/*.tsx` + `*.module.css`（MIT）拷贝/改写组件，保留 `role`/`aria`/键盘行为，CSS 只引用 `--dsw-alias-*` token，并给 class 加本插件前缀。

虚拟滚动可用 `@tanstack/react-virtual`（平台 seed），大量会话列表需要。

### 7.4 `dsh.client.external` 是什么

「非基线模块声明」：当 bundle 必须 `require` 某个**其他插件的 client bundle**（例如 `@deepseek-ai/dsh-client-ui-sidebar/client`）时，把它写进 `external`，宿主会把它作为模块表 row 依赖先加载；但**跨插件值导入本身被实践禁止**（应改用服务）。对 Threadloom：MVP 的 `external` 建议为 `[]`，只用 `react` + Cordis 服务。

### 7.5 locale（文案）

- `ctx.locale.register(NS, { zh, en, ... })`：**必须同时提供 `zh` 和 `en` 两个基线字典**，缺一会编译/注册失败；其他语言可选（`packages/client/locale/README.md:38-46`）。
- 组件内翻译：注册槽时声明 `locale: NS` → props 得到 `t(key, params?)`；或在 apply 内 `const t = ctx.locale.bind(NS)`。
- `label` 用 thunk 以跟随语言切换（如 `label: () => t('panel')`）。
- 宿主 shell 文案（如设置页导航）由宿主从注册项 `label` 读取，无需额外字段。

### 7.6 `dsh.client.inject` 建议列表（MVP）

按已发布第三方插件 dsh-intelligent-ui 的实测清单裁剪：

```json
"inject": [
  "@deepseek-ai/dsh-client-locale",
  "@deepseek-ai/dsh-client-ui-layout",
  "@deepseek-ai/dsh-client-ui-sidebar",
  "@deepseek-ai/dsh-client-ui-session",
  "@deepseek-ai/dsh-client-ui-workspace",
  "@deepseek-ai/dsh-api-remotes",
  "@deepseek-ai/dsh-api-session-controller",
  "@deepseek-ai/dsh-api-workspace-controller"
]
```

- 它是**模块图/激活序**依赖（factory 到达顺序 + Loader 组合边），不是 Cordis 服务依赖；Cordis 服务依赖写在 client bundle 导出的 `inject` 数组里（§5.3）。
- 若页面只用 standard hooks 做只读展示、不调 remote，可精简为 locale/layout/sidebar/session/workspace；但只要调 `ctx.remote.session.*`，就应保留 api-remotes + session-controller。

### 7.7 加载、HMR 与重启语义

- 页面打开时，Host 通过 `window.__DSH_BOOT__` 注入构图，客户端 `ClientEntries` 按图加载/热更新（`docs/api-gateway.md` 之外的模块系统文档：`docs/subsystems/client-modules.md`；源码 `modules/src/client/entries.ts:1-140`）。
- 运行期图变化通过 SSE `/plugins/events` 推送：`{type:'graph'}` → `entries.sync()`；`{type:'rebuilt'}` → `entries.reload(id, rev)`（`packages/client/hmr/src/events.ts:1-44`、`packages/client/hmr/src/client/index.ts:49-110`）。
- 因此：**新安装 bundle 可以热激活客户端半**（host-plugin.md：「Installing a new bundle can activate through HMR」）；**替换/升级已安装包需要重启 Host**才能加载新的 JavaScript 模块代际。开发期要自动重编 client bundle，需要 `pnpm run dev:web` 的 watcher 在跑；仅改源码不重建时页面仍是旧包。
- 安装后验证：不要只看安装结果，用 `cordis_inspect_query` 查 live Slots 注册（`main` key、`sidebar.panellist` id）。

---

## 8. 样式与主题 token

- 只使用 `--dsw-alias-*` 语义 token（浅/深色自动跟随）；不要写字面色值（插画除外）。token 声明在 `packages/client/ui-theme/src/styles/design-platform.css`（alias 段约 `:170-260`）、`base.css`；规则文档 `docs/web-styling.md:1-60`。
- 常用 token（管理页够用）：`--dsw-alias-bg-base`、`--dsw-alias-bg-layer-1/2/3`、`--dsw-alias-bg-mask-1/2`、`--dsw-alias-label-primary/secondary/tertiary`、`--dsw-alias-border-l1..l4`、`--dsw-alias-button-primary-fill/primary-dimmed/ghost-active-fill`、`--dsw-alias-state-business-primary`（focus 蓝）、`--dsw-alias-toast-bg/toast-label`、`--dsw-menu-surface-fill`、`--dsw-elevation-panel/prominent/soft`、`--dsw-focus-ring-color/--dsw-focus-ring-width`、`--dsw-alias-menu-group-header-fill`。
- 规则摘要（`docs/web-styling.md:14-30`）：
  - 用 CSS Modules + `clsx`；不要引入组件库/Tailwind；
  - hover 样式统一放 `@media (hover: hover)`；`(pointer: coarse)` 下输入框 ≥16px；
  - 中立分隔线用 `0.5px`；悬浮面用 elevation 阴影（`border:0`），不要「border + elevation」混用；
  - Modal 遮罩不 blur；菜单用 `Menu`/`MenuSurface` 材质；
  - 数字与相对时间、状态点、开关等宿主已有观感，建议复制 ui-primitives 对应组件再改前缀；
  - 圆角遵循 `docs/ui-radius.md`（圆/胶囊配 `corner-shape: round`）；
  - 不要读取其他插件 DOM / 不要 append 到 `document.body`（intelligent-ui 的「读宿主 DOM 放置 seat」是反面教材，仅因其历史原因存在）。

外部插件没有 DSH 的 CSS Modules 构建管线，两种做法：
1. **推荐**：bundle 里带一个 CSS 字符串常量，apply 中注入 `<style data-plugin="threadloom">` 并在 dispose 移除（intelligent-ui 写法）；class 用 `threadloom-*` 前缀；
2. 若使用自建 tsdown/rolldown，可复用 `packages/client/tsdown.client.ts` 的 CSS Modules 内联逻辑（该文件是 DSH 内部构建工具，发布包不建议依赖它，可参考其实现）。

---

## 9. MVP 实施清单

### 9.1 客户端文件结构（建议）

```
threadloom/
├─ package.json            # §7.1
├─ cordis.patch.yml        # Host row（insert threadloom Host 半）
├─ index.js                # Host: apply(ctx, config) + ctx.threadloom service + /threadloom/api 路由
├─ client.js               # 浏览器 bundle（__ModuleLoader__.load）
├─ locale/{zh,en}.json     # meta.title/description + NS 字典
└─ icon.svg                # 256KiB 内，包内相对路径
```

客户端模块建议单文件起步（打包工具会把 `page.js`、`rows.js`、`css.js` 合进 `client.js`）：`Page`（列表/筛选/详情）、`RowActions`、`ConfirmDialog`（删除/清空回收站）、`styles` 字符串、`dict` 字典。

### 9.2 页面内容（MVP）

- 头部：标题、会话总数/回收站入口、搜索框（title/id/内容）、workspace 筛选、排序（更新时间/创建时间）。
- 列表列：标题（`displayTitle`）、workspace（`useWorkspaces().items` 按 `sessionIds` 反查）、更新时间（`updatedAt`，相对时间）、状态（running/blank/archived/pinned）、preset（`projectionValues.agentPreset`）、model（`projectionValues.modelSelection`）、token（`projectionValues.tokenUsage`）、父会话（`parentId`）。
- 行操作（按 access hook 显隐）：
  - 打开：`ctx.uiWorkspace.openSession(id)`；
  - 改名：`ctx.remote.session.rename({sessionId,title})`（或 `ctx.sessions.using(id,{source:'threadloomPage'}, ref => ref.binding.session.rename(title))`，后者会等历史打开、较重；纯改名用前者即可）；
  - 置顶/取消：`ctx.workspaces.pinSession/unpinSession`；
  - 归档/取消：`ctx.workspaces.archiveSession/unarchiveSession`；running 会话的 `workspace/session-active` 拒绝要像宿主一样弹「停止并归档」确认（`WorkspaceArchiveError`，`api/workspace-controller/src/client/service.ts:24-31`，`stopActivity:true`）；
  - 删除（本期可选）：走 §6 自定义桥 + 回收站二次确认。
- 批量操作（后续）：多选 → 批量归档/删除；Host 无批量 Remote，逐条调或自定义桥批量端点。
- 详情抽屉：`useSessions(s => s.byId[id])` + `projectionValues`；子代理血缘用 `parentId` 反查 `byId` 构造树；`origin:'subagent'` 行默认折叠。
- 搜索：客户端即时过滤 title/id；内容搜索用 `ctx.sessions.search(query, signal)`（debounce ~250ms、新查询 abort 旧请求、结果上限 20，与宿主侧栏行为一致，`ui-workspace/src/client/index.ts:140-146`）。
- 空态/加载态：`phase==='pending'` 骨架；`state==='error'` 展示重试（`ctx.sessions.refresh()`）。

### 9.3 可复用/可拷贝的宿主实现

| 需要的东西 | 参考文件（拷贝用法 + 改名） |
|---|---|
| 管理页页面骨架（滚动/页头/960 列） | `ui-plugin-manager/src/client/PluginManagerPage.module.css:1-90`、`PluginManagerPage.tsx:1618-1700` |
| 行菜单项/图标按钮/确认框/输入框视觉 | `ui-primitives/src/` 下的 `Menu.tsx`（导出 `MenuItemButton`）、`Button.tsx`、`Modal.tsx`、`Input.tsx`、`Tooltip.tsx`、`Switch.tsx`、`SegmentedTabs.tsx`、`Pill.tsx`、`Tag.tsx`、`DisclosureRow.tsx` + 同名 `.module.css` |
| 重命名对话框（IME 组合、错误提示、禁空） | `ui-workspace/src/client/session-actions/RenameSession.tsx:64-120` |
| 归档拒绝/停止并归档交互 | `ui-workspace/src/client/session-actions/ArchiveSession.tsx`、`ui-workspace/src/client/index.ts:199-225` |
| 行操作/权限/可见性模式 | `ui-workspace/src/client/contract/slots.ts:152-205`、`session-actions/*.tsx` |
| 列表 store 选择器写法 | `ui-session/src/client/index.ts:697-708` 与 `ui-workspace/src/client/index.ts:160-161`（`derive(...)` 生成 Set 源） |
| 第三方整页注册范式 | `node_modules/dshmarket/client/client.js:16721-16737` |

---

## 10. 风险与未决问题

1. **live 校验缺口**：本次 client inspect 全部超时，slot 事实来自源码/构建产物；发布前必须在页面健康时复核 `main`/`sidebar.panellist` 的 live occupants（§11）。
2. **依赖宿主内部服务**：`ctx.sessions`/`ctx.workspaces`/`ctx.uiWorkspace` 等是 DSH 客户端服务的「事实公共面」——已被 dsh-intelligent-ui 等第三方插件使用（其 inject 列表可证），但不是对外承诺的稳定 API；DSH 升级可能变动。建议把对它们的调用集中在一个 adapter 文件，便于升级修补。
3. **删除桥的安全面**：自建 HTTP 路由没有 Typert 严格 schema；必须 `connection.requestRejection` + 大小上限 + 字段白名单 + 稳定错误码；不要暴露除 owner 之外的能力。非 owner Peer 不在 MVP 目标内。
4. **页面/侧栏注册生命周期不一致**会在点击时抛错（§4.2），务必同 effect 注册。
5. **用户可 unpin 侧栏行**：`sidebar.panellist` 行可被用户移到 More 菜单（内存态、刷新页面后复位）；管理页仍可从 More 打开，不影响功能，但文案上不要假设入口永远可见。
6. **`ui-primitives` 直接 import 的风险**（官方 practice 反对、组件抛错会让槽位空白）；MVP 走「复制/自写组件」。
7. **性能**：`useSessions` 选择器订阅避免整表重渲染；大列表用 `@tanstack/react-virtual`；避免在页面内 `retain` 每个会话（会开 history/保活），只对打开中的详情 retain 或直接读 remote。
8. **HMR 与发布**：安装新包可热加载；替换版本必须重启 Host；dev 需要 `dev:web` watcher，否则页面加载旧 bundle。
9. **设置页无法一键直达**：只有 `main` 面板是「一键目的地」，这也是 MVP 选整页的硬理由（dshmarket 注释同结论）。
10. **删除运行中会话**、**归档是否级联子代理**、**回收站保留期**仍是 README 的开放问题；UI 只做交互呈现，语义由 Host 服务决定（建议对齐 Codex 的分级危险操作）。

---

## 11. 复核命令（页面恢复后）

```text
cordis_inspect_list
cordis_inspect_query platform=client provider=Slots method=listSubTree
cordis_inspect_query platform=client provider=Slots method=listSubTree root=main
cordis_inspect_query platform=client provider=Slots method=listSubTree root=sidebar.panellist
cordis_inspect_query platform=client provider=Slots method=listSubTree root=sidebar.workspaces.session.menu.item
cordis_inspect_query platform=client provider=Service method=listService
cordis_inspect_query platform=client provider=Service method=listService service=sessions
cordis_inspect_query platform=client provider=Builtin method=listBuiltins
cordis_inspect_query platform=client provider=Theme method=listTokens
```

安装插件后重点看：`main` 槽出现 key=`threadloom` 的 occupant；`sidebar.panellist` 出现 id=`threadloom`；控制台无 `slot entry crashed in '...'`。

---

## 12. 源码索引（本文引用）

**槽位契约**
- `packages/client/ui-layout/src/client/index.ts:53-119`（root 子槽表：sidebar/main/rightbar/shell.*）、`:178-190`（root 注册 + 子槽声明）、`:203-204`（main 面板 key 保留）
- `packages/client/ui-layout/src/client/AppFrame.tsx:40-43`、`:246-248`（main 按 activePanelId 渲染）
- `packages/client/ui-layout/src/client/service.ts:24-78`（ILayout / selectPanel）
- `packages/client/ui-sidebar/src/client/contract/slots.ts:20-56`（sidebar 子槽）、`:73-78`（panellist icon props）、`:120-143`（panellist.actions props）
- `packages/client/ui-sidebar/src/client/index.ts:71-95`（sidebar 注入与子槽声明）、`:100-104`（shell.leading 复用）
- `packages/client/ui-sidebar/src/client/SidebarRoot.tsx:67-83`（面板行点击 → selectPanel）、`:102-120`（More 菜单）
- `packages/client/ui-workspace/src/client/contract/slots.ts:78-83`（行 owner props）、`:128-151`（leading/trailing/hover）、`:152-205`（menu.item/row.action，含官方示例与已占 id）
- `packages/client/ui-workspace/src/client/index.ts:169-260`（rename/pin/archive/fork/session-id 的真实接线）
- `packages/client/ui-settings/src/client/contract/slots.ts:14-92`（settings.* 槽与选项）
- `packages/client/ui-plugin-manager/src/client/index.ts:82-175`（官方整页范式）、`:129-149`（页面子槽声明）
- `packages/client/ui-plugin-manager/src/client/slot-contract.ts:1-10`（Plugins 页为其他插件声明的槽文件头）
- `packages/client/ui-plugin-manager/src/client/PluginManagerPage.module.css:1-90`、`PluginManagerPage.tsx:1618-1700`（页面骨架）

**slots 机制**
- `packages/client/ui-slots/src/index.ts:120-262`（SlotMap/kind/scope/props 组合）、`:768-838`（注册选项）、`:1207-1244`（register 校验）、`:236-262`（GlobalStandardProps/ScopeStandardProps）
- `packages/client/ui-slots/src/renderer.ts:42-44`（hook key → prop 名）
- `packages/client/ui-renderer/src/client/registry.ts:120-330`（SlotRegistry、`inject`、`register`、provideRoot）
- `packages/client/ui-renderer/src/client/registry.ts:29-56`（root 槽，禁止注册）

**standard kit / 客户端服务**
- `packages/client/ui-session/src/client/index.ts:157-186`（Global/Session/SessionMaybe standard props）、`:697-716`（provideRoot/installScope）
- `packages/client/ui-workspace/src/client/index.ts:72-80`（useWorkspaces/useWorkspaceAccess）
- `packages/api/session-controller/src/client/sessions/service.ts:27-73`（SessionSummary/SessionListState）、`:238-278`（ClientSessions + provide('sessions')）
- `packages/api/session-controller/src/client/contract/sessions.ts:49-190`（ISessions）
- `packages/api/session-controller/src/client/index.ts:104-150`（inject、事件接线、control stream）
- `packages/api/workspace-controller/src/client/service.ts:24-136`（WorkspaceArchiveError/IWorkspaces/WorkspaceController）
- `packages/api/workspace-controller/src/client/model.ts:29-57`（WorkspaceSnapshot / follow sink）
- `packages/client/ui-workspace/src/client/navigation.ts:195`（uiWorkspace 服务）、`:293-295`、`:520`、`:552`（openSession → selectPanel(null)）

**Remote / 数据契约**
- `packages/api/remotes/src/client/index.ts:6-30`（客户端可用命名空间全集）
- `packages/api/session-controller/lib/typert.remote-client.d.ts:1-50`（session/skills/fileReferences 生成签名）
- `packages/api/session-controller/src/types.ts:149-162`（SessionSummary）、`:238-256`（list/search 请求响应）、`:164-175`（搜索上限）
- `packages/api/session-controller/src/index.ts:265-277`（list）、`:420-430`（rename）、`:432-449`（fork）
- `packages/api/workspace-controller/src/index.ts:90-192`（create/rename/delete/insert/archive/pin）、`:205-230`（follow 流）
- `packages/api/workspace-controller/src/types.ts:18-25`（WorkspaceView）、`:130-160`（baseline/archive/pin 帧）
- `packages/session/session-projection/src/types.ts:53-67`（投影值/汇总类型）
- `packages/preset/agent-preset-registry/src/types.ts:50-55`（`agentPreset` 投影键）
- `packages/client/ui-session/...`（见上）、`packages/client/ui-workspace/src/client/index.ts:160-161`（derive 集合）

**Host 桥 / 连接**
- `docs/api-gateway.md:62`、`:100-134`（构建期生成 + 客户端 mount 面固定）、`:136-160`（SRC fallback 不能给 Client 新契约）、`:166`（exact Fetch route 定位）
- `packages/client/connection/src/rpc.ts:136-180`（ConnectionRpcHandler / ConnectionFetchRoute / HostConnectionFetch）、`:206-230`（HostConnectionHandle）、`:295+`（ClientConnectionRpc.call）
- `packages/client/connection/src/rpc-host.ts:253-277`（rpc.handle 挂 prefix route）、`:279-301`（intercept）
- `packages/client/connection/src/client/index.ts:149-187`（Client ConnectionHandle：rpc / generation / state）
- `packages/host/webserver/src/index.ts:48-58`（WebRoute）、`:445`（register）
- `packages/client/file-upload/src/index.ts:79-86`、`src/protocol.ts:2`（官方 exact fetch route 范例）

**客户端构建 / 加载**
- `packages/client/modules/src/index.ts:1-26`（Host 构图/`__DSH_BOOT__`/增量扫描）、`:890-925`（platform 门禁 + `./client` 必填）
- `packages/client/modules/src/client/manifest.ts:1-22`（lazy CJS 模型）、`:166-220`（dsh.client 解析/归一化）
- `packages/client/modules/src/client/entries.ts:1-140`（页面端 entry 协调）
- `packages/client/hmr/src/events.ts:1-44`、`packages/client/hmr/src/client/index.ts:49-110`（/plugins/events SSE）
- `packages/client/web/src/platform.ts:8-15`（平台模块种子表）
- `packages/client/tsdown.client.ts:1-20`（bundle 格式）、`:838-856`（purity gate）、`:380-460`（external 规则）
- `packages/client/locale/README.md:38-46`（字典注册，zh/en 基线）
- `docs/web-styling.md:1-60`（token/组件规则）、`docs/ui-radius.md`
- `packages/client/ui-theme/src/styles/design-platform.css`（alias token 定义）、`base.css`

**已安装第三方插件（真实样例）**
- `/home/leoric/.dsh/profiles/web/node_modules/dshmarket/package.json`（dsh.client）
- `/home/leoric/.dsh/profiles/web/node_modules/dshmarket/client/client.js:16508`、`:16721-16737`（main + sidebar.panellist 整页）
- `/home/leoric/.dsh/profiles/web/node_modules/dsh-intelligent-ui/lib/client.js`（client bundle、inject 列表、样式注入）
- `/home/leoric/.dsh/profiles/web/node_modules/dsh-intelligent-ui/src/index.mjs:31`、`src/host/service.mjs:54-58`、`src/client/host/pane.jsx:60`（webServer 前缀路由 + 相对 fetch）

**官方 skill 参考资料**
- `packages/preset/agent-preset/skills/cordis-plugin-development/references/ui-plugin.md`（客户端 manifest/loader/槽注册）
- `.../references/practices.md`（UI：槽、token、禁读插件 DOM、不要 import Harness Client 包）
- `.../references/host-plugin.md`（bundle patch、locale/icon、安装与验证）
- `.../references/user-actions.md`（UI 动作与 agent 工具共用 Host 服务；commands 桥）
