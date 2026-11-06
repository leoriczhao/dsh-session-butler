# Codex 模型工具面补遗与 Threadloom 对标（2026-10-29）

## 0. 为什么有这份文档

- 2026-10-27 的 `codex-session-management.md` 只枚举了 Codex 的 **CLI / TUI slash / app-server API** 三条通路，没有调查 **Codex 桌面 app 暴露给模型的工具面（T 面）**。
- 2026-10-29 用户指出「在 Codex session 里可以让它直接创建新 session」。随后在本机 ChatGPT 桌面端产物和 rollout 里找到证据：**Codex 模型有完整的 thread 工具族**，之前「Codex 不把会话管理交给模型」的表述是错的。
- 本文件记录证据、修正结论，并给出与 Threadloom 工具面的逐项对标。

## 1. 证据（本机实测，2026-10-29）

环境：ChatGPT 桌面端（Windows，Store 包 `OpenAI.Codex_26.1023.6621.0_x64__2p2nqsd0c76g0`，进程 `ChatGPT.exe` + `codex.exe`；即合并 ChatGPT/Codex 的同一 app）。

| # | 证据 | 来源 |
|---|---|---|
| E1 | `codex_app` MCP 工具配置 `enabled_tools = [create_thread, send_message_to_thread, handoff_thread, fork_thread]`（ephemeral 时为空） | `app.asar` 反编译 `buildMcpCodexConfig` |
| E2 | `dynamicToolCall` / `mcpToolCall` 的 `namespace=codex_app`、`tool=create_thread` 是 UI 可渲染的一等工具调用；渲染代码带 `::created-thread` 处理 | `app.asar` 反编译 `dy()`、item schema |
| E3 | developer `<app-context>`「Thread Coordination」列出工具：`create_thread, fork_thread, list_threads, list_archived_threads, read_thread, wait_threads, send_message_to_thread, handoff_thread, set_thread_archived, set_thread_title` | rollout `sessions/2026/10/18/...01a14db7...jsonl.zst` 的 developer message（模型 GPT-6） |
| E4 | `create_thread` 语义：仅当用户明确要求；创建出的线程 **user-owned、出现在侧栏**、用户直接跟进；异步 dispatch，需要 `wait_threads`；成功后输出 `::created-thread{threadId="..."}`；子任务应改用 multi-agent 工具 | 同上 E3 |
| E5 | 侧栏组织工具：`list_threads` / `list_projects` / `create_sidebar_section` / `rename_sidebar_section` / `delete_sidebar_section` / `move_thread_to_sidebar_section` / `move_project_to_sidebar_section` / `reorder_sidebar_projects` / `reorder_sidebar_sections`（移入 pinned 即置顶） | 同上 E3「Sidebar Organization」 |
| E6 | Worktrees：`create_worktree` / `archive_worktree` / `restore_worktree` / `list_artifacts`；Automations：`automation_update`、`set_thread_archived` | 同上 E3 |
| E7 | 本机近 120 个 rollout 实际调用统计：`exec` 6643、`shell_command` 2260、`apply_patch` 198、`js` 110、`wait` 206、`update_plan` 33、`view_image` 17、`spawn_agent` 6、`wait_agent` 81、`list_agents` 18、`send_message` 47、`interrupt_agent` 4、`followup_task` 4 | 本地 rollout 解析（可复现脚本见 §5） |

**限制**：本机 rollout 最新只到 2026-10-21，且**没有捕获到 `create_thread` 的真实调用**（用户实际使用可能发生在未落盘的云端/更新后的 app）。E1/E2 证明工具存在且是一等调用，E3/E4 证明其语义与触发条件；但 `create_thread` 的精确 arguments schema 尚未实测。

## 2. Codex 模型工具面清单（去重）

| 类别 | 工具 | 与 Threadloom 关系 |
|---|---|---|
| 线程生命周期 | `create_thread`、`fork_thread`、`list_threads`、`list_archived_threads`、`read_thread`、`wait_threads`、`send_message_to_thread`、`handoff_thread`、`set_thread_archived`、`set_thread_title` | 核心对标对象 |
| 侧栏组织 | `list_projects`、`create/rename/delete_sidebar_section`、`move_thread/project_to_sidebar_section`、`reorder_sidebar_projects/sections` | DSH 侧栏无自定义分区，不可对齐 |
| Worktree | `create_worktree`、`archive_worktree`、`restore_worktree`、`list_artifacts` | DSH 无 worktree 概念，不属插件 |
| 多 agent | `spawn_agent`、`wait_agent`、`list_agents`、`send_message`、`interrupt_agent`、`followup_task` | DSH 对应 Agent Teams / `subagent_*`（不同语义） |
| 自动化 | `automation_update`、`set_thread_archived` | DSH 有自动化任务，但无 agent 工具面 |
| 执行/其他 | `exec`、`wait`、`shell_command`、`js`、`apply_patch`、`update_plan`、`view_image`、`web_search` 等 | Codex 主工具面，不是会话管理 |

