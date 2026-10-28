# DSH 插件管理能力调研（0.2.2-alpha.2）与 Threadloom D3 接入建议

> 调研对象：DSH checkout `/home/leoric/code/deepseek-harness`（`package.json` 0.2.2-alpha.2，即正在运行的 `apps/cli/src/bin.ts web` 源码进程）。
> 目标插件：`dsh-session-butler` 0.1.2（profile `web`，`link:` 安装）。日期 2026-10-28。
> 用途：校准 `docs/d3-console-design.md` §8「与插件管理 feature 的集成」、§9.2 与 §11 开放问题 1/2。
> 方法：只读源码/README/profile；未改 `~/.dsh`、未改源码、未重启服务。**除特别注明外，证据路径均相对 DSH checkout。**

## TL;DR

1. DSH 0.2.2 的插件管理是「两个页面面 + 一条 CLI」：侧栏 **Plugins 页**（`ui-plugin-manager`，Remote `pluginManager.*`）、设置 → **内置插件**分区（只读清单 `pluginInventory.*`）、`dsh plugin ...`（转发 pnpm + 版本豁免子命令）；另有 agent 工具 `plugin_manager`（standard/ptc preset 启用，要求 danger-full-access 或逐次审批）。
2. 第三方装进 profile 后**不需要也不能**自实现安装/卸载/开关：插件页自动给 bundle 卡片、行开关、卸载、（注册表安装的）版本区块。
3. 第三方可挂到插件管理页的扩展点（`ui-plugin-manager` 声明，均 root 作用域）：`plugins.tab`、`plugins.add.actions`、`plugins.item`（官方占用）、`plugins.bundle.config`、`plugins.row.config`、`plugins.detail.actions/badge/section`、`plugins.bundle.activation`。
4. **D3 §8.2 需修正**：`settings.plugins.tab` 属于「设置 → 内置插件」分区的 tab 行，官方定位是随包内置插件信息（目前只有只读清单一个 tab）；第三方插件配置的官方位置是**侧栏 Plugins 页**。`dshmarket` 同时注册 `settings.section`/`settings.plugins.tab` 只是兼容 0.2.1 之前旧宿主（其 README 第 12 行明确 0.2.1+ 用 Plugins 页 tab）。
5. 推荐 Threadloom 落点：`plugins.row.config`（key `dsh-session-butler#session-butler`，行页自动出现「配置」入口；Config 字段标 `.volatile()` 后页面会拿到 `form`，保存写回 profile patch 并热生效）+ `plugins.bundle.config`（key `dsh-session-butler`，bundle 页内联健康/统计区，无 form）+ `plugins.detail.badge/section`（bundle 页健康徽标/诊断区）。
6. 设置写入路径：`plugins.row.config` 的 `form` 来自 `ui-settings` 的 `ctx.configForms`，命名空间 = profile 条目 id，**只有 volatile 字段进入表单**（`docs/subsystems/settings.zh.md:5,9`）；但 shipped client 都不消费 `autoGenerate`，**不存在自动表单页面**，页面必须自己渲染字段。Threadloom 现有 3 个字段未标 volatile（`src/config.ts:37-58`），需补 `.volatile()`。
7. 健康数据三源：bundle 页 slot 的 `subject.pkg`（name/version/installed/availability/official/enabled/rows，**无 fiberPhase/诊断**）、`pluginInventory/list`（fiberPhase/diagnostic/managementAvailable）、`pluginManager/listBundles`（error/readOnlyReason/rows）。第三方 client 可注入 `remote.pluginInventory`/`remote.pluginManager`（`ui-plugin-manager/src/client/index.ts:86`），owner 恒放行、非 owner 受 remote-access 策略；最稳的是 subject + 自有桥 `status`。
8. 升级：只有 registry 安装的第三方 bundle 才被标 `updatable` 并获得版本/更新 UI（`packages/boot/plugin-manager/src/types.ts:103-107`）；`link:`/git/tarball 无更新入口——Threadloom 当前是 `link:` 安装，D3 要升级必须先发布 npm（npm 最新 0.1.0，仓库 0.1.2）。
9. 兼容：`engines.dsh` 与 peer deps 在启动/安装时校验，不兼容 bundle 会被跳过；slot/Remote 契约不在 engines 校验范围，用 `ctx.slots.inject`（宿主未声明就不触发）做特性探测。
10. 权限边界：安装的 Host 代码在宿主进程内、不受 workspace 沙箱；依赖构建脚本另有 `allowBuilds` 审批；`webServer` 路由无服务器级认证，route owner 自管准入（Threadloom 用 connection 浏览器信任栅栏）。
11. 日志/诊断：profile `.plugin-manager/logs/operation-*`、事件 `plugin-manager/operation|changed|install-log|install-state|update-state`、failed fiber 的 `diagnostic`、启动失败 `~/.dsh/logs/startup-*.log`。日志目录格式不是公开契约，只做入口展示，别解析。
12. 最大开放点：bundle 级 `plugins.bundle.config` 无 form；`plugins.detail.*` 无「打开主面板」API；`engines.dsh` 不锁 slot 契约，需真实 profile 矩阵测试。

