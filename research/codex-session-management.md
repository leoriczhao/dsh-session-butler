# Codex 会话管理调研（2026-10-27 快照）

> 目的：为我们自己要做 DSH 会话管理插件，整理 Codex（OpenAI Codex CLI / 桌面端 / 云端）在"会话管理"上的**用例、功能面与设计决策**。
> 来源：官方文档（learn.chatgpt.com，`.md` 版本）、Codex CLI 0.146.0 changelog、app-server 协议文档、GitHub issues、社区第三方工具。文末有链接。

---

## 0. TL;DR

Codex 把会话（Thread）做成**一等资源**，围绕它有完整闭环：
**新建 → 续聊 → 组织（命名/置顶/分组）→ 分叉 → 归档/删除 → 导出/分享/迁移**，
并且同一套概念在 **CLI 命令 / TUI slash 命令 / app-server API** 三条通路都暴露。

存储上：JSONL 线程日志（rollout）+ SQLite 状态库（metadata/索引/分页），
归档 = 移目录（可恢复），删除 = 永久删（级联子代理会话）。

社区仍存在大量第三方会话浏览工具（codex-resume / codex-sessions / resumer），
说明"官方 picker 之外的检索、预览、跨主机管理"仍是真实痛点。

---

## 1. 数据模型与存储

| 概念 | 说明 |
|---|---|
| **Thread（会话）** | 一段人机对话；有 id、可选 name、metadata（isPinned、gitInfo）、状态（active/archived） |
| **Turn（轮）** | 一次用户请求 + 后续 agent 工作；可列表分页（`thread/turns/list`） |
| **Item（项）** | 消息、命令执行、文件变更、工具调用等；可单独分页读取 |
| **sessionId** | 线程树的根 id；fork 出来的线程保留 root 的 sessionId（`thread.sessionId != thread.id` 是常态） |
| **父子关系** | 子代理/派生会话有 `parentThreadId` / `ancestorThreadId`，归档/删除会**级联** |

存储（app-server 文档明确 + 社区工具佐证）：
- 线程日志：每线程一个 **JSONL 文件**（rollout），新版持久化线程默认走**分页历史**（SQLite 状态库），旧版 `historyMode: "legacy"` 仍支持；
- **归档目录**：`thread/archive` 把 JSONL 移入 archived 目录；`thread/unarchive` 移回；
- **SQLite 状态库**：name、isPinned、gitInfo、列表/搜索索引；`useStateDbOnly` 可跳过 JSONL 扫描；
- **输入历史**：`~/.codex/history.jsonl`（`history.persistence = save-all | none`，`history.max_bytes` 限大小；另有 tool output token 预算）；
- 社区工具扫描 `~/.codex/sessions` 目录（**文档未直接写死路径，以社区工具为准**）。

---

## 2. 用例清单（按用户故事组织）

### A. 新建与切换
- `/new` 在同一 CLI 进程里开新 chat（不清理终端），`/new bug bash` **创建时就命名**；
- `/clear` 清屏并开新 chat，`/clear <name>` 同时命名；Ctrl+L 只清屏不换会话；
- 多会话并存：可随时切回旧会话，不用退出 CLI；
- `/side` 开一个**临时旁支会话**（ephemeral fork），主会话继续跑，可看到主会话状态；旁支结束回主线。

### B. 续聊 / 恢复
- `/resume` 打开**已保存会话选择器**，选一个恢复（原历史不变）；
- `codex resume`：`--last` 默认**限定当前工作目录**，`--all` 跨目录；支持模型/sandbox 覆盖，不支持 `--worktree`；
- `codex resume <SESSION_ID>`；`codex exec resume --last|<ID>` 非交互续跑（CI 两段式流水线）；
- **跨目录续聊**是显式决策：`tui.resume_cwd = "current" | "session"`，未设置且有差异会**提示选择**；`--cd/-C` 优先级最高；
- `codex queue --thread <UUID|名字> --message "..."`：给**已有会话排队一条消息**（无需前置交互）；
- 桌面端 `/app` 把当前 CLI 会话**继续到桌面 app**。

### C. 组织：命名 / 置顶 / 浏览 / 检索
- `/rename <name>` 或 `/rename` 弹命名框；`thread/name/set`；**UUID 与名字二义时 UUID 优先**，按名字操作需要确认；
- **置顶**（pin）：`isPinned` metadata，app-server 用 `thread/list` 过滤 `isPinned`；桌面端 pin 与移动端同步；
- `/agents`（= `codex agents`）：**command center**，浏览共享 server 上的会话、看状态、切换；需要本地/远程 server；
- `/subagents`：在同一会话的**子代理线程**之间切换查看；
- 桌面端：**内容 + 分支名搜索**历史 chat；过去 chat 按项目/workspace 组织；
- 第三方 TUI（codex-resume / codex-sessions / resumer）：扫描 `~/.codex/sessions`，提供**预览、搜索、跨主机**恢复。

