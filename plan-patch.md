# plan.md 实现对照与补丁说明 (plan-patch)

> **性质**：本文件是 `plan.md` (v1.1) 的**补充补丁**，不修改 plan.md 原文。
> 记录了实现过程中发现的行为偏差、plan 未覆盖的推断点、依赖层关键陷阱与后续优化建议。
> 优先级低于 plan.md；与 plan.md 冲突时，以本文件"偏差声明"为准（均已标注理由）。

---

## 1. 当前实现进度总结（后端 100%）

| 模块 | 状态 | 说明 |
| :--- | :--- | :--- |
| 数据库 schema v1 | ✅ | 5 表 + 2 索引，WAL + 外键，`data/gateway.db` 自动建 |
| 认证 | ✅ | Bearer > x-api-key > api-key；首启自动生成 UUID；`/api/login` 免校验 |
| Provider CRUD / 测连 / 拉模型 | ✅ | 测连：任意响应可达；401/403 认证失败；拉取：新增 enabled=0，已有只刷 fetched_at |
| 模型管理 / 同名互斥 | ✅ | 同协议内事务互斥；列表联表返回 provider_name/protocol/provider_enabled |
| 代理管线 | ✅ | 50MB 上限、body 提取 model、404/503 路由、透传 3xx/4xx、5xx 包装 502、首包日志 |
| 日志 / 备份 / 测活 / 设置 | ✅ | 日志响应头时写入；备份含 token 全量覆盖；测活黑名单 + 30s 硬超时；host/port 重启生效 |
| 前端 | ⏳ | UI 组件与 Login/Providers/Models/Logs 已完成；Settings/Playground 待写 |

端到端已实测：登录、建 Provider、测连、拉模型、启用、代理 Chat 透传、互斥、
4xx 透传 / 405 / 413 / 400、GET /models、测活（黑名单拦截）、备份导出导入换 Token。

---

## 2. 与 plan.md 的行为偏差（实现为准）

| # | plan.md 原文 | 实际实现 | 理由 |
| :--- | :--- | :--- | :--- |
| D1 | 超 50MB 返回 400 `invalid_request_body`（错误码表里标注 413） | 返回 **413** + `invalid_request_body` | 遵循错误码表内 "(413)" 标注 |
| D2 | 代理 5xx 包装 502 `upstream_error` | 直接**丢弃**上游响应体后返回网关 JSON | 5xx 无透传价值，省带宽 |
| D3 | 409 未定义 | 模型启用等 PATCH 目标行不存在时**静默成功**（UPDATE 0 行） | **已修复**：返回 404 `model_not_found` |
| D4 | 日志表写入时机 | 代理日志在路由内写（非中间件），API 日志由中间件写；`GET /api/logs` 等读操作也产生日志 | **已修复**：API 日志仅记非 GET |
| D5 | 生产 SPA fallback "非静态 GET 回 index.html" | `/api` 未匹配返回 404 JSON，仅非 API 路径回 index.html | 遵循 plan.md §7.1 原文 |
| D6 | OpenAI 入口 `ALL /openai/v1/*` | 实际接受 `/openai/*` 任意路径（去掉前缀后透传） | **已修复**：严格限 `/openai/v1/*`，其他 404 |

---

## 3. plan.md 未覆盖的推断点（实现已选型，记录备查）

| # | 推断点 | 实现选择 |
| :--- | :--- | :--- |
| I1 | `GET /v1/models` 转发到哪个 Provider？ | 该协议**第一个 enabled=1 的 Provider**（无则 404） |
| I2 | anthropic-version 未配置时默认值 | `2023-06-01` |
| I3 | 拉取/测连上游超时 | provider.timeout_ms ?? 全局；外加 `AbortSignal.timeout` 兜底 |
| I4 | Provider `auth` 字段格式 | `{"api_key": "..."}`；anthropic 可加 `{"version": "..."}` 覆盖默认 |
| I5 | 日志中 API 请求的 protocol 列 | NULL（代理请求才记 openai/anthropic） |
| I6 | 备份导入后 Provider/Model 的 created_at | 重置为导入时刻 |
| I7 | PATCH `/api/models` 在 Provider 禁用时 | 允许启用模型（代理时仍会 503） |

