import { atom, read, update } from 'claude-code'
import type { Register, SessionContextUsage, SessionRateLimit } from 'claude-code'

import type { Context, Limit } from '../types'
import { describeContext, describeLimits } from './format'

const limits = atom({ plugin: 'limits-countdown', key: 'limits' } as const, [])
const now = atom({ plugin: 'limits-countdown', key: 'now' } as const, 0)
const context = atom({ plugin: 'limits-countdown', key: 'context' } as const, null)
const compactedTo = atom({ plugin: 'limits-countdown', key: 'compactedTo' } as const, null)
const isConfirming = atom({ plugin: 'limits-countdown', key: 'isConfirming' } as const, false)
const isCompacting = atom({ plugin: 'limits-countdown', key: 'isCompacting' } as const, false)

const STORED = 'limits'
const TICK_MS = 30_000

const plain = (list: readonly SessionRateLimit[]): Limit[] =>
  list.map(({ kind, percentUsed, resetsAt }) => ({ kind, percentUsed, resetsAt }))

const plainContext = ({ tokens, window, percent }: SessionContextUsage): Context => ({
  window,
  ...(tokens === undefined ? {} : { tokens }),
  ...(percent === undefined ? {} : { percent }),
})

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    // A fresh session has no reading until its first reply: start from the
    // last one kept, whose reset times are absolute and still right.
    const usage = await $.session.usage()
    const kept = (await $.store.get(STORED)) as Limit[] | undefined
    const start = usage.rateLimits.length > 0 ? plain(usage.rateLimits) : kept ?? []
    const t = await $.clock.now()
    await update($, limits, () => start)
    await update($, now, () => t)
    await update($, context, () => plainContext(usage.context))
    await update($, compactedTo, () => null)

    $.clock.every(TICK_MS, () => {
      void $.clock.now().then(time => update($, now, () => time))
    })

    return next(e)
  })

  on('session.measure', async ($, e, next) => {
    if (e.rateLimits.length > 0) {
      const fresh = plain(e.rateLimits)
      await update($, limits, () => fresh)
      await $.store.set(STORED, fresh)
    }

    if (e.changed.includes('context')) {
      await update($, context, () => plainContext(e.context))
      if (e.context.tokens !== undefined) await update($, compactedTo, () => null)
    }

    return next(e)
  })

  // /compact and the automatic compaction; the button's own call skips this hook.
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

    const compact = async () => {
      await update($, isConfirming, () => false)
      await update($, isCompacting, () => true)
      try {
        const result = await $.session.compact()
        if (result.skip !== undefined) {
          $.ui.toast(`Сжатие не состоялось: ${result.skip}`)
        } else if (result.tokensAfter !== undefined) {
          const after = result.tokensAfter
          await update($, compactedTo, () => after)
        }
      } catch (err) {
        $.ui.toast(`Не получилось сжать: ${err instanceof Error ? err.message : String(err)}`)
      } finally {
        await update($, isCompacting, () => false)
      }
    }

    // Compaction is refused while a turn runs, so the controls wait for it.
    const controls = compacting
      ? [<Text key="compacting" dimColor weight="bold">Сжимаю…</Text>]
      : e.props.isWorking
        ? []
        : confirming
          ? [
              <Text key="confirm" weight="bold">Сжать контекст?</Text>,
              <Button key="compact-yes" label="Да" variant="primary" onPress={() => void compact()} />,
              <Button key="compact-no" label="Нет" onPress={() => update($, isConfirming, () => false)} />,
            ]
          : [<Button key="compact" label="Сжать" dimColor onPress={() => update($, isConfirming, () => true)} />]

    return (
      <Box flexDirection="row" justifyContent="space-between" columnGap={3} width="100%">
        <Box flexDirection="row" flexWrap="wrap" columnGap={3} flexShrink={1}>
          {describeLimits(list, t).map((line, i) => (
            <Text key={`limit-${i}`} dimColor tabular weight="bold">
              {line}
            </Text>
          ))}
        </Box>
        {contextLine === null ? (
          []
        ) : (
          <Box flexDirection="row" columnGap={2} flexShrink={0}>
            <Text key="context" dimColor tabular weight="bold">
              {contextLine}
            </Text>
            {controls}
          </Box>
        )}
      </Box>
    )
  })
}
