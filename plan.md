# 轻量 LLM Provider 聚合网关：最终需求与详细实现设计文档 (v1.1)

> **致实现 Agent**：本文档是本项目的唯一权威设计指南。请严格按照本文档定义的架构、业务逻辑、边界条件和实现陷阱进行代码编写。如果实现过程中遇到本文档未覆盖的细节，请遵循“最小可用、原生透传、不修改请求体”的核心原则进行合理推断。

---

## 1. 项目概述与核心原则

本项目旨在开发一个本地部署的轻量级 LLM Provider 聚合网关，供单用户在可信局域网或本机环境使用。

### 1.1 核心定位
- **不是** API 商城、多账号池或计费系统。
- **是** 一个支持 OpenAI / Anthropic 协议的原生透传代理，具备模型管理、Provider 管理、模型测活和简单游乐场（Playground）功能的本地网关。

### 1.2 绝对不可违背的原则（红线）
1. **不做协议转换**：严禁在 OpenAI 和 Anthropic 协议之间进行格式互转。
2. **不修改请求体**：允许读取请求体提取 `model` 字段，但**严禁**修改、增删客户端请求体中的任何字段。
3. **安全声明**：本网关使用 HTTP 明文传输，Token 和上游 API Key 在局域网内裸奔，**仅限在受信任的局域网或本机环境使用**。

---

## 2. 技术栈与项目结构

### 2.1 技术栈
- **后端**：Node.js 24 LTS, TypeScript, Hono, `better-sqlite3`, `undici`, `zod`
- **前端**：React, Vite, TypeScript, Tailwind CSS, `shadcn/ui`, TanStack Query, `react-markdown` (用于 Playground)
- **包管理**：pnpm (配置国内镜像 `https://registry.npmmirror.com`)

### 2.2 项目目录结构
采用单仓库结构，生产环境下由 Hono 同时提供 API 和前端静态文件。

```text
llm-gateway/
├── package.json
├── tsconfig.json
├── vite.config.ts
├── tailwind.config.ts
├── data/                  # 运行时数据目录
│   └── gateway.db         # SQLite 数据库文件
├── src/                   # 后端源码
│   ├── server.ts          # 入口文件，启动 HTTP 服务
│   ├── app.ts             # Hono 应用实例与路由挂载
│   ├── db/                # 数据库初始化与迁移
│   ├── middlewares/       # 认证、日志、错误处理中间件
│   ├── proxy/             # 核心代理逻辑 (headers, body, upstream, dispatcher)
│   ├── providers/         # Provider 协议特定逻辑 (OpenAI/Anthropic 请求构造)
│   ├── routes/            # API 路由与代理路由定义
│   ├── services/          # 业务逻辑层 (providers, models, logs, backup, settings, liveness)
│   └── types/             # TypeScript 类型定义
└── web/                   # 前端源码
    ├── index.html
    ├── src/
    │   ├── main.tsx
    │   ├── App.tsx
    │   ├── api/           # 前端 API Client
    │   ├── components/    # UI 组件 (ChatUI, MarkdownRenderer)
    │   └── pages/         # 页面 (Login, Providers, Models, Logs, Settings, Playground)
    └── dist/              # 前端构建产物 (生产环境由 Hono 托管)
```

---

## 3. 数据库设计 (SQLite)

使用 `better-sqlite3`，开启 WAL 模式和外键约束。

### 3.1 表结构定义

#### `schema_version` (用于未来数据库迁移)
```sql
CREATE TABLE IF NOT EXISTS schema_version (
  version INTEGER PRIMARY KEY
);
INSERT INTO schema_version (version) VALUES (1);
```

#### `providers`
```sql
CREATE TABLE IF NOT EXISTS providers (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  protocol TEXT NOT NULL CHECK (protocol IN ('openai', 'anthropic')),
  base_url TEXT NOT NULL,
  auth_json TEXT NOT NULL,
  custom_headers_json TEXT NOT NULL DEFAULT '{}',
  proxy_url TEXT,
  timeout_ms INTEGER,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
```

#### `provider_models`
```sql
CREATE TABLE IF NOT EXISTS provider_models (
  provider_id TEXT NOT NULL,
  model_id TEXT NOT NULL,
  display_name TEXT,
  enabled INTEGER NOT NULL DEFAULT 0,
  source TEXT NOT NULL DEFAULT 'manual' CHECK (source IN ('fetched', 'manual')),
  fetched_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (provider_id, model_id),
  FOREIGN KEY (provider_id) REFERENCES providers(id) ON DELETE CASCADE
);
```

#### `settings`
```sql
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
```

#### `logs`
```sql
CREATE TABLE IF NOT EXISTS logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at TEXT NOT NULL,
  client_ip TEXT,
  protocol TEXT,
  method TEXT,
  path TEXT,
  model TEXT,
  provider_id TEXT,
  status INTEGER,
  latency_ms INTEGER,
  error_code TEXT
);
```

