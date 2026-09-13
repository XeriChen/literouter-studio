# 静态审查报告

## 审查范围

**分支**: `worktree-routing-features` (基于 `7750e91..802292e` + 未提交变更)  
**变更文件**: 25 个已修改文件 + 7 个新增文件  
**代码行数**: +1115 / -380

---

## 1. 架构一致性

### ✅ 通过项

1. **红线遵守**
   - ✅ 不做协议转换：代理路由只替换 `model` 与思考字段，其余透传
   - ✅ 仅替换允许字段：`proxy/body.ts` 的 `rewriteProxyBody` 定点替换 model 与 thinking，保留原 JSON 结构
   - ✅ 明文传输：无加密层变更

2. **数据模型演进**
   - schema v9 → v11（v10 为余额查询的 `upstream_type` 中间版本）
   - 新增表：`balance_snapshots`（余额日快照）
   - 新增列：`providers.upstream_type`（CHECK 约束 newapi/sub2api）、`logs.attempt`（重试序号）、`logs.prompt_tokens/completion_tokens/total_tokens`（被动统计）
   - 守卫式迁移：v6→v11 保留 `pragma_table_info` 检查，向前兼容

3. **路由模式实现**
   - `src/services/routing.ts`：single/weighted/failover 三种模式
   - `src/services/health.ts`：冷却、单探测、亲和状态机（借鉴 octopus RouteState）
   - `src/routes/proxy.ts`：重试循环消费候选列表，首字节前失败可重试

4. **余额查询泛化**
   - `src/services/balance.ts`：统一 `BalanceResult` 接口，支持 newapi/sub2api 两种上游
   - `src/services/upstream-capabilities.ts`：能力描述符模式，显式 unsupported 原因
   - 缓存 + 在途去重 + 最小间隔限流（60s TTL / 10s 最小间隔）
   - 日快照自动捕获（upsert 语义，服务器本地时区 YYYY-MM-DD）

5. **被动 usage 统计**
   - `src/proxy/usage.ts`：仅扫描 ASCII 键，latin1 编码防多字节伪造
   - Anthropic cache tokens 自动累加到 prompt_tokens
   - OpenAI 流式需客户端开启 `stream_options.include_usage`

### ⚠️ 需关注项

1. **schema 版本号跳跃**
   - 架构文档声明 schema v11，但数据库实现核对记录中提到 v9（余额查询提交）和 v10（未提交的 attempt 列）
   - **建议**: 统一为 schema v11，更新 ARCHITECTURE.md 实现核对记录的日期与版本号

2. **日志 `attempt` 列的语义边界**
   - single 模式无重试，`attempt` 恒为 1
   - weighted/failover 模式的 `attempt` 序号从 1 开始递增
   - **潜在混淆**: 用户可能误认为 single 模式的 `attempt=1` 是重试过一次
   - **建议**: 文档明确说明或考虑 single 模式写 `NULL`

3. **upstream_type CHECK 约束**
   - 当前只允许 `'newapi' | 'sub2api' | NULL`
   - 未来新增上游类型需 ALTER TABLE 修改约束
   - **建议**: 考虑去除 CHECK 约束，在应用层校验（更灵活）

---

## 2. 代码质量

### ✅ 优秀设计

1. **类型化错误**
   - `src/services/errors.ts`：`UpstreamError` 封闭联合类型，机器可读错误码
   - 替代字符串匹配的脆弱判断

2. **敏感信息脱敏**
   - `src/services/redact.ts`：识别 API Key/Token 模式，审计日志写入前自动打码
   - 防止上游回显密钥污染日志

3. **URL 出站校验**
   - `src/services/url-guard.ts`：SSRF 防御（localhost/内网 IP/嵌入凭据/控制字符）
   - Provider 保存 + 代理转发双重校验

4. **测试覆盖**
   - 89 个测试全部通过（routing/balance/crypto/health/usage/url-guard）
   - weighted 模式用统计验证分布，failover 验证严格序

### ⚠️ 潜在问题

1. **健康状态机的内存泄漏风险**
   - `src/services/health.ts` 的 `states` Map 按 `protocol/alias` 无限增长
   - 动态创建/删除映射后，旧状态不会清理
   - **建议**: 定期 GC 长期未访问的 alias 状态，或配置变更时显式 `clearHealthState(aliasKey)`

2. **余额查询的并发限流精度**
   - `MIN_INTERVAL_MS = 10_000` 限流基于进程内时间戳
   - 集群部署（虽然文档禁止）会突破限流
   - **当前**: 已明确单进程约束，不影响

