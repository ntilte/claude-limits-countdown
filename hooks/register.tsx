import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, SessionContextUsage, SessionRateLimit } from 'claude-code'

import type { Armed, Context, Later, Limit, Reading } from '../types'
import {
  BAR_WIDTH,
  barOf,
  contextMeter,
  describeContext,
  describeLimits,
  formatLeft,
  limitMeters,
  parseDelay,
  preview,
} from './format'

const limits = atom({ plugin: 'limits-countdown', key: 'limits' } as const, [])
const limitsAt = atom({ plugin: 'limits-countdown', key: 'limitsAt' } as const, 0)
const now = atom({ plugin: 'limits-countdown', key: 'now' } as const, 0)
const context = atom({ plugin: 'limits-countdown', key: 'context' } as const, null)
const compactedTo = atom({ plugin: 'limits-countdown', key: 'compactedTo' } as const, null)
const isConfirming = atom({ plugin: 'limits-countdown', key: 'isConfirming' } as const, false)
const isCompacting = atom({ plugin: 'limits-countdown', key: 'isCompacting' } as const, false)

const later = atom({ plugin: 'limits-countdown', key: 'later' } as const, null)
const armed = atom({ plugin: 'limits-countdown', key: 'armed' } as const, null)
const isPicking = atom({ plugin: 'limits-countdown', key: 'isPicking' } as const, false)

const STORED = 'reading'
const STORED_BEFORE = 'limits' // 0.5.0 kept the bare list, with no time
const TICK_MS = 15_000
const MIN_MS = 60_000
// A message whose time passed this long ago while the session was not
// running is no longer sent unasked.
const LATE_MS = 10 * MIN_MS
// A reset is read a little late, so a message waiting for one goes after it.
const AFTER_RESET_MS = MIN_MS
const PRESETS: readonly (readonly [number, string])[] = [
  [30, 'через 30 мин'],
  [60, 'через 1 ч'],
  [120, 'через 2 ч'],
]

const plain = (list: readonly SessionRateLimit[]): Limit[] =>
  list.map(({ kind, percentUsed, resetsAt }) => ({ kind, percentUsed, resetsAt }))

const plainContext = ({ tokens, window, percent }: SessionContextUsage): Context => ({
  window,
  ...(tokens === undefined ? {} : { tokens }),
  ...(percent === undefined ? {} : { percent }),
})

const sameContext = (a: Context | null, b: Context | null) =>
  a?.tokens === b?.tokens && a?.window === b?.window && a?.percent === b?.percent

function readingOf(value: unknown): Reading | null {
  if (Array.isArray(value)) return { at: 0, limits: value as Limit[] }
  if (typeof value === 'object' && value !== null && Array.isArray((value as Reading).limits)) {
    return value as Reading
  }
  return null
}

// The limits are the account's, so the newest reading any session took is
// everyone's: a session that sits idle still follows the one at work.
async function shared($: EngineInterface): Promise<Reading | null> {
  return readingOf(await $.store.get(STORED)) ?? readingOf(await $.store.get(STORED_BEFORE))
}

async function adopt($: EngineInterface, reading: Reading) {
  await update($, limits, () => reading.limits)
  await update($, limitsAt, () => reading.at)
}

async function showContext($: EngineInterface, fresh: Context) {
  if (sameContext(fresh, await read($, context))) return
  await update($, context, () => fresh)
  if (fresh.tokens !== undefined) await update($, compactedTo, () => null)
}

// Each session holds its own message, kept in the store so that a restart
// of the app does not lose it.
const laterKey = async ($: EngineInterface) => `later:${await $.session.id()}`

function laterOf(value: unknown): Later | null {
  if (typeof value !== 'object' || value === null) return null
  const { text, dueAt, isHeld } = value as Later
  if (typeof text !== 'string' || typeof dueAt !== 'number') return null
  return isHeld ? { text, dueAt, isHeld: true } : { text, dueAt }
}

async function keep($: EngineInterface, item: Later | null) {
  await update($, later, () => item)
  // The copy on disk only serves a restart: without it the message still
  // goes out while this session runs.
  try {
    const key = await laterKey($)
    if (item === null) await $.store.delete(key)
    else await $.store.set(key, item)
  } catch {
    // kept for this run only
  }
}

// A message held from before a restart: sent on time if its time is still
// ahead or has only just passed, otherwise it waits to be asked.
async function restore($: EngineInterface, t: number) {
  try {
    const held = laterOf(await $.store.get(await laterKey($)))
    if (held !== null) {
      await update($, later, () => (held.dueAt < t - LATE_MS ? { ...held, isHeld: true } : held))
    }
    await $.command.register({ name: 'later', description: 'Отложить сообщение: /later 2ч текст (сброс, отмена)' })
  } catch {
    // the band and its buttons work without either
  }
}

