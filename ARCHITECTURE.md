# 架构与设计文档

> 面向后来维护者的精简指南：先读 README（使用），再读本文档（设计），最后看代码。
> 更新时间：2026-08-24（已与 schema v8、思考等级改写、Provider/映射分组、多候选目标、全量备份恢复、React Router 8、请求体安全边界及运行时生命周期实现核对）

---

## 1. 定位与红线

轻量 LLM 聚合网关：一个进程同时提供 OpenAI / Anthropic 兼容的代理入口 + Web 管理界面。
客户端只认识「模型映射名」，网关把请求路由到真实 Provider。

**三条红线（改动代码前必读）：**

1. **不做协议转换**：严禁在 OpenAI / Anthropic 之间互转请求格式。
2. **仅替换 model 与思考等级字段**：客户端请求体的 `model` 是映射名，网关路由成功后只把该字段替换为真实模型名（`proxy.ts`）；若映射配置了思考等级，仅按配置定点改写/注入顶层 `thinking`（Anthropic）或 `reasoning_effort`（OpenAI）字段。严禁增删改其他任何字段。
3. **明文传输**：HTTP 明文，仅限可信局域网/本机，不做加密。

---

## 2. 技术栈与运行

| 层 | 技术 |
| :--- | :--- |
| 后端 | Node ≥ 24、TypeScript strict、Hono 4、better-sqlite3 13、undici 8、zod 4 |
| 前端 | React 19、Vite 8、Tailwind 4、shadcn/ui、TanStack Query、react-router 8 |

- 单包仓库；Node ≥ 24，包管理器固定为 pnpm 11.22.0；`web/dist` 由 Hono 托管（生产 `pnpm start`）。
- 开发：`pnpm dev` = 后端 3000（tsx watch）+ 前端 5173（Vite，`/api`、`/openai`、`/anthropic` 已代理到 3000）。
- 强制 `tsx` 直接跑 TS，禁止编译后端到 JS 再跑。
- `pnpm test` 运行 Node 原生测试；`pnpm test:e2e` 用 Playwright 启动生产服务执行浏览器冒烟测试。
- 提交前必须过：`pnpm check`（`typecheck` + 单元测试 + `build:web`）。

启动与关闭约定：数据库 `settings` 中已持久化的 `host`/`port` 优先于 `HOST`/`PORT` 环境变量，再回退到 `0.0.0.0:3000`；端口必须是 1–65535 的整数，否则使用 3000。`host`/`port` 保存后需重启，`global_timeout_ms` 在后续代理请求读取，`log_retention_days` 只在启动清理时使用（0 表示不清理）。收到 `SIGTERM`/`SIGINT` 后先等待 HTTP server 关闭，再释放 dispatcher 缓存和 SQLite；5 秒后仍未结束则强制退出。

## 3. 目录结构

```
src/
  server.ts        入口：读 settings 的 host/port 启动（保存后需重启生效）
  app.ts           Hono 实例：挂载 /api、/openai、/anthropic，生产 SPA fallback
  db/index.ts      SQLite 初始化 + 当前 schema v8 基线（开发期允许删库重建，v6→v7、v7→v8 保留守卫式加列）
  middlewares/     认证（Bearer > x-api-key > api-key）
  providers/       请求头构造（parseAuth/parseCustomHeaders，禁覆盖 authorization 等）
  proxy/           undici 上游请求与请求体解析：按 (proxy_url, timeout) 缓存 dispatcher
  routes/api.ts    管理 API 装配入口（领域路由位于 routes/api/*）
  routes/api/*     auth、providers、models、settings、logs、backup 领域路由
  routes/proxy.ts  代理入口流水线（路由、透传、日志）
  services/        providers / models（含映射层）/ logs / audit / settings / backup / liveness / auth
  types/           行类型
web/src/
  api/             fetch client（Token 存 localStorage['llm_gateway_token']，401 自动登出）
  pages/           Login / Home / Providers（分组管理）/ Models（映射 + 真实模型）/ Logs / Settings / Playground
  pages/ModelAliases.tsx  分组列表、映射开关、候选优先级/当前目标与快速测活
  components/      ChatUI（SSE 双协议解析）等
  lib/sse.ts       跨网络 chunk 的 OpenAI / Anthropic SSE 增量解析器
test/              Node 单元测试与 test/e2e/ Playwright 冒烟测试
data/gateway.db    按 process.cwd() 定位并在运行时自动创建（不入库）
```

## 4. 数据模型（schema v8）

