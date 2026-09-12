# AGENTS.md — 项目开发约定

本文件保留项目特有的约束、资料入口和完成标准。先确定任务范围，再按第 5 节读取相关资料；本会话已读且未变化的内容可以复用，无需每次改动前通读文档。

## 1. 权威设计文档

- [ARCHITECTURE.md](ARCHITECTURE.md) 是**唯一权威设计指南**，按任务查阅架构、数据模型、API、代理管线和边界行为。
- 设计或对外行为变化时，更新架构文档的相关章节，并在同一任务中同步 [README.md](README.md) 和项目 Skill 中受影响的说明；开发约定变化才需要更新本文件。
- 遇到文档未覆盖的细节时，遵循核心原则推断：**最小可用、原生透传、仅定点改写允许的请求字段**。文档与实现不一致时，结合用户目标和相关代码、测试定位差异，修正受影响的说明或实现。

## 2. 红线（绝对不可违背）

1. **不做协议转换**：严禁在 OpenAI / Anthropic 之间互转请求格式。
2. **仅替换 model 与思考等级字段**：映射名请求经网关转发时，只允许把 body 的 `model` 字段替换为真实模型名（`proxy.ts` 路由成功后执行）；若映射配置了思考等级（`model_aliases.thinking_json`），仅按配置定点改写/注入顶层 `thinking`（Anthropic）或 `reasoning_effort`（OpenAI）字段。严禁增删改其他任何字段。
3. **安全定位**：HTTP 明文，仅限可信局域网/本机，不加密不降级。

## 3. 常用命令

| 命令 | 说明 |
| :--- | :--- |
| `pnpm install` | 安装依赖（镜像：`registry.npmmirror.com`，已在 `.npmrc`） |
| `pnpm dev` | 后端 (3000) + 前端 dev server (5173) 同时启动 |
| `pnpm dev:server` | 仅后端，tsx watch |
| `pnpm dev:web` | 仅前端，Vite（/api、/openai、/anthropic 已代理到 3000） |
| `pnpm typecheck` | `tsc --noEmit` 类型检查 |
| `pnpm test` | Node 原生单元测试（由 tsx 执行） |
| `pnpm test:e2e` | Playwright 浏览器冒烟测试（先确保 `web/dist` 已构建） |
| `pnpm check` | 类型检查 + 单元测试 + 前端生产构建（适用范围见第 8 节） |
| `pnpm build:web` | 前端构建到 `web/dist` |
| `pnpm start` | 生产模式：Hono 托管 API + 前端静态文件 |

环境约束：Node ≥ 24，统一使用 **pnpm 11.26.0**（见 `packageManager`），必须用 `tsx` 直接运行后端 TS 源码。

## 4. 技术栈

- 后端：TypeScript（strict）、Hono、better-sqlite3、undici v8、zod
- 前端：React 19、Vite 8、Tailwind CSS 4、shadcn/ui、TanStack Query、react-markdown、react-router 8
- 单包结构，`web/dist` 由 Hono 托管

## 5. 按任务读取

按受影响的行为选择资料和代码入口，跨模块任务扩大范围。下表中的架构章节均指 [ARCHITECTURE.md](ARCHITECTURE.md)；纯文档审查只核对相关文档和配置。

| 任务 | 代码或配置入口 | 相关资料 |
| :--- | :--- | :--- |
| 代理、路由、请求体、认证头、流式传输 | `src/routes/proxy.ts`、`src/proxy/`、`src/providers/`、`src/middlewares/` | 架构第 5、6、8 节中的相关约定 |
| Provider、模型映射或管理 API | `src/routes/api/`、`src/services/`、`src/types/` | 架构第 4、5 节；错误码见第 5 节 |
| schema、备份与恢复 | `src/db/index.ts`、`src/services/backup.ts` | 架构第 4 节及第 8 节备份边界；本文件第 11 节 |
| 启动、部署与生产托管 | `src/server.ts`、`src/app.ts`、`vite.config.ts` | 架构第 2、6、8 节中的相关约定；README 配置说明 |
| 前端页面、交互与 SSE 展示 | `web/src/pages/`、`web/src/components/`、`web/src/api/`、`web/src/lib/sse.ts` | 架构第 7 节；涉及 API 时再查第 5 节 |
| 开发命令与验证配置 | `package.json`、`tsconfig.json`、`playwright.config.ts`、`test/` | 本文件第 8 节；README 浏览器验证说明 |
| 实际操作网关配置 | `skills/literouter/` | [SKILL.md](skills/literouter/SKILL.md) 及当前任务涉及的 API 参考章节 |

`skills/literouter/` 是项目 Skill 的维护源；工具的本地安装入口和副本同步方式见 README。开发或规则审查不会自动触发网关引导、读取 Token 或发起管理请求。

## 6. 硬性约定

- **凡需指定真实模型的管理 API 一律通过 Request Body 传参**（`provider_id` / `model_id` 放 body，不用路径参数），因 `model_id` 可能含 `/`（如 `openai/gpt-4`）；`GET /api/models` 仅列出模型，不需要 body。
- **Provider 分组只用于管理展示**：按协议隔离，每个 Provider 最多归属一个组；删除分组只解除归属，批量删除成员才会删除 Provider 及其关联数据，分组本身不参与代理路由；批量移动只能移入同协议分组或未分组，分组启用滑块以原子操作统一启用/禁用成员。
- **模型映射是唯一路由入口**：客户端请求的 `model` 字段必须是映射名；每个映射可绑定多个候选但只路由到唯一 active 目标，严禁请求期轮询/随机/故障转移；新增真实模型/导入时为同名映射追加 inactive 候选且不覆盖 active；映射按 `(protocol, alias_name)` 唯一，两协议命名空间独立。
- 两协议代理入口分别挂 `/openai`、`/anthropic`；端点的版本段自动归一化（缺 `/v1` 自动补齐、多重 `/v1` 自动去重，见 `src/proxy/path.ts`）。除 `GET */v1/models` 外，代理只接受 POST。
- 前端 `@/*` 别名指向 `web/src/*`（tsconfig paths + vite alias 已配）。
- 新增 shadcn/ui 组件时用 `pnpm dlx shadcn@latest add ...`，配置见 `components.json`。