**关键观察**：清单里**没有 delete/删除工具**。Codex 把「创建/分叉/读取/等待/发消息/移交/命名/归档」交给模型，唯独不暴露删除——这和我们 D-003「删除不进工具面」的边界一致。

## 3. Threadloom 当前 4 工具 vs Codex

| Codex 工具 | Threadloom | 状态 |
|---|---|---|
| `create_thread`（user-owned，出现在侧栏，异步，成功后 emit `::created-thread`；可排队 worktree setup） | `session_butler_new`：创建归属调用方 workspace 的空白会话，返回 id；无 name/worktree/初始任务 | ⚠️ 主干一致、能力子集 |
| `fork_thread` | `session_butler_fork(atSeq)`：默认最近完成轮，支持精确轮边界 | ⚠️ 主干一致 |
| `list_threads` / `list_archived_threads` | `session_butler_list`（query/cwd/archived/subagents/limit） | ⚠️ 部分：无 pinned/parent 过滤、无 cursor、无独立 archived 入口 |
| `read_thread` | `session_butler_detail`（header/stats/血缘一次性 DTO） | ⚠️ 部分：无 turns/items 分页 |
| `set_thread_title` | 无（交官方 UI rename） | ❌ 可补（Host `sessionTitle.rename`） |
| `set_thread_archived` | 无（交官方 UI archive） | ❌ 可补（Host `workspaceRegistry.archiveSession`） |
| `wait_threads` | 无 | ❌ DSH 无跨会话事件流工具化，需新建设计 |
| `send_message_to_thread` | 无 | ❌ DSH 无普通会话间消息服务（Agent Teams `send_message` 只发给 teammate） |
| `handoff_thread` | 无 | ❌ 无对应能力 |
| 侧栏分区 / worktree / automation | 无 | ❌ 不做 |
| （无 delete） | 无（D-003） | ✅ 边界一致 |

按「会话管理」类工具计：Codex 10 个线程工具，Threadloom 覆盖 `create_thread`、`fork_thread` 主干 + `list_threads`、`read_thread` 部分；约为 **2 完整 + 2 部分 / 10**。

## 4. 对 D-015/D-003 的影响

- D-003（删除不进 agent 工具面）**被 Codex 验证**：Codex 模型工具面也没有 delete。
- D-015 的「只做创建 + 只读，管理动作交人」是**比 Codex 更保守的产品选择**，不是「与 Codex 对齐」的结论。若要对齐 Codex，需补 `set_thread_title`、`set_thread_archived`、`list_archived_threads` 等非破坏性写工具；`wait_threads`/`send_message_to_thread`/`handoff_thread` 依赖 DSH 尚不存在的能力。
- `create_thread` 的「user-owned、用户明确要求才创建」语义，对应我们 `session_butler_new` 的「只操作调用方自己的会话」约束；两者都避免模型自建后台会话。

## 5. 复现方式（本机）

- app 产物：`C:\Program Files\WindowsApps\OpenAI.Codex_26.1023.6621.0_x64__2p2nqsd0c76g0\app\resources\app.asar`（Linux 侧 `/mnt/c/...`）；搜索 `create_thread` / `codex_app` / `enabled_tools`。
- rollout：`C:\Users\leoric\.codex\sessions\**\*.jsonl.zst`（zstd）；解析 `response_item` payload type=message 的 developer 文本中的 `<app-context>` 段，以及 function_call/custom_tool_call 的 `name`。
- 注意：本机 rollout 最新 2026-10-21，且上述工具调用未在本地录像中出现；精确 schema 待一次真实调用或更深的 asar 反编译确认。

## 6. 待确认

1. `create_thread` 的 arguments schema（name? prompt? worktree? hostId?）——需要抓一次真实调用或反编译 `codex_app` MCP server 定义。
2. 是否把 `set_thread_title` / `set_thread_archived` / `list_archived_threads` 补进 Threadloom 工具面（会修改 D-015 边界）。
3. `wait_threads` / `send_message_to_thread` / `handoff_thread` 在 DSH 是否可行（需要会话间消息/等待服务，或只做 UI 层）。
