import { clip } from '../core/failures.ts';

/** A model by `providerID` and `id`, the shape `ctx.experimental.generate.text` takes for `model`. */
export interface ModelRef {
  providerID: string;
  id: string;
}

/** An id that names a small, cheap tier of a model family: Haiku, mini, nano, flash, lite, small. A whole word in the id, so `minimal` does not match. */
const SMALL = /(?:^|[-_./:])(haiku|mini|nano|flash|lite|small)(?:$|[-_./:])/i;

/** The first (untiered) price of a model, input plus output per million tokens, or null when OpenCode lists none. */
function priceOf(cost: unknown): number | null {
  const c = Array.isArray(cost) ? (cost[0] as { input?: unknown; output?: unknown } | undefined) : undefined;
  return c && typeof c.input === 'number' && typeof c.output === 'number' ? c.input + c.output : null;
}

/**
 * The model that explains a failure: the cheapest enabled, current chat model in `ctx.model.list()` whose id names a small tier (the
 * way Claude Code asks Haiku), ties broken by id. Null when the list holds no such model; the caller then uses OpenCode's default.
 */
export function pickExplainModel(list: unknown): ModelRef | null {
  const data = (list as { data?: unknown } | null | undefined)?.data;
  if (!Array.isArray(data)) return null;
  let best: { ref: ModelRef; price: number } | null = null;
  for (const raw of data) {
    const x = raw as { providerID?: unknown; id?: unknown; type?: unknown; enabled?: unknown; status?: unknown; cost?: unknown } | null;
    if (!x || typeof x.providerID !== 'string' || typeof x.id !== 'string') continue;
    if (x.enabled === false || x.status === 'deprecated' || (x.type !== undefined && x.type !== 'chat') || !SMALL.test(x.id)) continue;
    const price = priceOf(x.cost);
    if (price === null) continue;
    if (!best || price < best.price || (price === best.price && x.id < best.ref.id)) best = { ref: { providerID: x.providerID, id: x.id }, price };
  }
  return best?.ref ?? null;
}

type Generate = (input: { prompt: string; model?: ModelRef }) => Promise<{ text: string }>;

const DEFAULT_LABEL = "OpenCode's default model";
/** The explanation is cut to 400 characters by the reporter; the attribution is kept inside that. */
const LIMIT = 400;

/**
 * Asks for an explanation of a failure from the small model `pickExplainModel` chose, falling back to OpenCode's default model when none is
 * listed, the list cannot be read or the chosen model fails. The answer ends with the model that gave it. Null for an empty answer.
 */
export async function explainWith(generate: Generate, list: () => Promise<unknown>, prompt: string): Promise<string | null> {
  let chosen: ModelRef | null = null;
  try {
    chosen = pickExplainModel(await list());
  } catch {
    // A list that cannot be read (or a host without one) means the default model.
  }
  let label = chosen ? `${chosen.providerID}/${chosen.id}` : DEFAULT_LABEL;
  let out: { text: string };
  if (chosen) {
    try {
      out = await generate({ prompt, model: chosen });
    } catch {
      label = DEFAULT_LABEL;
      out = await generate({ prompt });
    }
  } else {
    out = await generate({ prompt });
  }
  const text = out.text.trim();
  if (!text) return null;
  const tag = ` (explained by ${label})`;
  return `${clip(text, LIMIT - tag.length)}${tag}`;
}
