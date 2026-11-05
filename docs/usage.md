# Threadloom 使用说明

> 本文件是 DSH 插件详情页的长文（`locale/*.json` 的 `meta.detail` 指向它），也会随 npm 包发布。

## 这是什么

**Threadloom（`dsh-session-butler`）** 是 DeepSeek Harness 的会话管理插件。按 Codex 桌面端（合并后的 ChatGPT/Codex）的形态，它把管理动作放进**设置页**，删除**确认后一步完成**：

- **设置 → 已归档的聊天**：列出从侧栏归档的会话，支持搜索、按项目分组、**取消归档**、**永久删除**、**全部删除**（与 ChatGPT 桌面端「设置 → 已归档的聊天」一致）；
- **设置 → Threadloom**：插件配置（级联、删除等待、行菜单开关等 4 个字段），保存即生效；
- **会话行 "..." 菜单 → 删除会话**：侧栏会话的快捷永久删除（带确认，可配置关闭）；
- **Agent 工具**：`session_butler_list` / `session_butler_detail` / `session_butler_new` / `session_butler_fork`（删除等破坏性写操作不进入工具面，D-003/D-015）；
- **命令**：`/session-butler list|trash|restore|purge`（CLI 保留内部回收站作为高级恢复手段）。
- **没有用户可见的回收站页面**：删除确认后立即执行，不再要求去第二个页面二次删除（D-030）。

> **版本状态（0.2.1，已构建待发布）**：0.1.x 完成 Host 删除核心、命令、agent 工具与真实浏览器验证；0.2.0（D-029）移除会话库面板/插件页配置，改为设置页入口；0.2.1（D-030）按用户三次纠正移除回收站页面，删除改为一步永久删除。真实浏览器交互、隔离 `DSH_HOME` 的 trash→restore 闭环、`npm pack` 干净安装与 registry 已安装验证均在 0.1.x 完成；0.2.1 的 Host 删除方法需**重启 DSH 进程**后生效。npm：<https://www.npmjs.com/package/dsh-session-butler>；源码：<https://github.com/leoriczhao/dsh-session-butler>。

## 安装

DSH ≥ 0.2.1-rc.2（`engines.dsh`: `>=0.2.1-rc.2 <0.3.0-0`；下限经本插件实际使用的 API 在 rc.2 发布包上审计确定）。

```bash
# Web 侧：Plugins 页面安装，或由 agent 调用 plugin_manager 的 install_bundle
# CLI：
dsh plugin --profile <profile> add dsh-session-butler@<version>
```

安装会向 profile 的 `cordis.patch.yml` 层插入一行 `session-butler`，并自动启用该 bundle。卸载：

```bash
dsh plugin --profile <profile> remove dsh-session-butler
```

## 入口（0.2.1 / D-030，Codex 模式）

产品里**没有**「会话管理」按钮，也**没有会话库页面**。所有管理入口都在日常位置：

| 入口 | 位置 | 动作 |
|---|---|---|
| 已归档的聊天 | **设置 → 已归档的聊天** | 搜索、按项目分组、取消归档、永久删除、全部删除 |
| 插件配置 | **设置 → Threadloom** | 4 个字段，保存即写回 profile patch |
| 删除侧栏会话 | 会话行 hover → "..." → **删除会话** | 确认后立即永久删除；`inlineMenuEnabled=false` 时隐藏 |
| 插件健康 | 侧栏 **插件** → Threadloom → 详情 | 健康徽标 + 诊断区块 |

> 设置对话框的分区由 DSH 的 `settings.section` 扩展点提供（与 Claude Style / Dream 记忆等插件同级）；插件不再往插件页塞配置入口。

## 设置页细节

### 已归档的聊天

- 数据来自 Host bridge 的 `list`（`archivedOnly: true`），只返回归档行；旧 Host 会忽略该字段，由客户端过滤；
- 取消归档调用 DSH 官方 `uiWorkspace.unarchiveSession`，侧栏随官方 store 恢复显示；
- 「永久删除」/「全部删除」直接调用 bridge `delete` / `delete-many`：确认后立即永久删除，**不会**进入第二个回收站页面；
- 搜索按标题 / 路径 / id 过滤；列表按项目（cwd）分组，无项目归入「无项目」。

> 没有「设置 → 回收站」入口（D-030）。Host 仍在内部保留 trash 管线（跨进程租约、运行中停止、同盘移动）作为删除安全层；CLI 的 `trash`/`restore`/`purge` 命令继续可用，但 GUI 删除是一步完成的。

## 配置（设置 → Threadloom）

字段（全部为 DSH volatile 配置，保存经 `configForms` 写回 profile patch，Host 在使用点读取，保存即生效）：

| 字段 | 默认 | 说明 |
|---|---|---|
| `trashRetentionDays` | 30 | CLI 回收站保留天数；0 = 不设到期时间（GUI 不显示回收站） |
| `cascadeSubagents` | true | 删除时级联子代理会话（fork 永不级联） |
| `liveSettleTimeoutMs` | 3000 | 等待宿主自行释放已加载会话的毫秒上限；插件不会主动停止或归档该会话 |
| `inlineMenuEnabled` | true | 是否在会话行 "..." 菜单显示「删除会话」 |

