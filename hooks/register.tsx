import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, SessionContextUsage, SessionRateLimit } from 'claude-code'

import type { Context, Limit, Reading } from '../types'
import { describeContext, describeLimits } from './format'

const limits = atom({ plugin: 'limits-countdown', key: 'limits' } as const, [])
const limitsAt = atom({ plugin: 'limits-countdown', key: 'limitsAt' } as const, 0)
const now = atom({ plugin: 'limits-countdown', key: 'now' } as const, 0)
const context = atom({ plugin: 'limits-countdown', key: 'context' } as const, null)
const compactedTo = atom({ plugin: 'limits-countdown', key: 'compactedTo' } as const, null)
const isConfirming = atom({ plugin: 'limits-countdown', key: 'isConfirming' } as const, false)
const isCompacting = atom({ plugin: 'limits-countdown', key: 'isCompacting' } as const, false)

const STORED = 'reading'
const STORED_BEFORE = 'limits' // 0.5.0 kept the bare list, with no time
const TICK_MS = 15_000

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

async function tick($: EngineInterface) {
  const t = await $.clock.now()
  await update($, now, () => t)

  const newest = await shared($)
  if (newest !== null && newest.at > (await read($, limitsAt))) await adopt($, newest)

  // /clear and a compaction change the fill with no measurement of their own.
  await showContext($, plainContext((await $.session.usage()).context))
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

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) {
      return next(e)
    }

    const list = await read($, limits)
    const contextLine = describeContext(await read($, context), await read($, compactedTo))

    if (list.length === 0 && contextLine === null) {
      return next(e)
    }

    const t = (await read($, now)) || (await $.clock.now())
    const confirming = await read($, isConfirming)
    const compacting = await read($, isCompacting)
    const { Box, Button, Text } = $.ui.resolve(e)

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
      </Box>
    )
  })
}
