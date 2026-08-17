# AGENTS.md — 项目开发约定（AI 助手必读）

本文件为参与本仓库的 AI 助手提供上下文与硬性约定。**先读本文件，再读 `ARCHITECTURE.md`。**

## 1. 权威设计文档

- `ARCHITECTURE.md` 是**唯一权威设计指南**，实现必须以其为准（架构、数据模型、代理管线、红线、已知陷阱）。
- `README.md` 面向部署与使用者，`AGENTS.md` 面向参与开发的 AI 助手；实现行为变化时先更新 `ARCHITECTURE.md`，再同步另外两份文档中受影响的说明。
- 遇到文档未覆盖的细节时，遵循核心原则推断：**最小可用、原生透传、不修改请求体**。

## 2. 红线（绝对不可违背）

1. **不做协议转换**：严禁在 OpenAI / Anthropic 之间互转请求格式。
2. **仅替换 model 字段**：映射名请求经网关转发时，只允许把 body 的 `model` 字段替换为真实模型名（`proxy.ts` 路由成功后执行），严禁增删改其他任何字段。
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
| `pnpm check` | 类型检查 + 单元测试 + 前端生产构建（提交前必须通过） |
| `pnpm build:web` | 前端构建到 `web/dist` |
| `pnpm start` | 生产模式：Hono 托管 API + 前端静态文件 |

环境约束：Node ≥ 24，统一使用 **pnpm 11.22.0**（见 `packageManager`），必须用 `tsx` 直接运行后端 TS 源码。

## 4. 技术栈

- 后端：TypeScript（strict）、Hono、better-sqlite3、undici v8、zod
- 前端：React 19、Vite 8、Tailwind CSS 4、shadcn/ui、TanStack Query、react-markdown、react-router 8
- 单包结构，`web/dist` 由 Hono 托管

## 5. 目录职责

| 路径 | 职责 |
| :--- | :--- |
| `src/server.ts` | 入口；监听配置按数据库 settings > env > 默认值解析，启动时清日志并处理优雅关闭 |
| `src/app.ts` | Hono 实例，挂载 `/api`、`/openai`、`/anthropic`，错误中间件，SPA fallback（生产） |
| `src/db/index.ts` | SQLite 初始化：WAL + 外键，当前 schema v6 基线（开发期可删库重建），settings 读写助手 |
| `src/middlewares/` | 认证（token 提取校验）/ 错误处理 |
| `src/proxy/` | 请求体限流/定点 model 替换、undici 上游请求、dispatcher 按 `(proxy_url, timeout)` 缓存 |
| `src/providers/` | OpenAI / Anthropic 请求头与 URL 构造 |
| `src/routes/` | 管理 API 装配与领域路由、代理入口流水线 |
| `src/services/` | 业务层：providers / models / logs（代理访问日志）/ audit（配置操作日志）/ settings / backup / liveness |
| `src/types/` | 行类型：ProviderGroup / Provider / ProviderModel / ModelAliasGroup / ModelAlias / ModelAliasTarget / Log / Audit / Env |
| `web/src/api/` | 前端 API client，Token 存 `localStorage['llm_gateway_token']`，401 自动登出回 `/login` |
| `web/src/pages/` | Login / Home / Providers / Models（映射 + 真实模型）/ Logs / Settings / Playground |

## 6. 硬性约定

- **凡需指定真实模型的管理 API 一律通过 Request Body 传参**（`provider_id` / `model_id` 放 body，不用路径参数），因 `model_id` 可能含 `/`（如 `openai/gpt-4`）；`GET /api/models` 仅列出模型，不需要 body。
- **Provider 分组只用于管理展示**：按协议隔离，每个 Provider 最多归属一个组；删除分组只解除归属，批量删除成员才会删除 Provider 及其关联数据，分组本身不参与代理路由。
- **模型映射是唯一路由入口**：客户端请求的 `model` 字段必须是映射名；每个映射可绑定多个候选但只路由到唯一 active 目标，严禁请求期轮询/随机/故障转移；新增真实模型/导入时为同名映射追加 inactive 候选且不覆盖 active；映射按 `(protocol, alias_name)` 唯一，两协议命名空间独立。
- OpenAI 代理入口严格限定为 `/openai/v1/*`；Anthropic 使用 `/anthropic/v1/*`。除 `GET */v1/models` 外，代理只接受 POST。
- 前端 `@/*` 别名指向 `web/src/*`（tsconfig paths + vite alias 已配）。
- 新增 shadcn/ui 组件时用 `pnpm dlx shadcn@latest add ...`，配置见 `components.json`。

## 7. 数据与安全约定

