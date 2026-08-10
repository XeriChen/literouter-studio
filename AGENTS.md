# AGENTS.md — 项目开发约定（AI 助手必读）

本文件为参与本仓库的 AI 助手提供上下文与硬性约定。**先读本文件，再读 `ARCHITECTURE.md`。**

## 1. 权威设计文档

- `ARCHITECTURE.md` 是**唯一权威设计指南**，实现必须以其为准（架构、数据模型、代理管线、红线、已知陷阱）。
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
| `pnpm typecheck` | `tsc --noEmit` 类型检查（提交前必须通过） |
| `pnpm build:web` | 前端构建到 `web/dist` |
| `pnpm start` | 生产模式：Hono 托管 API + 前端静态文件 |

环境约束：Node ≥ 24，统一使用 **pnpm**，必须用 `tsx` 直接运行后端 TS 源码。

## 4. 技术栈

- 后端：TypeScript（strict）、Hono、better-sqlite3、undici、zod
- 前端：React 19、Vite 6、Tailwind CSS 3、shadcn/ui、TanStack Query、react-markdown、react-router 7
- 单包结构，`web/dist` 由 Hono 托管

## 5. 目录职责

| 路径 | 职责 |
| :--- | :--- |
| `src/server.ts` | 入口，读 env 启动 |
| `src/app.ts` | Hono 实例，挂载 `/api`、`/openai`、`/anthropic`，错误中间件，SPA fallback（生产） |
| `src/db/index.ts` | SQLite 初始化：WAL + 外键，schema v1 全量建表建索引，settings 读写助手 |
| `src/middlewares/` | 认证（token 提取校验）/ 错误处理 |
| `src/proxy/` | undici 上游请求，bodyTimeout=0，ProxyAgent 按 proxy_url 缓存，客户端断开 abort |
| `src/providers/` | OpenAI / Anthropic 请求头与 URL 构造 |
| `src/routes/` | 管理 API 路由、代理路由 |
| `src/services/` | 业务层：providers / models / logs（代理访问日志）/ audit（配置操作日志）/ settings / backup / liveness |
| `src/types/` | 行类型：Provider / ProviderModel / Log / Env |
| `web/src/api/` | 前端 API client，Token 存 `localStorage['llm_gateway_token']`，401 自动登出回 `/login` |
| `web/src/pages/` | Login / Providers / Models / Logs / Settings / Playground |

## 6. 硬性约定

- **模型管理 API 一律通过 Request Body 传参**（`provider_id` / `model_id` 放 body，不用路径参数），因 `model_id` 可能含 `/`（如 `openai/gpt-4`）。
- **模型映射是唯一路由入口**：客户端请求的 `model` 字段必须是映射名；新增真实模型/导入时自动建同名映射（`INSERT OR IGNORE`，已有同名映射不覆盖）；映射按 `(protocol, alias_name)` 唯一，两协议命名空间独立。
- 前端 `@/*` 别名指向 `web/src/*`（tsconfig paths + vite alias 已配）。
- 新增 shadcn/ui 组件时用 `pnpm dlx shadcn@latest add ...`，配置见 `components.json`。

## 7. 数据与安全约定

- `data/gateway.db` 不入库（.gitignore），运行时自动创建。
- `admin_token` 存在 `settings.admin_token`，首次启动自动生成 UUID；管理 API 与代理入口统一校验。
- Token 提取优先级：`Authorization: Bearer` > `x-api-key` > `api-key`。
- 备份文件含明文 API Key 与网关 Token；导出/导入均要警示用户。导入成功后前端强制登出并提示用备份内 Token 重新登录。
- 严禁把泄漏密钥/Token 的代码或常量提交进仓库。

## 8. 代理实现陷阱（提交前逐项核对）

- [ ] undici `bodyTimeout` 显式设为 `0`（防流式长连接被掐断）；`connectTimeout`/`headersTimeout` = timeout；timeout 为 0 时三者都为 0
- [ ] 映射路由走 `model_aliases`（协议隔离），模型未启用 404 / Provider 禁用 503；未建映射 404
- [ ] `custom_headers` 禁止覆盖 `authorization` / `x-api-key` / `accept-encoding`
- [ ] 透传保留了客户端 Query String；`base_url` 拼接前去除尾部 `/`
- [ ] 客户端断连（`c.req.raw.signal`）立即 abort 上游请求
- [ ] 日志在收到上游响应头时立即写入，`latency_ms` = 网关收请求到收响应头耗时（首包）
- [ ] 上游 4xx（400/401/429 等）原样透传不重新包装；5xx 才包 `upstream_error`（502）；超时 `upstream_timeout`（504）
- [ ] `accept-encoding: identity` 防止上游压缩破坏 SSE
- [ ] 生产环境 Hono 配 SPA fallback；仅**非 API、非静态资源的 GET** 回 `index.html`；`/api` 未匹配返回 404 JSON
- [ ] 代理请求须用 undici v7 实测口径：超时配置在 Agent/ProxyAgent 构造参数（按 proxy_url+timeout 缓存 dispatcher），`bodyTimeout: 0`；响应 body 为 Node Readable（`dump()` 排空 / `new Response(readable)` 透传）
- [ ] 测活：提示词黑名单（"hi/hello/你好/测试/test/1"），trim 后 ≥4 字符，默认提示词"现在的美国总统是谁"，30s 硬超时

## 8. 错误码速查

| HTTP | code | 触发 |
| :--- | :--- | :--- |
| 400 | `invalid_request_body` | body 非 JSON / 缺 model / 超 50MB（413） |
| 400 | `invalid_test_prompt` | 测活提示词命中黑名单或过短 |
| 401 | `invalid_api_key` | 网关 Token 校验失败 |
| 404 | `model_not_found` | 模型不存在/未启用/未建映射/Provider 不存在 |
| 400 | `alias_exists` | 同协议映射名重复 |
| 503 | `provider_disabled` | 模型启用但 Provider 禁用 |
| 502 | `upstream_error` | 上游不可达 / 拒绝连接 / 5xx |
| 504 | `upstream_timeout` | 连接或头阶段超时 |

## 9. 完成定义

- `pnpm typecheck` 与 `pnpm build:web` 通过
- 第 7 节代理陷阱清单逐项核对通过
- 行为与 `ARCHITECTURE.md` 中 API、错误码、边界行为一致