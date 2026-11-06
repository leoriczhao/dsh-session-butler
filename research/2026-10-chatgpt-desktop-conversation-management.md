# ChatGPT Desktop 会话管理调研（2026-10-28）

> 一句话结论：ChatGPT 桌面端**没有「会话管理页」**。会话管理被拆进 **侧栏列表 + 行内 ⋯ 菜单 + 搜索 + Settings 里的归档/批量区**，并用 **Temporary / Locked / Archived / Deleted 四层「隐藏强度」** 区分状态；删除永远是最后一步，且多数路径不可逆。

## 1. 调研说明

| 项 | 内容 |
|---|---|
| 调研时间 | 2026-10-28 16:55–17:50（Asia/Shanghai） |
| 对象 | 2026-07 起上线的 **new ChatGPT desktop app**（macOS / Windows；Linux 公测）；兼容的 ChatGPT Classic；以及 Web / 移动端可比行为 |
| 方法 | OpenAI Help Center 官方文章 + ChatGPT release notes + app release notes（第一手）；未依赖第三方二手文章；**未安装/运行** ChatGPT desktop（本机 Linux、无 ChatGPT 账号） |
| 可信度 | ✅ 官方原文；⚠️ 由 release notes / 文章推断、未实机验证 |
| 已知限制 | 官方新文档站 learn.chatgpt.com（Bing 显示 1 天前更新）在当前网络 DNS 被污染、连接被拒，**未能读取**；桌面端真实 UI 未截图验证 |

## 2. TL;DR（12 条）

1. **管理不离开列表**：Pin / Rename / Archive / Delete / Lock / Move to project / Share 都从会话行内「⋯」菜单发起；没有独立的「会话管理」页面。
2. **侧栏 = 会话的家**：全局切换器（ChatGPT / Codex）→ Chat / Work 切换 → **Pinned**（chat + project 混排）→ **Recents**（Chat 与 Work 会话统一列表）→ Projects；设置固定在底部。
3. **Recents 可组织**：可合并为一个列表，或**按 project 分组**；2026-07 起可 **排序、过滤、置顶**（Unified Recents）。
4. **搜索是「找回」的主入口**：侧栏搜索 + 内容类型过滤器（All / Chats / Images / Documents / Projects），匹配标题与消息；Archived 可搜，Deleted 不可搜，Locked 不进搜索。
5. **四层隐藏强度**：Temporary（不进历史，可保存转正）→ Locked（PIN / 生物识别门禁）→ Archived（移出侧栏、仍可搜、Settings 管理）→ Deleted（立即不可见、30 天内永久删除、不可恢复）。
6. **Pin 是一等公民**：会话与项目都能 pin，共用一个 Pinned 区；可从侧栏 hover 直接操作；Pinned 在 desktop 与 iOS 间同步（同一 Codex 账号；Android 暂不含）。
7. **归档 ≠ 删除**：归档无需确认、可搜索、可在 Settings > Data controls > Archived chats 恢复或删除；支持 **Archive all / Delete all** 批量操作。
8. **Codex 会话更严格**：**必须先 Archive 才能 Delete**；归档会停掉正在运行的 chat 和挂着的 scheduled task；Codex 历史与 ChatGPT 历史分离。
9. **分支（Branch）是一等功能**：消息级「More actions → Branch in new chat」（2025-09 从 Web 上线）；在 shared project 里 branch 会出现在项目内，用于探索新方向而不破坏原线程。
10. **Projects 是「会话 + 文件 + 指令 + memory」的容器**：chat 可移入/移出 project；进入后继承 instructions / files 上下文；project 可分享、可 branch、可删除。
11. **Temporary chat 可「转正」**：开始前选 Personalized / Unpersonalized；不写记忆、不训练；可保存为普通会话（保存后按普通会话规则处理）；不保存则离开后无法从历史找回。
12. **删除/分享/导出都有明确的对象规则**：删除的 chat 立即从视图消失、30 天内永久删除；删除不删 Library 里的独立文件；分享链接是快照（workspace 链接可追加）；locked / archived / shared link 与删除的交互都有官方说明。

