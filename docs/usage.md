# Threadloom 使用说明

> 本文件是 DSH 插件详情页的长文（`locale/*.json` 的 `meta.detail` 指向它），也会随 npm 包发布。

## 这是什么

**Threadloom（`dsh-session-butler`）** 是 DeepSeek Harness 的会话管理插件。它把散落在各个 workspace 里的会话收拢成一个可检索、可整理、可恢复的统一管理面：

- **总览（Web 管理页）**：跨 workspace 平铺列出会话，按标题/路径/id 过滤，按 workspace / 已归档 / 子代理筛选；
- **详情**：行内展示 cwd、更新时间、归属 workspace、运行/空白/归档/迁移状态；删除前可看到级联子代理数量（轮数/token/血缘树在 M3）；
- **整理**：改名、置顶、归档（复用 DSH 已有能力，管理面集中操作）；
- **删除**：回收站优先——先移入回收站，可恢复；确认后才永久删除，并可选级联删除子代理会话。

> **版本状态（0.1.0）**：M1 + M2 已完成——Host 删除核心、`/session-butler` 命令、Web 管理页（列表/筛选/回收站/删除确认）均可用；agent 工具与批量操作（M3）、发布验收（M4）尚未完成，因此暂不发布。

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

## Web 管理页（M2）

装好插件并启动 Web profile 后，侧栏会出现「会话管理」入口；页面分两个标签页：

- **会话**：列表 + 过滤（标题/路径/id、workspace、显示已归档/子代理）；行内「打开」跳转会话，「移入回收站」先弹出确认（运行中会提示先停止，迁移中的会话会被拒绝，可勾选级联子代理）。
- **回收站**：列出已删除会话（删除时间、原路径、是否过保留期、级联关系）；「恢复」直接移回原目录；「永久删除」需要配置 `permanentDelete: confirm` 并再次输入完整 session id。
- 顶部「刷新」会同时刷新会话列表与回收站；所有失败都以稳定错误码显示（如 `session-locked`、`permanent-delete-disabled`）。

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
    trashRetentionDays: 30     # 回收站保留天数；0 = 不自动清理
    cascadeSubagents: true     # 删除时级联子代理会话（fork 永不级联）
    permanentDelete: disabled  # disabled | confirm（confirm 需输入完整 session id）
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
