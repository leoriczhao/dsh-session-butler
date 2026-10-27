# 决策记录（ADR）

> 格式：每条决策记录 **背景 / 决策 / 理由 / 影响 / 状态**。
> 状态：`accepted`（已定）、`proposed`（建议，待用户确认）、`open`（待决）、`superseded`。
> 事实依据见 [`architecture.md`](./architecture.md) 与三份调研文档。

## 已定决策

### D-001 范围重定位：不重做 DSH 已有能力 · accepted

- **背景**：产品调研（`research/codex-session-management.md`）写于早期，假设 DSH 缺少改名/置顶/归档。经 0.2.1-rc.3 源码与 live service 核实：rename、pin/unpin、archive/unarchive、fork、export 均已有（Host Service + Web Remote + GUI 行菜单）。
- **决策**：Threadloom 的 MVP 聚焦 **统一管理页（列表/检索/详情/批量）+ 删除/回收站 + 命令面**；已有能力通过官方 Remote/Host Service 复用，不重写状态机。
- **影响**：README、`docs/usage.md`、里程碑（M1–M3）按此重排；「归档 = 移动目录」的假设作废。

### D-002 包身份与发布渠道 · accepted

- **背景**：用户选择。
- **决策**：
  - npm 包名 **`dsh-session-butler`**（unscoped，npm 上可用）；产品显示名 **Threadloom**（`locale/*.json` 的 `meta.title`）。
  - 发布到 **npmjs 公共 registry**；MIT 许可证；首版 `0.1.0`。
  - 兼容声明：顶层 `engines.dsh: ">=0.2.1-rc.3 <0.3.0"`；**不写** `dsh.engines`。
- **影响**：`package.json`、`cordis.patch.yml`（行 `name` 必须是裸包名）、构建产物中的模块 id、locale、文档统一使用该包名；GitHub 仓库地址待发布前补 `repository`/`homepage`/`bugs`。

### D-003 删除采用「插件侧回收站优先」 · accepted

- **背景**：DSH 无官方删除 API，且设计 note 明确"等真实消费者再加"（`SessionPersistence.delete()` 于 2026-06-20 被移除）。存储层处于 proposed 重构期。
- **决策**：
  - M1 在插件侧实现：`sessionQuery` 定位 → 路径/kind 校验 → `sessionPersistence.open(id,'write')` 跨进程写租约探测 → 同盘 `rename` 到 `~/.dsh/session-butler/trash/<id>/` → `storageDomain` 记录 → 清理 pin/archive 状态。
  - 回收站目录与索引由插件自持；保留期由 `trashRetentionDays` 控制（默认 30 天，`0` = 不自动清理）。
  - 永久删除（purge）需要回收站记录 + 完整 session id 确认；`permanentDelete` 默认 `disabled`。
  - 同时向上游提交 issue/PR 建议：`SessionPersistence.delete()` + `session/deleted` 事件 + 缓存/客户端失效钩子。上游落地后插件切换过去，删除目录的代码删除。
- **理由**：在无官方 API 的前提下，回收站优先把不可逆操作降到最低；租约探测避免删除其他进程正在写的会话；`kind === 'jsonl'` 判断让存储在重构后安全失败而不是误删。
- **影响**：插件需要文件系统能力（`node:fs` / `dshHomePath`），需要有 fixture 测试；存储重构时可能失效（有稳定错误码兜底）。

### D-004 级联只沿 `origin === 'subagent'`，fork 永不级联 · accepted

- **背景**：DSH 血缘 = `header.parentSession` + `header.origin === 'subagent'`；fork 是独立会话（`isSeeded: true`，不写 parentSession），但历史 fork 可能保留来源 id。
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
- **决策**：顶层 `engines.dsh` 声明 0.2.x 范围；peerDependencies 只声明 `@deepseek-ai/cordis` / `@deepseek-ai/schemastery`（optional），不声明 `@deepseek-ai/dsh*` peers；Host 侧全部通过 Service 契约访问，可选服务 `ctx.get` 探测；不 import 具体实现包。
- **影响**：DSH 升级时先跑 verify；发现 API 变化收紧范围而非放宽。

### D-012 跨 workspace 移动不做 · accepted

- **背景**：header 不可变、persistence 以 header 定目录；`workspace.entity.attachSession` 要求 cwd realpath 与 workspace path 一致。真"移动"需要改 header（非法）或重放新建。
- **决策**：MVP 与二期都不做跨 workspace 移动；若未来需要，先讨论「copy 后旧会话标记迁移」的产品语义并要上游支持。

### D-013 删除运行中会话的默认交互 · proposed

- **决策（建议）**：管理页对 running 会话的删除按钮先弹「先停止并归档？」；确认后调用官方 `archiveSession({stopActivity:true})`，再执行 trash。拒绝在运行中直接删。
- **待确认**：是否允许"强制停止并删除"（需要用户显式二次确认）。

## 待确认问题（发布前必须收敛）

| # | 问题 | 建议默认 |
|---|---|---|
| Q1 | 回收站默认保留期？ | 30 天（`trashRetentionDays=30`），到期仅提示不自动 purge |
| Q2 | 永久删除是否默认开启？ | 默认 `disabled`，用户在 profile 配置里显式改 `confirm` |
| Q3 | 归档是否级联子会话？ | 不级联（保持官方语义），UI 提示"子会话仍在列表中" |
| Q4 | 首版是否接受无内容级检索？ | 接受（D-007），内容检索二期 |
| Q5 | 是否同时提供 CLI 子命令（`dsh session …`）？ | 二期；首版先做 `/session-butler` 命令 + Web 页 |
| Q6 | 迁移中（formatStatus=migration-required）的会话删除策略？ | 先 resume 完成迁移再删，或拒绝并提示 |

## 发布门禁（MVP acceptance checklist）

- [ ] `pnpm run verify` 全绿（typecheck + build + tests + package validation）
- [ ] M1 删除核心在临时 `DSH_HOME` fixture 上通过：trash/restore/purge/级联/锁冲突/运行中拒绝
- [ ] M2 管理页在临时 profile 通过：挂载、列表、筛选、trash/restore/purge、错误码展示、刷新
- [ ] 临时 profile 用绝对路径 link 安装并 `--dump-config` 校验（`docs/publishing.md` 阶段 C）
- [ ] `npm pack` 产物在干净目录安装后 `exports` 全部可解析（阶段 B）
- [ ] locale（zh/en）、icon、detail 文档在插件页正确显示
- [ ] running/archived/fork/subagent 四类边界测试通过
- [ ] CHANGELOG、版本号、`engines.dsh` 与 DSH 运行时一致