async function schedule($: EngineInterface, text: string, dueAt: number) {
  await keep($, { text, dueAt })
  await update($, armed, () => null)
  await update($, isPicking, () => false)
}

const dueOf = (choice: Armed, t: number) => choice.at ?? t + (choice.ms ?? 0)

// When the session's window resets, if that is still ahead.
function resetAhead(list: readonly Limit[], t: number, kind = 'five_hour'): number | null {
  const at = Date.parse(list.find(limit => limit.kind === kind)?.resetsAt ?? '')
  return at > t ? at : null
}

// A limit that is spent and not yet reset: a message sent now would only
// be refused, so it waits for that reset instead.
function blockedUntil(list: readonly Limit[], t: number): number | null {
  const waits = list
    .filter(limit => limit.percentUsed >= 100)
    .map(limit => Date.parse(limit.resetsAt ?? ''))
    .filter(at => at > t)
  return waits.length > 0 ? Math.max(...waits) : null
}

let isSending = false

async function sendDue($: EngineInterface, isForced = false) {
  if (isSending) return
  const item = await read($, later)
  if (item === null) return

  if (!isForced) {
    const t = await $.clock.now()
    if (item.isHeld || item.dueAt > t) return
    const wait = blockedUntil(await read($, limits), t)
    if (wait !== null) return keep($, { text: item.text, dueAt: wait + AFTER_RESET_MS })
  }

  isSending = true
  try {
    await keep($, null)
    const sent = await $.prompt.submit({ text: item.text, asUser: true })
    if (sent.drop !== undefined) throw new Error(sent.drop)
  } catch (err) {
    await keep($, { text: item.text, dueAt: item.dueAt, isHeld: true })
    $.ui.toast(`Отложенное сообщение не ушло: ${err instanceof Error ? err.message : String(err)}`)
  } finally {
    isSending = false
  }
}

// The wait is picked: a draft already in the prompt box is held as it is,
// otherwise the next message the person sends is.
async function pick($: EngineInterface, choice: Armed) {
  let draft = ''
  try {
    draft = (await $.prompt.read()).text.trim()
  } catch {
    // no box to read: the next message sent is taken instead
  }

  if (draft !== '' && !draft.startsWith('/')) {
    await schedule($, draft, dueOf(choice, await $.clock.now()))
    await $.prompt.fill({ text: '' }).catch(() => undefined)
    return
  }

  await update($, armed, () => choice)
  await update($, isPicking, () => false)
}

