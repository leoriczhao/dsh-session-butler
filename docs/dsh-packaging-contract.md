# DSH npm 插件包发布契约（Threadloom 打包调研）

> 范围：把一个 DSH 插件（Host 半 + Web Client 半 + agent tools / chat commands）做成可从 npm registry 安装的 bundle 包。
> 基准运行时：**DSH 0.2.1-rc.3**（本机安装锚点 `~/.dsh/profiles/node_modules/@deepseek-ai/dsh-app-boot/package.json` 的 `version`，即 `getDshRuntimeVersion()` 读取的值）。
> 调研基准：DSH 源码 checkout `/home/leoric/code/deepseek-harness`（下文简称 **`DSH/`**）；已发布的真实插件在 `~/.dsh/profiles/web/node_modules/*`。
> 引用格式：`路径:行号`（只写仓库内相对路径）。所有规则都是对 0.2.1-rc.3 源码的实测阅读，不是猜测。

---

## 0. TL;DR（先读这段）

1. **包形态**：DSH 插件 = 普通 npm 包 + 一个 `dsh` 元数据块。三类声明缺一不可：
   - `dsh.bundle.patch`：一个（或有序多个）Cordis patch YAML 文件，安装后把插件行插入 profile 组合（`DSH/packages/util/package-manifest/src/types.ts:71-76`）。
   - `dsh.client`：可选；声明后 Web 端从 `exports["./client"]` 取浏览器 bundle（`DSH/packages/client/modules/src/index.ts:889-916`）。
   - Host 入口：ESM 模块，导出 `apply(ctx, config)`（可带 `inject`/`Config`）或默认 Service class（`references/host-plugin.md:57-64`）。
2. **兼容性只看顶层 `engines.dsh`**。`dsh.engines.dsh` **不会被读取**（已发布的 dsh-claude-style 就是反例）。`engines.dsh` 存在时它单独决定；不存在时改为把每个 `@deepseek-ai/dsh*` peer 范围与**当前运行中的 DSH 版本**比较（不是与该 peer 包自身版本比较）（`DSH/packages/boot/app-boot/src/plugin-compatibility.ts:55-74, 87-102`）。
3. **Client 半必须是 classic script**（`<script src>` 加载），内容是 `window.__ModuleLoader__.load({ id: "<包名>", factory: (require) => { ... return module.exports } })` 的闭包工厂；不是 ESM、不能有顶层 `import/export/await`。模块 id 必须等于包名（`DSH/packages/client/modules/src/client/system.ts:166-180, 209-247`）。
4. **React / React DOM / jsx-runtime 等 11 个 specifier 必须 external**（浏览器模块表 seed），否则双 React 实例必然崩 hooks（`DSH/packages/client/web/src/platform.ts:8-19`、`DSH/packages/client/web/src/seed.ts:26-42`）。
5. **`files` 决定发布内容、`exports` 决定运行时可解析性**；两者必须把 patch、client bundle、locale、icon、README/detail 全部包住。`files` 对本地 `link:` 安装不过滤，所以**只有 `npm pack` 的产物清单能证明发布后可运行**（`references/host-plugin.md:35`）。
6. 发布走 npm 最省事：`prepack` 自动构建，用户 `dsh plugin add <name>` / `plugin_manager install_bundle` 装的是预构建产物，不需要 build-script 审批；git 安装才需要 `prepare` + `allowBuilds`（`DSH/docs/user/develop/basic/publish.md:161-186`）。
7. 我们自己（Threadloom）落点：包名 `dsh-session-butler`、`dsh.bundle.patch: "./cordis.patch.yml"`、`dsh.client: { platform: "web", inject: ["@deepseek-ai/dsh-client-locale"] }`（UI 挂载点确定后再补对应提供方包）、顶层 `engines.dsh: ">=0.2.1-rc.3 <0.3.0"`、Host ESM 产物 `lib/index.js` + Client classic-script 产物 `lib/client.js`。

---

## 1. 概念与安装生命周期

### 1.1 bundle / profile / patch 行

| 概念 | 由谁声明 | 作用 |
|---|---|---|
| **bundle** | npm 包 `package.json.dsh.bundle` | 贡献一个 Cordis patch 层（可插入/覆盖插件行）。用户安装的是它。 |
| **profile** | `$DSH_HOME/profiles/<name>/package.json` 的 `dsh.profile.bundles` | 有序组合哪些 bundle；profile 目录还有 `cordis.patch.yml`（用户自己的层）。 |
| **plugin row** | patch YAML 的 `insert` / 覆盖项 | Loader 真正 mount 的一行：`id`/`name`/`config`/`disabled`/…。 |

来源：`DSH/packages/boot/app-boot/README.md:50-54`、`DSH/docs/user/develop/basic/publish.md:13-16`。

**层序**（后面的层按行覆盖前面；`config` 是整体替换，不深合并）：
1. profile 的 `dsh.profile.bundles` 里各 bundle 的 patch，按列表顺序；
2. profile 自己的 `cordis.patch.yml`；
3. `$DSH_HOME/cordis.patch.yml`（所有 profile 共享）；
4. 每次启动的 `--patch <path>`，按 argv 顺序。
（`DSH/docs/user/develop/basic/publish.md:120-136`、`DSH/packages/boot/app-boot/README.md:61`）

含义：我们的 patch 可以直接覆盖 `dsh-base`/`dsh-web-app` 的行（按 `id`），但**必须把该行需要的字段全部重述**；同时用户可以在 profile patch 里覆盖我们，所以默认值要选用户大概率会保留的值。

### 1.2 安装链路（两个入口，同一套 operations）

| 入口 | 行为 |
|---|---|
| CLI `dsh plugin --profile <p> add <spec>` | 转发给 profile 目录里的 pnpm；成功后把声明了 `dsh.bundle` 的依赖**追加**到 `dsh.profile.bundles` 末尾（`DSH/packages/boot/plugin-manager/src/operations.ts:89-114`）。没有 `dsh.bundle` 的包会 `warning: … declares no dsh.bundle — installed as a plain dependency`。 |
| Agent tool `plugin_manager` / Web 插件页 `installBundle(spec, options)` | 先做 spec 解析、registry 检查、兼容性检查，再 `pnpm add`（可选 `--save-exact`），随后**再次校验** manifest/patch、选择 bundle、发布 runtime resolution 并 reload（`DSH/packages/boot/plugin-manager/src/index.ts:835-965`）。 |

失败语义：`pnpm` 成功但 bundle 校验失败时，恢复 `package.json` 与 `pnpm-lock.yaml`，报告安装失败；安装成功之后的“发布/启用”失败**不会**回滚已安装依赖（`DSH/packages/boot/plugin-manager/README.md:184-191`）。

---

## 2. `package.json` 清单契约

### 2.1 字段总表

`DSH/packages/util/package-manifest/src/types.ts:8-41` 是 DSH 读取的字段集合（“selected npm field set”，不是完整 npm schema）：

| 字段 | 必要? | 读取方 / 规则 |
|---|---|---|
| `name` | **必须** | 包身份 = Client module id = bundle 选择名。必须是 registry 可接受的包名（小写、URL-safe、可带 scope；`DSH/packages/boot/plugin-manager/src/install-spec.ts:31-33`）。 |
| `version` | **必须** | 必须能被 `semver.valid()` 解析；市场/更新检查都用它（`plugin-manager/src/versions.ts:38-57, 66-79`）。 |
| `type` | 建议 **`"module"`** | Host 入口按 ESM 加载；没有它 `.js` 会被当 CJS，`export function apply` 无法存在。已发布插件全部 `"type": "module"`。 |
| `main` / `exports` | **必须二选一（推荐都写）** | Loader 通过 Node exports 解析包根；`exports["."]` 是 Host 入口。详见 §2.4。 |
| `types` | 可选（建议） | 例如 `"lib/types/index.d.ts"`；同时写 `exports["."].types`。运行时不读，纯 TS 体验。 |
| `description` | 建议 | ① bundle 列表的 `description`（`plugin-manager/src/index.ts:528-530`）；② locale 元数据的 description fallback（`app-boot/src/package-meta.ts:183-184`）；③ npm Install 视图读 registry 上的 description。 |
| `icon` | 可选 | 显示图标（相对 manifest 目录；SVG/PNG/JPEG/WebP ≤256 KiB，且 realpath 后不得逃出包目录）（`app-boot/src/package-meta.ts:22-55`）。 |
| `private` | **发布时不要写** | `true` 会阻止 npm 发布；本地目录 bundle 可保持 `private: true`（模板如此）。Official 目录专有安装会拒绝 private（`plugin-manager/src/official-install-target.ts:45`）。 |
| `dependencies` | 按需 | 运行时 npm 依赖。注意 Host 价值导入若需与宿主共享身份，应放 peers（见 §2.3）。 |
| `peerDependencies` | 按需 | 见 §2.3；`@deepseek-ai/dsh*` peers 参与兼容性检查，其余 peer 名不参与。 |
| `engines` | **强烈建议** | 顶层 `engines.dsh` 是唯一被读的 DSH 兼容声明（见 §2.3）。`engines.node` 仅 npm 侧提示。 |
| `dsh` | **bundle 必须** | 见 §2.2。 |
| `license` / `author` / `repository` / `homepage` / `bugs` / `keywords` | 建议 | `author`/`homepage`/`repository`/`keywords` 会被未来市场索引生成器使用（`.agents/notes/implemented/feature/2026-10-02-plugin-market-index-format.md:162-172`）；其余为 npm 规范字段。 |

### 2.2 `dsh` 键的精确形状

