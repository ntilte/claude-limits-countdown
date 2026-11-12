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

const MIN_MS = 60_000
export const MAX_DELAY_MS = 7 * 24 * 60 * MIN_MS

// A wait as a person writes it: "90" (minutes), "2ч", "1ч30м", "1.5h",
// "45 мин", "1:30". Null for anything else, under a minute or over a week.
export function parseDelay(raw: string): number | null {
  const s = raw.trim().toLowerCase().replace(/,/g, '.')
  if (s === '') return null

  let minutes: number | null = null
  const clock = /^(\d{1,3}):(\d{1,2})$/.exec(s)
  const parts =
    /^(?:(\d+(?:\.\d+)?)\s*(?:ч|час[а-я]*|h|hours?|hrs?))?\s*(?:(\d+(?:\.\d+)?)\s*(?:м|мин[а-я]*|m|min[a-z]*)?)?$/.exec(s)

  if (clock) minutes = Number(clock[1]) * 60 + Number(clock[2])
  else if (parts && (parts[1] !== undefined || parts[2] !== undefined)) {
    minutes = Number(parts[1] ?? 0) * 60 + Number(parts[2] ?? 0)
  }
  if (minutes === null || !Number.isFinite(minutes)) return null

  const ms = Math.round(minutes * MIN_MS)
  return ms >= MIN_MS && ms <= MAX_DELAY_MS ? ms : null
}

// The start of a held message, on one line, to tell it by.
export function preview(text: string, max = 28): string {
  const line = text.replace(/\s+/g, ' ').trim()
  return line.length <= max ? line : `${line.slice(0, max - 1)}…`
}

// One gauge of the band where a surface draws bars: a short coloured label,
// a quiet detail beside it and how full the bar is.
export type Meter = { key: string; label: string; detail: string; color: string; percent: number }

export function limitMeters(limits: readonly Limit[], now: number): Meter[] {
  return [...limits]
    .sort((a, b) => rank(a.kind) - rank(b.kind))
    .map(limit => {
      const name = labelOf(limit.kind)
      const percent = Math.round(limit.percentUsed)
      const resetsAt = limit.resetsAt === undefined ? NaN : Date.parse(limit.resetsAt)

      if (!Number.isNaN(resetsAt) && resetsAt <= now) {
        return { key: limit.kind, label: name, detail: 'лимит обновился', color: 'success', percent: 0 }
      }
      return {
        key: limit.kind,
        label: `${name} ${percent}%`,
        detail: Number.isNaN(resetsAt) ? '' : formatLeft(resetsAt - now),
        color: toneOf(limit.kind, percent),
        percent,
      }
    })
}

export function contextMeter(context: Context | null, compactedTo: number | null): Meter | null {
  if (context === null || !(context.window > 0)) return null

  const window = formatTokens(context.window)
  const percentOf = (tokens: number) => Math.round((tokens / context.window) * 100)

  if (context.tokens !== undefined) {
    const percent = context.percent ?? percentOf(context.tokens)
    return {
      key: 'context',
      label: `Контекст ${percent}%`,
      detail: `${formatTokens(context.tokens)} из ${window}`,
      color: toneOf('context', percent),
      percent,
    }
  }
  if (compactedTo !== null) {
    const percent = percentOf(compactedTo)
    return {
      key: 'context',
      label: `Контекст ≈${percent}%`,
      detail: `${formatTokens(compactedTo)} из ${window}, после сжатия`,
      color: toneOf('context', percent),
      percent,
    }
  }
  return { key: 'context', label: 'Контекст', detail: 'обновится после ответа', color: colorOf('context'), percent: 0 }
}

// A bar is drawn as an image, where the theme's keys mean nothing: each key
// the band uses has a colour that reads on a light and on a dark page.
const HEX: Record<string, string> = {
  suggestion: '#5B9DF0',
  merged: '#A78BFA',
  claude: '#D97757',
  warning: '#E0A030',
  error: '#E5484D',
  success: '#46A758',
}

export const BAR_WIDTH = 200

export function barOf(percent: number, color: string): string {
  const filled = Math.round((Math.min(100, Math.max(0, percent)) / 100) * BAR_WIDTH)
  const fill = HEX[color] ?? '#888888'
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${BAR_WIDTH}" height="4" viewBox="0 0 ${BAR_WIDTH} 4">` +
    `<rect width="${BAR_WIDTH}" height="4" rx="2" fill="#888888" fill-opacity="0.3"/>` +
    (filled > 0 ? `<rect width="${Math.max(4, filled)}" height="4" rx="2" fill="${fill}"/>` : '') +
    '</svg>'
  )
}
