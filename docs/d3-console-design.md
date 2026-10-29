# Threadloom D3：完整会话管理台（设计草案 v0.1）

> 输入：`research/2026-10-28-codex-desktop-ui-audit.md`（Codex 桌面 UI 实机）、`research/codex-session-management.md`（CLI/app-server 能力矩阵）、`research/dsh-session-management-v2.md`（DSH 七个能力面）、`docs/dsh-web-ui.md`（slot/挂载）、`research/2026-10-28-dsh-plugin-management-survey.md`（插件管理接入面，进行中）、`docs/decisions.md`（D-001…D-020）。
>
> 状态：**已确认（用户 2026-10-28）**；D3.0 已落地（配置 volatile + 插件页 `plugins.*` 四贡献 + 健康快照），其余阶段按 §10 推进。本文回答四个问题：**D3 长什么样、双用户怎么用、删除/回收站到底重不重要、如何与 DSH 已有插件管理 feature 结合。**
>
> **v0.2 修订（2026-10-29，用户纠正）**：ChatGPT/Codex **没有「会话管理」按钮**——会话管理内联在侧栏会话行（hover pin/archive、"..." 菜单、搜索/筛选）。据此删除侧栏 `sidebar.panellist` 入口，改为会话行 "..." 菜单两个动作（`会话详情…` / `会话库…`），完整 Library 通过 `ctx.layout.selectPanel` 从菜单或 Plugins 页打开。决策见 D-023（D-009 相应作废）。

---

## 0. 结论先行

1. **D3 = 一个控制台（人）+ 一组工具（agent）+ 一套插件管理集成（安装/设置/健康）。** 不是"回收站页面 + 删除按钮"。
2. **删除/回收站不是核心，降级为"清理（Cleanup）"模块**（见 §7）。核心是 **Library（检索/分组/预览）+ Detail（理解血缘与成本）+ Resume/Fork（接回与分支）+ Organize（置顶/归档/标签/备注）**。依据：Codex 实机里删除位于右键菜单最底部、无快捷键、无回收站；归档才是行内主生命周期动作。
3. **"完整"的定义**：覆盖会话的发现 → 理解 → 组织 → 接回 → 分支 → 清理 → 审计 七个环节；每个环节在 agent tool / 人类 UI / HTTP 桥 / Host 服务四个面都有明确落点（能做的做，不能做的写清楚为什么）。
4. **不重复 DSH 官方**：pin/rename/archive/fork/打开 官方已有，D3 只在"批量、跨 workspace 视图、详情页、回收站、标签/备注、导出"上补位；**入口沿用 Codex 形态**——会话行 "..." 菜单内联（DSH `sidebar.workspaces.session.menu.item` 支持第三方按 order 插入；已核实），完整 Library 由菜单/Plugins 页经 `ctx.layout.selectPanel` 打开，**不设常驻「会话管理」按钮**。
5. **与插件管理 feature 的整合是 D3 的一等目标**：插件详情/健康/设置页/安装升级/权限说明都必须像"官方插件"一样可见、可控、可诊断（§8）。

---

## 1. 目标与非目标

### 1.1 目标（可验收）

- **G1 找到**：在 1k 量级会话下，任意会话 ≤3 次交互可达（搜索/筛选/排序/深链）；列表首屏 <300ms（本地索引）。
- **G2 看懂**：详情页回答"是什么/在哪/多大/多久/谁生的/花了多少/产生过什么"六问，不依赖 projection cache，迁移中也能降级展示。
- **G3 接回**：从控制台一键打开会话（官方 `uiWorkspace.openSession`）、从任意会话新建/分叉。
- **G4 分叉**：human 可从控制台选源会话分叉（可带边界事件），agent 可用 `session_butler_fork`；fork 不级联、不写父血缘错误。
- **G5 组织**：批量置顶/归档（复用官方 remote/service）、插件自有标签/备注（存 `storageDomain`，不改 DSH 核心）。
- **G6 清理**：回收站可恢复、保留期可配、永久删除强确认；运行中会话有明确阻断与引导。
- **G7 可诊断**：插件管理页/设置页能看到版本、健康、统计、最近错误；出问题能定位是桥、Host 服务、存储还是权限。
- **G8 双用户**：同一能力对 agent 与 human 都能用，写边界明确（agent 不获得破坏性工具）。