```ts
// DSH/packages/util/package-manifest/src/types.ts:32-41
interface DshManifest {
  manifestVersion?: 1        // 声明格式版本；当前无读取方、无强制（:34，grep 仅类型定义）
  bundle?: DshBundleManifest // 本文 §2.2.1
  profile?: DshProfileManifest // 只属于 profile 目录，插件包不要声明
  client?: DshClientManifest // 本文 §4.2
}
```

#### 2.2.1 `dsh.bundle`

```ts
// DSH/packages/util/package-manifest/src/types.ts:71-76
interface DshBundleManifest {
  patch: string | string[]   // 一个文件路径，或“按序应用”的文件列表（相对包根）
  listedByDefault?: boolean  // GUI 列表里是否默认显示；省略 = true
}
```

- **string vs array**：两者等价于“一个层”；array 会按顺序拼接各文件的 patch 列表（`DSH/packages/boot/app-boot/src/profile.ts:46-70` 的 `bundlePatchFiles` / `bundlePatchPaths`；`DSH/packages/boot/app-boot/README.md:50`）。真实例子：dsh-intelligent-ui 用 `["./cordis.patch.yml", "./presets/cordis.patch.yml"]`（`~/.dsh/profiles/web/node_modules/dsh-intelligent-ui/package.json:65-71`），其余三个示例包用单字符串。
- **相对谁**：每个路径相对“声明它的 package 根”（`profile.ts:68-70`）；array 里每个文件自己的相对 `./` 行名要锚定在**该文件所在目录**（`app-boot/README.md:65`）。
- **非法形状**：不是 string 也不是 string[] → `dsh.bundle.patch must be a file path or a list of file paths`（`profile.ts:53-58`）。
- **`listedByDefault`**：非 boolean 会让该 bundle 以 error 形式列出（`plugin-manager/src/index.ts:519-523`）；它只影响 GUI 列表显示，不影响选择/激活（`plugin-manager/README.md:42`）。新插件省略即可。

#### 2.2.2 `dsh.client`（详见 §4）

```ts
// DSH/packages/util/package-manifest/src/types.ts:84-98
interface DshClientManifest {
  platform: string        // 必填；Web 消费者只接受 "web"，其余值整包跳过（index.ts:899-903）
  inject?: string[]       // 信息性 package-name 边：factory 到达顺序 + HMR 比对；不是 Cordis 服务注入
  immediately?: boolean   // 只给 stage-one 基建行；普通功能插件省略（= application batch）
  external?: string[]     // 精确的非 baseline 模块表请求（含 <pkg>/client 这类子路径）
}
```

校验实现：`DSH/packages/client/modules/src/client/manifest.ts:156-193`（`parseDshClient`）。畸形声明在 activation 阶段抛 AggregateError，直接让 `modules` fiber FAILED。

### 2.3 DSH 版本兼容：`engines.dsh`、peerDependencies、例外授权

**唯一规范（源码即行为）**，`DSH/packages/boot/app-boot/src/plugin-compatibility.ts`：

```
运行时版本 = app-boot 包 package.json 的 version        // :44-49（0.2.1-rc.3）
satisfies(runtime, range) = range.trim() !== '' && semver.satisfies(runtime, range, { includePrerelease: true })  // :51-53
unmet:
  若 manifest.engines 有 own 的 "dsh"（string 才合法）：
      range 不满足 → { 'engines.dsh': range }；peerDependencies 全部忽略   // :55-61
  否则遍历 peerDependencies 中 name === '@deepseek-ai/dsh' 或以 '@deepseek-ai/dsh-' 开头的项：
      范围与该“运行中的 DSH 版本”比较；workspace:^ / workspace:~ / workspace:* 视为当前 runtime（仅 peers 合法）
      其它空/非法范围、以及 engines.dsh 里的 workspace: 一律视为不满足               // :62-74
  畸形 engines（非对象）或 engines.dsh（非 string）→ 抛错（manifest 畸形）           // :56-59
```

要点与坑：

1. **`dsh.engines.dsh` 不会被读**。`DSH/.agents/notes/implemented/architecture/2026-09-10-public-package-manifest.md:25` 明确选择“顶层 `engines.dsh`”。反例：`~/.dsh/profiles/web/node_modules/dsh-claude-style/package.json:39-49` 把 `engines.dsh` 写在 `dsh` 下——该声明实际休眠，该包能通过检查只是因为它的 `@deepseek-ai/dsh-client-ui-primitives: ">=0.1.5-rc.1"` peer 恰好也接受 0.2.1-rc.3。
2. **所有 `@deepseek-ai/dsh*` peer 都拿“运行中的 DSH 版本”比较**，不是拿那个包自己的版本比较。所以写 `"@deepseek-ai/dsh-client-ui-primitives": "0.2.1-alpha.1"` 这种“按依赖包版本写的精确 peer”会误判。要么写覆盖运行版本的宽范围（如 `>=0.1.5-rc.1`），要么**优先写顶层 `engines.dsh` 让它独占判定**。
3. **`@deepseek-ai/cordis`、`@deepseek-ai/schemastery`、`react` 等 peer 不参与兼容检查**（名字不以 `@deepseek-ai/dsh` 开头）。它们只影响 npm/pnpm 的 peer 解析。
4. **prerelease 参与匹配**：`includePrerelease: true` 意味着像 `>=0.2.1-rc.3 <0.3.0` 也能接受 `0.3.0-rc.1`（rc 小于正式 0.3.0）。如果想“只锁 0.2.x”，用 `>=0.2.1-rc.3 <0.3.0-0` 或精确版本。
5. 当前可用的建议范围：`"engines": { "dsh": ">=0.2.1-rc.3 <0.3.0" }`（经本机 semver 实测 0.2.1-rc.3 满足）。
6. **检查点**：安装前（本地路径/registry spec 通过 `inspect`/`pnpm view` 读 manifest）、安装后（`index.ts:938-939`）、profile 启动加载 bundle 层时（`app-boot/README.md:52,54`）、版本列表（`index.ts:643-649`）、市场条目（`plugin-market/src/index.ts:512`）。git/tarball spec 只能在安装后判（`plugin-manager/README.md:75`）。
7. **版本例外（exemption）**：只存在于 profile 的 `compatibility.json`，键是精确 `name@version` → 允许的精确 DSH 版本列表；升级插件或升级 DSH 都不继承。拒绝时可用 `plugin_manager` 的 `list_version_exemptions`/`set_version_exemption`（`acceptRisk: true`）或 CLI `dsh plugin --profile <p> allow-version …`（`plugin-manager/README.md:76-81`、`tools.ts:113-120`）。它不能把缺失/非法声明变合法，也不进市场索引。

### 2.4 `exports` / `files`：发布闭包

**最小可用（Host-only 插件，dsh-opencode-session 的写法）**
```json
"main": "lib/index.js",
"exports": { ".": "./lib/index.js" },
"files": ["lib", "cordis.patch.yml", "README.md"]
```
（`~/.dsh/profiles/web/node_modules/dsh-opencode-session/package.json:6-14`）

**带 Web Client + 展示元数据的完整写法（推荐，照抄 dshmarket / dsh-claude-style）**

| export 子路径 | 用途 | 缺失后果 |
|---|---|---|
| `"."` | Host 入口（`{ types, default }` 或字符串） | Loader import 失败 |
| `"./client"` | Client bundle 文件（**必须**；值是 string，或 `{ default: string }`） | 声明了 `dsh.client` 却缺它 → 启动期抛 `declares dsh.client but exports no "./client" bundle`（`client/modules/src/index.ts:904-907`；`clientExportOf` 只认 `default` 键，`import` 条件键不读，见 `index.ts:201-212`） |
| `"./package.json"` | 展示元数据 fallback：title 用 `name`、description 用 `description`、`icon` 字段解析 | 失去 name/description/`icon` 字段 fallback；有 locale 文案但缺 en 时，`en` 会退化成**完整 Cordis specifier**，否则 title/description 可能整体缺失（GUI 回退显示 bundle 名）（`app-boot/src/package-meta.ts:147-156, 179-184`） |
| `"./locale/*.json"` | locale 文案发现（`en.json` 为入口） | 无本地化标题/描述；manifest 字段 fallback 还依赖 `./package.json` 导出 |
| `"./icon"` | 图标 fallback（顶层 `icon` 字段优先） | 无图标 → 面板默认图 |
| `"./assets/*": "./lib/assets/*"` | 只有用到构建期图片资源时才需要（`packages/client/AGENTS.md:9`；常量见 `client/modules/src/assets.ts:14-31`） | 图片 404 |

`files` 要点：
- 必须覆盖**所有运行时相对路径**：Host 产物（`lib`）、patch YAML、client bundle（含 map 可选）、locale、icon、README/detail 文档及图片、LICENSE（`packages/client/AGENTS.md:71`）。
- **`files` 不适用于本地 `link:` 安装**（`references/host-plugin.md:35`）；本地测试通过 ≠ 发布后可运行，必须 `npm pack` 校验。
- `cordis.patch.yml` 通过**文件系统路径**读取（`resolveBundleDir` + `join`），**不经过 exports**，所以 export 与否不影响，但**必须在 `files` 里**。dshmarket 额外导出了 `./cordis.patch.yml` 只是习惯。
- 可以发布 `src`（dshmarket、dsh-intelligent-ui 都发），但非必需；只要 `files` 闭环即可。

### 2.5 完整 `package.json` 模板（Threadloom）

