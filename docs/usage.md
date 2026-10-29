# Threadloom 使用说明

> 本文件是 DSH 插件详情页的长文（`locale/*.json` 的 `meta.detail` 指向它），也会随 npm 包发布。

## 这是什么

**Threadloom（`dsh-session-butler`）** 是 DeepSeek Harness 的会话管理插件。它把散落在各个 workspace 里的会话收拢成一个可检索、可整理、可恢复的统一管理面：

- **总览（Web 管理页）**：跨 workspace 平铺列出会话，按标题/路径/id 过滤，按 workspace / 已归档 / 子代理筛选；
- **详情**：行内展示 cwd、更新时间、归属 workspace、运行/空白/归档/迁移状态；详情弹窗展示轮数/步骤/消息/工具调用/token/日志字节/预设/血缘树与 enrichment 状态；删除前可看到级联子代理数量；
- **整理**：改名、置顶、归档（复用 DSH 已有能力，管理面集中操作）；
- **删除**：回收站优先——先移入回收站，可恢复；确认后才永久删除，并可选级联删除子代理会话；
- **批量**：会话与回收站列表均支持多选，批量移入回收站 / 批量恢复逐项返回结果；
- **Agent 工具**：`session_butler_list` / `session_butler_detail` 让模型在无 UI 场景读取会话列表与详情；`session_butler_new` / `session_butler_fork` 补齐 DSH 工具面的「会话 → 新会话」（新建同 cwd/preset 的空会话、或从当前会话按已完成轮分叉）。删除等破坏性写操作仍只留给命令/管理页。

> **版本状态（0.1.2，已构建待发布）**：M1–M4 已完成——Host 删除核心、`/session-butler` 命令、Web 管理页（列表/筛选/批量/详情/回收站/删除确认）、agent 工具均可用。0.1.1 修复工具 `parameters` 根 schema（native function calling 不再整请求失败）；0.1.2 补齐 `session_butler_new` / `session_butler_fork`，闭合 D-015 的工具面缺口。真实浏览器交互、隔离 `DSH_HOME` 的 trash→restore 闭环、`npm pack` 干净安装与 registry 全新安装均已验证。npm：<https://www.npmjs.com/package/dsh-session-butler>；源码：<https://github.com/leoriczhao/dsh-session-butler>。

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

## 入口（D3.0b，Codex 式）

没有独立的「会话管理」按钮；入口内联在日常使用的位置：

- **会话行 "..." 菜单**：hover 会话行 → 点 "..." → **会话详情…**（打开该会话的 Threadloom 详情弹窗）、**会话库…**（打开完整 Library / 回收站）；
- **DSH Plugins 页** → Threadloom bundle → 智能区块里的 **打开会话库**；
- 完整 Library 仍是一个 keyed `main` 面板，只从上面两处打开，不占用侧栏导航。

## Web 会话库（M2 + M3 + D3.0b）

打开后页面分两个标签页：

- **会话**：列表 + 过滤（标题/路径/id、workspace、显示已归档/子代理）；行内「详情」打开弹窗（轮数/步骤/消息/工具调用/token/日志大小/血缘/preset）；「打开」跳转会话；「移入回收站」先弹出确认（运行中会提示先停止，迁移中的会话会被拒绝，可勾选级联子代理）。
- **多选批量**：两个标签页都有全选/清空/选中计数；会话页可「移入回收站（n）」（逐项预检迁移态并汇总级联数），回收站页可「恢复（n）」；批量结果按成功/失败项聚合展示，失败项不影响其余项。
- **回收站**：列出已删除会话（删除时间、原路径、是否过保留期、级联关系）；「恢复」直接移回原目录；「永久删除」需要配置 `permanentDelete: confirm` 并再次输入完整 session id。
- 顶部「刷新」会同时刷新会话列表与回收站；所有失败都以稳定错误码显示（如 `session-locked`、`permanent-delete-disabled`）。

## DSH Plugins 页面（D3.0）

插件的配置字段全部声明为 DSH 的 volatile 配置，因此可以在 **DSH Plugins 页面**直接编辑（保存写回 profile patch，无需改文件）：

