# New API Balance Query Feature Verification

## Implementation Summary

### Backend
- `src/crypto.ts`: AES-256-GCM encryption for provider credentials
- `src/services/balance.ts`: newapi 系查询 OpenAI 兼容 billing 接口 `/v1/dashboard/billing/subscription` + `/usage`（sk- 密钥，TokenAuth），`剩余 = hard_limit_usd - total_usage/100`，并解析 `access_until` 到期日；usage 不可用时降级为只报 hard_limit_usd；`hard_limit_usd === 100000000`（new-api 无限额令牌哨兵）时返回 `unlimited=true`、`balance=null`，balances 只含「已用」（usage 不可用则为空数组），不写日快照。注意 `/api/user/self` 需要控制台 PAT/会话令牌（UserAuth），sk- 密钥会被 401，故不使用
- `src/routes/api/balance.ts`: `GET /api/providers/:id/balance` with error handling for non-newapi providers, timeouts, upstream errors
- `src/routes/api.ts`: Registered balance route under `/providers`
- `src/db/index.ts`: Added `upstream_type` column to providers table (schema v9 → v10)
- `src/services/providers.ts`: Updated to handle encrypted auth_json and upstream_type field

### Frontend
- `web/src/api/types.ts`: Added `upstream_type` and `BalanceResult` interface
- `web/src/pages/Providers.tsx`: 
  - Added upstream_type to form interface and EMPTY_FORM
  - Added balance query mutation with success/error handling
  - Added balance query button (CircleDollarSign icon) for newapi providers only

### Tests
- `test/balance.test.ts`: Unit tests for rejecting non-newapi providers and missing providers
- `test/crypto.test.ts`: Encryption/decryption round-trip and security tests

## Verification Results

### Type Check
✅ `pnpm typecheck` - No TypeScript errors

### Unit Tests
✅ `pnpm test` - All 50 tests passed including:
- Balance service rejects non-newapi provider
- Balance service rejects missing provider
- Crypto round-trip and security tests

### Frontend Build
✅ `pnpm build:web` - Build successful (611ms)

## Feature Behavior

### Balance Query Flow
1. User clicks CircleDollarSign button on newapi provider row
2. Frontend sends `GET /api/providers/:id/balance`
3. Backend validates provider exists and upstream_type='newapi'
4. Backend queries New API `/v1/dashboard/billing/subscription` + `/usage` with the provider sk- key (`Authorization: Bearer`)
5. Backend computes `remaining = hard_limit_usd - total_usage/100` (total_usage in cents), parses `access_until` as expiry; balances[] reports 剩余/已用/总额。`hard_limit_usd === 100000000` 哨兵表示无限额令牌：`unlimited=true`、`balance=null`，balances 只含「已用」（usage 不可用为空数组），不写日快照
6. Frontend displays result in a toast: 有限额度显示剩余/已用/总额+到期日；无限额显示「余额：无限额，已用 X USD」

### Error Handling
- Provider not found → 404 with `provider_not_found` error
- Provider without a supported upstream_type → 400 with `balance_unsupported` error
- Upstream timeout → 504 with `upstream_timeout` error
- Upstream error → 502 with `upstream_error` error

### UI Integration
- Balance button only visible for providers with `upstream_type='newapi'`
- Button disabled during query (balanceMutation.isPending)
- Success shows formatted balance: "余额：12.34 USD"
- Errors show in result notification

## Next Steps for Sub2API Support
- Implement Sub2API balance endpoint discovery and parsing
- Add sub2api to upstream_type validation
- Update UI to show balance button for both newapi and sub2api providers
