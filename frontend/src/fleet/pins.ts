// Pinned cards on the Fleet wall (#496). A pin holds a card's slot: its place in reading order within the wall or
// its band. The pins are remembered in this browser (usePins), not on the server.

export interface Pin {
  id: string;
  slot: number;
}

const MAX_PINS = 200;

/** The list with each pinned card in its slot and the rest filling the other slots in their given order. */
export function placePinned<T extends { id: string }>(list: readonly T[], pins: readonly Pin[]): T[] {
  const n = list.length;
  if (!pins.length || !n) return list.slice();
  const out: (T | null)[] = new Array(n).fill(null);
  const placed = new Set<string>();
  for (const p of pins.slice().sort((a, b) => a.slot - b.slot)) {
    const s = list.find((x) => x.id === p.id);
    if (!s || placed.has(s.id)) continue;
    // A slot past the end means last; a taken slot means the next free one.
    // (A slot past the end searches backward from the last, so it never takes a place ahead of a pin that asked for it.)
    const past = p.slot >= n;
    let i = Math.min(p.slot, n - 1);
    while (out[i]) i = past ? (i - 1 + n) % n : (i + 1) % n;
    out[i] = s;
    placed.add(s.id);
  }
  const rest = list.filter((s) => !placed.has(s.id));
  let k = 0;
  return out.map((s) => s ?? (rest[k++] as T));
}

export function addPin(pins: readonly Pin[], id: string, slot: number): Pin[] {
  return [...removePin(pins, id), { id, slot }];
}

export function removePin(pins: readonly Pin[], id: string): Pin[] {
  return pins.filter((p) => p.id !== id);
}

/** Pins for sessions that are still known; the same array when none is dropped. */
export function prunePins(pins: Pin[], known: ReadonlySet<string>): Pin[] {
  const kept = pins.filter((p) => known.has(p.id));
  return kept.length === pins.length ? pins : kept;
}

/** Stored pins, with anything unreadable dropped. */
export function parsePins(v: unknown): Pin[] {
  if (!Array.isArray(v)) return [];
  const seen = new Set<string>();
  const out: Pin[] = [];
  for (const e of v) {
    const o = e && typeof e === "object" ? (e as Record<string, unknown>) : {};
    if (typeof o.id !== "string" || !Number.isInteger(o.slot) || (o.slot as number) < 0 || seen.has(o.id)) continue;
    seen.add(o.id);
    out.push({ id: o.id, slot: o.slot as number });
    if (out.length === MAX_PINS) break;
  }
  return out;
}
