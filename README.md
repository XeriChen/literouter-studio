# LiteRouter Studio — 轻量 LLM Provider 聚合网关

本地部署、单用户、面向可信局域网/本机环境的 OpenAI / Anthropic **原生透传代理网关**。一个 Node 进程同时提供代理入口、管理 API 与 Web 控制台，用模型映射名把客户端请求路由到真实 Provider。

> ⚠️ **安全声明**：网关使用 HTTP 明文传输，Token 与上游 API Key 不受传输层加密保护。仅限可信局域网或本机使用，禁止直接暴露到公网。

## 核心红线

1. **不做协议转换**：OpenAI 与 Anthropic 请求格式互不转换。
2. **仅替换 `model` 与思考等级字段**：映射路由成功后，定点替换顶层 `model` 字符串值；若映射配置了思考等级，仅按配置改写/注入顶层 `thinking`（Anthropic）或 `reasoning_effort`（OpenAI）字段。不重新序列化请求体，也不修改其他字段。
3. **原生透传**：上游 3xx/4xx 状态码与响应体原样转发；仅 5xx 统一包装为 502。

## 功能特性

- OpenAI（`/openai/v1/*`）与 Anthropic（`/anthropic/v1/*`）代理入口，支持 SSE 流式透传；端点路径缺 `/v1` 自动补齐、多重 `/v1` 自动去重
- Provider 管理：按协议自定义分组、表单内新建分组、批量选择/移动/启用/禁用/删除、分组启用滑块、配置复制、API Key 显隐、连通性测试、模型拉取、HTTP 代理、自定义请求头与模型过滤
- 模型管理：手动添加或批量导入、启用/禁用、模型测活、批量操作
- 模型映射：按协议分组、独立启用开关、多个候选目标与手动优先级；每次请求只使用唯一 active 目标；可选思考等级（强制覆盖或仅默认，值为协议原生字段）
- 双轨日志：代理访问日志与配置操作审计日志，支持分页、筛选、刷新和清空
- 配置与备份：监听地址、超时、日志保留、Token 管理，以及配置数据的全量导出/导入
- Playground：直接调用真实网关入口，解析两种协议的 SSE，并按协议与映射名保存本地会话

## 技术栈

| 层 | 技术 |
| :--- | :--- |
| 后端 | Node.js ≥ 24 · TypeScript strict · Hono 4 · better-sqlite3 13 · undici 8 · zod 4 |
| 前端 | React 19 · React Router 8 · Vite 8 · Tailwind CSS 4 · shadcn/ui · TanStack Query · react-markdown |
| 包管理 | pnpm 11.22.0（`packageManager` 已固定；registry 为 `registry.npmmirror.com`） |

## 快速开始

准备 Node.js ≥ 24 与 pnpm 11.22.0，然后在项目根目录执行：

```bash
pnpm install
pnpm dev
```

开发模式会启动后端 `http://127.0.0.1:3000` 与 Vite `http://localhost:5173`；Vite 会把 `/api`、`/openai`、`/anthropic` 代理到后端。

首次运行会在 `data/gateway.db` 的 `settings.admin_token` 中生成随机 UUID。项目不会把 Token 写进仓库；可在项目根目录用下面的命令读取它，再到登录页输入：

```bash
pnpm exec tsx -e "import { getAdminToken } from './src/services/auth.ts'; console.log(getAdminToken())"
```

请勿把命令输出粘贴到源码、Issue、日志或其他不可信位置。

### 生产运行

```bash
pnpm build:web
pnpm start
```

`pnpm start` 直接运行后端 TypeScript 源码，并由 Hono 托管已构建的 `web/dist`。未构建前端时，管理 API 与代理仍可启动，但不会有可用的 Web 控制台。

## 配置生效规则

- 默认监听 `0.0.0.0:3000`。已保存的数据库设置优先于 `HOST`/`PORT` 环境变量，环境变量再优先于默认值。
- `host`、`port` 保存后需重启后端才能重新绑定监听地址。
- `global_timeout_ms` 由后续代理请求读取；Provider 自身的 `timeout_ms` 优先。值为 0 时代理连接/响应头不超时，流式响应体始终不设超时；Provider 连通性测试和模型列表拉取仍有 30 秒兜底。
- `log_retention_days` 在后端启动时清理代理日志和审计日志；0 表示不自动清理。
- 数据库路径是启动进程当前目录下的 `data/gateway.db`，请始终从项目根目录通过 pnpm 脚本启动。
- 当前为无正式用户的开发阶段，schema v6 是直接基线；遇到 schema 不兼容时可删除 `data/gateway.db` 重建，不承诺兼容早期开发版数据库或备份。

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
- 备份包含 Provider 分组、Provider、真实模型、映射分组、全部映射（含未分组映射）、候选目标/优先级、设置、网关 Token 和明文上游 API Key，不包含代理访问日志或配置操作日志。导入会先校验引用与协议关系，再在单个事务内全量替换这些配置数据；既有日志会保留，前端会退出登录，之后须使用备份中的 Token 登录。

## 目录结构

```text
├── src/
│   ├── server.ts         # 入口、监听配置、启动清理与优雅关闭
│   ├── app.ts            # Hono 应用、路由挂载、静态文件与 SPA fallback
│   ├── db/               # SQLite 当前 schema v6 基线
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
├── ARCHITECTURE.md       # 唯一权威设计指南
├── AGENTS.md             # AI 助手开发约定
└── data/                 # 运行时数据库目录（不入库）
```

## 脚本

| 命令 | 说明 |
| :--- | :--- |
| `pnpm dev` | 后端 watch + Vite 开发服务 |
| `pnpm dev:server` | 仅后端（tsx watch，默认 3000） |
| `pnpm dev:web` | 仅前端（Vite，默认 5173） |
| `pnpm typecheck` | TypeScript 类型检查 |
| `pnpm test` | Node 单元测试 |
| `pnpm test:e2e` | Playwright 浏览器测试；先构建 `web/dist`，命令会启动 `pnpm start`，认证用例需 `E2E_GATEWAY_TOKEN`（未提供时跳过） |
| `pnpm check` | 类型检查、单元测试与前端生产构建 |
| `pnpm build:web` | 构建前端到 `web/dist` |
| `pnpm start` | 生产模式运行 API、代理与前端静态站点 |

## 设计文档

- [`ARCHITECTURE.md`](ARCHITECTURE.md)：唯一权威设计指南，包含数据模型、API、代理与备份边界和已知权衡。
- [`AGENTS.md`](AGENTS.md)：面向 AI 助手的实现约定、红线、提交前检查清单和错误码速查。

## License

内部项目，未配置开源许可。
