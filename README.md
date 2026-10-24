# LiteRouter Studio — 轻量 LLM Provider 聚合网关

本地部署、单用户、面向可信局域网/本机环境的 OpenAI / Anthropic **原生透传代理网关**。一个 Node 进程同时提供代理入口、管理 API 与 Web 控制台，用模型映射名把客户端请求路由到真实 Provider。

> ⚠️ **安全声明**：网关使用 HTTP 明文传输，Token 与上游 API Key 不受传输层加密保护。仅限可信局域网或本机使用，禁止直接暴露到公网。

## 核心红线

1. **不做协议转换**：OpenAI 与 Anthropic 请求格式互不转换。
2. **仅替换 `model` 与思考等级字段**：映射路由成功后，定点替换顶层 `model` 字符串值；若映射配置了思考等级，仅按配置改写/注入顶层 `thinking`（Anthropic）或 `reasoning_effort`（OpenAI）字段。不重新序列化请求体，也不修改其他字段。
3. **原生透传**：成功响应与重定向原样转发；上游错误先由网关拦截，不直接暴露上游响应体。其中 Provider 故障（401/402/403/404/408/429/5xx）在首个响应字节写出前按 Key、再按映射绑定的真实模型 Provider 故障转移，候选耗尽后包装为 502/504；客户端请求错误（其余 4xx，如 400/413/422）按原始状态码返回、不切换、不冷却。

## 功能特性

- 控制台提供浅色/深色/跟随系统主题与响应式布局；`⌘K` / `Ctrl+K` 或侧栏搜索打开全局命令面板，可导航页面、切换主题、复制端点 URL，并搜索可用映射直达 Playground。跳转到 Provider 或映射时会预填目标页搜索框并短暂高亮标注命中项，便于快速定位。首页 cURL 示例使用当前协议的可用映射名，未配置时需替换 `<MODEL_ALIAS>`；示例 Token 保留为占位符。

- OpenAI（`/openai/v1/*`）与 Anthropic（`/anthropic/v1/*`）代理入口，支持 SSE 流式透传；端点路径缺 `/v1` 自动补齐、多重 `/v1` 自动去重
- Provider 管理：按名称或地址快速搜索、按分组筛选、分组按最近代理调用时间排序；按协议自定义分组、表单内新建分组、批量选择/移动/启用/禁用/删除、分组启用滑块、配置复制、API Key 显隐、连通性测试、模型拉取、导入弹窗标记已导入/已添加并支持单个取消导入与一键清理导入模型（拉取失败仍可清理）、HTTP 代理、自定义请求头与模型过滤、New API / Sub2API Access Token（可选，仅余额查询用，不参与代理转发）；支持 newapi/sub2api 余额查询：配置 access_token 可查**用户总余额**（newapi 走 `/api/user/self`，`quota/500000=USD`；sub2api 走 `/api/v1/auth/me` 的 `data.balance`）；newapi 令牌额度走 OpenAI 兼容 billing，展示剩余/已用/总额与令牌到期日，无限额密钥只报用量；sub2api 走 `/v1/usage` 展示无限额/剩余、已用成本与日周月限额；带 TTL 缓存与在途去重
- 模型管理：按 Provider 分组展示（默认折叠）、手动添加或批量导入、启用/禁用、模型测活、批量操作
- 模型映射：按协议分组（默认折叠）、编辑/移动分组、分组内模糊搜索导入已有映射、多个候选目标与手动优先级（候选模型搜索覆盖同协议全部 Provider，选中自动回填提供商与模型）、合并多个映射的候选（可选删除源映射）、一键清理无候选目标的无效映射；三种路由模式（single 仅当前目标 / weighted 加权随机 / failover 优先级故障转移，含失败冷却、单探测恢复与亲和期，仅限首个响应字节写出前重试）；可选思考等级（强制覆盖或仅默认，值为协议原生字段）；新建映射可一键把真实模型名填为映射名
- 单渠道多 Key：Provider 可逐把命名、启停、排序，按轮询、随机或顺序优先选择；Provider 故障先换同渠道 Key，Key 用尽再按映射策略换真实模型 Provider。冷却优先采用上游重试时间，冷却到期仅放行一条探测请求；客户端请求错误（其余 4xx）与响应头超时等结果不明的传输错误均不冷却。结果不明时跳过当前 Provider 的其他 Key，改切下一个真实模型 Provider，避免在同一 Provider 重放可能已处理的请求。
- 双轨日志：代理访问日志（含被动解析的 token 用量与重试序号）与配置操作审计日志，支持分页、筛选、刷新和清空
- 配置与备份：监听地址、超时、日志保留、健康探针间隔、Token 管理，以及配置数据的全量导出/导入
- Playground：直接调用真实网关入口，解析两种协议的 SSE，并按协议与映射名保存本地会话

