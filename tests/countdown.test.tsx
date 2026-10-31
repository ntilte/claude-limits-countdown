import { describe, expect, mock, test } from 'claude-code/testing'
import type { On, SessionContextUsage, SessionRateLimit } from 'claude-code'

import type { Reading } from '../types'
import { formatLeft, formatTokens } from '../hooks/format'

const NOW = Date.parse('2026-10-16T17:06:00Z')
const MIN = 60_000

const LIMITS: SessionRateLimit[] = [
  { kind: 'seven_day', percentUsed: 5, resetsAt: '2026-10-19T23:00:00Z' },
  { kind: 'five_hour', percentUsed: 8, resetsAt: '2026-10-16T20:00:00Z' },
]

const FILLED: SessionContextUsage = { tokens: 120_000, window: 1_000_000, percent: 12 }

const SUMMARY = [{ role: 'user' as const, text: 'Сводка разговора', toolUses: [] }]

const BAND = {
  plugin: 'limits-countdown',
  component: 'AbovePrompt',
  props: {
    hasSurvey: false,
    isWorking: false,
    maxRows: 10,
    bodyColumns: 120,
    scroll: { offset: 0, bodyRows: 9 },
    view: {},
  },
} as const

const SURFACES = ['terminal', 'desktop'] as const
const LIMIT_TEXT = /^(Сессия|Неделя)/

function world(
  on: On,
  rateLimits: SessionRateLimit[],
  stored: Record<string, unknown> = {},
  context: SessionContextUsage = { window: 200_000 },
) {
  const clock = mock.clock(on, { now: NOW })
  // The store file every session reads; the test writes it as another session would.
  const store: Record<string, unknown> = { ...stored }
  on('store.get', ($, e) => ({ value: store[e.key] }))
  on('store.set', ($, e) => {
    store[e.key] = e.value
    return { value: undefined }
  })
  const usage = { context, rateLimits }
  on('session.usage', () => ({ value: { startedAt: NOW, ...usage } }))
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.measure', ($, e) => ({ changed: e.changed }))
  return { clock, store, usage }
}

describe('formatLeft', () => {
  test('days and hours past a day, hours and minutes under it', async () => {
    expect(formatLeft((3 * 24 * 60 + 5 * 60 + 54) * MIN)).toBe('3 д 5 ч')
    expect(formatLeft(2 * 24 * 60 * MIN)).toBe('2 д')
    expect(formatLeft((2 * 60 + 54) * MIN)).toBe('2 ч 54 мин')
    expect(formatLeft(3 * 60 * MIN)).toBe('3 ч')
    expect(formatLeft(45 * MIN + 30_000)).toBe('45 мин')
    expect(formatLeft(30_000)).toBe('меньше минуты')
  })
})

describe('formatTokens', () => {
  test('thousands as k, millions as M', async () => {
    expect(formatTokens(640)).toBe('640')
    expect(formatTokens(120_400)).toBe('120k')
    expect(formatTokens(999_700)).toBe('1M')
    expect(formatTokens(1_000_000)).toBe('1M')
    expect(formatTokens(1_250_000)).toBe('1.3M')
  })
})

describe('colours', () => {
  test('a window near its limit turns yellow, then red', async ($, on) => {
    world(on, [
      { kind: 'five_hour', percentUsed: 92, resetsAt: '2026-10-16T20:00:00Z' },
      { kind: 'seven_day', percentUsed: 80, resetsAt: '2026-10-19T23:00:00Z' },
    ], {}, { tokens: 960_000, window: 1_000_000, percent: 96 })
    await $.session.start({ cwd: 'C:/', surface: 'desktop', isInteractive: true })
    const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })

    const colors = async () => (await ui.findAll({ type: 'Text', text: /^(Сессия|Неделя|Контекст)/ })).map(t => t.props.color)
    expect(await colors()).toEqual(['error', 'warning', 'error'])
  })

  test('a reset window is green', async ($, on) => {
    const { clock } = world(on, LIMITS)
    await $.session.start({ cwd: 'C:/', surface: 'desktop', isInteractive: true })
    const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
    await clock.advance(3 * 60 * MIN)

    expect((await ui.find({ type: 'Text', text: /^Сессия/ }))?.props.color).toBe('success')
  })
})

