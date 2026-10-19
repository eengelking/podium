// Which of a page's reads may land, for a page that reads again on an interval (Traffic, and a reporter's Messaging in
// Admin). A fresh read, for a new range or after an action, makes every read started before it stale, so an older
// answer never lands over a newer one. An interval read makes nothing stale: it is skipped while a read is still out,
// so a read slower than the interval still lands rather than being dropped by the next tick, again and again.
export class ReadGate {
  private gen = 0;
  /** The number of the read still out, or -1. */
  private out = -1;

  /** Starts a read that makes every earlier one stale. Returns its number. */
  fresh(): number {
    this.gen += 1;
    this.out = this.gen;
    return this.gen;
  }

  /** Starts an interval read, or returns null while a read that may still land is out. */
  poll(): number | null {
    if (this.out === this.gen) return null;
    this.out = this.gen;
    return this.gen;
  }

  /** Called when the read numbered `at` answers: whether it may land. */
  land(at: number): boolean {
    if (this.out === at) this.out = -1;
    return at === this.gen;
  }

  /** Makes every read still out stale, as when the page closes or stops reading. */
  drop(): void {
    this.gen += 1;
  }
}