### 1.2 非目标

- 不改 DSH 核心、不新增 `ctx.remote.*` 命名空间、不做跨 workspace "移动"（语义上不可行，D-012）。
- 不做云端同步/多用户协作/会话内容编辑。
- 不做"项目（Project）"一等对象（DSH 无）；用 workspace 分组 + 标签近似。
- 不尝试删除运行中的会话（无公开 dispose API；只能先停止/归档，见 D-005/D-013）。

---

## 2. 设计原则（按 Codex 实机校准）

1. **检索优先**：把"搜索/命令面板"放在第一入口，而不是先做详情页。
2. **删除守门**：危险动作最低视觉权重、默认关闭、强确认；归档是主生命周期动作。
3. **可逆默认**：任何隐藏/移除先进入可恢复状态（DSH 归档、Threadloom 回收站）。
4. **键盘优先**：`/` 或 `Ctrl+K` 聚焦过滤；列表 `j/k` 移动、`Enter` 打开、`x` 选择、`Esc` 清除。
5. **不重复官方**：官方已有动作（pin/rename/archive/fork）只做"批量版/视图版"，不造第二套单条入口。
6. **只读优先**：agent 工具默认只读；写操作只保留"创建/分叉"（已实现）与人工确认的桥。
7. **本地元数据**：标签/备注/未读等扩展状态存插件 `storageDomain`，与 DSH 升级解耦。
8. **失败可见**：桥/服务/存储任何一坏，控制台显示可操作的错误，而不是白屏。

---

## 3. 对象与状态模型

### 3.1 DSH 原生（只读/复用）

| 字段 | 来源 | 说明 |
|---|---|---|
| `sessionId` | header | 权威 id |
| `title` | `sessionTitle` / projection | 可被官方重命名 |
| `cwd` / workspace | header + `workspaceRegistry` | 分组依据 |
| `agentPreset` / model | header + projections | 详情展示 |
| `createdAt` / `updatedAt` | header / 事件折叠 | 排序 |
| `size` / `eventCount` | `sessionPersistence.stat` | 清理提示（超大日志） |
| `running` | `sessions.get` / `agents.get` | live 阻断 |
| `pinned` / `archived` | `workspaceRegistry` | 复用官方；插件不自建第二套 |
| `parentSessionId` / `origin` | header | 血缘；仅 `origin==='subagent'` 可级联 |
| 工具/产物/token | 事件折叠 | 详情页（只读） |

### 3.2 Threadloom 扩展元数据（`ctx.storageDomain`）