3. **Usage 解析的边界case**
   - 跨 chunk 的 64 字节尾缓冲假设键+值不超过此长度
   - 极端格式化（大量空白）可能切断键值对
   - **影响**: 小概率丢失 usage（不影响功能正确性，只是统计缺失）

4. **重试循环的客户端取消处理**
   - `reportClientCancel` 只释放探测位，不清失败计数
   - 若客户端频繁取消，可能误触冷却
   - **建议**: 取消不计入失败，但需验证 `isAbortError` 判断准确性

---

## 3. 文档一致性

### ✅ 已同步

1. ARCHITECTURE.md 新增章节：
   - 路由模式（single/weighted/failover）
   - 余额查询流程与缓存策略
   - 被动 usage 统计精度边界
   - 健康探针（冷却/单探测/亲和）

2. VERIFICATION.md 完整记录余额查询验证

3. CLAUDE.md / AGENTS.md 的阅读索引已更新

### ❌ 需补充

1. **陷阱清单未更新**（ARCHITECTURE.md §6/§8）
   - 重试逻辑的可重试状态集（401/403/408/429/5xx）
   - 健康状态机的进程内生命周期
   - usage 解析的 latin1 编码假设
   - **建议**: 在 §8 增加「健康状态不持久化，重启即清空」「重试只在首字节前安全」

2. **前端变更未在 §7 体现**
   - ModelAliases 页新增路由配置面板（mode/max_attempts/cooldown/affinity）
   - Providers 页新增余额查询按钮（仅 newapi/sub2api 可见）
   - **建议**: 补充到 ARCHITECTURE.md §7 前端要点

3. **AGENTS.md 的阅读索引**
   - 余额查询、健康探针、usage 统计需加入第 5 节的任务→资料映射表

---

## 4. 测试覆盖

### ✅ 已验证

- **单元测试**: 89 个测试全部通过（1288ms）
  - routing: weighted 分布、failover 严格序、config 钳制
  - balance: newapi/sub2api 查询、缓存去重、401 映射
  - crypto: 加密往返、格式校验、篡改检测
  - health: 冷却/探测/亲和状态机、客户端取消
  - usage: 跨 chunk 解析、cache tokens 累加
  - url-guard: localhost/内网/嵌入凭据拦截

- **类型检查**: `pnpm typecheck` 通过

### ❌ 缺失覆盖

1. **E2E 测试未运行**
   - 前端路由配置面板的交互
   - 余额查询按钮的条件显示
   - **原因**: 未提交变更不含前端构建产物
   - **建议**: 提交前运行 `pnpm check` + E2E

2. **集成测试缺失**
   - 代理重试循环的端到端流程（mock 上游 429 → 故障转移）
   - 健康状态机与路由模式的组合场景
   - **建议**: 补充 `test/proxy-retry.test.ts` 模拟多候选重试

---

## 5. 提交状态

### 已提交

- `802292e`: feat(balance): add Sub2API balance query support
- `fe797ce`: feat: add New API balance query with encrypted provider credentials

### 未提交（36 个文件变更）

#### 核心功能
- `src/routes/proxy.ts`: 重试循环 +183/-51
- `src/services/routing.ts`: 路由模式 +121/-54
- `src/services/balance.ts`: 余额泛化 +223/-69
- `src/services/models.ts`: 候选列表路由 +154/-66
- `src/db/index.ts`: schema v11（attempt 列）

#### 新增模块
- `src/services/health.ts`: 冷却/探测/亲和状态机
- `src/services/errors.ts`: 类型化上游错误
- `src/services/redact.ts`: 敏感信息脱敏
- `src/services/upstream-capabilities.ts`: 能力描述符
- `src/services/url-guard.ts`: 出站 URL 校验
- `src/proxy/usage.ts`: 被动 usage 解析

#### 前端集成
- `web/src/pages/ModelAliases.tsx`: 路由配置面板 +144
- `web/src/pages/Providers.tsx`: 余额查询按钮 +13
- `web/src/pages/Settings.tsx`: 健康探针设置 +12

#### 测试
- `test/health.test.ts`: 状态机测试
- `test/usage-parser.test.ts`: usage 解析测试
- `test/url-guard.test.ts`: SSRF 防御测试
- `test/balance.test.ts`: 余额查询扩展 +184
- `test/routing.test.ts`: 路由模式测试 +163

---

## 6. 修改建议

### 🔴 必须修复

1. **schema 版本号统一**
   ```diff
   - 实现核对记录：2026-09-12（已与 schema v9...
   + 实现核对记录：2026-09-13（已与 schema v11...
   ```