## 3. 产品结构与入口地图（截至 2026-10）

### 3.1 应用形态

- **new ChatGPT desktop app**：2026-07-09 全球上线 macOS + Windows；2026-08-14 起 Linux（Ubuntu 24.04/26.04、Debian 13、Fedora 43/44）public preview。
- **ChatGPT Classic**：上一代桌面 app，可继续使用，继续收模型更新/修复；新 agent 功能可能只在新 app。两者可能并存安装（名称不同）[S4][S14]。
- **应用内三个体验**：**Chat**（提问/对话）、**Work**（研究、分析、产出文档/表格/幻灯片/报告/Sites）、**Codex**（本地文件/仓库/终端/开发工具）。桌面端顶部全局切换器选 ChatGPT / Codex；ChatGPT 内再切换 Chat / Work [S4]。
- **Chat 与 Work 的会话**统一进入 **Recents**；**Codex 历史独立**，不进 ChatGPT 历史 [S4]。
- **跨端**：Cloud Work 会话在 web/mobile/desktop 同步；**本地会话留在本机**（local Work conversations 不能 lock）[S4][S9]。

### 3.2 侧栏与导航（会话相关）

| 区域 | 内容 | 来源 |
|---|---|---|
| 顶部 | 全局切换器：ChatGPT / Codex；Chat / Work toggle（桌面端） | [S4] |
| Pinned | 置顶区，**chats 与 projects 混排**；可从侧栏 hover 直接 pin | [S14] 2026-06-18 |
| Recents | 最近会话；Chat + Work 统一；可排序/过滤/置顶；可合并为一个列表或**按 project 分组**；侧栏最多展示 8 条最近会话，其余走展开/滚动 | [S4][S14] 2026-07-16 / 2026-08-21 |
| Projects | 项目列表；可从项目内新建 Chat 或 Work；项目同时是上下文边界 | [S3][S4] |
| Scheduled | 独立页面：查看/暂停/恢复/编辑/删除定时任务 | [S14] 2026-06-17 |
| 底部 | Settings（含 Data controls → Archived chats；Desktop settings 含 companion 快捷键等） | [S1][S5][S14] |
| 其他 | Plugins / Skills（侧栏）；移动端把 Images/Codex/Pulse/Apps 收进聊天上方的 chip 横条 | [S14] 2026-03-26 |

### 3.3 搜索

- 入口：侧栏 Search；Web 上 Ctrl+K（Windows）/ Cmd+K（macOS）；Windows app 历史搜索用 Control+K；macOS app 有「Conversation search」[S2][S13][S12]。
- 范围：**chats、projects、images、documents**，可加过滤器；匹配 chat 标题与消息；如连接 Google Drive，可含 Drive 文件/文件夹 [S2]。
- 语义：**Archived 可搜；Deleted 不搜；Locked 不搜**（需去 Projects > Locked chats 用 PIN/设备认证打开）[S2][S9]。
- 官方提醒：**「更早的会话从侧栏消失 ≠ 被删除」**，先搜索；搜索更新可能有延迟 [S2]。

### 3.4 桌面专属快捷入口

- **Windows：Companion Window**（Alt+Space）：即时提问、上传文件、生成图片、开始新会话；记住位置；New chat 清空；误关可再用快捷键或从侧栏历史继续；快捷键可在 Settings > App > Companion window hotkey 改；与其它应用冲突时可能不生效 [S5]。
- **macOS：Chat Bar**（默认 ⌥+Space）：即时提问、上传文件、截图/拍照、直接开始新会话；可拖动窗口、菜单栏图标打开；快捷键可改 [S11]。
- **macOS Classic** 还有：Option+Space 打开 companion window 并**开始新会话**、把历史会话「pop out」成 companion window、侧栏折叠快捷键 [S12]。

## 4. 对象与状态模型

### 4.1 四层「隐藏强度」