\`\`\`ts
interface ButlerMeta {
  sessionId: string
  tags: string[]                 // P1：自由标签，用于跨 workspace 视图/筛选
  note?: string                  // P1：一句话备注
  unreadAt?: number              // P2：标记未读时间（本地，不改 DSH）
  lastSeenAt?: number            // 详情/最近活动辅助
  trash?: TrashRecord            // 回收站条目（原路径/删除时间/级联快照）
  updatedAt: number
  schemaVersion: 1
}
\`\`\`

### 3.3 状态机

\`\`\`
                 rename/pin/archive（官方）
active ─────────────────────────────────────────────► active'
  │                                                        ▲
  │ trash（插件，先停/归档 live）                            │ restore
  ▼                                                        │
trashed ───────────────────────────────────────────────────┘
  │ purge（强确认 + 保留期）
  ▼
purged（不可恢复）

live（running）──► 不可 trash；先 cancel/archive（官方 stopActivity）→ 变冷后再 trash
\`\`\`

- 归档与回收站是**两层**：归档 = DSH 原生"移出活动列表"；回收站 = 插件"移出 DSH 存储目录，可恢复"。两者可叠加但 UI 要解释清楚。
- fork 关系不是父子级联：fork 出来的会话独立，不随源删除而删除（D-004）。

---

## 4. 信息架构（控制台）

### 4.1 导航

\`\`\`
Threadloom（main 面板，keyed）
├─ 概览 Overview        # 统计/最近/清理建议/健康
├─ 会话库 Library       # 核心：列表 + 过滤 + 批量 + 详情抽屉
├─ 回收站 Trash         # 恢复/永久删除
├─ 清理 Cleanup         # live/超大/迁移中/孤儿（P1）
└─ 设置 Settings        # 插件管理 tab：开关/策略/诊断
\`\`\`

**入口（Codex 式，无独立按钮）**：

- 会话行 "..." 菜单：`会话详情…`（打开当前行会话详情）、`会话库…`（打开 Library/Trash）；
- Plugins 页 Threadloom bundle 区块：「打开会话库」按钮；
- 完整 Library 仍是 keyed `main` 面板，但只由上述入口经 `ctx.layout.selectPanel('session-butler')` 打开；
- 不注册 `sidebar.panellist`，不在侧栏增加任何常驻行。

### 4.2 会话库（Library）

**工具栏**：搜索框（标题/id/cwd；内容搜索 P1 可选）、筛选 chips（workspace/状态/血缘/大小/时间）、排序（最近活动/创建/大小/标题）、密度切换、刷新、批量选择。

**列表行**（对齐 Codex 侧栏的信息密度）：

\`\`\`
▸ 标题（截断）                 [live] [pinned] [archived] [subagent d2]
  cwd · 相对时间 · 大小 · 轮数 · token
\`\`\`

- hover：预览卡（标题/时间/血缘/最近事件摘要/标记），不弹大图；
- 行尾：详情、打开、分叉（不复制官方 pin/archive 单条动作；批量时出现）；
- 行点击：打开详情抽屉（非跳转），Double-click/Enter 打开会话（官方 openSession）。

**详情抽屉**：Header（标题/cwd/时间/大小/状态）、血缘树（祖先/后代，可点）、统计（轮/步/工具/token）、工具与产物摘要、导出 Markdown（P1）、回收站/恢复、分叉（选边界 P1）。

**批量栏**：已选 N 个 → 置顶/取消置顶、归档/取消归档（官方能力）、加标签、移入回收站；显示"其中 live N 个将被跳过并提示"。

### 4.3 回收站（Trash）

- 列：原 workspace/cwd、标题、删除时间、剩余保留天数、级联数量、恢复状态；
- 动作：恢复（单个/批量）、永久删除（仅 `permanentDelete=confirm` 且输入完整 id）；
- 空态文案：解释"归档（官方）≠ 回收站（Threadloom）"，引导用户用归档做日常整理。
- 保留策略：`trashRetentionDays`（默认 30，0=不自动清理）；过期只标记"可清理"，不自动删。

### 4.4 概览（Overview）

- 卡片：总会话/活动/置顶/归档/回收站/live；最近 7 天新增；
- "需要关注"：live 且长时间未活动、超大日志（>100MB）、迁移中、回收站即将过期；
- 插件健康摘要（桥/存储/后端），点击跳到设置页诊断。

### 4.5 交互细节（来自 Codex 的启发）

- **命令面板式过滤**：`Ctrl+K` 打开统一输入，支持 `/` 前缀切动作（如 `/trash`、`/workspace X`），`Alt+1` 打开首条；
- **hover 预览**而非展开行；**批量选择**用 checkbox/空格；
- **危险动作分级**：归档有快捷键，删除无快捷键；永久删除需要输入 id；
- **不打断**：所有操作乐观更新 + 失败回滚提示。

---

## 5. 双用户能力映射

| 能力 | Agent tool（模型） | 人类 UI | HTTP 桥 | Host 服务 | 官方复用 |
|---|---|---|---|---|---|
| 列表/搜索 | `session_butler_list`（已有；P1 加 query/标签筛选） | Library 工具栏 | `list` | `sessionQuery` | 只读 |
| 详情 | `session_butler_detail`（已有） | 详情抽屉 | `detail` | stat+事件折叠 | — |
| 新建 | `session_butler_new`（已有） | Library"新建"（P1） | — | `sessionController.create` | 官方 hero/+ |
| 分叉 | `session_butler_fork`（已有；P1 加 atSeq 提示） | 行"分叉"/详情"分叉" | `fork`（P1） | `sessionController.fork` | 官方 fork UI |
| 置顶/归档 | ✗（不加写工具） | 批量栏 | `pin`/`archive`（P1，复用官方 remote 或桥） | `workspaceRegistry` | ✅ |
| 标签/备注 | ✗（P1 只读展示） | 详情编辑 | `meta` | `storageDomain` | — |
| 回收站 | ✗（不给模型删除） | Trash | `trash`/`restore`/`purge` | 插件 service | — |
| 导出 MD | ✗ | 详情按钮 | `export`（P1） | 复用 `formatSessionMarkdown`（HEAD）或自写 | 视版本 |
| 打开会话 | ✗ | 行/详情 | — | `uiWorkspace.openSession`（client） | ✅ |

> 写边界：**agent 工具不注册删除/归档等破坏性动作**（延续 D-018 只读边界）；归档/置顶走人类 UI + 官方能力；回收站只对人类开放。

---

## 6. 能力矩阵（P0/P1/P2）

| 优先级 | 能力 | 验收 |
|---|---|---|
| P0 | Library 列表 + 搜索 + 筛选 + 排序 + 分页；详情抽屉；回收站（trash/restore/purge 已有）；批量归档/置顶；fork/new 入口；概览统计 | 1k 会话可用；错误态可见；live 阻断有文案 |
| P0 | 插件管理集成骨架：插件信息/健康/设置页（见 §8） | 设置页可打开、显示版本/健康、配置只读或可写（按调研结论） |
| P1 | 标签/备注；内容搜索（opt-in `session-query`）；导出 Markdown；分叉选边界；清理页；跨 workspace 视图 | 标签筛选可组合；搜索降级有提示 |
| P2 | 未读标记；保存筛选；最近活动热力；审计日志；主题/密度记忆；批量恢复 | 与 i18n/主题一致 |

---

## 7. 删除/回收站定位（回答"是不是核心"）

### 7.1 结论

**不是核心。** 它是 D3 的"清理"模块，默认低权重、默认关闭永久删除；D3 的核心是 Library/Detail/Resume/Fork/Organize。

### 7.2 五条理由（证据）

1. **Codex 实机**：删除只在右键菜单最底部；行内 hover 是 pin/archive；归档有快捷键（Ctrl+Shift+A），删除没有；无回收站 UI。
2. **官方产品结论**：Codex CLI/app-server 里 archive 是移动目录、可恢复；delete 是永久删除且危险（`--force` 仅 UUID）。产品把"可恢复"做成默认路径。
3. **价值不对称**：组织/检索每天用；删除是低频终点。把核心预算给删除，等于用高风险换低价值。
4. **DSH 约束**：live 会话无法安全删除（`session-running`；无公开 dispose API）；回收站需要目录移动 + 元数据 + 回滚，工程量不小，且用户价值是"清理"，不是"管理"。
5. **成功指标**：删除按钮的 KPI 不该是"删除量"，而是"误删=0、可恢复=100%、live 误删=0"。

### 7.3 但仍要完整（因为 DSH 真缺）

- DSH 官方无删除/回收站；会话会越积越多（含测试/失败会话），真实缺口存在。
- 形态：归档（官方）→ 回收站（插件，可恢复）→ 永久删除（强确认）；默认 `permanentDelete: disabled`。
- live 会话：trash 前先 `stopActivity`（归档）并有界 settle；仍运行 → 返回 `session-running` + UI 引导（先停止/归档），不静默强删。
- 审计：每次 purge 记 `{sessionId, at, by:'human-ui', confirmId}`，便于事后解释。

---

## 8. 与 DSH 插件管理 feature 的集成

> 事实来自 `research/2026-10-28-dsh-plugin-management-survey.md`（DSH checkout 0.2.2-alpha.2，含 path:line 证据）与真实插件页证据 `docs/evidence/plugin-detail.png`。
>
> **修正**：D3 草案 v0.1 曾计划注册 `settings.plugins.tab`——调研证实这是错的：该 slot 属于「设置 → 内置插件」分区（现只有只读清单一个 tab），语义错位；第三方插件的配置/健康应挂在**侧栏 Plugins 页**的 `plugins.*` 扩展点上。本节按此重写。

### 8.1 DSH 现有插件管理（两个页面 + 一条 CLI，全部复用）

| 面 | 机制 | 对 Threadloom 的含义 |
|---|---|---|
| 侧栏 **Plugins 页**（`ui-plugin-manager`，Remote `pluginManager.*`） | bundle 卡片、行开关、卸载、`plugins.tab`（官方「已安装/发现」）、版本区块（仅 registry 安装的第三方有 `updatable`）、每插件 `plugins.row.config`/`bundle.config`/`detail.*` 扩展点 | 安装/卸载/启停/版本/说明**已自动提供**，D3 不重做 |
| 设置 → **内置插件**（`pluginInventory.*`，只读） | 每项 `entryId/moduleName/meta/enabled/fiberPhase/diagnostic/managementAvailable` | fiber 级失败原因已有；功能级健康由插件自报（§8.4） |
| `dsh plugin …` CLI | 转发 profile 目录的 pnpm；registry 安装才有升级语义 | 文档写安装/升级命令即可 |
| `plugin_manager` agent 工具 | 需 danger-full-access 或逐次审批（默认 disabled） | 不依赖；不作为 D3 能力 |

### 8.2 用哪些插件页扩展点

| 用途 | slot | key/id | 说明 |
|---|---|---|---|
| 配置表单 | `plugins.row.config`（keyed） | `dsh-session-butler#session-butler` | 行页出现「配置」入口；owner 传入 `form`（需 volatile 字段） |
| 状态/统计 | `plugins.bundle.config`（keyed） | `dsh-session-butler` | bundle 页内联区块；**只有 `view:'page'`，无 form** |
| 健康徽标 | `plugins.detail.badge`（list） | `id: threadloom-health` | bundle 页标题旁绿/黄/红 |
| 诊断区 | `plugins.detail.section`（list） | `id: threadloom-diagnostics` | 桥/存储/最近错误，可复制复现命令 |
| 显式配置入口 | `plugins.detail.actions`（list） | `id: threadloom-configure` | bundle 页标题旁「配置」按钮；点击弹出与 row 页同一份 `configForms` 表单的对话框 |

