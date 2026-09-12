import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { fetchNewApiBalance } from '../src/services/balance'
import { createProvider } from '../src/services/providers'
import { db } from '../src/db'

describe('balance service', () => {
  it('should reject non-newapi provider', async () => {
    db.exec('DELETE FROM providers')
    const provider = createProvider({
      name: 'Standard OpenAI',
      protocol: 'openai',
      group_id: null,
      base_url: 'https://api.openai.com/v1',
      auth_json: JSON.stringify({ api_key: 'sk-test' }),
      custom_headers_json: '{}',
      proxy_url: null,
      timeout_ms: null,
      model_filter: null,
      upstream_type: null,
    })

    await assert.rejects(
      () => fetchNewApiBalance(provider.id),
      /not a New API instance/,
    )
  })

  it('should reject missing provider', async () => {
    await assert.rejects(
      () => fetchNewApiBalance('nonexistent'),
      /not found/,
    )
  })
})