| 状态 | 侧栏可见 | 可搜索 | 找回入口 | 关键语义 | 来源 |
|---|---|---|---|---|---|
| **普通会话** | 是（Recents / Pinned / Projects） | 是 | 侧栏 / 搜索 | 普通保存；受 retention/训练设置约束 | [S1][S2] |
| **Temporary chat** | 否（离开即不可从历史找回） | 否 | 只能当场保存为普通会话 | 不写记忆、不训练；可选 Personalized / Unpersonalized；**保存即转正**；临时期间 OpenAI 最多保留 30 天用于安全 | [S7][S6] |
| **Locked chat** | 不在常规历史/搜索/pin；侧栏只显示 Locked chats 项目，标题隐藏 | 否（常规搜索不返回） | Projects > Locked chats + 4 位 PIN / Face ID / Touch ID / 设备解锁 | 不是 E2E 加密；不改变 retention 和「改进模型」设置；锁定时会**离开所在 project**；重置 PIN 会永久删除所有 locked chats 及仅受 PIN 保护的文件 | [S9][S14] 2026-10-20 |
| **Archived chat** | 否（移出常规侧栏） | 是 | Settings > Data controls > Archived chats（或 View archived chats） | 无需确认；保留策略不变；若会话用于 scheduled task，后续运行可能暂停；可 Unarchive | [S1] |
| **Deleted chat** | 否 | 否 | **不可恢复**（UI / API / Support 都不行） | 立即从账户视图移除；30 天内从 OpenAI 系统永久删除（例外：已去标识化/法律安全保留）；删除不删 Library 独立文件；删除会带走会话内的 connected-app 数据 | [S1][S8] |

### 4.2 其他对象

| 对象 | 说明 | 来源 |
|---|---|---|
| **Project** | 会话 + 文件 + instructions + memory 的容器；chat 可移入/移出；项目内可新建 Chat/Work；删除 project 会永久删除其 chats/instructions 与仅存于项目的文件（Library 文件保留） | [S3] |
| **Pinned** | chat 和 project 都可 pin；统一 Pinned 区；跨 desktop ↔ iOS 同步（同一 Codex 账号） | [S14] 2025-12-18 / 2026-06-18 / 2026-08-20 |
| **Branch** | 从某条消息 More actions → Branch in new chat 派生新会话；shared project 内 branch 与原始会话并列 | [S14] 2025-09-04 / [S3] |
| **Shared link** | 个人账号分享是**快照**（可 Update link 刷新）；workspace 链接可包含分享后的新消息；可删除链接；删除原会话后链接行为有单独说明 | [S10] |
| **Codex chat** | 独立历史/侧栏；**先 Archive 后 Delete**；归档停 running chat 与 scheduled task；批量删除在 Settings > Archived chats | [S8] |
| **Space（2026 新）** | 页面/文件夹式内容空间，部分账号取代 Library；**与 chats/projects 分离**；移动端只读 | [S15] |
| **Scheduled task** | 侧栏 Scheduled 页面统一管理；可分享 | [S14] 2026-06-17 / [S10] |

## 5. 用例清单（按用户任务组织）

> 说明：每条给出「场景 → 入口/步骤 → 关键语义与边界 → 来源」。桌面端（新 app）与 Web 的差异单独标注；未验证处标 ⚠️。

### A. 开始与捕获

| # | 用例 | 入口 / 步骤 | 关键语义与边界 | 来源 |
|---|---|---|---|---|
| A1 | 从侧栏开新会话 | 侧栏 New chat | 普通会话，进入 Recents | [S2][S4] |
| A2 | 不离开当前工作、快速提问 | Windows Alt+Space / macOS ⌥+Space 唤起 Companion / Chat Bar，直接输入；可附文件/截图 | 默认新会话；清空用 New chat；可继续到主窗口；快捷键可配 | [S5][S11] |
| A3 | 无痕提问（不写历史、不训练） | 新会话 → 选 Temporary，先选 Personalized / Unpersonalized | 开始后不能改 personalization；不写记忆；可保存转正；否则离开不可找回 | [S7][S6] |
| A4 | 在项目上下文里开新会话 | Projects → 项目内选 Chat（或 Work） | 继承项目 instructions / files / memory 设置 | [S3][S4] |
| A5 | 开一个「工作型」长任务会话 | Chat / Work 切到 Work；Cloud Work 会话可跨端继续 | 本地 Work 会话留在本机；可 lock 的只有 cloud Chat/Work 会话 | [S4][S9] |
| A6 | 起一个 Codex 开发会话 | 全局切到 Codex，按原有 Codex 工作流 | Codex 历史独立；不参与 ChatGPT 搜索/Recents | [S4][S8] |