- 不使用 `settings.plugins.tab`（语义错位）；也不建议 `plugins.tab`（会把会话库塞进插件页、与主面板重复）。
- 可选兜底：若未来需要一个**独立设置导航页**，用 `settings.section`（`id: threadloom`），不要与 row 页同时放同一组设置。
- 所有注册都走 `ctx.slots.inject(...)`：宿主未声明 slot 时只等待、不抛错，天然完成版本特性探测。

### 8.3 配置：`volatile` + 共用一份表单，单源写 profile patch

- 现有 3 个 Config 字段（`trashRetentionDays` / `cascadeSubagents` / `permanentDelete`，`src/config.ts`）**必须补 `.volatile()`** 才会进入 DSH 的表单投影；P0 新增 `liveSettleTimeoutMs`（live 停止等待）与 `inlineMenuEnabled`（控制会话行 "..." 菜单贡献，默认 true）。
- 表单来源：Plugins 页 row 页从 `ui-settings` 的 `ctx.configForms` 生成 `form: {state, mutate}`；我们只负责**渲染字段**（DSH 没有自动表单页面——`autoGenerate` 无客户端消费，`configure({auto:false})` 只翻标志）。注意 owner 传入的是 `{state, mutate}` 结构，不是 `ConfigForm` 实例（没有 `getSnapshot`）；`mutate(ops, revision)` 成功后由 owner 的 mirror 刷新 `state`。
- 保存：`form.mutate([{path, value}], state.revision)` → config-editor 写 profile `cordis.patch.yml` → Loader 热应用。**不新建 HTTP 写接口、不建第二配置源**。
- **入口统一（2026-10-29）**：客户端在 apply 时用 `ctx.get('configForms').get(rowId)` 取同一份服务表单，`plugins.detail.actions` 的「配置」按钮打开对话框渲染它；`plugins.row.config` 仍渲染 DSH 原生配置页。两处共用同一 form，不存在两份状态；bundle 页正文不再内联重复表单。
- 降级：无 `ui-settings`（headless/旧组合）时 row 页无表单；`plugins.row.config` 组件显示只读配置 + 指向 profile patch 的说明，不报红。