## 0. 证据基线

- 版本/进程：`package.json:3` = 0.2.2-alpha.2；`pgrep -af "apps/cli/src/bin.ts web"` → `node --import tsx/esm apps/cli/src/bin.ts web --no-open`（源码即运行版；本次未重启）。
- Web profile：`~/.dsh/profiles/web/package.json` bundles 顺序为 base → web-app → experimental-plugin-market-bundle → subagent-codex → opencode-session → agent-team → **dshmarket 1.73.1** → claude-style → intelligent-ui → dream → **session-butler(link)**。
- 运行配置：`~/.dsh/profiles/web/cordis.patch.yml`（`plugin-market.indexes` 自定义索引、`agent-preset-registry.selectedDefault: ptc` 等）。
- `dsh` 不在 PATH：等价入口为 `pnpm dsh ...` 或 `node --import tsx/esm apps/cli/src/bin.ts ...`（见 §5）。

## 1. A. DSH 插件管理能力全清单

### 1.1 生命周期

| 能力 | 入口 | 机制（含第三方接入方式） | 证据 |
|---|---|---|---|
| 安装 | Plugins 页「添加插件」/ `plugin_manager install_bundle` / `dsh plugin add` | `pnpm add` → 校验 `dsh.bundle` → 追加 `dsh.profile.bundles` 并默认启用；失败恢复 package.json/lock；一次只跑一个安装；构建脚本需 allowBuilds | `packages/client/ui-plugin-manager/README.zh.md:63`；`packages/boot/plugin-manager/README.zh.md:54,72`；`src/index.ts:871` |
| 卸载 | bundle 页确认框 / 工具 / CLI | 取消选择 → 卸载运行时贡献 → `pnpm remove` → 发布 runtime resolution；任一步失败停在失败步骤 | `plugin-manager/README.zh.md:195`；`src/index.ts:1035` |
| 启用/禁用 bundle | bundle 卡片/详情开关 | 改 profile `package.json` 的 `dsh.profile.bundles`（关闭保留依赖；再开追加末尾，可能改变配置优先级） | `plugin-manager/README.zh.md:40`；`src/index.ts:850` |
| 启用/禁用 row | bundle 页组件行开关 | 改 profile `cordis.patch.yml` 中最后一条匹配覆盖的 `disabled`；HMR 下即时重组 | `plugin-manager/README.zh.md:40`；`src/index.ts:832` |
| 升级（随包官方） | bundle 页「更新」/ 版本区块 | 先移除再装当前 DSH 提供的目标；无 HMR 报 `restart-required` | `ui-plugin-manager/README.zh.md:40,69-75`；`plugin-manager/README.zh.md:54,58` |
| 升级（第三方 registry） | bundle 页「版本」区块 | `listVersions` 查新版本 → 确认 → 先移除再装确切版本；仅 `updatable` 包有 | `src/index.ts:662,713`；`types.ts:103-107` |
| 版本豁免 | CLI / `plugin_manager` | 精确 `pkg@ver` ↔ 精确 DSH 版本，写 profile `compatibility.json`；需 `--accept-risk` | `plugin-manager/README.zh.md:79,83`；`apps/cli/src/plugin.ts:22-74` |
| profile/CLI | `dsh plugin --profile <p> <pnpm args>` | 原样转发 pnpm；成功后按 `dsh.bundle` 声明自动维护 bundles 列表；缺 profile 会初始化 | `docs/cli-help.zh.md:63-82`；`apps/cli/reference/README.zh.md:85-87` |

### 1.2 profile / bundle / patch 模型

- profile = `$DSH_HOME/profiles/<name>`，由 `package.json`（`dsh.profile.bundles` 有序列表）与自身 `cordis.patch.yml` 组成；bundle 的 `dsh.bundle.patch` 指向 patch 文件或有序文件列表（`packages/util/package-manifest/README.zh.md:46`）。
- 叠加顺序：各 bundle patch → profile `cordis.patch.yml` → home `$DSH_HOME/cordis.patch.yml` → argv `--patch`；patch 按 id 覆盖**整行 config**（不深合并）（`packages/boot/app-boot/README.zh.md:63,65`；`apps/cli/reference/README.zh.md:13`）。
- 平台与可见性：`dsh.bundle.platforms` 不支持则整层跳过；`dsh.bundle.listedByDefault:false` 控制 GUI 默认隐藏（`package-manifest/README.zh.md:48,55`；`app-boot/README.zh.md:58`）。
- Threadloom 现状对应：`cordis.patch.yml` 插入 row `session-butler`（name 必须是裸包名，否则 Web Client 半侧不会被扫描加载）；`package.json` 的 `dsh.client.platform=web`、`inject:[dsh-client-locale]`。

### 1.3 市场

