# LLM Gateway — 轻量 LLM Provider 聚合网关

本地部署、单用户、面向可信局域网/本机环境的 OpenAI / Anthropic **原生透传代理网关**。
提供 Provider 管理、模型管理、模型测活、请求日志、配置备份与一个简单 Playground。

> ⚠️ **安全声明**：网关使用 HTTP 明文传输，Token 与上游 API Key 在局域网内裸奔，
> **仅限在受信任的局域网或本机环境使用**，请勿暴露到公网。

## 核心红线（不可违背）

1. **不做协议转换**：严禁在 OpenAI 与 Anthropic 协议之间互转请求体。
2. **不修改请求体**：只允许读取 body 提取 `model` 字段，严禁增删改任何字段。
3. **原生透传**：上游状态码与响应体一律原样转发。

## 功能特性

- OpenAI（`/openai/v1/*`）与 Anthropic（`/anthropic/*`）统一代理入口，SSE 流式透传
- Provider 管理：增删改查、网络连通性测试、模型拉取、代理与自定义请求头
- 模型管理：手动添加/导入模型自动生成同名映射；模型映射按协议隔离，客户端仅通过映射名调用；模型测活（30s 硬超时）
- 日志：模型访问日志与网站配置操作日志双 tab，分页/筛选/一键清空
- 配置备份导出/导入（含 Token 与明文 API Key，请妥善保管）
- Playground：直接调用网关代理入口的简单 Chat UI，支持两种协议 SSE 解析

## 技术栈

| 层 | 技术 |
| :--- | :--- |
| 后端 | Node.js 24 LTS · TypeScript · Hono · better-sqlite3 · undici · zod |
| 前端 | React 19 · Vite · Tailwind CSS 3 · shadcn/ui · TanStack Query · react-markdown |
| 包管理 | pnpm（registry 已配置国内镜像 `registry.npmmirror.com`） |

## 快速开始

```bash
pnpm install        # 安装依赖（使用国内镜像）
pnpm dev            # 同时启动后端 (3000) 与前端 dev server (5173)
```

- 首次启动会自动生成随机 Token 存入 `data/gateway.db`，用于登录与所有 API 校验。
- 浏览器访问 `http://localhost:5173`，在登录页输入该 Token。
- 修改监听 host/port 或全局超时后，需重启后端进程生效。

**生产构建：**

```bash
pnpm build:web      # 构建前端到 web/dist
pnpm start          # 由 Hono 同时托管 API 与前端静态文件
```

## 目录结构

```text
├── src/                  # 后端源码
│   ├── server.ts         # 入口，启动 HTTP 服务
│   ├── app.ts            # Hono 应用与路由挂载
│   ├── db/               # SQLite 初始化与 schema（WAL + 外键）
│   ├── middlewares/      # 认证 / 错误处理
│   ├── proxy/            # 核心代理（undici 上游请求）
│   ├── providers/        # OpenAI / Anthropic 协议构造
│   ├── routes/           # /api 管理路由 与 代理路由
│   ├── services/         # providers / models / logs / audit / settings / backup / liveness
│   └── types/            # 类型定义
├── web/                  # 前端源码（构建产物 web/dist 由 Hono 托管）
│   ├── src/api/          # API Client（localStorage 存 Token，401 自动登出）
│   ├── src/components/   # ChatUI / MarkdownRenderer / Layout
│   └── src/pages/        # Login / Providers / Models / Logs / Settings / Playground
└── data/                 # 运行时数据（gitignore），gateway.db 存放于此
```

## 脚本

| 命令 | 说明 |
| :--- | :--- |
| `pnpm dev` | 开发模式（后端 watch + Vite，含 /api 代理） |
| `pnpm dev:server` | 仅后端（tsx watch，默认 3000） |
| `pnpm dev:web` | 仅前端（Vite，默认 5173） |
| `pnpm typecheck` | TypeScript 类型检查 |
| `pnpm build:web` | 构建前端到 `web/dist` |
| `pnpm start` | 生产模式运行（需先 build:web） |

## 设计与实现

- **架构与设计文档**：`ARCHITECTURE.md`（数据模型、代理管线、API 速查、实现陷阱）。
- 面向实现 Agent 的约定见 `AGENTS.md`。

## License

内部项目，未配置开源许可。