## 技术栈

| 层 | 技术 |
| :--- | :--- |
| 后端 | Node.js ≥ 24 · TypeScript strict · Hono 4 · better-sqlite3 13 · undici 8 · zod 4 |
| 前端 | React 19 · React Router 8 · Vite 8 · Tailwind CSS 4 · shadcn/ui · TanStack Query · react-markdown |
| 包管理 | pnpm 11.26.0（`packageManager` 已固定；registry 为 `registry.npmmirror.com`） |

## 快速开始

准备 Node.js ≥ 24 与 pnpm 11.26.0，然后在项目根目录执行：

```bash
pnpm install
pnpm dev
```

开发模式会启动后端 `http://127.0.0.1:3000` 与 Vite `http://localhost:5173`；Vite 会把 `/api`、`/openai`、`/anthropic` 代理到后端。

首次运行会在 `data/gateway.db` 的 `settings.admin_token` 中生成随机 UUID。项目不会把 Token 写进仓库；可在项目根目录用下面的命令读取它，再到登录页输入：

```bash
pnpm exec tsx -e "import { getAdminToken } from './src/services/auth.ts'; console.log(getAdminToken())"
```

此命令供部署者在自己的终端取 Token 登录。AI 助手操作网关时使用项目 Skill 的进程内凭据读取方式，避免将 Token 带入工具输出或对话；请勿把命令输出粘贴到源码、Issue、日志或其他不可信位置。

### 生产运行

```bash
pnpm build:web
pnpm start
```

`pnpm start` 直接运行后端 TypeScript 源码，并由 Hono 托管已构建的 `web/dist`。未构建前端时，管理 API 与代理仍可启动，但不会有可用的 Web 控制台。

### 部署与 CD 逻辑（本地作为生产机）

Linux 生产机上 3000 端口是 systemd 托管的生产网关（`literouter.service`）。仓库采用**双分支**模型：`dev` 是开发线，`main` 只作为生产镜像（禁止直接提交，只接受从 `dev` 合并）。整套 CD 是**拉取式**的：

```
dev 提交 → 自测 + 审查 diff → git merge --no-ff dev → git push origin main
                                                      ↓
                                    生产机切回 main 后手动跑 scripts/deploy.sh
                                                      ↑ 推送 ≠ 部署，部署是显式动作
```

部署用脚本代替手工 `git pull`：

```bash
git switch main && scripts/deploy.sh
```

生产服务直接运行本仓库源码，因此部署前必须停在 `main` 且工作树干净；`deploy.sh` 会校验当前分支，停在 `dev` 时直接拒绝执行。

脚本依次执行：校验当前分支为 `main` 且无已跟踪文件改动 → `git fetch` → 用 `data/last-deployed-sha`（上次成功部署的提交）与 `origin/main` 比较决定是否需要部署 → 打印变更文件 → 按需 `git merge --ff-only` → 用 SQLite 在线备份 API 把 `data/gateway.db` 快照到 `data/deploy-backups/`（校验完整性后才原子落位）→ `pnpm install --frozen-lockfile` → `pnpm check`（类型检查 + 单元测试 + 前端构建）→ 重启 `literouter.service` → 轮询冒烟检查 `http://127.0.0.1:3000/`（默认最多等 60s，冷启动慢于 12s 时不再误报失败）→ 冒烟通过后写回部署记录。

- **按部署记录判断，而不是本地 HEAD**：手工 `git pull` 提前快进、直接在仓库里开发后忘了部署，脚本仍会补跑备份、门禁与重启；只有服务 active 且冒烟 200 才更新记录，中途失败不会污染记录，下次运行自动重试。
- **已部署版本必须仍在远端历史中**：远端被强推或回滚时脚本拒绝自动部署，避免变更清单与回滚提示失真。
- **失败即中止**：`pnpm check` 不通过时不会重启服务，旧版本继续对外服务。
- **数据库与 `.env` 不被触碰**：两者都在 `.gitignore` 内，`data/` 下只有备份目录与 `last-deployed-sha` 会被写入；快照保留最近 10 份。
- **只允许快进**：本地若存在远端没有的提交会被拒绝，避免在生产机产生分叉或合并提交。
- **只允许在 `main` 上部署**：当前分支不是 `main` 时脚本直接拒绝，避免把 `dev` 上未发布的代码带上生产。
- 可用 `BRANCH`、`SERVICE`、`HEALTH_URL`、`KEEP_BACKUPS`、`SMOKE_TIMEOUT`、`SMOKE_INTERVAL`、`STATE_FILE` 环境变量覆盖默认值。
- 回滚需手工执行：`git checkout <旧 SHA> && pnpm install && pnpm build:web && systemctl --user restart literouter.service`，并把 `data/last-deployed-sha` 改成对应 SHA（否则下次部署会以为线上仍是新版本）；**代码回滚不会回滚数据**，必要时先从 `data/deploy-backups/` 恢复。

