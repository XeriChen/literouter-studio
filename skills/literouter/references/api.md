# literouter 管理 API 参考（agent 操作规范本体）

与网关 `src/routes/api/*` 的实现一一对应；字段名以 `src/routes/api/shared.ts` 的 zod schema 为准。
本文档是规范本体：未来 CLI / MCP 工具面按此表的操作名一一映射实现。

## 0. 通用约定

- Base URL：本机网关通常为 `http://127.0.0.1:3000`（实际监听地址由 settings 或 `HOST`/`PORT` 环境变量决定，见 `src/server.ts`）；站点不在本机时向用户索取。
- 认证：所有 `/api` 请求（除 `POST /api/login`）带 `Authorization: Bearer <管理Token>`。
- **指定真实模型一律用 Request Body 传参**（`provider_id` / `model_id` 放 body，不用路径参数），因为 `model_id` 可能含 `/`（如 `openai/gpt-4`）。
- 响应外形统一为 `{"ok":true,"data":…}` 或 `{"ok":false,"error":{"message","type","code"}}`；排错先读 `error.code` 对照第 7 节。
- curl 写请求模板（body 走 stdin，避免密钥进 shell 历史）：

```bash
curl -sS -X POST "$BASE_URL/api/providers" \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  --data-binary @- <<'JSON'
{ "name": "示例", "protocol": "openai", "base_url": "https://api.example.com/v1" }
JSON
```

- 危险级别图例：🟢 免确认直接执行；🔴 先向用户复述影响并获确认后执行。

## 1. 引导与查询（全部 🟢）

| 操作 | 端点 | 说明 |
| :--- | :--- | :--- |
| 验证 Token | `GET /api/me` | 返回 `{token}`，成功即引导完成 |
| 换取会话 | `POST /api/login` | body `{token}`；agent 一般不需要，直接用 Bearer |
| Provider 列表 | `GET /api/providers` | ⚠️ `auth` 字段回显明文 Key |
| Provider 详情 | `GET /api/providers/:id` | 同上 |
| Provider 分组列表 | `GET /api/provider-groups` | |
| 真实模型列表 | `GET /api/models` | 含 enabled/source/display_name |
| 映射列表 | `GET /api/aliases` | 含 targets 数组（priority/active）及内联 provider_name/provider_enabled/target_enabled，可直接判断可路由性 |
| 映射分组列表 | `GET /api/alias-groups` | |
| 读设置 | `GET /api/settings` | host/port/global_timeout_ms/log_retention_days |
| 代理访问日志 | `GET /api/logs?page=&page_size=&protocol=&provider_id=&model=&status=` | model=映射名；provider_name/resolved_model=实际路由 |
| 配置操作日志 | `GET /api/audit-logs?page=&page_size=&resource=` | resource 可选 provider/model/alias/… |

Provider 对象字段：`id, name, protocol(openai|anthropic), group_id, base_url, auth(键值对), custom_headers(键值对), proxy_url, timeout_ms, model_filter, enabled(0|1)`。

- `timeout_ms`：`null` = 用全局 `global_timeout_ms`；`0` = 永不超时（连接/响应头仍受管理操作 30s 兜底）；正整数 = 毫秒。
- ⚠️ **Provider 名称不强制唯一**：重名创建会静默生成同名新实例，不会报错。创建前必须先 `GET /api/providers` 查重，靠 `id` 区分实例。

⚠️ 所有 `group_id` 字段都传分组对象返回的 **`id`（UUID），不是组名**；传名字会得到 `provider_group_not_found` / `alias_group_not_found`。

## 2. Provider 及其分组