describe('band', () => {
  test('shows the session first, then the week, as time left', async ($, on) => {
    world(on, LIMITS)
    await $.session.start({ cwd: 'C:/', surface: 'desktop', isInteractive: true })

    for (const surface of SURFACES) {
      const ui = await $.ui.mount({ ...BAND, surface })
      const lines = (await ui.findAll({ type: 'Text', text: LIMIT_TEXT })).map(t => t.text)
      expect(lines).toEqual([
        'Сессия: 8%, сброс через 2 ч 54 мин',
        'Неделя: 5%, сброс через 3 д 5 ч',
      ])
    }
  })

  test('counts down as the clock ticks', async ($, on) => {
    const { clock } = world(on, LIMITS)
    await $.session.start({ cwd: 'C:/', surface: 'desktop', isInteractive: true })
    const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })

    await clock.advance(6 * MIN)

    expect((await ui.find({ type: 'Text', text: /Сессия/ }))?.text).toBe(
      'Сессия: 8%, сброс через 2 ч 48 мин',
    )
  })

  test('a fresh session starts from the last reading kept', async ($, on) => {
    world(on, [], { limits: LIMITS })
    await $.session.start({ cwd: 'C:/', surface: 'desktop', isInteractive: true })
    const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })

    expect((await ui.find({ type: 'Text', text: /Неделя/ }))?.text).toBe(
      'Неделя: 5%, сброс через 3 д 5 ч',
    )
  })

  test('a window whose reset has passed says so', async ($, on) => {
    const { clock } = world(on, LIMITS)
    await $.session.start({ cwd: 'C:/', surface: 'desktop', isInteractive: true })
    const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })

    await clock.advance(3 * 60 * MIN)

    expect((await ui.find({ type: 'Text', text: /Сессия/ }))?.text).toBe('Сессия: лимит обновился')
  })

  test('a new reading replaces the old one', async ($, on) => {
    world(on, LIMITS)
    await $.session.start({ cwd: 'C:/', surface: 'desktop', isInteractive: true })
    await $.session.measure({
      context: { window: 200_000 },
      rateLimits: [{ kind: 'five_hour', percentUsed: 12, resetsAt: '2026-10-16T20:00:00Z' }],
      changed: ['rateLimits'],
    })
    const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })

    const lines = (await ui.findAll({ type: 'Text', text: LIMIT_TEXT })).map(t => t.text)
    expect(lines).toEqual(['Сессия: 12%, сброс через 2 ч 54 мин'])
  })
})

describe('sessions side by side', () => {
  const NEWER: Reading = {
    at: NOW + MIN,
    limits: [
      { kind: 'five_hour', percentUsed: 40, resetsAt: '2026-10-16T20:00:00Z' },
      { kind: 'seven_day', percentUsed: 9, resetsAt: '2026-10-19T23:00:00Z' },
    ],
  }

  test('a measurement that moved is shared with the other sessions', async ($, on) => {
    const { store } = world(on, LIMITS)
    await $.session.start({ cwd: 'C:/', surface: 'desktop', isInteractive: true })
    await $.session.measure({ context: { window: 200_000 }, rateLimits: NEWER.limits, changed: ['rateLimits'] })

    expect(store.reading).toEqual({ at: NOW, limits: NEWER.limits })
  })

  test('an idle session takes up the newer reading another one shared', async ($, on) => {
    const { clock, store } = world(on, LIMITS)
    await $.session.start({ cwd: 'C:/', surface: 'desktop', isInteractive: true })
    const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })

    store.reading = NEWER
    await clock.advance(15_000)

    const lines = (await ui.findAll({ type: 'Text', text: LIMIT_TEXT })).map(t => t.text)
    expect(lines).toEqual(['Сессия: 40%, сброс через 2 ч 53 мин', 'Неделя: 9%, сброс через 3 д 5 ч'])
  })

  test('a fresh session starts from the shared reading', async ($, on) => {
    world(on, [], { reading: NEWER, limits: LIMITS })
    await $.session.start({ cwd: 'C:/', surface: 'desktop', isInteractive: true })
    const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })

    expect((await ui.find({ type: 'Text', text: /^Сессия/ }))?.text).toBe('Сессия: 40%, сброс через 2 ч 54 мин')
  })

  test('a reading that did not move overwrites nothing', async ($, on) => {
    const { clock, store } = world(on, LIMITS, { reading: NEWER })
    await $.session.start({ cwd: 'C:/', surface: 'desktop', isInteractive: true })
    await clock.advance(15_000)
    await $.session.measure({ context: FILLED, rateLimits: LIMITS, changed: ['context'] })
    const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })

    expect(store.reading).toEqual(NEWER)
    expect((await ui.find({ type: 'Text', text: /^Сессия/ }))?.text).toBe('Сессия: 40%, сброс через 2 ч 53 мин')
  })
})