```json
{
  "name": "dsh-session-butler",
  "version": "0.1.0",
  "description": "Session management for DeepSeek Harness: list, inspect, rename, pin, archive, and delete sessions across workspaces.",
  "type": "module",
  "main": "lib/index.js",
  "types": "lib/types/index.d.ts",
  "icon": "icon.svg",
  "license": "MIT",
  "author": { "name": "Your Name", "url": "https://github.com/you" },
  "repository": { "type": "git", "url": "git+https://github.com/you/dsh-session-butler.git" },
  "homepage": "https://github.com/you/dsh-session-butler#readme",
  "bugs": { "url": "https://github.com/you/dsh-session-butler/issues" },
  "keywords": [
    "dsh",
    "deepseek-harness",
    "dsh-plugin",
    "cordis",
    "session",
    "session-management",
    "archive",
    "threadloom"
  ],
  "engines": {
    "node": ">=22.19",
    "dsh": ">=0.2.1-rc.3 <0.3.0"
  },
  "exports": {
    ".": {
      "types": "./lib/types/index.d.ts",
      "default": "./lib/index.js"
    },
    "./client": "./lib/client.js",
    "./package.json": "./package.json",
    "./locale/*.json": "./locale/*.json",
    "./icon": "./icon.svg"
  },
  "files": [
    "lib",
    "locale",
    "icon.svg",
    "cordis.patch.yml",
    "README.md",
    "docs/usage.md",
    "LICENSE"
  ],
  "dsh": {
    "manifestVersion": 1,
    "bundle": {
      "patch": "./cordis.patch.yml"
    },
    "client": {
      "platform": "web",
      "inject": [
        "@deepseek-ai/dsh-client-locale"
      ]
    }
  },
  "peerDependencies": {
    "@deepseek-ai/cordis": "^4.0.5",
    "@deepseek-ai/schemastery": "^3.18.5"
  },
  "devDependencies": {
    "@deepseek-ai/cordis": "^4.0.5",
    "@deepseek-ai/schemastery": "^3.18.5",
    "@types/node": "^24.0.0",
    "@types/react": "^18.3.0",
    "@types/react-dom": "^18.3.0",
    "react": "^18.3.1",
    "react-dom": "^18.3.1",
    "tsdown": "^0.22.0",
    "typescript": "^5.9.0"
  },
  "scripts": {
    "typecheck": "tsc -p tsconfig.host.json --noEmit && tsc -p tsconfig.client.json",
    "build": "npm run build:host && npm run build:client",
    "build:host": "tsc -p tsconfig.host.json",
    "build:client": "tsdown",
    "prepack": "npm run typecheck && npm run build"
  },
  "publishConfig": {
    "access": "public"
  }
}
```

逐项说明：
- `engines.dsh` 放**顶层**；`dsh.manifestVersion: 1` 可写（当前无强制）。不要把 `dsh.profile` 写进插件包。
- `dsh.client.inject` 只列**我们 UI 真正挂载到的 client 包 + locale**（示例先只放 locale；Web 方案确定挂载点后补 `@deepseek-ai/dsh-client-ui-sidebar` 等**提供 slot 的 client 包**）；它是信息性边，不排序激活（`packages/client/AGENTS.md:149`）。Cordis 服务等待由 Client 半 `apply` 导出对象里的 `inject` 负责（模板见 `templates/decoration/client.js`）。
- `prepack` 覆盖 `npm pack` / `npm publish` 的构建。**只有要支持 git / 本地路径安装时才加 `"prepare": "npm run build"`**：`prepare` 会在 `npm install`、git 安装以及 pack/publish 前运行；注意 npm 在 pack/publish 时会先跑 `prepack` 再跑 `prepare`，两者都构建等于构建两次（也可只保留 `prepare` 覆盖全部场景）。已发布的 dshmarket 就是 `prepack` + `prepare` 双份。
- unscoped 包 `publishConfig.access` 可省；scoped 包（`@you/dsh-session-butler`）必须 `public`。
- `devDependencies` 里的 `react`/`react-dom` 只用于类型与本地测试，不随之安装；生产依赖若实例需与宿主共享，放 `peerDependencies` + `devDependencies` 同范围（`publish.md:105`）。

### 2.6 Host 插件导出形态（`lib/index.js`）

二选一，不可混用（`references/host-plugin.md:57-64`）：

```js
// 形态 A：函数式
export const name = 'threadloom'          // 可选
export const inject = ['tools', 'commands', 'sessionQuery']  // 可选：Cordis 服务名
export const Config = Schema.object({ /* schemastery */ })   // 可选：row.config 的校验器
export function apply(ctx, config) {
  // 所有资源用 ctx.effect / ctx.on 注册并返回 cleanup
}

// 形态 B：默认导出 Service class
export default class Threadloom extends Service { ... }
```

- `inject` 是**服务名**（不是包名）；`Config` 存在时 row 的 `config` 会在激活前校验；可用 `Config.listConfigs` 查询安装后插件的 schema。
- 与宿主共享身份的 `@deepseek-ai/*` 包放 `peerDependencies` + `devDependencies`（同范围），既能被 typecheck，又由安装的 DSH 运行时解析（`publish.md:105`）。
- agent tools 用 `ctx.tools.register(defineTool({...}))`（需 `tools` 服务）；chat slash 命令用 `ctx.commands.register({...})`（需 `commands` 服务）；Web UI 在 Client 半。CLI 子命令**不能**由第三方插件包注册（`dsh` 的 `plugin` 子命令只是转发 pnpm；`dsh cmdline` 的 `ctx.cmdlineArgs` 供 app 读取当前启动参数——`DSH/packages/boot/cmdline/README.md:30-60`）。

---

## 3. Bundle patch 契约（`cordis.patch.yml`）

### 3.1 语法（Loader patch dialect）

每个 patch 文件是一个 YAML 数组，元素为“mapping”，常用形态：

```yaml
# 插入新行
- insert:
    - id: threadloom
      name: 'dsh-session-butler'
      config:
        pageSize: 50

# 覆盖已有行（按 id）：只替换给出的字段；config 整块替换，不深合并；name 为真值时必须与现名一致（断言），否则警告并跳过
- id: some-base-row
  config:
    enabled: true

# 插入到已有 group 行内部：patch 同时带目标 group 的 id 与 insert 列表
# （vendor/include/src/index.ts:79-94：id 必须指向 group:true 且 config 为数组的行；找不到/不是组 → 警告并跳过）
- id: planning
  insert:
    - id: threadloom-plan-row
      name: 'dsh-session-butler/extra'
```

行字段（`DSH/packages/preset/agent-preset/skills/cordis-composition-reference/SKILL.md`“Loader patch dialect” 一节）：

| 字段 | 说明 |
|---|---|
| `id` | 行标识；覆盖/启停都按它匹配。第三方 bundle 应使用稳定、唯一、带插件前缀的 id（如 `threadloom`）。 |
| `name` | 插件 package specifier（被插入的相对路径按 patch 文件所在目录锚定）。**对带 Client 半的包必须是裸包名**，见 §3.3。 |
| `config` | 传给插件 `apply` 的配置；覆盖时**整块替换**。可含 `!!js` 表达式（在行声明的注入服务就绪后、对插件自己的 ctx 求值）。 |
| `disabled` | boolean / null / `!!js`；禁用行不会再被实例化（本行就不存在 Client 行）。 |
| `inject` | 行级服务注入（Cordis 服务名）。 |
| `group: true` + `name: cordis:group` | `config` 是嵌套行列表，可被后续 `insert` 按 id 追加。 |
| `name: cordis:include` + `config.path` | 加载字面 YAML/JSON 行列表文件。 |
| `isolate` | 服务隔离域（`{ service: true }` / realm 标签）。 |
| `intercept` | 拦截器（较少用）。 |

规则细节（实现见 `DSH/vendor/include/src/index.ts:57-127`）：
- **非 insert 且没有非空 `id`、或 id 匹配不到任何行** → 打印 stderr 警告并跳过（不是致命错误）。
- 覆盖时：`name` 为真值且与现名不一致 → 警告并跳过（它是断言不是改名）；其余字段（含 `disabled`、`config`）**浅赋值**，`config` 整体替换。
- `insert` 带 `id` = 插入到该 id 的 group 行内部（目标必须 `group: true` 且 config 为数组），不带 `id` = 追加到顶层列表；同一 patch 列表里后出现的 patch 可以再次定位前面刚插入的行。
- `config` 中的 `!!js` 只在 Loader 表达式位置生效，别的行元数据保持字面。
- 我们的 patch 可以覆盖更早层的行，但必须**重述该行所有需要的字段**（`publish.md:131-136`）；profile 的所有层（bundle 层 + profile 用户层 + home 层 + `--patch` overlay）会被 `readProfilePatches` **拍平成一个有序 patch 列表**（`DSH/packages/boot/app-boot/src/profile-context.ts:74-85`），作为根 Include 的 `patches` 按序叠加到根 entry 列表上（`DSH/packages/boot/app-boot/src/index.ts:738-772` 的 `mountRootInclude`；算法 `vendor/include/src/index.ts:57-127, 239-241`）。

### 3.2 校验时机

- **安装后**：`installBundle` 在 `pnpm add` 成功后对 `dsh.bundle.patch` 的每个文件执行 `loadOverlayPatches`——YAML 解析失败即安装失败并回滚 `package.json`/`pnpm-lock.yaml`（`DSH/packages/boot/plugin-manager/src/index.ts:936-941`）。
- **启动/重组合**：profile 逐 bundle 加载；**bundle 的 manifest/兼容性/patch 加载失败只跳过该 bundle**（`skippedBundles`，启动时打印一次），其余 bundle 保持顺序。**profile 自身 patch 或 home patch 的错误会让启动失败**（`DSH/packages/boot/app-boot/README.md:50`、`profile.ts:96-106`）。
- **HMR**：profile 用 HMR 时 patch 改动即时重组合；安装/替换包本身通常需要重启加载新的 JS 模块代（`references/host-plugin.md:66-70`、`plugin-manager/README.md:124`）。

### 3.3 行 `name` 与 Client 扫描的关键约束

Client 扫描逻辑（`DSH/packages/client/modules/src/index.ts:889-916, 918-964, 1034-1041`）：

