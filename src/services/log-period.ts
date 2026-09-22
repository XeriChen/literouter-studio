export type LogPeriod = 'today' | 'week' | 'month'

export function parseLogPeriod(value: string | undefined): LogPeriod | undefined {
  if (value === 'today' || value === 'week' || value === 'month') return value
  return undefined
}

/** 本地日历的区间起点。本周从周一开始。 */
export function logPeriodStart(period: LogPeriod, now = new Date()): Date {
  const start = new Date(now.getTime())
  start.setHours(0, 0, 0, 0)
  if (period === 'week') {
    const weekday = start.getDay()
    const fromMonday = weekday === 0 ? 6 : weekday - 1
    start.setDate(start.getDate() - fromMonday)
  } else if (period === 'month') {
    start.setDate(1)
  }
  return start
}