### D. 分叉与实验
- `/fork`：克隆当前 chat 为**新 ID**，原 transcript 不动，可并行探索另一条路；
- `codex fork`（无参 = picker；`--last`；`<ID> --worktree` 在 **Git worktree** 里分叉）；
- TUI 快捷：Esc Esc（空 composer）**编辑上一条用户消息并从该点 fork**；
- app-server `thread/fork`：`lastTurnId` **截断到某轮**、`ephemeral: true` **内存分叉**（不落盘）；
- `/worktree`：在受管 worktree 里开新 chat 或继续当前会话（桌面端同能力）。

### E. 归档、恢复、删除
- `codex archive <id|name>` / `codex unarchive <id|name>`：**保留 transcript**，只是移出活动列表；
- `/archive` 归档当前会话（有确认；若 turn 在跑会**先停 turn**）；归档会**级联尝试归档子代理线程**；
- `codex delete <id|name>` / `/delete`：**永久删除** transcript 及派生子会话；`--force` 仅限 UUID，按名字删除必须二次确认；
- 归档目录可浏览/恢复（移动端也有 archived-chat 浏览）；
- GitHub 需求源头：issue #8784 "codex delete <session>"。

### F. 导出 / 分享 / 迁移
- `/export`：复制或保存**整段会话 Markdown**（`/export session.md` 直接落盘）；
- `/share`：生成**只读快照链接**（会 redact 已知密钥模式，快照不能 fork，可当附件导入新会话）；
- **Chat handoff**：会话连同 **Git 状态**在本地 ↔ 远端主机间转移，可复用 worktree 继续；
- 云端：`codex cloud list` 列历史 chat、`codex cloud exec` 提交、`codex apply` 把云端 diff 应用到本地；
- `/import`：从 Claude Code / Cursor 导入（发现最近 30 天、最多 50 条会话）；
- `codex exec fork <SESSION_ID> [PROMPT]`：把已保存会话复制成新会话继续跑。

### G. 容量 / 成本 / 完整性
- `/compact` 压缩上下文（自动也会压缩）；`/recap` 生成摘要但不释放上下文；
- 关闭持久化：`codex exec --ephemeral`（不写 rollout 文件）；app-server 内存 fork；
- `history.persistence=none`、`history.max_bytes`；`/status` 看会话状态；
- 真实痛点：issue #24948 **会话日志涨到 700MB–2GB**（反复 compaction 历史 + 原始工具输出）。

### H. 多端 / 多用户 / 远程
- `codex app-server`（stdio / ws / unix socket）+ `--remote`：TUI 连远端 server；
- 共享 server 上 `/agents`、`codex agents --remote <URL>` 做**多会话 command center**；
- 移动端 Remote：archived-chat 浏览、Spotlight/Shortcuts 入口、`/side`；
- 企业：session sharing via object storage（issue #9717）、audit/compliance 日志。

---

## 3. 三条通路矩阵

| 能力 | CLI 命令 | TUI slash | app-server API |
|---|---|---|---|
| 新建 | `codex` / `codex exec` | `/new [name]`、`/clear [name]` | `thread/start` |
| 续聊 | `codex resume [--last/--all/<id>]`、`exec resume` | `/resume` | `thread/resume` |
| 列表/搜索 | `codex cloud list`（云端）、picker | `/resume` picker、`/agents` | `thread/list`（searchTerm/archived/isPinned/cwd/parent/ancestor 过滤、游标分页） |
| 读取历史 | `/export` | `/export` | `thread/read`、`thread/turns/list`、`thread/items/list` |
| 命名 | —（CLI 无直接命令） | `/rename`、`/new <name>` | `thread/name/set` |
| 置顶 | — | 桌面端 UI | `thread/metadata/update`（isPinned） |
| 分叉 | `codex fork [--last/<id> --worktree]`、`exec fork` | `/fork`、Esc Esc、`/side` | `thread/fork`（lastTurnId / ephemeral） |
| 归档 | `codex archive` | `/archive` | `thread/archive` |
| 恢复归档 | `codex unarchive` | — | `thread/unarchive` |
| 删除 | `codex delete [--force]` | `/delete` | `thread/delete` |
| 排队消息 | `codex queue --thread` | Tab 排队 | `turn/start` / `turn/steer` |
| 分享/导出 | — | `/share`、`/export` | 快照接口（未公开细节） |
| 切换/清理 | — | `/new`、`/agents`、`/subagents` | `thread/loaded/list`、`thread/unsubscribe` |

app-server 其余相关方法：`thread/compact/start`、`thread/revert`（删除某轮及之后）、`thread/inject_items`、`thread/goal/*`、`thread/loaded/list`；事件：`thread/started|archived|unarchived|closed|status|name/updated|deleted`。

---

## 4. 值得借鉴的设计决策

