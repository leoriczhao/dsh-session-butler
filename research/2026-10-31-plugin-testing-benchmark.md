# 社区插件测试覆盖对标：Threadloom 要不要 E2E

> 调研日期：2026-10-31。对象：本机 `~/.dsh/profiles/web/node_modules` 里已安装的社区插件，以及它们公开的 GitHub 仓库、CI 与测试源码；同时对照 DSH 官方 `docs/testing.md` 的分层策略。结论先行，证据在后。

## 0. 结论

**需要 E2E，但不是“大而全的浏览器矩阵”。**

Threadloom 属于 **产品可见 UI + 破坏性文件操作 + Host/Client 双半 + npm 安装契约** 的插件，风险等级高于普通 provider/loader 插件。按 DSH 官方测试政策与社区同行的做法，合理的最小配置是：

1. **Real-composition 集成测试**（优先）：用真实 DSH Loader/profile 把插件装进去，验证 bundle 能被发现、Host apply、Client slot 注册、bridge 路由可达；可用临时 `DSH_HOME`，不需要浏览器，适合每次 PR。
2. **一条 Playwright E2E happy path**（第二优先）：隔离 `DSH_HOME` + 固定版本 DSH + 打包后的本插件 + 脚本化模型，真实 Chromium 里验证：设置页两个分区、已归档删除、行菜单删除、删除后会话目录/回收站无残留。桌面/安装类风险用 `packed` 产物而不是源码。
3. 保留现有 65 个 node:test 单元/集成测试作为快速门禁；E2E 单独 job，PR + 发布前跑，不塞进 `npm run verify`。
4. **不需要**照搬 dsh-claude-style 的多平台/多场景/视觉快照/分片矩阵；它的页面/皮肤面比 Threadloom 大一个量级。

如果暂时不做完整 E2E，至少要把 **real-composition 集成测试** 补上；只靠现有 fake ctx 单测 + 手动 Playwright 截图，不足以覆盖“装到真实 DSH 后入口是否出现、删除是否真的发生”。

## 1. 社区插件实测分布

| 插件（安装版本） | 形态 | 测试层级 | 浏览器 E2E | CI 做法 |
|---|---|---|---|---|
| **dsh-claude-style** 0.19.6 | 大型皮肤/行为插件（CSS、页面、侧栏） | vitest 单测；`contract-probe`；`smoke`（stand-in page）；`behaviour` 三系统；`faults`；`coverage` | **有，且最重**：`packages/testing/e2e.mjs` 启真实 `dsh web` + 脚本化模型 + Chromium，按 scenario 分片，逐帧采样、失败留证据 | CI 多 lane：checks、build-unit-smoke、behaviour-macos、e2e、faults、observe；PR/merge queue/manual 跑全矩阵 |
| **dsh-intelligent-ui** 0.2.1-rc.3.iui.* | 复杂渲染 UI/协议插件 | `node --test` 几十个用例；`test/host/*.test.mjs` 使用真实打包 Host + Playwright 页面对象，覆盖 hover/提交/保存/刷新/卸载 | **有**：在真实 packaged native Web 生命周期里用 Playwright locator 操作页面（`test/host/web-product.test.mjs`） | CI 矩阵 3 OS × 多个 host SDK 版本；安装 Chromium；`pnpm test` + 打包后 host 测试；Windows 特有状态诊断 |
| **dshmarket** 1.73.5 | 插件市场（安装/更新链路是核心） | vitest 单测 + `test:compat` 兼容矩阵 + preflight/registry/validate | **有，Layer-3 web e2e**：真实 pinned dsh + 打包 market + 真实 Chromium，覆盖安装/更新/频道 | CI 分 job：unit/compat/web-e2e；Windows + Linux 双平台；显式 `playwright install chromium`，`npm run test:web` |
| **dsh-unlag** 1.14.15 | loader/工具类插件（改启动图、按钮） | `node --test` 大量单测（chaos、guard、reload、hostile host 等） | **没有常规 Playwright**；有 `scripts/live-smoke.mjs`（真实运行中的 app，连不上就 skip）和 `loader-contract.mjs`（真实 app loader 契约，Windows CI） | CI 多 OS Node 矩阵 + Windows desktop check；smoke 允许 skip，不让缺环境变红 |
| **dsh-opencode-session** 0.1.1 | 小型 provider 适配器 | 单个 `tests/test.mjs`：fake cordis ctx + 本地 HTTP echo server，驱动 `llm/stream` | 无 | 只有 `npm test`；`prepublishOnly` 跑测试 |
| **Threadloom** 0.2.1（本仓库） | 产品可见 UI + 删除会话 + Host/Client 双半 + npm bundle | `node:test` 65 个用例 + `e2e/` L1 真实组合（3 条断言链） | **已实现一条 L2 Playwright happy path**：设置页两分区、行菜单一步删除、已归档页永久删除、目录/回收站零残留；会话用持久化 idle fixture，不依赖模型 | CI ubuntu：verify + 独立 e2e job（Playwright Chromium），失败上传截图 |