> 注意：生产仓库不要保留未提交改动，且不要在生产机上执行 `git reset --hard` / `git checkout --`，那会静默丢弃本地未提交的文档或配置修改。

### 本机开发：`dev` 分支 + `pnpm dev`

功能开发在同一主仓库切到 `dev` 分支进行，不使用 worktree 副本：

```bash
git switch dev
pnpm dev   # 启动前端口预检；后端 tsx watch + Vite，代理自动对齐库里的后端端口
```

改动自测并审阅 diff 后合入 `main`（`main` 锁提交，只接受来自 `dev` 的合并）：

```bash
pnpm check                                   # 自测
git add -A && git commit -m "feat(scope): ..."
git push origin dev                          # 备份/协作
git switch main && git merge --no-ff dev      # 审查通过后合入
git push origin main                         # 推送 ≠ 部署
```

端口规划（测试与部署分离，互不占用）：

| 场景 | 后端 | 前端 | 说明 |
| :--- | :--- | :--- | :--- |
| 生产部署 | 3000 | — | Linux 生产机 systemd `literouter.service` |
| 本机开发 | 3013 | 5173 | 后端端口由库中 `settings.port` 决定 |
| E2E 测试 | 3013 | — | Playwright 默认 `http://127.0.0.1:3013`，复用同端口测试实例 |

- **每次启动前自动预检端口**：`pnpm dev`、`pnpm dev:server`、`pnpm dev:web`、`pnpm start` 都先执行 `scripts/check-ports.ts`，端口被占用时打印冲突端口和排查命令并中止启动，不会带冲突继续跑。单独检查：`tsx scripts/check-ports.ts [--server|--web|--port=8080]`。
- Vite 已设 `strictPort`：端口被占用直接失败，不会静默切到 5174，避免访问地址与实际监听不一致。
- 后端监听以 `data/gateway.db` 的 `settings.host/port` 为准，其次才是 `HOST`/`PORT` 环境变量；本机开发库为 `0.0.0.0:3013`，只想本机访问时在 Settings 里把 host 改成 `127.0.0.1`。
- 代理目标按 `PORT` > 库中 `settings.port` > 3000 解析（`vite.config.ts` 与 `src/server.ts` 同序），所以 `pnpm dev` 不传参数也会代理到库里的 3013；临时改端口再用 `PORT=...` 覆盖。
- 3000 属于生产网关，开发实例不要占用或重启它，也不要在生产仓库里跑开发服务。
- E2E 默认打测试实例：`pnpm test:e2e`；换目标用 `E2E_GATEWAY_URL=...`，未设 `E2E_GATEWAY_TOKEN` 时自动从当前库只读读取 Token。

**开发与发布流程**：

1. 在主仓库 `main` 上编码、提交，`git push origin main`；
2. 到生产仓库跑 `scripts/deploy.sh`，拉取并按门禁重启。

不保留长期并行开发分支；需要试错时用短命 `feat/*` 分支，合入前快进到 main 后即删除，这样 deploy.sh 的 `--ff-only` 拉取与快进校验永远成立。

## 配置生效规则