1. **会话有稳定 id + 用户名字两条寻址通道**；冲突规则明确（UUID 优先；按名字操作要确认），避免"同名删错"。
2. **归档 ≠ 删除**：归档只移动文件（可恢复、可浏览），删除才真正移除；删除**级联 descendants**，且危险操作有分级确认（UUID 才允许 --force）。
3. **fork 是历史拷贝，原会话不可变**；支持三种形态：全量 fork、`lastTurnId` 截断、`ephemeral` 内存分支（`/side` 用完即弃）。
4. **跨目录/跨主机是一个需要显式决策的状态**（`resume_cwd`、handoff 携带 Git 状态），默认不静默套用。
5. **子代理会话是一等线程**：有 parent/ancestor 关系、可单独 resume 查看、归档/删除时级联。
6. **存储分层**：事件日志（JSONL，可回放/导出）+ 状态库（SQLite：索引、metadata、分页）；`useStateDbOnly` + scan-and-repair 兜底损坏/漂移。
7. **输入历史与对话持久化分离**（`history.jsonl` 可关、可限大小）。
8. **多端同一概念**（CLI / 桌面 / 移动 / 云端 / app-server），并用 server 做"命令中心"。
9. **容量是产品问题**：压缩（/compact）、日志膨胀 issue、持久化开关（--ephemeral）。

---

## 5. 对我们要做的 DSH 会话管理插件的启示

### DSH 现状（已核实）
- 存储：`~/.dsh/sessions/<workspace>/session-<uuid>/session.v4.jsonl.zstd`（每个会话一个目录 + `session.lock`，header 事件含 id / createdAt / cwd / agentPreset）；
- 现有 GUI：侧栏按 workspace 分组、`Show N more sessions`、会话名搜索、**归档（Archive）** 动作；
- 现有服务层：`session-query` 服务（`listSessions` / `searchSessions`，有 sqlite 实现）+ 官方 experimental `dsh-experimental-session-search`（给 agent 的 5 个只读工具）；
- 现有 CLI：仅 `--resume <session>`，**没有** list / archive / delete / rename 子命令；
- 生态里已有一些只做"归档管理/删除"的社区插件（dsh-archive-manager 247★、dsh-session-manager 84★ 等），说明这块是真实缺口，但没人做完整闭环。

### 建议的 MVP 用例优先级
1. **列表 + 搜索**：按 workspace / 标题 / id / 内容（用 session-query 索引）、时间、大小、模型/preset 过滤；游标分页。
2. **会话详情**：cwd、workspace、创建/更新时间、轮数/token、大小、preset、模型、子代理血缘。
3. **命名 + 置顶**：rename（写 header/metadata）、pin（本地 metadata 文件或 session projection）。
4. **归档 / 取消归档**：移目录 + 侧栏可见性；操作后刷新列表。
5. **删除（含级联）**：先移回收站/二次确认；级联子代理会话；显示"将删除 N 个派生会话"。
6. **fork / side**（第二期）：复制历史为新会话；lastTurn 截断；临时旁支不落盘。
7. **导出 / 分享**（第二期）：Markdown 导出（官方已有 session-log-export 包可复用）、只读快照。
8. **跨目录 / 跨 workspace**（第二期）：移动会话（改 cwd 元数据 + 索引）、resume 时的 cwd 选择提示。

### 与 Codex 的差异化机会
- DSH 的 **workspace 一等分组**、**agent preset 迁移**、**Agent Teams 会话血缘**比 Codex 更结构化，可以把"团队会话树"做成特色视图；
- 利用 `session-query-sqlite` 做**内容检索**（Codex 的 thread/list searchTerm 也是这个思路）；
- 参考 Codex 的分级危险操作：归档 → 回收站 → 永久删除（UUID 强确认）。

### 需要产品决策的开放问题
1. 删除：回收站（可恢复）还是永久？保留多久？
2. fork 语义：复制历史 vs 引用（磁盘/一致性权衡）；是否支持 `lastTurnId` 截断？
3. 命名冲突：允许同名？按名字操作时是否强制 UUID？
4. 归档是否级联子代理会话（DSH subagent session 目前是否独立落盘）？
5. 跨 workspace 是 "move" 还是 "copy"？cwd 变更如何与 session projection cache 同步？
6. 删除正在运行的会话怎么办（先停 turn？拒绝？）——Codex 是"先停 turn"再归档，删除在运行中不可用。

---

## 6. 参考链接

- Codex CLI 命令参考（含 resume/fork/archive/delete/queue/agents）：https://learn.chatgpt.com/docs/developer-commands
- Slash 命令详解（/new /clear /rename /resume /fork /side /agents /subagents /export /share）：同上
- 非交互模式（exec / exec resume / --ephemeral / --json）：https://learn.chatgpt.com/docs/non-interactive-mode
- app-server 协议（thread 生命周期、list/resume/fork/archive/delete、事件）：https://learn.chatgpt.com/docs/app-server
- 配置参考（history.persistence、history.max_bytes、tui.resume_cwd）：https://learn.chatgpt.com/docs/config-file/config-reference
- Codex CLI 0.146.0 发布说明（会话命名、置顶、side chat、临时 fork）：https://github.com/openai/codex/releases/tag/rust-v0.146.0
- Issue #8784 codex delete session：https://github.com/openai/codex/issues/8784
- Issue #24948 会话日志膨胀 700MB-2GB：https://github.com/openai/codex/issues/24948
- Issue #9717 企业级会话分享：https://github.com/openai/codex/issues/9717
- 社区工具：codex-resume（Textual TUI，扫 ~/.codex/sessions）、Uri2001/codex-sessions、jin-ttao/resumer