- 官方实验 bundle `@deepseek-ai/dsh-experimental-plugin-market-bundle`：Host 侧 `plugin-market`（读索引源）+ Client 侧 `ui-plugin-market`（在 Plugins 页注册「发现」tab）。运行 profile 已启用，patch 里配置了索引 URL（`packages/experimental/plugin-market-bundle/cordis.patch.yml`；`docs/user/guide/plugin-market.zh.md:21,30`）。
- 索引是 format 1 JSON（npm/git 来源、`engines.dsh`、图标/标题/描述、分类/标签），安装前确认来源；Creator 获得只读 `plugin_market` 工具（`plugin-market.zh.md:107-137`；`packages/boot/plugin-market/README.zh.md`）。
- 第三方 `dshmarket` 1.73.1（本 profile 已装）：0.2.1+ 在 Plugins 页注册 `plugins.tab`（order -1，紧邻「已安装」）；同时注册 legacy `settings.section`/`settings.plugins.tab` 兼容旧宿主；Web 端安装/更新通过子进程 `dsh plugin`，Desktop 才用 `pluginManager` 服务（`~/.dsh/profiles/web/node_modules/dshmarket/README.md:12,28`；`lib/index.js:175-248`；`client/client.js` 中 `plugins.tab`/`plugins.bundle.config` 注册）。

### 1.4 插件详情页与每插件设置页

- 详情页（bundle/row/官方 item）固定渲染：详细介绍文档（`locale meta.detail` → README；图片走 `GET /api/plugin-manager/detail-file`）、版本/实验/异常标签、rows 列表、版本区块、来源；再叠加贡献 slot（`ui-plugin-manager/README.zh.md:38,79-83,113`）。
- 四个「每插件设置」位置：`plugins.row.config`（行页 + 「配置」入口，**有 form**）、`plugins.bundle.config`（bundle 页内联，**只有 view:'page'，无 form**）、`plugins.item`（官方插件页，官方设置页占用）、`settings.plugins.tab`（内置插件分区 tab）/ `settings.section`（独立设置页）（`packages/client/ui-plugin-manager/src/client/slot-contract.ts:118-168`；`packages/client/ui-settings/src/client/contract/slots.ts:57,66`）。
- form 的来源：页面 owner 对 row/item 调 `formFor(id)`，要求 `ui-settings` 的配置命名空间包含该 id，再经 `ctx.configForms` 生成 `{state, mutate}`（`PluginManagerPage.tsx:1527-1531,1762,1803`；`ui-plugin-manager/README.zh.md:145-151`）。
- Threadloom 当前**未注册任何** settings/plugins slot（grep 空），所以其插件页目前只有基础信息 + row 开关，没有配置入口。

### 1.5 权限与审批

- 安装即信任边界：装好的 Host 代码在宿主进程内运行，**不受 workspace 沙箱限制**（`plugin-manager/README.zh.md:31`）。
- `plugin_manager` 工具：每个动作要求 `danger-full-access` 或本次调用审批；`ask` 下会请求审批，`never`/拒绝/取消/无审批渠道均不执行，批准不改变会话权限模式（`packages/boot/plugin-manager/src/tools.ts:104-111`；base row 默认 disabled，standard/ptc preset 在 `profileContext` 存在时启用：`packages/bundle/web-app/presets/standard.patch.yml:122-125`）。
- 依赖构建脚本：pnpm 11 拦截时报 `pendingBuilds`；Web 页给「允许这些脚本并重试」，授权写 profile `pnpm-workspace.yaml`，本会话内持久；只校验名字不核实对话（`plugin-manager/README.zh.md:72`）。
- Remote ACL：owner 恒放行，非 owner 按 `remoteAccess` 策略逐方法/资源判定；`pluginManager/listBundles` 是插件页入口/导航的权限门（`packages/api/remote-access/README.zh.md:27,33-36`；`ui-plugin-manager/README.zh.md:119`；`ui-plugin-manager/src/client/index.ts:106`）。第三方**不能新增** Typert `@Remote` 命名空间（组合固定：`packages/api/remotes/src/client/index.ts:16,194`；Threadloom 审计结论 `src/host/bridge.ts:3`）。
- HTTP 路由：`webServer` 不提供服务器级认证/来源策略，route owner 负责准入；Threadloom 已用 connection 浏览器信任栅栏（`packages/host/webserver/README.zh.md:61,132`；`src/host/bridge.ts:246-260`）。
- 平台/版本拒绝：`dsh.bundle.platforms` 不支持 → 层跳过；`engines.dsh`/peer 不满足 → 拒绝加载（`app-boot/README.zh.md:52,58`）。

### 1.6 健康、诊断与日志