### B. 找回（Find / retrieve）

| # | 用例 | 入口 / 步骤 | 关键语义与边界 | 来源 |
|---|---|---|---|---|
| B1 | 从最近列表继续 | 侧栏 Recents（最多展示 8 条最近；展开看全部） | 新 app 里 Chat + Work 统一 | [S14] 2026-08-21 / 2026-07-16 |
| B2 | 按关键词找会话 | Search → 输入词 → 选 All / Chats / Images / Documents / Projects → 打开结果 | 匹配标题与消息；Web Ctrl/Cmd+K；Windows app Control+K；⚠️ desktop 与新版全量搜索的完全一致性未验证 | [S2][S13] |
| B3 | 找「侧栏里没了」的会话 | 先 Search（不要急着认为被删）；再去 Settings > Data controls > Archived chats | 官方明确：从侧栏消失 ≠ 删除 | [S2][S1] |
| B4 | 找置顶的重要内容 | Pinned 区（chats + projects） | 从侧栏 hover 直接 pin；跨设备同步 | [S14] 2026-06-18 / 2026-08-20 |
| B5 | 找归档会话 | Settings → Data controls → Archived chats / View archived chats | 归档会话仍可搜索；可 Unarchive | [S1][S2] |
| B6 | 找加密隐藏的会话 | Projects → Locked chats → PIN / 设备认证 | Locked 标题在侧栏隐藏；不进常规搜索 | [S9] |
| B7 | 跨设备接着用 | Cloud Work 会话在 web/mobile/desktop 同步；Codex 会话可在移动端 Remote tab 打开 | 本地会话不同步（留在本机） | [S4] |
| B8 | 「会话丢了」排查路径 | ①确认账号/workspace ②Search ③看 Archived ④刷新/重登 ⑤看 status.openai.com ⑥数据导出 | 官方给出的 missing chats 流程；Deleted 无法恢复 | [S1][S2] |

### C. 整理 / 组织

| # | 用例 | 入口 / 步骤 | 关键语义与边界 | 来源 |
|---|---|---|---|---|
| C1 | 重命名会话 | 会话行 ⋯ → Rename（或侧栏交互） | 2026-02 起侧栏操作更快；macOS Classic 曾修过 renaming chats in sidebar | [S14] 2026-02-27 / [S12] |
| C2 | 置顶会话 / 项目 | 侧栏 hover → ⋯ → Pin；或行内 pin 控件 | Pinned 区混排 chats 与 projects；可跨端同步 | [S14] 2025-12-18 / 2026-06-18 / 2026-08-20 |
| C3 | 把已有会话收进项目 | 把 chat 拖到 project，或 chat 菜单 → Move to project | 移入后继承项目 instructions / files；Pinned chat 也可移动；GPT 创建的 chat 不能移入；可 Remove from project 移回历史 | [S3] |
| C4 | 把相关会话收在一起（不用项目） | Recents 设为 combined，或 group chats by project | 项目分组的替代方案；不引入新对象 | [S14] 2026-06-18 |
| C5 | 调整 Recents 的可见条数感 | 侧栏最多展示 8 条最近会话，其余展开 | 2026-08-21 的更新 | [S14] 2026-08-21 |
| C6 | 给会话加「保护区」 | ⋯ → Lock chat | 锁定后离开 project；需 PIN；⚠️ 不改变 retention/训练 | [S9] |

### D. 派生 / 继续（Branch / continue）

