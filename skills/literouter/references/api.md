# literouter 管理 API 参考

按当前任务查阅相关端点、字段和副作用。授权、凭据与完成标准统一见 [SKILL.md](../SKILL.md)，表中端点本身不构成执行授权或重新确认的要求。

维护本参考时，项目设计以仓库 `ARCHITECTURE.md` 为准，受影响字段和实现可在 `src/routes/api/shared.ts` 的 zod schema 与 `src/routes/api/*` 核对；实际操作网关无需预先通读源码。

## 0. 通用约定

- Base URL：复用已知目标，本机通常为 `http://127.0.0.1:3000`（实际监听地址由 settings 或 `HOST`/`PORT` 决定）；目标缺失且无法从已有配置确定时才询问。
- 认证：所有 `/api` 请求（除 `POST /api/login`）带 `Authorization: Bearer <管理Token>`。
- **指定真实模型一律用 Request Body 传参**（`provider_id` / `model_id` 放 body，不用路径参数），因为 `model_id` 可能含 `/`（如 `openai/gpt-4`）。
- 响应外形统一为 `{"ok":true,"data":…}` 或 `{"ok":false,"error":{"message","type","code"}}`；先检查 HTTP 状态与 `ok`，失败按 `error.code` 对照第 7 节，避免直接读取不存在的 `data` 掩盖错误。
- 凭据由请求进程从环境、受保护文件或对应本机数据库只读取得，使用结构化请求 API 或 stdin 传 body；敏感响应在输出前筛选或脱敏。以下只展示创建 Provider 的请求体形状，占位符由请求进程替换，真实 Key 不写入命令文本：

```json
{ "name": "示例", "protocol": "openai", "base_url": "https://api.example.com", "auth": {"api_key": "<API_KEY>"} }
```

**base_url 只填到版本前缀的上一级，不要带尾部 `/v1`**：网关拼接上游 URL 时会追加 `/v1/models`、`/v1/chat/completions` 且不去重。若上游真实路径含 `/v1`（如 `https://host/api/v1`），base_url 填 `https://host/api`，让网关补 `/v1`。这是 Provider 地址约定，与客户端代理入口的 v1 路径归一化不同。

## 1. 引导与查询

| 操作 | 端点 | 说明 |
| :--- | :--- | :--- |
| 验证 Token | `GET /api/me` | 响应含 `{token}`；检查状态和 `ok` 后仅输出认证结果，不回显 Token |
| 换取会话 | `POST /api/login` | body `{token}`；agent 一般不需要，直接用 Bearer |
| Provider 列表 | `GET /api/providers` | `auth` 字段回显明文 Key，输出前脱敏 |
| Provider 详情 | `GET /api/providers/:id` | 同上 |
| Provider 分组列表 | `GET /api/provider-groups` | |
| 真实模型列表 | `GET /api/models` | 含 enabled/source/display_name |
| 映射列表 | `GET /api/aliases` | 含 targets 数组（priority/active）及内联 provider_name/provider_enabled/target_enabled，可直接判断可路由性 |
| 映射分组列表 | `GET /api/alias-groups` | |
| 读设置 | `GET /api/settings` | host/port/global_timeout_ms/log_retention_days/health_check_interval_seconds |
| 代理访问日志 | `GET /api/logs?page=&page_size=&protocol=&provider_id=&model=&status=` | model=映射名；provider_name/resolved_model=实际路由 |
| 配置操作日志 | `GET /api/audit-logs?page=&page_size=&resource=` | resource 可选 provider/model/alias/… |

Provider 对象字段：`id, name, protocol(openai|anthropic), group_id, base_url, auth(键值对), custom_headers(键值对), proxy_url, timeout_ms, model_filter, enabled(0|1)`。

- `timeout_ms`：`null` = 用全局 `global_timeout_ms`；`0` = 永不超时（连接/响应头仍受管理操作 30s 兜底）；正整数 = 毫秒。
- **Provider 名称不强制唯一**：重名创建会生成同名新实例，不会报错。结合名称、协议、地址与用户目标识别对象，靠 `id` 区分实例；已有足够且有效的查询结果可复用。

所有 `group_id` 字段都传分组对象返回的 **`id`（UUID），不是组名**；传名字会得到 `provider_group_not_found` / `alias_group_not_found`。

## 2. Provider 及其分组