- 默认监听 `127.0.0.1:3000`（仅本机）。已保存的数据库设置优先于 `HOST`/`PORT` 环境变量，环境变量再优先于默认值；需要局域网访问时在 Settings 里把 host 改为 `0.0.0.0` 或具体地址。
- `host`、`port` 保存后需重启后端才能重新绑定监听地址。
- `global_timeout_ms` 由后续代理请求读取；Provider 自身的 `timeout_ms` 优先。值为 0 时代理连接/响应头不超时，流式响应体始终不设超时；Provider 连通性测试和模型列表拉取仍有 30 秒兜底。
- `log_retention_days` 在后端启动时清理代理日志和审计日志；0 表示不自动清理。
- 后端内置 RSS 看门狗：进程内存超过 `GATEWAY_RSS_SNAPSHOT_BYTES`（默认 1.5 GiB，设 0 关闭）时向 `data/` 写堆快照用于定位内存泄漏，两次快照至少间隔 5 分钟。
- 数据库路径是启动进程当前目录下的 `data/gateway.db`，可用 `GATEWAY_DATA_DIR` 覆盖数据目录，请始终从项目根目录通过 pnpm 脚本启动。测试进程（`NODE_TEST_CONTEXT`）只允许把库解析到系统临时目录，否则启动即报错，避免误删真实配置。
- `ENCRYPTION_KEY` 用于加解密 Provider 凭据，按三级来源解析：进程环境变量/项目根目录 `.env`（已被 Git 忽略）→ 数据目录下的 `.generated-encryption-key`（上次启动自动生成，权限 0600，**重启时自动读回复用**）→ 两者皆无时随机生成并写入该文件（**不会打印到 stdout**）。建议尽快把密钥迁入 `.env`，确认生效后删除密钥文件。若库中已有加密凭据但 env 与密钥文件都缺失（如文件被误删），网关会拒绝启动而不是静默换钥——恢复原 `.env` 或密钥文件后再启动。
- 当前为无正式用户的开发阶段，schema v11 是直接基线；遇到 schema 不兼容时可删除 `data/gateway.db` 重建，不承诺兼容早期开发版数据库或备份。

## 客户端接入

客户端请求中的 `model` 必须填写模型映射名，不能直接填写未映射的真实模型 ID。两个协议的映射命名空间彼此独立。

| 协议 | 模型列表 | 常用请求入口 |
| :--- | :--- | :--- |
| OpenAI | `GET /openai/v1/models` | `POST /openai/v1/chat/completions`、`POST /openai/v1/responses` |
| Anthropic | `GET /anthropic/v1/models` | `POST /anthropic/v1/messages` |

> 端点的 `/v1` 版本段会自动归一化：缺 `/v1`（如 `/openai/chat/completions`）会自动补齐，多重 `/v1`（如 `/openai/v1/v1/chat/completions`）会自动去重。

所有管理 API 与代理入口都需要网关 Token。提取优先级为：

1. `Authorization: Bearer <gateway-token>`
2. `x-api-key: <gateway-token>`
3. `api-key: <gateway-token>`

Anthropic SDK 通常会占用 `x-api-key` 发送上游 Key，因此接入本项目时应使用 `Authorization: Bearer <gateway-token>`；真实上游 Key 只在 Provider 配置中保存。

## 数据、日志与备份

- `data/gateway.db` 使用 SQLite WAL 与外键约束，运行时自动创建且已被 Git 忽略。
- 代理日志的 `latency_ms` 是收到上游响应头的首包耗时，不是完整流式响应耗时。
- 备份包含 Provider 分组、Provider（含 Key 池策略、顺序、启停和明文 Key）、真实模型、映射分组、全部映射（含未分组映射）、候选目标/优先级、设置和网关 Token，不包含代理访问日志、配置操作日志或内存冷却状态。导入会先校验引用、协议关系与 Key 池形状（重复 ID、空池、非法策略等直接拒绝），再在单个事务内全量替换这些配置数据；既有日志会保留，前端会退出登录，之后须使用备份中的 Token 登录。导出时若任一 Provider 凭据无法解密（通常是 `ENCRYPTION_KEY` 丢失或被更换），导出会直接失败并提示，不会产出一份缺凭据的备份。

## 目录结构

```text
├── src/
│   ├── server.ts         # 入口、监听配置、启动清理与优雅关闭
│   ├── app.ts            # Hono 应用、路由挂载、静态文件与 SPA fallback
│   ├── db/               # SQLite 当前 schema v11 基线
│   ├── middlewares/      # Token 认证
│   ├── proxy/            # 请求体边界、model 定点替换与 undici dispatcher
│   ├── providers/        # OpenAI / Anthropic URL、认证与请求头构造
│   ├── routes/           # /api 管理路由与两类代理入口
│   ├── services/         # Provider、模型/映射、日志、设置、备份与测活
│   └── types/            # 后端行类型与 API 类型
├── web/src/
│   ├── api/              # API Client（Token 存 localStorage，401 自动登出）
│   ├── components/       # Layout、ChatUI、MarkdownRenderer 与 UI 组件
│   ├── lib/sse.ts        # 跨网络 chunk 的双协议 SSE 增量解析器
│   └── pages/            # Home、Providers、Models、Logs、Settings、Playground
├── test/                 # Node 单元测试与 Playwright 浏览器冒烟测试
├── skills/literouter/    # 网关管理 Skill 的维护源
├── ARCHITECTURE.md       # 唯一权威设计指南
├── AGENTS.md             # AI 助手开发约定
└── data/                 # 运行时数据库目录（不入库）
```