- `pluginInventory/list`（Remote，只读）：每行 `entryId/moduleName/meta/enabled/fiberPhase(pending|loading|active|failed|unloading|null)/diagnostic`，另含 `managementAvailable` 与 `agentPresets`；即时快照、无历史/订阅（`packages/host/plugin-inventory/src/types.ts:8-28,68-77`；`README.zh.md:12,32,42`）。
- `pluginManager`：`BundleInfo.error/readOnlyReason/rows`、`PluginInfo.readOnlyReason`；事件 `plugin-manager/operation|changed|install-log|install-state|update-state`；`PackageResult.logPath`、`pendingBuilds`（`src/types.ts:39-42,155-184,334-449`；`src/index.ts:1008,1018`）。
- 磁盘日志：profile `.plugin-manager/logs/operation-*`（本机已有 11 份）、`.plugin-manager/run.json`；`@deepseek-ai/dsh-plugin-manager/diagnostic` 给 Desktop/壳读取（`plugin-manager/README.zh.md:128,134,179`）。
- 启动诊断：required 插件失败时 CLI 退出 1，完整报告在 `$DSH_HOME/logs/startup-<timestamp>-<uuid>.log`（`apps/cli/reference/README.zh.md:74-77`）。
- 页面侧口径：row 状态点只表达 fiber 阶段（failed 行不显示原因，原因在 Host 日志）；Settings 的插件清单能看启动失败/禁用条件/预设组合（`ui-plugin-manager/README.zh.md:83`；`ui-settings-plugin-inventory/README.zh.md:36,48`）。

### 1.7 版本兼容

- 校验：有 `engines.dsh` 只由它决定；否则 `peerDependencies` 中 `@deepseek-ai/dsh`/`@deepseek-ai/dsh-*` 全部满足；预发布参与；都不声明则不约束（`app-boot/README.zh.md:52`）。
- 拒绝效果：incompatible bundle 跳过并进 `skippedBundles`；普通 row 变游离 disabled；安装时 registry spec 在 pnpm 前就拒绝，git/tarball 在抓取后回滚（`app-boot/README.zh.md:52`；`plugin-manager/README.zh.md:77`）。
- 精确豁免：profile `compatibility.json`（`pkg@ver` → 精确 DSH 版本列表），插件升级/DSH 升级都不继承；CLI `allow-version/revoke-version/version-exemptions`（`plugin-manager/README.zh.md:79,83`；`apps/cli/src/plugin.ts`）。
- Threadloom：`engines.dsh: >=0.2.1-rc.2 <0.3.0-0`（`package.json:25`），与 0.2.2-alpha.2 兼容；`link:` 依赖 → `updatable=false`。

## 2. B. 第三方插件可注册的扩展点

| 扩展点 | 注册方式 | 契约/字段 | 证据 |
|---|---|---|---|
| Agent tool | `ctx.tools.register(definition)`（官方可用 `defineTool`；第三方可传普通对象） | `name/description/parameters/output/execute`；审批走 `ctx.approval`/sandbox policy | Threadloom `src/host/tools.ts:130-206,574-592`；官方 `plugin-manager/src/tools.ts:86-162` |
| 斜杠命令 | `ctx.commands.register()` | 小写 name、description、input hint、handler；不产生模型消息；记录会话日志 | `packages/interaction/commands/README.zh.md:30-46` |
| Host service | `ctx.provide(name, service)` + 消费者 `inject`/`ctx.get` | Cordis 服务；可选依赖用 getter 晚绑定（Threadloom 范式） | Threadloom `src/index.ts:110-139` |
| HTTP 路由 | `webServer.register({kind:'prefix'|'exact', path, handler})` | 返回 disposer；重复路径抛错；无内建认证 | `packages/host/webserver/README.zh.md:61,63,132`；Threadloom `src/host/bridge.ts:246-260` |
| Client 主/侧栏 slot | `ctx.slots.inject('main'|'sidebar.panellist', () => ctx.slots.register(...))` | keyed `main`、list `sidebar.panellist`；options `id/key/order/label/locale/inject/children` | Threadloom `src/client/index.tsx:63-70` |
| 插件管理页 tab | `plugins.tab` list slot | `label/order`；owner props `install({spec,registry?,title,version})`、`openPackage(name)` | `slot-contract.ts:83-107,124`；`ui-plugin-manager/README.zh.md:117` |
| bundle 配置区 | `plugins.bundle.config` keyed slot | key = bundle 包名；只有 `view:'page'`，无 form | `slot-contract.ts:142`；`PluginManagerPage.tsx:795-801` |
| row 配置页 | `plugins.row.config` keyed slot | key = `<包名>#<row id>`；官方传入 `form`（需 volatile） | `slot-contract.ts:150`；`PluginManagerPage.tsx:687,1762` |
| 详情页贡献 | `plugins.detail.actions/badge/section` list slot | owner props `subject: {kind:'bundle',pkg}|{kind:'row',pkg,row}|{kind:'item',id}`；无话题返回 null | `slot-contract.ts:44-71,156-168` |
| 设置页/分区 | `settings.section`（独立页）/ `settings.plugins.tab`（内置插件分区 tab）/ `settings.general.item`（一行偏好） | `id/order/label`；section 拿 `close()`；tab 无 owner props | `packages/client/ui-settings/src/client/contract/slots.ts:57,66,92` |
| Settings schema | Schemastery `Config` + `.volatile()` + `ctx.settings.configure({auto:false})` | 表单按 profile 条目 id；只投影 volatile 字段；保存经 config-editor 写 profile patch | `packages/settings/settings/README.zh.md:12,33,37-39`；`docs/subsystems/settings.zh.md:5,9,39` |
| 客户端设置表单 | `ctx.configForms.get(entryId)` / props `form: {state, mutate}` | `state` 含 value/base/user/revision/writable；`mutate(ops, expectedRevision)` 原子写 | `ui-settings/README.zh.md:32-40`；`slot-contract.ts:172-178` |
| Locale | `ctx.locale.register(ns, {zh,en,...})` 或 `(ns, lang, dict)`；`bind(ns)` | 需 zh+en 完整；slot 的 `locale` 让注入 `t` 跟随语言 | `packages/client/locale/README.zh.md:40,44,48-66`；Threadloom `src/client/index.tsx:45-47` |
| 展示元信息 | `package.json.icon` 或 `exports "./icon"`；`locale/*.json` 的 `meta.title/description/detail` | 图标 ≤256KiB、详情图 ≤5MiB；子路径插件不读 package.json | `docs/cookbook/adding-a-package.zh.md:112-156`；`plugin-manager/README.zh.md:100-103` |
| Remote | 第三方不能新增命名空间；可消费 DSH 已有 `remote.<ns>`（如 `remote.pluginInventory`、`remote.pluginManager`） | 需 client 包 inject；owner 恒放行，非 owner 走 remoteAccess | `packages/api/remotes/src/client/index.ts:16,194`；`ui-plugin-manager/src/client/index.ts:86` |

