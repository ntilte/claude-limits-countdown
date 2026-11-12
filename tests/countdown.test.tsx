import { describe, expect, mock, test } from 'claude-code/testing'
import type { On, SessionContextUsage, SessionRateLimit } from 'claude-code'

import type { Reading } from '../types'
import { formatLeft, formatTokens, parseDelay, preview } from '../hooks/format'

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

const SURFACES = ['terminal'] as const
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
  on('store.delete', ($, e) => {
    delete store[e.key]
    return { value: undefined }
  })
  on('session.id', () => ({ value: 'one' }))
  on('command.register', () => ({ value: undefined }))
  const usage = { context, rateLimits }
  on('session.usage', () => ({ value: { startedAt: NOW, ...usage } }))
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.measure', ($, e) => ({ changed: e.changed }))
  return { clock, store, usage }
}

// The prompt box and what was sent as the person's own.
function composer(on: On, draft = '') {
  const box = { text: draft }
  const sent: string[] = []
  on('prompt.read', () => ({ value: { text: box.text, cursor: box.text.length } }))
  on('prompt.fill', ($, e) => {
    box.text = e.text
    return { isFilled: true, text: e.text, cursor: e.text.length }
  })
  on('prompt.submit', ($, e) => {
    sent.push(e.text)
    return { text: e.text }
  })
  return { box, sent }
}

const START = { cwd: 'C:/', surface: 'desktop', isInteractive: true } as const
const LATER_TEXT = /^(Отправлю|Не отправлено|Напишите)/

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
    const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })

    const colors = async () => (await ui.findAll({ type: 'Text', text: /^(Сессия|Неделя|Контекст)/ })).map(t => t.props.color)
    expect(await colors()).toEqual(['error', 'warning', 'error'])
  })

  test('a reset window is green', async ($, on) => {
    const { clock } = world(on, LIMITS)
    await $.session.start({ cwd: 'C:/', surface: 'desktop', isInteractive: true })
    const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
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
    const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })

    await clock.advance(6 * MIN)

    expect((await ui.find({ type: 'Text', text: /Сессия/ }))?.text).toBe(
      'Сессия: 8%, сброс через 2 ч 48 мин',
    )
  })

  test('a fresh session starts from the last reading kept', async ($, on) => {
    world(on, [], { limits: LIMITS })
    await $.session.start({ cwd: 'C:/', surface: 'desktop', isInteractive: true })
    const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })

    expect((await ui.find({ type: 'Text', text: /Неделя/ }))?.text).toBe(
      'Неделя: 5%, сброс через 3 д 5 ч',
    )
  })

  test('a window whose reset has passed says so', async ($, on) => {
    const { clock } = world(on, LIMITS)
    await $.session.start({ cwd: 'C:/', surface: 'desktop', isInteractive: true })
    const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })

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
    const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })

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
    const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })

    store.reading = NEWER
    await clock.advance(15_000)

    const lines = (await ui.findAll({ type: 'Text', text: LIMIT_TEXT })).map(t => t.text)
    expect(lines).toEqual(['Сессия: 40%, сброс через 2 ч 53 мин', 'Неделя: 9%, сброс через 3 д 5 ч'])
  })

  test('a fresh session starts from the shared reading', async ($, on) => {
    world(on, [], { reading: NEWER, limits: LIMITS })
    await $.session.start({ cwd: 'C:/', surface: 'desktop', isInteractive: true })
    const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })

    expect((await ui.find({ type: 'Text', text: /^Сессия/ }))?.text).toBe('Сессия: 40%, сброс через 2 ч 54 мин')
  })

  test('a reading that did not move overwrites nothing', async ($, on) => {
    const { clock, store } = world(on, LIMITS, { reading: NEWER })
    await $.session.start({ cwd: 'C:/', surface: 'desktop', isInteractive: true })
    await clock.advance(15_000)
    await $.session.measure({ context: FILLED, rateLimits: LIMITS, changed: ['context'] })
    const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })

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
    const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })

    expect((await ui.find({ type: 'Text', text: /^Контекст/ }))?.text).toBe('Контекст: обновится после ответа')
  })

  test('follows each measurement', async ($, on) => {
    world(on, LIMITS)
    await $.session.start({ cwd: 'C:/', surface: 'desktop', isInteractive: true })
    await $.session.measure({ context: FILLED, rateLimits: [], changed: ['context'] })
    const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })

    expect((await ui.find({ type: 'Text', text: /^Контекст/ }))?.text).toBe('Контекст: 12% (120k из 1M)')
  })

  test('hides the button while a turn runs', async ($, on) => {
    world(on, LIMITS, {}, FILLED)
    await $.session.start({ cwd: 'C:/', surface: 'desktop', isInteractive: true })
    const ui = await $.ui.mount({ ...BAND, props: { ...BAND.props, isWorking: true }, surface: 'terminal' })

    expect((await ui.find({ type: 'Text', text: /^Контекст/ }))?.text).toBe('Контекст: 12% (120k из 1M)')
    expect(await ui.find({ key: 'compact' })).toBeUndefined()
  })

  test('picks up a /clear with no measurement of its own', async ($, on) => {
    const { clock, usage } = world(on, LIMITS, {}, FILLED)
    await $.session.start({ cwd: 'C:/', surface: 'desktop', isInteractive: true })
    const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })

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

    expect(runs).toEqual([''])
  })

  test('a /compact typed by hand shows the new size too', async ($, on) => {
    world(on, LIMITS, {}, FILLED)
    on('session.compact', () => ({ messages: SUMMARY, tokensAfter: 50_000 }))
    await $.session.start({ cwd: 'C:/', surface: 'desktop', isInteractive: true })

    await $.session.compact({ trigger: 'manual', messages: SUMMARY })
    await $.session.measure({ context: { window: 1_000_000 }, rateLimits: [], changed: ['context'] })
    const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })

    expect((await ui.find({ type: 'Text', text: /^Контекст/ }))?.text).toBe('Контекст: ≈5% (50k из 1M) после сжатия')

    await $.session.measure({ context: FILLED, rateLimits: [], changed: ['context'] })
    expect((await ui.find({ type: 'Text', text: /^Контекст/ }))?.text).toBe('Контекст: 12% (120k из 1M)')
  })

  test('"Нет" leaves the conversation as it is', async ($, on) => {
    world(on, LIMITS, {}, FILLED)
    const runs = compactCommand(on, () => $.session.compact({ trigger: 'manual', messages: SUMMARY }))
    on('session.compact', () => ({ messages: SUMMARY }))
    await $.session.start({ cwd: 'C:/', surface: 'desktop', isInteractive: true })
    const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })

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
    const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })

    await ui.press({ key: 'compact' })
    await ui.press({ key: 'compact-yes' })

    expect(await ui.find({ key: 'compact' })).toBeDefined()
    expect((await ui.find({ type: 'Text', text: /^Контекст/ }))?.text).toBe('Контекст: 12% (120k из 1M)')
  })
})

