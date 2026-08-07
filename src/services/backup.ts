export interface BackupData {
  token: string
  settings: Record<string, string>
  providers: unknown[]
  models: unknown[]
}

export function exportBackup(): BackupData {
  // TODO: 导出 settings + providers + models + token（不含 logs）
  throw new Error('backup not implemented')
}

export function importBackup(_data: BackupData): void {
  // TODO: 全量覆盖（settings/providers/models/token），事务执行，失败回滚，不影响 logs
  throw new Error('backup not implemented')
}