1. 只扫描 **active、未 disabled** 的 Loader 行（`processOne` 跳过无 fiber / disabled）。
2. 对行 `name` 求“所属包”：**只有“包根裸名”或“文件路径/file:/绝对路径”两种形态**能被解析到包。`exactPackageSpecifier('pkg/sub')` 返回 undefined，且非 path-like → 直接 `return undefined`（`manifest.ts:201-207`、`index.ts:929-936`）。
3. 因此：**带 Web Client 半的包，patch 里必须有一行 `name` 是裸包名**（如 `name: 'dsh-session-butler'`）。如果只写 `name: 'dsh-session-butler/startup'` 这类子路径行，Host 能加载，但 `dsh.client` 永远不会被发现，浏览器侧不会出现该插件。
4. 同一个包若被**多个 active Loader source** 解析到，会抛 `package … resolves from multiple active Loader sources`（`index.ts:1080-1087`）。
5. 行 `name` 解析出的包根目录由 Node exports 决定：`exports["."]` 指向的 Host 入口所在包即包根；client bundle 路径 = 包根 + `exports["./client"]` 的相对路径（`index.ts:904-910`）。

### 3.4 Threadloom 的 patch 草案

```yaml
# Threadloom 的 profile 层：一行同时挂 Host 半（apply）与 Client 半（dsh.client）。
- insert:
    - id: threadloom
      name: 'dsh-session-butler'
      config:
        pageSize: 50
        trashRetentionDays: 30
```

- `id` 用 `threadloom`，`name` 用**裸包名**，`config` 可被用户在自己的 profile patch 里按 id 覆盖（他们要重述所需字段）。
- Host 半若还需要独立子行（例如只在某些 preset 启用的工具行），可以再加 `name: 'dsh-session-butler/tools'`；但**必须保留裸包名那一行**，否则 Client 半消失。
- 如果以后要覆盖/扩展既有行（例如给官方 session 搜索工具行改 config），在 patch 里用 `- id: …` 覆盖并重述字段。

---

## 4. Client（Web 半）契约

### 4.1 发现、组装与路由

- 发现是**增量扫描**：每个 cordis `internal/plugin` 事件把 fiber 的 entry name 标脏，microtask flush 重读该 entry 的包 manifest 与 `dsh.client`（`DSH/packages/client/modules/src/index.ts:1-27, 1034-1136`）。没有全量重扫路径。
- 条件：包在 profile 中安装、对应 Loader 行 active、`dsh.client.platform === 'web'`、`exports["./client"]` 指向一个**已构建**文件（`index.ts:899-916`）。缺失 bundle 会抛 `client bundle not found; run pnpm run build before launch`（`index.ts:99-117`），fiber FAILED → Web 启动审计失败。
- 组装：每个包一行 `WebBootEntry{ id=包名, url, rev, inject?, immediately?, external? }`，按模块图拓扑排序（被请求的 dynamic package 行在消费者之前；自请求/环直接报错）（`index.ts:526-581`）。
- 路由：Web 端用 `/plugins/??<pkg-a>/client.js,<pkg-b>/client.js&rev=<rev>` 组合脚本；单包 URL 也支持；`rev` 由 bundle 的 mtime/ctime/size 派生（不 hash 内容）；`HEAD` 与不可变缓存由 Host 负责（`docs/subsystems/client-modules.md:100-102`、`index.ts:226-229`）。
- 初始注入：`window.__ModuleLoader__` 队列门面（一个 **classic script**）、application 批预加载、bootstrap 批阻塞脚本、最后 `window.__DSH_BOOT__` 图（`index.ts:600-635`）。
- 浏览器侧懒加载：执行 bundle **只注册工厂**；模块体副作用（含 CSS 注入）在首次 materialize 时发生（`client/modules/src/client/manifest.ts:9-16`）。

### 4.2 `dsh.client` 字段语义（逐字对应）

| 字段 | 类型 | 语义 | 实现位置 |
|---|---|---|---|
| `platform` | string（必填） | 只有 `'web'` 会被 Web 消费者接收；其他值整包跳过（不是报错）。 | `manifest.ts:173-181`、`index.ts:903` |
| `inject` | string[]（可选） | **信息性** package-name 依赖边：保证这些包的 factory 在**本行 materialize 之前到达**，并参与 HMR 差异判断；**不**决定 Cordis 激活顺序（激活顺序只由 Client 半导出的 `inject` 服务名决定）。 | `manifest.ts:88-91`、`system.ts:253-280`、`entries.ts:32`、`packages/client/AGENTS.md:149` |
| `immediately` | boolean（可选） | `true` = stage-one 预取：boot 在并发 import 之前先 `prefetch` 本行脚本（只提前传输/注册工厂，不激活）。只给基建行用，普通功能插件省略（默认 application batch）。 | `manifest.ts:90-91, 264-266`、`web/src/boot.ts:116-123`、`AGENTS.md:149` |
| `external` | string[]（可选） | 精确的**非 baseline** 模块表请求；声明后该包行必须在消费者 materialize 之前到达（模块图边），循环/自请求被拒。类型导入被擦除、不产生请求。 | `manifest.ts:92-97, 218-220`、`index.ts:549-581`、`AGENTS.md:83-86` |

注意 `external` 与 `inject` 的差别（`packages/client/AGENTS.md:112-122` 的三张表）：`inject` 是包级边，`external` 是模块 specifier 级请求，Cordis 服务 `inject` 才是运行时服务等待。

### 4.3 模块包装格式（必须逐字一致）

浏览器把每个 bundle 当 **classic script** 执行（`<script src>` 动态插入，无 `type=module`，`client/modules/src/client/system.ts:15-28`）。DSH 自己的构建预设产出的形态就是唯一标准（`packages/client/tsdown.client.ts:924-937`）：

```js
window.__ModuleLoader__.load({ id: "<package name>", factory: (require) => {
var module = { exports: {} }; var exports = module.exports;
/* ---- bundler 产出的 CommonJS 代码（require("react") 会落到 factory 参数） ---- */
return module.exports; } });
```

