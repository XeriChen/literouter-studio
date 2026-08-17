# 架构与设计文档

> 面向后来维护者的精简指南：先读 README（使用），再读本文档（设计），最后看代码。
> 更新时间：2026-08-09（v4 配置操作日志已落地）

---

## 1. 定位与红线

轻量 LLM 聚合网关：一个进程同时提供 OpenAI / Anthropic 兼容的代理入口 + Web 管理界面。
客户端只认识「模型映射名」，网关把请求路由到真实 Provider。

**三条红线（改动代码前必读）：**

1. **不做协议转换**：严禁在 OpenAI / Anthropic 之间互转请求格式。
2. **仅替换 model 字段**：客户端请求体的 `model` 是映射名，网关路由成功后只把该字段替换为真实模型名（`proxy.ts`），严禁增删改其他任何字段。
3. **明文传输**：HTTP 明文，仅限可信局域网/本机，不做加密。

---

## 2. 技术栈与运行

| 层 | 技术 |
| :--- | :--- |
| 后端 | Node ≥ 24、TypeScript strict、Hono、better-sqlite3、undici v8、zod |
| 前端 | React 19、Vite 8、Tailwind 4、shadcn/ui、TanStack Query、react-router 7 |

- 单包仓库，`web/dist` 由 Hono 托管（生产 `pnpm start`）。
- 开发：`pnpm dev` = 后端 3000（tsx watch）+ 前端 5173（Vite，`/api`、`/openai`、`/anthropic` 已代理到 3000）。
- 强制 `tsx` 直接跑 TS，禁止编译后端到 JS 再跑。
- 提交前必须过：`pnpm typecheck`（`tsc --noEmit`）、`pnpm build:web`。

## 3. 目录结构

```
src/
  server.ts        入口：读 settings 的 host/port 启动（保存后需重启生效）
  app.ts           Hono 实例：挂载 /api、/openai、/anthropic，生产 SPA fallback
  db/index.ts      SQLite 初始化 + 版本化迁移（当前 schema v4）
  middlewares/     认证（Bearer > x-api-key > api-key）
  providers/       请求头构造（parseAuth/parseCustomHeaders，禁覆盖 authorization 等）
  proxy/           undici 上游请求：按 (proxy_url, timeout) 缓存 dispatcher
  routes/api.ts    管理 API 装配入口（领域路由位于 routes/api/*）
  routes/proxy.ts  代理入口流水线（路由、透传、日志）
  services/        providers / models（含映射层）/ logs / audit / settings / backup / liveness / auth
  types/           行类型
web/src/
  api/             fetch client（Token 存 localStorage['llm_gateway_token']，401 自动登出）
  pages/           Login / Providers / Models（两 tab：模型映射 + 真实模型）/ Logs（两 tab）/ Settings / Playground
  components/      ChatUI（SSE 双协议解析）等
data/gateway.db    运行时自动创建（不入库）
```

## 4. 数据模型（schema v4）

| 表 | 说明 |
| :--- | :--- |
| `providers` | 上游 Provider：protocol(openai/anthropic)、base_url、auth_json、custom_headers_json、proxy_url、timeout_ms、model_filter、enabled |
| `provider_models` | 真实模型：PK(provider_id, model_id)，enabled、source(fetched/manual) |
| `model_aliases` | **映射层**：PK(protocol, alias_name)，指向 (provider_id, model_id)；外键级联删除 |
| `settings` | key/value：admin_token、host、port、global_timeout_ms |
| `logs` | 代理访问日志（模型请求），latency_ms 为首包耗时 |
| `audit_logs` | 配置操作日志（管理 API 增删改/测活/备份/登录等），字段：resource/target/action/detail/status |

迁移方式：`schema_version` 表记录版本，`db/index.ts` 里按 `if (currentVersion < N)` 逐段升级。

## 5. 核心概念：模型映射（路由键）

客户端请求到网关时，`model` 字段的值是**映射名**，不是真实模型名。

- 映射名按 `(protocol, alias_name)` 唯一，两协议各自独立命名空间。
- `GET /openai/v1/models`（及 anthropic 对应入口）只返回当前协议中可用的映射名：需 Provider 已启用且目标模型已启用才可见；不可用的对客户端隐藏（调用时仍按现有 503/404 处理）。
- 未建立映射的模型（或直接写真实模型名）→ `404 model_not_found`。
- 映射指向的 Provider 被禁用 → `503 provider_disabled`；目标模型被禁用 → `404`。
- 自动建映射：导入模型（`import-models`）与手动添加模型时自动生成同名映射；已存在同名映射则不覆盖（保留用户自定义映射）—— `INSERT OR IGNORE`。
- 删除真实模型/Provider 时映射随外键级联删除。
- 手动添加模型默认 enabled=1（开箱即用）。

### 管理 API（前缀 `/api`，请求体传参，不用路径参数 —— model_id 可能含 `/`）

