# DSH Host 侧会话管理 API 调研（Threadloom 基础）

> 范围：DeepSeek Harness（DSH）Host 进程里所有与会话管理相关的服务、事件、磁盘格式与注册扩展点，回答「列表 / 详情 / 改名 / 置顶 / 归档 / 删除 / fork / 导出 / 级联 / 运行中会话」各自有没有官方 API、缺口在哪、插件该怎么补。
>
> 基准运行时：**DSH 0.2.1-rc.3**（`DSH/package.json:3`；本机实际安装 `~/.dsh/profiles/node_modules/@deepseek-ai/dsh/package.json` 也是 `0.2.1-rc.3`）。
> 源码 checkout：`/home/leoric/code/deepseek-harness`（下文简称 **`DSH/`**），HEAD `22ddee3792`（2026-10-23），调研时间 2026-10-27。
> 本机 Web profile：`~/.dsh/profiles/web`（正在提供 `http://127.0.0.1:3080` 的 GUI）。
>
> 核验方式（双重）：
> 1. `cordis_inspect_query`（platform=host, provider=Service）读取**运行中 Host** 的 Service 精确签名与类型声明（read-only）；
> 2. 逐条回到 `DSH/` 源码核对实现与语义。
>
> 引用格式：`DSH/路径:行号`（checkout 内相对路径）；本机文件用绝对路径或 `~`。
> 相关文档：Web UI 挂载面见 [`dsh-web-ui.md`](./dsh-web-ui.md)；打包/发布契约见 [`dsh-packaging-contract.md`](./dsh-packaging-contract.md)；产品调研见 [`../research/codex-session-management.md`](../research/codex-session-management.md)。

---

## 0. TL;DR（先读这段）

1. **README 与产品调研里的「DSH 不能改名/置顶/删除」已经部分过期。** 0.2.1-rc.3 里已经存在：
   - 改名：`ctx.sessionTitle.rename()`（要求 live 会话）+ Web Remote `session.rename`（会自动 resume 冷会话）；
   - 置顶/取消置顶：`ctx.workspaceRegistry.pinSession/unpinSession` + Web Remote `workspace.pinSession/unpinSession`；
   - 归档/取消归档：`ctx.workspaceRegistry.archiveSession/unarchiveSession`（支持 `stopActivity` 停运行中的 turn/subagent/job/schedule）+ Web Remote；
   - fork：Host 侧 `ctx.sessions.fork()`（仅 live）+ Web Remote `session.fork`（冷会话可用，`atSeq` 截断）；
   - 导出：官方 `session-log-export` 包提供 `/export` 命令、`/api/session.export`（ZIP，含附件与 subagent descendants）和 `/api/session.markdown`（Markdown）。
   **真正缺失的核心操作只有「删除」**（以及围绕删除的回收站/级联/统一管理面/CLI/agent tool）。
2. **DSH 的「归档」不是移文件。** 它只把 session id 写进 `~/.dsh/storages/workspace.json` 的 `global.archivedSessionIds`；session 目录原地不动。归档后该会话在 Web 侧不可打开，且其 subagent 血缘上的后代被 `agent/pre-step` 门禁挡住、不会再跑 turn（`DSH/packages/api/session-controller/src/archived-session-gate.ts:23-56`）。所以「归档 = 移动存储」的假设需要纠正。
3. **没有官方删除 API，而且是刻意设计成「有真实消费者时再加」的。** `SessionPersistence.delete()` 曾在 2026-06-20 被明确删除，设计 note 直接点名「a session-management UI that deletes old sessions will want it — add it then」（`DSH/.agents/notes/archived/simplification/2026-06-20-prune-dead-seam-methods.md:31,41`）。MVP 有两条路：
   - **插件侧实现**：`sessionQuery` 找目标 → `sessionPersistence.open(id, 'write')` 抢写租约证明无并发写者 → `node:fs/promises.rm(session 目录)` → 清理归档/置顶集合；
   - **上游补 API**（更长期、更干净）：给 `SessionPersistence` 加回 `delete()` + backend hook + 删除事件/客户端失效通知，Threadloom 作为 consumer 反过来 pin 住契约。
4. **内容全文搜索默认是关闭的。** base 组合把 `session-query-sqlite` 配成 `openAt: never`（`DSH/packages/bundle/base/cordis.patch.yml:149-161`），`listSessions/readTitle/traceSession` 等精确读仍可用，但 `searchSessions/searchEvents` 会抛 `SESSION_QUERY_SEARCH_DISABLED`。本机 Web profile 没有覆盖该配置，所以「按会话内容搜索」需要：改 profile 配置开启索引，或插件自建索引。
5. **`workspaceRegistry` 不在 base，只在 Web / SDK 组合里。** `dsh-base` 不含 workspace 行；`dsh-web-app`（`DSH/packages/bundle/web-app/cordis.patch.yml:83-84`）与 `dsh-sdk-app`（`DSH/packages/bundle/sdk-app/cordis.patch.yml:51-52`）各自挂载；**headless/acp profile 没有** `ctx.workspaceRegistry`。插件应把 workspace 当**可选**依赖（`ctx.get('workspaceRegistry')`），核心能力只依赖 `sessionQuery`/`sessionPersistence`/`sessionTitle`（这些在 base）。
6. **fork 子会话不写 `parentSession`**（`isSeeded: true` 的独立会话，`DSH/packages/api/session-controller/src/commands.ts:267-286`）。DSH 的「血缘」= `header.parentSession` + `header.origin === 'subagent'`；**级联删除/归档只能沿 `origin === 'subagent'` 走**，否则可能误伤历史 fork（header 注释明确「historical ordinary forks may retain their source id here」，`DSH/packages/core/session/src/types.ts:107-112`）。
7. **Session 存储层正在重构**（proposed `logical-session-storage-rebuild`：Stage 1–2 草案完成、Stage 3 实现但未定稿、Stage 4–5 未完成），`Session`/`SessionPersistence` 未来可能改名换面（`DSH/.agents/notes/proposed/architecture/2026-09-06-logical-session-storage-rebuild.md:1-40,71-79`）。因此插件必须：
   - 精确声明 `engines.dsh` / peer 范围（0.2.x 内）；
   - 所有 Host Service 用能力探测（`ctx.get(key)`）而不是 import 具体实现包；
   - 不直接解析 `session.v4.jsonl.zstd`，只走 `sessionPersistence`/`sessionQuery`。

---

## 1. 版本、运行时与依赖契约

| 事实 | 值 / 来源 |
|---|---|
| DSH 版本 | `0.2.1-rc.3`（`DSH/package.json:3`；本机安装同版本） |
| 包管理器 / 引擎 | pnpm 11.28.5；node >= 24.9.0（`DSH/package.json`） |
| Cordis | 4.0.5（本机 `~/.dsh/profiles/node_modules/@deepseek-ai/cordis/package.json`） |
| 会话格式 | `SESSION_FORMAT_VERSION = 4`（`DSH/packages/core/session/src/types.ts:90`） |
| plugin 兼容判定 | 顶层 `engines.dsh` 存在时单独决定；否则把每个 `@deepseek-ai/dsh` / `@deepseek-ai/dsh-*` **peerDependencies** 与运行中 DSH 版本比较，`includePrerelease: true`（`DSH/packages/boot/app-boot/src/plugin-compatibility.ts:55-74, 87-102`） |
| 安装形态 | 普通 npm 包 + `dsh.bundle.patch`；`dsh plugin add` / `plugin_manager install_bundle` 安装（`DSH/packages/boot/plugin-manager/src/index.ts:836`）；细节见打包文档 |

**Threadloom 建议依赖**（version 必须与运行中的 DSH 同代；全部 Service 来自 Host Context，不需要 import 实现包。peer 在运行时由 profile 上方 hoist 的 `~/.dsh/profiles/node_modules/@deepseek-ai/*` 解析，不要把它们打进 bundle）：

