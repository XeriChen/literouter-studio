import type { ModelAlias } from '@/api/types'

/** 与 Playground 的 active 目标可用条件一致，不代表上游推理已验证。 */
export function isAliasAvailable(alias: ModelAlias): boolean {
  return alias.enabled === 1
    && alias.provider_id !== null
    && alias.model_id !== null
    && alias.provider_enabled === 1
    && alias.target_enabled === 1
}