| 端点 | 用途 |
| :--- | :--- |
| `GET/POST/PATCH/DELETE /providers`、`GET/PUT/DELETE /providers/:id` | Provider CRUD（部分 PUT 更新） |
| `POST /providers/:id/test` | 测连通性（/models 任意响应即可达） |
| `POST /providers/:id/upstream-models` | 拉上游模型列表（known 不落库） |
| `POST /providers/:id/import-models` | body `{model_ids:[...]}`，落库 + 自动建同名映射 |
| `GET/POST/PATCH/DELETE /models` | 真实模型 CRUD（body：provider_id+model_id） |
| `GET /aliases` `POST/PATCH/DELETE /aliases` | 映射 CRUD，POST 校验目标存在且启用 |
| `POST /models/test` | 测活：body `{provider_id, model_id, prompt}` |
| `GET/PUT /settings`、`GET /me`、`POST /token/reset` | 配置、Token 查看/重置 |
| `GET/POST /backup` | 导出/导入（含明文 Token 与 Key，强警示，导入后前端强制登出） |
| `GET /logs`、`DELETE /logs` | 代理访问日志分页/清空 |
| `GET /audit-logs`、`DELETE /audit-logs` | 配置操作日志分页（可按 resource 筛）/清空 |

### 错误码（管理 API 返回 `{ok:false, error:{code}}`；代理返回裸 JSON）

| HTTP | code | 触发 |
| :--- | :--- | :--- |
| 400 | `invalid_request_body` | body 非 JSON / 缺 model / 参数非法 |
| 401 | `invalid_api_key` | Token 校验失败 |
| 404 | `model_not_found` / `provider_not_found` / `alias_not_found` | 不存在（含模型未启用） |
| 400 | `alias_exists` | 同协议映射名重复 |
| 503 | `provider_disabled` | 模型启用但 Provider 禁用 |
| 502 | `upstream_error` | 上游不可达 / 拒绝连接 / 5xx |
| 504 | `upstream_timeout` | 连接或头阶段超时 |

## 6. 代理管线（routing/proxy + proxy/）

```text
请求 → auth 校验(token) → 50MB 上限 → body JSON 解析提取 model
     → model 查映射(model_aliases) → 找到 → 校验 provider.enabled
     → 构造上游 URL(保留 query string, base_url 去尾部 '/')
     → undici 请求(dispatcher 按 proxy_url+timeout 缓存)
     → 收到响应头 → 立即写日志(latency = 收请求→响应头)
     → 原样透传(3xx/4xx 透传；5xx 包装 502 丢弃 body；超时 504)
```

**陷阱清单（改代理代码必逐条核对）：**

1. undici v8：超时配置在 **Agent 构造参数**（`connectTimeout`/`headersTimeout`/`bodyTimeout:0` 恒设，timeout=0 时全 0），`request()` 层不接收这些参数。
2. 响应 body 是 Node Readable：排空用 `.dump()`，透传 `new Response(readable)`。
3. `accept-encoding: identity` 防上游压缩破坏 SSE。
4. 客户端断连（`c.req.raw.signal`）立即 abort 上游；AbortError 静默，不写日志。
5. `custom_headers` 禁覆盖 `authorization` / `x-api-key` / `accept-encoding`。
6. 日志在收到响应头时立即写入（首包），`latency_ms`=请求→响应头。
7. 生产 SPA fallback：仅非 `/api`、非静态资源的 GET 回 index.html；`/api` 未匹配 404 JSON。

### 测活（liveness）

提示词黑名单（hi/hello/你好/测试/test/1），trim 后 ≥4 字符；默认「现在的美国总统是谁」；30s 硬超时。

## 7. 前端要点

- Token 存 `localStorage['llm_gateway_token']`，`api()` 自动注入 Bearer；401 自动清 Token 回 `/login`。
- Models 页两个 tab：**模型映射**（复制映射名、新建/删除，新建时校验目标已启用）与**真实模型**（拉取/手动添加/启用/测活/批量）。
- Logs 页两个 tab：**代理访问**（模型请求，原筛选/清空）与**配置操作**（审计日志：按资源类型筛，操作/详情/状态，独立清空）。
- Playground：选协议 → 选映射 → ChatUI 发送时 `model` 字段 = 映射名。
- shadcn 组件新增用 `pnpm dlx shadcn@latest add ...`；`@/*` 别名指向 `web/src/*`。

## 8. 已知权衡与陷阱（决策留痕）

1. **x-api-key 冲突**：网关 Token 提取含 `x-api-key`，而 Anthropic 客户端默认用它发上游 Key → Anthropic 客户端须用 `Authorization: Bearer <网关 Token>`。
2. **单进程约束**：better-sqlite3 不支持多实例共享，只能单进程运行。
3. **日志增长**：启动时按 `log_retention_days`（默认 30，settings 可配）清理过期日志（代理日志与配置操作日志同步清理）；运行期无自动裁剪，条数上限策略未实施。
4. 停止网关时代理日志 `status` 会记录网关进程退出码（非代理错误）。
5. **配置操作日志（audit_logs）**：管理 API 各写操作端点显式写入（`src/routes/api/*` 调用 `writeAuditLog`），无请求体记录（detail 只含变更字段名与可见值，不含 API Key/Token 明文）；登录成败、Token 重置、备份导入导出、日志清空亦有记录；代理入口与管理 API 之间无隐式日志中间件。