> `permanentDelete` 字段仍保留在 schema 中供 CLI `purge` 使用（兼容已有 profile patch），但 GUI 删除以确认对话框授权，不再要求该配置。

也可以在 profile 的 `cordis.patch.yml` 中覆盖（覆盖时 `config` 整块替换，未写的键使用默认值）。插件详情页仍显示**功能级健康**（版本、会话/回收站/运行中数量、存储可写性、后端能力、最近错误），数据来自插件自报的 `/session-butler/api/status`。

## Agent 工具（M3 + 0.1.2）

插件注册四个模型可见工具（删除等破坏性写操作仍只留给人类 UI/命令）：

| 工具 | 参数 | 返回 |
|---|---|---|
| `session_butler_list` | `query?`、`cwd?`、`includeArchived?`、`includeSubagents?`、`limit?`（1–100，默认 25） | `total` / `truncated` / 会话行（id、标题、cwd、时间、归档/置顶/子代理/live/迁移/flags） |
| `session_butler_detail` | `sessionId`（必填，精确 id） | header、统计（轮数/步骤/消息/工具/token/日志字节）、enrichment 状态、祖先与扁平化子代理后代（`depth`） |
| `session_butler_new` | 无 | 在**调用方会话自己的 cwd/preset** 下新建空会话，并自动归属调用方 Workspace，返回 `sessionId`（不接受任意路径/workspace/目标会话 id；空白会话可点侧栏「新会话」复用后开始对话） |
| `session_butler_fork` | `atSeq?`（精确包含的源事件 seq；省略=最近一个已完成轮） | 把**调用方会话**分叉成新的独立会话，返回 `sessionId`/`sourceSessionId`/`atSeq`；同一路径与 Web Remote `session.fork` 语义一致 |

- `list`/`detail` 只读；`new`/`fork` 只创建新的平级会话，不复制或删除旧会话；它们只在组合提供 `sessionController` 时出现（Web profile 有，headless/ACP 可能没有），且永远只操作调用方自己的会话。
- 工具输出同时带 JSON 值（供脚本化使用）与经过裁剪的文本渲染（供人读）；详情后代过多时文本会注明截断。

## 命令（M1）

在任意会话的 composer 中输入：

```
/session-butler list
/session-butler trash <session-id> [--cascade|--no-cascade]
/session-butler restore <session-id>
/session-butler purge <session-id> <session-id>
```

- `list`：列出回收站条目（删除时间、保留期是否已到、级联来源）。
- `trash`：预检通过后移入回收站；仍被加载的会话会等待宿主释放，超时则拒绝，不主动停止或归档；迁移中会话会被拒绝；默认级联子代理会话（fork 永不级联）。
- `restore`：移回原目录；原路径已被占用时拒绝。
- `purge`：CLI 高级恢复路径上的永久删除，需要配置 `permanentDelete: confirm` 且第二次输入完整 session id；GUI 不使用该命令，删除走 bridge `delete`。

## 安全边界

- **支持原生删除的宿主**：已加载的空闲会话由其宿主所有者安全释放，再由持久化后端持锁删除；无需为每次删除重启。仍有活动、待输入、维护或活跃子代理时会拒绝，不会主动丢弃工作。健康快照 `backends.nativeDeletion === true` 表示宿主与后端都提供所需能力。
- **旧宿主保留保护**：没有原生能力时，仍加载的会话会被拒绝。可安全重启持有它的 DSH 实例，随后不要重新打开目标会话，直接删除。旧路径的写租约探测仅是瞬时检查，不构成完整跨进程事务。
- **跨进程要求**：原生后端的稳定 ID 锁覆盖删除与元数据清理。共享同一会话根目录的写入进程必须一起升级，不能混用不遵守新锁的旧写入者。
- **只删会话目录内的文件**：不触碰 `attachments`、其他插件数据或未知文件。
- **删除确认后立即永久删除**：GUI 用确认对话框提示不可恢复；新宿主使用原生删除事务，旧宿主保留移动后立即 purge 的路径。级联从叶到根逐项提交；中途失败会明确报告已移除部分，不保证整棵树全部提交或全部撤销。CLI 的 `purge` 保留 `permanentDelete` 门禁与完整 id 输入。
- **fork 不属于血缘**，不会被级联删除。

## 兼容性

- 兼容声明由顶层 `engines.dsh` 独占决定（`dsh.engines.dsh` 不被读取）。
- `workspaceRegistry`、`sessionTitle`、`subagents` 等能力按可选依赖探测：headless / ACP profile 缺少这些服务时，插件降级而不是崩溃；`settings.section` 不存在时设置页贡献静默跳过。
- 存储层若从当前 JSONL 目录形态切换，插件会拒绝执行删除并提示升级，而不是盲删文件。

## 链接

- 设计文档：`docs/architecture.md`
- 决策记录：`docs/decisions.md`（D-030 为当前删除/入口设计，取代 D-029 的回收站部分）
- 调研修正：`research/2026-10-29-research-corrections.md`
- 发布流程：`docs/publishing.md`