| 操作 | 端点 | Body / 说明 | 级别 |
| :--- | :--- | :--- | :--- |
| 新建 Provider | `POST /api/providers` | `{name, protocol, base_url, auth?, custom_headers?, group_id?, proxy_url?, timeout_ms?, model_filter?}`；auth 示例 `{"authorization":"Bearer sk-…"}` 或 `{"x-api-key":"…"}` | 🟢 |
| 更新 Provider | `PUT /api/providers/:id` | 部分更新；`protocol` 不可改；可传 `enabled:0\|1` | 🟢 |
| 删除 Provider | `DELETE /api/providers/:id` | 级联删除其模型与映射候选，触发 active 目标修复 | 🔴 |
| 测连通 | `POST /api/providers/:id/test` | 无 body；401/403 判认证失败，其他 HTTP 响应判网络可达 | 🟢 |
| 拉上游模型 | `POST /api/providers/:id/upstream-models` | 无 body；返回 `{model_ids:[…]}`，应用 model_filter，不落库 | 🟢 |
| 导入模型 | `POST /api/providers/:id/import-models` | `{model_ids:[…]}` 非空数组；落库并自动建同名映射（同名已存在只追加 inactive 候选，不切 active） | 🟢 |
| 新建分组 | `POST /api/provider-groups` | `{protocol, name}`；同协议组名唯一 | 🟢 |
| 重命名分组 | `PATCH /api/provider-groups` | `{protocol, group_id, name}` | 🟢 |
| 删除分组 | `DELETE /api/provider-groups` | `{protocol, group_id}`；仅解除成员归属到「未分组」，不删数据 | 🔴 |
| 批量启用组内 | `POST /api/provider-groups/batch-enable` | `{protocol, group_id}` | 🟢 |
| 批量启/禁组内 | `POST /api/provider-groups/batch-toggle` | `{protocol, group_id, enabled}`；批量禁用会使流量 503（可逆） | 🟢 |
| 批量删除组内 | `POST /api/provider-groups/batch-delete` | `{protocol, group_id}`；删成员 Provider 及其模型/候选，保留空组 | 🔴 |

## 3. 真实模型与测活

| 操作 | 端点 | Body / 说明 | 级别 |
| :--- | :--- | :--- | :--- |
| 手动加模型 | `POST /api/models` | `{provider_id, model_id, display_name?}`；默认 enabled=1 | 🟢 |
| 启用/禁用模型 | `PATCH /api/models` | `{provider_id, model_id, enabled:0\|1}` | 🟢 |
| 删除模型 | `DELETE /api/models` | `{provider_id, model_id}` | 🔴 |
| 测活 | `POST /api/models/test` | `{provider_id, model_id, prompt?, thinking?}`；默认提示词「现在的美国总统是谁」；黑名单 hi/hello/你好/测试/test/1 且 trim 后 ≥4 字符；30s 硬超时 | 🟢 |

## 4. 模型映射与候选（路由核心）

映射按 `(protocol, alias_name)` 唯一，两协议命名空间独立。请求只路由到唯一 `active=1` 候选。

| 操作 | 端点 | Body / 说明 | 级别 |
| :--- | :--- | :--- | :--- |
| 建映射 | `POST /api/aliases` | `{protocol, alias_name, provider_id, model_id, group_id?, enabled?, thinking?}`；目标 Provider 与真实模型必须已启用且协议一致；首个目标即 active | 🟢 |
| 改映射 | `PATCH /api/aliases` | `{protocol, alias_name, new_alias_name?/group_id?/enabled?/(provider_id+model_id 成对出现=换当前目标)/thinking?}`；`thinking:null` 清除思考配置 | 🟢 |
| 删映射 | `DELETE /api/aliases` | `{protocol, alias_name}` | 🔴 |
| 加候选 | `POST /api/alias-targets` | `{protocol, alias_name, provider_id, model_id}`；已有 active 时新候选为 inactive，**不切换流量** | 🟢 |
| 设为当前目标 | `PATCH /api/alias-targets` | 同上 body；原子切换 active（迁移流量用这个） | 🟢 |
| 删候选 | `DELETE /api/alias-targets` | 同上 body；若删的是 active 自动按 priority 修复到首个可用候选 | 🔴 |
| 重排优先级 | `POST /api/alias-targets/reorder` | `{protocol, alias_name, targets:[{provider_id, model_id},…]}`；targets 必须是完整候选集按新顺序排列 | 🟢 |

注意：候选新增/设 active 的前置校验相同——Provider 与真实模型都存在且 enabled、协议一致，否则 400。

## 5. 映射分组

| 操作 | 端点 | Body | 级别 |
| :--- | :--- | :--- | :--- |
| 新建分组 | `POST /api/alias-groups` | `{protocol, name}` | 🟢 |
| 重命名 | `PATCH /api/alias-groups` | `{protocol, group_id, name}` | 🟢 |
| 删除分组 | `DELETE /api/alias-groups` | `{protocol, group_id}`；**连同组内全部映射一起删除** | 🔴 |
| 批量启用 | `POST /api/alias-groups/batch-enable` | `{protocol, group_id}` | 🟢 |
| 清空分组映射 | `POST /api/alias-groups/batch-delete` | `{protocol, group_id}`；删组内映射但保留空分组 | 🔴 |

