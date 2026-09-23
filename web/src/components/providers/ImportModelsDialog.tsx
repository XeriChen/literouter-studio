import { Eraser, Loader2, Search, Undo2 } from 'lucide-react'
import type { ProviderModel } from '@/api/types'
import type { ConfirmOptions } from '@/components/ConfirmDialog'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'

export function ImportModelsDialog({
  fetchDialog,
  onFetchDialogChange,
  upstreamModels,
  upstreamLoading,
  selectedModels,
  onSelectedModelsChange,
  modelSearch,
  onModelSearchChange,
  createAlias,
  onCreateAliasChange,
  filteredUpstream,
  importedById,
  importedFetchedIds,
  toggleUpstreamModel,
  confirm,
  cleanupPending,
  onCleanup,
  cancelPending,
  onCancelImport,
  importPending,
  onImport,
}: {
  fetchDialog: { providerId: string; providerName: string } | null
  onFetchDialogChange: (value: { providerId: string; providerName: string } | null) => void
  upstreamModels: string[]
  upstreamLoading: boolean
  selectedModels: Set<string>
  onSelectedModelsChange: (value: Set<string>) => void
  modelSearch: string
  onModelSearchChange: (value: string) => void
  createAlias: boolean
  onCreateAliasChange: (value: boolean) => void
  filteredUpstream: string[]
  importedById: Map<string, ProviderModel>
  importedFetchedIds: string[]
  toggleUpstreamModel: (id: string) => void
  confirm: (options: ConfirmOptions) => Promise<boolean>
  cleanupPending: boolean
  onCleanup: (providerId: string) => void
  cancelPending: boolean
  onCancelImport: (input: { providerId: string; modelId: string }) => void
  importPending: boolean
  onImport: (input: { providerId: string; modelIds: string[]; createAlias: boolean }) => void
}) {
  return (
    <Dialog open={!!fetchDialog} onOpenChange={(open) => { if (!open) onFetchDialogChange(null) }}>
      <DialogContent className="flex max-h-[calc(100dvh-2rem)] w-[calc(100%-2rem)] max-w-lg flex-col overflow-hidden">
        <DialogHeader className="shrink-0">
          <DialogTitle>选择要导入的模型</DialogTitle>
          <DialogDescription>{fetchDialog ? `从「${fetchDialog.providerName}」拉取到 ${upstreamModels.length} 个模型` : ''}</DialogDescription>
        </DialogHeader>
        {upstreamLoading ? (
          <div className="flex items-center justify-center gap-2 py-8 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" /> 正在拉取模型列表...
          </div>
        ) : (
          <div className="min-h-0 flex-1 space-y-3 overflow-y-auto overscroll-contain py-1 pr-1">
            <div className="relative">
              <Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
              <Input className="pl-8 text-sm" placeholder="模型名" value={modelSearch} onChange={(event) => onModelSearchChange(event.target.value)} />
            </div>
            <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
              <span>
                已选 {selectedModels.size} / {upstreamModels.length}
                {modelSearch.trim() ? `（筛选 ${filteredUpstream.length} 个）` : ''}
                {importedFetchedIds.length > 0 && <>，已导入 {importedFetchedIds.length} 个</>}
              </span>
              <div className="flex flex-wrap items-center gap-2">
                {importedFetchedIds.length > 0 && (
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-7 text-xs"
                    disabled={cleanupPending}
                    title="删除该 Provider 全部拉取导入的模型（手动添加的模型不受影响）"
                    onClick={async () => {
                      if (await confirm({ title: '一键清理导入模型？', description: `确定清理「${fetchDialog?.providerName ?? ''}」已导入的 ${importedFetchedIds.length} 个模型？手动添加的模型不受影响；同名映射保留，可在模型映射页清理无候选的无效映射。`, confirmLabel: '清理', destructive: true })) {
                        onCleanup(fetchDialog!.providerId)
                      }
                    }}
                  >
                    <Eraser className="h-3.5 w-3.5" />
                    {cleanupPending ? '清理中...' : `一键清理已导入（${importedFetchedIds.length}）`}
                  </Button>
                )}
                <div className="flex items-center gap-2">
                  <button className="hover:underline" onClick={() => onSelectedModelsChange(new Set([...selectedModels, ...filteredUpstream]))}>全选</button>
                  <button className="hover:underline" onClick={() => { const filtered = new Set(filteredUpstream); onSelectedModelsChange(new Set([...selectedModels].filter((id) => !filtered.has(id)))) }}>全不选</button>
                </div>
              </div>
            </div>
            <div className="max-h-64 space-y-0.5 overflow-y-auto rounded-md border p-2">
              {filteredUpstream.map((id) => {
                const imported = importedById.get(id)
                const isFetched = imported?.source === 'fetched'
                return (
                  <div key={id} className={`flex items-center gap-2 rounded px-2 py-1.5 text-sm ${isFetched ? 'bg-muted/40' : 'hover:bg-muted'}`}>
                    <Checkbox checked={selectedModels.has(id)} onCheckedChange={() => toggleUpstreamModel(id)} aria-label={`选择 ${id}`} />
                    <span className="min-w-0 flex-1 truncate font-mono text-xs" title={id}>{id}</span>
                    {imported && <Badge variant={isFetched ? 'secondary' : 'outline'} className="shrink-0">{isFetched ? '已导入' : '已添加'}</Badge>}
                    {isFetched && (
                      <Button
                        variant="ghost"
                        size="icon"
                        className="icon-button h-7 w-7 shrink-0 text-muted-foreground hover:text-destructive"
                        disabled={cancelPending}
                        title="取消导入（删除该导入模型，可重新导入）"
                        aria-label={`取消导入 ${id}`}
                        onClick={async () => {
                          if (await confirm({ title: '取消导入？', description: `取消导入「${id}」？将从该 Provider 删除此模型。`, confirmLabel: '取消导入', destructive: true })) {
                            onCancelImport({ providerId: fetchDialog!.providerId, modelId: id })
                          }
                        }}
                      >
                        <Undo2 className="h-3.5 w-3.5" />
                      </Button>
                    )}
                  </div>
                )
              })}
              {!filteredUpstream.length && <p className="py-4 text-center text-sm text-muted-foreground">{upstreamModels.length === 0 ? '未获取到模型' : '无匹配模型'}</p>}
            </div>
            <label className="flex cursor-pointer items-start gap-2 rounded-md border p-2 text-xs">
              <Checkbox checked={createAlias} onCheckedChange={(checked) => onCreateAliasChange(checked === true)} className="mt-0.5" />
              <span>
                <span className="font-medium">同时创建同名映射</span>
                <span className="block text-muted-foreground">取消勾选只登记模型，不创建同名映射；未建映射的模型无法被代理请求。</span>
              </span>
            </label>
          </div>
        )}
        <DialogFooter className="shrink-0 border-t pt-2 sm:border-t-0">
          <Button variant="outline" onClick={() => onFetchDialogChange(null)}>取消</Button>
          <Button disabled={selectedModels.size === 0 || importPending} onClick={() => fetchDialog && onImport({ providerId: fetchDialog.providerId, modelIds: [...selectedModels], createAlias })}>
            {importPending && <Loader2 className="h-4 w-4 animate-spin" />} 导入 {selectedModels.size} 个模型
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
