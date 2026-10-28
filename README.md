# Threadloom · dsh-session-butler

> DeepSeek Harness 的会话管理插件 —— 把散落在各个 workspace 里的会话，织成一张可检索、可整理、可恢复的网。

**npm 包名**：`dsh-session-butler`（产品显示名 **Threadloom**）
**状态**：**foundation + M1 + M2 + M3（删除核心 + `/session-butler` 命令 + Web 管理页/同源桥 + 只读 agent 工具 + 批量操作 + 详情补全均已实现；M4 本地发布验收已通过，因 npm 凭据与仓库元数据未补齐而暂不发布）**
**兼容**：DSH `>=0.2.1-rc.2 <0.3.0-0`（顶层 `engines.dsh`；下限经 M1–M3 用到的 API 在 rc.2 上逐项审计，见 `research/dsh-session-management-v2.md` §5.4）

---

## 这是什么

DSH 0.2.1-rc.3 已经内置了改名、置顶、归档、fork、导出；**真正缺的是统一管理面和删除**。Threadloom 补齐这一层：

| 能力 | 状态 |
|---|---|
| 跨 workspace 统一列表 / 筛选 | ✅ M2（main panel + sidebar 入口；标题/路径/id 过滤 + workspace/归档/子代理筛选） |
| 会话详情（cwd / 状态 / 时间 / 归属 workspace） | ✅ M3（行内信息 + 详情弹窗：轮数/步骤/消息数/工具调用/token/日志字节/血缘树/preset/enrichment） |
| 改名 / 置顶 / 归档 / 取消归档 | ✅ 复用 DSH 官方 UI（本插件页面不重复提供；M3 批量范围仅删除/恢复） |
| **删除（回收站优先 + 恢复 + 永久删除）** | ✅ M1 Host 核心 + ✅ M2 管理页/同源桥（`/session-butler` 命令同样可用） |
| 子代理级联删除（fork 永不级联） | ✅ M1 |
| `/session-butler` 命令 | ✅ M1（list / trash / restore / purge） |
| 回收站管理页 | ✅ M2（列表、恢复、二次确认后永久删除） |
| 只读 agent 工具 | ✅ M3（`session_butler_list` / `session_butler_detail`；写操作不进模型面） |
| 批量操作 | ✅ M3（管理页多选 + 同源桥 `trash-many` / `restore-many`，逐项结果） |
| 发布包（构建 / 打包 / 校验 / 发布 runbook） | ✅ M0 已完成 |

> 当前 `0.1.0` 的工作区已包含可发布的包骨架、M1 删除核心、M2 Web 管理页与 M3 工具/批量/详情。M4 本地验收（真实浏览器、隔离 `DSH_HOME` 写入闭环、干净目录安装）已完成；剩余阻塞是 npm 登录与 `repository`/`homepage`/`bugs` 元数据，因此**暂不发布**。验证：`pnpm run verify`（typecheck + build + 52 tests + npm pack 契约）。发布门禁与证据见 [`docs/decisions.md`](docs/decisions.md) 和 [`docs/publishing.md`](docs/publishing.md)。

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
dsh --profile tl-web --port 3099 --no-open                      # 打开打印的 token URL，点侧栏「会话管理」
```

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
│   └── client/                  # Client 半：index/page/bridge/locale/contract
├── scripts/                     # build-client / validate-package / clean
├── tests/                       # node:test 产物与 manifest 冒烟
├── docs/                        # 见下
└── research/                    # 产品调研（Codex 会话管理）
```

## 文档

| 文档 | 内容 |
|---|---|
| [`docs/architecture.md`](docs/architecture.md) | **目标架构**：能力边界、模块划分、删除管线、HTTP 桥、UI 挂载、里程碑、风险 |
| [`docs/decisions.md`](docs/decisions.md) | 决策记录（D-001…D-020）+ 已收敛问题 + 发布门禁 |
| [`docs/publishing.md`](docs/publishing.md) | 发布 runbook（build → pack → link 验证 → publish → registry 复验） |
| [`docs/usage.md`](docs/usage.md) | 用户文档（同时是插件详情页 `meta.detail`） |
| [`research/dsh-session-management-v2.md`](research/dsh-session-management-v2.md) | **调研 v2（以此为准）**：7 个表面 × 15 个能力的矩阵、已发布 rc 通道 vs HEAD 版本差异、第三方插件可用性、修正记录 |
| [`research/v2-verification.md`](research/v2-verification.md) | v2 的**独立对抗式复核**：15 条 claim（13 CONFIRMED / 1 WRONG / 1 NEEDS-NUANCE）+ 逐条证据 + 复核限制 |
| [`docs/dsh-host-apis.md`](docs/dsh-host-apis.md) | ⛔ 第一版调研（已被 v2 取代，仅存档源码索引） |
| [`docs/dsh-web-ui.md`](docs/dsh-web-ui.md) | ⛔ 第一版调研（已被 v2 取代，仅存档 slot/源码索引） |
| [`docs/dsh-packaging-contract.md`](docs/dsh-packaging-contract.md) | 调研：npm 打包/安装/校验契约与 25 条坑位 |
| [`research/codex-session-management.md`](research/codex-session-management.md) | 产品对标：Codex thread 管理 |

## 决策状态

已定：包名/发布渠道/MIT（D-002）、删除采用回收站优先（D-003）、级联只沿 subagent（D-004）、运行中先归档（D-005）、归档不搬文件（D-006）、Web 桥用 webServer 前缀路由（D-008）、UI 用 main panel + sidebar（D-009）、tsc+esbuild 构建（D-010）、engines.dsh 独占兼容（D-011）、跨 workspace 移动不做（D-012）、运行中先归档再删（D-013）、fork 不重做（D-014）、tool 面缺口（D-015）、桥同源 POST 信封（D-016）、可选注入 + 延迟绑定（D-017）、结构化注册只读工具（D-018）、详情以 stat + 事件折叠为准（D-019）、批量操作逐项独立（D-020）。

Q1–Q7 已全部收敛（回收站保留期 30 天不自动清理；永久删除默认 disabled；归档不级联；首版无内容检索；不做 CLI 子命令；迁移中会话拒绝删除；`engines.dsh` 下限 rc.2）。

## 命名

- 包名 `dsh-session-butler`（用户选定，避免与 npm 上已被占用的 `threadloom` 冲突）
- 产品/展示名 **Threadloom**（thread + loom：会话是线，管理器是织机）

## 许可证

MIT
