import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { createNoticeQueue, NOTICE_DISMISS_MS, NOTICE_FADE_MS, NOTICE_HOLD_MS } from '../web/src/lib/notice-lifetime'

function fakeClock() {
  let now = 0
  let nextId = 1
  const pending: Array<{ id: number; at: number; run: () => void }> = []

  return {
    setTimeout(run: () => void, ms: number) {
      const id = nextId++
      pending.push({ id, at: now + ms, run })
      return id
    },
    clearTimeout(id: number) {
      const index = pending.findIndex((item) => item.id === id)
      if (index >= 0) pending.splice(index, 1)
    },
    advance(ms: number) {
      now += ms
      for (;;) {
        const due = pending
          .filter((item) => item.at <= now)
          .sort((a, b) => a.at - b.at || a.id - b.id)
        const next = due[0]
        if (!next) break
        const index = pending.findIndex((item) => item.id === next.id)
        pending.splice(index, 1)
        next.run()
      }
    },
  }
}

test('operation notices stay solid for 5 seconds, then fade for 5 seconds', () => {
  assert.equal(NOTICE_HOLD_MS, 5_000)
  assert.equal(NOTICE_FADE_MS, 5_000)

  const clock = fakeClock()
  const queue = createNoticeQueue<{ message: string }>(clock)
  queue.push({ message: '已保存' })

  clock.advance(4_999)
  assert.equal(queue.getItems()[0]?.leaving, false)

  clock.advance(1)
  assert.equal(queue.getItems()[0]?.leaving, true)
  assert.equal(queue.getItems()[0]?.fadeMs, 5_000)
  assert.equal(queue.getItems()[0]?.message, '已保存')

  clock.advance(4_999)
  assert.equal(queue.getItems().length, 1)

  clock.advance(1)
  assert.deepEqual(queue.getItems(), [])
})

test('closing early fades immediately and cancels the hold timer', () => {
  assert.equal(NOTICE_DISMISS_MS, 400)
  const clock = fakeClock()
  const queue = createNoticeQueue<{ message: string }>(clock)
  const id = queue.push({ message: '失败' })

  clock.advance(1_000)
  queue.leave(id, NOTICE_DISMISS_MS)
  queue.leave(id, NOTICE_DISMISS_MS)
  assert.equal(queue.getItems()[0]?.leaving, true)
  assert.equal(queue.getItems()[0]?.fadeMs, 400)

  clock.advance(400)
  assert.deepEqual(queue.getItems(), [])

  clock.advance(20_000)
  assert.deepEqual(queue.getItems(), [])
})

test('each notice keeps its own timer', () => {
  const clock = fakeClock()
  const queue = createNoticeQueue<{ message: string }>(clock)
  queue.push({ message: '第一条' })
  clock.advance(4_000)
  queue.push({ message: '第二条' })

  clock.advance(1_000)
  assert.deepEqual(
    queue.getItems().map((item) => [item.message, item.leaving]),
    [
      ['第一条', true],
      ['第二条', false],
    ],
  )

  clock.advance(4_000)
  assert.deepEqual(
    queue.getItems().map((item) => [item.message, item.leaving]),
    [
      ['第一条', true],
      ['第二条', true],
    ],
  )

  clock.advance(1_000)
  assert.deepEqual(
    queue.getItems().map((item) => [item.message, item.leaving]),
    [['第二条', true]],
  )

  clock.advance(4_000)
  assert.deepEqual(queue.getItems(), [])
})

test('dispose drops pending timers', () => {
  const clock = fakeClock()
  const queue = createNoticeQueue<{ message: string }>(clock)
  queue.push({ message: '仍在' })
  queue.dispose()
  clock.advance(20_000)
  assert.equal(queue.getItems()[0]?.leaving, false)
})

test('replacing a notice drops the previous timer', () => {
  const clock = fakeClock()
  const queue = createNoticeQueue<{ token: string }>(clock)
  const first = queue.push({ token: '保存成功' })
  clock.advance(4_000)
  queue.drop(first)
  queue.push({ token: '保存成功' })
  clock.advance(4_999)
  assert.equal(queue.getItems()[0]?.leaving, false)
  clock.advance(1)
  assert.equal(queue.getItems()[0]?.leaving, true)
  clock.advance(5_000)
  assert.deepEqual(queue.getItems(), [])
})

test('notice stylesheet fades the leaving banner over 5 seconds', () => {
  const css = readFileSync(new URL('../web/src/index.css', import.meta.url), 'utf8')
  assert.match(css, /\.notice\.is-leaving,[\s\S]*?\.toast-banner\.is-leaving\s*\{[^}]*notice-fade 5s linear forwards/)
  assert.match(css, /@keyframes notice-fade\s*\{[\s\S]*?to\s*\{\s*opacity:\s*0/)
})
