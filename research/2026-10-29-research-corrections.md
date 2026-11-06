# 调研修正记录（2026-10-29）

> 用户原话：「还有你的调研做的是真的很差很差」。这份文件不辩解，只记录调研错在哪、为什么错、怎么改，以及现在还欠什么。相关文档：`research/tool-face-parity.md`、`research/codex-session-management.md`（补遗）、`research/2026-10-28-codex-desktop-ui-audit.md`（补遗）、`docs/decisions.md` D-029。

## 1. 被用户纠正的三次

| # | 我之前的结论 | 用户纠正 | 实际情况 | 证据 |
|---|---|---|---|---|
| 1 | 会话管理应该有「会话管理」按钮/面板（D-009） | 「ChatGPT 根本就没有会话管理这个 button」 | ChatGPT/Codex 没有常驻「会话管理」入口，管理内联在侧栏会话行 | 用户口述 + `docs/evidence/inline-session-menu.png`（D-023） |
| 2 | 没有「会话库」这个 feature；已归档聊天在设置里 | 「我都说了没有会话库这个 feature」「chatgptapp 里面是在设置页面里面有一个已归档的聊天」 | 归档会话是 **设置 → 已归档的聊天**（列表 + 搜索 + 取消归档 + 删除 + 全部删除），没有独立 Library 页面 | `docs/evidence/chatgpt-archived-chats-settings.png`（用户提供，2026-10-29） |
| 3 | Codex 模式不把会话管理交给模型（工具面只有 shell/apply_patch） | 「谁和你说的 codex 模式没有工具？在 codex session 里面可以让他直接创建新 session」 | Codex 桌面 app 通过 `codex_app` MCP 暴露 `create_thread` / `fork_thread` / `list_threads` / `read_thread` / `wait_threads` / `send_message_to_thread` / `handoff_thread` / `set_thread_archived` / `set_thread_title` 等线程工具 | app.asar 的 `enabled_tools`；rollout developer prompt「Thread Coordination」；见 `research/tool-face-parity.md` |

## 2. 根因（不是「资料不够」，是方法错了）

1. **从旧文档推断产品形态**：只看了 CLI/TUI/app-server 与上一轮 UI 审计，没有从「真实 app 的设置页/模型提示词/工具调用日志」重新取证。Codex 的模型工具面藏在 app bundle 的 `codex_app` MCP 配置与 developer prompt 里，文档不会写。
2. **漏看产品的设置页**：上一轮 UI 审计明确把 Settings 标为「未观察」（Ctrl+, 无响应），却没把这条列为阻塞缺口，而是继续按「侧栏 + Library」设计。用户一张截图就推翻了整个入口假设。
3. **先写实现再找扩展点**：先把精力花在 `main` 面板、`ctx.layout.selectPanel`、`plugins.*` 配置入口上；其实 DSH 设置对话框的 `settings.section` 才是第三方插件放配置/管理页的官方扩展点（`packages/client/ui-settings/src/client/contract/slots.ts:57`，dsh-dream/Claude Style 都在用）。
4. **没有逐条标注证据等级**：把「我推断」和「我核实」混在一起写，用户一追问就暴露。

## 3. 已修正

- `docs/decisions.md`：新增 D-029（设置页三入口 + 行菜单仅保留移入回收站 + 删除 Library/面板/插件页配置），并给 D-021/D-022/D-023/D-024 加「被取代」记录。
- 代码：`src/client/settings.tsx`（三个 `settings.section`）、`src/client/menu.tsx`（仅删除动作）、`src/client/index.tsx`（注册表）；删除 `page.tsx` / `navigation.ts`。
- `research/tool-face-parity.md`：Codex 模型工具面与 Threadloom 4 工具逐项对标。
- `research/codex-session-management.md`：顶部补遗，说明原文只覆盖 CLI/TUI/app-server。
- `research/2026-10-28-codex-desktop-ui-audit.md`：补 Settings → 已归档的聊天 这一缺口。
- 证据文件：`docs/evidence/chatgpt-archived-chats-settings.png`、`docs/evidence/dsh-settings-dialog.png`。

## 4. 后续调研协议（写进流程，不再靠自觉）

1. **参考产品**：先看真实界面（截图/实机）与真实模型工具调用（developer prompt、function_call 日志、app bundle 字符串），再引用文档；文档只作旁证。
2. **宿主 DSH**：先读源码里的 slot/service 契约，再找已安装第三方插件的实际注册实例；不靠猜测扩展点。
3. **每条结论必须带证据**：文件 + 行号、截图、rollout id、或「实测命令 + 日期」。推断必须显式标「推断」，不进决策。
4. **用户纠正即写 corrections log**（本文件），并回写受影响的决策文档；不静默改口。
5. **快照日期**：所有外部产品结论标注观察/版本日期，发布前重新核对。

## 5. 仍欠的调研/验证

- `create_thread` 的精确 arguments schema（需抓一次真实调用，或用更深的 asar 反编译）；本机 rollout 未捕获。
- ChatGPT Chat/Work 的模型工具面是否与 Codex thread 工具面不同（尚未核实）。
- 设置页三个分区的 live 截图与交互（需重启 3080 后验证：已归档列表加载、取消归档、删除、行菜单确认框）。
- DSH `settings.section` 的图标机制：settings shell 用 `navIcon(id)` 对 `archived-sessions` 预置归档图标，其他 id 回退齿轮；第三方 section 无法自定义图标（除非 id 命中内置映射）。
- Codex app 的 Settings 是否也有「已归档的聊天」（用户截图来自 ChatGPT app；Codex 分区设置未实机核对）。