| 表 | 说明 |
| :--- | :--- |
| `provider_groups` | Provider 管理分组：PK(protocol, id)，同协议组名唯一；只用于管理展示 |
| `providers` | 上游 Provider：可选归组，protocol(openai/anthropic)、base_url、auth_json、custom_headers_json、proxy_url、timeout_ms、model_filter、enabled |
| `provider_models` | 真实模型：PK(provider_id, model_id)，display_name、enabled、source(fetched/manual)、fetched_at |
| `model_alias_groups` | 映射分组：PK(protocol, id)，同协议组名唯一；只用于管理展示 |
| `model_aliases` | **映射层**：PK(protocol, alias_name)，可归组，拥有独立 enabled 开关；`thinking_json` 为可选思考等级配置（`{mode:override/default, value:协议原生值}`） |
| `model_alias_targets` | 映射候选：指向真实模型，带 priority/active；每个映射最多一个 active |
| `settings` | key/value：admin_token、host、port、global_timeout_ms、log_retention_days |
| `logs` | 代理访问日志（模型请求），latency_ms 为首包耗时；model=请求映射名，provider_name/resolved_model=实际路由的提供商名与真实模型名（冗余存储，删除 Provider/真实模型后日志仍可读） |
| `audit_logs` | 配置操作日志（管理 API 增删改/测活/备份/登录等），字段：resource/target/action/detail/status |

当前处于无正式用户的开发阶段，schema v8 直接作为基线；破坏性变更允许删除 `data/gateway.db` 重建，不保留历史 v1–v5 运行时迁移路径（仅保留 v6→v7、v7→v8 的守卫式加列）。正式部署前需重新确认迁移与兼容策略。

## 5. 核心概念：模型映射（路由键）

Provider 分组按协议隔离，每个 Provider 最多属于一个组。分组不参与代理查询和请求转发；删除分组只把成员移到“未分组”。批量启用会启用组内当前禁用的 Provider，批量删除会删除组内 Provider 及其模型/候选目标并保留空组，随后按既有规则修复映射 active 目标。

客户端请求到网关时，`model` 字段的值是**映射名**，不是真实模型名。

- 映射名按 `(protocol, alias_name)` 唯一，两协议各自独立命名空间；分组也按协议隔离，创建/归组本身不改变调用。
- 映射可绑定多个真实模型候选，`priority` 越小越优先，但请求只读取唯一 `active=1` 目标；严禁按请求轮询、随机或故障转移。
- 映射有独立 `enabled` 开关；`GET /openai/v1/models` 与 `GET /anthropic/v1/models` 只返回映射、active 目标、Provider 与真实模型均启用的映射名。
- 未建立映射的模型（或直接写真实模型名）→ `404 model_not_found`。
- 映射指向的 Provider 被禁用 → `503 provider_disabled`；目标模型被禁用 → `404`。
- 自动建映射：启用的 Provider 新增/导入模型时自动生成同名映射；已有同名映射时只追加 inactive 候选，不切换 active。导入会启用新模型，也会重新启用已存在的目标模型。
- 删除/禁用 active 真实模型或 Provider 时，在配置事务内按 priority 选择首个可用候选；重新启用旧目标不回切。没有可用候选则映射保留但不可调用。
- 删除分组会级联删除组内映射；“清空组内映射”批量操作可保留空分组。
- 手动添加模型默认 enabled=1（开箱即用）。
- 映射可选配**思考等级**（`thinking`）：`{mode, value}`，`value` 是协议原生值 —— Anthropic 为 `thinking` 对象（如 `{"type":"enabled","budget_tokens":2048}` 或 `{"type":"disabled"}`），OpenAI 为 `reasoning_effort` 字符串（如 `"high"`）。`override` = 无条件替换/注入对应顶层字段；`default` = 仅在客户端未携带该字段时注入；不配置 = 原样透传。管理 API 的 `POST/PATCH /aliases` 用 `thinking` 字段配置（PATCH 传 `null` 清除），value 形状在入库前按协议校验。

### 管理 API（前缀 `/api`，请求体传参，不用路径参数 —— model_id 可能含 `/`）

`POST /api/login` 是唯一公开的管理端点；其余管理端点统一经过认证中间件。管理端请求体与代理请求体共用 50 MiB 上限和流式读取器，非法 JSON、空 body 或超限统一返回 `invalid_request_body`（超限 HTTP 413）。