### 3.2 索引优化
为防止全表扫描，必须创建以下索引：
```sql
CREATE INDEX IF NOT EXISTS idx_models_model_id_protocol ON provider_models(model_id, enabled);
CREATE INDEX IF NOT EXISTS idx_logs_created ON logs(created_at DESC);
```

---

## 4. 核心业务逻辑

### 4.1 认证与 Token 管理
- **全局单 Token**：所有管理 API 和代理入口均需校验 `admin_token`。
- **提取规则**：按优先级从 `Authorization: Bearer <token>`、`x-api-key: <token>`、`api-key: <token>` 中提取。
- **首次启动**：自动生成随机 UUID 作为 `admin_token` 存入 `settings`。

### 4.2 模型路由与同名互斥（核心）
路由键定义为：$$ routeKey = (protocol, model\_id) $$

#### 同名模型互斥规则（严格限制在同协议内）
当在 Web UI 中启用某个 Provider 的某个 Model 时，**仅禁用同协议下其他 Provider 的同名模型**，跨协议不互斥。
**执行 SQL 逻辑**：
```sql
BEGIN TRANSACTION;

-- 1. 禁用同协议下的同名模型
UPDATE provider_models SET enabled = 0
WHERE model_id = ? 
  AND provider_id IN (
    SELECT id FROM providers WHERE protocol = ?
  );

-- 2. 启用目标模型
UPDATE provider_models SET enabled = 1
WHERE provider_id = ? AND model_id = ?;

COMMIT;
```

### 4.3 模型拉取与更新规则
- **拉取来源**：OpenAI 请求 `{base_url}/models`，Anthropic 请求 `{base_url}/v1/models`。
- **更新规则**：
  - 若模型不存在：插入新记录，`enabled = 0` (默认禁用)，`source = 'fetched'`。
  - 若模型已存在：**保持 `source` 和 `enabled` 状态不变**，仅更新 `fetched_at` 时间戳。
- **删除规则**：允许删除任何模型（包括 `fetched`）。若删除了 `fetched` 模型，下次拉取时会以 `enabled=0` 的状态重新出现。

### 4.4 测试连接逻辑 (网络连通性)
测试 Provider 连通性时，发送对应的 `/models` 请求：
- **网络可达**：收到任何 HTTP 响应（包括 404 Not Found）均视为网络可达。
- **认证失败**：收到 401 / 403。
- **不可达/错误**：网络异常、超时或 5xx 错误。

### 4.5 模型测活 (Liveness Testing)
用于验证模型是否真实可用（具备生成能力），而非仅仅网络连通。
- **提示词限制**：禁止使用 "hi", "hello", "你好", "测试", "test", "1" 等无意义短词。后端需维护一个黑名单，并要求 `prompt.trim().length >= 4`。
- **默认提示词**：若未提供 prompt，默认使用 **“现在的美国总统是谁”**。
- **绕过严格策略**：测活接口允许测试未在网关中启用的模型，只要 Provider 本身启用且配置正确即可。
- **超时控制**：测活请求硬编码超时时间为 **30秒**，防止模型卡死导致接口一直 pending。
- **执行逻辑**：后端根据 Provider 协议，自动构造非流式 (`stream: false`) 的 Chat 请求发给上游，并同步返回结果。

---

## 5. 代理转发机制 (Proxy)

### 5.1 统一代理入口
- **OpenAI**：`ALL /openai/v1/*` (支持 `/chat/completions`, `/responses`, `/models`)
- **Anthropic**：`ALL /anthropic/*` (支持 `/v1/messages`, `/v1/models`)
- **不支持的端点**：除 `GET /models` 外的其他 GET 请求（如 retrieve model），或不带 `model` 字段的 POST 请求，一律返回 `400 invalid_request_body` 或 `405 Method Not Allowed`。

### 5.2 请求处理流水线
1. **校验 Token**：中间件拦截并校验。
2. **读取 Body**：按原始字节读取，限制最大 **50MB**。超限返回 `413 Payload Too Large`。
3. **解析 Model**：尝试 JSON 解析并提取顶层 `model` 字段。失败则返回 `400`。
4. **路由查找**：
   - 查找 `provider_models` 中 `enabled=1` 且 `model_id` 匹配的记录。
   - 检查所属 `provider` 是否 `enabled=1`。
   - 若模型不存在或未启用，返回 `404 model_not_found`。
   - 若模型存在但 Provider 被禁用，返回 `503 provider_disabled`。
5. **构造上游请求**：
   - **URL 拼接**：自动去除 `base_url` 尾部的 `/`。原样保留并拼接客户端的 **Query String**。
   - **超时控制**：优先使用 Provider 的 `timeout_ms`，否则用全局 `global_timeout_ms`。`0` 表示不超时。

