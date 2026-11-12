// How full a context window is, as the percent both reporters send (#1055). Pure.

/** Tokens as a percent of the window, to one decimal and never over 100; null when either is unknown or the window is 0. */
export function pct(tokens: number | null, window: number | null): number | null {
  if (tokens === null || !window) return null;
  return Math.round(Math.min(100, (tokens / window) * 100) * 10) / 10;
}