## 6. 设置 / Token / 日志清理 / 备份

| 操作 | 端点 | Body / 说明 | 级别 |
| :--- | :--- | :--- | :--- |
| 改设置 | `PUT /api/settings` | `{host?/port?/global_timeout_ms?/log_retention_days?}`（字符串数字）；host/port 需重启生效 | 🔴 |
| 重置 Token | `POST /api/token/reset` | 无 body；旧 Token 全部失效 | 🔴 |
| 清空代理日志 | `DELETE /api/logs` | 不可恢复 | 🔴 |
| 清空审计日志 | `DELETE /api/audit-logs` | 不可恢复 | 🔴 |
| 导出备份 | `GET /api/backup` | 🟢 但产物含明文 API Key 与网关 Token，落盘前告知用户 | 🟢* |
| 导入备份 | `POST /api/backup` | 备份 JSON 原样作 body；**全量替换现有配置**（含未分组映射），不含两类日志 | 🔴 |

## 7. 错误码速查

| HTTP | code | 触发与处置 |
| :--- | :--- | :--- |
| 400 | `invalid_request_body` | 参数非法；对照 schema 修正字段后重试一次 |
| 413 | `invalid_request_body` | body 超 50 MiB |
| 400 | `invalid_test_prompt` | 测活提示词命中黑名单或过短，换提示词 |
| 400 | `invalid_backup` | 备份内部引用/协议/候选关系不合法 |
| 401 | `invalid_api_key` | Token 错误 → 回引导步骤重取 |
| 404 | `model_not_found` / `provider_not_found` / `alias_not_found` 等 `_not_found` 系列 | 目标不存在或未启用；先 GET 列表核对标识再操作 |
| 400 | `provider_group_exists` / `alias_exists` / `alias_group_exists` / `alias_target_exists` | 已存在；视为幂等成功，继续后续步骤 |
| 404 | `not_found` | 路径错误 |
| 405 | `method_not_allowed` | 方法用错 |
| 503 | `provider_disabled` | Provider 被禁用；先启用再操作 |
| 502 | `upstream_error` | 上游不可达/5xx/管理侧上游失败 |
| 504 | `upstream_timeout` | 上游超时 |

写操作失败（尤其创建类）禁止盲目原样重试，防重复创建或重复副作用。

## 8. 思考等级（thinking）配置规则

映射可选配 `thinking: {mode, value}`，value 为协议原生值，入库前按协议校验：

| protocol | value 合法形状 | 示例 |
| :--- | :--- | :--- |
| `anthropic` | thinking 对象：`{"type":"enabled","budget_tokens":N}`（N 为 ≥1024 整数）或 `{"type":"disabled"}` | `{"mode":"override","value":{"type":"enabled","budget_tokens":2048}}` |
| `openai` | 非空字符串（reasoning_effort） | `{"mode":"default","value":"high"}` |

- `override` = 无条件替换/注入顶层 `thinking`（Anthropic）或 `reasoning_effort`（OpenAI）；`default` = 仅客户端未携带时注入。
- 不配置 = 客户端什么就转发什么，网关不动。
- `POST /models/test` 可带同款 `thinking` 直接验证效果。

## 9. 关键路由语义（排障必读）

1. 客户端请求的 `model` 必须是**映射名**；直写真实模型名 → 代理返回 `404 model_not_found`。
2. 只有「映射 enabled + 目标候选 active + Provider enabled + 真实模型 enabled」四者齐备才能被调通；任一缺失分别表现为 404/503。
3. 代理入口：OpenAI `/openai/v1/*`、Anthropic `/anthropic/v1/*`，除 `GET */v1/models` 外只收 POST。
4. 删除/禁用 active 目标后网关自动把 active 迁到剩余候选中 priority 最小者；重新启用旧目标**不会**自动切回。
5. 导入/新增真实模型会自动建同名映射，但同名映射已存在时不切 active。
6. 上游 4xx 原样透传给客户端，5xx 包装为 502，超时 504；访问日志在收到响应头时立即落库，`latency_ms` 是首包耗时。
