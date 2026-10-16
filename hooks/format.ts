import type { Context, Limit } from '../types'

const ORDER = ['five_hour', 'seven_day']

export function labelOf(kind: string): string {
  if (kind === 'five_hour') return 'Сессия'
  if (kind === 'seven_day') return 'Неделя'
  if (kind.startsWith('seven_day_')) return `Неделя · ${kind.slice('seven_day_'.length)}`
  if (kind === 'spend_limit') return 'Расход'
  return kind
}

export function formatLeft(ms: number): string {
  const minutes = Math.floor(ms / 60_000)
  if (minutes < 1) return 'меньше минуты'

  const d = Math.floor(minutes / 1440)
  const h = Math.floor((minutes % 1440) / 60)
  const m = minutes % 60

  if (d > 0) return h > 0 ? `${d} д ${h} ч` : `${d} д`
  if (h > 0) return m > 0 ? `${h} ч ${m} мин` : `${h} ч`
  return `${m} мин`
}

function rank(kind: string): number {
  const i = ORDER.indexOf(kind)
  return i === -1 ? ORDER.length : i
}

export type Row = { text: string; color: string }

// Theme keys, so the colours follow the person's light or dark theme.
function colorOf(kind: string): string {
  if (kind === 'five_hour') return 'suggestion'
  if (kind.startsWith('seven_day')) return 'merged'
  if (kind === 'context') return 'claude'
  return 'text'
}

// Near the edge the group's own colour gives way to a warning.
export function toneOf(kind: string, percent: number): string {
  if (percent >= 90) return 'error'
  if (percent >= 75) return 'warning'
  return colorOf(kind)
}

export function describeLimits(limits: readonly Limit[], now: number): Row[] {
  return [...limits]
    .sort((a, b) => rank(a.kind) - rank(b.kind))
    .map(limit => {
      const label = labelOf(limit.kind)
      const percent = Math.round(limit.percentUsed)
      const color = toneOf(limit.kind, percent)
      const resetsAt = limit.resetsAt === undefined ? NaN : Date.parse(limit.resetsAt)

      if (Number.isNaN(resetsAt)) return { text: `${label}: ${percent}%`, color }
      if (resetsAt <= now) return { text: `${label}: лимит обновился`, color: 'success' }

      return { text: `${label}: ${percent}%, сброс через ${formatLeft(resetsAt - now)}`, color }
    })
}

export function formatTokens(n: number): string {
  if (n < 1000) return String(n)
  const k = Math.round(n / 1000)
  if (k < 1000) return `${k}k`
  return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`
}

// The fill comes with each reply; right after a compaction there is none
// yet, so the size the compaction reported stands in until the next one.
export function describeContext(context: Context | null, compactedTo: number | null): Row | null {
  if (context === null || !(context.window > 0)) return null

  const window = formatTokens(context.window)
  const percentOf = (tokens: number) => Math.round((tokens / context.window) * 100)

  if (context.tokens !== undefined) {
    const percent = context.percent ?? percentOf(context.tokens)
    return {
      text: `Контекст: ${percent}% (${formatTokens(context.tokens)} из ${window})`,
      color: toneOf('context', percent),
    }
  }
  if (compactedTo !== null) {
    const percent = percentOf(compactedTo)
    return {
      text: `Контекст: ≈${percent}% (${formatTokens(compactedTo)} из ${window}) после сжатия`,
      color: toneOf('context', percent),
    }
  }
  return { text: 'Контекст: обновится после ответа', color: colorOf('context') }
}