```jsonc
// peerDependencies（参与 DSH 兼容检查；运行时由宿主 profile 提供，不要打进 bundle）
"@deepseek-ai/cordis": "^4.0.5",
"@deepseek-ai/dsh-session": "^0.2.1-rc.3",            // SessionId/SessionEvent/SESSION_FORMAT_VERSION/header 类型
"@deepseek-ai/dsh-session-query": "^0.2.1-rc.3",      // sessionQuery 契约 + SessionRecord/Lineage 类型
"@deepseek-ai/dsh-session-persistence": "^0.2.1-rc.3",// 持久化契约 + 类型化错误
"@deepseek-ai/dsh-session-title": "^0.2.1-rc.3",      // 标题类型 + normalizeSessionTitle（冷改名兜底时用）
"@deepseek-ai/dsh-workspace": "^0.2.1-rc.3",          // WorkspaceRegistry 类型（可选运行时）
"@deepseek-ai/dsh-subagent": "^0.2.1-rc.3",           // 血缘枚举类型（可选运行时）
"@deepseek-ai/dsh-tools": "^0.2.1-rc.3",              // defineTool/ToolDefinition
"@deepseek-ai/dsh-commands": "^0.2.1-rc.3",           // CommandDefinition
"@deepseek-ai/dsh-agent": "^0.2.1-rc.3",              // Agent 类型（status/cancel）
"@deepseek-ai/dsh-storage-domain": "^0.2.1-rc.3",     // 插件自己的回收站索引 domain
"@deepseek-ai/dsh-storage": "^0.2.1-rc.3",
"@deepseek-ai/dsh-brand": "^0.2.1-rc.3",
"@deepseek-ai/schemastery": "^3.18.5"
// dependencies：只放真正需要随包带走的纯 JS 依赖
// engines: { "dsh": ">=0.2.1-rc.3 <0.3.0" }   ← 与打包文档 §12 对齐
```

> ⚠️ 上表的 `^0.2.1-rc.3` 在 semver 上会把 `0.2.1`（正式版）也算满足（prerelease 同一 `[0,2,1]` 元组允许更高版本），但不会跨到 `0.2.2`。DSH 仍处于 rc + 存储层重构期，**发现 API 变化时收紧而不是放宽**。

---

## 2. Host Service 地图

挂载层含义：**base** = `dsh-base` bundle（web/headless/sdk 都继承）；**web** = `dsh-web-app` bundle（仅 Web GUI/desktop）。

| ctx key | 提供包 | 挂载 | 与 Threadloom 的关系 |
|---|---|---|---|
| `sessionQuery` | `@deepseek-ai/dsh-session-query-sqlite`（契约在 `dsh-session-query`） | base | ★ 列表/搜索/详情/血缘的唯一官方读取面 |
| `sessionPersistence` | `@deepseek-ai/dsh-session-persistence-jsonl` | base | ★ 物理日志：stat/list/open/append/flush；删除必须经它定位与探测 |
| `sessions` | `@deepseek-ai/dsh-session` | base | 进程内 live 会话仓库（判断运行中、fork live 源） |
| `sessionTitle` | `@deepseek-ai/dsh-session-title` | base | 改名（live only）+ 标题投影单元 |
| `sessionProjections` | `@deepseek-ai/dsh-session-projection` | base | 投影注册表（插件可注册自己的派生列） |
| `sessionProjectionCache` | `@deepseek-ai/dsh-session-projection-cache` | base | 冷会话零 I/O 读 title/sessionStats/tokenUsage 等 |
| `workspaceRegistry` | `@deepseek-ai/dsh-workspace` | web/sdk | 归档/置顶集合 + workspace 分组（可选依赖） |
| `workspaceController` | `@deepseek-ai/dsh-api-workspace-controller` | web | 归档/置顶/分组的 Typert Remote 面（客户端用） |
| `sessionController` | `@deepseek-ai/dsh-api-session-controller` | web | `session.*` Remote：list/search/rename/fork/…（客户端用） |
| `subagents` | `@deepseek-ai/dsh-subagent` | base | `listChildren/listDescendants` 血缘枚举 + 停止/中断（base 行 `DSH/packages/bundle/base/cordis.patch.yml:359-360`） |
| `agents` | `@deepseek-ai/dsh-agent` | base | live Agent 注册表：`get/list/status`、`cancel` |
| `commands` | `@deepseek-ai/dsh-commands` | base | 人类 slash 命令注册 |
| `tools` | `@deepseek-ai/dsh-tools` | base | 模型工具注册 |
| `storageDomain` | `@deepseek-ai/dsh-storage-domain` | base | 插件自有持久数据（回收站索引等） |
| `fs` | `@deepseek-ai/dsh-fs-sandbox` | base | 抽象文件系统；**没有 delete/rm 原语** |
| `connection` | `@deepseek-ai/dsh-client-connection` | web/sdk | Host HTTP 路由注册（`/api/...`，前端可直接 fetch） |

\* `subagents` 与其 `spawn`/`fork` provider 都在 `dsh-base`（`DSH/packages/bundle/base/cordis.patch.yml:359-368`），所以 base 系 profile 都有；`listChildren/listDescendants` 还要求 `sessionQuery` 与 `subagentCatalog` 投影（base 也具备）。自建最小 profile 才需要 `ctx.get('subagents')` 探测。

---

## 3. 关键服务精确契约

以下签名同时经 `cordis_inspect_query` 与源码核对；只列 Threadloom 会用到的成员。

### 3.1 `ctx.sessionQuery`（`DSH/packages/session-query/session-query/src/index.ts:98`）

**定位**：live-preferred 逻辑语料（live 覆盖 persisted），所有读操作都不 resume Agent。

```ts
abstract class SessionQueryEngine extends Service {
  observeSession(sessionId, options?: SessionObservationOptions): Promise<SessionObservation> // :140
  abstract searchSessions(request: SessionSearchRequest, exec?: SessionSearchExecContext)
    : Promise<SessionSearchPage<SessionSearchHit>>                                            // :153
  abstract searchEvents(request: SessionEventSearchRequest, exec?: SessionSearchExecContext)
    : Promise<SessionEventSearchPage>                                                          // :164
  listSessions(signal?: AbortSignal): Promise<SessionRecord[]>                                 // :174
  readSession(sessionId): Promise<SessionLogSnapshot>                                          // :184
  filterSessions(filters: readonly SessionResultFilter[], signal?): Promise<SessionRecord[]>   // :206
  readTitle(sessionId, signal?): Promise<SessionTitleSnapshot | undefined>                     // :220
  readTitleSnapshot(sessionId, signal?): Promise<SessionTitleObservation>                      // :233
  readTitleSnapshots(sessionIds, signal?): Promise<SessionTitleObservationResult[]>            // :251
  listEvents(sessionId): Promise<SessionEventRecord[]>                                         // :269
  filterEvents(sessionId, filters): Promise<SessionEventSearchDocument[]>                      // :280
  readSurface(sessionId): Promise<SessionSurfaceSnapshot>                                      // :310
  traceSession(sessionId, signal?): Promise<SessionLineageTrace>                               // :327
  traceEvent(request, signal?): Promise<SessionEventTraceObservation>                          // :340
  readEvent(request, signal?): Promise<SessionEventWindow>                                     // :355
}
```

关键数据类型（`DSH/packages/session-query/session-query/src/types.ts`）：

```ts
interface SessionRecord { header: SessionHeader; live: boolean; persisted: boolean;
  formatStatus?: 'current' | 'migration-required' }                       // :27
type SessionResultFilter =
  | { kind: 'id'; values: readonly SessionId[] }
  | { kind: 'cwd'; values: readonly (string | null)[] }
  | { kind: 'created-at'; from?: number; to?: number }
  | { kind: 'parent'; values: readonly (SessionId | null)[] }
  | { kind: 'availability'; values: readonly ('live' | 'persisted')[] }    // :199,205
interface SessionSearchRequest { query: string;
  sessionFilters?: readonly SessionResultFilter[];
  eventFilters?: readonly SessionEventMetadataFilter[];
  limit?: number; cursor?: SessionSearchCursor }                           // :253
type SessionLineageTrace = { target: SessionRecord;
  ancestors: SessionRecord[]; descendants: SessionLineageNode[] }
  & ({ complete: true; root: SessionRecord }
    | { complete: false; unresolvedParentId: SessionId })                  // :83
```

语义要点：
- `listSessions` 按 `header.createdAt` **降序**（同时间按 id 排序，`DSH/packages/session-query/session-query/src/corpus.ts:313-315`），与「最近活动时间」不同；Web 列表的 `updatedAt` 取 `max(createdAt, lastPromptAt)`（`DSH/packages/api/session-controller/src/list.ts:360-362`）。
- `filterSessions` 支持按 cwd 过滤 —— 这是**workspace 过滤的官方替代**（即使没有 workspaceRegistry 也能按目录分组）。
- `readSession` 返回 detached header + 完整事件 + `inheritedEventCount`，并做 replay 校验；失败抛 `SessionQueryError`（`SESSION_QUERY_CORRUPT_SESSION` 等，`DSH/packages/session-query/session-query/src/config.ts:23-48`）。
- `traceSession` 只沿 `header.parentSession` 建树（`DSH/packages/session-query/session-query/src/tracing.ts:119-180`）；**fork（不带 parentSession）不会出现在 descendants 里**。
- 搜索错误码：`SESSION_QUERY_SEARCH_DISABLED`（`config.ts:43`）在 `openAt: never` 时由 sqlite 实现抛出（`DSH/packages/session-query/session-query-sqlite/src/index.ts:334-343`）。
- 所有 cursor 只对「完全相同的规范化请求」有效，stale 时抛 `SESSION_QUERY_STALE_CURSOR`。