| 操作 | 端点 | Body / 说明 |
| :--- | :--- | :--- |
| 新建 Provider | `POST /api/providers` | `{name, protocol, base_url, auth?, custom_headers?, group_id?, proxy_url?, timeout_ms?, model_filter?}`；auth 统一用 `{"api_key":"…"}`（裸 token，不含 `Bearer ` 前缀）：openai 协议会自动拼成 `authorization: Bearer <api_key>`，anthropic 协议会自动映射到 `x-api-key`。不要写成 `{"authorization":"Bearer sk-…"}`，网关不读该字段会导致上游 401。base_url 不带尾部 `/v1`（见第 0 节） |
| 更新 Provider | `PUT /api/providers/:id` | 部分更新；`protocol` 不可改；可传 `enabled:0\|1` |
| 删除 Provider | `DELETE /api/providers/:id` | 级联删除其模型与映射候选，触发 active 目标修复 |
| 测连通 | `POST /api/providers/:id/test` | 无 body；401/403 判认证失败，其余 HTTP 响应（含 404/502）判网络可达；结果不证明模型推理或映射链路可用 |
| 查余额 | `GET /api/providers/:id/balance` | 仅 upstream_type 为 newapi/sub2api 的 Provider 支持；返回归一化结果 `{success, balance, currency, balances[], unlimited, available, status_code, fetched_at, error, expires_at}`；newapi 系用 sk- 密钥调 OpenAI 兼容接口 `/v1/dashboard/billing/subscription`+`/usage`（**不是** `/api/user/self`，那需要控制台 access_token），balance=剩余额度，balances 给剩余/已用/总额，`expires_at` 为令牌到期日（无则 null）；无限额密钥（newapi 哨兵 `hard_limit_usd=100000000`）返回 `unlimited=true`、`balance=null`，balances 仅含「已用」（usage 不可用则为空数组）；60s TTL 缓存 + 在途去重，`?force=1` 直连上游；不支持时 400 `balance_unsupported` |
| 余额日快照 | `GET /api/providers/:id/balance/snapshots` | 当地时区每天一条（后写覆盖），默认返回最近 90 天 |
| 拉上游模型 | `POST /api/providers/:id/upstream-models` | 无 body；返回 `{model_ids:[…]}`，应用 model_filter，不落库 |
| 导入模型 | `POST /api/providers/:id/import-models` | `{model_ids:[…]}` 非空数组，可选 `create_alias`（默认 true）；启用导入模型，已启用的 Provider 自动建同名映射（同名已存在只追加 inactive 候选，不切 active）；传 `create_alias:false` 只登记模型 |
| 一键清理导入模型 | `POST /api/providers/:id/cleanup-imported-models` | 无 body；事务内删除该 Provider 全部 `source='fetched'` 模型（手动添加不受影响），返回 `{deleted}`；同名映射保留、候选随引用修复，可能留下无候选的无效映射（用映射页「清理无效映射」清理） |
| 新建分组 | `POST /api/provider-groups` | `{protocol, name}`；同协议组名唯一 |
| 重命名分组 | `PATCH /api/provider-groups` | `{protocol, group_id, name}` |
| 删除分组 | `DELETE /api/provider-groups` | `{protocol, group_id}`；删除分组并解除成员归属到「未分组」，不删除 Provider |
| 批量启用组内 | `POST /api/provider-groups/batch-enable` | `{protocol, group_id}` |
| 批量启/禁组内 | `POST /api/provider-groups/batch-toggle` | `{protocol, group_id, enabled}`；禁用会触发 active 修复，相关映射可能切换到其他候选或变为不可调用 |
| 批量删除组内 | `POST /api/provider-groups/batch-delete` | `{protocol, group_id}`；删成员 Provider 及其模型/候选，保留空组 |

## 3. 真实模型与测活

| 操作 | 端点 | Body / 说明 |
| :--- | :--- | :--- |
| 手动加模型 | `POST /api/models` | `{provider_id, model_id, display_name?}`；默认 enabled=1 |
| 启用/禁用模型 | `PATCH /api/models` | `{provider_id, model_id, enabled:0\|1}` |
| 删除模型 | `DELETE /api/models` | `{provider_id, model_id}` |
| 测活 | `POST /api/models/test` | `{provider_id, model_id, prompt?, thinking?}`；默认提示词「现在的美国总统是谁」；黑名单 hi/hello/你好/测试/test/1 且 trim 后 ≥4 字符；30s 硬超时。产生真实推理消耗，按 Skill 中的推理授权与 thinking 规则执行；不经过映射层 |

## 4. 模型映射与候选（路由核心）

映射按 `(protocol, alias_name)` 唯一，两协议命名空间独立。路由模式由映射的 `routing_config` 决定（默认 single）：

- **single**（默认）：只使用 `active=1` 候选，失败不换目标。
- **weighted**：全候选按 `weight` 加权随机分配；weight 0 仅作末位备选，全 0 均匀随机。
- **failover**：按 priority 升序尝试，失败自动切换下一候选。