关键约束：
- Client 半侧必须是 `dsh.client.platform=web` + `exports["./client"]` 的经典脚本 factory；React/`ui-slots`/`ui-primitives` 等在模块表内（Threadloom `scripts/build-client.mjs` 的 `PLATFORM_SEED`；`packages/client/web/src/platform.ts:8-22`）。
- `ctx.slots.inject(name, cb)` 在宿主未声明该 slot 时**只等待、不抛错**——可用作版本特性探测；`register` 的 slot 必须由宿主声明。（Threadloom 两个 owner 分别注入的经验：`src/client/index.tsx:59-70`；`ui-settings-plugin-inventory/README.zh.md:62`）
- 插件配置：`plugins.*` 放侧栏 Plugins 页；`settings.plugins.tab` 只属于「内置插件」分区；`settings.section` 用于功能设置页。三者不要重复挂同一组设置。

## 3. C. Threadloom D3 如何结合插件管理 feature

### 3.1 对 D3 设计的校准

- `docs/d3-console-design.md:228` 的「注册 `settings.plugins.tab`」改为：**不注册**该 slot；改用 §3.4 的 `plugins.row.config`/`plugins.bundle.config`/`plugins.detail.*`。理由见 TL;DR #4。
- `docs/d3-console-design.md:240` 的「配置写入路径」结论：**有运行时写配置**，路径 = volatile Config + `plugins.row.config` 的 `form.mutate`（经 config-editor 写 profile patch）；不需要自建第二套配置源，也不需要「复制 patch 片段」兜底（只读展示可保留给高风险项）。
- **Q1 `settings.plugins.tab` vs `settings.section`**：前者注册后只是「内置插件」分区里多一个 tab（现只有只读清单 id=`all`），没有按插件身份过滤的风险，但语义是「内置插件」、与配置职责错位，且该分区在旧/非 web 组合可能缺席；后者注册 Settings 导航页，未知 id 用兜底齿轮图标、不会静默过滤，拿 `close()`。若二选一选 `settings.section`，但两者都不如 §3.4 的 `plugins.*` 方案。
- `docs/d3-console-design.md:291` 的「`settings.plugins.tab` 稳定性」问题消解：该 slot 不是我们的入口；新入口的稳定性用 `ctx.slots.inject` 天然兜底。
- `docs/d3-console-design.md:269` 的「新增 `settings.plugins.tab` 页面」改为「新增 `plugins.row.config` 设置页 + `plugins.bundle.config` 状态区」。

### 3.2 插件页展示什么

