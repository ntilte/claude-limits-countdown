export type Limit = { kind: string; percentUsed: number; resetsAt?: string }
export type Context = { tokens?: number; window: number; percent?: number }

declare module 'claude-code' {
  interface PluginState {
    'limits-countdown': {
      limits: Limit[]
      now: number
      context: Context | null
      compactedTo: number | null
      isConfirming: boolean
      isCompacting: boolean
    }
  }
}