2. **ARCHITECTURE.md 补充陷阱清单**
   - §6 代理管线新增：重试的可重试状态集、usage 解析精度边界
   - §8 已知权衡新增：健康状态不持久化、内存泄漏风险与缓解

3. **类型导出缺失**
   - `web/src/api/types.ts` 需导出 `RoutingConfig` 接口
   - 前端已使用但未在类型文件中声明

### 🟡 建议改进

1. **健康状态 GC**
   ```typescript
   // src/services/health.ts 新增定期清理
   export function pruneStaleStates(maxIdleMs = 3600_000): void {
     const now = Date.now()
     for (const [key, state] of states) {
       if (!state.affinity && state.cooldowns.size === 0 && state.failures.size === 0) {
         // 无活跃状态超过 maxIdleMs 清理
       }
     }
   }
   ```

2. **日志 `attempt` 语义明确**
   - 文档补充：single 模式 `attempt=1`，weighted/failover 从 1 递增
   - 或：single 模式写 `NULL`，只有重试才填序号

3. **前端路由配置校验前置**
   - `buildRoutingConfig` 的错误提示应在表单 blur 时显示
   - 避免提交时才发现非法值

### 🟢 可选优化

1. **余额查询批量接口**
   ```typescript
   // GET /api/providers/balance?ids=p1,p2,p3
   // 返回 Map<provider_id, BalanceResult>
   ```

2. **usage 统计导出**
   - 管理 API 聚合查询：按 Provider/模型/日期范围统计 token 用量
   - 可用于成本分析

3. **健康快照 UI**
   - ModelAliases 页显示当前冷却中的候选（红色徽章）
   - 亲和期显示固定目标（蓝色徽章）

---

## 7. 总体评价

### 代码质量: ⭐⭐⭐⭐☆ (4/5)

**优点**:
- 类型化错误、敏感信息脱敏、SSRF 防御等工程实践到位
- 测试覆盖全面，89 个单元测试全部通过
- 路由模式与健康状态机设计清晰，借鉴成熟项目（octopus/all-api-hub）

**不足**:
- 健康状态 Map 无 GC 机制，长期运行可能内存泄漏
- 部分文档未同步（陷阱清单、前端变更）
- E2E 测试未运行

### 架构一致性: ⭐⭐⭐⭐⭐ (5/5)

- 三条红线严格遵守
- 数据模型演进有守卫式迁移
- 新功能符合「最小可用、原生透传」原则

### 文档完整性: ⭐⭐⭐☆☆ (3/5)

- 核心设计已记录（路由模式、余额查询、usage 统计）
- 缺少陷阱清单更新、前端变更说明
- AGENTS.md 阅读索引需补充新模块

---

## 8. 发布检查清单

- [ ] schema 版本号统一为 v11（ARCHITECTURE.md 实现核对记录）
- [ ] 补充陷阱清单：健康状态不持久化、重试边界、usage 精度
- [ ] 补充前端变更到 ARCHITECTURE.md §7
- [ ] 更新 AGENTS.md 阅读索引（余额查询、健康探针、usage）
- [ ] 导出 `RoutingConfig` 类型到 `web/src/api/types.ts`
- [ ] 运行 `pnpm check`（typecheck + test + build:web）
- [ ] 运行 `pnpm test:e2e`（需先启动服务、准备测试数据）
- [ ] 健康状态 GC 或在配置变更时显式清理（可选，标注 TODO）
- [ ] 提交消息遵循 conventional commits 格式
- [ ] 合并前 rebase main 分支最新提交

---

## 附录：关键文件变更摘要

| 文件 | 变更 | 风险 | 说明 |
|------|------|------|------|
| `src/routes/proxy.ts` | +183/-51 | 🔴高 | 重试循环核心，影响全部代理请求 |
| `src/services/routing.ts` | +121/-54 | 🟡中 | 路由模式实现，weighted 随机性依赖 Math.random |
| `src/services/health.ts` | +174/新增 | 🟡中 | 状态机，内存泄漏风险 |
| `src/services/balance.ts` | +223/-69 | 🟢低 | 余额查询，管理面功能 |
| `src/proxy/usage.ts` | +88/新增 | 🟢低 | 被动统计，不影响功能正确性 |
| `src/db/index.ts` | +31 | 🟡中 | schema v11，需测试迁移路径 |
| `web/src/pages/ModelAliases.tsx` | +144 | 🟢低 | 路由配置 UI |

**审查时间**: 2026-09-13  
**审查者**: Claude (Opus 5)  
**验证状态**: 单元测试通过，E2E 未运行，文档部分待补充
