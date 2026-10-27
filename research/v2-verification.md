# v2 报告独立复核（adversarial verification）

- 复核对象：`research/dsh-session-management-v2.md`，本次以 **md5 `09d52eeefc7defae3aa0ca1bae46c181`（mtime 2026-10-27 17:37）** 为准。该文件在复核期间被 Lead 改过（此前 md5 `d3125d56…`、mtime 17:27），下述判定已对齐最新文本。
- 复核人：research-verifier（task-4）。未修改 v2 报告、DSH checkout、profile；只写本文件，临时产物仅在 `/tmp`。
- 基线：
  - **H** = `/home/leoric/code/deepseek-harness` HEAD `22ddee3792`，`git describe = dsh-v0.2.1-rc.3-1533-g22ddee3792`，root `package.json version = 0.2.1-rc.3`；运行进程 PID 17358 `node --import tsx/esm apps/cli/src/bin.ts web --no-open`，`/proc/17358/cwd -> /home/leoric/code/deepseek-harness`（均实测）。
  - **R** = npm `@deepseek-ai/*@0.2.1-rc.3` tarball（`/tmp/rc3/` 既有解压 + 本次 `npm pack` 到 `/tmp/verify/`）。
  - live：`cordis_inspect_query`(host `Tool.listTools` / `Service.listService`) 成功；**client `Slots.listSubTree` 连续 2 次 10s 超时**，client 槽位改用 H 源码 + `lib/` 构建产物复核（与 v1 同样的环境问题）。

## 0. 结论总表（15 条）