- `data/gateway.db` 不入库（.gitignore），按进程当前工作目录解析并在运行时自动创建。
- `admin_token` 存在 `settings.admin_token`，首次启动自动生成 UUID；管理 API 与代理入口统一校验。
- Token 提取优先级：`Authorization: Bearer` > `x-api-key` > `api-key`。
- 备份文件含明文 API Key 与网关 Token，但不含代理访问日志和配置操作日志；导出/导入均要警示用户。导入会先校验数据图，再在事务内全量替换 Provider 分组、Provider、真实模型、映射分组、全部映射（含未分组映射）和候选目标，应用备份设置与 Token；成功后前端强制登出并提示用备份内 Token 重新登录。
- `host`/`port` 保存后需重启；`global_timeout_ms` 对后续代理请求生效；`log_retention_days` 在下次启动清理时生效。
- 严禁把泄漏密钥/Token 的代码或常量提交进仓库。

## 8. 代理实现陷阱（提交前逐项核对）

- [ ] undici `bodyTimeout` 显式设为 `0`（防流式长连接被掐断）；`connectTimeout`/`headersTimeout` = timeout；timeout 为 0 时三者都为 0
- [ ] 映射路由走 `model_aliases.enabled + model_alias_targets.active`（协议隔离），请求期绝不尝试其他候选；模型未启用 404 / Provider 禁用 503；未建映射 404
- [ ] `custom_headers` 禁止覆盖 `authorization` / `x-api-key` / `api-key` / `accept-encoding`
- [ ] 透传保留了客户端 Query String；`base_url` 拼接前去除尾部 `/`
- [ ] 客户端断连（`c.req.raw.signal`）立即 abort 上游请求
- [ ] 日志在收到上游响应头时立即写入，`latency_ms` = 网关收请求到收响应头耗时（首包）；上游 5xx 的日志 status 保留上游状态码
- [ ] 上游 3xx/4xx（400/401/429 等）原样透传不重新包装；5xx 才包 `upstream_error`（502）；超时 `upstream_timeout`（504）
- [ ] `accept-encoding: identity` 防止上游压缩破坏 SSE
- [ ] 生产环境 Hono 配 SPA fallback；仅**非 API、非静态资源的 GET** 回 `index.html`；`/api` 未匹配返回 404 JSON
- [ ] 代理请求须用 undici v8 实测口径：超时配置在 Agent/ProxyAgent 构造参数（按 proxy_url+timeout 缓存 dispatcher），`bodyTimeout: 0`；响应 body 为 Node Readable（`dump()` 排空 / `new Response(readable)` 透传）
- [ ] `GET */v1/models` 只返回映射、active 目标、Provider 与真实模型均启用的映射名；其他非 POST 代理请求返回 405
- [ ] 模型测活：提示词黑名单（"hi/hello/你好/测试/test/1"），trim 后 ≥4 字符，默认提示词"现在的美国总统是谁"，30s 硬超时
- [ ] Provider 连通性测试：401/403 判认证失败，其他 HTTP 响应判网络可达；配置超时为 0 时仍有 30s AbortSignal 兜底

## 9. 错误码速查

| HTTP | code | 触发 |
| :--- | :--- | :--- |
| 400 | `invalid_request_body` | body 非 JSON、参数非法或代理请求缺少有效 model |
| 413 | `invalid_request_body` | 请求体超过 50 MiB |
| 400 | `invalid_test_prompt` | 测活提示词命中黑名单或过短 |
| 400 | `invalid_backup` | 备份内部引用、协议或候选关系不合法 |
| 401 | `invalid_api_key` | 网关 Token 校验失败 |
| 404 | `model_not_found` | 模型不存在、未启用或未建映射 |
| 404 | `provider_not_found` / `provider_group_not_found` / `alias_not_found` / `alias_group_not_found` / `alias_target_not_found` | 管理 API 目标不存在 |
| 400 | `provider_group_exists` / `alias_exists` / `alias_group_exists` / `alias_target_exists` | 同协议 Provider 分组名、映射名/分组名或映射候选重复 |
| 404 | `not_found` | `/api` 未匹配或 OpenAI 代理路径不在 `/openai/v1/*` |
| 405 | `method_not_allowed` | 模型列表以外的代理请求使用非 POST 方法 |
| 503 | `provider_disabled` | 模型启用但 Provider 禁用 |
| 502 | `upstream_error` | 代理上游不可达/拒绝连接/5xx，或管理侧上游调用失败 |
| 504 | `upstream_timeout` | 代理连接/响应头阶段或管理侧上游调用超时 |
| 500 | `internal_error` | 未处理的网关内部异常 |

## 10. 完成定义

- `pnpm check` 通过；涉及浏览器行为或生产托管时再运行 `pnpm test:e2e`
- 第 8 节代理陷阱清单逐项核对通过
- 行为与 `ARCHITECTURE.md` 中 API、错误码、边界行为一致

## 11. 开发阶段数据策略（当前有效）

- 当前仍处于开发阶段、没有正式用户数据；允许破坏性 schema 变更、删除 `data/gateway.db` 后重建。
- 不为历史 v1–v5 数据库保留运行时迁移兼容路径；当前 schema 直接作为全新基线维护。
- 备份格式也以当前开发版为准，不需要兼容正式部署前的旧备份；恢复必须保持“配置全量替换”语义，不能因未分组映射不受分组级联删除而残留旧配置。若未来进入正式部署，由用户另行确认迁移与兼容策略。
