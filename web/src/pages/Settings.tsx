import { useEffect, useRef, useState } from 'react'
import { useMutation, useQuery } from '@tanstack/react-query'
import { Download, KeyRound, Loader2, Upload } from 'lucide-react'
import { api, clearToken } from '@/api/client'
import type { BackupData } from '@/api/types'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'

export default function Settings() {
  const [notice, setNotice] = useState<string | null>(null)
  const [exportWarnOpen, setExportWarnOpen] = useState(false)
  const [importWarnOpen, setImportWarnOpen] = useState(false)
  const [resetConfirmOpen, setResetConfirmOpen] = useState(false)
  const [importFile, setImportFile] = useState<File | null>(null)
  const [form, setForm] = useState({ host: '0.0.0.0', port: '3000', global_timeout_ms: '120000' })
  const fileRef = useRef<HTMLInputElement>(null)

  const settingsQuery = useQuery({
    queryKey: ['settings'],
    queryFn: () => api<{ ok: true; data: Record<string, string> }>('/api/settings').then((r) => r.data),
  })
  const meQuery = useQuery({
    queryKey: ['me'],
    queryFn: () => api<{ ok: true; data: { token: string } }>('/api/me').then((r) => r.data),
  })

  useEffect(() => {
    if (settingsQuery.data) {
      setForm({
        host: settingsQuery.data.host ?? '0.0.0.0',
        port: settingsQuery.data.port ?? '3000',
        global_timeout_ms: settingsQuery.data.global_timeout_ms ?? '120000',
      })
    }
  }, [settingsQuery.data])

  const saveSettings = useMutation({
    mutationFn: () => api('/api/settings', { method: 'PUT', body: JSON.stringify(form) }),
    onSuccess: () => setNotice('设置已保存（host/port 需重启后端生效）'),
    onError: (err) => setNotice(`保存失败：${err instanceof Error ? err.message : String(err)}`),
  })

  const resetToken = useMutation({
    mutationFn: () =>
      api<{ ok: true; data: { token: string } }>('/api/token/reset', { method: 'POST' }).then((r) => r.data.token),
    onSuccess: () => {
      setNotice('Token 已重置，请立即复制保存')
      setResetConfirmOpen(false)
      meQuery.refetch()
    },
  })

  function doExport(backup: BackupData) {
    const blob = new Blob([JSON.stringify(backup, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `llm-gateway-backup-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.json`
    a.click()
    URL.revokeObjectURL(url)
    setNotice('备份已导出，请妥善保管（含明文 API Key）')
    setExportWarnOpen(false)
  }

  function doImport() {
    if (!importFile) return
    const reader = new FileReader()
    reader.onload = async () => {
      try {
        const data = JSON.parse(String(reader.result)) as BackupData
        await api('/api/backup', { method: 'POST', body: JSON.stringify(data) })
        setImportWarnOpen(false)
        clearToken()
        window.location.href = '/login'
      } catch (err) {
        setNotice(`导入失败：${err instanceof Error ? err.message : '文件格式错误'}`)
        setImportWarnOpen(false)
      }
    }
    reader.readAsText(importFile)
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">Settings</h1>
        {notice && <span className="text-sm text-muted-foreground">{notice}</span>}
      </div>

      <Card>
        <CardHeader>
          <CardTitle>网关设置</CardTitle>
          <CardDescription>监听地址与端口修改后需重启后端生效；全局超时 0 表示不超时</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid max-w-lg grid-cols-3 gap-4">
            <div className="space-y-2">
              <Label>监听地址</Label>
              <Input value={form.host} onChange={(e) => setForm({ ...form, host: e.target.value })} />
            </div>
            <div className="space-y-2">
              <Label>端口</Label>
              <Input value={form.port} onChange={(e) => setForm({ ...form, port: e.target.value })} />
            </div>
            <div className="space-y-2">
              <Label>全局超时(ms)</Label>
              <Input
                value={form.global_timeout_ms}
                onChange={(e) => setForm({ ...form, global_timeout_ms: e.target.value })}
                placeholder="0 不超时"
              />
            </div>
          </div>
          <Button size="sm" onClick={() => saveSettings.mutate()} disabled={saveSettings.isPending || settingsQuery.isLoading}>
            {saveSettings.isPending && <Loader2 className="h-4 w-4 animate-spin" />}
            保存设置
          </Button>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Token</CardTitle>
          <CardDescription>网关管理 API 与代理入口的统一校验 Token，明文存储于 data/gateway.db</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex items-center gap-2">
            <code className="max-w-md truncate rounded bg-muted px-2 py-1 text-xs">
              {meQuery.isLoading ? '加载中...' : meQuery.data?.token ?? '（空）'}
            </code>
            <Badge variant="secondary">admin</Badge>
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                if (meQuery.data?.token) void navigator.clipboard.writeText(meQuery.data.token)
              }}
            >
              复制
            </Button>
          </div>
          <Button variant="destructive" size="sm" onClick={() => setResetConfirmOpen(true)}>
            <KeyRound className="h-4 w-4" /> 重置 Token
          </Button>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>备份</CardTitle>
          <CardDescription>导出/导入全部 Provider、模型、设置与 Token；导入会全量覆盖并强制重新登录</CardDescription>
        </CardHeader>
        <CardContent className="flex gap-2">
          <Button variant="outline" size="sm" onClick={() => setExportWarnOpen(true)}>
            <Download className="h-4 w-4" /> 导出备份
          </Button>
          <input
            ref={fileRef}
            type="file"
            accept="application/json,.json"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0] ?? null
              if (f) {
                setImportFile(f)
                setImportWarnOpen(true)
              }
              e.target.value = ''
            }}
          />
          <Button variant="outline" size="sm" onClick={() => fileRef.current?.click()}>
            <Upload className="h-4 w-4" /> 导入备份
          </Button>
        </CardContent>
      </Card>

      <Dialog open={exportWarnOpen} onOpenChange={setExportWarnOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>导出前警告</DialogTitle>
            <DialogDescription className="text-amber-600">
              备份文件包含所有 Provider 的明文 API Key 和网关 Token，请妥善保管，切勿泄露到不信任环境。
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setExportWarnOpen(false)}>取消</Button>
            <Button
              onClick={async () => {
                try {
                  const res = await api<{ ok: true; data: BackupData }>('/api/backup')
                  doExport(res.data)
                } catch (err) {
                  setNotice(`导出失败：${err instanceof Error ? err.message : String(err)}`)
                  setExportWarnOpen(false)
                }
              }}
            >
              确认导出
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={importWarnOpen} onOpenChange={setImportWarnOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>导入警告</DialogTitle>
            <DialogDescription className="text-amber-600">
              导入将全量覆盖现有 Providers、模型、设置与 Token。成功后需使用备份中的 Token 重新登录。
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setImportWarnOpen(false)}>取消</Button>
            <Button onClick={doImport}>确认导入</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={resetConfirmOpen} onOpenChange={setResetConfirmOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>重置 Token？</DialogTitle>
            <DialogDescription>旧 Token 立即失效，所有使用旧 Token 的客户端会被登出。</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setResetConfirmOpen(false)}>取消</Button>
            <Button onClick={() => resetToken.mutate()}>确认重置</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}