| 端点 | 用途 |
| :--- | :--- |
| `GET/POST /providers`、`GET/PUT/DELETE /providers/:id` | Provider CRUD（支持可空 group_id；PUT 为部分更新，protocol 不可修改） |
| `GET/POST/PATCH/DELETE /provider-groups` | Provider 分组 CRUD；删除组只解除成员归属 |
| `POST /provider-groups/batch-enable`、`POST /provider-groups/batch-toggle`、`POST /provider-groups/batch-delete` | 原子批量启用/禁用或清空组内 Provider，清空后保留分组 |
| `POST /providers/:id/test` | 测连通性：401/403 判认证失败，其他 HTTP 响应判网络可达 |
| `POST /providers/:id/upstream-models` | 拉上游模型 ID 列表并应用 model_filter，仅返回、不落库 |
| `POST /providers/:id/import-models` | body `{model_ids:[...]}`，落库 + 自动建同名映射 |
| `GET /models`、`POST/PATCH/DELETE /models` | 真实模型列表与变更；变更请求 body 传 `provider_id+model_id` |
| `GET /aliases`、`POST/PATCH/DELETE /aliases` | 映射 CRUD；支持 enabled、分组、重命名、当前目标兼容字段与思考等级（PATCH 传 null 清除） |
| `GET/POST/PATCH/DELETE /alias-groups` | 分组 CRUD；删除分组连同组内映射删除 |
| `POST /alias-groups/batch-enable`、`POST /alias-groups/batch-delete` | 原子批量启用或清空组内映射 |
| `POST/PATCH/DELETE /alias-targets`、`POST /alias-targets/reorder` | 候选新增、设为 active、删除与 priority 重排 |
| `POST /models/test` | 测活：body `{provider_id, model_id, prompt?, thinking?}`，thinking 为映射同款思考配置（value 按协议校验并注入测活请求体） |
| `GET/PUT /settings`、`GET /me`、`POST /token/reset` | 配置、Token 查看/重置 |
| `GET/POST /backup` | 导出/导入配置（含明文 Token 与 Key，不含两类日志）；导入校验后在事务内全量替换配置，成功后前端强制登出 |
| `GET /logs`、`DELETE /logs` | 代理访问日志分页/清空 |
| `GET /audit-logs`、`DELETE /audit-logs` | 配置操作日志分页（可按 resource 筛）/清空 |

`/api` 下未匹配的路径返回 JSON `not_found`，不会落入前端 SPA 回退。

### 错误码与响应外形

管理 API 使用 `{ok:false,error:{message,type,code}}`；代理流水线产生的路由、上游和方法错误使用 `{error:{message,type,code}}`。认证中间件同时用于两类入口，因此代理 Token 校验失败仍返回前一种带 `ok:false` 的外形。

| HTTP | code | 触发 |
| :--- | :--- | :--- |
| 400 | `invalid_request_body` | body 非 JSON、缺有效 model 或参数非法 |
| 413 | `invalid_request_body` | 请求体超过 50 MiB |
| 400 | `invalid_test_prompt` | 测活提示词过短或命中黑名单 |
| 400 | `invalid_backup` | 备份结构通过请求校验，但内部引用、协议或候选关系不合法 |
| 401 | `invalid_api_key` | Token 校验失败 |
| 404 | `model_not_found` / `provider_not_found` / `provider_group_not_found` / `alias_not_found` | 不存在（含模型未启用） |
| 404 | `alias_group_not_found` / `alias_target_not_found` | 映射分组或候选目标不存在 |
| 400 | `provider_group_exists` / `alias_exists` / `alias_group_exists` / `alias_target_exists` | 同协议 Provider 分组名、映射名/分组名或候选目标重复 |
| 404 | `not_found` | `/api` 未匹配或 OpenAI 代理路径不在 `/openai/v1/*` |
| 405 | `method_not_allowed` | 模型列表以外的代理请求使用非 POST 方法 |
| 503 | `provider_disabled` | 模型启用但 Provider 禁用 |
| 502 | `upstream_error` | 代理上游不可达/拒绝连接/5xx，或管理侧上游调用失败 |
| 504 | `upstream_timeout` | 代理连接/响应头阶段或管理侧上游调用超时 |
| 500 | `internal_error` | 未处理的网关内部异常 |

## 6. 代理管线（routing/proxy + proxy/）

入口约束：OpenAI 仅接受 `/openai/v1/*`；Anthropic 使用 `/anthropic/v1/*`。两协议的 `GET */v1/models` 是网关本地生成的映射列表，不请求上游；其余代理请求只接受 POST，其他方法返回 405。