describe('context', () => {
  test('shows the fill on the right on every surface', async ($, on) => {
    world(on, LIMITS, {}, FILLED)
    await $.session.start({ cwd: 'C:/', surface: 'desktop', isInteractive: true })

    for (const surface of SURFACES) {
      const ui = await $.ui.mount({ ...BAND, surface })
      expect((await ui.find({ type: 'Text', text: /^Контекст/ }))?.text).toBe('Контекст: 12% (120k из 1M)')
      expect(await ui.find({ key: 'compact' })).toBeDefined()
    }
  })

  test('every line is bold and dim, the row centred', async ($, on) => {
    world(on, LIMITS, {}, FILLED)
    await $.session.start({ cwd: 'C:/', surface: 'desktop', isInteractive: true })

    for (const surface of SURFACES) {
      const ui = await $.ui.mount({ ...BAND, surface })
      expect((await ui.findAll({ type: 'Box' }))[0]?.props.justifyContent).toBe('center')
      await ui.press({ key: 'compact' })

      const texts = await ui.findAll({ type: 'Text' })
      expect(texts.map(t => t.text)).toEqual([
        'Сессия: 8%, сброс через 2 ч 54 мин',
        'Неделя: 5%, сброс через 3 д 5 ч',
        'Контекст: 12% (120k из 1M)',
        'Сжать?',
      ])
      expect(texts.map(t => t.props.weight)).toEqual(Array(4).fill('bold'))
      expect(texts.map(t => t.props.color ?? (t.props.dimColor ? 'dim' : undefined))).toEqual([
        'suggestion',
        'merged',
        'claude',
        'dim',
      ])
      await ui.press({ key: 'compact-no' })
      await ui.unmount()
    }
  })

  test('says it waits for a reply before the first one', async ($, on) => {
    world(on, [])
    await $.session.start({ cwd: 'C:/', surface: 'desktop', isInteractive: true })
    const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })

    expect((await ui.find({ type: 'Text', text: /^Контекст/ }))?.text).toBe('Контекст: обновится после ответа')
  })

  test('follows each measurement', async ($, on) => {
    world(on, LIMITS)
    await $.session.start({ cwd: 'C:/', surface: 'desktop', isInteractive: true })
    await $.session.measure({ context: FILLED, rateLimits: [], changed: ['context'] })
    const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })

    expect((await ui.find({ type: 'Text', text: /^Контекст/ }))?.text).toBe('Контекст: 12% (120k из 1M)')
  })

  test('hides the button while a turn runs', async ($, on) => {
    world(on, LIMITS, {}, FILLED)
    await $.session.start({ cwd: 'C:/', surface: 'desktop', isInteractive: true })
    const ui = await $.ui.mount({ ...BAND, props: { ...BAND.props, isWorking: true }, surface: 'desktop' })

    expect((await ui.find({ type: 'Text', text: /^Контекст/ }))?.text).toBe('Контекст: 12% (120k из 1M)')
    expect(await ui.find({ key: 'compact' })).toBeUndefined()
  })

  test('picks up a /clear with no measurement of its own', async ($, on) => {
    const { clock, usage } = world(on, LIMITS, {}, FILLED)
    await $.session.start({ cwd: 'C:/', surface: 'desktop', isInteractive: true })
    const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })

    usage.context = { window: 1_000_000 }
    await clock.advance(15_000)

    expect((await ui.find({ type: 'Text', text: /^Контекст/ }))?.text).toBe('Контекст: обновится после ответа')
  })
})