### 8.4 运行期健康（补 inventory 看不到的功能级状态）

`POST /session-butler/api/status` 扩展为（主面板与插件页共用同一快照）：

```ts
interface ButlerStatus {
  ok: boolean
  version: string
  dshVersion: string
  host: { ok: boolean; error?: string }
  bridge: { ok: boolean; mounted: boolean; lastError?: string }
  storage: { trashWritable: boolean; sessionsRootWritable: boolean; trashCount: number }
  backends: { sessionQuery: boolean; workspaceRegistry: boolean; sessionController: boolean; tools: boolean; commands: boolean }
  counts: { sessions: number; trashed: number; live: number }
  errors: Array<{ code: string; at: number; count: number }>
}
```

- `plugins.detail.badge`：`ok` → 绿「正常」；`host`/`bridge` 降级 → 黄「受限」；存储不可写 → 红「不可用」，title 显示原因。
- `plugins.bundle.config` + `plugins.detail.section`：完整快照、最近错误、复制诊断。
- 可选增强：`remote.pluginInventory` 读本行 `fiberPhase/diagnostic`（owner 恒放行，非 owner 走 remoteAccess）；权限拒绝时静默降级到自有 `status`。
- 组合降级：无 `webServer`/`connection` 时桥不挂载 → 显示「仅命令/工具可用」，不报红。

