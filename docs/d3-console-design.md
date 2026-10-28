# Threadloom D3：完整会话管理台（设计草案 v0.1）

> 输入：`research/2026-10-28-codex-desktop-ui-audit.md`（Codex 桌面 UI 实机）、`research/codex-session-management.md`（CLI/app-server 能力矩阵）、`research/dsh-session-management-v2.md`（DSH 七个能力面）、`docs/dsh-web-ui.md`（slot/挂载）、`research/2026-10-28-dsh-plugin-management-survey.md`（插件管理接入面，进行中）、`docs/decisions.md`（D-001…D-020）。
>
> 状态：草案，等待用户确认后进入实现。本文回答四个问题：**D3 长什么样、双用户怎么用、删除/回收站到底重不重要、如何与 DSH 已有插件管理 feature 结合。**

---

## 0. 结论先行

1. **D3 = 一个控制台（人）+ 一组工具（agent）+ 一套插件管理集成（安装/设置/健康）。** 不是"回收站页面 + 删除按钮"。
2. **删除/回收站不是核心，降级为"清理（Cleanup）"模块**（见 §7）。核心是 **Library（检索/分组/预览）+ Detail（理解血缘与成本）+ Resume/Fork（接回与分支）+ Organize（置顶/归档/标签/备注）**。依据：Codex 实机里删除位于右键菜单最底部、无快捷键、无回收站；归档才是行内主生命周期动作。
3. **"完整"的定义**：覆盖会话的发现 → 理解 → 组织 → 接回 → 分支 → 清理 → 审计 七个环节；每个环节在 agent tool / 人类 UI / HTTP 桥 / Host 服务四个面都有明确落点（能做的做，不能做的写清楚为什么）。
4. **不重复 DSH 官方**：pin/rename/archive/fork/打开 官方已有，D3 只在"批量、跨 workspace 视图、详情页、回收站、标签/备注、导出"上补位；官方行菜单不能挂第三方动作（slot 限制），所以插件入口是 main 面板 + sidebar 入口 + 设置页 + 会话行装饰。
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

侧栏保留一个入口行（`sidebar.panellist`），只做"打开控制台/最近会话"两件事，不复制官方会话列表。

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

> 本节事实来自本机 DSH checkout（0.2.2-alpha.2）源码与真实插件页验收证据（`docs/evidence/plugin-detail.png`）；更细的插件管理契约见 `research/2026-10-28-dsh-plugin-management-survey.md`（后台复核中）。

### 8.1 DSH 现有插件管理面（已核实，D3 直接复用）

| 面 | 事实（源码/证据） | 对 Threadloom 的含义 |
|---|---|---|
| Plugins 设置页 | `packages/client/ui-settings-plugins` 拥有唯一 Settings 导航入口与 tab 容器；内置 inventory tab | 只能"贡献 tab"，不要抢 `settings.section` 导航行 |
| 插件详情页 | 显示 icon / 名称 / 版本 / 包名 / 描述 / Uninstall / 启用开关 / `meta.detail` 长文 / 组件与运行状态（实测 `docs/evidence/plugin-detail.png`） | 安装、启停、卸载、版本、说明**已由 DSH 提供**，不重做 |
| 运行状态 | Host `plugin-inventory` snapshot 每项含 `enabled`、`fiberPhase`（pending/loading/active/failed/unloading/null）、`diagnostic`、`managementAvailable` | fiber failed 已有诊断；**桥/存储/后端健康**需插件自报（§8.3） |
| `settings.plugins.tab` | list/root slot，第三方 client 可注册 tab；options `id/order/label`（label 可为 thunk，本地化）；标准 props 含 `useRemoteAccess/useSessions/useSessionStatus/…`；由 ui-settings-plugins 运行时声明 | 用独立 id + inject 等待声明；设置页就注册在这里 |
| 配置读写 | `ctx.remote.settings`（settings-controller）：`describe` 返回 schema/value/revision（secret 脱敏），`update/replace/mutate` 写回；`dsh-settings` 可把 Config 的 `.volatile()` 字段投影为表单（autoGenerate） | 配置只有**一个源**（profile patch）；不要在插件内再造一套配置存储 |
| 安装/生命周期 | `dsh plugin …` 子命令把参数转发给 profile 目录里的 pnpm；`engines.dsh` 约束版本；profile bundle + `cordis.patch.yml` | 升级 = npm 版本 + patch；破坏性变更靠 CHANGELOG + storage schema 迁移 |