| 区块 | 内容 | 数据来源 |
|---|---|---|
| 基础信息 | Threadloom / `dsh-session-butler`、版本、描述、图标、详细介绍 `docs/usage.md` | 已具备：`package.json` icon、`locale/*.json meta`（title/description/detail）；DSH 自动渲染 |
| 开关/卸载 | bundle 开关、row 开关、卸载确认 | DSH 自动（bundle 页头/rows）；`main` 面板已注册独立于插件页 |
| 版本/升级 | 版本标签；registry 安装时才有版本区块 | 需先发布 npm；`link:` 安装无此区块 |
| 健康徽标 | `healthy|degraded|unavailable` + 一句话原因 | 自有桥 `status`（扩展字段见 §3.5），挂在 `plugins.detail.badge` |
| 诊断/统计区 | 桥/路由状态、trash 计数、会话总数、最近错误码、复制复现命令 | `plugins.bundle.config` + `plugins.detail.section`（`subject.pkg` 只给 name/version/installed/enabled/rows） |
| 配置入口 | 保留期/级联/永久删除/live settle/入口开关 | `plugins.row.config` 行页 form |
| 兼容提示 | 当前 DSH 版本与 `engines.dsh` 是否满足 | 桥 `status` 返回 `dshVersion` + 插件版本 |

**Q3 failed/diagnostic 的展示与第三方贡献**：DSH 侧——bundle 页显示 problem 标签 + 原因行（`PluginManagerPage.tsx:782,791`）、row 页显示 `RuntimeError(row.diagnostic)`（同一文件 `:685`）、行状态点把 failed 映射为 error 且不显示原因（`ui-plugin-manager/README.zh.md:83`）；失败原因还可从 `pluginInventory/list` 的 `diagnostic` 读取。第三方侧——可以贡献健康信息：`plugins.detail.badge`（标题旁状态标签）与 `plugins.detail.section`（页面底部自绘区块），但 owner props 只有 `subject` 的 bundle/row 事实（无 fiberPhase/diagnostic），所以健康值来自我们自己的桥快照，或可选读 `remote.pluginInventory`。

### 3.3 设置项与写入路径

| 设置项 | 类型/默认 | 现状 | 建议 |
|---|---|---|---|
| `trashRetentionDays` | number, 30 | 已存在（`config.ts:38`），仅 profile patch 可改 | 标 `.volatile()` 进表单 |
| `cascadeSubagents` | boolean, true | 已存在 | 同上 |
| `permanentDelete` | 'disabled'|'confirm', disabled | 已存在；服务端双重要求（`service.ts:631-639`） | 同上；表单用说明文案强调风险 |
| `liveSettleTimeoutMs` | number, 3000 | **仅内部 option**，Host 入口未透传（`service.ts:53-55,704`；`src/index.ts:95-108`） | 新增 Config 字段并传入 service |
| `panelEntryEnabled` | boolean, true | 无；侧栏入口当前恒定注册 | 新增字段，client `apply` 用它决定是否注册 `sidebar.panellist` |
| `trashSweepOnStart`（可选） | boolean | 无 | P1，谨慎：会写盘 |

写入路径（推荐）：`Config` 字段 `.volatile()` → `ui-settings` 为 entry id `session-butler` 提供表单 → Plugins 页 row 页把 `form` 传给我们 → 我们渲染字段并 `form.mutate([{path, value}], state.revision)` → config-editor 写 profile `cordis.patch.yml` → Loader 热应用（不重挂插件）。**不要**为写入新建 HTTP 接口或第二份配置。

**Q2 自动表单在哪里 / 如何关掉**：`settings.describe` 与 settings-controller 只返回 `{autoGenerate, schema, value, base?, user?, revision, applies:'live'}`（`packages/api/settings-controller/src/index.ts:51-58`；`packages/settings/settings/src/types.ts:24`），官方说明 `autoGenerate` 默认 true「供按 schema 生成页面的客户端使用，目前没有已发布的客户端这样做」（`packages/settings/settings/README.zh.md:39`）；Plugins 页只在注册了 `plugins.row.config` 的行上显示「配置」（`PluginManagerPage.tsx:323-325,1603,1762`）。`ctx.settings.configure({ auto: false }, ctx.fiber)` 只是把 descriptor 的 `autoGenerate` 翻成 false 的**页面策略标记**（`settings/src/index.ts:225`；`docs/subsystems/settings.zh.md:39`），不生成也不挂载表单——自带页面的插件用它声明「不要自动页」，第三方仍须自己画字段。

### 3.4 slot 注册清单与示例

| slot | key/id | 用途 | owner props 可用字段 |
|---|---|---|---|
| `plugins.row.config` | key `dsh-session-butler#session-butler` | 行「配置」页：显示/编辑 Config | `view`、`form?: {state, mutate}` |
| `plugins.bundle.config` | key `dsh-session-butler` | bundle 页内联状态/统计区 | 仅 `view:'page'`（无 form） |
| `plugins.detail.badge` | id `threadloom-health` | bundle 页标题旁的绿/黄/红徽标 | `subject`（`pkg.name` 判别自己） |
| `plugins.detail.section` | id `threadloom-diagnostics` | bundle 页底部诊断区（桥/存储/最近错误） | `subject` |
| `settings.section`（可选） | id `threadloom`，order 自定 | 仅当 D3 要独立设置导航页时；与 row 页二选一 | `close()` |
| `plugins.tab`（不建议） | — | 会把「会话库」塞进插件页，重复主面板 | `install`/`openPackage` |

