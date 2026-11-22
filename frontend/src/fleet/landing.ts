// Chat's reads after one `chat` signal land together (#1311). The overview and the open thread are two requests; each used to put its answer into
// state as it came, so the page drew twice for one signal, and again for each of the other reads on the console. A page that reads from several hooks
// gives them one `Landing`: a read says it has started, and when it ends it hands over what it would do with its answer; when the last read that started
// has ended they all run in one go, which React draws once.

/** How long a read that came back waits for another that has not, before it lands on its own: a request that hangs must not hold the rest of the page. */
export const LANDING_WAIT_MS = 1500;

export class Landing {
  private open = 0;
  private held: (() => void)[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;

  /** A read starts. Every `start` is followed by one `end`. */
  start(): void {
    this.open += 1;
  }

  /** A read ends with what it would do to state. Resolves once that has been done. */
  end(apply: () => void): Promise<void> {
    return new Promise<void>((done) => {
      this.held.push(() => {
        apply();
        done();
      });
      this.open = Math.max(0, this.open - 1);
      if (this.open === 0) this.flush();
      else if (this.timer === null) this.timer = setTimeout(() => this.flush(), LANDING_WAIT_MS);
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
