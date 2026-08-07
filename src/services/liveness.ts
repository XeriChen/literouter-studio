import type { Hono } from 'hono'

export function registerProviderLiveness(_h: Hono): void {
  // TODO: 模型测活 —— 构造非流式 Chat 请求（30s 硬超时），
  // 提示词黑名单校验（禁 "hi/hello/你好/测试/test/1" 等，且 trim 后 >= 4 字符）
}