```text
POST 请求 → auth 校验(token) → 50 MiB 上限 → body JSON 解析提取 model
     → model 查已启用映射 + 唯一 active 候选 → 找到 → 校验 provider.enabled
     → 构造上游 URL(保留 query string, base_url 去尾部 '/')
     → undici 请求(dispatcher 按 proxy_url+timeout 缓存)
     → 收到响应头 → 立即写日志(latency = 收请求→响应头)
     → 原样透传(3xx/4xx 透传；5xx 包装 502 丢弃 body；超时 504)
```

### 请求体与响应边界

- `src/proxy/body.ts` 先按 `Content-Length` 快速拒绝超限请求，再通过 `ReadableStream` 分块读取，累计超过 50 MiB 时立即取消读取。
- 代理只接受顶层 JSON object 且 `model` 必须是非空字符串。解析器保留原文中顶层 `model` 字符串及 `thinking`/`reasoning_effort` 值的字节范围，路由成功后做定点替换（模型名恒替换；思考字段按映射配置的 override/default 改写，缺失时在对象开头注入）；不重新序列化 JSON，因此空白、字段顺序、数字精度、转义和其他同名字段都保持不变。重复键遵循 `JSON.parse` 的最后一个键语义；思考字段重复时仅替换最后一次出现的值。
- 上游响应 body 是 Node `Readable`：成功与 3xx/4xx 响应用 `new Response(readable)` 透传，5xx 或无需返回 body 时调用 `.dump()` 排空；上游缺少 `content-type` 时默认补 `application/json`。
- 上游 3xx/4xx 保留状态码与响应体；5xx 转为 502 `upstream_error`；连接/响应头阶段超时转为 504 `upstream_timeout`。客户端断连触发 abort，`app.onError` 生成内部 499 响应并抑制噪音错误日志。
- 转发请求丢弃 hop-by-hop、客户端认证和 `content-length`，强制 `accept-encoding: identity`；Provider 认证头最后写入，`custom_headers` 不能覆盖 `authorization`、`x-api-key`、`api-key` 或 `accept-encoding`。
- 收到上游响应头即写访问日志：`latency_ms` 是首包耗时，`status` 记录上游原始状态，`model` 记请求的映射名，`provider_name` / `resolved_model` 记实际路由的提供商名称与真实模型名（冗余落库）。因此上游 5xx 虽向客户端转换为 502，日志仍保留实际的上游 5xx；映射/超时等网关失败则记录网关状态与 `error_code`。

### 生产静态资源与 SPA 回退

`app.ts` 以 `import.meta.dirname` 为基准定位 `web/dist`，并防止路径穿越。`/api`、`/openai`、`/anthropic` 网关前缀永不回退到 `index.html`；带文件扩展名的缺失静态资源返回 404，只有非网关、非静态资源的 GET 客户端路由才回退到 `index.html`。静态文件按扩展名设置内容类型和缓存策略。

**陷阱清单（改代理代码必逐条核对）：**

1. undici v8：超时配置在 **Agent 构造参数**（`connectTimeout`/`headersTimeout`/`bodyTimeout:0` 恒设，timeout=0 时全 0），`request()` 层不接收这些参数。
2. 响应 body 是 Node Readable：排空用 `.dump()`，透传 `new Response(readable)`。
3. `accept-encoding: identity` 防上游压缩破坏 SSE。
4. 客户端断连（`c.req.raw.signal`）立即 abort 上游；AbortError 静默，不写日志。
5. `custom_headers` 禁覆盖 `authorization` / `x-api-key` / `api-key` / `accept-encoding`。
6. 日志在收到响应头时立即写入（首包），`latency_ms`=请求→响应头。
7. 生产 SPA fallback：仅非 `/api`、非静态资源的 GET 回 index.html；`/api` 未匹配 404 JSON。

### 测活（liveness）

模型测活提示词黑名单（hi/hello/你好/测试/test/1），trim 后 ≥4 字符；默认「现在的美国总统是谁」；30s 硬超时。管理路由会校验真实模型存在且 Provider 启用；真实模型未启用仍允许测活。测活按真实 `provider_id + model_id` 调用，不经过映射层；请求体可显式携带 `thinking` 配置，value 校验后按协议注入测活请求体（Anthropic `thinking` / OpenAI `reasoning_effort`），映射页的快速测活会自动带上该映射的思考等级。

测活按 Provider 协议构造非流式 Chat/Messages 请求并解析回复。Provider 模型列表拉取和连通性测试复用认证头与 `(proxy_url, timeout)` dispatcher；Provider/全局超时为 0 时，代理请求不设连接/响应头超时，但这两类管理操作仍以 30s `AbortSignal` 兜底。

## 7. 前端要点