---

## 4. 依赖层关键陷阱（实现期实测发现，写代码前必读）

### 4.1 undici v7 API 变化（与 plan.md §5.4 描述不同）
- `request(url, options)` **不再接受** `connectTimeout` / `headersTimeout` / `bodyTimeout` / `maxRedirections`。
  这些必须配置在 **Agent / ProxyAgent / Client** 构造参数上。
- 因此实现为：**按 (proxy_url, timeout_ms) 缓存 dispatcher**（`src/proxy/index.ts`），
  `bodyTimeout: 0` 恒设，`connectTimeout = headersTimeout = timeout`（0 即全部 0）。
- 3xx 重定向：undici v7 默认不跟随，天然满足"原样透传"。

### 4.2 响应体类型
- undici v7 响应 body 是 **Node Readable**（BodyReadable），不是 Web ReadableStream：
  - 排空用 `body.dump()`（无则 `destroy()`），**没有 `.cancel()`**；
  - 透传用 `new Response(readable as unknown as BodyInit)`（Node 自动转换）。

### 4.3 超时错误识别
- 超时错误 `code` 为 `UND_ERR_CONNECT_TIMEOUT` / `UND_ERR_HEADERS_TIMEOUT`（→ 504 `upstream_timeout`）；
- 客户端断连为 `UND_ERR_ABORTED` / `AbortError`（→ 直接重抛，不写日志不响应）。

### 4.4 日志写入位置
- 首包日志必须在收到上游响应头时写，因此写在 `src/routes/proxy.ts` 的转发函数内，
  由 handler 在响应头到达时立即 `writeLog`，`latency_ms` 为 startedAt→headerAt。

---

## 5. 建议补丁（P1-P5，实现期发现的改进点，非阻塞）

| # | 建议 | 影响 |
| :--- | :--- | :--- |
| P1 | **✅ 已实施**：PATCH `/api/models` 目标行不存在时返回 404 `model_not_found`，避免前端误以为成功 | 后端 3 行 |
| P2 | **✅ 已实施**：API 日志只记**非 GET**（跳过 `/api/logs`、`/api/me` 等读请求的自污染） | 后端 2 行 |
| P3 | **✅ 已实施**：OpenAI 入口严格校验 `upstreamPath.startsWith('/v1/')`，否则 404 | 后端 3 行 |
| P4 | 日志表增加保留策略（如 7 天/1 万条自动裁剪），当前只靠前端分页 | 后续版本 |
| P5 | `GET /v1/models` 支持查询参数 `?provider_id=` 显式指定 Provider | 后续版本 |

---

## 6. 已知设计权衡（非缺陷，记录决策）

1. **x-api-key 双义性**：网关 Token 提取含 `x-api-key`（plan 规定），而 Anthropic 客户端
   默认用 `x-api-key` 发上游 Key —— 两者冲突时会被当作网关 Token 校验失败。
   **结论**：Anthropic SDK 用户必须改用 `Authorization: Bearer <网关 Token>`（SDK 支持自定义请求头）。
2. **明文安全**：HTTP + 明文 Key 为 plan 红线规定，README/登录页均需持续警示。
3. **单进程**：better-sqlite3 不支持多实例共享，保持单进程运行。

---

## 7. 待办（前端剩余）

- [ ] Settings 页：host/port/全局超时编辑、Token 查看/重置、备份导出（强警告）与导入（成功后登出）
- [ ] Playground：协议/Provider/Model 选择 + ChatUI + OpenAI/Anthropic 双 SSE 解析 + react-markdown
- [ ] `web/src/api/client.ts` 已在 `fetch` 层实现 401 自动登出
- [ ] AGENTS.md 需同步修正一处与 plan 矛盾的口径（SPA fallback：`/api` 未匹配应 404 而非回 index.html）

---

## 8. 变更记录

| 日期 | 版本 | 内容 |
| :--- | :--- | :--- |
| 2026-08-07 | v0.1 | 初稿：后端实现对照 + 偏差声明 + 依赖陷阱 + 建议补丁 |