### 3.2 `ctx.sessions`（`DSH/packages/core/session`）

```ts
registerMessageProjection(projection): () => Promise<void>
create(id?: SessionId, options?: CreateSessionOptions): Session
prepare(id?, options?): Session
enter(session): () => void
announce(session): void
flush(session): Promise<boolean>            // durability checkpoint
get(id): Session | undefined
list(): Session[]                            // live sessions, creation order
fork(source: Session | SessionId, boundary?: SessionSeq, childSessionId?: SessionId): Session
// 实现：DSH/packages/core/session/src/index.ts:1064（SessionStore）、:1403（fork）
```

- `fork` 只接受 **live** source；`boundary` 是**包含式** seq，省略 = 当前最后事件（`DSH/packages/core/session/src/index.ts:1064,1403` 服务契约，inspect 结果同）。
- Threadloom 用它判断「会话是否在本进程活着」：`ctx.sessions.get(id) !== undefined`；但**别的 dsh 进程**里的 live 会话看不到。

### 3.3 `ctx.sessionPersistence`（`DSH/packages/session/session-persistence/src/index.ts:125`）

```ts
interface SessionPersistence {
  readonly identity: symbol                                                     // :155
  create(header, options?): Promise<SessionHandle>                              // :159
  open(id, access: 'read'|'write', options?): Promise<SessionHandle>            // :174
  flush(): Promise<void>                                                        // :187
  stat(id, options?): Promise<SessionPersistenceSnapshot | undefined>           // :203
  list(options?): Promise<readonly SessionPersistenceSnapshot[]>                // :210
}
interface SessionHandle extends AsyncDisposable {                               // handle.ts:25
  id; header; inheritedEventCount; access
  read(offset?, length?, options?): Promise<{ eventState; events }>             // handle.ts:83
  append(events, options?): Promise<void>   // 首事件 seq 必须等于 next-seq；写句柄独占
  flush(options?): Promise<void>            // 唯一 durability barrier
  close(): Promise<void>                    // 幂等，释放写租约
}
interface SessionPersistenceSnapshot {
  header: SessionHeader
  formatStatus?: 'current' | 'migration-required'
  revision: SessionPersistenceRevision       // 不透明变更令牌，仅同实例同 session 可比
  eventCount?: number                        // JSONL 后端当前不填
  sizeBytes?: number                         // 物理文件大小（含压缩后）
  location?: { kind: string; path: string }  // JSONL: kind='jsonl'，path=日志文件绝对路径
}
```

要点：
- 打开 `write` 是**跨进程独占**的（POSIX `flock` on `session.lock`，`DSH/packages/session/session-persistence-jsonl/src/lease.ts:40`）；已有写者时抛 `SessionAlreadyOwnedError`（`DSH/packages/session/session-persistence/src/errors.ts`）。**这是删除前唯一的「是否有并发写者」探测手段**。
- `stat().location.path` 是公开的定位入口；不要自己拼 `~/.dsh/sessions/...`（root 可配置，`root` 是必填配置项，`DSH/packages/session/session-persistence-jsonl/src/index.ts:102`）。
- `append` 必须 seq 连续；`flush` 后才保证落盘；`close` 会 drain 并释放租约。

### 3.4 `ctx.sessionTitle`（`DSH/packages/session/session-title/src/index.ts:301`）

```ts
get(session: Session): SessionTitleSnapshot | undefined
rename(session: Session, title: string): SessionTitleSnapshot   // :411，要求 session 是本 store 的 live 会话
refresh(session, signal?): Promise<SessionTitleSnapshot | undefined>
register(provider: SessionTitleProvider): () => Promise<void>
```

- `rename` 会 normalized（去控制字符/空白折叠/UTF-8 截断），然后 `session.append('session/title', { title, messageSeqs: [], source: { kind: 'user' } })`（`index.ts:411-431`）。标题**允许同名、没有唯一约束**；base 配置 `maxTitleBytes: 80`（`DSH/packages/bundle/base/cordis.patch.yml:60-65`）。
- 规范化函数是公开导出的：`normalizeSessionTitle(input, maxBytes)`（`DSH/packages/session/session-title/src/normalize.ts:59`；入口 `index.ts:53`），冷改名兜底可复用。
- 非 live 会话调用会抛 `Error("session ... is not live in this store")`（`index.ts:413-415`）；空标题抛 `SessionTitleInvalidError`（`index.ts:87`）。
- 标题投影 `SessionProjectionMap.title: string | null`（`DSH/packages/session/session-title/src/types.ts:80-87`），**会出现在列表 summary 里**（unit 未标 `summary: false`）。

### 3.5 `ctx.sessionProjections` / `ctx.sessionProjectionCache`

`sessionProjections`（`DSH/packages/session/session-projection/src/index.ts:252`）：

```ts
register<K, S>(definition): Promise<ProjectionHandle<S>>     // :290/:302/:306，注册派生列（可 summary 或 host-only）
onChanged(listener): () => void                              // :440
snapshot(session: Session, keys?): ProjectionSnapshot        // :459 要求 live session
cachedSnapshot(session: Session, keys?): ProjectionSnapshot | undefined // :483
summaryKeys(): ReadonlySet<...>                              // :512
checkpoint(session): ProjectionCheckpoint                    // :541
restoreFloor(checkpoint): SessionLogOffset | undefined
viewCheckpoint(checkpoint, keys?): Partial<SessionProjectionMap>
restore(checkpoint, events, baseSeq, header, inheritedEventCount)
hydrate(session, checkpoint, events, baseSeq)
```

`sessionProjectionCache`（`DSH/packages/session/session-projection-cache/src/index.ts:105`）：

```ts
cachedSnapshot(meta: SessionHeader, keys?): ProjectionSnapshot | undefined   // :162 零 I/O，冷会话也可用
cachedPredecessorTitle(meta): ProjectionSnapshot | undefined                 // :187
hydratePrepared(session, events): ProjectionSnapshot
write(session): Promise<void>                                                // 强制 checkpoint
coldSnapshot(meta, inheritedEventCount, events): ProjectionSnapshot          // :288 给完整日志时的冷读
```

已注册的投影 key（对本插件有用的）：`title`、`sessionListMetadata`、`sessionStats`（turns/steps/token/耗时，`summary: false`，`DSH/packages/session/session-stats/src/projection.ts:108,205`）、`tokenUsage`、`contextPressure`、`agentPreset`、`modelSelection`、`subagentCatalog`、`subagentTiming`、`turnOutline`、`goal`、`plan`、`inbox`。**详情页（轮数/token/大小/preset/模型）几乎都能从投影拿到，不必解析事件。**

持久化位置：`~/.dsh/storages/session_projcache/sessions/<sessionId>.json`（per-record layout，`DSH/packages/session/session-projection-cache/src/spec.ts:100`）。

### 3.6 `ctx.workspaceRegistry`（`DSH/packages/workspace/workspace/src/index.ts:170`）

```ts
static inject = ['storageDomain', 'sessionPersistence']                       // :171

get archivedSessionIds(): readonly SessionId[]                                // :344 全局归档集合
get pinnedSessionIds(): readonly SessionId[]                                  // :417 全局置顶集合（最近置顶在前）

archiveSession(sessionId, options?: { stopActivity?: boolean }): Promise<void> // :365
unarchiveSession(sessionId): Promise<void>                                     // :399
pinSession(sessionId): Promise<void>                                           // :428
unpinSession(sessionId): Promise<void>                                         // :455

create(path, title?); initializeDefault(resolve); get(id); list(); delete(id);
insertBefore(id, beforeId?); resolveByPath(path)                               // :238-508
```