| # | 声明（对照最新报告） | 判定 | 一句证据 |
|---|---|---|---|
| 1 | 无「会话→新会话」agent tool（无 session_create/fork/delete/archive） | **CONFIRMED** | live Tool 清单（spill `/tmp/dsh-spill-…/08c2ed…txt`）无任何 DSH `session_*` 生命周期工具；`docs/tool-catalog.md:41` 只有 5 个只读会话工具；R `/tmp/rc3/dsh-tool-session-query/package/lib/index.js:946-999` 亦只有 5 个只读工具 |
| 2 | `subagent_fork`=带父已完成轮 seed 的子代理委派，非平级会话 | **CONFIRMED** | R `/tmp/verify/subagent-fork/package/README.md:2,12,36,143` 与 H `packages/subagent/subagent-fork-in-process/README.md:2,12,36`：seed=最后完成 turn 前缀、结果回父会话；tool-catalog 记其别名为 `subagent_fork` |
| 3 | R 有 session/{fork,create,rename,list,search} Remote，无 session/delete；workspace/* 有 archive/unarchive/pin/unpin 无 session delete | **CONFIRMED** | R `/tmp/rc3/dsh-api-session-controller/package/lib/typert.remote-client.d.ts`（session 19 个方法，无 delete）；`/tmp/rc3/dsh-api-workspace-controller/package/lib/typert.remote-client.d.ts`（11 个方法）；`workspace/delete` 只接 `workspaceId`（types.d.ts:88-94） |
| 4 | R `SessionPersistence` 无 delete，方法仅 create/open/flush/stat/list | **CONFIRMED** | R `/tmp/rc3/dsh-session-persistence/package/lib/types/index.d.ts` abstract 方法清单；H `packages/session/session-persistence/src/index.ts` grep delete 无命中 |
| 5 | `session/list` 请求有 cursor 字段但实现忽略；SessionSummary 无 title | **CONFIRMED** | R `types.d.ts:267-274`（`cursor?` + 仅 `items`）、`lib/index.js:3061-3076` `async list(_request, signal)`；H `src/index.ts:266` 同；`SessionSummary` R types.d.ts:160-172 / H types.ts:149 无 title；title 走投影（R session-title `lib/index.js:235` 注册 title projection） |
| 6 | R `session/fork` 写 `parentSession=source.header.id`；H 不写（b096659） | **CONFIRMED** | R `lib/index.js:889`、`lib/types/commands.js:264`，且 R 核心 `Sessions.fork`（`/tmp/verify/session/package/lib/index.js:2006-2020`）也写；H `git show b096659` 删除该行、`git grep "parentSession: source.header.id" -- packages` 为空；H `packages/core/session/src/index.ts:1403-1417` meta 无 parentSession |
| 7 | `/api/session.markdown` 仅 H；R 只有 `/api/session.export` | **CONFIRMED** | H `packages/session-query/session-log-export/src/routes.ts:14` + `src/index.ts:90,105`；R `/tmp/rc3/dsh-session-log-export/package/lib/index.js:488` 仅 export 常量，全 rc.3 包 grep `session.markdown` 0 命中 |
| 8 | Host 命令注册点含 `/plan`、`/permission`（最新报告已修正为 6 个 + client `file`） | **CONFIRMED（最新报告）／旧清单措辞已过时** | R `plan-mode/package/lib/index.js:182`、`permission-presets/package/lib/index.js:209`；R base patch:265/332 顶层挂载二者；H `packages/plan/plan-mode/src/index.ts:233`、`packages/interaction/permission-presets/src/index.ts:255`；live dump `/tmp/dumpcfg.txt:172-173,239-240` 已挂载 → 任务清单旧措辞「只有 compact/feedback/goal/export」不成立，但 v2 最新 §4.2 已改对 |
| 9 | 内容检索默认关闭：R base/web-app `openAt: never`；opt-in bundle `first-search` + 挂 tool-session-query | **CONFIRMED** | R `dsh-base/cordis.patch.yml:149-161`、`dsh-web-app/cordis.patch.yml:22-30`、`session-search/cordis.patch.yml`（openAt first-search + optional-tool-session-query）；H 同文件同值；R sqlite `lib/types/index.d.ts:26-43` |
| 10 | 当前 profile：sqlite openAt never；log-export/workspace/workspace-controller 挂载；tool-session-query/session-search 未挂；工具含 subagent/subagent_fork 无 session_* | **CONFIRMED** | `/tmp/dumpcfg.txt:103-107`（openAt never）、`:456-458`（session-log-download=dsh-session-log-export）、`:467,487,497`（workspace/workspace-files/workspace-controller）；1404 行 dump 中无 tool-session-query/session-search；live Tool 清单有 subagent/subagent_fork/subagent_codex、无 session_* |
| 11 | live Client slot 树含 main(keyed, 被 conversation 占)、sidebar.panellist、session.menu.item、session.row.action、settings.section、shell.overlay | **CONFIRMED（证据级别降级）** | live client inspect 本次 2 次超时无法复现；改用 H 源码+build：`ui-layout/src/client/index.ts:73`（main keyed）、`:105`（shell.overlay list）、`ui-conversation/src/client/apply.ts:573-576`（key 'conversation'）、`ui-sidebar/src/client/contract/slots.ts:36`、`ui-settings/src/client/contract/slots.ts:57`、`ui-workspace/src/client/contract/slots.ts:186-205`；构建产物 `lib/types/…d.ts` 同（如 `ui-layout/lib/…/index.d.ts:53-55,95-97`） |
| 12 | 第三方 npm 插件不能新增 `ctx.remote.*` 命名空间（构建期 codegen + 静态 api-remotes 装配） | **NEEDS-NUANCE** | 主链成立：`docs/api-gateway.md:80,82`、`packages/api/remotes/src/client/index.ts` 静态 import+固定 `$mount` 列表、`scripts/generate-typert.ts`；但存在运行时旁路缝：`ctx.remote.$mount()`（`packages/api/gateway/src/client/index.ts:214-221`）与 Host `ctx.typert.register`（live Service 目录），且 `@deepseek-ai/dsh-typert-generator@0.2.1-rc.3` 已发布 npm → 「绝对不可能」过强，应写成「标准装配链不可扩展，旁路不承诺稳定」 |
| 13 | rc.3 GUI 行菜单含 pin/rename/fork/archive/session-id；fork 中文「分叉会话」；快捷键存在；**对话页内无 fork 入口** | **WRONG（后半句）** | 前半句 CONFIRMED：R `client-ui-workspace/lib/client.js:143,155,176,4382,4739,4803`（KeyF：desktop primary+alt / web primary+shift），H 同（`locales.ts:61`、`shortcuts.ts:96`）。后半句错：**R 与 H 的对话页每条已完成轮末都有 branch/fork 按钮**，R `client-ui-chat/lib/client.js:6963-6998,13266-13280,5223-5237,5869-5870`（`message.branch`=在新对话中分支），H `packages/client/ui-chat/src/client/chat/TurnTailNodeView.tsx:32,70`、`MessageIconActions.tsx:66-78`、`apply.ts:299-305`；且按钮传 `atSeq=data.seq`，**可选定分叉点**（按完成轮） |
| 14 | `session/rename` Remote 冷会话自动 resume（resolveAgent→resolve→resume） | **CONFIRMED** | R `lib/types/commands.js:192-207` rename→resolveAgent；`lib/index.js:210-213` resolveAgent→`:224-229` resolve→`:370` resume；jsDoc「Rename one Session after explicitly resuming it」 |
| 15 | CLI 无会话管理子命令；`--resume` 只是 app 参数 | **CONFIRMED（有措辞小瑕）** | H `apps/cli/src/args.ts:20-70` 仅 profile/dump-config/dump-config-schema/plugin 四种；`pnpm dsh --help`、`pnpm dsh web --help` 实测无会话子命令；`:97` 正是 `dsh tui --resume <session>` 注释示例 |

**计数：CONFIRMED 13、WRONG 1（claim 13）、NEEDS-NUANCE 1（claim 12）。** claim 8 的「旧清单措辞」是唯一的清单/报告漂移：按旧措辞判 WRONG，按最新 v2 文本判 CONFIRMED。

## 1. 需要修正的关键点（含证据）

### 1.1 claim 13：对话页内确实有 fork（branch）入口，且可选分叉点
- rc.3 发布包 `@deepseek-ai/dsh-client-ui-chat@0.2.1-rc.3`（`/tmp/verify/client-ui-chat/package/lib/client.js`）：
  - `:6963-6998` `TurnTailNodeView`：`const forkAllowed = useAccess("session/fork")`，`onBranch: forkAllowed ? () => { forkAt(data.seq) } : undefined`；
  - `:13266-13280` `forkAt(seq)`：`ctx.sessions.fork({ sessionId, atSeq: seq, increaseTitle: true, onCreated → ctx.uiWorkspace.openSession(childId) })`；
  - `:5223-5237` `MessageIconActions` 在 `onBranch !== undefined` 时渲染分支图标按钮；
  - `:5869-5870` locale：`message.branch: 在新对话中分支`、`message.branchUnavailable: 仅可从已完成轮次的最后一条消息分支`。
- H 同功能：`packages/client/ui-chat/src/client/chat/TurnTailNodeView.tsx:32,70`、`MessageIconActions.tsx:66-78`、`apply.ts:299-305`、`src/client/locale.ts:162-163`。
- 结论：侧栏「…」菜单固定最近完成轮；**对话页每轮尾部图标可对该完成轮 atSeq 分叉**。所以报告 §5.1「对话页内没有可见按钮/菜单入口；不能选分叉点」与 §3 行 10、§0 #2 都需改；这是本次复核最重要的能力面遗漏。

### 1.2 claim 12：Remote 命名空间「不可新增」应加旁路说明
- 标准链确实固定：`docs/api-gateway.md:80`（Client 只装配 `api-remotes`，静态 import 后 `ctx.remote.$mount`）、`:82`（方法表限于生成期选择）；`packages/api/remotes/src/client/index.ts` 顶部静态 import 名单 + `apply()` 固定 contribution 列表。
- 但 `ctx.remote.$mount(contribution)` 是公开方法（`packages/api/gateway/src/client/index.ts:214-221`），Host 侧 `ctx.typert.register(contribution)` 也在 live Service 目录中，`@deepseek-ai/dsh-typert-generator` 已发布到 npm（`npm view …@0.2.1-rc.3` 成功）。因此建议措辞：「标准 api-remotes 装配链无法加入；绕过链（自产 typert 产物 + $mount/typert.register）存在但未文档化、不承诺稳定」。对 Threadloom 的工程结论（不要依赖 `ctx.remote.sessionButler.*`）不变。

## 2. 版本口径：报告仍有重要歧义（建议优先修）

实测（2026-10-27）`npm view @deepseek-ai/dsh dist-tags`：**latest = 0.2.1-rc.2，next = 0.2.1-rc.4**；rc.3 不是任何 dist-tag 所指版本。发布时间：rc.2 10-17、rc.3 10-23、**rc.4 10-26**。
- 本次另 pack rc.2/rc.4 验证：**rc.2、rc.4 的 session-controller 同样写 `parentSession: source.header.id`**（`/tmp/verify/rc2-session-controller/package/lib/index.js:889`、`/tmp/verify/rc4-session-controller/package/lib/index.js:889`）；**rc.4 也没有 `/api/session.markdown`**（`/tmp/verify/rc4-log-export/package/lib/index.js:488` 仅 export 常量）。
- 即：截至今日，**所有已发布版本（latest rc.2 / rc.3 / next rc.4）都是 R 行为，H 行为只存在于开发 checkout**。因此：
  - §1.1「R=rc.3 = 插件用户实际安装的 DSH」不成立（用户装 latest 得 rc.2）；
  - §0 #5 / §5.3「兼容范围 `>=0.2.1-rc.3 <0.3.0` 内两种行为都会遇到」缺乏证据支持，实际是「已发布版 vs 开发 HEAD」；且若兼容下限写 rc.3，会排除 latest 用户（rc.2）。
  - 建议把版本故事改为：「已发布 rc 通道（rc.2/rc.3/rc.4）fork 带 parentSession、无 markdown 路由；HEAD 已改为不带血缘并新增 markdown，未来稳定版可能随之改变，插件仍应运行时探测」。

## 3. 其余误导 / 版本歧义 / 表面混淆清单

1. **矩阵 R/H 字母双关**：§1.1 用 R=发布版、H=HEAD；§1.3/§3 又用 R=Web Remote、H=Host Service。同一符号两义，正是 v2 要防的混淆，建议改表面代号（如 RM/HS）。
2. §2.1 表格行 `session-query` 不存在：composed config 只有 `session-query-sqlite`（dump:103-104；base/web-app patch 亦只有该行），`ctx.sessionQuery` 由 sqlite 后端提供；应写「session-query-sqlite 提供 ctx.sessionQuery」。
3. §2.1 `session-log-export` 行 id 实际为 `session-log-download`（dump:456-458），包名才是 dsh-session-log-export。
4. §2.2 仍把 `list_agents / send_message / interrupt_agent` 标成「子代理控制」。live 描述显示本 profile 里它们是 **Agent Teams** 工具（list_agents=列 Lead/teammates；send_message=发给 Team member；interrupt_agent=Team Lead only），同名 subagent-control 变体被 `packages/experimental/agent-team-profile/cordis.patch.yml` 顶层禁用；同名冲突见 `docs/tool-catalog.md:44` vs `:46`。§3 行 14「list_agents（仅本父会话的委派子代理）」对当前 profile 不成立。
5. §3 行 11 C 列「`/export`（…写入/复制 Markdown）」混淆：`/export` 是 ZIP 下载（H `src/index.ts:81` 描述、R lib/index.js:507）；Markdown 复制是 **H 独有的 Header 动作**（`/api/session.markdown` + browser copy controller），不是命令；U 列又把 `/export` 列为 UI 入口，C/U 重复。
6. §3 行 11 H 列「官方 `formatSessionMarkdown` 可复用」仅 H：rc.3 全部 tarball grep `formatSessionMarkdown` 0 命中，R 只有 ZIP archive；§6「导出 官方格式化可复用」未标版本。
7. §4.6「`dsh` 只有两类入口」不完整：launcher 还有 `--dump-config`/`--dump-config-schema`/`--dump-default-config`/`--from-default-profile`（args.ts:20-70、--help 输出）；虽非会话管理，但「只有两类」表述不准。
8. §4.7 目录名「`session-<uuid>`」不普遍：本机 `~/.dsh/sessions/**` 下 66 个 `session-<uuid>`、42 个裸 `<uuid>` 目录。
9. §5.1 Host 行类型名 `SessionForkResult` 不存在于 R/H；`ctx.sessions.fork` 返回 `Session`（R `/tmp/verify/session/package/lib/types/index.d.ts:513`；H `packages/core/session/src/index.ts:1403`）。
10. §4.1 defineTool 示例不符契约：`parameters` 是 `ParameterSchemaSpec`（JSON-Schema 风格，不是 schemastery `z.object`），`output: {schema, render}` 为必填（H `packages/core/tools/src/schema.ts:484-516`；真实用法 `packages/experimental/tool-session-query/src/index.ts:65-105`）。
11. §4.4「React 等 11 个 platform seed 必须 external」数字对（H `packages/client/web/src/platform.ts` 恰 11 项），但机制不准：动态 bundle 对基线模块**隐式 external**；`dsh.client.external` 只允许精确的非基线请求（`packages/client/modules/README.md` "Sharing modules"）。
12. §10 证据路径 `packages/client/ui-workspace/locales.ts` 不存在，实际 `packages/client/ui-workspace/src/client/locales.ts`。
13. §7.3「存储层有 proposed 重构」未找到证据（`docs/subsystems/persistence*.md` 无 proposed/refactor 相关），应标 U 或删除。
14. 矩阵行 2 把「标题/workspace 名搜索」与内容检索混一行：Remote 列写 `session/search`（内容检索，属行 3）；按能力本身，标题/workspace 搜索在 Remote 面应为 ❌（仅 Client 本地过滤 `toLowerCase().includes`，R `client-ui-workspace/lib/client.js:1186` 已核实）。
15. 矩阵行 10 Host 列把 `ctx.sessions.fork`（仅 live、与 Remote fork 不同实现）与 `session/fork`（冷路径：observeSession→buildForkSeed→agents.create）并列；易误导插件用 Host fork 处理冷会话。
16. §2.3/§8 #6 声称「live slot 树已获取」：本次复核 client `Slots.listSubTree` 2 次 10s 超时，无法复现（与 v1 环境问题相同）；槽位事实本身经源码+构建产物确认，建议把证据等级从「live」降为「源码+构建产物」。

## 4. 报告遗漏的重要事实

1. **对话页每轮 branch/fork 入口**（见 §1.1）：这是「从会话新建会话」在 GUI 的第二条入口，且支持按完成轮选 atSeq；报告明确否认其存在。
2. **发布通道矩阵**（见 §2）：latest=rc.2、next=rc.4，二者均 R 行为；rc.3 非当前发布指针。插件兼容声明若以 rc.3 为下限会漏掉/挡掉 latest 用户。
3. **Agent Teams 与 subagent-control 的同名工具冲突**：本 profile 中 `list_agents/send_message/interrupt_agent` 已被 Agent Teams 版本占用，subagent-control 的同名工具被禁用；「子代理浏览」在 T 面当前 profile 实际不可用（不是 list_agents）。报告对此未区分。
4. **live 人类命令面含 `/plan`、`/permission`**（报告最新版已补，列此备查）。
5. 新增的 `workspaceRegistry` 层级差异（报告 17:37 版新增，H sdk-app patch 含 workspace 已由我实测确认 1 行；rc.3 是否发布过 sdk-app 包无法从现有 /tmp/rc3 验证，标「未完全验证」）。
6. 本机会话目录命名混用（见 §3.8），影响「按目录删除/回收站」实现的路径发现逻辑。

## 5. 复现/证据路径（本次实际执行）

- 基线：`git describe --tags --always`；`ps -ef | grep apps/cli/src/bin.ts`；`/proc/17358/{cwd,cmdline}`；`node -p "require('./package.json').version"`。
- live：`cordis_inspect_query(host Tool.listTools)`（结果 spill `/tmp/dsh-spill-sVtGHI/session-fe6c5528ad81/08c2ed2cd91f-cordis_inspect_query.txt`）、`host Service.listService`（spill `…/021a2c34980c-…txt`）；client Slots 两次超时。
- 配置：`pnpm dsh --profile web --dump-config > /tmp/dumpcfg.txt`（1404 行）；`pnpm dsh --help`；`pnpm dsh web --help`。
- npm 产物：`/tmp/rc3/*`（既有）+ 本次 pack 到 `/tmp/verify/`：client-ui-workspace、client-ui-chat、subagent-fork-in-process、session、session-query-sqlite、plan-mode、permission-presets、command-compact/feedback/goal、rc2-session-controller、rc4-session-controller、rc4-log-export（均为 `0.2.1-rc.*`）。
- 版本：`npm view @deepseek-ai/dsh dist-tags --json`、`npm view @deepseek-ai/dsh time --json`、`npm view @deepseek-ai/dsh@latest|@next version`。

## 6. 复核限制

- client `Slots.listSubTree` 在本会话环境持续 10s 超时（2 次），claim 11 与 §2.3 的 live 证据无法复现，只能用 H 源码+`lib/` 构建产物交叉验证（结论一致）。
- R 侧只抽查了与 15 条声明相关的 tarball；未做全量 rc.3 工具包/命令包枚举（claim 1/8 的 R 侧完整性依赖 H 的生成物 `docs/tool-catalog.md` 及其完整性守卫，以及 rc.3 相关包实测）。
- 报告在复核期间被并发修改（md5 已从 `d3125d56…` 变为 `09d52eee…`）；本文件以 09d52eee 为准。若报告继续修改，claim 8/§2.2/新增 workspaceRegistry 行需重新对表。
