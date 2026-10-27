# Threadloom · dsh-session-butler

> DeepSeek Harness 的会话管理插件 —— 把散落在各个 workspace 里的会话，织成一张可检索、可整理、可恢复的网。

**npm 包名**：`dsh-session-butler`（产品显示名 **Threadloom**）
**状态**：**foundation（基础包已就绪；能力调研 v2 已完成并经独立复核；MVP 功能开发中）**
**兼容**：DSH `>=0.2.1-rc.2 <0.3.0-0`（顶层 `engines.dsh`；下限经 M1–M3 用到的 API 在 rc.2 上逐项审计，见 `research/dsh-session-management-v2.md` §5.4）

---

## 这是什么

DSH 0.2.1-rc.3 已经内置了改名、置顶、归档、fork、导出；**真正缺的是统一管理面和删除**。Threadloom 补齐这一层：

| 能力 | 状态 |
|---|---|
| 跨 workspace 统一列表 / 筛选 / 检索 | 🔜 M2（复用 `remote.session.list` + 宿主 standard hooks） |
| 会话详情（cwd / 轮数 / token / 大小 / preset / 模型 / 血缘） | 🔜 M2 |
| 改名 / 置顶 / 归档 / 取消归档 | ✅ 复用 DSH 官方 Remote（管理面集中操作） |
| **删除（回收站优先 + 恢复 + 永久删除）** | 🔜 M1（DSH 无官方 API，插件自建，见决策 D-003） |
| 子代理级联删除（fork 永不级联） | 🔜 M1 |
| `/session-butler` 命令、只读 agent 工具、批量操作 | 🔜 M3 |
| 发布包（构建 / 打包 / 校验 / 发布 runbook） | ✅ M0 已完成 |

> 当前 `0.1.0` 是可安装、可构建、可发布的基础包：Host/Client 双半管线、配置、展示资源、打包校验全部就绪，但**还没有用户功能**。发布门禁见 [`docs/decisions.md`](docs/decisions.md)。

## 快速开始（开发）

```bash
pnpm install
pnpm run verify        # typecheck + build + tests + npm pack 契约校验
```

产物：

- `lib/index.js` + `lib/types/**`：Host 半（ESM，`apply(ctx, config)`）
- `lib/client.js`：Web Client 半（`window.__ModuleLoader__.load({id, factory})` 经典脚本）

本地安装到临时 profile 验证（不要装进日常 profile）：

```bash
dsh plugin --profile tl-dev add /home/leoric/code/dsh-session-butler
dsh --profile tl-dev --dump-config   # 确认出现 session-butler 行
```

## 目录

```
├── package.json                 # npm 契约：dsh.bundle.patch / dsh.client / engines.dsh / exports / files
├── cordis.patch.yml             # 安装时插入的 loader 行（id=session-butler）
├── icon.svg · locale/{en,zh}.json
├── src/
│   ├── index.ts                 # Host 入口（name/inject/Config/apply）
│   ├── config.ts                # Schemastery 配置（已实现）
│   ├── shared/identity.ts       # 稳定标识（包名/行 id/panel id/API 前缀）
│   └── client/index.ts          # Client 入口
├── scripts/                     # build-client / validate-package / clean
├── tests/                       # node:test 产物与 manifest 冒烟
├── docs/                        # 见下
└── research/                    # 产品调研（Codex 会话管理）
```

## 文档

| 文档 | 内容 |
|---|---|
| [`docs/architecture.md`](docs/architecture.md) | **目标架构**：能力边界、模块划分、删除管线、HTTP 桥、UI 挂载、里程碑、风险 |
| [`docs/decisions.md`](docs/decisions.md) | 决策记录（D-001…D-013）+ 待确认问题 + 发布门禁 |
| [`docs/publishing.md`](docs/publishing.md) | 发布 runbook（build → pack → link 验证 → publish → registry 复验） |
| [`docs/usage.md`](docs/usage.md) | 用户文档（同时是插件详情页 `meta.detail`） |
| [`research/dsh-session-management-v2.md`](research/dsh-session-management-v2.md) | **调研 v2（以此为准）**：7 个表面 × 15 个能力的矩阵、已发布 rc 通道 vs HEAD 版本差异、第三方插件可用性、修正记录 |
| [`research/v2-verification.md`](research/v2-verification.md) | v2 的**独立对抗式复核**：15 条 claim（13 CONFIRMED / 1 WRONG / 1 NEEDS-NUANCE）+ 逐条证据 + 复核限制 |
| [`docs/dsh-host-apis.md`](docs/dsh-host-apis.md) | ⛔ 第一版调研（已被 v2 取代，仅存档源码索引） |
| [`docs/dsh-web-ui.md`](docs/dsh-web-ui.md) | ⛔ 第一版调研（已被 v2 取代，仅存档 slot/源码索引） |
| [`docs/dsh-packaging-contract.md`](docs/dsh-packaging-contract.md) | 调研：npm 打包/安装/校验契约与 25 条坑位 |
| [`research/codex-session-management.md`](research/codex-session-management.md) | 产品对标：Codex thread 管理 |

## 决策状态

已定：包名/发布渠道/MIT（D-002）、删除采用回收站优先（D-003）、级联只沿 subagent（D-004）、运行中先归档（D-005）、归档不搬文件（D-006）、Web 桥用 webServer 前缀路由（D-008）、UI 用 main panel + sidebar（D-009）、tsc+esbuild 构建（D-010）、engines.dsh 独占兼容（D-011）、跨 workspace 移动不做（D-012）。

待确认（见 [`docs/decisions.md`](docs/decisions.md) 的 Q1–Q6）：回收站保留期、永久删除是否默认可见、内容检索是否进首版、CLI 子命令排期、迁移中会话删除策略。

## 命名

- 包名 `dsh-session-butler`（用户选定，避免与 npm 上已被占用的 `threadloom` 冲突）
- 产品/展示名 **Threadloom**（thread + loom：会话是线，管理器是织机）

## 许可证

MIT
