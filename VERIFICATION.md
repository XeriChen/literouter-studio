# New API Balance Query Feature Verification

## Implementation Summary

### Backend
- `src/crypto.ts`: AES-256-GCM encryption for provider credentials
- `src/services/balance.ts`: `fetchNewApiBalance()` queries `/api/user/self` endpoint, converts quota to USD
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
4. Backend queries New API `/api/user/self` endpoint with provider auth
5. Backend converts quota to USD: `balance = quota / 500000`
6. Frontend displays result in toast notification

### Error Handling
- Provider not found → 404 with `provider_not_found` error
- Non-newapi provider → 400 with `invalid_upstream_type` error
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