语义（必须按原样理解）：
- **全局集合，不是 per-workspace**；durable 写在 `~/.dsh/storages/workspace.json` 的 `global.archivedSessionIds` / `global.pinnedSessionIds`（本机实测）。
- `archiveSession`：
  - 会话必须 live 或存在于 persistence（`WorkspaceUnknownSessionError`，`:47`）；
  - 默认拒绝有活动的会话：瀑布事件 `workspace/session-activity` 返回 `turn`/`job`/`subagent`/`schedule` 任一项即抛 `WorkspaceActiveSessionError`（`:63`）；
  - `stopActivity: true` 时**先写归档、再并行请求停止**（`workspace/session-stop`）；停止失败只 log，不回滚归档（`:365-387`）；
  - 归档会**同时丢弃置顶**（`:380-384`）；已归档再归档是 no-op。
- `pinSession` 拒绝已归档会话（`WorkspaceArchivedSessionPinError`，`:74`）；重复 pin 是 no-op。
- 归档**不移动任何文件、不改 header、不写 session 日志**（源码只在 state 上写集合）。
- 归档门禁：`ArchivedSessionGate` 在 `agent/pre-step` 上拒绝「已归档会话或其 subagent 后代」跑模型步（`DSH/packages/api/session-controller/src/archived-session-gate.ts:23-56`），所以归档父会话会连带冻结仍活着的子代理（但**不会**把子会话逐个标记归档）。
- workspace 实体：`attachSession` 校验 header.cwd 的 realpath 必须等于 workspace path（`DSH/packages/workspace/workspace/src/entity.ts:110-150`）；`detachSession` 只解除分组不减日志（`:175-179`）。

Remote 面 `ctx.workspaceController`（web）：`@Remote` 方法 `archiveSession/unarchiveSession/pinSession/unpinSession/create/rename/delete/insertBefore/insertSessionBefore/follow`，请求类型见 `DSH/packages/api/workspace-controller/src/types.ts:114-143`；`archiveSession` 支持 `stopActivity`。客户端服务 `ctx.workspaces`（`DSH/packages/api/workspace-controller/src/client/service.ts`）已被 GUI 使用。

### 3.7 `ctx.subagents`（`DSH/packages/subagent/subagent/src/index.ts`）

```ts
listChildren(parentSessionId: SessionId, signal?): Promise<SubagentCatalogEntry[]>            // :407
listDescendants(rootSessionId: SessionId, signal?): Promise<SubagentDescendantListEntry[]>    // :427
drainDescendants(parents: readonly Agent[]): Promise<void>                                    // :375
interrupt(targetSessionId, authority): void                                                   // :361
sendMessage(...); prompt(...) @Remote; interruptByParent(...) @Remote
```

- `listChildren` 读的是父会话日志里的 `subagentCatalog` 投影（`DSH/packages/subagent/subagent/src/list-children.ts:31-52`），**不加载 Agent**；`listDescendants` 逐层读取、外部子代理是叶子，读不到的子树以 `diagnostic` 行返回（`list-children.ts:64-140`）。
- 与 `sessionQuery.traceSession` 的区别：前者是父目录「主动登记」（更加可靠的存在性），后者是 header lineage（历史 fork 可能残留 parentSession）。**级联删除建议两者交叉验证，且只取 `origin === 'subagent'`。**
- 血缘字段：`header.parentSession` + `header.origin === 'subagent'` + `delegationDepth`（`DSH/packages/core/session/src/types.ts:95-135`）。本机实测一个 Agent Teams 子会话 header：
  ```json
  {"type":"session","version":4,"id":"125ce157-…","createdAt":1793073264628,
   "cwd":"/home/leoric/code/dsh-session-butler","parentSession":"session-64bba441-…",
   "isSeeded":false,"origin":"subagent","delegationDepth":1,"agentPreset":"cordis"}
  ```
  注意 **子会话 id 不一定是 `session-` 前缀**（Agent Teams/子代理 mint 的是裸 UUID，`DSH/packages/subagent/subagent/src/manager.ts:385`、`DSH/packages/experimental/agent-team/src/roster.ts:242`）——所有删除目标必须以实际 id 为准，禁止靠前缀判断。

### 3.8 `ctx.agents`（`DSH/packages/core/agent`）

```ts
get(id): Agent | undefined
list(): Agent[]
listRoots / roots / isOwnedBy / turnBoundaryOf
create(options) / resume(options): Promise<AgentHandle>   // AgentHandle { agent; dispose(): Promise<void> }
```

`Agent` 运行时能力（`DSH/packages/core/agent/src/runtime-types.ts`）：

```ts
readonly status: 'idle' | 'running'                 // :136
cancel(cause: 'user'|'parent'|'hook'|'disposed', options?): void  // :212；keepInbox 可保留队列
whenIdle(): Promise<void>
```

- **没有公开的「dispose 别人的 Agent」API**：`AgentHandle.dispose()` 只属于 create/resume 的持有者。因此删除一个当前在本进程 live 的会话，插件不能安全强行拆 Agent，应拒绝或要求先归档（归档会 cancel turn）。
- 归档停止逻辑正是 `agent.cancel({kind:'user'})` 且不 keepInbox（`DSH/packages/core/agent/src/archive-admission.ts:27-38`）。

### 3.9 `ctx.commands`（`DSH/packages/interaction/commands/src/index.ts`）

```ts
register(definition: CommandDefinition): () => void                     // :285
find(agent, name): CommandDefinition | undefined
@Remote list(agent): readonly CommandDescriptor[]
@Remote execute(agent, line, submittedAttachments, signal): Promise<CommandExecution | undefined>
```

`CommandDefinition`（`DSH/packages/interaction/commands/src/index.ts:61-78`）：

```ts
{ definitionId?: CommandDefinitionId; name: string;   // 小写 [a-z][a-z0-9_-]*，不带 /
  description: string; input?: { hint: string; attachments?: boolean };
  recordInput?: boolean;                              // 默认 true；写 command/run 事件
  handler(invocation: CommandInvocation): CommandResult | Promise<CommandResult> }
interface CommandInvocation { commandId; agent: Agent; rawInput: string;
  attachments: readonly (ImageBlock|FileBlock)[];
  signal: AbortSignal }                                // :41-58
type CommandResult = { kind:'success'; text?; sourceEventSeq? } | { kind:'error'; text }  // types.ts:35
```

- handler 的 `agent` 是**发起命令的会话**，但命令可以做任意 Host 操作（例如删除其它会话）。
- 命令的派发面是 Client（Web composer：`DSH/packages/api/session-controller/src/client/sessions/session.ts:388` 调 `remote.commands.execute`）；CLI 没有 slash 派发器。
- 现成范例：`/export`（`DSH/packages/session-query/session-log-export/src/index.ts:81-88`）、`/goal`（带 `input.hint` + `attachments: true` 的完整注册，`DSH/packages/goal/command-goal/src/index.ts:191-198`）、`/compact`（`DSH/packages/compaction/command-compact/src/index.ts:101-103`）。
- 注册是 effect-scoped（返回 disposer）；同名重复注册会抛错（`:102-104`）。

### 3.10 `ctx.tools`（`DSH/packages/core/tools/src/index.ts:99`）

```ts
register(definition: ToolDefinition, options?: ToolRegistrationOptions): () => void   // :128
restrict(filter); get(name, scope?, toolSet?); executable(...); resolve(context);
definitions(...); schemas(...); setExecutor(...); execute(input); guard(...); checkGuards(...)
```

`ToolDefinition`（`DSH/packages/core/tools/src/contracts.ts:26`，extends `ToolSchema` = name/description/parameters）：

```ts
{ name; description; parameters: Record<string, unknown>;
  output: { schema; render(args, value): ContentBlock[]; presentationMeta? };
  execute(args, exec: ToolRunContext): Promise<unknown>;   // 必须有 output！
  timeoutMs?; isConcurrencySafe?; projectContent?; finalizeContent?;
  presentCall?(args); presentResult?(args, result) }
interface ToolRunContext { agent?: Agent; signal: AbortSignal; ... deferContext(); concludeTurn() }
```

- 本版本的 `ToolDefinition` **强制 `output` 声明**（canonical JSON schema + render），不是「schema+execute」两件套；用 `defineTool()`（`DSH/packages/core/tools/src/schema.ts:555`）构造可省略大量样板。
- `exec.agent` 可能为 undefined（PTC/嵌套派发），工具必须自己拒绝无 Agent 的调用（官方 session 工具就这么做：`DSH/packages/experimental/tool-session-query/src/workspace-access.ts:55-70`）。
- 注册在哪个 Context 决定作用域：profile 级行 = 所有 agent 可见；**agent preset 的 `agent.cordis.yml` 里注册 = 仅该 preset 的会话可见**（preset 文件注释 `DSH/.dsh` 本机示例；DSH 包内说明见 `DSH/packages/preset/agent-preset/README.md`）。
- 最完整的官方范例：`@deepseek-ai/dsh-tool-session-query` 注册 5 个只读工具（session_search/session_event_search/session_trace/session_event_trace/session_event_read），含 workspace 授权、输出 schema、presentation（`DSH/packages/experimental/tool-session-query/src/index.ts:19-120`）。**Threadloom 的 agent 工具可直接参考该模式。**