### 观察

- **小插件可以只做单测**（dsh-opencode-session），因为它们没有 UI 入口、没有跨模块安装面。
- **一旦有“产品可见页面/入口/删除”**，社区主流会加真实组合测试；复杂 UI 插件直接上真实 host + Playwright（dsh-intelligent-ui、dshmarket）。
- **E2E 的实现方式有梯度**：
  - 轻量 live smoke：真实 app 在才跑，否则 skip（dsh-unlag）；
  - 中等：真实打包 Host + Playwright，测一条生命周期（dsh-intelligent-ui）；
  - 重：独立 `dsh web` + 脚本化模型 + 场景表 + 分片（dsh-claude-style）。
- Threadloom 的风险点（bundle 是否被 loader 发现、设置 slot 是否出现、删除是否真的移走文件、打包后是否还能用）正好落在“必须真实组合”的区域，而不是纯逻辑单测能覆盖的区域。

## 2. DSH 官方测试分层（`docs/testing.md`）

官方仓库自己的 gate 顺序值得拿来当参考：

1. **Unit**（vitest）：registry 要测 HMR 安全（dispose contributing fiber + 断言清理）；偏好错误路径、事件顺序、并发竞态、契约回归。
2. **Coverage gate**：`packages/*/*/src` 逐文件 100%；但明确“行覆盖必要不充分”。
3. **Real-API e2e**：需要 key 的测试缺 key 自动 skip，keyless CI 保持绿。
4. **Owner-local expected output / snapshot / web browser snapshot**：真实 browser lane 是 Linux PR 必过门禁，Chromium 跑 `snapshots/web/`；录制/刷新只允许本地，CI 只读。
5. **规则**：产品可见插件需要 **non-unit REAL-composition test**；手工拼 `ctx.plugin(...)` 不够，要 boot test-only `cordis.yml`；测试“真实入口路径”（发布产物，不是 tsx 源码）；E2E 自己创建并 dispose harness，断言失败也要清理。

这套分层与主流工程共识一致：**快速单元/契约门禁 → 真实组合集成 → 少量关键路径 E2E → 发布前安装/升级冒烟**；E2E 负责“只有组装后才成立”的事实，不负责替代单元测试。

## 3. Threadloom 现状评估

现有 65 个测试不弱：

- Host：trash/restore/purge/delete、级联、运行中/迁移中拒绝、租约、批量、read-model、bridge 协议、命令、工具 schema；
- Client：真实 Cordis mount、slot 注册/延迟绑定/释放、设置页 SSR、行菜单开关；
- 构建/发布：经典脚本 bundle 注册、manifest、package closure、tarball 校验。

调研时仍有三个空白；本轮落地状态：

1. **没有真实 DSH 组合**：`cordis-mount.test.mjs` 用的是空 `Context`，不是真实 Loader/profile/bootstrap；bundle 是否被 DSH 发现、`settings.section` 是否注入到真实设置 shell、bridge 路由是否被真实 web server 接受，都没有自动断言。→ **已补（L1）**。
2. **没有真实浏览器 E2E**：设置页入口、已归档删除、行菜单删除、删除后文件消失，目前靠手动 Playwright + 截图；不可重复、CI 不可见。→ **已补一条主路径（L2）**。
3. **手动 E2E 已经抓到真实 bug**：2026-10-30 的验证里，运行中会话点击“删除聊天…”时，Host 返回 `session-running`，而 Client 只 `console.error`，用户界面没有任何提示；这类“交互后静默失败”只有真实组合/浏览器测试容易暴露。→ **仍未修复**；L2 使用 idle 会话，不把运行中 settle 的时序不确定性带进 CI，该错误路径目前只由 Host 单测覆盖。

## 4. 建议的测试流程（由轻到重）