```tsx
// Threadloom client apply 内；props 为 DSH 注入的 slot props（含 locale 注入的 t）
ctx.slots.inject('plugins.row.config', () => ctx.slots.register(
  { name: 'plugins.row.config', key: 'dsh-session-butler#session-butler', locale: NS },
  (props) => props.view === 'summary' ? null : <ThreadloomConfigForm form={props.form} t={t} />,
))
ctx.slots.inject('plugins.detail.section', () => ctx.slots.register(
  { name: 'plugins.detail.section', id: 'threadloom-diagnostics', locale: NS },
  ({ subject }) => subject.kind === 'bundle' && subject.pkg.name === 'dsh-session-butler'
    ? <ThreadloomHealthSection pkg={subject.pkg} t={t} /> : null,
))
```

注意：slot props 是结构化契约，Threadloom 现有 `src/client/contract.ts` 不含 `plugins.*`/`form` 类型，需要补最小结构类型（保持「不运行时 import DSH 包」的既有策略）。

### 3.5 桥/路由健康

- 扩展现有 `status`（当前返回 `retentionDays/cascadeSubagents/permanentDelete/workspaceAvailable`，`src/client/contract.ts:76-82`）：`{ ok, version, dshVersion, host:{ ok, error? }, bridge:{ ok, mounted, lastError? }, storage:{ trashWritable, sessionsRootWritable }, backends:{ sessionQuery, workspaceRegistry, sessionController, tools, commands }, counts:{ trash, sessions }, errors: [{code,at,count}] }`。
- 展示：主面板 Overview 与插件页 `plugins.bundle.config` 共用同一快照；黄/红时给「复制诊断」与修复建议（`session-running`、`session-locked`、`permanent-delete-disabled`、`trash-missing`）。
- 组合降级：无 `webServer`/`connection` 时桥不挂载（`src/host/bridge.ts:246-252`），插件页显示「当前组合仅命令/工具可用」，不报红；headless/ACP 组合即此类。
- 是否读取 DSH 的 `pluginInventory`：可选。注入 `remote.pluginInventory` 后再读 row fiberPhase/diagnostic，能得到「Threadloom row 是否 failed」；但非 owner/无权限页面会拒绝，必须可在失败时降级到自有 `status`。

### 3.6 安装与兼容策略

- 发布：npm 发布 `dsh-session-butler`（0.1.2 待发布；0.1.0 已在 npm），README 写 `dsh plugin --profile web add dsh-session-butler`；DSH 自动识别 `dsh.bundle` 并加入层栈。发布后 bundle 页才有可升级语义（`updatable`），link 安装没有。
- 元数据：已有 `icon`/`locale meta`/`meta.detail`/`keywords`；市场（官方索引格式/第三方 dshmarket）都按包名+npm 元数据展示，无需额外字段。
- 兼容探测：新增 slot 一律 `ctx.slots.inject`（宿主未声明则跳过）；可选 Host 服务用 `ctx.get`/`ctx.inject`（Threadloom 已用此模式）；`engines.dsh` 保持 `>=0.2.1-rc.2 <0.3.0-0`，若使用 0.2.2 才有的 slot 不必抬高下限（inject 会静默等待），但发布说明应写「插件管理页配置区需 0.2.2+」。
- 升级引导：不在插件内做自我更新（运行中移除/替换自身风险高，官方也无自更新入口）；插件页/README 指向 Plugins 页「版本」区块，link 安装用户用 CLI 重装。
- 测试矩阵：0.2.1-rc.2（无新 slot，降级正常）与 0.2.2-alpha.2（完整）；有/无 `ui-settings`；headless profile（仅命令/工具）；非 owner 页面（liveshare）不暴露写操作。

### 3.7 可直接进设计的接口/字段清单

| 接口 | 形态 | 说明 |
|---|---|---|
| `POST /session-butler/api/status` | JSON，见 §3.5 字段 | 插件页健康区与主面板共用 |
| `POST /session-butler/api/list` / `detail` / `trash` / `trash-many` / `restore` / `restore-many` / `purge` / `list-trash` | 现有（`bridge.ts:33`） | 保持 `{ok:true,value}|{ok:false,error}` 信封 |
| Config 字段 | `trashRetentionDays`、`cascadeSubagents`、`permanentDelete`、`liveSettleTimeoutMs`、`panelEntryEnabled` | 全部 volatile；默认值保守 |
| slot 注册 | §3.4 四项（+可选 settings.section） | 全部 `ctx.slots.inject`；key 与 row id/包名严格一致 |
| Host 探测 | `webServer`、`connection`、`sessionQuery`、`sessionPersistence`、`sessions`、`agents`、`workspaceRegistry`、`tools`、`commands`、`sessionController` | 已有 getter 晚绑定模式 |
| 事件/订阅 | `plugin-manager/changed`（bundle/row 变更后刷新插件页数据）；`settings/document-updated`（表单失效重读） | 可选；失败时轮询/重开页面兜底 |
| 用户文档 | README「安装/升级/配置」三节 + `docs/usage.md` | 插件页详情文档会直接渲染 usage |