async function tick($: EngineInterface) {
  const t = await $.clock.now()
  await update($, now, () => t)

  const newest = await shared($)
  if (newest !== null && newest.at > (await read($, limitsAt))) await adopt($, newest)

  // /clear and a compaction change the fill with no measurement of their own.
  await showContext($, plainContext((await $.session.usage()).context))

  await sendDue($)
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    // A fresh session has no reading until its first reply: start from the
    // shared one, whose reset times are absolute and still right.
    const usage = await $.session.usage()
    const kept = await shared($)
    const start = usage.rateLimits.length > 0 ? { at: 0, limits: plain(usage.rateLimits) } : kept
    const t = await $.clock.now()
    if (start !== null) await adopt($, start)
    await update($, now, () => t)
    await update($, context, () => plainContext(usage.context))
    await update($, compactedTo, () => null)

    $.clock.every(TICK_MS, () => void tick($))
    await restore($, t)

    return next(e)
  })

  on('session.measure', async ($, e, next) => {
    // Only a reading that moved is news: an idle session's last one may be
    // older than what another session has shared since.
    if (e.changed.includes('rateLimits') && e.rateLimits.length > 0) {
      const reading = { at: await $.clock.now(), limits: plain(e.rateLimits) }
      await adopt($, reading)
      const kept = await shared($)
      if (kept === null || kept.at <= reading.at) await $.store.set(STORED, reading)
    }

    if (e.changed.includes('context')) await showContext($, plainContext(e.context))

    return next(e)
  })

  // Every compaction of the main conversation: the button's /compact, one
  // typed by hand and the automatic one.
  on('session.compact', async ($, e, next) => {
    const result = await next(e)
    if (e.agentId === undefined && result.skip === undefined && result.tokensAfter !== undefined) {
      const after = result.tokensAfter
      await update($, compactedTo, () => after)
    }

    return result
  }).catch(($, e, next) => next(e)) // a fault here never stands in the compaction's way

  // While a wait is picked and no message written, the next one the person
  // sends is held instead of going out.
  on('prompt.submit', async ($, e, next) => {
    const choice = await read($, armed)
    const kind = e.origin.kind
    const isPersons = kind === 'composer' || kind === 'bridge' || kind === 'sdk'
    if (choice === null || !isPersons || e.command !== undefined || e.isMeta || e.text.trim() === '') {
      return next(e)
    }

    const t = await $.clock.now()
    const dueAt = dueOf(choice, t)
    await schedule($, e.text, dueAt)
    const lost = e.attachments !== undefined && e.attachments.length > 0 ? ' Вложения не сохраняются, уйдёт только текст.' : ''

    return { drop: `Отложено: отправлю через ${formatLeft(dueAt - t)}.${lost}` }
  }).catch(($, e, next) => next(e)) // a fault here never holds a message back

  on('command.run', { command: 'later' }, async ($, e) => {
    const args = e.args.trim()
    const t = await $.clock.now()
    const item = await read($, later)

    if (args === '') {
      return {
        text:
          item === null
            ? 'Отложенных сообщений нет. Пример: /later 2ч текст сообщения'
            : `Отложено «${preview(item.text, 60)}»: ${item.dueAt > t ? `через ${formatLeft(item.dueAt - t)}` : 'время прошло'}.`,
      }
    }
    if (/^(отмена|cancel|off|стоп)$/i.test(args)) {
      await keep($, null)
      await update($, armed, () => null)
      return { text: 'Отложенная отправка отменена.' }
    }

    const [first = '', ...rest] = args.split(/\s+/)
    const text = rest.join(' ')
    let choice: Armed | null = null
    if (/^(сброс|reset)$/i.test(first)) {
      const at = resetAhead(await read($, limits), t)
      if (at === null) return { text: 'Время сброса лимита сессии пока неизвестно.' }
      choice = { at: at + AFTER_RESET_MS }
    } else {
      const ms = parseDelay(first)
      if (ms !== null) choice = { ms }
    }
    if (choice === null) {
      return { text: 'Не понял время. Примеры: /later 90 текст, /later 2ч текст, /later 1ч30м текст, /later сброс текст' }
    }

    const dueAt = dueOf(choice, t)
    if (text === '') {
      const picked = choice
      await update($, armed, () => picked)
      return { text: `Следующее сообщение будет отложено на ${formatLeft(dueAt - t)}.` }
    }
    await schedule($, text, dueAt)
    return { text: `Отложено: отправлю через ${formatLeft(dueAt - t)}.` }
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) {
      return next(e)
    }

    const list = await read($, limits)
    const contextLine = describeContext(await read($, context), await read($, compactedTo))

    if (list.length === 0 && contextLine === null && (await read($, later)) === null && (await read($, armed)) === null) {
      return next(e)
    }

    const t = (await read($, now)) || (await $.clock.now())
    const confirming = await read($, isConfirming)
    const compacting = await read($, isCompacting)
    const elements = $.ui.resolve(e)
    const { Box, Button, Input, Text } = elements
    // Bars are drawn where the surface has images; the terminal keeps its row of text.
    const Svg = e.surface !== 'terminal' && 'Svg' in elements ? elements.Svg : undefined
    const held = await read($, later)
    const choice = await read($, armed)
    const picking = await read($, isPicking)
    const resetAt = resetAhead(list, t)

    const cancel = async () => {
      await keep($, null)
      await update($, armed, () => null)
      await update($, isPicking, () => false)
    }
    const custom = async (value: string) => {
      const ms = parseDelay(value)
      if (ms === null) $.ui.toast('Не понял время. Примеры: 90, 2ч, 1ч30м')
      else await pick($, { ms })
    }

    const laterRow =
      held !== null
        ? [
            <Text key="later-text" color={held.isHeld ? 'warning' : 'suggestion'} tabular weight="bold">
              {held.isHeld || held.dueAt <= t
                ? `Не отправлено вовремя: «${preview(held.text)}»`
                : `Отправлю через ${formatLeft(held.dueAt - t)}: «${preview(held.text)}»`}
            </Text>,
            <Button key="later-now" label="Сейчас" dimColor onPress={() => void sendDue($, true)} />,
            <Button key="later-cancel" label="Отменить" dimColor onPress={() => void cancel()} />,
          ]
        : choice !== null
          ? [
              <Text key="later-armed" color="suggestion" weight="bold">
                {`Теперь напишите сообщение и отправьте как обычно — оно уйдёт через ${formatLeft(dueOf(choice, t) - t)}`}
              </Text>,
              <Button key="later-cancel" label="Отмена" dimColor onPress={() => void cancel()} />,
            ]
          : picking
            ? [
                ...PRESETS.map(([minutes, label]) => (
                  <Button key={`later-${minutes}`} label={label} onPress={() => void pick($, { ms: minutes * MIN_MS })} />
                )),
                ...(resetAt === null
                  ? []
                  : [
                      <Button
                        key="later-reset"
                        label={`когда обновится лимит (${formatLeft(resetAt - t)})`}
                        variant="primary"
                        onPress={() => void pick($, { at: resetAt + AFTER_RESET_MS })}
                      />,
                    ]),
                <Input key="later-custom" label="или через" placeholder="90 (минут), 2ч, 1ч30м" submitLabel="отложить" onSubmit={value => void custom(value)} />,
                <Button key="later-cancel" label="Отмена" dimColor onPress={() => void cancel()} />,
              ]
            : [<Button key="later" label="Отложить" dimColor onPress={() => update($, isPicking, () => true)} />]

    // The same /compact the person would type: the desktop app runs it as a
    // turn of its own, where a plugin's direct compaction is refused.
    const compact = async () => {
      await update($, isConfirming, () => false)
      await update($, isCompacting, () => true)
      try {
        await $.command.run({ command: 'compact' })
      } catch (err) {
        $.ui.toast(`Не получилось сжать: ${err instanceof Error ? err.message : String(err)}`)
      } finally {
        await update($, isCompacting, () => false)
      }
    }

    // Compaction waits for the running turn, so the controls wait for it too.
    const controls = compacting
      ? [<Text key="compacting" dimColor weight="bold">Сжимаю…</Text>]
      : e.props.isWorking
        ? []
        : confirming
          ? [
              <Text key="confirm" dimColor weight="bold">Сжать?</Text>,
              <Button key="compact-yes" label="Да" variant="primary" onPress={() => void compact()} />,
              <Button key="compact-no" label="Нет" onPress={() => update($, isConfirming, () => false)} />,
            ]
          : [<Button key="compact" label="Сжать" dimColor onPress={() => update($, isConfirming, () => true)} />]

    // The picker says what will be sent before it asks when.
    const laterBox = (
      <Box key="later-row" flexDirection="column" alignItems="center">
        {held === null && choice === null && picking ? (
          <Text dimColor>
            Когда отправить? Отложу текст из поля ввода, а если оно пустое — следующее сообщение, которое вы отправите.
          </Text>
        ) : (
          []
        )}
        <Box flexDirection="row" flexWrap="wrap" justifyContent="center" alignItems="center" columnGap={2}>
          {laterRow}
        </Box>
      </Box>
    )

    if (Svg === undefined) {
      // One centred row; on a narrow band the groups wrap onto centred lines.
      return (
        <Box
          flexDirection="row"
          flexWrap="wrap"
          justifyContent="center"
          alignItems="center"
          columnGap={4}
          width="100%"
        >
          {describeLimits(list, t).map((row, i) => (
            <Text key={`limit-${i}`} color={row.color} tabular weight="bold">
              {row.text}
            </Text>
          ))}
          {contextLine === null ? (
            []
          ) : (
            <Box flexDirection="row" alignItems="center" columnGap={2} flexShrink={0}>
              <Text key="context" color={contextLine.color} tabular weight="bold">
                {contextLine.text}
              </Text>
              {controls}
            </Box>
          )}
          {laterBox}
        </Box>
      )
    }

    // Gauges side by side, each a label over its bar; the buttons on a row
    // of their own, which the time picker takes whole while it is open.
    const fill = contextMeter(await read($, context), await read($, compactedTo))
    const meters = [...limitMeters(list, t), ...(fill === null ? [] : [fill])]
    const isChoosing = held === null && choice === null && picking

    return (
      <Box flexDirection="column" alignItems="center" rowGap={1} width="100%">
        <Box flexDirection="row" flexWrap="wrap" justifyContent="center" columnGap={5} rowGap={1}>
          {meters.map(meter => (
            <Box key={`meter-${meter.key}`} flexDirection="column" alignItems="center" flexShrink={0}>
              <Box flexDirection="row" alignItems="center" columnGap={2}>
                <Text color={meter.color} tabular weight="bold">
                  {meter.label}
                </Text>
                {meter.detail === '' ? [] : <Text dimColor tabular>{meter.detail}</Text>}
              </Box>
              <Svg
                source={barOf(meter.percent, meter.color)}
                alt={meter.detail === '' ? meter.label : `${meter.label}, ${meter.detail}`}
                width={BAR_WIDTH}
                height={4}
              />
            </Box>
          ))}
        </Box>
        <Box flexDirection="row" flexWrap="wrap" justifyContent="center" alignItems="center" columnGap={3}>
          {fill === null || isChoosing ? [] : controls}
          {laterBox}
        </Box>
      </Box>
    )
  })
}
