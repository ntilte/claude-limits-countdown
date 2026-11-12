export type Limit = { kind: string; percentUsed: number; resetsAt?: string }
export type Context = { tokens?: number; window: number; percent?: number }
// One reading of the account's limits and when it was taken: every session
// shares the newest through the store.
export type Reading = { at: number; limits: Limit[] }
// A message held back: sent as the person's own once `dueAt` has come.
// `isHeld` marks one whose time passed while the session was not running:
// it waits for the person's word instead of going out late.
export type Later = { text: string; dueAt: number; isHeld?: boolean }
// The wait picked before the message was written: the next prompt the person
// sends is held for `ms`, or until `at`.
export type Armed = { ms?: number; at?: number }

declare module 'claude-code' {
  interface PluginState {
    'limits-countdown': {
      limits: Limit[]
      limitsAt: number
      now: number
      context: Context | null
      compactedTo: number | null
      isConfirming: boolean
      isCompacting: boolean
      later: Later | null
      armed: Armed | null
      isPicking: boolean
    }
  }
}