| 层级 | 内容 | 频次 | 成本 |
|---|---|---|---|
| L0 快速门禁 | 现有 65 个 node:test + typecheck + build + validate-package | 每次 push/PR | 低（当前 ~1 分钟） |
| L1 Real-composition | 临时 `DSH_HOME` + 真实 DSH CLI/profile 启动，安装/链接本插件，断言：bundle 被发现、Host apply 无错、Client 注册两个 settings section + 行菜单、bridge `status` 可达 | 每次 PR | 中（fixture + 配置） |
| L2 Playwright E2E | 打包产物 + 隔离 profile + 脚本化模型 + Chromium：设置页两分区、已归档删除、行菜单删除、删除后目录/回收站断言、运行中删除错误提示 | PR + 发布前（ubuntu 单平台） | 中高（fixture/browser/CI job） |
| L3 发布/安装 | `npm pack` 后干净目录安装、`dsh plugin add`、启动冒烟、版本/registry 校验 | 发布前 | 中（已有部分 `validate-package` 基础） |

建议顺序：**先 L1**（性价比最高，能覆盖 bundle/loader/slot 三类最容易回归的问题）→ **再 L2 一条 happy path** → L3 保持现有 runbook。不要一上来做 L3 全浏览器矩阵。

### L2 最小范围（若做）

- 用打包后的 `dsh-session-butler`，不是源码路径；
- 隔离 `DSH_HOME`，启动固定版本 `dsh web`（如 0.2.2-alpha.2），端口随机，token 从启动输出读取；
- 脚本化 LLM（参考 dsh-claude-style 的 `mock-llm.mjs` 或 dsh-intelligent-ui 的 host fixture），避免真实 API 依赖；
- 场景 1：设置 → 已归档的聊天存在；行菜单只有官方项 + Delete chat…；不存在 Trash 分区；
- 场景 2：创建一个丢弃会话 → 归档 → 设置页 Delete permanently → 确认 → 断言 bridge list 无此 id、会话目录不存在、trash 目录无残留；
- 场景 3（回归）：运行中会话点删除 → 断言出现用户可见错误（而不是静默）；
- 失败时保存截图/trace；CI 上单独 job，不加入 `verify`，PR 必过、发布前再跑一次。

## 5. 落地记录（2026-10-31，用户批准「L1 + 一条 L2」）

- **已完成**：
  - `e2e/composition.e2e.mjs`（L1）：临时 `DSH_HOME` + `npm pack` 可发布产物 + 真实 `dsh web`；断言 Client bundle 注入、桥 `status`/版本/后端、`delete` 路由、空归档列表。
  - `e2e/live-ui.e2e.mjs`（L2）：Playwright Chromium 走真实 GUI；设置页只有 Archived chats / Threadloom，行菜单 `Delete chat…` 一步删除，归档后设置页 `Delete permanently`，并断言会话目录与 `trashCount` 零残留。
  - CI 独立 `e2e` job；本地 `pnpm run test:e2e`；失败截图上传。
- **与建议的偏差**：
  - L2 没有接脚本化 LLM，改为写入 Host 同格式的 **idle 持久化会话**。目标路径是设置页/行菜单/删除，不需要模型；这样 CI 不依赖模型路由时序，也不需要维护 mock provider。代价是未覆盖“新建会话 → 首次标题”的模型路径。
  - L2 使用 `npm pack --ignore-scripts` 后解压到临时 profile，而不是 `dsh plugin add` 从 registry 安装；这已覆盖发布 tarball 的 `files` 闭包与构建产物，registry 安装仍由现有发布 runbook 覆盖。
- **仍未覆盖**：运行中会话行菜单删除失败时的用户可见错误（上面第 3 项）；需要单独的浏览器场景或 Client 交互测试。
- **运行约定**：先 `pnpm run build`（E2E fixture 会检查 `lib/client.js`），首次安装 Playwright Chromium；详见 [docs/testing.md](../docs/testing.md)。

## 6. 参考链接

- DSH 官方测试政策：`/home/leoric/code/deepseek-harness/docs/testing.md`（本地 checkout）
- dsh-claude-style：<https://github.com/Nwflower/dsh-claude-style>（`packages/testing/e2e.mjs`、`scenarios.mjs`、`.github/workflows/ci.yml`）
- dsh-intelligent-ui：<https://github.com/gulagala001/dsh-intelligent-ui>（`test/host/web-product.test.mjs`、`test/fixtures/host.mjs`、`.github/workflows/ci.yml`）
- dshmarket：<https://github.com/dsh-market/dsh-market>（`test:web`、`scripts/install-e2e-host.mjs`、`.github/workflows/ci.yml`）
- dsh-unlag：<https://github.com/regrevia/dsh-unlag>（`scripts/live-smoke.mjs`、`scripts/loader-contract.mjs`、CI）
- dsh-opencode-session：<https://github.com/nobu121/dsh-opencode-session>（`tests/test.mjs`）
