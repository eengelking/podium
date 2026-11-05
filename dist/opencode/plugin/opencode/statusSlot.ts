// The status line in the prompt's footer (#987): the TUI part claims the `prompt.footer.status` slot and shows the connection's status
// there, always, where a toast shows a change once. A slot's content is a Solid element, which the host's runtime builds; this file takes the
// two pieces it needs (`solid-js` and the JSX runtime of `@opentui/solid`) through a loader, so it is tested with fakes and a host that does not
// provide them leaves the toast as the only display.

export interface SlotHost {
  slot(claim: { append: 'prompt.footer.status'; render: () => unknown }): () => void;
}

export interface StatusParts {
  solid: { createSignal<T>(value: T): [() => T, (value: T) => void] };
  jsx: { jsx(type: string, props: Record<string, unknown>): unknown };
}

export interface StatusLine {
  /** Shows `text`; an empty text shows nothing. */
  set(text: string): void;
  /** Gives the slot back. */
  dispose(): void;
}

/** Claims the slot, or null when the host cannot (the parts did not load, or the claim failed). Never throws. */
export async function mountStatus(host: SlotHost, load: () => Promise<StatusParts>): Promise<StatusLine | null> {
  try {
    const { solid, jsx } = await load();
    const [text, setText] = solid.createSignal('');
    // A getter, so the element follows the signal.
    const dispose = host.slot({ append: 'prompt.footer.status', render: () => jsx.jsx('text', { get children() { return text(); } }) });
    return { set: setText, dispose };
  } catch {
    return null;
  }
}