### 5.3 请求头 (Headers) 构造规则
- **保留**：`content-type`, `accept`, `user-agent`, `openai-organization`, `anthropic-beta` 等业务头。
- **删除**：`host`, `connection`, `keep-alive`, `content-length`, `transfer-encoding`, `authorization`, `x-api-key`, `api-key`。
- **强制注入**：
  - 强制设置 `accept-encoding: identity` (防止上游压缩破坏 SSE)。
  - OpenAI 注入 `Authorization: Bearer <token>`。
  - Anthropic 注入 `x-api-key: <key>` 和 `anthropic-version: <version>`。
- **`custom_headers` 规则**：
  - 允许覆盖普通业务头。
  - **严禁**覆盖认证头（`authorization`, `x-api-key`）和流式控制头（`accept-encoding`）。若配置中包含这些保留头，网关应直接忽略或报错。
- **`anthropic-version` 冲突**：Provider 配置的版本**优先级最高**，强制覆盖客户端传入的值。

### 5.4 undici 请求配置与超时陷阱（关键）
使用 `undici` 发起上游请求时，**必须**显式配置超时参数，防止流式响应被意外掐断：
```typescript
{
  connectTimeout: timeout,   // 连接阶段超时
  headersTimeout: timeout,   // 等待响应头超时
  bodyTimeout: 0,            // 【关键】必须显式设为 0 禁用，否则长流会被中途杀死
  maxRedirections: 0         // 不跟随 3xx 重定向，原样透传给客户端
}
```
*注：当 `timeout_ms = 0` 时，上述三个超时参数均设为 0。*

### 5.5 客户端断连处理 (Abort)
必须监听客户端连接关闭事件（如 Hono 的 `c.req.raw.signal` 或 Node 的 `close` 事件）。一旦检测到客户端断开，**立即 abort 上游 `undici` 请求**，防止白白消耗上游 Token。

### 5.6 响应转发与日志写入
- **透传**：保留上游 HTTP 状态码（包括 3xx/4xx/5xx），原样流式透传响应体，不修改 JSON，不重新编码 SSE。删除 `connection`, `keep-alive` 等 hop-by-hop 响应头。
- **日志写入时机**：在**收到上游响应头时立即写入**日志。`latency_ms` 记录从网关收到请求到收到上游响应头的耗时（首包耗时），流式传输过程不计入。

---

## 6. 管理 API 设计

所有 `/api/*` 接口需校验 Token（`POST /api/login` 除外）。统一返回 `{ ok: true, data: {} }` 或 `{ error: { message, type, code } }`。

### 6.1 核心 API 列表
- **Auth**: `POST /api/login`, `GET /api/me`, `POST /api/token/reset`
- **Settings**: `GET /api/settings`, `PUT /api/settings` (修改 host/port 需重启生效)
- **Providers**: `GET/POST /api/providers`, `GET/PUT/DELETE /api/providers/:id`, `POST /api/providers/:id/test` (网络连通性), `POST /api/providers/:id/fetch-models`
- **Logs**: `GET /api/logs` (支持分页/筛选), `DELETE /api/logs`

### 6.2 模型管理 API (避免 URL 斜杠问题)
为防止 `model_id` 包含 `/` (如 `openai/gpt-4`) 破坏路径参数解析，**模型操作一律通过 Request Body 传参**：
- **获取列表**：`GET /api/models`
- **手动添加**：`POST /api/models` (Body: `{ provider_id, model_id, display_name }`)
- **更新状态**：`PATCH /api/models` (Body: `{ provider_id, model_id, enabled }`) -> *后端在此处执行同协议互斥逻辑*
- **删除模型**：`DELETE /api/models` (Body: `{ provider_id, model_id }`)

### 6.3 备份与恢复
- **导出**：`GET /api/backup` (返回包含 settings, providers, models, token 的 JSON，不含 logs)。
- **导入**：`POST /api/backup` (全量覆盖 settings, providers, models, token。在事务中执行，失败则回滚。不影响 logs)。

### 6.4 模型测活 API
- **接口**：`POST /api/models/test`
- **Body**：
  ```json
  {
    "provider_id": "string",
    "model_id": "string",
    "prompt": "string (optional)"
  }
  ```
- **校验**：若 `prompt` 命中黑名单（如 "hi", "你好"）或长度过短，返回 `400 invalid_test_prompt`。若未传，使用默认提示词。
- **执行**：后端构造非流式请求发给上游，超时 30s。
- **Response**：
  ```json
  {
    "ok": true,
    "data": {
      "reply": "模型回复内容",
      "latency_ms": 1234
    }
  }
  ```

---

## 7. 前端 Web UI 设计

