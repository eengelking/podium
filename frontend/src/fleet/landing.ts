// Chat's reads after one `chat` signal land together (#1311). The overview and the open thread are two requests, and each put its answer into state as it
// came, so the page was drawn twice for one signal. Reads that share a `Landing` hand over what they would do with their answer, and when the last read
// that started has answered they all run in one go, which React draws once.

/** How long an answer waits for a read that has not answered, before it lands on its own: a request that hangs must not hold the rest of the page. */
export const LANDING_WAIT_MS = 1500;

export class Landing {
  private open = 0;
  private held: (() => void)[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;

  /** Runs one read. `read` fetches and returns what to do when the answer lands (null: nothing), `failed` what to do when it threw. Resolves once that is done. */
  async run(read: () => Promise<(() => void) | null>, failed: (err: unknown) => () => void): Promise<void> {
    this.open += 1;
    let apply: (() => void) | null;
    try {
      apply = await read();
    } catch (err) {
      apply = failed(err);
    }
    await new Promise<void>((done) => {
      this.held.push(() => {
        apply?.();
        done();
      });
      this.open -= 1;
      if (this.open === 0) this.flush();
      else this.timer ??= setTimeout(() => this.flush(), LANDING_WAIT_MS);
    });
  }

  private flush(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    const run = this.held;
    this.held = [];
    for (const f of run) f();
  }
}
