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

const queue = atom({ plugin: 'limits-countdown', key: 'queue' } as const, [])
const armed = atom({ plugin: 'limits-countdown', key: 'armed' } as const, null)
const isPicking = atom({ plugin: 'limits-countdown', key: 'isPicking' } as const, false)
const isTyping = atom({ plugin: 'limits-countdown', key: 'isTyping' } as const, false)

const STORED = 'reading'
const STORED_BEFORE = 'limits' // 0.5.0 kept the bare list, with no time
const TICK_MS = 15_000
const MIN_MS = 60_000
// A message whose time passed this long ago while the session was not
// running is no longer sent unasked.
const LATE_MS = 10 * MIN_MS
// A reset is read a little late, so a message waiting for one goes after it.
const AFTER_RESET_MS = MIN_MS
// Rows of waiting messages the band shows; /later lists them all.
const SHOWN = 5
const PRESETS: readonly (readonly [number, string])[] = [
  [30, '30 мин'],
  [60, '1 ч'],
  [120, '2 ч'],
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

// Each session holds its own messages, kept in the store so that a restart
// of the app does not lose them.
const laterKey = async ($: EngineInterface) => `later:${await $.session.id()}`

function itemOf(value: unknown, id: number): Later | null {
  if (typeof value !== 'object' || value === null) return null
  const { text, dueAt, isHeld } = value as Later
  if (typeof text !== 'string' || typeof dueAt !== 'number') return null
  return isHeld ? { id, text, dueAt, isHeld: true } : { id, text, dueAt }
}

// Soonest first; messages due at the same moment keep the order they came in.
const soonestFirst = (list: readonly Later[]) => [...list].sort((a, b) => a.dueAt - b.dueAt)

// What the store holds: a list since 0.9.0, the one message 0.8 kept before.
function queueOf(value: unknown): Later[] {
  const kept = Array.isArray(value) ? value : [value]
  return soonestFirst(kept.map((item, i) => itemOf(item, i + 1)).filter((item): item is Later => item !== null))
}

const nextId = (list: readonly Later[]) => list.reduce((max, item) => Math.max(max, item.id), 0) + 1

async function edit($: EngineInterface, change: (list: readonly Later[]) => Later[]): Promise<Later[]> {
  const list = await update($, queue, list => soonestFirst(change(list)))
  // The copy on disk only serves a restart: without it the messages still
  // go out while this session runs.
  try {
    const key = await laterKey($)
    if (list.length === 0) await $.store.delete(key)
    else await $.store.set(key, list)
  } catch {
    // kept for this run only
  }
  return list
}

// Messages held from before a restart: each sent on time if its time is
// still ahead or has only just passed, otherwise it waits to be asked.
async function restore($: EngineInterface, t: number) {
  try {
    const kept = queueOf(await $.store.get(await laterKey($)))
    if (kept.length > 0) {
      await update($, queue, () => kept.map(item => (item.dueAt < t - LATE_MS ? { ...item, isHeld: true } : item)))
    }
    await $.command.register({
      name: 'later',
      description: 'Отложить сообщение: /later 2ч текст (сброс, отмена); можно несколько подряд',
    })
  } catch {
    // the band and its buttons work without either
  }
}

async function closePicker($: EngineInterface) {
  await update($, armed, () => null)
  await update($, isPicking, () => false)
  await update($, isTyping, () => false)
}

// One more message waits; resolves to how many wait now.
async function add($: EngineInterface, text: string, dueAt: number): Promise<number> {
  const list = await edit($, list => [...list, { id: nextId(list), text, dueAt }])
  await closePicker($)
  return list.length
}

const totalOf = (count: number) => (count > 1 ? ` Всего отложено: ${count}.` : '')

const dueOf = (choice: Armed, t: number) => choice.at ?? t + (choice.ms ?? 0)

type Reset = { at: number; kind: string }

// What the band shows as 100% is spent.
const isSpent = (limit: Limit) => Math.round(limit.percentUsed) >= 100

// A limit that is spent and not yet reset: a message sent now would only be
// refused, so it waits for the latest such reset instead.
function spentUntil(list: readonly Limit[], t: number): Reset | null {
  let last: Reset | null = null
  for (const limit of list) {
    const at = Date.parse(limit.resetsAt ?? '')
    if (isSpent(limit) && at > t && (last === null || at > last.at)) last = { at, kind: limit.kind }
  }
  return last
}

// "After the reset": when the session window resets, unless a spent limit
// (the week at 100%, say) holds every message past its own reset, which the
// session window's would not lift.
function nextReset(list: readonly Limit[], t: number): Reset | null {
  const spent = spentUntil(list, t)
  if (spent !== null) return spent
  const at = Date.parse(list.find(limit => limit.kind === 'five_hour')?.resetsAt ?? '')
  return at > t ? { at, kind: 'five_hour' } : null
}

let isSending = false

// Sends the soonest message whose time has come, one a call, so that each
// is a turn of its own; `id` sends that one now, whatever its time.
async function sendDue($: EngineInterface, id?: number) {
  if (isSending) return
  const list = await read($, queue)
  let item: Later | undefined

  if (id === undefined) {
    const t = await $.clock.now()
    item = list.find(each => !each.isHeld && each.dueAt <= t)
    if (item === undefined) return
    const spent = spentUntil(await read($, limits), t)
    if (spent !== null) {
      // Every message that would fall before the reset waits for it, in order.
      const after = spent.at + AFTER_RESET_MS
      await edit($, list => list.map(each => (!each.isHeld && each.dueAt < after ? { ...each, dueAt: after } : each)))
      return
    }
  } else {
    item = list.find(each => each.id === id)
  }
  if (item === undefined) return

  const sending = item
  isSending = true
  try {
    await edit($, list => list.filter(each => each.id !== sending.id))
    const sent = await $.prompt.submit({ text: sending.text, asUser: true })
    if (sent.drop !== undefined) throw new Error(sent.drop)
  } catch (err) {
    await edit($, list => [...list, { ...sending, isHeld: true }])
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
    await add($, draft, dueOf(choice, await $.clock.now()))
    await $.prompt.fill({ text: '' }).catch(() => undefined)
    return
  }

  await update($, armed, () => choice)
  await update($, isPicking, () => false)
  await update($, isTyping, () => false)
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

const whenOf = (item: Later, t: number) =>
  item.isHeld ? 'не отправлено вовремя' : item.dueAt <= t ? 'отправляю' : `через ${formatLeft(item.dueAt - t)}`

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
    const count = await add($, e.text, dueAt)
    const lost = e.attachments !== undefined && e.attachments.length > 0 ? ' Вложения не сохраняются, уйдёт только текст.' : ''

    return { drop: `Отложено: отправлю через ${formatLeft(dueAt - t)}.${totalOf(count)}${lost}` }
  }).catch(($, e, next) => next(e)) // a fault here never holds a message back

  on('command.run', { command: 'later' }, async ($, e) => {
    const args = e.args.trim()
    const t = await $.clock.now()
    const list = await read($, queue)

    if (args === '') {
      if (list.length === 0) return { text: 'Отложенных сообщений нет. Пример: /later 2ч текст сообщения' }
      return {
        text: [
          `Отложено сообщений: ${list.length}`,
          ...list.map(item => `• ${whenOf(item, t)} — «${preview(item.text, 60)}»`),
        ].join('\n'),
      }
    }
    if (/^(отмена|cancel|off|стоп)$/i.test(args)) {
      await edit($, () => [])
      await closePicker($)
      return {
        text: list.length > 0 ? `Отложенные сообщения отменены: ${list.length}.` : 'Отложенная отправка отменена.',
      }
    }

    const [first = '', ...rest] = args.split(/\s+/)
    const text = rest.join(' ')
    let choice: Armed | null = null
    if (/^(сброс|reset)$/i.test(first)) {
      const reset = nextReset(await read($, limits), t)
      if (reset === null) return { text: 'Время сброса лимита пока неизвестно.' }
      choice = { at: reset.at + AFTER_RESET_MS }
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
    const count = await add($, text, dueAt)
    return { text: `Отложено: отправлю через ${formatLeft(dueAt - t)}.${totalOf(count)}` }
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) {
      return next(e)
    }

    const list = await read($, limits)
    const contextLine = describeContext(await read($, context), await read($, compactedTo))
    const items = await read($, queue)
    const choice = await read($, armed)

    if (list.length === 0 && contextLine === null && items.length === 0 && choice === null) {
      return next(e)
    }

    const t = (await read($, now)) || (await $.clock.now())
    const confirming = await read($, isConfirming)
    const compacting = await read($, isCompacting)
    const elements = $.ui.resolve(e)
    const { Box, Button, Input, Text } = elements
    // Bars are drawn where the surface has images; the terminal keeps its row of text.
    const Svg = e.surface !== 'terminal' && 'Svg' in elements ? elements.Svg : undefined
    const picking = await read($, isPicking)
    const typing = await read($, isTyping)
    const reset = nextReset(list, t)

    const custom = async (value: string) => {
      const ms = parseDelay(value)
      if (ms === null) $.ui.toast('Не понял время. Примеры: 90, 2ч, 1ч30м')
      else await pick($, { ms })
    }

    // Each waiting message on a row of its own, soonest first.
    const rows = items.slice(0, SHOWN).map(item => (
      <Box
        key={`later-item-${item.id}`}
        flexDirection="row"
        flexWrap="wrap"
        justifyContent="center"
        alignItems="center"
        columnGap={2}
      >
        <Text color={item.isHeld ? 'warning' : 'suggestion'} tabular weight="bold">
          {item.isHeld
            ? `Не отправлено вовремя: «${preview(item.text)}»`
            : item.dueAt <= t
              ? `Отправляю: «${preview(item.text)}»`
              : `Отправлю через ${formatLeft(item.dueAt - t)}: «${preview(item.text)}»`}
        </Text>
        <Button key={`later-now-${item.id}`} label="Сейчас" dimColor onPress={() => void sendDue($, item.id)} />
        <Button
          key={`later-cancel-${item.id}`}
          label="Отменить"
          dimColor
          onPress={() => void edit($, list => list.filter(each => each.id !== item.id))}
        />
      </Box>
    ))
    const queueBox =
      items.length === 0 ? (
        []
      ) : (
        <Box key="later-queue" flexDirection="column" alignItems="center" width="100%">
          {rows}
          {items.length > SHOWN ? (
            <Text key="later-more" dimColor>
              {`и ещё ${items.length - SHOWN}, весь список: /later`}
            </Text>
          ) : (
            []
          )}
        </Box>
      )

    const laterRow =
      choice !== null
        ? [
            <Text key="later-armed" color="suggestion" weight="bold">
              {`Напишите сообщение — уйдёт через ${formatLeft(dueOf(choice, t) - t)}`}
            </Text>,
            <Button key="later-cancel" label="Отмена" dimColor onPress={() => void closePicker($)} />,
          ]
        : picking && typing
          ? [
              <Text key="later-ask" dimColor weight="bold">Через</Text>,
              <Input key="later-custom" placeholder="90 мин, 2ч, 1ч30м" submitLabel="ок" onSubmit={value => void custom(value)} />,
              <Button key="later-back" label="Назад" dimColor onPress={() => update($, isTyping, () => false)} />,
            ]
          : picking
            ? [
                <Text key="later-ask" dimColor weight="bold">Отправить через</Text>,
                ...PRESETS.map(([minutes, label]) => (
                  <Button key={`later-${minutes}`} label={label} onPress={() => void pick($, { ms: minutes * MIN_MS })} />
                )),
                ...(reset === null
                  ? []
                  : [
                      <Button
                        key="later-reset"
                        label={reset.kind.startsWith('seven_day') ? 'после сброса недели' : 'после сброса'}
                        onPress={() => void pick($, { at: reset.at + AFTER_RESET_MS })}
                      />,
                    ]),
                <Button key="later-other" label="другое" onPress={() => update($, isTyping, () => true)} />,
                <Button key="later-cancel" label="Отмена" dimColor onPress={() => void closePicker($)} />,
              ]
            : [
                <Button
                  key="later"
                  label={items.length > 0 ? 'Отложить ещё' : 'Отложить'}
                  dimColor
                  onPress={() => update($, isPicking, () => true)}
                />,
              ]

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

    const laterBox = (
      <Box key="later-row" flexDirection="row" flexWrap="wrap" justifyContent="center" alignItems="center" columnGap={2} rowGap={1}>
        {laterRow}
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
          {queueBox}
          {laterBox}
        </Box>
      )
    }

    // Gauges side by side, each a label over its bar; the waiting messages
    // below, then the buttons on a row of their own, which the time picker
    // takes whole while it is open.
    const fill = contextMeter(await read($, context), await read($, compactedTo))
    const meters = [...limitMeters(list, t), ...(fill === null ? [] : [fill])]
    const isChoosing = choice === null && picking

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
        {queueBox}
        <Box flexDirection="row" flexWrap="wrap" justifyContent="center" alignItems="center" columnGap={3}>
          {fill === null || isChoosing ? [] : controls}
          {laterBox}
        </Box>
      </Box>
    )
  })
}