## 7. 数据与安全约定

- `data/gateway.db` 不入库（.gitignore），按进程当前工作目录解析并在运行时自动创建。
- `admin_token` 存在 `settings.admin_token`，首次启动自动生成 UUID；管理 API 与代理入口统一校验。
- Token 提取优先级：`Authorization: Bearer` > `x-api-key` > `api-key`。
- 备份文件含明文 API Key 与网关 Token，还含映射的思考等级配置，但不含代理访问日志和配置操作日志；导出/导入均要警示用户。导入会先校验数据图（含思考配置的协议形状校验），再在事务内全量替换 Provider 分组、Provider、真实模型、映射分组、全部映射（含未分组映射）和候选目标，应用备份设置与 Token；成功后前端强制登出并提示用备份内 Token 重新登录。
- `host`/`port` 保存后需重启；`global_timeout_ms` 对后续代理请求生效；`log_retention_days` 在下次启动清理时生效。
- 严禁把泄漏密钥/Token 的代码或常量提交进仓库。

## 8. 按风险验证

验证范围取决于受影响的行为和依赖，不只看文件数量。代理陷阱、API 错误码及数据边界以架构文档的对应章节为准，相关改动核对相关条目；跨模块改动扩大覆盖范围。

| 改动类型 | 默认验证 |
| :--- | :--- |
| 只读审查、文档、规则、纯整理 | 核对内容、链接、命令和引用的一致性；有修改时运行 `git diff --check`；Skill 变更再检查 frontmatter 与安装副本，无需构建或应用测试 |
| 局部 TypeScript 逻辑 | `pnpm typecheck` 与相关现有测试；按回归风险补充有意义的测试 |
| 局部 UI | 涉及 TS 时类型检查，运行 `pnpm build:web` 并验证受影响的交互；布局变化检查相关桌面和移动视口 |
| 核心代理、鉴权、数据库、共享逻辑、依赖或构建配置 | `pnpm check` 加受影响的边界验证；涉及浏览器行为或生产托管时运行适用 E2E |

- 单元测试可按文件运行，例如 `pnpm exec tsx --test test/path.test.ts`；E2E 可用 `pnpm exec playwright test --grep '<用例名>'` 选择相关场景。现有用例未覆盖变更风险时补充针对性验证。
- E2E 前确认 `web/dist` 已按当前前端构建、目标服务对应当前修改，并核对所需 Token 和测试数据；实际启动、复用服务和 Token 回退行为见 README。相关关键用例跳过不算验证完成，模拟 API 的 UI 用例也不证明真实后端链路可用。
- 同一代码、依赖及相关配置下已通过的验证可以复用。只在新改动、失败或未解决的疑点影响结论时扩大或重跑；提交动作本身不触发重复验证。

## 9. 授权与推进

- 用户已明确的目标、范围和授权在本任务中持续有效。常规实现、可逆修正和验证在授权范围内推进；需要用户输入的是尚不明确且会影响结果或操作后果的信息。
- 需要澄清或确认时，先完成不依赖该信息的工作，并准备好可审阅的对象、差异和影响说明。已有明确授权不重复索取；实际网关操作按 Skill 中的影响与授权规则执行。
- 遇到失败先定位原因，能在任务范围内修复就继续；没有新依据时不盲目重复操作。只有缺少必要信息、权限或外部条件且无法继续的部分才标为阻塞，不因一次失败停止其余可完成工作。

## 10. 完成、提交与整理

- 用户要求的结果已实现或审查意见已交付，相关行为符合架构约定，受影响文档已同步；通过检查命令本身不能替代目标达成。
- 第 8 节适用的验证已完成。交付时说明实际验证结果；未运行、跳过、失败或受阻的必要验证明确列出，不能表述为全部通过。真实阻塞时交代已完成工作、缺少的条件与受影响结论。
- 有文件修改时审阅本任务 diff，核对范围和敏感信息。只暂存、提交已授权且属于本任务的改动；提交、推送按用户已有授权执行，无需为了交付强制产生 commit 或要求工作树干净。
- 整理限本任务产生的临时文件、测试产物和不再需要的进程；保留用户改动与已有运行服务。为用户保留的预览服务交代地址，不执行无关重构、全仓清理或默认删库。

## 11. 开发阶段数据策略（当前有效）

- 当前仍处于开发阶段、没有正式用户数据；相关 schema 开发任务中允许破坏性变更、删除 `data/gateway.db` 后重建。该许可不作为日常整理或排障的默认步骤。
- 不为历史 v1–v5 数据库保留运行时迁移兼容路径；当前 schema 直接作为全新基线维护。
- 备份格式也以当前开发版为准，不需要兼容正式部署前的旧备份；恢复必须保持“配置全量替换”语义，不能因未分组映射不受分组级联删除而残留旧配置。若未来进入正式部署，由用户另行确认迁移与兼容策略。