**结论**：D3 不需要"插件管理"模块；D3 要补的是**插件配置的可见可改**与**运行期健康/诊断**这两块 DSH 插件管理不覆盖的部分。

### 8.2 设置页（注册 `settings.plugins.tab`，不抢导航）

注册参数与实现约束：

- `id: 'threadloom-settings'`（独立 id，勿复用 shipped id），`order: 100`，`label` 用当前 locale 的 tab 名；
- 在 `ctx.slots.inject('settings.plugins.tab', …)` 里注册，**等待 owner 声明**，声明不存在时不报错（headless/旧版本）；
- 组件 props 使用标准 `PropsRuntime`/`PropsLocale`/`InjectFace` 形状（参考 `ui-settings-plugin-inventory` 的 tab 实现）；重渲染用 `ctx.slots.subscribe`/`locale.subscribe`。

内容分组：

| 分组 | 项 | 默认 | 说明 |
|---|---|---|---|
| 入口 | 主面板入口 / 侧栏入口 | 开 | 关闭后仍可用命令与工具 |
| 回收站 | `trashRetentionDays` | 30 | 0 = 不自动清理（只标记 expired） |
|  | `cascadeSubagents` | true | 仅 `origin==='subagent'` |
| 危险 | `permanentDelete` | disabled | confirm = 输入完整 session id |
| 运行中 | `liveSettleTimeoutMs` | 3000 | 归档 stopActivity 后的等待上限 |
| 检索 | 内容搜索 opt-in | 关 | 依赖 `session-query` 后端；不可用时降级 |
| 诊断 | 健康快照 / 最近错误 / 复现命令 | — | 只读 |

**配置写入路径（二选一，D3.0 验证后定稿）**：

- **A 复用 DSH（首选）**：把 Config 字段标为 `.volatile()`，让 `dsh-settings` 的原生表单投影出来（autoGenerate）。若第三方插件也被允许显示在该页，则设置 tab 只展示健康 + 只读配置，写入交给 DSH。
- **B 自建 tab**：读桥 `/session-butler/api/status` 展示 resolved config 与"复制 patch 片段"，写入仍走 profile patch（**不建第二配置源**）。

> 风险：`settings.plugins.tab` 是运行时声明的 slot；旧 DSH 版本可能不存在 → tab 注册失败要静默降级，插件页仍显示基本条目。

### 8.3 运行期健康（补 inventory 看不到的部分）

`GET /session-butler/api/status` 扩展为：

```ts
interface ButlerStatus {
  version: string
  dshVersion: string
  host: { ok: boolean; error?: string }
  bridge: { ok: boolean; lastError?: string }
  storage: { trashWritable: boolean; metaWritable: boolean; trashCount: number }
  backends: { sessionQuery: boolean; workspaceRegistry: boolean; sessionTitle: boolean }
  counts: { sessions: number; trashed: number; live: number }
}
```

- 设置 tab 顶部用绿/黄/红显示；失败时给出可操作文案（"桥不可达：检查 web 组合/认证"）。
- 与 DSH 插件详情页的 `fiberPhase/diagnostic` 互补：前者是插件进程级，后者是**功能级**。

### 8.4 命令 / 工具 / 市场的可见性

- 命令：`/session-butler list|trash|restore|purge`（已有），P1 加 `/session-butler search|stats|trash-empty`；
- 工具：`session_butler_list/detail/new/fork`（已有）；描述中明确"只读/创建，不删除"；
- 插件页/README：名称、版本、描述、icon、locale（zh/en）、`meta.detail`（`docs/usage.md`）已在验收中验证可显示；
- 市场（dshmarket）：复用同一套 manifest 元数据，不额外造字段（若市场要求额外字段，D3.0 补齐）。

### 8.3 命令与工具（对插件管理可见）