### 3.11 `ctx.storageDomain`（插件自有数据）

```ts
open<S extends DomainSpec>(spec: S): Promise<Domain<S>>   // DSH/packages/storage/storage-domain/src/index.ts
get(name: string): DomainImpl | undefined
closeAll(): Promise<void>
interface Domain { table(name): KvTable; global; close() }
interface KvTable { get/put/delete/deleteMany/keys/entries/size }
```

- 声明方式：`defineDomain({ name, version, layout?, tables: { t: domainTable<Key, Value>(zodSchema) } })`（`DSH/packages/storage/storage-domain/src/spec.ts:107`）。
- json 后端的 root = `~/.dsh/storages`（`DSH/packages/bundle/base/cordis.patch.yml:182-185`）；`single` layout 一个文件/域，`per-record` 一 record 一文件。
- **Threadloom 的回收站索引 / pin 扩展元数据 / 命名别名映射** 放这里，不要污染 `workspace.json`（那属于 workspace 服务）。
- 相关但不必直接用：`ctx.storage` 是 hub（`backend: BackendRegistry` + `mount/form`，`DSH/packages/storage/storage/src/index.ts`），插件持久数据应走 `storageDomain` 而不是裸 backend；`ctx.settings`/`ctx.settingsController` 只负责把各插件 `Config` schema 投影成设置页（`describe/update/replace/mutate`，见 inspect 目录），**不是**会话数据存储。Threadloom 的用户配置用插件自己的 schemastery `Config` 即可（打包文档 §2.1）。

### 3.12 `ctx.fs`（抽象文件系统）—— 没有删除原语

`DSH/packages/fs/fs/src/index.ts:87` 的抽象方法只有：resolve/processPath/fileUrl/contains/stat/lstat/readText/streamText/readBytes/readByteRange/listDir/writeText/editText/watch。**没有 delete/rm/unlink**（`grep delete|remove|unlink` 为零）。
所以物理删除只能：
- Host 插件里直接 `import { rm } from 'node:fs/promises'`（插件运行在 Host 进程，权限与 dsh 进程相同；这是唯一实际可行的 MVP 路径）；或
- 推动上游给 `ctx.fs` 增加删除原语（涉及 sandbox policy）。

注意：`ctx.fs` 的**读**在任何 sandbox 模式下都放行（`DSH/packages/fs/fs-sandbox/src/index.ts:1-10`），但写被 sandbox 策略约束；`sessionPersistence` 不受 sandbox 约束（它是存储 seam，不是 model-facing 文件工具）。**读会话日志应优先走 persistence/sessionQuery，而不是 ctx.fs。**

### 3.13 Web Remote 面（客户端可用，`ctx.remote.*`）

`SessionController`（`DSH/packages/api/session-controller/src/index.ts:134`，namespace `session`）：

| 方法 | 行 | 说明 |
|---|---|---|
| `list(request, signal)` | :265 | 全部可见 SessionSummary（**不过滤 archived**；archived 过滤在客户端） |
| `search(request, signal)` | :279 | 内容搜索（受 `openAt: never` 限制） |
| `create` / `selectModel` / `initializeDefaultModel` / `modelCatalog` | :290-336 | 创建/模型 |
| `rename(request)` | :420 | 先 `resolveAgent`（**冷会话会被 resume**）再 `sessionTitle.rename` |
| `fork(request)` | :432 | 冷会话可用；`atSeq` 截断；`allowMigration` 预检 |
| `prompt` / `updateQueue` / `cancel` / `attachment` / `page` / `follow` / `projections` / `control` | :451-588 | 对话控制 |

`SessionSummary`（`DSH/packages/api/session-controller/src/types.ts:149-162`）：`sessionId, updatedAt, running, blank, agentAvailable, formatStatus?, parentSessionId?, origin?, cwd?, projections?`。标题在 `projections.values.title`（`SessionProjectionHints`，`:45-58`）。`SessionListRequest` 只有一个未用的 `cursor`（`:238-240`），所以**列表分页在客户端/由插件自己做**。

`WorkspaceController`（namespace `workspace`）：见 §3.6。

官方 client 半的 Cordis `inject` 是 `['connection','fileUpload','typert','remote','remote.commands','remote.session','remote.subagents']`（`DSH/packages/api/session-controller/src/client/index.ts:98-105`），运行期通过 `ctx.remote.*` 调 Remote。第三方 client 半的 `dsh.client.inject` 声明的是 slot 提供方包（见打包文档 §2.2/§4.2），**不是**这些服务名；两者别混。**这意味着 Threadloom 的 Web UI 在 MVP 阶段不必自建 Typert Remote 命名空间**：list/rename/pin/archive/fork/导出都能调官方 remote；只有「删除」需要一个新入口（见 §5.2）。

---

## 4. 磁盘布局（本机实测 + 源码）

### 4.1 目录树

```text
$DSH_HOME (= ~/.dsh，可用 $DSH_HOME 覆盖；~/.dsh/profiles/node_modules 是安装锚点)
├── sessions/                                      # base 配置 root = dshHomePath('sessions')
│   ├── --home-leoric-code-deepseek-harness--/     # projectKey(cwd)：分隔符→'-'，首尾 '--'，过长截断
│   │   └── session-<uuid>/                        # 普通会话 id
│   │       ├── session.v4.jsonl.zstd              # 当前格式代（4）的压缩 JSONL：首行 header + 每行事件
│   │       └── session.lock                       # 0 字节；POSIX flock 的跨进程写租约
│   ├── --home-leoric-code-dsh-session-butler--/
│   │   ├── session-<uuid>/
│   │   ├── <bare-uuid>/                           # 子代理/Agent Teams 子会话（id 无 session- 前缀）
│   │   └── ...
│   └── _no-cwd/                                   # header.cwd 为空的会话
├── storages/                                      # storage-json root
│   ├── workspace.json                             # workspace 服务域（v2）：global 归档/置顶集合 + workspaces 表
│   ├── session_projcache/sessions/<id>.json       # 投影缓存（per-record；title/sessionStats/tokenUsage/…）
│   ├── session_projcache.json                     # 旧版单文件残留（历史格式，勿依赖）
│   └── ...                                        # 其它插件的域
├── attachments/v1/{objects,file-objects,tmp,request-images}/...  # 内容寻址的附件（多会话共享）
└── profiles/<name>/                               # profile 组合 + 该 profile 的 node_modules
```

源码依据：root 配置 `DSH/packages/bundle/base/cordis.patch.yml:138-141`；项目/会话目录 `DSH/packages/session/session-persistence-jsonl/src/format.ts:199-288`；文件命名 `DSH/packages/session/session-format/src/filename.ts:5-30` + `format.ts:42,58`；锁文件 `lease.ts:40`；默认 zstd `index.ts:69`。

### 4.2 header 行（实测解压首行）

```json
{"type":"session","version":4,"id":"125ce157-59df-466f-9dfc-f7d6fbbd931d",
 "createdAt":1793073264628,"cwd":"/home/leoric/code/dsh-session-butler",
 "parentSession":"session-64bba441-ce6b-4db2-ba5d-ffa64dd31492",
 "isSeeded":false,"origin":"subagent","delegationDepth":1,"agentPreset":"cordis"}
```

字段定义：`SessionHeader`（`DSH/packages/core/session/src/types.ts:95-136`）。`seq` 从 0 连续；`inheritedEventCount`（fork 继承前缀长度）不在 header 行里，而是存储元数据（handle 提供，`DSH/packages/session/session-persistence/src/handle.ts:67-77`）。

### 4.3 归档/置顶状态（实测 `~/.dsh/storages/workspace.json`）

```json
{ "unit": { "name": "workspace", "version": 2 },
  "global": { "initialized": true, "workspaceIds": ["…"],
              "archivedSessionIds": ["session-88fe26ae-…", …],
              "pinnedSessionIds": [] },
  "tables": { "workspaces": { "<workspaceId>": { "path": "/home/leoric/code/snake",
              "title": "snake", "sessionIds": ["…"], "createdAt": "…", "updatedAt": "…" } } } }
```

→ 归档/置顶都是**逻辑状态**；session 日志与目录完全不动。这也是为什么 Codex 式「archive=移目录」在 DSH 里不成立。