- Token 存 `localStorage['llm_gateway_token']`，`api()` 自动注入 Bearer；401 自动清 Token 回 `/login`。
- Providers 页按协议和自定义分组折叠展示，支持新增 Provider 时就地创建分组、跨分组批量选择启用/禁用/删除/移动，以及用分组滑块统一控制启用状态；批量移动要求所选 Provider 协议一致，目标也只能是同协议分组或未分组；复制 Provider 会预填新增表单但不复制模型或映射，API Key 输入默认隐藏并可临时查看。
- Provider 新增、编辑与复制共用视口限高弹窗；表单内容独立滚动，标题和底部操作区保持可见，确保移动端可完整填写和提交。
- Models 页两个 tab：**模型映射**（按协议折叠分组、映射启用开关、候选展开管理/拖拽优先级、当前目标切换与快速测活）与**真实模型**（搜索/筛选、手动添加、启用/禁用、测活、批量操作）；新增候选时 Provider 与目标模型必须启用且协议一致。
- Logs 页两个 tab：**代理访问**（协议/Provider/模型/状态筛选、手动刷新、清空）与**配置操作**（按资源类型筛选、手动刷新、独立清空）。
- Playground：只展示映射、active 目标、Provider 与真实模型均启用的项目；ChatUI 发送时 `model` 字段仍为映射名。
- `ChatUI` 使用 `SseDeltaParser` 处理任意网络 chunk 边界、CRLF、多个 `data:` 行和没有尾部分隔符的最终事件；按 `protocol + alias` 将对话持久化到 `localStorage`。
- Settings 页可查看/复制/重置 Token；重置后当前前端会用新 Token 续期，备份导入则清除本地 Token 并强制回登录页。
- shadcn 组件新增用 `pnpm dlx shadcn@latest add ...`；`@/*` 别名指向 `web/src/*`。

## 8. 已知权衡与陷阱（决策留痕）

1. **x-api-key 冲突**：网关 Token 提取含 `x-api-key`，而 Anthropic 客户端默认用它发上游 Key → Anthropic 客户端须用 `Authorization: Bearer <网关 Token>`。
2. **单进程约束**：应用按单进程运行设计，未实现多进程间的连接池、关闭流程或配置变更协调；不要用 cluster/多实例共享同一运行目录。
3. **日志增长**：启动时按 `log_retention_days`（默认 30，settings 可配）清理过期日志（代理日志与配置操作日志同步清理）；运行期无自动裁剪，条数上限策略未实施。
4. **客户端断连**：收到上游响应头前断连不会写代理访问日志；若响应头已经收到，访问日志已经按上游状态落库。内部 499 只用于中止后的错误处理，不代表一定存在一条 status=499 的访问日志。
5. **配置操作日志（audit_logs）**：管理 API 各写操作端点显式写入（`src/routes/api/*` 调用 `writeAuditLog`），无请求体记录（detail 只含变更字段名与可见值，不含 API Key/Token 明文）；登录成败、Token 重置、备份导入导出、代理日志清空有记录。清空审计日志本身不会再写一条审计记录，否则清空后会立即残留新记录。
6. **请求体原样保留的边界**：只有合法 JSON object 且顶层存在非空字符串 `model` 的代理请求可以路由；除 `model` 与映射配置的思考字段（Anthropic `thinking` / OpenAI `reasoning_effort`）外，网关不会尝试修复或重写其他 JSON 结构，超过 50 MiB 的请求在读取阶段拒绝。管理侧测活仍不经映射层，但支持在请求体中显式携带 `thinking` 配置（前端映射快速测活会自动带上）。
7. **dispatcher 生命周期**：Provider 的 `proxy_url` 或 `timeout_ms` 变化、Provider 删除及进程关闭都会清空 dispatcher 缓存；缓存键为 `(proxy_url, timeout_ms)`，`bodyTimeout` 永远为 0。
8. **运行目录影响数据位置**：SQLite 使用 `process.cwd()/data/gateway.db`，生产静态文件则相对 `src/app.ts` 定位；应通过仓库脚本从项目根目录启动，避免误用另一份数据库。
9. **备份恢复是配置全量替换**：导入前先校验 Provider 分组、Provider、真实模型、映射分组、映射与候选目标之间的数据图；事务内必须先删除全部 `model_aliases`（包括 `group_id IS NULL` 的未分组映射），再按外键顺序重建两类分组、Provider、模型、映射与候选。备份使用独立 `provider_groups` 字段保存 Provider 分组，原 `groups` 仍表示映射分组；不包含 `logs` / `audit_logs`，导入不会清空既有日志；导入成功以及进入数据图校验后发生的失败会另写一条审计日志。