### 8.5 安装 / 升级 / 兼容

- 当前是 `link:` 安装 → **没有版本/升级 UI**（`updatable=false`）；要验证升级体验必须先发布 npm（0.1.2 待发），再用 registry 安装。
- `engines.dsh` 保持 `>=0.2.1-rc.2 <0.3.0-0`：新 `plugins.*` 集成在 rc.2 组合下静默跳过（主面板/命令/工具仍可用），发布说明标注「插件页配置区需 0.2.2+」。
- 不做插件内自更新（运行中替换自身风险高，官方也无自更新入口）；升级引导到 Plugins 页版本区块或 CLI 重装。
- 破坏性变更：`storageDomain` schema 迁移 + CHANGELOG；`meta.detail`/icon/locale 已满足插件页与市场展示。

### 8.6 命令 / 工具 / 市场可见性

- 命令：`/session-butler list|trash|restore|purge`（已有），P1 加 `search|stats|trash-empty`；
- 工具：`session_butler_list/detail/new/fork`（已有），描述明确「只读/创建，不删除」；
- 插件页/市场：名称、版本、描述、icon、zh/en locale、`meta.detail`（`docs/usage.md`）已由 DSH 自动渲染；市场复用同一套 npm manifest，不加私有字段。

## 9. Host / Client 架构增量

### 9.1 Host

- `config.ts`：现有 3 字段补 `.volatile()`，新增 `liveSettleTimeoutMs`、`inlineMenuEnabled`（§8.3）。
- `service.ts`：现有 list/detail/trash/restore/purge 之外增加 `stats()`、`health()`、`tags/notes CRUD`（P1）、`exportMarkdown()`（P1，复用或自写）。
- `trash-store.ts`：sidecar `schemaVersion`、保留期扫描、批量恢复、孤儿 sidecar 清理。
- `bridge.ts`：现有路由不变；新增 `status` 扩展字段、`stats`、`meta`、`export`（P1）；统一错误信封。
- `storageDomain`：新增 `butler-meta` 键空间（标签/备注/未读）；与 trash 分键，避免耦合。
- 性能：列表分页在 Host 侧完成（已有）；标签筛选在 Host 侧 join；>1k 会话时缓存 stat 结果（TTL 30s，可配置）。

