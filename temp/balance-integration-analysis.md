# New API / Sub2API 余额查询集成分析

## 核心发现

### New API 余额查询接口

从 all-api-hub 的实现中提取到的关键信息：

**端点**: `GET /api/user/self`

**响应字段**:
```typescript
{
  quota?: number  // 剩余额度（单位：quota，需除以 500000 转为美元）
}
```

**认证**: Bearer Token 或 API Key（优先级同当前网关）

**实现位置**:
- `temp/all-api-hub/src/services/apiService/newApiFamily/default/accountData.ts:142-153`
- 函数 `fetchAccountQuota()`

**汇率转换** (来自 New API 源码注释):
- 内部存储以 `$0.002 / quota` 为单位（即 quota = 1 表示 $0.002）
- 转换公式: `余额(美元) = quota / 500000`

---

### Sub2API 余额查询

**端点**: 需进一步确认（从 constants 看有独立的账户管理 API）

**字段结构**:
```typescript
{
  name: string
  platform: 'openai' | 'anthropic' | 'gemini' | 'grok' | 'antigravity'
  status: 'active' | 'inactive' | 'error'
  baseURL: string
  key: string
  supportedModels: string[]
  concurrency: number
  priority: number
}
```

**特点**: Sub2API 是多 Key 聚合系统，单个账户下可管理多个平台的 Key

---

## 集成策略建议

### 阶段 1：New API Provider 余额查询（推荐优先）

**新增字段**（`providers` 表）:
```sql
ALTER TABLE providers ADD COLUMN upstream_type TEXT DEFAULT NULL;
-- 可选值: 'newapi' | 'sub2api' | NULL (标准 Provider)
```

**新增 API**:
```
GET /api/providers/:id/balance
→ 返回 { balance: number, currency: 'USD', last_checked: timestamp }
```

**实现逻辑**:
1. 检查 `provider.upstream_type === 'newapi'`
2. 使用 Provider 的 `base_url` + `/api/user/self` 查询
3. 使用 Provider 的 `auth_json` 认证
4. 转换 `quota / 500000` 为美元
5. 缓存结果（建议 5 分钟 TTL）

**前端展示**:
- Providers 页面每行显示余额徽章（可选刷新按钮）
- 余额低于阈值时高亮警告

---

### 阶段 2：Sub2API 多 Key 聚合

**架构调整**:
- Sub2API 作为特殊 Provider 类型，不直接映射为单个 Provider
- 新增 `sub2api_accounts` 表存储其多 Key 结构
- 网关从 Sub2API 拉取 Key 列表，动态生成临时 Provider（内存或数据库）

**复杂度**: 高（需要账户轮询、Key 生命周期管理）

---

### 阶段 3（可选）：统一余额仪表盘

**功能**:
- 聚合所有 New API / Sub2API Provider 的余额
- 按协议分组展示总可用额度
- 余额趋势图（需历史记录表）

---

## 实现优先级

1. ✅ **New API 余额查询** - 直接、低风险、高价值
2. ⏸️ Sub2API 集成 - 需先确认用户是否实际使用 Sub2API
3. ⏸️ 余额仪表盘 - 依赖阶段 1 完成

---

## 下一步问题

**你目前主要使用哪种上游？**
- A) 主要用 New API 部署实例（推荐先做阶段 1）
- B) 同时用 New API 和 Sub2API（需要两者集成）
- C) 只是想了解余额，不需要实时查询（可以手动输入余额字段）

**余额查询的用途？**
- 监控预警（自动告警余额不足）
- 手动排查（偶尔检查某个 Provider 是否欠费）
- 智能路由（优先使用余额充足的 Provider）
