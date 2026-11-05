# 测试与验证

Threadloom 的验证分三层：第一层是每次提交的默认门禁（`pnpm run verify`），第二、三层在 CI 的独立 `e2e` job 中运行；两层 E2E 都使用真实 `dsh web` 进程，不伪造 Cordis Context。

## 1. 单元与契约测试（72 个）

```bash
pnpm test          # node:test，tests/*.test.mjs
pnpm run verify    # typecheck + clean + build + test + npm pack 契约校验
```

覆盖 Host 服务、bridge 信封、M1 删除/级联、M2 客户端 bundle、M3 read model、manifest 与打包闭包。它们直接调用构建产物或稳定模块边界，不启动浏览器。

## 2. L1：真实组合测试

文件：`e2e/composition.e2e.mjs`

每个用例都会：

1. 在系统临时目录创建一次性 `DSH_HOME`；
2. 用 `npm pack --ignore-scripts` 打出**当前可发布产物**（受 `files` 白名单约束），解压到 profile 的 `node_modules/dsh-session-butler`；profile 的 `package.json` 只写这个临时 tarball 的 `file:` 依赖，真实 Loader 仍从包名解析，而不是直接 import 源码；
3. 用仓库 devDependency 里的真实 CLI 启动 `dsh web --no-open --port 0`，等待它打印带 token 的 URL；
4. 走浏览器认证入口拿到 cookie，再通过真实 HTTP 观察 Host。

断言覆盖：

- Web bootstrap HTML 中出现了 `dsh-session-butler/client.js`；
- `/session-butler/api/status` 返回 200、`ok: true`、版本与 `package.json` 一致、`bridge.mounted` 与各 Host 后端均为 true；
- `/session-butler/api/delete` 在真实 Host 上存在，未知 id 返回稳定的 `session-not-found`；
- 已归档只读列表在空 profile 上返回 0 条。

这一层能抓住 Loader 组合、bridge 路径和构建产物问题；设置 slot 的实际注入由 L2 浏览器路径覆盖。它不启动浏览器。

## 3. L2：Playwright 浏览器测试

文件：`e2e/live-ui.e2e.mjs`

在同一临时 profile 基础上预置两个 **idle 且非空白** 的已持久化会话（按 Host 的 JSONL v4 格式写入临时 `sessions/`，因此无需模型 Provider、不会产生正在运行的 turn），然后用 Playwright Chromium 打开真实 GUI：

- 打开账号菜单 → Settings，断言左栏包含 **Archived chats** 与 **Threadloom**，且没有 Trash / 回收站或会话库入口；
- 打开两个设置分区，检查 Archived chats 页面可渲染，Threadloom 设置页出现两个数字配置输入；
- 两个 workspace 的会话行都出现在侧栏；
- 模拟桥返回 `session-running`、`session-in-use`、`session-locked` 和网络中断，验证关闭行菜单后仍会弹出对应提示；再通过临时存储冲突触发真实 Host 错误；
- 用宿主的重命名操作加载一个已完成的会话，验证删除被安全拒绝且数据仍在；重启隔离宿主后直接重试删除，断言会话目录消失、`trashCount === 0`；
- 在 alpha 会话行检查“Delete session”菜单项和图标；
- 在 beta 会话行点 "`...`" → `Archive session`，进入 Settings → Archived chats，点 `Delete permanently`，确认后同样断言 bridge 列表、会话目录与回收站。

> L2 使用模拟 bridge 响应覆盖提示，并通过真实 Host 覆盖存储冲突和空闲但仍被加载的会话。浏览器测试不启动真实模型或运行中的回合；Host 等待释放、拒绝时不停止活动且不改变归档/置顶状态，由单元测试覆盖。

## 本地运行

```bash
pnpm exec playwright install chromium   # 首次或升级 Playwright 后
pnpm run test:e2e
```

如果本机已有 Chromium，可跳过下载并使用显式路径：

```bash
DSH_E2E_CHROME=/path/to/chrome pnpm run test:e2e
```

L1 需要 Node（`node:zlib` 的 zstd 支持，Node 24+）、`npm` 与 `tar`；L2 还需要 Playwright Chromium。E2E 会先 `npm pack`，所以必须先 `pnpm run build`（`pnpm run verify` 已包含）。

## CI

`.github/workflows/ci.yml` 的 `e2e` job 在 Ubuntu 上安装依赖、构建、安装 Chromium，再执行 `pnpm run test:e2e`。它与 `verify` job 并行，失败不会让 `verify` 的发布契约结果被掩盖。

## 隔离与清理承诺

- 只写系统临时目录；测试把所有 DSH 状态收在临时 `DSH_HOME`，不修改用户真实的 `~/.dsh`。
- 每个用例结束都会停止子进程并递归删除临时 `DSH_HOME`；即使断言失败也走 `finally`。
- 固定使用 `--port 0`，不会占用 3080 或其它固定端口。