### 9.2 Client

- 现有：`main` keyed 页面 + locale；**无 `sidebar.panellist` 入口**（D-023）。
- 入口：`sidebar.workspaces.session.menu.item` 两个菜单项（id `threadloom.detail`/`threadloom.library`，order 460/470）；`ctx.layout.selectPanel` 由 `navigation.ts` 在 apply 时安装；Plugins 页 bundle 区块提供「打开会话库」按钮。
- 新增：插件页扩展（§8.2）——`plugins.row.config` 配置表单（需 Config 字段 `.volatile()`）、`plugins.bundle.config` 状态区、`plugins.detail.badge`/`section` 健康与诊断；`sidebar.session.row.trailing` 轻量徽标（标签/子代理/大小，P2，避免与官方 hover 冲突）；`shell.overlay` 确认框（永久删除输入 id）。
- 页面拆分：`Overview`/`Library`/`Trash`/`Settings` + `DetailDrawer`；共享 `List`/`FilterChips`/`EmptyState`。
- 数据：桥优先，`sessions.refresh()` 在写操作后触发；本地缓存只做 UI 状态（筛选/滚动/选择）。
- 主题：用 DSH token（`docs/dsh-web-ui.md` §8），不硬编码颜色；暗色跟随。

---

## 10. 里程碑与验收

| 阶段 | 内容 | 验收 |
|---|---|---|
| D3.0 | 设计定稿 + 插件页集成（row config / detail.actions 配置按钮+对话框 / bundle config / detail badge+section）+ Config volatile；status 健康快照；`liveSettleTimeoutMs`/`inlineMenuEnabled` 接线 | 插件页出现「配置」入口（标题旁按钮与 row 页）；保存写回 profile patch 且热生效；健康红黄绿正确；无回归 |
| D3.0b（2026-10-29） | Codex 式入口修订：删除 `sidebar.panellist`；会话行 "..." 菜单注入详情/会话库；`ctx.layout.selectPanel` 打开 main 面板；`inlineMenuEnabled` 热增删菜单项 | 侧栏无「会话管理」按钮；两项菜单出现且可打开详情/Library；取消勾选后菜单项立即消失 |
| D3.1 | Library（搜索/筛选/排序/分页/批量 pin+archive）+ Detail 抽屉 + 概览 | 1k 会话首屏 <300ms；批量操作逐项结果可见 |
| D3.2 | 分叉入口（human）+ fork 边界（P1）+ Trash 完整（保留期/批量恢复/强确认）+ live 引导 | 误删=0；恢复=100%；live 阻断有文案 |
| D3.3 | 标签/备注、内容搜索 opt-in、导出 MD、Cleanup、诊断、i18n/主题、审计 | 标签筛选可组合；导出内容正确；诊断可复制 |
| 发布 | npm `0.2.0` + GitHub release + 市场元数据 | 安装/升级/回滚演练通过 |