### 4.4 其它后台文件

- `~/.dsh/dsh-claude-style/`、`~/.dsh/dsh-market/`、`~/.dsh/skin-center/`、`~/.dsh/task-board/`、`~/.dsh/intelligent-ui/` 等是其它已装插件的自有目录（看到时不要删）。
- `~/.dsh/session-repair-backups/`、`local-changes-backups/` 是修复/备份目录，删除逻辑不要碰。

### 4.5 读/删的安全约束

1. **读取**：一律 `sessionQuery`（语料/日志）或 `sessionPersistence.open(id,'read')`/`stat`；不要手工解 zstd（多头帧追加、格式代迁移、崩溃截断修复都在后端里）。
2. **删除定位**：`stat(id).location?.path` 拿日志绝对路径 → `dirname()` 即 session 目录；再校验该目录是 `…/sessions/<projectKey>/<id 目录>` 的直接子目录（当前 id 都是 URL-safe 字符，`encodeSegment` 对它们是恒等映射，`DSH/packages/session/session-persistence-jsonl/src/format.ts:199-214`；不要自行实现转义，以免漂移），最后 `rm -r`。
3. **写者探测**：`open(id,'write')` 成功即证明当前无并发写者（跨进程 flock）；紧接着 `close()` 再删（或持 handle 删除后再 close，需实测 close 对缺失文件的容错，MVP 建议前者）。
4. **清理关联状态**：删除成功后 `unarchiveSession(id)` / `unpinSession(id)`（幂等，避免 `workspace.json` 留死 id）；投影缓存**没有公开删除 API**，残留行按 identity 校验（`formatVersion/createdAt/cwd/isSeeded`）不会污染同 id 重建的新会话（`DSH/packages/session/session-projection-cache/src/spec.ts:52-67`），可视为无害垃圾；如坚持清理，只能 `storageDomain.get('session_projcache').table('sessions').delete(id)`（不属于该域的官方 owner，属越权操作，需谨慎）。
5. **附件不要删**：`attachments` 是内容寻址、跨会话共享；没有引用计数/GC API，删了会破坏其它会话。

---

## 5. 能力矩阵（核心结论）

图例：✅ 官方已有；🟡 有原语但需插件组装；❌ 缺失，插件必须自补。

| 能力 | 现状 | 精确 API / 证据 | 缺口 / 插件实现路径 |
|---|---|---|---|
| **列表 list** | ✅ | Host：`sessionQuery.listSessions/filterSessions`（§3.1）；Web：`session.list`（`:265`）+ GUI 侧栏（workspace 分组、Show N more、Ungrouped：`DSH/packages/client/ui-workspace/src/client/tree.ts:3-5`）；ACP：`session/list`（只列可 resume 的冷会话，排除 live/subagent/no-cwd，`DSH/packages/acp/acp/src/index.ts:293-329`） | 缺「跨 workspace 平铺/统一管理视图」、CLI 列表、agent 只读列表工具。插件：`sessionQuery.listSessions` + `filterSessions({kind:'cwd'})` + `workspaceRegistry` 分组 + `sessionProjectionCache.cachedSnapshot(header, ['title','sessionStats'])` 出一行。 |
| **搜索 search** | 🟡 | 内容：`sessionQuery.searchSessions/searchEvents`（sqlite FTS5）；Web：`session.search`（`:279`）；**默认关闭**：base `openAt: never`（`DSH/packages/bundle/base/cordis.patch.yml:149-161`），错误码 `SESSION_QUERY_SEARCH_DISABLED`。GUI 侧栏搜索只匹配标题/workspace 名（同上注释） | 缺「开箱即用的内容搜索」。插件方案 A：在自己的 profile patch 里把 `session-query-sqlite` 覆盖成 `openAt: first-search` + durable `path`（用户级配置，不改 DSH）；方案 B：插件自建轻量索引（读 `listEvents`/`filterEvents` 或 `readSession`，缓存到自有 storage domain）。MVP 建议 A + 标题搜索兜底。 |
| **详情 detail** | 🟡 | `sessionQuery.readSession/readSurface/readTitleSnapshots/traceSession`；`sessionPersistence.stat`（`sizeBytes`/`location`/`formatStatus`，无 eventCount）；`sessionProjectionCache.cachedSnapshot`（turns/steps/token/preset/model）；`sessionQuery.readSession` 里 turn 数可 fold `turnOutline` | 没有单一 detail DTO；插件组合：header + size + title + sessionStats/tokenUsage/agentPreset/modelSelection + traceSession（ancestors/descendants）+ workspace 归属 + 运行状态（`ctx.agents.get(id)?.status`）。`migration-required` 会话要提示先打开（写打开会发布迁移，见 §4.5/§6.2）。 |
| **改名 rename** | ✅ | live：`sessionTitle.rename(session, title)`；Web：`session.rename`（**先 resume 冷会话**：`DSH/packages/api/session-controller/src/commands.ts:186-212`）；GUI 行菜单/双击重命名（`DSH/packages/client/ui-workspace/src/client/session-actions/RenameSession.tsx`） | 缺「不经 resume 的冷会话改名」。插件方案 A（官方）：`ctx.agents.resume({resumeSessionId:id})` → `sessionTitle.rename` → `handle.dispose()`；方案 B（绕过 agent，需谨慎）：`sessionPersistence.open(id,'write')` 读末 seq，append `session/title {title: normalizeSessionTitle(...), messageSeqs: [], source:{kind:'user'}}`，flush/close。B 依赖事件 schema（v4）与宿主的 title 配置（base 默认 80 字节，profile 可覆盖），属非官方路径，建议仅作为「冷改名」优化并加开关。冲突规则：无唯一约束，同名允许；危险操作仍以 sessionId 寻址。 |
| **置顶 pin/unpin** | ✅ | `workspaceRegistry.pinSession/unpinSession`（`:428,:455`）；Web `workspace.pinSession/unpinSession`；GUI Pin 按钮（`PinSession.tsx`）；置顶集合全局、最近置顶在前；已归档不可 pin | 无缺口。若目标 profile 无 workspaceRegistry（headless/acp），插件可用自有 storage domain 实现等价 pin 集合（但 Web GUI 不识别，需同时做 client 半）。 |
| **归档 archive / 取消归档** | ✅ | `workspaceRegistry.archiveSession(sessionId, {stopActivity?})` / `unarchiveSession`（`:365,:399`）；Web `workspace.archiveSession/unarchiveSession`；GUI Archive/Restore + 运行中确认框（`ArchiveSession.tsx`）；归档门禁 `ArchivedSessionGate` | 无缺口，但语义是「逻辑隐藏」：文件不动、GUI 不可打开、后代被门禁冻结、不级联标记子会话。插件若要「Codex 式归档目录」需自己实现移动（不建议，会绕开官方状态机）。 |
| **删除 delete（回收站/永久）** | ❌ | **没有任何官方 API/命令/路由/事件/工具**。`SessionPersistence` 只有 create/open/flush/stat/list（`DSH/packages/session/session-persistence/src/index.ts:159-210`）；删除方法在 2026-06-20 被移除且设计 note 留了「等真实 UI 消费者再加」的说明（`DSH/.agents/notes/archived/simplification/2026-06-20-prune-dead-seam-methods.md:31,41`） | ★ Threadloom 的核心价值。插件侧实现（§4.5/§5.2）：回收站 = 把 session 目录 move 到插件自有 trash 根（`~/.dsh/threadloom/trash/<id>/`）+ 自有 domain 记录原路径/删除时间/父 lineage；永久删除 = rm；恢复 = move 回原路径并清理 pinned/archived 状态。必须处理：live 会话拒绝、跨进程写者探测、级联子代理、刷新事件缺失。长期：向上游补 `SessionPersistence.delete()`（见 §5.2）。 |
| **fork** | ✅（Web） | live：`ctx.sessions.fork(source, boundary?, childId?)`；Web：`session.fork({sessionId, atSeq?, allowMigration?})`（`commands.ts:214-300`）→ `sessionQuery.observeSession` + `buildForkSeed` + `agents.create`（`isSeeded:true`，新 id `session-<uuid>`，继承 cwd/preset，attach 到同 workspace）；GUI Fork 菜单（`ForkSession.tsx`） | 二期可用官方 Remote 直接做 UI；缺口：CLI/tool/截断点的可视化（`atSeq` 语义是 inclusive，省略=最近完成的 turn，`SessionForkRequest` 注释 `types.ts:301-307`）。fork 不写 parentSession，不要把它算进血缘级联（除非产品上要「fork 树」，需另存派生关系）。 |
| **导出 export** | ✅（Web） | 官方 `@deepseek-ai/dsh-session-log-export`：`/export` 斜杠命令（`DSH/packages/session-query/session-log-export/src/index.ts:83`）；`GET /api/session.export?sessionId=&includeDescendants=`（ZIP：日志 JSONL + 附件 + `subagents/<id>/…`，`session-log-export/src/archive.ts:343-390`）；`GET /api/session.markdown?sessionId=`（Markdown 文本，`index.ts:105-160`）；`formatSessionMarkdown` 可复用 | 缺 CLI/批量导出（按 workspace 打包、导出全部）。插件可：直接复用 HTTP 路由（Web），或 `sessionQuery.readSession + formatSessionMarkdown` 自己写文件（Host 侧，需要 `node:fs`）。 |
| **级联子代理清理** | 🟡 | 枚举：`subagents.listChildren/listDescendants`（目录投影，最可靠）+ `sessionQuery.traceSession`（header 血缘）；停止：`subagents.drainDescendants`、`agent.cancel`（归档路径里 subagent 插件已实现 `workspace/session-stop`：`DSH/packages/subagent/subagent/src/archive-admission.ts:23-38`）；**删除没有级联 API** | 插件逻辑：以目标为根，取「`origin==='subagent'` 且 `parentSession` 链可达」的会话集合；删除前展示数量/标题；逐个执行删除流程；fork 不算后代。归档若希望「子会话也消失于列表」，需要逐个 `archiveSession`（官方只标记父级）。 |
| **运行中会话处理** | 🟡 | 归档：官方支持 `stopActivity`（先写归档再停 turn/subagent/job/schedule，`:365-387`）；其他：`ctx.agents.get(id).status`、`agent.cancel({kind:'user'})`；删除：无官方支持 | 删除策略建议「先归档（stopActivity）再删」：归档保证 turn 结束、子代理被 cancel、日志收尾；若坚持直接删，必须拒绝 `ctx.sessions.get(id)` 存在的会话，并用 `open(id,'write')` 探测跨进程写者；不能 dispose 别人的 Agent（无公开 API）。 |
| **跨 workspace 移动** | ❌（实际不可行） | `workspace.entity.attachSession` 要求 header.cwd 的 realpath == workspace path（`entity.ts:110-150`）；header 是**不可变**的（`SessionHeader` readonly，且 persistence 以 header 定目录）。`workspaceRegistry.delete(id)` 只删注册、不删会话（设计 note `DSH/.agents/notes/archived/feature/2026-07-27-workspace-registration-deletion.md`） | 真「移动」需要复制日志到新 project 目录 + 改 header.cwd（非法）或新建会话重放（fork+改 cwd，非移动）。MVP 不做；二期若要，讨论「copy 后旧会话标记迁移」的产品语义，并需上游支持。 |
| **打开/恢复会话** | ✅ | Web `session.prompt`/`resolveAgent` 内部 resume；SDK `session/resume`（`DSH/packages/sdk/server/src/server.ts:431-437`）；ACP `session/resume`；archived 会话被 GUI 禁止打开（`DSH/packages/client/ui-workspace/src/client/index.ts:250-256`） | 详情页的「打开」按钮可直接复用 `remote.session`/命令；删除前提示「已归档需先取消归档」。 |