// The engine's /compact: it compacts through the session.compact hooks.
function compactCommand(on: On, compact: () => Promise<unknown>) {
  const runs: string[] = []
  on('command.run', { command: 'compact' }, async ($, e) => {
    runs.push(e.args)
    await compact()
    return { text: 'Compacted' }
  })
  return runs
}

describe('compact button', () => {
  test('asks first, then runs /compact and shows the new size', async ($, on) => {
    world(on, LIMITS, {}, FILLED)
    const runs = compactCommand(on, () => $.session.compact({ trigger: 'manual', messages: SUMMARY }))
    on('session.compact', () => ({ messages: SUMMARY, tokensBefore: 120_000, tokensAfter: 30_000 }))
    await $.session.start({ cwd: 'C:/', surface: 'desktop', isInteractive: true })
    await $.session.measure({ context: { window: 1_000_000 }, rateLimits: [], changed: ['context'] })

    for (const surface of SURFACES) {
      const ui = await $.ui.mount({ ...BAND, surface })
      await ui.press({ key: 'compact' })
      expect((await ui.find({ type: 'Text', text: /^Сжать\?/ }))?.text).toBe('Сжать?')
      expect(await ui.find({ key: 'compact' })).toBeUndefined()

      await ui.press({ key: 'compact-yes' })
      expect(await ui.find({ type: 'Text', text: /^Сжать\?/ })).toBeUndefined()
      expect((await ui.find({ type: 'Text', text: /^Контекст/ }))?.text).toBe('Контекст: ≈3% (30k из 1M) после сжатия')
      await ui.unmount()
    }

    expect(runs).toEqual(['', ''])
  })

  test('a /compact typed by hand shows the new size too', async ($, on) => {
    world(on, LIMITS, {}, FILLED)
    on('session.compact', () => ({ messages: SUMMARY, tokensAfter: 50_000 }))
    await $.session.start({ cwd: 'C:/', surface: 'desktop', isInteractive: true })

    await $.session.compact({ trigger: 'manual', messages: SUMMARY })
    await $.session.measure({ context: { window: 1_000_000 }, rateLimits: [], changed: ['context'] })
    const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })

    expect((await ui.find({ type: 'Text', text: /^Контекст/ }))?.text).toBe('Контекст: ≈5% (50k из 1M) после сжатия')

    await $.session.measure({ context: FILLED, rateLimits: [], changed: ['context'] })
    expect((await ui.find({ type: 'Text', text: /^Контекст/ }))?.text).toBe('Контекст: 12% (120k из 1M)')
  })

  test('"Нет" leaves the conversation as it is', async ($, on) => {
    world(on, LIMITS, {}, FILLED)
    const runs = compactCommand(on, () => $.session.compact({ trigger: 'manual', messages: SUMMARY }))
    on('session.compact', () => ({ messages: SUMMARY }))
    await $.session.start({ cwd: 'C:/', surface: 'desktop', isInteractive: true })
    const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })

    await ui.press({ key: 'compact' })
    await ui.press({ key: 'compact-no' })

    expect(runs).toEqual([])
    expect(await ui.find({ key: 'compact' })).toBeDefined()
  })

  test('a refusal brings the button back and leaves the fill', async ($, on) => {
    world(on, LIMITS, {}, FILLED)
    compactCommand(on, () => $.session.compact({ trigger: 'manual', messages: SUMMARY }))
    on('session.compact', () => ({ skip: 'blocked by a hook' }))
    await $.session.start({ cwd: 'C:/', surface: 'desktop', isInteractive: true })
    const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })

    await ui.press({ key: 'compact' })
    await ui.press({ key: 'compact-yes' })

    expect(await ui.find({ key: 'compact' })).toBeDefined()
    expect((await ui.find({ type: 'Text', text: /^Контекст/ }))?.text).toBe('Контекст: 12% (120k из 1M)')
  })
})