| # | 用例 | 入口 / 步骤 | 关键语义与边界 | 来源 |
|---|---|---|---|---|
| D1 | 从某条消息分叉探索新方向 | 消息 hover → More actions（⋯）→ Branch in new chat | 不破坏原线程；官方 2025-09 从 Web 上线；⚠️ 桌面端/移动端是否全部可用未逐项验证 | [S14] 2025-09-04 |
| D2 | 在共享项目里分叉 | 打开已有 chat 继续对话；branch 出现在项目内、与原会话并列 | 用于保留原思路同时试新假设 | [S3] |
| D3 | 从 Chat Bar / Companion 继续到主界面 | 关掉 companion 后从侧栏历史打开该会话 | 官方建议路径 | [S5] |
| D4 | 跨端继续 Work | Cloud Work 会话在桌面开始、web/mobile 续；反向也行 | 本地会话不参与 | [S4] |
| D5 | 保存/复制他人内容 | Project 内可把 chat 响应 Add to project sources；离开 shared project 可选择复制自己的 chats | 复制是副本，不是引用 | [S3] |

### E. 分享 / 协作

| # | 用例 | 入口 / 步骤 | 关键语义与边界 | 来源 |
|---|---|---|---|---|
| E1 | 分享单个会话链接 | 会话 ⋯ → Share → Create/Copy link | 个人账号为**快照**，可 Update link 刷新；workspace 链接可含后续消息；可删除链接 | [S10] |
| E2 | 分享项目 | 项目 Share → 邀请个人/群组，或 Anyone with a link；chat/edit 两种权限 | 协作上限：Pro 40 files/100 人；Plus/Go 25 files/10 人；Free 5/5；可随时改可见性 | [S3] |
| E3 | 从项目分享单条会话 | 私有项目内 chat → Share | 接收者只看该 chat，不看项目其它内容；shared project 里分享的 chat 需先加入项目才能看 | [S3] |
| E4 | 分享定时任务 | Scheduled → Share | 刷新快照不改变对方已排的任务 | [S10] |
| E5 | 导出/迁移数据 | Settings → Data controls 导出；导出文件可在账号间转移 | 导出含 shared_conversations.json（含链接 ID/会话 ID/标题/匿名设置） | [S10][S17] |

### F. 清理（Archive / Delete）

| # | 用例 | 入口 / 步骤 | 关键语义与边界 | 来源 |
|---|---|---|---|---|
| F1 | 会话不删、但不想看见 | 行内 ⋯ → Archive | **无需确认**；移出常规侧栏、仍可搜索；保留策略不变；可能影响 scheduled task 后续运行；可在 Settings 里 Unarchive | [S1] |
| F2 | 彻底删掉会话 | 行内 ⋯ → Delete → 确认 | 立即不可见；30 天内永久删除；不可恢复；不删 Library 独立文件；删除会带走会话内 connected-app 数据 | [S1] |
| F3 | 批量归档 / 批量删除 | Settings → Data controls → Archive all chats / Delete all chats → 确认 | 作用于当前账户/workspace，包括 project 内会话；Delete all 不可撤销 | [S1] |
| F4 | 删除 Codex 会话 | 先 Archive → Settings → Archived chats → 垃圾桶 → Delete | **先归档才能删**；归档会停 running chat 和 scheduled task；支持批量删除全部 archived | [S8] |
| F5 | 删除项目 | 项目 ⋯ → Delete project | 永久删除项目内 chats/instructions 与仅存于项目的文件；Library 文件保留；协作者失去访问；不可撤销 | [S3] |
| F6 | 删除后确认「真的没了」 | 搜索不到；数据导出核对；Support 也无法恢复 | deleted 不进搜索；官方明确不可恢复 | [S1][S2] |

### G. 隐私 / 保护