weighted/failover 下，候选跨请求连续失败达阈值后冷却并在选路时跳过；全部冷却时仅放行一个探测请求（其余立即 503）；探测/切换成功后可按配置进入短时亲和期。

| 操作 | 端点 | Body / 说明 |
| :--- | :--- | :--- |
| 建映射 | `POST /api/aliases` | `{protocol, alias_name, provider_id, model_id, group_id?, enabled?, thinking?}`；目标 Provider 与真实模型必须已启用且协议一致；首个目标即 active |
| 改映射 | `PATCH /api/aliases` | `{protocol, alias_name, new_alias_name?/group_id?/enabled?/(provider_id+model_id 成对出现=换当前目标)/thinking?/routing_config?}`；`thinking:null` 清除思考配置；`routing_config` 形如 `{mode, max_attempts?/cooldown_seconds?/affinity_seconds?}`（mode ∈ single/weighted/failover，max_attempts 1-10，cooldown/affinity 0-3600 秒，null 清除回退 single） |
| 删映射 | `DELETE /api/aliases` | `{protocol, alias_name}` |
| 合并映射 | `POST /api/aliases/merge` | `{protocol, sources:[…], target_alias_name, group_id?, delete_sources?}`；候选按 (provider_id, model_id) 去重追加；**并入已有映射不改其 active（不切流量）**，新建映射以第一个源的当前目标为 active、thinking 继承第一个非空源；`delete_sources:true` 删除源映射（属删除类操作，需确认授权） |
| 加候选 | `POST /api/alias-targets` | `{protocol, alias_name, provider_id, model_id}`；已有 active 时新候选为 inactive，**不切换流量** |
| 设为当前目标 | `PATCH /api/alias-targets` | 同上 body；原子切换 active（迁移流量用这个） |
| 删候选 | `DELETE /api/alias-targets` | 同上 body；若删的是 active 自动按 priority 修复到首个可用候选 |
| 重排优先级 | `POST /api/alias-targets/reorder` | `{protocol, alias_name, targets:[{provider_id, model_id},…]}`；targets 必须是完整候选集按新顺序排列 |
| 设候选权重 | `POST /api/alias-targets/weight` | `{protocol, alias_name, provider_id, model_id, weight(0-10000)}`；weighted 模式的分配权重，0 = 仅末位备选 |

注意：候选新增/设 active 的前置校验相同——Provider 与真实模型都存在且 enabled、协议一致，否则 400。

## 5. 映射分组

| 操作 | 端点 | Body |
| :--- | :--- | :--- |
| 新建分组 | `POST /api/alias-groups` | `{protocol, name}` |
| 重命名 | `PATCH /api/alias-groups` | `{protocol, group_id, name}` |
| 删除分组 | `DELETE /api/alias-groups` | `{protocol, group_id}`；**连同组内全部映射一起删除** |
| 批量启用 | `POST /api/alias-groups/batch-enable` | `{protocol, group_id}` |
| 清空分组映射 | `POST /api/alias-groups/batch-delete` | `{protocol, group_id}`；删组内映射但保留空分组 |

## 6. 设置 / Token / 日志清理 / 备份

| 操作 | 端点 | Body / 说明 |
| :--- | :--- | :--- |
| 改设置 | `PUT /api/settings` | `{host?/port?/global_timeout_ms?/log_retention_days?/health_check_interval_seconds?}`（字符串数字）；host/port 需重启，超时对后续代理请求生效，日志保留天数在下次启动清理时生效；健康探针间隔（秒，默认 0=关闭）对冷却中的候选发最小请求探活，成功则提前恢复冷却 |
| 重置 Token | `POST /api/token/reset` | 无 body；旧 Token 全部失效，新 Token 在请求进程内保存和使用，不原样输出 |
| 清空代理日志 | `DELETE /api/logs` | 不可恢复 |
| 清空审计日志 | `DELETE /api/audit-logs` | 不可恢复 |
| 导出备份 | `GET /api/backup` | 产物含明文 API Key 与网关 Token，保存到约定位置并告知敏感性；任一 Provider 凭据无法解密时导出直接失败（500 `backup_export_failed`），不会产出缺凭据的备份 |
| 导入备份 | `POST /api/backup` | 备份 JSON 原样作 body；**全量替换现有配置**（含未分组映射、设置和 Token），备份不含两类日志，导入也不清空既有日志 |

## 7. 错误码速查