## 脚本

| 命令 | 说明 |
| :--- | :--- |
| `pnpm dev` | 后端 watch + Vite 开发服务（启动前端口预检；默认 3000/5173，用 `PORT`/`VITE_PORT` 让位） |
| `pnpm dev:server` | 仅后端（tsx watch，启动前端口预检） |
| `pnpm dev:web` | 仅前端（Vite，启动前端口预检 + `strictPort`，代理目标跟随 `PORT`） |
| `scripts/check-ports.ts` | 独立端口预检：`tsx scripts/check-ports.ts [--server\|--web\|--port=8080]` |
| `pnpm typecheck` | TypeScript 类型检查 |
| `pnpm test` | Node 单元测试 |
| `pnpm test:e2e` | Playwright 浏览器测试；构建、服务复用与 Token 前提见下文 |
| `pnpm check` | 类型检查、单元测试与前端生产构建 |
| `pnpm build:web` | 构建前端到 `web/dist` |
| `pnpm start` | 生产模式运行 API、代理与前端静态站点 |

### 浏览器验证

- 先运行 `pnpm build:web` 生成与当前前端对应的 `web/dist`。Playwright 默认访问测试实例 `http://127.0.0.1:3013`（与部署端口 3000 分离，可用 `E2E_GATEWAY_URL` 覆盖），非 CI 环境可复用该地址已有服务，否则由配置启动 `pnpm start`（自带端口预检）；核对目标服务是否对应当前后端及构建，避免用旧服务的结果证明新改动。数据库中的监听设置可能覆盖环境变量，端口冲突或地址不符时先选择受控的测试实例，不随意停止已有服务。
- 认证用例优先使用 `E2E_GATEWAY_TOKEN`；未设置时，`test/e2e/global-setup.ts` 尝试从仓库开发库 `data/gateway.db` 只读取得 `admin_token`。两者都不可用时，依赖真实登录的用例跳过；模拟 API 的 UI 用例不依赖真实 Token。
- 验证结论需覆盖本次受影响场景，并说明相关跳过项。模拟 API 的 UI 用例通过不等于真实后端链路通过，关键登录用例跳过也不能算该场景已验证。
- `test/ui-check.mjs` 是可按需运行的桌面与移动端 UI 检查脚本，不属于 `pnpm check` 或正式 E2E 套件；需要已运行的后端和有效 Token，产物在 `test-results/ui-check/`。它不是每次改动的额外门槛。

开发与提交按 [AGENTS.md](AGENTS.md) 第 8 节选择验证范围，局部改动可运行相关用例；同一代码与环境下已通过的检查不因提交动作重复执行。

## 项目 Skill

[skills/literouter/SKILL.md](skills/literouter/SKILL.md) 是网关管理 Skill 的维护源，[references/api.md](skills/literouter/references/api.md) 提供按需查阅的端点参考。Skill 用于实际配置与排障任务，开发或规则审查不自动触发网关访问。

工具加载配置和安装副本属于本机环境，已被 Git 忽略，新克隆不保证存在。OpenCode 可在项目根目录的 `.opencode/opencode.json` 中将 `skills.paths` 设为 `["skills"]`，合并时保留已有配置。本机还保留 `.agents/skills.json` 的路径记录，以及 `.claude/skills/literouter/`、`.pi/skills/literouter/` 的安装副本；这些记录不代表所有客户端都支持相同的加载方式。

各工具按其支持的技能路径或安装入口引用同一个维护源，支持目录引用或符号链接时优先采用。使用安装副本时仅在源 Skill 变更后同步整个目录并核对一致性，不独立编辑副本，也不把同步变成其他任务的完成门槛。

## 设计文档

- [`ARCHITECTURE.md`](ARCHITECTURE.md)：唯一权威设计指南，包含数据模型、API、代理与备份边界和已知权衡。
- [`AGENTS.md`](AGENTS.md)：面向 AI 助手的项目约束、按任务阅读索引、风险验证和完成、提交与整理规则。

## License

内部项目，未配置开源许可。