| # | 用例 | 入口 / 步骤 | 关键语义与边界 | 来源 |
|---|---|---|---|---|
| G1 | 敏感会话不进历史 | Temporary chat（见 A3） | 不保存则离开不可找回；可转正 | [S7] |
| G2 | 敏感会话上锁 | chat ⋯ → Lock chat → 默认二次确认 → 建/输 4 位 PIN | 隐藏标题/内容；常规搜索不返回；**不是加密保险箱**；锁定时离开 project；重置 PIN 会删除所有 locked chats（含仅受 PIN 保护的文件） | [S9] |
| G3 | 关闭历史记录 | Settings 关闭 chat history（2023 起） | 关闭期间会话不进侧栏、不训练 | [S14] 2023-05-03 |
| G4 | 删除账户/会话前的准备 | 数据导出、删除 shared links、active sessions | 分享链接/导出与删除有独立说明 | [S10][S17] |

### H. 批量 / 系统级

| # | 用例 | 入口 | 说明 | 来源 |
|---|---|---|---|---|
| H1 | 管理归档区 | Settings → Data controls → Archived chats | 恢复 / 删除 / 批量删除；Codex 的归档删除也在这里 | [S1][S8] |
| H2 | 管理 scheduled tasks | 侧栏 Scheduled 页面 | 查看下次运行、暂停/恢复/编辑/删除 | [S14] 2026-06-17 |
| H3 | 搜索过滤 | Search → 内容类型 filter | 找不到时回 All | [S2] |
| H4 | 桌面快捷键/窗口形态 | Settings：companion hotkey、sidebar toggle、floating sidebar（Windows） | Windows 有浮窗侧栏；macOS 有侧栏折叠快捷键 | [S5][S12][S13] |

## 6. 交互设计要点（ChatGPT 的做法）

1. **就地管理（in-place）**：所有会话级动作挂在会话行的 ⋯ 上，不给「管理」单独造页面。
2. **侧栏是唯一会话入口**，Settings 只放两类东西：**归档区（回收前的最后可见地）** 和 **批量危险操作**。
3. **分级隐藏**而不是二元删除：Temporary → Locked → Archived → Deleted，每层都有独立入口与找回方式。
4. **确认只给不可逆操作**：Archive / Pin 无确认；Delete / Delete all / Delete project 有确认且文案强调不可恢复。
5. **Codex 采用「先归档再删除」** 的两段式，降低误删（对 agent 产品尤其值得抄）。
6. **搜索优先**：官方 troubleshooting 的第一建议是搜索，而不是让用户翻页；Archived 仍可被搜索到。
7. **对象对等**：chat 与 project 共享 pin、share 等交互模型，减少概念分裂。
8. **项目 = 上下文容器**：会话管理不只是「收纳」，还改变模型可用上下文（instructions/files/memory）。
9. **跨端同步的是「组织状态」**（pinned、cloud Work），本地会话明确留在本机。
10. **快速捕获入口独立**：Chat Bar / Companion 让「新会话」不要求先回到主窗口。

## 7. 桌面端 vs Web / Classic / 移动端

| 维度 | new ChatGPT desktop app | ChatGPT Classic | Web | 移动端 |
|---|---|---|---|---|
| 会话域 | Chat + Work（统一 Recents）+ Codex（独立） | 单一 ChatGPT 会话 | Chat（Work 也可用） | Chat / Work；Codex 经 Remote tab |
| 侧栏 | 全局切换器 + Pinned + Recents（可合并/按项目分组）+ Projects | 传统侧栏 | 同新版侧栏（Web） | 简化侧栏 + 顶部 chip 横条 |
| 搜索 | 有（macOS Classic 有 Conversation search；Windows Control+K；新版全量搜索在桌面的一致性 ⚠️） | 有 | 侧栏搜索 + Ctrl/Cmd+K + filters | 有搜索（跨内容类型） |
| 快速入口 | Windows Alt+Space Companion；macOS ⌥+Space Chat Bar | macOS Option+Space companion | 浏览器标签页 | App 图标 |
| 删除 | 行内 Delete（确认）；Codex 先归档再删 | 行内 Delete | 同左 | 长按会话 → Delete |
| Locked chats | 支持（仅 cloud Chat/Work；Codex 与本地 Work 不可锁） | 不支持（新功能） | 支持 | 支持（PIN / Face ID / Touch ID / 设备解锁） |
| 归档管理 | Settings → Data controls → Archived chats | 同 | 同 | 同 |
| 其他 | 浮窗侧栏（Windows）、本地文件/内置浏览器、Work 跨端 | 继续维护 | Branch 2025-09 起 | 置顶 2025-12 起 |

