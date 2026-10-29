# Threadloom · dsh-session-butler

[![npm](https://img.shields.io/npm/v/dsh-session-butler.svg)](https://www.npmjs.com/package/dsh-session-butler)
[![CI](https://github.com/leoriczhao/dsh-session-butler/actions/workflows/ci.yml/badge.svg)](https://github.com/leoriczhao/dsh-session-butler/actions/workflows/ci.yml)

> DeepSeek Harness 的会话管理插件 —— 把散落在各个 workspace 里的会话，织成一张可检索、可整理、可恢复的网。

**npm 包名**：`dsh-session-butler`（产品显示名 **Threadloom**）
**状态**：**0.1.2 已构建并验证，待发布**（npm 上最新为 0.1.0；0.1.1 修复 native function calling 的 `parameters` 根 schema，0.1.2 补齐 `session_butler_new` / `session_butler_fork` 工具）
**兼容**：DSH `>=0.2.1-rc.2 <0.3.0-0`（顶层 `engines.dsh`；下限经 M1–M3 用到的 API 在 rc.2 上逐项审计，见 `research/dsh-session-management-v2.md` §5.4）

---

## 这是什么

DSH 0.2.1-rc.3 已经内置了改名、置顶、归档、fork、导出；**真正缺的是统一管理面、删除，以及 agent tool 面的「会话 → 新会话」**。Threadloom 补齐这两层：

| 能力 | 状态 |
|---|---|
| 跨 workspace 统一列表 / 筛选 | ✅ M2（会话行 "..." 菜单 → 会话库；标题/路径/id 过滤 + workspace/归档/子代理筛选） |
| 会话详情（cwd / 状态 / 时间 / 归属 workspace） | ✅ M3（行内信息 + 详情弹窗：轮数/步骤/消息数/工具调用/token/日志字节/血缘树/preset/enrichment） |
| 改名 / 置顶 / 归档 / 取消归档 | ✅ 复用 DSH 官方 UI（本插件页面不重复提供；M3 批量范围仅删除/恢复） |
| **删除（回收站优先 + 恢复 + 永久删除）** | ✅ M1 Host 核心 + ✅ M2 管理页/同源桥（`/session-butler` 命令同样可用） |
| 子代理级联删除（fork 永不级联） | ✅ M1 |
| `/session-butler` 命令 | ✅ M1（list / trash / restore / purge） |
| 回收站管理页 | ✅ M2（列表、恢复、二次确认后永久删除） |
| Agent 工具：读取 | ✅ M3（`session_butler_list` / `session_butler_detail`） |
| **Agent 工具：会话 → 新会话** | ✅ 0.1.2（`session_butler_new` 继承调用方 cwd/preset 新建空会话；`session_butler_fork` 从调用方会话按已完成轮分叉；只操作调用方会话，不暴露任意 session id；删除等破坏性写操作不进工具面） |
| 批量操作 | ✅ M3（管理页多选 + 同源桥 `trash-many` / `restore-many`，逐项结果） |
| DSH 插件页集成 | ✅ D3.0/D-024（bundle 页标题旁「配置」按钮 + 设置对话框；健康徽标、诊断区块；5 个 volatile 配置热生效） |
| Codex 式入口 | ✅ D3.0b/D-023（无侧栏按钮；会话行 "..." 菜单内联「会话详情…」「会话库…」；`inlineMenuEnabled` 可关） |
| i18n / 主题 | ✅ 中英文完整；跟随宿主主题 token |
| 发布包（构建 / 打包 / 校验 / 发布 runbook） | ✅ 构建与校验完成；`0.1.0` 已上 npm，`0.1.1`/`0.1.2` + D3 改动待 `npm publish`（需 2FA） |

> **发布**：npm 上最新为 `dsh-session-butler@0.1.0`；`0.1.1`（schema 修复）、`0.1.2`（工具面补齐）以及 D3.0/3.0b 改动已构建、验证并提交，**待 `npm publish`（需要账号 2FA）**；GitHub 有 10 个提交待 push。源码托管在 [`leoriczhao/dsh-session-butler`](https://github.com/leoriczhao/dsh-session-butler)，npm 页面在 [`dsh-session-butler`](https://www.npmjs.com/package/dsh-session-butler)。验证：`pnpm run verify`（typecheck + build + 59 tests + npm pack 契约）；发布门禁与实测记录见 [`docs/decisions.md`](https://github.com/leoriczhao/dsh-session-butler/blob/main/docs/decisions.md) 和 [`docs/publishing.md`](https://github.com/leoriczhao/dsh-session-butler/blob/main/docs/publishing.md)。

## 还差什么（D3 路线图）

D3 目标是「完整管理台」，当前完成 D3.0 + D3.0b；以下是已设计、未实现的部分（详见 [`docs/d3-console-design.md`](./docs/d3-console-design.md) §10）：

| 阶段 | 缺口 |
|---|---|
| 发布 | `0.1.1`/`0.1.2` + D3 改动尚未 `npm publish`（2FA）；10 个本地提交未 push |
| D3.1 Library | 排序控件（当前固定 pin + 最近活动）、分页（当前本地最多 300 行）、概览统计页、详情抽屉（当前是弹窗）、Library 内「新建会话」、批量置顶/归档（当前批量仅删除/恢复） |
| D3.2 组织与生命周期 | 面板内分叉入口（当前用官方 UI 或 agent tool）、分叉边界选择、Trash 保留期清理引导/审计、live 会话引导文案打磨 |
| D3.3 增强 | 标签/备注（P1）、内容级搜索（opt-in `session-query`）、导出 Markdown、Cleanup 清理页、独立诊断页、命令面板/快捷键、hover 预览、过滤保存 |
| 明确非目标 | 跨 workspace 移动（D-012）、自动永久删除、运行中会话强删（D-013） |

## 快速开始（开发）

```bash
pnpm install
pnpm run verify        # typecheck + build + tests + npm pack 契约校验
```

产物：

- `lib/index.js` + `lib/types/**`：Host 半（ESM，`apply(ctx, config)`）
- `lib/client.js`：Web Client 半（`window.__ModuleLoader__.load({id, factory})` 经典脚本）

本地安装到临时 profile 验证（不要装进日常 profile；管理页需要 Web 模板）：

```bash
dsh --profile tl-web --from-default-profile web --dump-config   # 先建临时 web profile
dsh plugin --profile tl-web add /home/leoric/code/dsh-session-butler
dsh --profile tl-web --port 3099 --no-open                      # 打开打印的 token URL；hover 会话行 → "..." → 「会话库…」
```

配置：侧栏 **插件** → **Threadloom 会话管理** → 标题右侧 **「配置」** 按钮（对话框）或底部行 `session-butler` 的原生配置页，两者共用同一份表单。

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
│   └── client/                  # Client 半：index/page/menu/navigation/bridge/locale/contract
├── scripts/                     # build-client / validate-package / clean
├── tests/                       # node:test 产物与 manifest 冒烟
├── docs/                        # 见下
└── research/                    # 产品调研（Codex 会话管理）
```

## 文档

| 文档 | 内容 |
|---|---|
| [`docs/architecture.md`](https://github.com/leoriczhao/dsh-session-butler/blob/main/docs/architecture.md) | **目标架构**：能力边界、模块划分、删除管线、HTTP 桥、UI 挂载、里程碑、风险 |
| [`docs/decisions.md`](https://github.com/leoriczhao/dsh-session-butler/blob/main/docs/decisions.md) | 决策记录（D-001…D-020）+ 已收敛问题 + 发布门禁 |
| [`docs/publishing.md`](https://github.com/leoriczhao/dsh-session-butler/blob/main/docs/publishing.md) | 发布 runbook（build → pack → link 验证 → publish → registry 复验） |
| [`docs/usage.md`](https://github.com/leoriczhao/dsh-session-butler/blob/main/docs/usage.md) | 用户文档（同时是插件详情页 `meta.detail`） |
| [`research/dsh-session-management-v2.md`](https://github.com/leoriczhao/dsh-session-butler/blob/main/research/dsh-session-management-v2.md) | **调研 v2（以此为准）**：7 个表面 × 15 个能力的矩阵、已发布 rc 通道 vs HEAD 版本差异、第三方插件可用性、修正记录 |
| [`research/v2-verification.md`](https://github.com/leoriczhao/dsh-session-butler/blob/main/research/v2-verification.md) | v2 的**独立对抗式复核**：15 条 claim（13 CONFIRMED / 1 WRONG / 1 NEEDS-NUANCE）+ 逐条证据 + 复核限制 |
| [`docs/dsh-host-apis.md`](https://github.com/leoriczhao/dsh-session-butler/blob/main/docs/dsh-host-apis.md) | ⛔ 第一版调研（已被 v2 取代，仅存档源码索引） |
| [`docs/dsh-web-ui.md`](https://github.com/leoriczhao/dsh-session-butler/blob/main/docs/dsh-web-ui.md) | ⛔ 第一版调研（已被 v2 取代，仅存档 slot/源码索引） |
| [`docs/dsh-packaging-contract.md`](https://github.com/leoriczhao/dsh-session-butler/blob/main/docs/dsh-packaging-contract.md) | 调研：npm 打包/安装/校验契约与 25 条坑位 |
| [`research/codex-session-management.md`](https://github.com/leoriczhao/dsh-session-butler/blob/main/research/codex-session-management.md) | 产品对标：Codex CLI/TUI/app-server 的 thread 管理 |
| [`research/2026-10-28-codex-desktop-ui-audit.md`](https://github.com/leoriczhao/dsh-session-butler/blob/main/research/2026-10-28-codex-desktop-ui-audit.md) | **实机审计**：ChatGPT 桌面端 Codex 部分的侧栏、行内动作、右键菜单、命令面板、快捷键与"删除为何不是核心"的证据 |
| [`research/2026-10-chatgpt-desktop-conversation-management.md`](https://github.com/leoriczhao/dsh-session-butler/blob/main/research/2026-10-chatgpt-desktop-conversation-management.md) | 产品对标：ChatGPT 桌面端 Chat/Work 的会话管理用例（Recents/Projects/Temporary/Archive/Delete） |
| [`docs/d3-console-design.md`](https://github.com/leoriczhao/dsh-session-butler/blob/main/docs/d3-console-design.md) | **D3 设计草案**：完整管理台的 IA、双用户能力矩阵、删除/回收站定位、与 DSH 插件管理 feature 的集成 |
| [`research/2026-10-28-dsh-plugin-management-survey.md`](https://github.com/leoriczhao/dsh-session-butler/blob/main/research/2026-10-28-dsh-plugin-management-survey.md) | DSH 插件管理能力调研（Plugins 页/内置插件/CLI）+ Threadloom 接入建议（`plugins.*` 扩展点、volatile 表单、健康快照） |

## 决策状态

已定：包名/发布渠道/MIT（D-002）、删除采用回收站优先（D-003）、级联只沿 subagent（D-004）、运行中先归档（D-005）、归档不搬文件（D-006）、Web 桥用 webServer 前缀路由（D-008）、UI 入口内联会话行 "..." 菜单、不设侧栏按钮（D-023，取代 D-009 的 sidebar 部分）、tsc+esbuild 构建（D-010）、engines.dsh 独占兼容（D-011）、跨 workspace 移动不做（D-012）、运行中先归档再删（D-013）、fork 不重做（D-014）、tool 面缺口（D-015）、桥同源 POST 信封（D-016）、可选注入 + 延迟绑定（D-017）、结构化注册只读工具（D-018）、详情以 stat + 事件折叠为准（D-019）、批量操作逐项独立（D-020）。

已定（D3）：**D-021** D3 以「库/详情/续聊/分叉/组织」为核心、删除/回收站降为清理模块；**D-022** 插件管理集成（复用 DSH Plugins 页/详情/启停 + `plugins.*` 扩展点 + 运行期健康，不重做插件管理）。D3.0 已落地。

Q1–Q7 已全部收敛（回收站保留期 30 天不自动清理；永久删除默认 disabled；归档不级联；首版无内容检索；不做 CLI 子命令；迁移中会话拒绝删除；`engines.dsh` 下限 rc.2）。

## 命名

- 包名 `dsh-session-butler`（用户选定，避免与 npm 上已被占用的 `threadloom` 冲突）
- 产品/展示名 **Threadloom**（thread + loom：会话是线，管理器是织机）

## 许可证

MIT
