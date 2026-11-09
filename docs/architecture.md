# 会话管家架构

插件是单个 npm 包，两半代码：

| 半 | 位置 | 运行环境 | 入口 |
|---|---|---|---|
| Host | `src/host`、`src/index.ts` | `dsh` 进程（Node ESM） | `apply(ctx, config)` |
| Client | `src/client` | Web 前端 | `window.__ModuleLoader__.load({ id, factory })` |

## Host 半

`apply` 先构造 `SessionButlerService` 并 `provide('sessionButler')`，再按宿主实际存在的服务挂载各表面：`webServer` + `connection` 在才挂 HTTP bridge；`tools` 在才注册工具。可选服务一律用 `ctx.get` 探测，缺了就降级，不阻塞插件加载。

| 模块 | 职责 |
|---|---|
| `service.ts` | 用例：list / detail / trash / restore / purge / delete / deleteMany / health |
| `ports.ts` | 只声明用到的 DSH 接口子集（sessionQuery、sessionPersistence、workspaceRegistry、agents、sessions、webServer…），测试用假对象实现同一契约 |
| `locate.ts` | 按 session id 在 sessions root 下定位目录；先精确匹配，再试历史 `session-` 前缀变体，并用日志头校验 |
| `lineage.ts` | 从 `traceSession` 里挑出 `origin === 'subagent'` 的后代，供级联删除 |
| `trash-store.ts` | 回收站：元数据 + payload 目录、同盘移动、冲突检查、恢复、清除 |
| `read-model.ts` | 把 header、live 状态、归档/置顶、标题、事件统计拼成 list/detail 投影 |
| `bridge.ts` | `/session-butler/api/*` 前缀路由，同源 POST 信封 |
| `tools.ts` | 四个 agent 工具：list / detail / new / fork |
| `schema.ts` | 配置与请求体校验 |
| `fs.ts` | 存在性检查、目录移动、原子写 JSON、受控删除 |

### 读取

`list` 合并三个来源：持久化快照、live Session/Agent、Workspace 的归档与置顶集合，再批量读标题。`detail` 以 `stat` 的 header 为骨架，追加 `traceSession` 的血缘和事件折叠出的 token/体积；日志读不到时返回 `enrichment: partial` 而不是失败。

### 删除

1. 预检：拒绝删除当前会话；拒绝 `migration-required` 的会话；按配置展开 subagent 级联集合（fork 永不在集合里）。
2. 加载检查：本进程仍持有 Session/Agent 时直接拒绝——运行中给 `session-running`，仅加载给 `session-in-use`。插件拿不到释放句柄的能力，不会为了删除去停任务或改状态。
3. 移动：写租约探测发现其他进程持锁则拒绝；通过后把目录同盘移入回收站并写元数据，任一步失败回滚已移动的部分。
4. 清除：GUI 删除在移动成功后立即 purge 回收站条目，因此用户看到的是"一步删除"，回收站只作为失败时的安全网。

## Client 半

`index.tsx` 是注册入口：设置分区（「已归档的聊天」「会话管家」）、会话行 `...` 菜单的删除项、插件页健康区块。`settings.tsx` 负责已归档列表（搜索、按项目分组、取消归档、永久删除、全部删除）和四个配置字段；`menu.tsx` 只做确认 + 调用；`bridge.ts` 用同源相对路径发 POST，失败按稳定错误码映射成中英文提示；`locale.ts` 是唯一文案来源。

## HTTP bridge

- 路径固定前缀 `/session-butler/api/<method>`，同源 POST，JSON 信封 `{ ok: true, value }` / `{ ok: false, error: { code, message } }`。
- 只接受同源请求；没有 `webServer` 的 headless/ACP 组合不挂路由。
- `trash`/`restore`/`purge`/`list-trash` 等服务与桥方法仍保留为内部能力；0.3.0 没有对应的 GUI/CLI 回收站入口，也不把它们注册为模型工具。GUI 删除走 `delete`/`delete-many`。
- 错误码是稳定标识（`session-in-use`、`session-locked`、`trash-conflict`…），客户端按码选文案，不解析 message。

## 磁盘布局

```
~/.dsh/sessions/<project>/<session>/session.v4.jsonl.zstd   # 只读定位，不解析
~/.dsh/session-butler/trash/<project>/<dir>/                # payload
~/.dsh/session-butler/trash/<project>/<dir>.json            # 元数据
```

会话目录只会被整体移动，不会被逐文件改写；跨盘移动直接拒绝，避免出现两份真源。

## 打包

`dsh.bundle.patch` 让 `dsh plugin add` 往 profile 的 loader 层插一行；`dsh.client` 声明浏览器半；`engines.dsh` 是唯一兼容判定。浏览器半是经典脚本，React 等 platform seed 必须 external，由宿主提供。

## 测试

单元/契约测试直接跑构建产物，L1 用真实 `dsh web` + 临时 `DSH_HOME` 验证组合与路由，L2 用 Playwright 跑真实设置页与行菜单。细节见 [testing.md](./testing.md)。