## 8. 对 DSH / Threadloom 的启示（初步，待确认方向）

### 8.1 DSH 现状（本仓库核对）

- 官方 Web 侧栏的会话行**已有** Rename / Pin / Archive / Fork（apps/web/tests/session-row-hover/actions.expected.json 与 e2e 用例可见），**没有 Delete/回收站**。
- DSH **没有** locked / temporary chat；没有 project 对象（workspace/cwd 只承担部分「上下文边界」）；没有 30 天删除保留期。
- 第三方插件的 UI 插槽只有 **main panel** 和 **sidebar 入口**（此前调研结论），**不能给官方 session row 加菜单项**——这意味着「像 ChatGPT 一样在行内加 Delete/Pin」在当前 DSH 里做不到，除非上游开放 slot。

### 8.2 可借鉴 / 不可照搬

| ChatGPT 模式 | 对 Threadloom 的参考价值 | 备注 |
|---|---|---|
| 行内管理、无管理页 | 很高 | 与「不要独立管理页」的判断一致；但 DSH 插件加不了行内菜单，只能靠工具/命令或自建面板 |
| Temporary / Locked / Archived / Deleted 四层 | 高 | Temporary 与 Locked 依赖 DSH 核心能力（加密/门禁、不进历史），第三方插件很难独立实现 |
| 删除 = 归档 → 回收站 → 永久（含保留期/批量） | 很高 | DSH 完全缺失，是插件唯一无争议的硬功能；但要先解决 live session 不能删的问题（需要 DSH dispose API 或重启变冷流程） |
| 搜索 + 内容类型过滤 | 高 | DSH 侧栏有搜索；跨 workspace/回收站搜索是插件可补的增量 |
| Pin 对象统一（chat + project） | 中 | DSH 有 pin（聊天）；若引入 project/分组需重新设计 |
| Branch | 低 | DSH 已有 fork，语义接近 ChatGPT branch；无需重做 |
| Project 作为上下文容器 | 中 | 与 DSH workspace 可能重叠；要不要引入「project」是新设计决策 |
| Chat Bar / Companion 快速捕获 | 低 | Web GUI 插件做不了系统级热键；低优先级 |
| Codex 式「先归档再删」 | 高 | 适合作为 DSH 无条件删除的替代安全流程 |

### 8.3 三个候选方向（供下一轮讨论，不急着定）

- **D1 纯工具面（agent-first）**：list / detail / new / fork / rename / pin / archive / search 工具化；删除只走 /session-butler 命令 + 桥 API（不进 agent 工具面，维持 D-003）。不做主面板页。
- **D2 回收站控制台（human-first）**：只做「已归档/已删除」的恢复与批量清理面板，不重复列全部会话；删除流程 = archive → trash → purge（含确认与保留期）。
- **D3 完整管理台**：跨 workspace 搜索/过滤/批量 + 回收站；需要先解决 live 会话删除（等 DSH 上游 dispose API，或接受「重启后清理」）。

### 8.4 待确认的问题

1. 目标用户主要是 **agent（工具调用）**，还是 **GUI 里的人**，还是两边都要？
2. 删除/回收站是否要作为下一版核心（它是 DSH 唯一完全缺失的硬功能）？
3. 要不要引入 project/分组 概念，还是复用 DSH 的 workspace/cwd？
4. Temporary / Locked 这类隐私语义，是否值得为 DSH 重新设计（还是映射成「不写入会话/只读分享」等弱化版）？
5. UI 面：砍掉主面板（工具 + 命令），还是保留一个**只做回收站**的窄面板？

## 9. 未验证 / 待补