- 命令：`/session-butler list|trash|restore|purge`（已有），P1 加 `/session-butler search|stats|trash-empty`；命令描述与插件页一致。
- 工具：`session_butler_list/detail/new/fork`（已有）；工具页的描述中明确"只读/创建，不删除"。
- 市场/发现：README/description/icon/locale 齐全；`dshmarket` 展示时用同一套元数据（待调研确认字段）。

### 8.4 诊断与支持

- 设置页"导出诊断"：版本、配置解析值（脱敏）、路由可达性、trash 目录可写、最近 20 条错误码、复现命令；
- 常见错误码（`session-running`、`session-locked`、`permanent-delete-disabled`、`trash-missing`）在 UI 有中文解释与修复建议。

---

## 9. Host / Client 架构增量

### 9.1 Host

- `service.ts`：现有 list/detail/trash/restore/purge 之外增加 `stats()`、`health()`、`tags/notes CRUD`（P1）、`exportMarkdown()`（P1，复用或自写）。
- `trash-store.ts`：sidecar `schemaVersion`、保留期扫描、批量恢复、孤儿 sidecar 清理。
- `bridge.ts`：现有路由不变；新增 `status` 扩展字段、`stats`、`meta`、`export`（P1）；统一错误信封。
- `storageDomain`：新增 `butler-meta` 键空间（标签/备注/未读）；与 trash 分键，避免耦合。
- 性能：列表分页在 Host 侧完成（已有）；标签筛选在 Host 侧 join；>1k 会话时缓存 stat 结果（TTL 30s，可配置）。

### 9.2 Client

- 现有：`main` keyed 页面 + `sidebar.panellist` 入口 + locale。
- 新增：`settings.plugins.tab` 页面（§8.2）；`sidebar.session.row.trailing` 轻量徽标（标签/子代理/大小，P2，避免与官方 hover 冲突）；`shell.overlay` 确认框（永久删除输入 id）。
- 页面拆分：`Overview`/`Library`/`Trash`/`Settings` + `DetailDrawer`；共享 `List`/`FilterChips`/`EmptyState`。
- 数据：桥优先，`sessions.refresh()` 在写操作后触发；本地缓存只做 UI 状态（筛选/滚动/选择）。
- 主题：用 DSH token（`docs/dsh-web-ui.md` §8），不硬编码颜色；暗色跟随。

---

## 10. 里程碑与验收

| 阶段 | 内容 | 验收 |
|---|---|---|
| D3.0 | 设计定稿 + 插件管理集成调研落地；设置页骨架；status 健康快照 | 设置页可见；健康红黄绿正确；无回归 |
| D3.1 | Library（搜索/筛选/排序/分页/批量 pin+archive）+ Detail 抽屉 + 概览 | 1k 会话首屏 <300ms；批量操作逐项结果可见 |
| D3.2 | 分叉入口（human）+ fork 边界（P1）+ Trash 完整（保留期/批量恢复/强确认）+ live 引导 | 误删=0；恢复=100%；live 阻断有文案 |
| D3.3 | 标签/备注、内容搜索 opt-in、导出 MD、Cleanup、诊断、i18n/主题、审计 | 标签筛选可组合；导出内容正确；诊断可复制 |
| 发布 | npm `0.2.0` + GitHub release + 市场元数据 | 安装/升级/回滚演练通过 |

---

## 11. 风险与开放问题

1. **配置写入**：DSH 插件管理页是否支持第三方运行时写配置？若不支持，设置页只读 + 复制 patch（待调研确认）。
2. **slot 可用性**：`settings.plugins.tab` 在不同 DSH 版本是否稳定？需要 `engines.dsh` 下限/特性探测。
3. **写操作重复**：官方已有 pin/archive；插件批量操作走官方 remote 还是 Host 服务？需确认失败语义与刷新。
4. **live 会话**：trash 的 stopActivity + settle 是否总能成功；失败时错误码与 UI 引导。
5. **性能**：1k+ 会话的 stat/事件折叠成本；是否引入本地索引（P2）。
6. **内容搜索**：`session-query` 后端默认关闭；插件要检测并降级。
7. **隐私**：回收站/导出包含用户内容；默认不导出、不云同步；诊断导出需脱敏。
8. **兼容**：fork 血缘在 REL 与 HEAD 不同（v2 §5.3）；D3 以 DSH 运行版探测为准。

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

_最后更新：2026-10-28_