describe('parseDelay', () => {
  test('minutes, hours and both, in Russian or Latin letters', async () => {
    expect(parseDelay('90')).toBe(90 * MIN)
    expect(parseDelay('2ч')).toBe(120 * MIN)
    expect(parseDelay('1ч30м')).toBe(90 * MIN)
    expect(parseDelay('1 ч 30 мин')).toBe(90 * MIN)
    expect(parseDelay('1.5h')).toBe(90 * MIN)
    expect(parseDelay('1,5 часа')).toBe(90 * MIN)
    expect(parseDelay('45m')).toBe(45 * MIN)
    expect(parseDelay('1:30')).toBe(90 * MIN)
  })

  test('refuses what is no time, too short or too long', async () => {
    expect(parseDelay('')).toBeNull()
    expect(parseDelay('завтра')).toBeNull()
    expect(parseDelay('0')).toBeNull()
    expect(parseDelay('999ч')).toBeNull()
  })

  test('preview keeps one short line', async () => {
    expect(preview('Продолжай')).toBe('Продолжай')
    expect(preview('a\n b', 10)).toBe('a b')
    expect(preview('x'.repeat(40), 10)).toBe('xxxxxxxxx…')
  })
})

describe('send later', () => {
  test('holds the draft, counts down and sends it on time', async ($, on) => {
    const { clock, store } = world(on, LIMITS)
    const { box, sent } = composer(on, 'Продолжай работу')
    await $.session.start(START)
    const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })

    await ui.press({ key: 'later' })
    await ui.press({ key: 'later-30' })

    expect(box.text).toBe('')
    expect((await ui.find({ type: 'Text', text: LATER_TEXT }))?.text).toBe('Отправлю через 30 мин: «Продолжай работу»')
    expect(store['later:one']).toEqual({ text: 'Продолжай работу', dueAt: NOW + 30 * MIN })

    await clock.advance(29 * MIN)
    expect(sent).toEqual([])

    await clock.advance(2 * MIN)
    expect(sent).toEqual(['Продолжай работу'])
    expect(store['later:one']).toBeUndefined()
    expect(await ui.find({ key: 'later' })).toBeDefined()
  })

  test('with an empty box the next message sent is held', async ($, on) => {
    const { clock } = world(on, LIMITS)
    const { sent } = composer(on)
    await $.session.start(START)
    const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })

    await ui.press({ key: 'later' })
    await ui.input({ key: 'later-custom', text: '1ч30м' })
    expect((await ui.find({ type: 'Text', text: LATER_TEXT }))?.text).toBe(
      'Напишите и отправьте сообщение — уйдёт через 1 ч 30 мин',
    )

    const entered = await $.prompt.submit({ text: 'Проверь сборку', origin: { kind: 'composer' } })
    expect(entered.drop).toBe('Отложено: отправлю через 1 ч 30 мин.')
    expect(sent).toEqual([])

    await clock.advance(91 * MIN)
    expect(sent).toEqual(['Проверь сборку'])

    // Nothing is armed any more: the next message goes straight through.
    await $.prompt.submit({ text: 'Сразу', origin: { kind: 'composer' } })
    expect(sent).toEqual(['Проверь сборку', 'Сразу'])
  })

  test('"После сброса" waits for the session window to reset', async ($, on) => {
    const { clock } = world(on, LIMITS)
    const { sent } = composer(on, 'Дальше')
    await $.session.start(START)
    const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })

    await ui.press({ key: 'later' })
    await ui.press({ key: 'later-reset' })
    expect((await ui.find({ type: 'Text', text: LATER_TEXT }))?.text).toBe('Отправлю через 2 ч 55 мин: «Дальше»')

    await clock.advance(174 * MIN)
    expect(sent).toEqual([])
    await clock.advance(2 * MIN)
    expect(sent).toEqual(['Дальше'])
  })

  test('a spent limit pushes the message past its reset', async ($, on) => {
    const { clock } = world(on, [{ kind: 'five_hour', percentUsed: 100, resetsAt: '2026-10-16T20:00:00Z' }])
    const { sent } = composer(on, 'Дальше')
    await $.session.start(START)
    const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })

    await ui.press({ key: 'later' })
    await ui.press({ key: 'later-30' })
    await clock.advance(31 * MIN)

    expect(sent).toEqual([])
    await clock.advance(160 * MIN)
    expect(sent).toEqual(['Дальше'])
  })

  test('cancel drops it, "Сейчас" sends at once', async ($, on) => {
    const { clock, store } = world(on, LIMITS)
    const { box, sent } = composer(on, 'Раз')
    await $.session.start(START)
    const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })

    await ui.press({ key: 'later' })
    await ui.press({ key: 'later-60' })
    await ui.press({ key: 'later-cancel' })
    expect(store['later:one']).toBeUndefined()
    await clock.advance(61 * MIN)
    expect(sent).toEqual([])

    box.text = 'Два'
    await ui.press({ key: 'later' })
    await ui.press({ key: 'later-60' })
    await ui.press({ key: 'later-now' })
    await clock.settle()
    expect(sent).toEqual(['Два'])
  })

  test('survives a restart; one long overdue waits to be asked', async ($, on) => {
    const { clock } = world(on, LIMITS, { 'later:one': { text: 'Старое', dueAt: NOW - 60 * MIN } })
    const { sent } = composer(on)
    await $.session.start(START)
    const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })

    expect((await ui.find({ type: 'Text', text: LATER_TEXT }))?.text).toBe('Не отправлено вовремя: «Старое»')
    await clock.advance(5 * MIN)
    expect(sent).toEqual([])

    await ui.press({ key: 'later-now' })
    await clock.settle()
    expect(sent).toEqual(['Старое'])
  })

  test('one still ahead after a restart goes out on time', async ($, on) => {
    const { clock } = world(on, LIMITS, { 'later:one': { text: 'Скоро', dueAt: NOW + 5 * MIN } })
    const { sent } = composer(on)
    await $.session.start(START)

    await clock.advance(6 * MIN)
    expect(sent).toEqual(['Скоро'])
  })

  test('/later takes the time and the text', async ($, on) => {
    const { clock } = world(on, LIMITS)
    const { sent } = composer(on)
    await $.session.start(START)

    const ran = await $.command.run({ command: 'later', args: '2ч Запусти тесты' })
    expect(ran.text).toBe('Отложено: отправлю через 2 ч.')
    expect((await $.command.run({ command: 'later', args: 'когда-нибудь' })).text).toMatch(/^Не понял время/)

    await clock.advance(121 * MIN)
    expect(sent).toEqual(['Запусти тесты'])
  })
})

