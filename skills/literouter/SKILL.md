---
name: literouter
description: 管理 literouter LLM 网关的 Provider 与模型映射配置。当用户要求添加/修改/删除 provider、导入或启停真实模型、建立/改名/删除模型映射（alias）、切换映射目标、配置思考等级、测活、查代理日志、备份或恢复网关配置时使用。仅用于 literouter 网关管理面，不处理业务代码。
---

# literouter 网关管理

通过网关自带的 HTTP 管理 API 操作，无需任何额外工具。端点与字段的完整定义在 [references/api.md](references/api.md)，先读完本文件的引导与安全规则再动手。

## 引导（每次会话首次操作前执行一次）

1. 确定 Base URL：本机网关通常为 `http://127.0.0.1:3000`（实际监听由 settings 或 `HOST`/`PORT` 环境变量决定）；远端网关向用户索取。
2. 取管理 Token（网关在本机时直读数据库，必须在项目根目录执行；装了 sqlite3 CLI 用前者，否则用后者）：
   ```bash
   sqlite3 data/gateway.db "SELECT value FROM settings WHERE key='admin_token'"
   # 或（项目自带 better-sqlite3，必然可用）：
   node -e "const db=require('better-sqlite3')('data/gateway.db',{readonly:true});process.stdout.write(db.prepare(\"SELECT value FROM settings WHERE key='admin_token'\").get().value);db.close()"
   ```
   - 读不到（远端网关）就向用户索取 Token。
   - 绝不猜测 Token。
3. 验证：`curl -sS "$BASE_URL/api/me" -H "Authorization: Bearer $TOKEN"`，返回 `{ok:true,…}` 即完成；401 则重取或询问用户。

## 安全规则（必须遵守）

- **免确认**：全部 GET 查询；新建/更新 Provider、真实模型、映射、候选；设 active 目标；重排优先级；测连通；拉上游模型；导入模型；批量启用。
- **严禁自发测活**：`POST /api/models/test` 会产生真实推理消耗，**严禁在接入、导入、建映射或切流量等流程中自发触发测活**；仅当用户明确指令要求测活后，才对用户指定模型发起测活，且**默认不带 thinking**（除非用户明确要求带 thinking/自定义 prompt）。
- **须先向用户复述影响并获明确同意**：一切 DELETE 与 batch-delete（含「删分组连带删映射」「清空组内 Provider」）；`POST /api/backup` 导入（全量替换现有配置）；`POST /api/token/reset`（旧 Token 全失效）；`PUT /api/settings`；清空两类日志。
- **密钥卫生**：`GET /providers` 与备份文件含明文 Key/Token，向用户展示时必须打码（如 `sk-…abcd`），不得原样回显完整密钥；**Base64/编码密钥解码后同样敏感，中间过程也不得把完整 key 回显到对话**；写请求 body 用 stdin/heredoc 传，避免密钥进 shell 历史。
- **写失败不自愈**：创建类请求失败后禁止盲目原样重试；按 `error.code` 处置（见 references 第 7 节），`*_exists` 视为幂等成功继续。
- 不修改代理请求语义相关的任何约定；本 skill 只操作 `/api` 管理面。

## 响应瘦身（必须遵守）

查询类响应必须先用 `node -e` 过滤出本次任务需要的字段再读入上下文，禁止把完整 JSON 列表原样倒进对话；写操作的响应很小，直接看 `ok` 和返回的 `id` 即可。

```bash
# 列 Provider：只要 id/协议/名称/启停
curl -sS "$BASE_URL/api/providers" -H "Authorization: Bearer $TOKEN" \
  | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{for(const p of JSON.parse(s).data)console.log(p.id,p.protocol,p.name,'enabled='+p.enabled)})"
# 看映射当前路由：只要名称和 active 目标
curl -sS "$BASE_URL/api/aliases" -H "Authorization: Bearer $TOKEN" \
  | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{for(const a of JSON.parse(s).data){const t=a.targets.find(t=>t.active);console.log(a.protocol,a.alias_name,'->',t?t.provider_name+'/'+t.model_id:'(无可用目标)','enabled='+a.enabled)}})"
```

需要完整单条详情时按 id 取 `GET /api/providers/:id`，不要拉全表。

## 工作流：接入新 Provider

1. `GET /api/providers` 查重名；必要时 `POST /api/provider-groups` 建分组。
2. `POST /api/providers` 创建（protocol 决定后续一切协议行为，确认无误再建）。
   - **base_url 只填到版本前缀的上一级，不要带尾部 `/v1`**：网关会无条件拼 `/v1/models`、`/v1/chat/completions` 且不去重，带尾 `/v1` 会拼成 `/v1/v1/...` → 404。如上游真实路径是 `https://host/api/v1`，base_url 填 `https://host/api`。
3. `POST /api/providers/:id/test` 测连通；401/403 判认证失败，**其余 HTTP 响应（含 404/502）判网络可达**——某些渠道不提供 `/v1/models` 端点会返回非 2xx，但只要不是 401/403 就说明网络通了，代理转发不受影响。认证失败时和用户核对 Key 后 `PUT /api/providers/:id` 更新 auth。
4. `POST /api/providers/:id/upstream-models` 拉列表给用户看，确认后 `POST /api/providers/:id/import-models` 导入——已启用的 Provider 会自动建同名映射。
   - 若上游不提供 `/v1/models` 端点（拉列表失败/502），改用 chat 口实测探测模型名，或直接向用户索取模型名；`import-models` 按 model_id 落库，**不校验模型是否在上游列表中**，只要上游真实支持即可。

## 工作流：配置映射与验证

1. `POST /api/aliases` 建映射（首个目标即 active）；需要固定思考等级就带 `thinking`（形状校验规则见 references 第 8 节）。
2. （仅在用户明确要求测活时）`POST /api/models/test` 测活目标模型（可带同款 thinking）确认端到端可用；默认不带 thinking。
3. 已有映射加备用路线：`POST /api/alias-targets`（新候选默认 inactive，不影响现网流量）。
4. 切换流量：`PATCH /api/alias-targets` 把候选设为 active，切完用测活复核。

## 工作流：排障

1. `GET /api/logs?model=<映射名>` 看最近请求的 status / provider_name / resolved_model / latency_ms。
2. 按 references 第 9 节路由语义定位断点（常见：Provider 或真实模型被禁用 → 503；没建映射 → 404）。
3. `GET /api/audit-logs` 追溯是谁改的配置。
4. 测活返回上游 4xx（402/404 等）时，**直连上游同端点甄别**：网关透传上游状态码，4xx 通常反映上游账户/模型问题（402=额度不足、404=模型未开通或后端函数缺失），不是网关问题。
5. **禁用 Provider/模型会触发 active 自动修复**（迁到 priority 最小且可用的候选）；若所有候选都不可用时 active 保持原样、访问 503。排障时若发现 active 停在已禁用 Provider 上，先检查其他候选是否也全部不可用。

## 工作流：备份与恢复

- 导出：`GET /api/backup` 存文件，提醒用户产物含明文密钥。
- 导入：**危险操作**，先复述「全量替换所有 Provider/分组/模型/映射配置」，获确认后再 `POST /api/backup`；成功后旧 Token 作废，需用备份内 token 重新引导。
