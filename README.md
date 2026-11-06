# Threadloom · dsh-session-butler

[![npm](https://img.shields.io/npm/v/dsh-session-butler.svg)](https://www.npmjs.com/package/dsh-session-butler)
[![CI](https://github.com/leoriczhao/dsh-session-butler/actions/workflows/ci.yml/badge.svg)](https://github.com/leoriczhao/dsh-session-butler/actions/workflows/ci.yml)

> DeepSeek Harness 的会话管理插件 —— 按 Codex 桌面端的形态管理会话：归档在设置里，删除一步完成。

**npm 包名**：`dsh-session-butler`（产品显示名 **Threadloom**）
**状态**：**0.2.2 已发布到 npm（latest）**（0.1.1 修复 native function calling 的 `parameters` 根 schema，0.1.2 补齐 `session_butler_new` / `session_butler_fork` 工具并修复新会话的 Workspace 归属；0.2.0 把会话管理入口收进设置页并移除会话库面板；0.2.1/D-030 移除回收站页面，删除改为一步永久删除；0.2.2 修复删除入口的图标/文案，并在拒绝删除仍被加载的会话时给出可执行提示）
**兼容**：DSH `>=0.2.1-rc.2 <0.3.0-0`（顶层 `engines.dsh`；下限经 M1–M3 用到的 API 在 rc.2 上逐项审计，见 `research/dsh-session-management-v2.md` §5.4）

---

## 这是什么

DSH 0.2.1-rc.3 已经内置了改名、置顶、归档、fork、导出；**真正缺的是归档/删除管理面，以及 agent tool 面的「会话 → 新会话」**。Threadloom 按 Codex 桌面端（合并后的 ChatGPT/Codex）的形态补齐：

| 能力 | 状态 |
|---|---|
| 已归档的聊天（设置页） | ✅ 0.2.1（设置 → 已归档的聊天：搜索、按项目分组、取消归档、永久删除、全部删除） |
| **删除（一步永久删除）** | ✅ 0.2.1（已归档页「永久删除」/「全部删除」+ 会话行「删除会话」；确认后直接删除，无回收站第二步；Host 底层仍走安全移动管线） |
| 子代理级联删除（fork 永不级联） | ✅ M1 |
| `/session-butler` 命令 | ✅ M1（list / trash / restore / purge） |
| Agent 工具：读取 | ✅ M3（`session_butler_list` / `session_butler_detail`） |
| **Agent 工具：会话 → 新会话** | ✅ 0.1.2（`session_butler_new` 继承调用方 cwd/Workspace/preset 新建空会话，自动归属调用方 workspace；`session_butler_fork` 从调用方会话按已完成轮分叉；只操作调用方会话，不暴露任意 session id；删除等破坏性写操作不进工具面） |
| 批量操作 | ✅ 已归档页「全部删除」批量永久删除（同源桥 `delete-many`，每批 ≤50，逐项结果） |
| 插件页集成 | ✅ 健康徽标 `plugins.detail.badge` + 诊断区块 `plugins.detail.section`（配置已迁至设置页） |
| Codex 式入口 | ✅ 0.2.1/D-030（无侧栏按钮、无会话库面板；设置页两个分区：「已归档的聊天」「Threadloom」；会话行 "..." 菜单仅保留「删除会话」；`inlineMenuEnabled` 可关） |
| i18n / 主题 | ✅ 中英文完整；跟随宿主主题 token |
| 发布包（构建 / 打包 / 校验 / 发布 runbook） | ✅ 构建与校验完成；`0.1.0` 已上 npm，`0.2.2` 已通过 GitHub Actions 的 trusted publishing 发布（带 provenance） |

> **发布**：npm 上最新为 `dsh-session-butler@0.1.0`；`0.1.1`（schema 修复）、`0.1.2`（工具面补齐）、`0.2.0`–`0.2.2`（设置页入口、一步删除、拒绝删除已加载会话）均已构建、验证并提交；`0.2.2` 已发布。源码托管在 [`leoriczhao/dsh-session-butler`](https://github.com/leoriczhao/dsh-session-butler)，npm 页面在 [`dsh-session-butler`](https://www.npmjs.com/package/dsh-session-butler)。验证：`pnpm run verify`（typecheck + build + 71 tests + npm pack 契约）与 `pnpm run test:e2e`（真实 dsh web 组合 + Playwright）；发布门禁与实测记录见 [`docs/decisions.md`](https://github.com/leoriczhao/dsh-session-butler/blob/main/docs/decisions.md) 和 [`docs/publishing.md`](https://github.com/leoriczhao/dsh-session-butler/blob/main/docs/publishing.md)。

## 还差什么（D3 路线图）

D3 方向在 2026-10-29 被用户二次纠正：**不做 Library/管理台，管理入口全部收进设置页**（D-029）；2026-10-30 三次纠正后删除改为一步完成、取消回收站页面（D-030）。当前完成 0.2.1 的设置页两入口；以下是剩余工作：

| 阶段 | 缺口 |
|---|---|
| 发布 | 后续版本走 `v*` tag + trusted publishing 自动发布（见 `docs/publishing.md` 阶段 D2） |
| D3.1 设置页完善 | 已归档列表分页/workspace 筛选、临时删除的 undo toast（替代原生 confirm）、设置分区图标（DSH 只对内置 id 映射图标）、live 会话/句柄删除的兼容性 |
| D3.2 组织与生命周期 | CLI 回收站保留期审计与过期提示、行菜单删除的 toast/撤销体验（当前原生 confirm） |
| D3.3 增强 | 设置页内的搜索/筛选状态记忆、CLI 恢复入口文档化、i18n 补全（设置页两分区已中英） |
| 明确非目标 | 跨 workspace 移动（D-012）、自动永久删除、运行中会话强删（D-013）、会话库/独立管理面板（D-029） |

## 快速开始（开发）

```bash
pnpm install
pnpm run verify        # typecheck + build + tests + npm pack 契约校验
pnpm run test:e2e      # 真实 dsh web 组合（L1）+ Playwright 浏览器（L2）
```

产物：

- `lib/index.js` + `lib/types/**`：Host 半（ESM，`apply(ctx, config)`）
- `lib/client.js`：Web Client 半（`window.__ModuleLoader__.load({id, factory})` 经典脚本）

本地安装到临时 profile 验证（不要装进日常 profile；管理页需要 Web 模板）：

```bash
dsh --profile tl-web --from-default-profile web --dump-config   # 先建临时 web profile
dsh plugin --profile tl-web add /home/leoric/code/dsh-session-butler
dsh --profile tl-web --port 3099 --no-open                      # 打开打印的 token URL；设置 → 已归档的聊天 / Threadloom
```

使用入口（与 Codex 桌面端一致）：

- **设置 → 已归档的聊天**：搜索、按项目分组、取消归档、永久删除、全部删除；
- **设置 → Threadloom**：插件配置（4 个 volatile 字段，保存即生效）；
- **会话行 "..." 菜单 → 删除会话**：侧栏会话的快捷永久删除（`inlineMenuEnabled` 可关）。

> 删除确认后立即执行，没有第二步回收站页面。仍被 DSH 加载的会话**不会被删除**：插件无法释放宿主持有的写句柄，会提示先停止工作或安全重启后再试；未加载的会话即时删除。详见 `docs/usage.md` 的安全边界。

## 目录

```
├── package.json                 # npm 契约：dsh.bundle.patch / dsh.client / engines.dsh / exports / files
├── cordis.patch.yml             # 安装时插入的 loader 行（id=session-butler）
├── icon.svg · locale/{en,zh}.json
├── src/
│   ├── index.ts                 # Host 入口（name/inject/Config/apply）
│   ├── config.ts                # Schemastery 配置
│   ├── shared/                  # 稳定标识 + 稳定错误码
│   ├── host/                    # Host 半：ports/locate/lineage/trash-store/read-model/service/tools/bridge/command
│   └── client/                  # Client 半：index/settings/menu/plugin-page/bridge/locale/contract
├── scripts/                     # build-client / validate-package / clean
├── e2e/                         # L1 真实组合 + L2 Playwright（临时 DSH_HOME）
├── tests/                       # node:test 产物与 manifest 冒烟
├── docs/                        # 见下
└── research/                    # 产品调研（Codex 会话管理）
```

## 文档

| 文档 | 内容 |
|---|---|
| [`docs/architecture.md`](https://github.com/leoriczhao/dsh-session-butler/blob/main/docs/architecture.md) | **目标架构**：能力边界、模块划分、删除管线、HTTP 桥、UI 挂载、里程碑、风险 |
| [`docs/decisions.md`](https://github.com/leoriczhao/dsh-session-butler/blob/main/docs/decisions.md) | 决策记录（D-001…D-033）+ 已收敛问题 + 发布门禁 |
| [`docs/publishing.md`](https://github.com/leoriczhao/dsh-session-butler/blob/main/docs/publishing.md) | 发布 runbook（build → pack → link 验证 → publish → registry 复验） |
| [`docs/testing.md`](https://github.com/leoriczhao/dsh-session-butler/blob/main/docs/testing.md) | **验证分层**：71 个单元/契约测试、L1 真实 `dsh web` 组合、L2 Playwright 浏览器、CI e2e job、临时 DSH_HOME 隔离 |
| [`docs/usage.md`](https://github.com/leoriczhao/dsh-session-butler/blob/main/docs/usage.md) | 用户文档（同时是插件详情页 `meta.detail`） |
| [`research/dsh-session-management-v2.md`](https://github.com/leoriczhao/dsh-session-butler/blob/main/research/dsh-session-management-v2.md) | **调研 v2（以此为准）**：7 个表面 × 15 个能力的矩阵、已发布 rc 通道 vs HEAD 版本差异、第三方插件可用性、修正记录 |
| [`research/v2-verification.md`](https://github.com/leoriczhao/dsh-session-butler/blob/main/research/v2-verification.md) | v2 的**独立对抗式复核**：15 条 claim（13 CONFIRMED / 1 WRONG / 1 NEEDS-NUANCE）+ 逐条证据 + 复核限制 |
| [`docs/dsh-host-apis.md`](https://github.com/leoriczhao/dsh-session-butler/blob/main/docs/dsh-host-apis.md) | ⛔ 第一版调研（已被 v2 取代，仅存档源码索引） |
| [`docs/dsh-web-ui.md`](https://github.com/leoriczhao/dsh-session-butler/blob/main/docs/dsh-web-ui.md) | ⛔ 第一版调研（已被 v2 取代，仅存档 slot/源码索引） |
| [`docs/dsh-packaging-contract.md`](https://github.com/leoriczhao/dsh-session-butler/blob/main/docs/dsh-packaging-contract.md) | 调研：npm 打包/安装/校验契约与 25 条坑位 |
| [`research/codex-session-management.md`](https://github.com/leoriczhao/dsh-session-butler/blob/main/research/codex-session-management.md) | 产品对标：Codex CLI/TUI/app-server 的 thread 管理 |
| [`research/2026-10-28-codex-desktop-ui-audit.md`](https://github.com/leoriczhao/dsh-session-butler/blob/main/research/2026-10-28-codex-desktop-ui-audit.md) | **实机审计**：ChatGPT 桌面端 Codex 部分的侧栏、行内动作、右键菜单、命令面板、快捷键；补遗指出漏看的 Settings → 已归档的聊天 |
| [`research/tool-face-parity.md`](https://github.com/leoriczhao/dsh-session-butler/blob/main/research/tool-face-parity.md) | **Codex 模型工具面补遗**：`codex_app` 线程工具（create_thread/fork_thread/…）证据与 Threadloom 4 工具对标 |
| [`research/2026-10-29-research-corrections.md`](https://github.com/leoriczhao/dsh-session-butler/blob/main/research/2026-10-29-research-corrections.md) | **调研修正记录**：三次被用户纠正的结论、根因、修正与后续调研协议 |
| [`research/2026-10-chatgpt-desktop-conversation-management.md`](https://github.com/leoriczhao/dsh-session-butler/blob/main/research/2026-10-chatgpt-desktop-conversation-management.md) | 产品对标：ChatGPT 桌面端 Chat/Work 的会话管理用例（Recents/Projects/Temporary/Archive/Delete） |
| [`docs/d3-console-design.md`](https://github.com/leoriczhao/dsh-session-butler/blob/main/docs/d3-console-design.md) | **D3 设计草案**：完整管理台的 IA、双用户能力矩阵、删除/回收站定位、与 DSH 插件管理 feature 的集成 |
| [`research/2026-10-28-dsh-plugin-management-survey.md`](https://github.com/leoriczhao/dsh-session-butler/blob/main/research/2026-10-28-dsh-plugin-management-survey.md) | DSH 插件管理能力调研（Plugins 页/内置插件/CLI）+ Threadloom 接入建议（`plugins.*` 扩展点、volatile 表单、健康快照） |

## 决策状态

已定：包名/发布渠道/MIT（D-002）、删除底层采用回收站安全管线（D-003；D-030 后仅内部/CLI，GUI 一步删除）、级联只沿 subagent（D-004）、已加载会话等待宿主释放（D-005，后续由 D-032 修正）、归档不搬文件（D-006）、Web 桥用 webServer 前缀路由（D-008）、UI 入口内联会话行 "..." 菜单、不设侧栏按钮（D-023，取代 D-009 的 sidebar 部分）、tsc+esbuild 构建（D-010）、engines.dsh 独占兼容（D-011）、跨 workspace 移动不做（D-012）、删除前等待释放（D-013，后续由 D-032 修正）、fork 不重做（D-014）、tool 面缺口（D-015）、桥同源 POST 信封（D-016）、可选注入 + 延迟绑定（D-017）、结构化注册只读工具（D-018）、详情以 stat + 事件折叠为准（D-019）、批量操作逐项独立（D-020）。

已定（D3）：**D-029（2026-10-29 二次纠正，取代 D-021/D-022/D-023/D-024 的入口与 Library 部分）** 无会话库、无侧栏按钮；管理入口全部收进 DSH 设置页。**D-030（2026-10-30 三次纠正，取代 D-029 的回收站页与行菜单动作）** 设置页只剩「已归档的聊天 / Threadloom」两项；删除一步完成（Delete permanently / Delete all / 行菜单 Delete session），不再有用户可见回收站；底层仍走安全移动管线，CLI 保留 trash/restore/purge。插件页只保留健康/诊断。工具面不变（D-015）。

Q1–Q7 已全部收敛（底层回收站保留期 30 天不自动清理；CLI purge 默认 disabled；归档不级联；首版无内容检索；不做 CLI 子命令；迁移中会话拒绝删除；`engines.dsh` 下限 rc.2）。D-030 后 GUI 删除不再受 `permanentDelete` 门禁。D-031 接受用户批准的测试分层：L1 真实 `dsh web` 组合 + 一条 L2 Playwright 浏览器主路径，CI 独立 `e2e` job。

## 命名

- 包名 `dsh-session-butler`（用户选定，避免与 npm 上已被占用的 `threadloom` 冲突）
- 产品/展示名 **Threadloom**（thread + loom：会话是线，管理器是织机）

## 许可证

MIT