describe('gauges on the desktop', () => {
  test('each limit and the context is a label over a bar', async ($, on) => {
    world(on, LIMITS, {}, FILLED)
    composer(on)
    await $.session.start(START)
    await $.session.measure({ context: FILLED, rateLimits: LIMITS, changed: ['context'] })
    const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })

    const texts = (await ui.findAll({ type: 'Text' })).map(text => text.text)
    expect(texts.slice(0, 6)).toEqual(['Сессия 8%', '2 ч 54 мин', 'Неделя 5%', '3 д 5 ч', 'Контекст 12%', '120k из 1M'])
    expect(await ui.findAll({ type: 'Svg' })).toHaveLength(3)
    expect(await ui.find({ key: 'compact' })).toBeDefined()
    expect(await ui.find({ key: 'later' })).toBeDefined()
  })

  test('the time picker takes the button row whole', async ($, on) => {
    world(on, LIMITS, {}, FILLED)
    composer(on)
    await $.session.start(START)
    const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })

    await ui.press({ key: 'later' })
    expect(await ui.find({ key: 'compact' })).toBeUndefined()
    expect((await ui.findAll({ type: 'Button' })).map(button => button.key)).toEqual([
      'later-30',
      'later-60',
      'later-120',
      'later-reset',
      'later-cancel',
    ])

    await ui.press({ key: 'later-cancel' })
    expect(await ui.find({ key: 'compact' })).toBeDefined()
  })
})
