export type Limit = { kind: string; percentUsed: number; resetsAt?: string }
export type Context = { tokens?: number; window: number; percent?: number }
// One reading of the account's limits and when it was taken: every session
// shares the newest through the store.
export type Reading = { at: number; limits: Limit[] }

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
    }
  }
}
