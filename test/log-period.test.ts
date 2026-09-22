import assert from 'node:assert/strict'
import test from 'node:test'
import { logPeriodStart, parseLogPeriod } from '../src/services/log-period'
import { formatLogClock } from '../web/src/lib/log-time'

test('parses the three log periods and ignores anything else', () => {
  assert.equal(parseLogPeriod('today'), 'today')
  assert.equal(parseLogPeriod('week'), 'week')
  assert.equal(parseLogPeriod('month'), 'month')
  assert.equal(parseLogPeriod(''), undefined)
  assert.equal(parseLogPeriod('year'), undefined)
  assert.equal(parseLogPeriod(undefined), undefined)
})

test('today, this week and this month start at local midnight', () => {
  const now = new Date(2026, 8, 22, 21, 5, 6)
  const stamp = now.getTime()

  const today = logPeriodStart('today', now)
  assert.equal(today.getFullYear(), 2026)
  assert.equal(today.getMonth(), 8)
  assert.equal(today.getDate(), 22)
  assert.equal(today.getHours(), 0)
  assert.equal(today.getMinutes(), 0)
  assert.equal(today.getSeconds(), 0)

  const week = logPeriodStart('week', now)
  assert.equal(week.getDay(), 1)
  assert.equal(week.getHours(), 0)
  assert.ok(week.getTime() <= today.getTime())
  assert.ok(today.getTime() - week.getTime() < 7 * 24 * 60 * 60 * 1000)

  const month = logPeriodStart('month', now)
  assert.equal(month.getFullYear(), 2026)
  assert.equal(month.getMonth(), 8)
  assert.equal(month.getDate(), 1)
  assert.equal(month.getHours(), 0)

  assert.equal(now.getTime(), stamp)
})

test('a Sunday still belongs to the week that started on Monday', () => {
  const now = new Date(2026, 8, 22, 12)
  const week = logPeriodStart('week', now)
  const sunday = new Date(week)
  sunday.setDate(week.getDate() + 6)
  sunday.setHours(15, 30, 0, 0)
  assert.equal(sunday.getDay(), 0)
  assert.equal(logPeriodStart('week', sunday).getTime(), week.getTime())
})

test('log list clock hides the date', () => {
  const value = new Date(2026, 8, 22, 9, 5, 7).toISOString()
  assert.equal(formatLogClock(value), '09:05:07')
  assert.equal(formatLogClock('not-a-date'), '-')
})
