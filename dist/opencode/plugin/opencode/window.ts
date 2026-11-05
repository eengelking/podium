// The context window of a model, from OpenCode's model list (`ctx.model.list`). `ctx.model.get` exists only inside a model
// transform, so the list is what a reporter can read. Pure: the caller makes the call.

/** The window of `provider`/`model` in a `ctx.model.list()` answer, or null when the list does not hold it or gives no window. */
export function windowFromList(list: unknown, provider: string, model: string): number | null {
  const data = (list as { data?: unknown } | null | undefined)?.data;
  if (!Array.isArray(data)) return null;
  const hit = data.find((m: { providerID?: unknown; id?: unknown }) => m?.providerID === provider && m?.id === model) as { limit?: { context?: unknown } } | undefined;
  const w = hit?.limit?.context;
  return typeof w === 'number' && Number.isFinite(w) && w > 0 ? w : null;
}