| HTTP | code | 触发与处置 |
| :--- | :--- | :--- |
| 400 | `invalid_request_body` | 参数非法；按错误与字段约定修正后继续，避免不改请求地重复提交 |
| 413 | `invalid_request_body` | body 超 50 MiB |
| 400 | `invalid_test_prompt` | 测活提示词命中黑名单或过短，换提示词 |
| 400 | `invalid_backup` | 备份内部引用/协议/候选关系不合法 |
| 500 | `backup_export_failed` | 导出备份时 Provider 凭据解密失败（通常是 `ENCRYPTION_KEY` 丢失或被更换）；用原密钥重启网关后重新导出 |
| 401 | `invalid_api_key` | 核对目标地址与凭据来源，更新有效 Token 后再验证；来源缺失时才询问 |
| 404 | `model_not_found` / `provider_not_found` / `alias_not_found` 等 `_not_found` 系列 | 目标不存在或未启用；先 GET 列表核对标识再操作 |
| 400 | `provider_group_exists` / `alias_exists` / `alias_group_exists` / `alias_target_exists` | 已存在；读回并比对协议、标识和任务相关配置，一致才视为目标已满足并复用 id，否则按已有授权修正 |
| 404 | `not_found` | 路径错误 |
| 405 | `method_not_allowed` | 方法用错 |
| 503 | `provider_disabled` | 核对 Provider 启用状态和任务目标；已有授权涵盖启用或恢复服务时再修正，查询排障不自动启用 |
| 503 | `no_available_target` | weighted/failover 模式下全部候选冷却且探测位被占用；稍后重试或检查候选健康状态 |
| 400 | `balance_unsupported` | 该 Provider 的 upstream_type 不提供余额端点 |
| 400 | `outbound_url_invalid` | 上游 URL 形状非法（协议/凭据/控制字符），核对 base_url |
| 502 | `upstream_error` | 上游不可达/5xx/管理侧上游失败 |
| 504 | `upstream_timeout` | 上游超时 |

写入超时或断连时结果可能未知，先读回现状再决定是否重试，防止重复创建或重复副作用。可依据新错误信息继续修正；同一原因反复出现且没有新依据时报告该操作的阻塞，继续不受影响的步骤。

## 8. 思考等级（thinking）配置规则

映射可选配 `thinking: {mode, value}`，value 为协议原生值，入库前按协议校验：

| protocol | value 合法形状 | 示例 |
| :--- | :--- | :--- |
| `anthropic` | thinking 对象：`{"type":"enabled","budget_tokens":N}`（N 为 ≥1024 整数）或 `{"type":"disabled"}` | `{"mode":"override","value":{"type":"enabled","budget_tokens":2048}}` |
| `openai` | 非空字符串（reasoning_effort） | `{"mode":"default","value":"high"}` |

- `override` = 无条件替换/注入顶层 `thinking`（Anthropic）或 `reasoning_effort`（OpenAI）；`default` = 仅客户端未携带时注入。
- 不配置 = 客户端什么就转发什么，网关不动。
- `POST /api/models/test` 可在已授权的思考配置验证中带同款 `thinking`；它直接调用真实模型，不证明映射路由或代理侧定点改写已生效。

## 9. 关键路由语义（路由排障时查阅）

1. 客户端请求的 `model` 必须是**映射名**；直写真实模型名 → 代理返回 `404 model_not_found`。
2. 映射可路由要求「映射 enabled + 至少一个可用候选（其 Provider enabled + 真实模型 enabled）」。全部候选不可用时返回 `503 provider_disabled`；映射不存在或禁用返回 `404 model_not_found`。single 模式使用 active 候选；weighted/failover 使用全部可用候选。
3. 代理入口：OpenAI `/openai/v1/*`、Anthropic `/anthropic/v1/*`，除 `GET */v1/models` 外只收 POST。
4. 删除 active 候选、或删除/禁用其 Provider 与真实模型时，在配置事务内按 priority 选择首个可用候选修复 active。没有可用候选时映射保留但不可调用，按实际路由状态返回 404/503；重新启用旧目标不会替换已经可用的 active。
5. weighted/failover 模式的失败重试只发生在「首个响应字节写给客户端之前」；候选连续失败达 max_attempts 次后冷却 cooldown_seconds（默认 60），全部冷却时其余请求立即 503 `no_available_target`。健康状态纯进程内，重启即清空。
6. 上游 4xx 原样透传给客户端；401/403/408/429 属「候选故障」，会在首字节前换候选，候选耗尽后包装为 502（`upstream_auth_error`/`upstream_rate_limited`）或 504（`upstream_timeout`）；single 模式恒为单次尝试，这四种状态直接透传原始状态码、响应体与 `Retry-After` 等头，不包装。5xx 一律包装为 502，超时 504；访问日志在收到响应头时立即落库，`latency_ms` 是本次尝试的首包耗时，`attempt` 是第几次尝试。
7. 已启用的 Provider 导入/新增真实模型会自动建同名映射，但同名映射已存在时只追加 inactive 候选，不切 active。