- **learn.chatgpt.com 无法访问**：本次调研期间该域名的 DNS 被污染（解析到 X/Facebook 段 IP 且连接超时），因此官方新版「ChatGPT Learn」文档（Bing 显示 1 天前更新）**未被读取**；本报告全部事实来自 help.openai.com 与 release notes。
- **未实机验证**：无 ChatGPT 账号，未运行 macOS/Windows 桌面 app（本机 Linux；Linux 版仍是 public preview），所有 UI 细节来自官方文档描述。
- ⚠️ 桌面端全量搜索（chats/projects/files + filters）与 Web 的一致性未逐项验证；桌面 branch 是否已全量可用未验证。
- ⚠️ 部分动作的**精确 UI 位置**（如新版桌面端 Rename 的确切菜单项、Recents 排序/过滤的具体选项）来自 release notes 概括，未截图确认。
- 缺少：真实 UI 截图/录屏、快捷键全表、Enterprise 管理策略对会话管理的限制细节。

## 10. 来源

| ID | 标题 | URL | 原文更新时间 |
|---|---|---|---|
| S1 | Deleting and archiving chats in ChatGPT | https://help.openai.com/en/articles/8809935-deleting-and-archiving-chats-in-chatgpt | 更新于 2026-10-28（抓取时约 20 分钟前） |
| S2 | Finding your chats, projects, and files in ChatGPT | https://help.openai.com/en/articles/10056348-finding-your-chats-projects-and-files-in-chatgpt | 5 天前 |
| S3 | Projects in ChatGPT | https://help.openai.com/en/articles/10169521-projects-in-chatgpt | 约 2 小时前 |
| S4 | Moving to the new ChatGPT desktop app | https://help.openai.com/en/articles/20001276-moving-to-the-new-chatgpt-desktop-app | 约 23 分钟前 |
| S5 | Using the ChatGPT Windows app | https://help.openai.com/en/articles/9982051-using-the-chatgpt-windows-app | 9 天前 |
| S6 | Temporary Chats on the ChatGPT macOS app | https://help.openai.com/en/articles/9295248-temporary-chats-on-the-chatgpt-macos-app | 9 天前 |
| S7 | Temporary chat in ChatGPT | https://help.openai.com/en/articles/8914046-temporary-chat-in-chatgpt | 未标注 |
| S8 | Archiving and deleting Codex chats in the ChatGPT app | https://help.openai.com/en/articles/20001333-archiving-and-deleting-codex-chats-in-the-chatgpt-app | 约 3 小时前 |
| S9 | Using locked chats in ChatGPT | https://help.openai.com/en/articles/20001411-using-locked-chats-in-chatgpt | 未标注 |
| S10 | Sharing conversations and scheduled tasks in ChatGPT | https://help.openai.com/en/articles/7925741-sharing-conversations-and-scheduled-tasks-in-chatgpt | 未标注 |
| S11 | How to launch the Chat Bar | https://help.openai.com/en/articles/9295241-how-to-launch-the-chat-bar | 9 天前 |
| S12 | ChatGPT macOS app release notes | https://help.openai.com/en/articles/9703738-chatgpt-macos-app-release-notes | 未标注 |
| S13 | Windows App - Release Notes | https://help.openai.com/en/articles/10003026-windows-app-release-notes | 未标注 |
| S14 | ChatGPT release notes | https://help.openai.com/en/articles/6825453-chatgpt-release-notes | 更新于约 15 小时前；内文按日期引用（2022-12-15 → 2026-10-27） |
| S15 | Getting started with Space in ChatGPT | https://help.openai.com/en/articles/20001549-getting-started-with-space-in-chatgpt | 约 14 小时前 |
| S16 | Chat and file retention in ChatGPT | https://help.openai.com/en/articles/8983778-chat-and-file-retention-in-chatgpt | 未标注 |
| S17 | Exporting your ChatGPT history and data / Transfer exported conversations | https://help.openai.com/en/articles/7260999-exporting-your-chatgpt-history-and-data ； https://help.openai.com/en/articles/9106926-transfer-exported-conversations-between-chatgpt-accounts | 未标注 |

> 注：Help Center 的「Updated」是抓取页面时的相对时间（2026-10-28 当天）。
