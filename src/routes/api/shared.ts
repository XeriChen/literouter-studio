import type { Context } from 'hono'
import type { ContentfulStatusCode } from 'hono/utils/http-status'
import { z } from 'zod'
import { parseAuth, parseCustomHeaders } from '../../providers/headers'
import {
  MAX_REQUEST_BODY_BYTES,
  readRequestBody,
  RequestBodyTooLargeError,
} from '../../proxy/body'
import type { ApiResponse, Env, ProviderRow } from '../../types'

export type ApiContext = Context<Env>

export function ok<T>(c: ApiContext, data: T) {
  return c.json({ ok: true, data } as ApiResponse<T>)
}

export function fail(c: ApiContext, status: number, message: string, code: string) {
  return c.json(
    { ok: false, error: { message, type: code, code } } as ApiResponse<never>,
    status as ContentfulStatusCode,
  )
}

export async function readJson(c: ApiContext): Promise<unknown | null> {
  try {
    const bytes = await readRequestBody(c.req.raw, MAX_REQUEST_BODY_BYTES)
    if (bytes.byteLength === 0) return null
    return JSON.parse(new TextDecoder().decode(bytes)) as unknown
  } catch (error) {
    if (error instanceof RequestBodyTooLargeError || c.req.raw.signal.aborted) throw error
    return null
  }
}

export const nonEmptyText = z.string().trim().min(1)

const httpUrl = z.string().trim().refine(
  (value) => {
    try {
      const { protocol } = new URL(value)
      return protocol === 'http:' || protocol === 'https:'
    } catch {
      return false
    }
  },
  'must be an HTTP(S) URL',
)

export const authSchema = z.record(z.string().min(1), z.string())

const nonNegativeIntegerText = z
  .string()
  .regex(/^\d+$/)
  .refine((value) => Number.isSafeInteger(Number(value)), 'must be a safe integer')

export const settingsSchema = z.object({
  host: nonEmptyText.optional(),
  port: z.string().regex(/^\d{1,5}$/).refine((value) => Number(value) >= 1 && Number(value) <= 65535, 'port 无效').optional(),
  global_timeout_ms: nonNegativeIntegerText.optional(),
  log_retention_days: nonNegativeIntegerText.optional(),
})

export const providerSchema = z.object({
  name: nonEmptyText,
  protocol: z.enum(['openai', 'anthropic']),
  group_id: nonEmptyText.nullable().optional(),
  base_url: httpUrl,
  auth: authSchema.default({}),
  custom_headers: authSchema.default({}),
  proxy_url: httpUrl.nullable().optional(),
  timeout_ms: z.number().int().min(0).nullable().optional(),
  model_filter: z.string().nullable().optional(),
})

export const providerPatchSchema = providerSchema
  .omit({ protocol: true })
  .partial()
  .extend({ enabled: z.union([z.literal(0), z.literal(1)]).optional() })
  .refine((value) => Object.keys(value).length > 0, 'provider patch cannot be empty')

export const modelRefSchema = z.object({
  provider_id: nonEmptyText,
  model_id: nonEmptyText,
})

export const aliasRefSchema = z.object({
  protocol: z.enum(['openai', 'anthropic']),
  alias_name: nonEmptyText,
})

export const aliasSchema = aliasRefSchema.extend({
  provider_id: nonEmptyText,
  model_id: nonEmptyText,
  group_id: nonEmptyText.nullable().optional(),
  enabled: z.union([z.literal(0), z.literal(1)]).optional(),
})

export const aliasPatchSchema = aliasRefSchema.extend({
  new_alias_name: nonEmptyText.optional(),
  group_id: nonEmptyText.nullable().optional(),
  enabled: z.union([z.literal(0), z.literal(1)]).optional(),
  provider_id: nonEmptyText.optional(),
  model_id: nonEmptyText.optional(),
}).refine(
  (value) => value.new_alias_name !== undefined || value.group_id !== undefined || value.enabled !== undefined
    || (value.provider_id !== undefined && value.model_id !== undefined),
  'alias patch cannot be empty',
).refine(
  (value) => (value.provider_id === undefined) === (value.model_id === undefined),
  'provider_id and model_id must be provided together',
)

export const aliasGroupRefSchema = z.object({
  protocol: z.enum(['openai', 'anthropic']),
  group_id: nonEmptyText,
})

export const providerGroupRefSchema = z.object({
  protocol: z.enum(['openai', 'anthropic']),
  group_id: nonEmptyText,
})

export const aliasTargetRefSchema = aliasRefSchema.extend({
  provider_id: nonEmptyText,
  model_id: nonEmptyText,
})

export function providerOut(provider: ProviderRow) {
  return {
    id: provider.id,
    name: provider.name,
    protocol: provider.protocol,
    group_id: provider.group_id,
    base_url: provider.base_url,
    auth: parseAuth(provider),
    custom_headers: parseCustomHeaders(provider),
    proxy_url: provider.proxy_url,
    timeout_ms: provider.timeout_ms,
    model_filter: provider.model_filter,
    enabled: provider.enabled,
    created_at: provider.created_at,
    updated_at: provider.updated_at,
  }
}
