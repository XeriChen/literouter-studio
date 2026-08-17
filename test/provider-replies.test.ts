import assert from 'node:assert/strict'
import test from 'node:test'
import { extractAnthropicReply } from '../src/providers/anthropic'
import { extractOpenAIReply } from '../src/providers/openai'

test('reply extractors tolerate malformed upstream JSON', () => {
  assert.equal(extractOpenAIReply(null), '')
  assert.equal(extractOpenAIReply({ choices: [{ message: { content: 42 } }] }), '')
  assert.equal(extractAnthropicReply({ content: [null, { text: 'hello' }, { text: 7 }] }), 'hello')
  assert.equal(extractAnthropicReply({ content: 'not-an-array' }), '')
})
