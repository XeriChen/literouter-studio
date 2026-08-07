import { db } from '../db'
import type { ProviderModelRow } from '../types'

export function listModels(): ProviderModelRow[] {
  return db.prepare('SELECT * FROM provider_models ORDER BY provider_id, model_id').all() as ProviderModelRow[]
}

export function addModel(input: {
  provider_id: string
  model_id: string
  display_name: string | null
}): void {
  // TODO: 手动添加模型
}

export function setModelEnabled(input: {
  provider_id: string
  model_id: string
  enabled: number
}): void {
  // TODO: 更新启用状态，并执行"同协议同名模型互斥"逻辑（事务）
  db.transaction(() => {})()
}

export function deleteModel(input: { provider_id: string; model_id: string }): void {
  db.prepare('DELETE FROM provider_models WHERE provider_id = ? AND model_id = ?').run(
    input.provider_id,
    input.model_id,
  )
}