## 4. 开放问题

1. **row config form 的成立条件**：需同时满足 volatile 字段 + `ui-settings` 已挂载；需在真实 0.2.2 profile 实测「配置」入口出现、保存后 profile patch 变化且不重挂插件。
2. **第三方 client 读取 `remote.pluginManager/pluginInventory` 的实际权限**：owner 页面理论恒放行，但组合/ACL 是否对第三方命名空间调用放行未实测；建议设计成可选增强，失败即降级。
3. **从 `plugins.detail.actions` 打开 Threadloom 主面板**没有通用 API（`pluginNavigation` 只服务插件页自身导航）；若必须一键跳转，需要 DSH 上游能力或放弃该动作。
4. **`plugins.bundle.config` 无 form**：若 D3 想在 bundle 页直接编辑设置，只能走 row 页或自行 inject `configForms`；后者会多一条与 ui-settings 的耦合。
5. **升级体验**：Threadloom 从 `link:` 切到 registry 安装后，`updatable` 才成立；需要验证 remove+install 更新对运行中 client 半侧/主面板的影响与失败回滚文案。
6. **slot 契约稳定性**：`plugins.*` 在 0.2.2 已存在但不在 `engines.dsh` 的语义里；未来改名/调整 owner props 需要重新审计（建议每次 DSH 升级跑一次 §5 的 grep + 浏览器实测）。
7. **自更新/自卸载边界**：插件管理服务不允许管理「插件管理自身」的组件（`management-required`），但 Threadloom 作为普通 bundle 可被卸载；是否需要「移除前提示回收站数据仍在」的文案待定。
8. **诊断日志格式**：`.plugin-manager/logs` 非公开契约；插件页只应展示路径/引导用户提供，不应解析。
9. **dshmarket 与官方 Discover 并存**：`plugins.tab` 的 order 由注册方决定（dshmarket 用 -1）；若未来两者都装，tab 顺序可能变化，不依赖固定顺序。

## 5. 复现命令

```bash
# 运行版与进程（只读；不要 restart/kill）
node -e "console.log(require('/home/leoric/code/deepseek-harness/package.json').version)"   # 0.2.2-alpha.2
pgrep -af "apps/cli/src/bin.ts web"                                                        # 源码即运行版
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:3080/                            # 401 = token 保护

# profile 现状（只读；禁止改写）
cat ~/.dsh/profiles/web/package.json
sed -n '1,90p' ~/.dsh/profiles/web/cordis.patch.yml
ls ~/.dsh/profiles/web/.plugin-manager/logs | head

# 能力证据（在 DSH checkout 内执行）
rg -n "name: 'plugins\.(item|tab|bundle\.config|row\.config|detail\.(actions|badge|section))'" packages/client/ui-plugin-manager/src/client/slot-contract.ts
rg -n "settings\.section|settings\.plugins\.tab" packages/client/ui-settings/src/client/contract/slots.ts
rg -n "volatile|configure\(" docs/subsystems/settings.zh.md packages/settings/settings/README.zh.md
rg -n "volatile\(\)" packages/web/web-search-deepseek/src/index.ts | head
rg -n "plugins\.tab|settings\.plugins\.tab|plugins\.bundle\.config" ~/.dsh/profiles/web/node_modules/dshmarket/README.md
rg -n "plugins\.tab|plugins\.bundle\.config" ~/.dsh/profiles/web/node_modules/dshmarket/client/client.js        # 压缩单文件，按字符串定位

# 只读 CLI（不启动服务、不改配置；dsh 不在 PATH，用 pnpm 脚本）
cd /home/leoric/code/deepseek-harness
pnpm dsh --profile web --dump-config | head -60          # 只打印已组合配置树
pnpm dsh plugin --profile web version-exemptions         # 只打印豁免 JSON
```

## 6. 参考

- DSH：`packages/boot/plugin-manager/README.zh.md`、`packages/client/ui-plugin-manager/README.zh.md` + `src/client/slot-contract.ts`、`packages/client/ui-settings-plugins/README.zh.md`、`packages/host/plugin-inventory/{README.zh.md,src/types.ts}`、`packages/boot/app-boot/README.zh.md`、`packages/util/package-manifest/README.zh.md`。
- DSH 设置/权限：`docs/subsystems/settings.zh.md`、`packages/settings/settings/README.zh.md`、`packages/api/settings-controller/src/index.ts`、`packages/api/remote-access/README.zh.md`、`packages/host/webserver/README.zh.md`。
- 市场：`docs/user/guide/plugin-market.zh.md`、`packages/experimental/plugin-market-bundle/`、`~/.dsh/profiles/web/node_modules/dshmarket/`。
- 本仓库：`docs/d3-console-design.md` §8/§9.2/§11、`docs/dsh-packaging-contract.md`、`src/config.ts`、`src/host/bridge.ts`。