### 7.1 全局与路由
- **Token 存储**：登录成功后存入 `localStorage` (`llm_gateway_token`)。
- **401 拦截**：API Client 收到 401 时，自动清除本地 Token 并跳转至登录页。
- **SPA Fallback**：生产环境下，Hono 托管 `web/dist` 时，对于非 API、非静态资源的 GET 请求，**统一 fallback 返回 `index.html`**，防止深链接刷新 404。

### 7.2 页面功能要求
- **Login**: 输入 Token 验证。
- **Providers**: 增删改查、测试连接（网络）、拉取模型、配置代理/超时/自定义头。
- **Models**: 列表展示、按协议/Provider筛选、启用/禁用（触发互斥）、手动添加/删除、**模型测活（弹窗输入提示词或点击快速测活）**。
- **Logs**: 分页表格、多条件筛选、一键清空。限制最多展示 10000 条。
- **Settings**: 修改监听地址/端口/全局超时、查看/重置 Token、导入/导出备份。
- **Playground (游乐场)**：
  - **功能**：提供简单的 Chat UI，直接与网关代理的模型对话。
  - **布局**：左侧/顶部为配置区（选择 Protocol, Provider, Model），主区域为聊天记录，底部为输入框。
  - **切换逻辑**：切换 Protocol 或 Model 时，**自动清空当前聊天记录**，确保协议和上下文匹配。
  - **核心实现**：前端**直接调用网关的代理入口**（`/openai/v1/chat/completions` 或 `/anthropic/v1/messages`），携带网关 Token，处理 SSE 流式响应。
  - **SSE 解析**：前端需实现两个简单的 Parser，分别处理 OpenAI (`data: {"choices":...}`) 和 Anthropic (`event: content_block_delta\ndata: {"delta":...}`) 的流式格式，并使用 `react-markdown` 渲染回复。

### 7.3 关键 UX 交互
1. **备份导出警告**：点击导出时，必须弹出强警告：“备份文件包含所有 Provider 的明文 API Key 和网关 Token，请妥善保管，切勿泄露”。
2. **备份导入后登出**：导入备份成功后，前端必须**强制清除本地 Token 并跳转到登录页**，并提示：“配置已恢复，请使用备份中的 Token 重新登录”。
3. **测活提示词校验**：在 Models 页面点击测活时，若用户输入 "hi" 等短词，前端应直接拦截并提示“请使用更具实质内容的提示词进行测试”。

---

## 8. 错误码与异常处理

代理入口错误优先使用 OpenAI 风格返回：
```json
{
  "error": {
    "message": "具体错误描述",
    "type": "error_type",
    "code": "error_code"
  }
}
```

### 标准错误码映射
| HTTP 状态码 | 错误码 (code) | 触发条件 |
| :--- | :--- | :--- |
| 400 | `invalid_request_body` | Body 非 JSON、缺失 `model` 字段、或超过 50MB |
| 400 | `invalid_test_prompt` | 测活提示词命中黑名单或长度过短 |
| 401 | `invalid_api_key` | 网关 Token 校验失败 |
| 404 | `model_not_found` | 模型不存在、未启用，或所属 Provider 不存在 |
| 503 | `provider_disabled` | 模型存在且启用，但所属 Provider 被禁用 |
| 502 | `upstream_error` | 上游网络不可达、连接拒绝、或返回 5xx |
| 504 | `upstream_timeout` | 连接或等待响应头阶段超时 |

*注：若上游返回 4xx 错误（如 400, 401, 429），网关**不重新包装**，直接原样透传上游的状态码和响应体。*

---

## 9. 实现陷阱与检查清单 (Checklist)

在提交代码前，请实现 Agent 自行核对以下关键点：

- [ ] `undici` 的 `bodyTimeout` 是否显式设置为 `0`？
- [ ] 同名模型互斥 SQL 是否限制了 `protocol` 作用域？
- [ ] `custom_headers` 是否被拦截，防止覆盖 `authorization` 和 `accept-encoding`？
- [ ] 代理转发是否原样保留了 Query String？
- [ ] `base_url` 拼接前是否去除了尾部的 `/`？
- [ ] 模型管理 API 是否改为了 Body 传参以支持带 `/` 的 `model_id`？
- [ ] 是否监听了客户端断连事件并 abort 了上游请求？
- [ ] 日志是否在收到响应头时立即写入，且 `latency_ms` 计算正确？
- [ ] `ProxyAgent` 是否实现了按 `proxy_url` 缓存复用？
- [ ] 生产环境 Hono 是否配置了 SPA 路由 fallback？
- [ ] 数据库是否创建了 `model_id` 和 `created_at` 的索引？
- [ ] 导入备份后，前端是否执行了登出跳转逻辑？
- [ ] 模型测活是否实现了提示词黑名单校验和 30s 硬编码超时？
- [ ] Playground 是否正确处理了 OpenAI 和 Anthropic 两种不同的 SSE 流式格式？