> **实现状态（2026-10-29 已验证）**：D3.0 + D3.0b 已落地并通过 `pnpm run verify`（59 tests / 57 package checks）。在隔离 `DSH_HOME`（DSH 0.2.2-alpha.2，含真实会话数据）+ Playwright Chromium 实测：
>
> - **入口**：侧栏没有「会话管理」按钮（导航只有 插件/自动化任务/更多）；会话行 "..." 菜单追加 **会话详情…** 与 **会话库…**（带分隔线、原生菜单样式），点击详情直接打开 Threadloom 面板并弹出该会话详情；
> - **Library**：从行菜单与 Plugins 页「打开会话库」按钮均可打开（`ctx.layout.selectPanel`）；空会话/回收站/批量等既有能力正常；
> - **配置**：bundle 页标题旁出现**「配置」按钮**（`plugins.detail.actions`），点击弹出 **Threadloom 设置**对话框（5 字段），保存后写回 profile `cordis.patch.yml`；行配置页同样可用（同一份 `configForms` 表单）。bundle 页 **Healthy** 徽标 + 状态区块；`inlineMenuEnabled` 取消勾选后菜单项**实时消失**、恢复后重新出现；
> - 全程无 console/page error。
>
> 证据：`docs/evidence/inline-session-menu.png`、`inline-detail-panel.png`、`plugin-configure-entry.png`、`plugin-configure-dialog.png`、`plugin-row-config.png`、`plugin-health-bundle.png`。
>
> **注意**：DSH 当前的 bundle 热切换只重组合 Client graph，**不会重新 import Host 模块**（core 未组合 host HMR）；因此 Host 代码改动仍需**重启 DSH 进程**。下一阶段 D3.1 Library（搜索/筛选/排序 + 概览）。

---

## 11. 风险与开放问题

1. ~~**row config 表单成立条件**~~（2026-10-29 已验证）：`.volatile()` + `ui-settings` 组合下「配置」入口出现，保存写回 profile `cordis.patch.yml`，且值按使用点热读取；无 `ui-settings` 时降级为只读说明。
2. **插件页 slot 稳定性**：`plugins.*` 是 0.2.2 的契约，不在 `engines.dsh` 语义内；全部用 `ctx.slots.inject` 探测（rc.2 组合无入口但主面板/命令/工具可用）。DSH 升级后需重跑审计 + 浏览器实测。
3. **`remote.pluginInventory` 权限**：owner 页面恒放行，非 owner/liveshare 可能拒绝；只做可选增强，失败降级到自有 `status`。
4. ~~**没有"打开主面板"API**~~（2026-10-29 已核实）：第三方 Client 插件可 `inject: ['layout']` 并调用 `ctx.layout.selectPanel('session-butler')`；已用于行菜单与 Plugins 页「打开会话库」。
5. ~~**bundle.config 无 form**~~（2026-10-29 已解决）：bundle 页标题旁用 `plugins.detail.actions` 提供**「配置」按钮 + 对话框**，与 row 页共用同一份 `configForms` 表单；bundle 页正文仍只做健康/统计（`plugins.bundle.config` 无 form），避免页面内联重复表单。
6. **升级体验**：当前 `link:` 安装无 `updatable`；发布 npm 后需验证 remove+install 对运行中 client 半侧/主面板的影响与失败回滚文案。
7. **写操作重复**：官方已有 pin/archive；批量操作走官方 remote 还是 Host 服务需实测失败语义与刷新。
8. **live/性能/搜索/隐私/兼容**：trash 的 stopActivity+settle 成功率；1k+ 会话 stat 成本；`session-query` 默认关闭需降级；回收站/导出隐私；fork 血缘 REL≠HEAD（v2 §5.3）。

---

## 12. 附录

### A. Codex UI → D3 对照

见 `research/2026-10-28-codex-desktop-ui-audit.md` §9.3（项目/最近、hover、右键、命令面板、分支、删除）。

### B. DSH 官方复用清单

- pin/archive：`ctx.remote.workspace.pinSession/unpinSession/archiveSession`（Client）或 `workspaceRegistry`（Host）。
- rename：`ctx.remote.session.rename` / `sessionTitle.rename`。
- open：`ctx.uiWorkspace.openSession`。
- fork：`sessionController.fork`（Host，live）/ `ctx.remote.session.fork`（冷会话）。
- 列表：`sessionQuery.listSessions/filterSessions`。
- 导出：`session-log-export`（ZIP）/ HEAD `formatSessionMarkdown`（按版本探测）。

### C. 尚未验证项

见 audit §10（Settings、归档/删除确认、子菜单、批量操作、rail tooltip、`Codex ⌄` 菜单）。

---

_最后更新：2026-10-29_