- 打开 DSH Plugins 页 → 选中 **Threadloom** bundle → 行 **session-butler** 的「配置」入口；
- 页面包含：回收站保留天数、运行中等待上限、级联子代理、会话行菜单动作开关、永久删除级别；
- bundle 页与插件详情页还会显示 **功能级健康**（版本、会话/回收站/运行中数量、存储可写性、后端能力、最近错误），数据来自插件自报的 `/session-butler/api/status`。

> 需要 DSH 0.2.2+ 的组合才会出现这些入口；旧版本上 Settings 表单与插件页区块会静默跳过，主管理页/命令/工具不受影响。

## Agent 工具（M3 + 0.1.2）

插件注册四个模型可见工具（删除等破坏性写操作仍只留给命令/管理页）：

| 工具 | 参数 | 返回 |
|---|---|---|
| `session_butler_list` | `query?`、`cwd?`、`includeArchived?`、`includeSubagents?`、`limit?`（1–100，默认 25） | `total` / `truncated` / 会话行（id、标题、cwd、时间、归档/置顶/子代理/live/迁移/flags） |
| `session_butler_detail` | `sessionId`（必填，精确 id） | header、统计（轮数/步骤/消息/工具/token/日志字节）、enrichment 状态、祖先与扁平化子代理后代（`depth`） |
| `session_butler_new` | 无 | 在**调用方会话自己的 cwd/preset** 下新建空会话，返回 `sessionId`（不接受任意路径/workspace/目标会话 id） |
| `session_butler_fork` | `atSeq?`（精确包含的源事件 seq；省略=最近一个已完成轮） | 把**调用方会话**分叉成新的独立会话，返回 `sessionId`/`sourceSessionId`/`atSeq`；同一路径与 Web Remote `session.fork` 语义一致 |

- `list`/`detail` 只读，不能移动、删除或修改任何会话；错误以 `session-not-found` 等稳定信息返回给模型。
- `new`/`fork` 只创建新的平级会话，不复制或删除旧会话；它们只在组合提供 `sessionController` 时出现（Web profile 有，headless/ACP 可能没有），且永远只操作调用方自己的会话。
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
- `trash`：预检通过后移入回收站；运行中会话会先归档停止（D-013），迁移中会话会被拒绝；默认级联子代理会话（fork 永不级联）。
- `restore`：移回原目录；原路径已被占用时拒绝。
- `purge`：永久删除，需要配置 `permanentDelete: confirm` 且第二次输入完整 session id。

## 配置

插件行可以在 profile 的 `cordis.patch.yml` 中覆盖配置（覆盖时 `config` 整块替换，未写的键使用默认值）：

```yaml
- id: session-butler
  config:
    trashRetentionDays: 30        # 回收站保留天数；0 = 不自动清理
    cascadeSubagents: true        # 删除时级联子代理会话（fork 永不级联）
    permanentDelete: disabled     # disabled | confirm（confirm 需输入完整 session id）
    liveSettleTimeoutMs: 3000     # 运行中会话先归档停止、再等待的毫秒上限
    inlineMenuEnabled: true       # 是否在会话行 "..." 菜单注入 Threadloom 动作
```

## 安全边界

- **运行中的会话不会被直接删除**：插件会拒绝，或按配置先归档（`stopActivity`）再删除。
- **删除前必须抢占跨进程写租约**：证明没有其他 DSH 进程正在写同一个会话。
- **只删会话目录内的文件**：不触碰 `attachments`、其他插件数据或未知文件。
- **永久删除**默认关闭，开启后要求输入完整 UUID，并展示将级联删除的子会话数量。
- **fork 不属于血缘**，不会被级联删除。

## 兼容性

- 兼容声明由顶层 `engines.dsh` 独占决定（`dsh.engines.dsh` 不被读取）。
- `workspaceRegistry`、`sessionTitle`、`subagents` 等能力按可选依赖探测：headless / ACP profile 缺少这些服务时，插件降级而不是崩溃。
- 存储层若从当前 JSONL 目录形态切换，插件会拒绝执行删除并提示升级，而不是盲删文件。

## 链接

- 设计文档：`docs/architecture.md`
- 决策记录：`docs/decisions.md`
- 发布流程：`docs/publishing.md`
