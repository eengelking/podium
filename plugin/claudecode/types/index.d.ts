/** The name and token a session reports as, taken once at its start (#226). */
export type HeldIdentity = { userName: string; token: string }

/** The reporter config file a context chose at a session's start, held so a reload keeps it (#606). */
export type HeldConfig = { path: string; context: string }

declare module 'claude-code' {
  interface PluginState {
    'podium-reporter': { identity: HeldIdentity | null; chosenConfig: HeldConfig | null }
  }
}