---

## 6. 推荐扩展点（按实现顺序）

### 6.1 插件形态

一个 Threadloom 包（`dsh-session-butler`）三层：

1. **Host 半（必须）**：`apply(ctx)` 里
   - 必需 `inject = ['sessionQuery', 'sessionPersistence', 'storageDomain']`；要注册命令/工具时再加 `'commands'`/`'tools'`（base 恒有，见 §2 表）；
   - `ctx.get('workspaceRegistry')` / `ctx.get('sessionTitle')` / `ctx.get('subagents')` / `ctx.get('agents')` 作为**可选**能力探测（web/sdk 有、headless 无）；
   - 对外暴露一个 Host Service（`ctx.provide`/`Service` 子类，如 `threadloom`），内部实现 list/detail/trash/purge/cascade；**不要**把删除逻辑直接塞进 client 插件。
2. **命令面（MVP 推荐）**：`ctx.commands.register({ name:'threadloom', … })` + `commands.execute`；好处：客户端零改动即可用（Web composer 输入 `/threadloom …`），Host 侧拿到发起会话的 agent 上下文；坏处：CLI 无 slash 派发、交互式确认能力有限（`CommandResult` 只有 success/error 文本）。
3. **Web Client 半（增强）**：复用 `ctx.remote.session` / `ctx.remote.workspace` / `ctx.remote.commands` 完成 list/rename/pin/archive/fork/export；删除通过 `/threadloom delete <id>` 命令触发，或用 Host HTTP 路由（`ctx.connection.fetch.register`，客户端 `fetch('/api/threadloom/…')` —— 官方 `/export` 就是这个模式，`DSH/packages/session-query/session-log-export/src/index.ts:88-120`）。**MVP 不需要自建 Typert Remote 命名空间**（自建需要 typert generator 的构建期产物，`DSH/packages/typert/generator/README.md`）。
4. **Agent 工具（二期/可选）**：`ctx.tools.register(defineTool({...}))`，只读工具（threadloom_list/threadloom_detail）可参考 `tool-session-query`；**写操作（删除）不建议暴露给模型**，或至少要求会话内二次确认。工具作用域：注册在 profile 根 = 全部 agent；只给某些 preset 就在 preset 的 `agent.cordis.yml` 挂行。

### 6.2 删除能力的两种实现

**路径 A：插件侧删除（MVP 可行）**

```text
prepare(id):
  record = filterSessions([{kind:'id', values:[id]}])           # 存在性 + header
  if sessions.get(id) || agents.get(id) → 拒绝（运行中/本进程 live）
  handle = persistence.open(id,'write')                         # 抢跨进程写租约
  handle.close()
  snapshot = persistence.stat(id)                               # location.path, sizeBytes, formatStatus
  verify 目录位于 …/sessions/<project>/<id>/ 且 basename 与 id 一致
trash(id):
  rm -rf 原目录前先 rename 到插件 trash 根（同一文件系统内 rename 最安全）
  自有 domain 记录 {id, originalPath, deletedAt, headerSnapshot, descendantIds}
  清理 pinned/archived 集合（unarchive/unpin）
purge(id): rm -rf trash 记录
restore(id): rename 回 originalPath → 清理状态 → 刷新
cascade: descendants = 交叉验证（subagents.listDescendants ∩ traceSession）且 origin==='subagent'
```

注意：
- **没有 session 删除事件**：Web 客户端不会收到 `api-session/removed`（那只在 live session dispose 时发，`DSH/packages/api/session-controller/src/index.ts:215-217`）；插件 UI 需要自己刷新（或触发自己的 client 事件）。
- 回收站目录建议放 `~/.dsh/threadloom/trash/`（用 `ctx.get('dshHomePath')?.('threadloom','trash')`，app-boot 提供 `dshHomePath`，`DSH/packages/boot/app-boot/src/index.ts:1220`）；同盘 rename 避免跨设备复制。
- 不要删 `attachments`，不要识别/删除未知文件（其它插件在同一 root 下有数据）。
- 删除 migration-required 会话：先 `agents.resume` 让它完成迁移再删，或直接删并记录（产品决定）。

**路径 B：向上游补 API（推荐作为跟进 issue/PR）**

设计 note 已给出方向（多方法一层的 `SessionPersistence.delete(id)` + backend hook + 事件 + cache/client 失效）。Threadloom 可以作为「真实消费者」提案：
- `SessionPersistence.delete(id)`：写打开验证无并发写者 → 后端删除整目录（含 lock/历史代）→ 返回 `deleted: boolean`；
- `session/deleted` 事件 + `api-session/removed` 对 cold 会话也发；
- 投影缓存清理钩子；
- 归档/置顶集合自动清理由 workspace 服务订阅事件完成。
这样 Threadloom 就只做 UI/编排，不碰 fs 细节（也避免与未来逻辑存储重构冲突）。

### 6.3 与现有 GUI 的关系

