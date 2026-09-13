/**
 * 上游能力描述符（借鉴 all-api-hub 的能力注册表 + 显式不支持原因）：
 * 管理面按能力查询，而不是散落各处的 upstream_type 字符串分支；
 * 不支持时返回结构化 unsupported + reason，供 UI 显示原因而非渲染坏按钮。
 */

import type { ProviderRow } from '../types'

export type BalanceMethod = 'new_api_token' | 'sub2api'

export interface BalanceCapability {
  supported: boolean
  method: BalanceMethod | null
  /** supported=false 时的显式原因码 */
  reason: 'upstream-type-missing' | 'upstream-type-unsupported' | null
}

export interface UpstreamCapabilities {
  balance: BalanceCapability
}

export function getUpstreamCapabilities(upstreamType: ProviderRow['upstream_type']): UpstreamCapabilities {
  switch (upstreamType) {
    case 'newapi':
      return { balance: { supported: true, method: 'new_api_token', reason: null } }
    case 'sub2api':
      return { balance: { supported: true, method: 'sub2api', reason: null } }
    case null:
      return { balance: { supported: false, method: null, reason: 'upstream-type-missing' } }
    default:
      return { balance: { supported: false, method: null, reason: 'upstream-type-unsupported' } }
  }
}
