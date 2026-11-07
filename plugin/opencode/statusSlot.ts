// The status line in the prompt's footer (#987): the TUI part claims the `prompt.footer.status` slot and shows the connection's status
// there, always, where a toast shows a change once. A slot's content is a Solid element, which the host's runtime builds; this file takes the
// two pieces it needs (`solid-js` and the JSX runtime of `@opentui/solid`) through a loader, so it is tested with fakes and a host that does not
// provide them leaves the toast as the only display.

export interface SlotHost {
  slot(claim: { append: 'prompt.footer.status' | 'session.composer.top'; render: () => unknown }): () => void;
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
export const mountStatus = (host: SlotHost, load: () => Promise<StatusParts>): Promise<StatusLine | null> => mountText(host, load, 'prompt.footer.status');

/**
 * The Admin board (#1051): the Admin callouts stay in the session screen, above the prompt, for as long as the reading does. A line there is for the person
 * only: it is drawn by the terminal UI and never enters a session, so the model does not read it. `set` takes the lines, joined by new lines; empty shows nothing.
 */
export const mountBanner = (host: SlotHost, load: () => Promise<StatusParts>): Promise<StatusLine | null> => mountText(host, load, 'session.composer.top');

async function mountText(host: SlotHost, load: () => Promise<StatusParts>, slot: 'prompt.footer.status' | 'session.composer.top'): Promise<StatusLine | null> {
  try {
    const { solid, jsx } = await load();
    const [text, setText] = solid.createSignal('');
    // A getter, so the element follows the signal.
    const dispose = host.slot({ append: slot, render: () => jsx.jsx('text', { get children() { return text(); } }) });
    return { set: setText, dispose };
  } catch {
    return null;
  }
}