- 侧栏已有：workspace 分组、标题搜索、pin、rename、archive/unarchive、fork、`/export`、archived 筛选。Threadloom 的差异化在「统一管理面 + 删除/回收站 + 详情/血缘 + 批量操作 + 跨 workspace 总览」，而不是重做侧栏。
- 要做「管理面板」时，client 半的挂载点、slot key、props 与构建约束见 [`dsh-web-ui.md`](./dsh-web-ui.md)（结论：`main` 面板 + `sidebar.panellist` 入口，与官方 Plugins 页同构）；数据通过 `remote.session.list` + 自有 detail 命令/路由拿。
- 详情页「轮数/token」优先用投影（`sessionStats`/`tokenUsage`/`contextPressure`）；冷会话用 `sessionProjectionCache.cachedSnapshot(header, ['title','sessionStats','tokenUsage'])`（零 I/O、可能稍旧），没有缓存时再 `readSession` 全量 fold。

### 6.4 刷新与一致性

| 变更 | 谁会推送 |
|---|---|
| live session 增删 | `api-session/added/removed`（`DSH/packages/api/session-controller/src/index.ts:212-217`） |
| 运行状态 | `api-session/status`（`:225-227`） |
| 活动时间 | `api-session/activity`（`:231-234`） |
| workspace/归档/置顶 | `workspace.follow` 流（`WorkspaceFollowFrame`，`DSH/packages/api/workspace-controller/src/types.ts:153-176`） |
| 标题/projection | `sessionProjections.onChanged`（Host 侧）/ 客户端 projection store |
| **冷会话删除** | ❌ 无事件；插件自己做刷新/广播 |

---

## 7. 风险、边界与待决策

1. **API 不稳定**：0.2.1-rc.3 + 存储层重构提案 → 所有依赖版本要夹紧；Service 用 `ctx.get` 探测；避免 import 具体实现包（如 `session-persistence-jsonl` 的路径函数未导出，只有 `sessionDir` 内部使用）。
2. **删除与未来逻辑存储**：如果上游将来换存储实现，插件直删目录会失效；用 `stat().location` 的 kind 判断（`kind==='jsonl'` 才按目录删；其它 kind 拒绝并提示升级），可降低风险。
3. **跨进程**：`SessionPersistence` 的写租约是跨进程的；但**列表/状态是每进程视角**。多开 dsh（web + headless）时，插件只应信任 `open(write)` 探测结果，不要把 `sessions.list()` 当全局。
4. **归档语义与用户预期**：归档后 GUI 不能打开、子代理被冻结；如果 Threadloom 的 UI 把 archived 会话展示为可预览，需要先 unarchive（会解除门禁）。
5. **内容搜索**：开启 sqlite FTS 索引会引入持久 DB 文件（`path` 建议放 `~/.dsh/` 下），并且 `openAt: first-search` 首次搜索有延迟；插件要处理 `SESSION_QUERY_SEARCH_DISABLED` 与 `SESSION_QUERY_INDEX_FAILED`。
6. **命名/寻址**：title 无唯一约束、id 不统一前缀；危险操作（删除/永久清除）强制 UUID/完整 id，按名字/标题只用于选择列表，执行前再次回显 id。
7. **待产品决策**（沿用 README）：回收站保留期、级联删除是否含 fork（当前建议不含）、删除运行中会话是「先归档」还是拒绝、命名冲突规则。

---

## 8. 参考索引（源码行号）

**会话读写**
- `DSH/packages/core/session/src/types.ts:90` `SESSION_FORMAT_VERSION = 4`；`:95-136` `SessionHeader`（parentSession/origin/isSeeded/delegationDepth/agentPreset）
- `DSH/packages/session-query/session-query/src/index.ts:98-355` `SessionQueryEngine` 全部方法
- `DSH/packages/session-query/session-query/src/types.ts:27,83,199,205,233,253,287` 关键类型
- `DSH/packages/session-query/session-query/src/corpus.ts:62-92` live-preferred 列表 + 排序；`:313-315` compareSessions
- `DSH/packages/session-query/session-query/src/tracing.ts:119-180` traceSession（父子关系）
- `DSH/packages/session-query/session-query/src/config.ts:23-49` 错误码
- `DSH/packages/session/session-persistence/src/index.ts:125-210` persistence 契约；`handle.ts:25-116` handle 契约；`errors.ts` 错误类
- `DSH/packages/session/session-persistence-jsonl/src/format.ts:199-305` 目录/文件名；`lease.ts:40` 锁；`index.ts:69,102` 压缩/root

**标题/投影**
- `DSH/packages/session/session-title/src/index.ts:301,411-431` 服务与 rename；`normalize.ts:59` 规范化；`types.ts:80-87` title 投影
- `DSH/packages/session/session-projection/src/index.ts:252-541` 投影注册表
- `DSH/packages/session/session-projection-cache/src/index.ts:105-300` 缓存服务；`spec.ts:52-67,100` 域/identity
- `DSH/packages/session/session-stats/src/projection.ts:108,205` sessionStats（summary:false）

**workspace / 归档 / 置顶**
- `DSH/packages/workspace/workspace/src/index.ts:47-148,170-508` 错误、事件、注册表与归档/置顶
- `DSH/packages/workspace/workspace/src/entity.ts:106-181` attach/detach/insert/status
- `DSH/packages/api/workspace-controller/src/index.ts:159-191` Remote 映射；`commands.ts:162-235` 实现；`types.ts:114-176` 请求/值
- `DSH/packages/api/session-controller/src/archived-session-gate.ts:23-56` 归档门禁
- `DSH/packages/client/ui-workspace/src/client/index.ts:160-214,249-256` 客户端 pin/archive/rename/fork 行为

**Remote / 客户端**
- `DSH/packages/api/session-controller/src/index.ts:134,265-279,420-443,503-588` Session Remote
- `DSH/packages/api/session-controller/src/types.ts:45-58,149-162,238-245,289-326` summary/request/value
- `DSH/packages/api/session-controller/src/commands.ts:186-300` rename/fork 实现
- `DSH/packages/api/workspace-controller/src/client/service.ts:80-180` 客户端 workspace 服务
- `DSH/packages/api/session-controller/src/client/index.ts:98-105` client inject 的 remote 命名空间
- `DSH/packages/session-query/session-log-export/src/index.ts:83-160` `/export` + 两个 HTTP 路由；`routes.ts:8-14`；`markdown.ts`、`archive.ts:343-390`（includeDescendants）

**命令 / 工具 / 存储 / 文件系统**
- `DSH/packages/interaction/commands/src/index.ts:41-78,285` 命令契约与注册
- `DSH/packages/core/tools/src/contracts.ts:26-100` ToolDefinition；`schema.ts:555` defineTool；`DSH/packages/core/tools/src/index.ts:99,128` ToolsService
- `DSH/packages/experimental/tool-session-query/src/index.ts:19-120` 官方工具注册范例；`workspace-access.ts:55-70` 授权范例
- `DSH/packages/storage/storage-domain/src/spec.ts:107` defineDomain；`domain.ts:115-136,348` Domain/table.delete
- `DSH/packages/fs/fs/src/index.ts:87-300` FileSystem 抽象（无删除）；`DSH/packages/fs/fs-sandbox/src/index.ts:1-10` 读放行
- `DSH/packages/boot/app-boot/src/index.ts:1220` `ctx.provide('dshHomePath', …)`

**组合与兼容**
- `DSH/packages/bundle/base/cordis.patch.yml:40,60-65,138-141,149-161,182-185,196,317,494` 会话/标题/持久化/搜索/存储/命令/工具
- `DSH/packages/bundle/web-app/cordis.patch.yml:67,83,94,99,113,146,227,362` export/workspace/session-controller/workspace-controller/connection/ui；`DSH/packages/bundle/sdk-app/cordis.patch.yml:46,51-52` connection/workspace
- `DSH/packages/boot/app-boot/src/plugin-compatibility.ts:55-102` 兼容判定
- `DSH/.agents/notes/archived/simplification/2026-06-20-prune-dead-seam-methods.md:31,41` 删除 API 的设计依据
- `DSH/.agents/notes/proposed/architecture/2026-09-06-logical-session-storage-rebuild.md:1-40,71-79` 存储层重构提案（Stage 进度表；不稳定因素）
- ACP/SDK 旁路：`DSH/packages/acp/acp/src/index.ts:293-329`（session/list）、`DSH/packages/sdk/server/src/server.ts:425-437`（session/resume，无 list/delete）

**本机实测**
- `~/.dsh/sessions/--home-leoric-code-dsh-session-butler--/<id>/session.v4.jsonl.zstd` + `session.lock`
- `~/.dsh/storages/workspace.json`（archivedSessionIds/pinnedSessionIds）
- `~/.dsh/storages/session_projcache/sessions/<id>.json`
- `~/.dsh/profiles/node_modules/@deepseek-ai/dsh*/package.json`（0.2.1-rc.3 安装锚点）