对应构建配置（tsdown/rolldown 输出选项）：
```js
banner:  `window.__ModuleLoader__.load({ id: ${JSON.stringify(pkgName)}, ${isChunk ? `chunk: ${JSON.stringify(fileName)}, ` : ''}factory: (require) => {`
intro:   'var module = { exports: {} }; var exports = module.exports;'
footer:  'return module.exports; } });'
format:  'cjs'
```

浏览器侧注册与解析（`client/modules/src/client/system.ts`）：

- `register(registration)`：`ownerId = stripClientSuffix(registration.id)`；`id` 不带 `chunk` 时用 ownerId。**id 必须等于包名**（写 `<pkg>/client` 也会被 strip 成包名）。重复注册、chunk 名非法（只能是 `client.<name>.js`）都会抛错（`:166-180`）。
- `arrive(row)`：加载脚本后必须 `factories.has(id)`，否则报 `loaded without registering "<id>" via __ModuleLoader__.load`；失败会自动重试批次/回退到单包 URL（`:209-247`）。
- 工厂里的 `require(spec)` 解析顺序：**baseline seed 词 → 已 materialize 记录 → 已注册工厂 → 抛错**（错误文案 `require("<spec>") missed the module table …`）（`:299-351`）。
- `require.async('./client.<name>.js')`：按需加载包内 chunk（`import()` 的产物）；chunk 文件名规则 `^client\.[A-Za-z0-9][A-Za-z0-9._-]*\.js$`（`index.ts:198-199`、`system.ts:341-349`）。
- `require.asset(ref)`：把构建期资产引用解析成 `/plugins/<pkg>/assets/...` 的文档相对 URL（`system.ts:340`、`manifest.ts:354-359`）。
- factory 必须返回 exports 对象；Client 半的插件导出（`apply`/`inject`/`Config`）就是这个对象的字段——见模板 `templates/decoration/client.js` 的 `return { inject: ['slots'], apply(ctx) {...} }`。

### 4.4 模块表 baseline：11 个可用 specifier

浏览器启动时把下列 specifier 冻结为“平台单例”，所有动态 bundle 都按这个表解析 externals（`DSH/packages/client/web/src/platform.ts:8-19`，seed 实现 `packages/client/web/src/seed.ts:26-42`）：

```
react
react/jsx-runtime
react-dom
react-dom/client
@deepseek-ai/cordis
zod
@tanstack/react-virtual
@deepseek-ai/dsh-client-store
@deepseek-ai/dsh-client-ui-slots
@deepseek-ai/dsh-client-ui-primitives
@deepseek-ai/dsh-client-ui-dockkit
```

规则：
- **这 11 个隐式 external，不要重复写进 `dsh.client.external`**（workspace 校验会报“repeats baseline module”，第三方虽不校验但纯属噪声）。
- 其他第三方库（日期、图标、状态机…）**内联进 bundle**（私有副本，无共享身份要求）；跨插件行为走 Cordis 服务，UI 走 slots（`packages/client/AGENTS.md:83-93`）。
- 想请求**非 baseline** 的 module 值，只有两种合法供给：① 某个 active dynamic package 行；② baseline 的精确 key。没有 `dsh.client.provide` 别名协议。
- React 三件套 + jsx-runtime **必须 external**：内联 React 会产生第二个实例，hooks/context 立即损坏。

### 4.5 样式、资源、source map

- CSS：DSH 预设把 CSS 编译成“工厂执行时注入 `<style data-plugin=…>`”，卸载由 `ctx.effect` 清理；不产出独立 CSS 文件（`packages/client/tsdown.client.ts:1-18, 59-76`）。第三方可以自己实现等价逻辑，或把样式作为 React 元素渲染（组件局部样式随 unmount 消失，`references/ui-plugin.md:11`）。
- 图片：只支持包内 `src/client/assets/` 的图片经构建后进 `lib/assets/`（文件名带内容修订），并在 `package.json` 里 `exports["./assets/*"] = "./lib/assets/*"`、`files` 含 `lib/assets`；浏览器经 `/plugins/<pkg>/assets/<path>` 读取（`packages/client/AGENTS.md:9`、`assets.ts:14-31`）。`require.asset()` 只在构建把它编译进 bundle 时才有意义。
- Source map：可选。bundle 尾部 `//# sourceMappingURL=…` 会被 Host 剥掉并改写成组合查询，组合 map 在首次 GET 时合成（`docs/subsystems/client-modules.md:102`）。不发 `.map` 也能运行，只是调试信息退化为 identity map。
- `immediately` 与 HMR：Client 图按 release 判定；Host 升级/包升级后页面要 reload 才用新代码（`docs/subsystems/client-modules.md:88-90`）。

---

## 5. 展示元数据：locale / icon / detail / README

Plugin Manager（插件页、插件行）与 Settings 会在**不激活插件**的前提下读取这些资源（`app-boot/src/package-meta.ts:158-174`）。

### 5.1 locale 文案

- 发现入口：`<pkg>/locale/en.json` 必须能通过 exports 解析（`package-meta.ts:179-181`）。语言文件与 `en.json` **必须同目录**、文件名是语言 id（`/^[A-Za-z]{2,8}(-[A-Za-z0-9]{1,8})*$/`），大小写归一后去重（`package-meta.ts:124-145`）。
- 文件形状：
  ```json
  { "meta": { "title": "Session manager", "description": "List, rename, pin, archive, and delete sessions." } }
  ```
- fallback 链（各自独立；作者规范见 `adding-a-package.md:139-145`，实现见 `package-meta.ts:147-156`）：title：locale `meta.title` → package.json `name`（仅包根）→ 完整 Cordis specifier（仅当有本地化条目但缺 en 时，`en` 才落到 specifier）；description：locale `meta.description` → package.json `description` → 空。
- 英语 title/description 用 sentence case；值必须是非空字符串；畸形 JSON/字段会让该插件带诊断（文案仍回退，不影响可管理性）。
- 建议：`locale/en.json` + `locale/zh.json`（本项目用户是中文；zh 要覆盖 en 的所有字段）。如果要做 npm 发布的门面，再补 ja/es/fr/de/ru/pt（那是 first-party 规范，`adding-a-package.md:139`）。

### 5.2 icon

优先级（`package-meta.ts:22-55, 188-194`）：
1. `package.json` 顶层 `icon`（相对 manifest 目录；绝对路径/URL/逃逸包目录/symlink 逃逸都拒绝）；
2. `exports["./icon"]` 资源；
3. 都没有 → 面板默认图。

约束：SVG / PNG / JPEG（`.jpg`/`.jpeg`）/ WebP，原始字节 ≤ **256 KiB**；必须是包内常规文件。读取结果是 `data:` URL，**不激活插件**。取不到时显示默认图并保留有效文本；图标坏了不会回退到 export 形式。

### 5.3 detail 文档（插件详情长文）

选择顺序（`packages/util/plugin-detail/README.md:29-42`、`plugin-detail/src/document.ts:99-111`）：
1. **locale `meta.detail`**：按语言链（`zh-Hans-CN` → `zh-hans-cn` → `zh-hans` → `zh` → `en`）读 `locale/<lang>.json`（也接受地区大写形式如 `zh-CN.json`），第一个声明 `meta.detail` 的语言生效；
2. **包 README**：`README.md`、`readme.md`、`Readme.md`、`README.markdown`、`README` 任一；
3. 只有**市场条目页**再回退：`repository` 指向目录的 README（已安装 bundle 的插件页不读仓库）。

`meta.detail` 规则（`document.ts:31-40`）：非空字符串；`/` 分隔、相对包根、不得有 `\`、URL scheme、空段、`.`/`..`；必须以 `.md`/`.markdown` 结尾。文件不存在 → `invalid`，**不会**回退 README。建议放 `docs/usage.md` 这类子目录，并让 `files` 包含 `docs`（插件页图片按“相对文档”或“以 `/` 开头 = 包根”解析，只服务 PNG/JPEG/GIF/WebP/AVIF/SVG，`document.ts:113-140`）。

读取来源：已安装 bundle 直接读包目录；Official 未安装条目从 npm 文件 CDN（jsDelivr/unpkg/npmmirror）读（`plugin-manager/README.md:103-112`）。所以 **locale/detail/README/图片都必须在 `files` 里**。

### 5.4 README 的打包意义

- 包没有 `meta.detail` 时，插件详情页就是 README；README 必须在 `files` 里。
- README 内容会展示给用户（含“Install/Uninstall 步骤、Config 说明、版本兼容范围”）。
- Settings 的插件清单只缩短字面 fallback（去 scope/前缀），locale 文案不变（`adding-a-package.md:156-158`）。

---

## 6. TypeScript 构建与产物布局（推荐）

### 6.1 目录布局

```
dsh-session-butler/
├── package.json
├── cordis.patch.yml
├── icon.svg
├── locale/{en,zh}.json
├── README.md
├── docs/usage.md              # meta.detail 目标（可选）
├── tsconfig.host.json         # Host 半：ESM + declaration
├── tsconfig.client.json       # Client 半：noEmit 类型检查
├── tsdown.config.ts           # 只构建 Client 半
├── src/
│   ├── index.ts               # Host 入口：apply/inject/Config
│   ├── host/…                 # 服务、工具、命令、持久化
│   ├── shared/…               # host 与 client 都可 import 的纯类型/纯函数（浏览器安全）
│   └── client/
│       ├── index.tsx          # Client 入口：export apply / inject
│       └── ui/…               # React 组件（只能用 baseline 依赖）
└── lib/                       # 构建产物（发布）
    ├── index.js               # Host ESM
    ├── types/**/*.d.ts
    ├── client.js              # Client classic-script 工厂
    └── client.js.map
```

`lib/` 是产物目录，不进源码树（`.gitignore`），但必须出现在 `files` 里。

### 6.2 Host 半：ESM

- 需要 `"type": "module"`；入口是 `exports["."]`（或 `main`）。
- `tsconfig.host.json` 关键项：`"module": "NodeNext"`、`"moduleResolution": "NodeNext"`、`"target": "ES2022"`、`"rootDir": "src"`、`"outDir": "lib"`、`"declaration": true`、`"declarationDir": "lib/types"`、`"sourceMap": true`；`include` 只含 host/shared（排除 `src/client`）。
- `@deepseek-ai/*` 运行时依赖**保持 import 原样、不要 bundle**：它们由运行中的 DSH 安装解析（peer 感知的运行时解析）。产物里出现 `require('@deepseek-ai/cordis')`/`import '@deepseek-ai/cordis'` 是正常且正确的。

### 6.3 Client 半：classic-script 工厂

**tsdown（推荐，与 DSH 官方同一工具链）**——`tsdown.config.ts`：

```ts
import { defineConfig } from 'tsdown'

const ID = 'dsh-session-butler'

// 与 DSH 0.2.1-rc.3 的 PLATFORM_MODULES 保持一致（packages/client/web/src/platform.ts:8-19）
const BASELINE = [
  'react', 'react/jsx-runtime', 'react-dom', 'react-dom/client',
  '@deepseek-ai/cordis', 'zod', '@tanstack/react-virtual',
  '@deepseek-ai/dsh-client-store', '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-ui-primitives', '@deepseek-ai/dsh-client-ui-dockkit',
]
// 与 package.json 的 dsh.client.external 保持一致（本插件建议为空）
const EXTERNAL: string[] = []
const requested = new Set([...BASELINE, ...EXTERNAL])

export default defineConfig([{
  name: `${ID}/client`,
  entry: { client: 'src/client/index.tsx' },
  outDir: 'lib',
  format: 'cjs',            // 外面包成工厂，所以内部必须是 CJS
  platform: 'browser',
  dts: false,               // 类型由 tsconfig.client.json 检查，不产出 d.cts
  sourcemap: true,
  clean: false,             // 不要清掉 Host 产物
  deps: {
    neverBundle: (spec: string) => requested.has(spec),   // baseline + 声明的 external 保持 require()
    alwaysBundle: (spec: string) => !requested.has(spec), // 其余内联（私有副本）
  },
  define: {
    'process.env.NODE_ENV': JSON.stringify('production'),
    'import.meta.env.MODE': JSON.stringify('production'),
  },
  inputOptions: {
    resolve: { conditionNames: ['production', 'browser', 'import', 'module', 'default'] },
  },
  outputOptions: {
    entryFileNames: 'client.js',
    chunkFileNames: 'client.[name].js',   // 只有用 import() 才产生；名字必须匹配 /^client\.[A-Za-z0-9][A-Za-z0-9._-]*\.js$/
    banner: `window.__ModuleLoader__.load({ id: ${JSON.stringify(ID)}, factory: (require) => {`,
    intro: 'var module = { exports: {} }; var exports = module.exports;',
    footer: 'return module.exports; } });',
  },
}])
```

要点：
- `format: 'cjs'` + `platform: 'browser'` + 上述 banner/intro/footer 是 DSH 官方产物的精确形态（`packages/client/tsdown.client.ts:780-812, 924-937`）。
- 不要产出 ESM（浏览器按 classic script 执行，`import/export` 会 SyntaxError）；也不要只产出普通 IIFE/UMD 全局变量——必须调用 `__ModuleLoader__.load(...)` 注册工厂。
- `deps.neverBundle` 必须覆盖 **11 个 baseline + `dsh.client.external`**；`alwaysBundle` 覆盖其余全部（否则 require 落不到模块表会抛 `missed the module table`）。
- **首版建议单文件、不用 `import()` 拆包**：DSH 预设会用自定义 Rolldown 插件把动态 import 改写成 `require.async('./client.<name>.js')`（`packages/client/tsdown.client.ts:471-` 的 `asyncChunkRequirePlugin`，挂载于 `:855`），第三方没有这个预设；tsdown/esbuild 默认会把动态 import 编成同步 `require()`，而模块表只认 `require.async`，运行时会抛 require miss。若确实要拆包，必须自己实现同样的改写，并让 chunk 名匹配 `client.<name>.js`，才能被 `/plugins/<pkg>/client.<name>.js` 路由服务。

**esbuild 备选**（更小、依赖更少）：
```js
import { build } from 'esbuild'
await build({
  entryPoints: ['src/client/index.tsx'],
  outfile: 'lib/client.js',
  bundle: true, format: 'cjs', platform: 'browser', target: 'es2022',
  jsx: 'automatic', sourcemap: true, logLevel: 'info',
  external: [...BASELINE, ...EXTERNAL],
  banner: { js: `window.__ModuleLoader__.load({ id: "dsh-session-butler", factory: (require) => { var module = { exports: {} }; var exports = module.exports;` },
  footer: { js: 'return module.exports; } });' },
})
```
构建后**必须检查产物头部**：开头是 `window.__ModuleLoader__.load({ id: "dsh-session-butler", factory: (require) => {`，结尾是 `return module.exports; } });`，且 `require("react")` 没有被内联成 React 代码。

### 6.4 必须 external / 必须 inline 清单

| 类别 | 例子 | 处理 |
|---|---|---|
| 模块表 baseline（11 个） | `react`, `react-dom`, `react/jsx-runtime`, `@deepseek-ai/cordis`, `zod`, `@tanstack/react-virtual`, `@deepseek-ai/dsh-client-store`, `@deepseek-ai/dsh-client-ui-slots`, `@deepseek-ai/dsh-client-ui-primitives`, `@deepseek-ai/dsh-client-ui-dockkit` | **external**（不写进 `dsh.client.external`）；共享同一实例 |
| 声明的非 baseline 模块请求 | 仅基建/传输/生成装配才会用；例如另一个插件包的 `client` 子路径 | 写 `dsh.client.external`；supplier 必须存在 |
| 其他第三方库 | 图标库、日期库、状态机、工具函数 | **inline**（私有副本，无共享身份需求） |
| `@deepseek-ai/*` 中非 baseline 且需共享身份 | 不要尝试 require；改为 **Cordis 服务** | `apply` 的 `inject` + `ctx.<service>` |
| 宿主包（Host 半） | `@deepseek-ai/cordis`、`@deepseek-ai/dsh-*` | 依赖声明（peers/devDeps），运行时由安装解析，不 bundle |

---

## 7. registry 安装、更新与校验链路

### 7.1 三个安装入口的行为差异

| 入口 | 目标 spec | 保存方式 | 适用 |
|---|---|---|---|
| `dsh plugin --profile <p> add <spec>` | 任意 pnpm spec（相对路径也可） | pnpm 默认（registry 包默认 `^版本`） | 本地/开发/手工管理 |
| `plugin_manager` `install_bundle`（tool） | registry 名 / 绝对路径 / git / tarball | **不传 `--save-exact`**（`tools.ts:146-152`、`index.ts:895`）→ pnpm 默认范围 | agent 自动化；需审批/`danger-full-access` |
| Web 插件页安装 | 同上 | 非本地安装传 `saveExact: true`（`packages/client/ui-plugin-manager/src/client/manager-store.ts:1145`）→ 精确版本 | 普通用户路径 |

Official on-demand 安装也走 `installBundle`，registry 目标用 `saveExact: true`（`plugin-manager/README.md:52`）。

### 7.2 安装前后校验清单（`installBundle` 全流程）

**安装前**（`plugin-manager/src/index.ts:844-924`、`operations.ts` 的 named-spec 预检）：
1. spec 形态：空串或以 `-` 开头 → `invalid-spec`；本地路径必须**绝对路径**（`install-spec.ts:69-92`）；URL 只能是 git 仓库或 tarball；registry 名必须匹配 npm 包名正则。
2. 已安装检测：HMR 下同包已安装 → `already-installed`（不跑 pnpm）。
3. 预检：本地路径读它的 package.json；registry spec 用 `pnpm view` 读选中版本的 `engines`/`peerDependencies`（`plugin-manager/README.md:75`）。**未满足 DSH 要求 → 直接拒绝，不下载、不执行构建脚本**。
4. bundle 声明：没有 `dsh.bundle` → `not-a-bundle`（本地路径/registry spec 在**安装前**拒绝；git/tarball spec 因需先 fetch，在**安装后**拒绝并回滚文件，`plugin-manager/README.md:75`）。
5. GitHub/HTTP(S)-git 可达性探测（`git ls-remote`，默认 5s；只拦网络/超时）（`plugin-manager/README.md:58-62`）。
6. 构建脚本：pnpm 11 默认阻止依赖的 install/build 脚本；失败会返回 `pendingBuilds`，用户批准后以 `approvedBuilds` 重试（`plugin-manager/README.md:70`、`tools.ts:94`）。

**安装后**（`index.ts:925-961`）：
7. 依赖变化必须恰好一个包，否则 `ambiguous-install`；
8. 解析包目录 → manifest 必须声明 `dsh.bundle`；
9. 再跑兼容性检查（未豁免的拒绝）；
10. `loadOverlayPatches` 逐个解析 patch 文件（失败 → 回滚 `package.json`/`pnpm-lock.yaml`）；
11. `selectBundle(name, true)`：把包名**追加**到 `dsh.profile.bundles` 末尾（`enabled: false` 时不追加）；
12. 发布 runtime resolution + reload；HMR 下新依赖即时生效，否则 `restart-required`。**安装成功后启用失败不回滚依赖**。

**启动时**：
13. 每个被选 bundle 再查兼容性；不满足且无豁免 → 跳过并记入 `skippedBundles`，启动打印一次（`app-boot/README.md:52,54`）。
14. 行 mount；Client 扫描（畸形 `dsh.client` / 缺 `./client` / 同包多 source → FAILED，Web 启动审计失败）。

### 7.3 更新（versions / updateBundle）

- **谁算可更新**（`plugin-manager/src/index.ts:174-190`）：profile 依赖中、非 Official、`availability === 'profile'`、**以 registry spec 按自己名字安装**（不能是 `npm:` alias）、manifest 版本是合法 semver、且不携带 plugin management。tarball/URL/git 依赖**不可**更新（没有 registry source）。
- `listVersions`：`pnpm view <name> versions time dist-tags` → 取比已安装版本新的版本（semver `gt`，最多 `versionListLimit` 默认 20）→ 逐版本 `pnpm view <name>@<v>` 读 `engines`/`peerDependencies`/`deprecated`/`dsh`，标出 `bundle` 与 `incompatible`（`index.ts:626-663`、`versions.ts:5-8`）。
- `updateBundle`：目标必须存在、声明 `dsh.bundle`、兼容；**HMR** 下先 remove（插件停止）再 `installBundle(name@version, saveExact:true, enabled)`；失败/取消/起不来时自动回退安装旧版本；**无 HMR** 时直接覆盖安装并报 `restart-required`（`index.ts:677-735`、`plugin-manager/README.md:54-56`）。更新后保存的是**精确版本**（`README.md:166`）。
- 注意：`plugin_manager` **tool 没有** listVersions/updateBundle action（action 枚举见 `tools.ts:89-98`）；更新入口是 Web 插件页 + CLI 手工 `remove` + `add <name>@<ver>`。

### 7.4 卸载

`removeBundle`：从 `dsh.profile.bundles` 移除 → 卸载运行时贡献 → `pnpm remove` → 发布 runtime resolution。无 HMR 时“启动时已加载的 bundle”不能被移除，会要求先停 profile（`plugin-manager/README.md:184-191, 171`）。插件管理自身所需 bundle 不可移除（`management-required`）。

---

## 8. 真实已发布插件对照

四个真实 npm 发布包（均在 `~/.dsh/profiles/web/node_modules/`）：

| 维度 | dshmarket | dsh-claude-style | dsh-intelligent-ui | dsh-opencode-session |
|---|---|---|---|---|
| 版本 / 形态 | 1.71.1；Host+Client+market | 0.19.4；Host+Client 主题 | 0.2.1-rc.3.iui.1.0.13；Host+Client（GitHub release tarball 安装） | 0.1.1；**Host-only** |
| `type` / main / types | module / `lib/index.js` / `lib/types/index.d.ts` | module / `lib/host/index.js` / 无 types | module / `src/index.mjs` / 无 types | module / `lib/index.js` / 无 |
| `engines` | 无 | **`dsh.engines.dsh: ">=0.1.7"`（无效位置）** | **顶层 `engines.dsh: "0.2.1-rc.3"` + `node >=22.19`** | 顶层 `engines.node` |
| `dsh.bundle.patch` | 字符串 | 字符串 | **数组** `[root, presets]` | 字符串 |
| `dsh.client` | `{platform:"web", inject:[locale, ui-settings, ui-theme]}` | `{platform:"web", inject:[]}` | `{platform:"web", inject:[9 个 ui/api 包]}` | 无 |
| `exports` | `.`+`./client`+`./package.json`+`./locale/*.json`+`./update-api-v1` | `.`+`./client`+`./package.json`+`./locale/*` | `.`+`./client`+`./prompt`+`./package.json` | `.` |
| `files` | assets/logo.svg, locale, lib, **src**, client, patch, LICENSE | lib, locale, skin.json, patch, docs, README… | src, lib, presets, skills, patch, README, docs… | lib, patch, README |
| client 产物 | `client/client.js`（848 KB） | `lib/client.js`（970 KB） | `lib/client.js`（837 KB） | — |
| client 头部 | `window.__ModuleLoader__.load({ id: "dshmarket", factory: (require) => {` | 注释 banner + `load({id:"dsh-claude-style", factory…})` | `load({id:"dsh-intelligent-ui",factory…})` | — |
| `prepack`/`prepare` 等 | `prepack` build+preflight；`prepare` build | `prepublishOnly` build | `prepack` docs+build+public-files | `prepublishOnly` test |
| 发布渠道 | npm | npm | GitHub Release `.tgz`（profile 里记录 URL） | npm（`^0.1.1` 范围） |
| 展示资源 | 顶层 `icon`；locale `meta:{}`（详情用 README） | 顶层 `icon`；locale 有 title/description | 无 locale/icon（回退 name/description） | 无（Host-only 无客户端展示需求） |

**该抄什么**：
- 抄 dshmarket / dsh-claude-style 的**发布闭环**：`"./client"`、`"./package.json"`、`"./locale/*.json"` 全部导出；顶层 `icon`；`files` 覆盖 `lib`+`locale`+`icon`+patch+README+LICENSE；`prepack` 里构建。
- 抄 dsh-intelligent-ui 的**兼容声明位置**：顶层 `engines.dsh`（并加 `engines.node`）。
- 抄 dsh-intelligent-ui 的**多 patch 文件**（若未来同时需要 Host 扩展与 agent preset 行）。
- **不要抄** dsh-claude-style 的 `dsh.engines.dsh`（不生效）；**不要抄** dsh-intelligent-ui 的“无 locale/icon”（展示会降级）；**不要抄** 用 tarball URL 安装（会失去 plugin_manager 更新能力）。

---

## 9. 市场索引（未来提交）

DSH 没有内置官方市场，用户需要在插件页的 **Discover** 里手动添加索引 URL（`plugin-market` 服务的 `indexes` 配置，默认空；`DSH/packages/boot/plugin-market/README.md:30-33`、`docs/user/guide/plugin-market.md:30-40`）。索引是**独立 JSON 文件**，可托管在任意静态 https 主机；我们若想被收录，通常是把包发布到 npm，再（自己或在社区索引里）生成索引条目。

格式 1 的硬性字段（`.agents/notes/implemented/feature/2026-10-02-plugin-market-index-format.md:96-160`、`packages/util/plugin-market-index/src/types.ts:44-110`）：

```json
{
  "format": 1,
  "title": { "en": "Threadloom plugin index", "zh": "Threadloom 插件源" },
  "plugins": [
    {
      "name": "dsh-session-butler",
      "title": { "en": "Threadloom", "zh": "Threadloom 会话管理" },
      "description": { "en": "Session management for DSH.", "zh": "DSH 会话管理。" },
      "icon": "icons/threadloom.svg",
      "author": "Your Name",
      "homepage": "https://github.com/you/dsh-session-butler#readme",
      "repository": { "url": "https://github.com/you/dsh-session-butler" },
      "metadata": { "keywords": ["session", "archive"] },
      "dist-tags": { "latest": "0.1.0" },
      "versions": [
        {
          "version": "0.1.0",
          "publishTimestamp": 1790000000,
          "source": { "type": "npm" },
          "engines": { "dsh": ">=0.2.1-rc.3 <0.3.0" }
        }
      ]
    }
  ]
}
```

- 根字段：`format: 1`、`title`（LocalizedText，必须含 `en`）、`plugins`（数组；顺序即默认排序）；`description`/`metadata.categories|labels|sortKeys` 可选。**`metadata.category`/`labels`/`sortKeys` 的值必须在根 `metadata` 里声明**，否则读取器拒绝整个索引；`keywords` 不需要根声明。
- 插件字段：`name` 必须唯一且是 npm 合法包名；`versions` 非空；`title/description` 是 LocalizedText（对象键必须是小写语言 id，含 `en`）；`icon` 是 ≤32 KiB 的 base64 data URL，或可解析为 https（或与索引同源）的 URL；`author/homepage/repository` 只用于展示。
- 版本字段：`version` 精确 semver、同插件内唯一；`publishTimestamp` 整数 Unix 秒；`source` 为 `{"type":"npm","registry"?}` 或 `{"type":"git","url","commit","path"?}`（git 必须是 40 位小写 commit）；`engines.dsh` 是**生成器义务**要求声明的合法 SemVer range（读取器实现里 `engines` 目前可省略，`plugin-market-index/src/index.ts:208-219, 251`；但省略会导致市场无法预判兼容性，安装时仍会用真实 manifest 拒绝，出现“市场可装、安装被拒”）。
- 安装参数由客户端拼：npm → `<name>@<version>`（+registry）；git → `git+<url>.git#<commit>`（+`&path:/<path>`）。**索引只是清单**：实际安装仍走 §7 的完整校验。
- 生成器义务（不可由读取器验证，`注:162-172`）：`name`/`version` 必须等于安装源 manifest；`publishTimestamp` 为真实发布时间；`engines.dsh` 原样复制；`dsh.bundle` 必须声明（安装端独立拒绝无 bundle 的包）；`title/description/icon/author/homepage/repository` 取“最高版本的 locale/manifest 元数据”。
- `dist-tags.latest` 必须指向存在的精确版本；客户端装的是记录的精确版本，**不会**自动追 `latest`（`注:184-186`）。

结论：若未来要上市，我们只需保证 npm 包里有：`dsh.bundle`、`engines.dsh`、locale/icon/README、`author/homepage/repository`，然后生成/托管索引或让社区索引收录。

---

## 10. 发布 Checklist（build → pack → publish → install 验证）

> 本机 DSH 为 0.2.1-rc.3；以下命令在项目根目录执行。**不要在 DSH profile 目录里手工 pnpm add/写 manifest**，安装统一走 `dsh plugin` / `plugin_manager`。

### 阶段 A：构建与自查
1. 版本 bump：`package.json.version`；`engines.dsh` 覆盖当前运行时（如 `>=0.2.1-rc.3 <0.3.0`）；CHANGELOG。
2. `npm run typecheck`（host + client 两套 tsconfig）。
3. `npm run build` → 确认 `lib/index.js`（ESM）、`lib/client.js`（classic-script 工厂）、`lib/types/**` 存在。
4. **人工检查 client 产物头尾**：`window.__ModuleLoader__.load({ id: "dsh-session-butler", factory: (require) => {` … `return module.exports; } });`；确认 React 没有内联。
5. patch 自查：`id` 唯一、`name` 为裸包名、YAML 能被 `js-yaml`/`dsh --dump-config` 解析；行 `config` 若被覆盖需重述。

### 阶段 B：打包产物校验（最关键）
6. `npm pack --dry-run`（或 `npm pack` 后 `tar -tzf`）确认发布清单包含：
   `lib/index.js`、`lib/types/**`、`lib/client.js`(+map)、`cordis.patch.yml`、`locale/en.json`、`locale/zh.json`、`icon.svg`、`README.md`、`docs/usage.md`、`LICENSE`。
7. 确认没有误发：测试、`.env`、构建配置、超大 map（可选）；确认 `files` 与 `exports` 指向一致。
8. 在**临时空目录** `npm install <tarball>`，用 Node 解析 `pkg/package.json`、`pkg/client`、`pkg/locale/en.json`（验证 exports 在真实安装形态下可解析）。

### 阶段 C：本地安装验证（发布前）
9. 新建测试 profile（或临时 profile）：`dsh plugin --profile tl-dev add /abs/path/to/dsh-session-butler`（本地目录 → linked；注意 `files` 不过滤）。
10. `dsh --profile tl-dev --dump-config`：确认出现 `# == dsh-session-butler` 层，行 id/name/config 正确。
11. 启动 `dsh --profile tl-dev`：
    - Host 半 apply 执行、工具/命令注册成功（无 FAILED fiber）；
    - Client 半加载：浏览器控制台无 `client bundle not found` / `missed the module table` / `loaded without registering`；
    - 插件/插件行显示正确的 title/description/icon（英文与 zh）；
    - 详情页显示 README 或 `meta.detail`；
    - 实际功能（列表/改名/归档等）冒烟。
12. 卸载验证：`dsh plugin --profile tl-dev remove dsh-session-butler`，确认 row 消失、无残留。

### 阶段 D：发布
13. `npm publish`（scoped 包加 `--access public`；`prepack` 自动构建）。发布后核对：
    `npm view dsh-session-butler@0.1.0 name version engines peerDependencies dsh license repository` —— 必须能看到 `dsh.bundle`（更新检查依赖 registry 上可见的 `dsh` 字段，`versions.ts:8, 66-79`）。
14. 打 tag、GitHub Release 附 `npm pack` 的 tgz（可选；`prepare` 覆盖 git 安装场景）。

### 阶段 E：从 registry 全新安装验证
15. 干净测试 profile：`dsh plugin --profile tl-fresh add dsh-session-butler@0.1.0`（或用 `plugin_manager` `install_bundle`，target = `dsh-session-butler@0.1.0`）。
16. 确认 `~/.dsh/profiles/tl-fresh/package.json` 的 `dependencies` 与 `dsh.profile.bundles`（bundle 追加在末尾）正确；`--dump-config` 正确。
17. 启动并复跑阶段 C 的功能/UI 检查；刷新页面（Host 升级/包升级后必须 reload 才换 client bundle）。
18. 更新路径验证（可选）：Web 插件页 `Update` 或 remove+add 新版本；确认 `listVersions` 能列出、`updateBundle` 保存精确版本；无 HMR profile 需重启。
19. 回归：禁用/卸载/重装，确认无残留 client 行、无重复注册。

---

## 11. 坑位清单（按踩中概率排序）

1. **把兼容声明写进 `dsh.engines.dsh`** → 静默失效。必须顶层 `engines.dsh`；否则会退化成“拿 `@deepseek-ai/dsh*` peers 与运行版本比较”。
2. **`@deepseek-ai/dsh-*` peer 范围按“运行中的 DSH 版本”判定**，不是该包版本。写精确包版本（如 `0.2.1-alpha.1`）会误拒。最稳：顶层 `engines.dsh` 独占判定 + 其余 peers 只用于 install 关系。
3. **patch 行 `name` 用了子路径**（`dsh-session-butler/host`）→ Host 能跑，但 Client 半永远不被扫描（只认裸包名/path-like）。带 UI 的包必须有一行裸包名。
4. **缺 `exports["./client"]`，或用 `{ "import": ... }` 条件键** → 启动期抛错（`clientExportOf` 只读 string 或 `.default`），`modules` fiber FAILED。
5. **忘记 `"./package.json"` export** → title 回退为完整 specifier、description 丢失、`icon` 字段不生效（readPluginMeta 必须解析到 manifest）。
6. **client bundle 里出现顶层 `import/export/await`** → classic script 语法错误，整包加载失败（`loaded without registering`）。
7. **注册 id 不等于包名** → `loaded without registering "<id>"`；即使能注册，图行 id 仍按包名匹配。
8. **React/react-dom/jsx-runtime 未 external** → 双 React 实例，hooks/context 立刻崩。
9. **把 baseline 模块重复写进 `dsh.client.external`** 或把 `external` 当依赖机制 → 校验报错（workspace）/ require miss（第三方）。
10. **require 了非 baseline、非声明 external、非本包 chunk 的 specifier** → `require(...) missed the module table`，且是**运行时**才炸。
11. **忘了 `files` 里的 patch/locale/icon/README/client bundle** → 本地 link 一切正常，发布后 ENOENT / 无文案 / 无图标。以 `npm pack --dry-run` 为准。
12. **`private: true` 还想 npm publish** → npm 直接拒绝；发布包不要写。scoped 包忘了 `publishConfig.access: "public"` 同理。
13. **以为 `prepare` 能救 git 安装** → pnpm 10+ 默认阻止依赖构建脚本，用户必须 `allowBuilds` 批准；最省事还是发 npm 预构建产物（`publish.md:161-186`）。
14. **用 tarball/URL 安装后想用 plugin_manager 更新** → 不可更新（`source` 不是 registry spec，`updateRefusal` 拒绝）；更新需要 npm registry 安装。
15. **tool 安装与 Web UI 安装的保存形态不同**：tool `install_bundle` 不传 `--save-exact`（profile 记录 `^x.y.z`），Web 对非本地安装 `saveExact: true`（精确）；`updateBundle` 总是精确保存。别拿 profile 里看到的 `^` 判断安装路径。
16. **在 HMR profile 里对同版本重装** → `already-installed`；更新/换版本要先 remove 再 install（或用 Web Update）。无 HMR 则可能 `restart-required`。
17. **同一包被两个 loader source 解析**（例如同时 link 和 registry 安装）→ Client 组合报 `resolves from multiple active Loader sources`。
18. **profile patch 覆盖行时只写改动字段** → `config` 整块替换，其余字段丢失。必须重述。
19. **`meta.detail` 指向根目录文件或未随包发布** → `invalid`，且**不**回退 README；详情页图片路径也必须在 `files` 内。建议放 `docs/`。
20. **market 索引 `engines.dsh` 缺失或声明 workspace 范围** → 生成器义务违规/读取器拒绝（`workspace:` 明确 fail）；省略时市场不预判兼容，安装才拒。
21. **运行时版本来源搞错**：`getDshRuntimeVersion()` 读的是安装里的 **`@deepseek-ai/dsh-app-boot` 包版本**，不是 profile、不是 CLI 参数；DSH 升级后必须重新核对 `engines.dsh`。
22. **发布后 client 不更新**：Host release 一旦变化，页面只应用“boot release 相同”的图，必须刷新页面；同一 release 下的 bundle 更新由 client HMR 推送（仅在 HMR 启用时）（`docs/subsystems/client-modules.md:88-90, 122`）。
23. **Client 半写 Cordis 服务依赖时只写了 `dsh.client.inject`**（包边）而不是 `apply` 导出对象里的 `inject: ['slots', 'locale']`（服务名）→ 激活顺序/服务不可用问题。两者不可互换。
24. **在 profile 目录手工 `pnpm add`/改 `package.json`** → 绕过选择/校验/回滚逻辑；统一用 `dsh plugin` 或 `plugin_manager`。
25. **`import()` 拆包但没把产物改写成 `require.async`** → 动态 chunk 在运行时 require miss；首版保持单 `client.js` 最稳（见 §6.3）。

---

## 12. 对 Threadloom 的落地建议

- **包名**：`dsh-session-butler`（unscoped，和 dshmarket/dsh-claude-style 一致，安装 spec 最短、`parseInstallSpec` 无 scope 障碍）。
- **首版 manifest**：直接用 §2.5 模板；`dsh.bundle.patch` 用单字符串；`dsh.client` 先只声明 `platform: "web"` + `inject: ["@deepseek-ai/dsh-client-locale"]`，等 Web 方案（task-2）确定挂载点后再补 `@deepseek-ai/dsh-client-ui-sidebar` 等**提供 slot 的 client 包**。
- **Host 半**：`inject = ['tools', 'commands', 'sessionQuery', …]`（以 task-1 的结论为准）；agent tools 走 `ctx.tools.register`，slash 命令走 `ctx.commands.register`；所有资源在 `apply` 内用 `ctx.effect`/`ctx.on` 注册并返回 cleanup。
- **Client 半**：React 组件全部用 baseline 依赖（`react`、`ui-slots`、`ui-primitives`）；通过 `ctx.slots.inject/register` 扩展；文案走 locale 服务与 `locale/*.json` 双层（Client 字典 + 包展示 meta）。
- **发布节奏**：先用绝对路径 link 到临时 profile 做端到端验证（阶段 C）→ `npm pack` 校验文件闭环 → 临时 profile 从 tarball 安装 → 最后 `npm publish`（阶段 D/E）。
- **兼容策略**：首个版本 `engines.dsh: ">=0.2.1-rc.3 <0.3.0"`；如果依赖了 0.2.1-rc.3 才有的 API，可在 `dsh.client`/工具描述里注明最低版本；升级 DSH 后按 §2.3 重新评估，必要时收紧范围而不是依赖 exemption。

---

## 13. 参考来源（按引用密度）

**DSH 源码（`/home/leoric/code/deepseek-harness`）**
- `packages/util/package-manifest/src/types.ts` — `DshPackageManifest` / `DshBundleManifest` / `DshClientManifest` / `DshEnginesManifest`
- `packages/boot/app-boot/src/plugin-compatibility.ts` — 运行时版本、`evaluatePluginCompatibility`、warning
- `packages/boot/app-boot/src/profile.ts` — `bundlePatchFiles` / `bundlePatchPaths` / `SkippedBundle`
- `packages/boot/app-boot/src/package-meta.ts` — `readPluginMeta`、locale/icon 发现
- `packages/boot/app-boot/README.md` — bundles、兼容、例外、显示元数据
- `packages/boot/plugin-manager/src/{index,operations,install-spec,versions,official-install-target,tools}.ts` — 安装/校验/更新/清除
- `packages/boot/plugin-manager/README.md` — 行为、失败语义、版本与例外、配置默认值
- `packages/client/modules/src/index.ts` — `dsh.client` 扫描、图组装、`/plugins` 路由
- `packages/client/modules/src/client/{manifest,system,entries}.ts` — wire 类型、注册/require、entry 生命周期
- `packages/client/modules/README.md` / `docs/subsystems/client-modules.md` — 浏览器侧契约
- `packages/client/web/src/{platform,seed,boot,boot-client}.ts` — 模块表 baseline、boot 流程
- `packages/client/tsdown.client.ts` — 官方 client 构建预设（banner/intro/footer、externals）
- `packages/client/AGENTS.md` — Client 包规则、external/inject 语义、发布闭包
- `packages/util/plugin-detail/{README.md,src/document.ts}` — detail 文档顺序与 `meta.detail`
- `packages/util/plugin-market-index/src/{types,index}.ts` + `.agents/notes/implemented/feature/2026-10-02-plugin-market-index-format.md` — 索引格式
- `packages/boot/plugin-market/{README.md,src/types.ts}` — 市场服务、索引源配置、兼容判定
- `packages/preset/agent-preset/skills/cordis-plugin-development/{references/host-plugin.md,references/ui-plugin.md,templates/decoration/*}` — bundle/客户端模板
- `packages/preset/agent-preset/skills/cordis-composition-reference/SKILL.md` — patch dialect
- `docs/user/develop/basic/publish.md` — 从作者视角的 bundle/profile/安装/发布教程
- `docs/cookbook/adding-a-package.md` — 插件展示元数据作者规范
- `docs/user/guide/plugin-market.md` — 索引发布与安装
- `.agents/notes/implemented/architecture/2026-09-10-public-package-manifest.md` — 顶层 `engines.dsh` 决策

**已发布真实插件（`~/.dsh/profiles/web/node_modules/`）**
- `dshmarket/package.json`、`cordis.patch.yml`、`client/client.js`（头部）
- `dsh-claude-style/package.json`、`cordis.patch.yml`、`lib/client.js`（头部）
- `dsh-intelligent-ui/package.json`、`cordis.patch.yml`、`lib/client.js`（头部）、`release-manifest.json`
- `dsh-opencode-session/package.json`、`cordis.patch.yml`
- `dsh-profile-web/package.json`（`~/.dsh/profiles/web/package.json`，看依赖保存形态：精确版本 / URL tarball / `^range` / `link:`）
