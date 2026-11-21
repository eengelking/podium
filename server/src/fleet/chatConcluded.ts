// What was concluded for each person because an agent in a conversation ended (#1283), kept in memory only. The conversation is deleted, so this is the one place the
// console learns why a row left and can say so. It holds names and a time, never any text. A person's list is bounded (20) and its entries expire when it is read or added to, so
// a server that stays up for weeks holds at most that many names for someone who never signs in. Shared by the pair Direct Messages (`chatDirect.ts`) and the conversations of people and agents (`chatConversations.ts`).

/** A conversation that was concluded and deleted: who ended, who it was with, and when. `id` is what a dismissal names. Never any text. */
export interface ConcludedView {
  id: string;
  thread: string;
  agent: string;
  with: string[];
  at: number;
  /** How many messages a person wrote that the agent never took, including one still waiting for its owner's approval, which is discarded (#1283). Absent when none. */
  undelivered?: number;
}

/** How long a conclusion is kept for the console to show, and the most kept for one person. */
const KEEP_MS = 24 * 3_600_000;
const MAX = 20;

export class ConcludedList {
  private readonly byPerson = new Map<number, ConcludedView[]>();

  constructor(private readonly now: () => number) {}

  /** Records one for each of these people (`people.id`). */
  add(people: Iterable<number>, entry: Omit<ConcludedView, 'id' | 'at'>): void {
    const at = this.now();
    for (const person of new Set(people)) {
      const list = this.of(person);
      list.push({ ...entry, id: `${entry.thread}@${at}`, at });
      this.byPerson.set(person, list.slice(-MAX));
    }
  }

  /** What was concluded for this person and not yet dismissed. */
  of(person: number): ConcludedView[] {
    const at = this.now();
    return (this.byPerson.get(person) ?? []).filter((x) => at - x.at < KEEP_MS);
  }

  /** The person dismisses one of their own. False when they have no such entry (another person's id is the same as none). */
  dismiss(person: number, id: string): boolean {
    const list = this.byPerson.get(person) ?? [];
    const kept = list.filter((x) => x.id !== id);
    if (kept.length === list.length) return false;
    this.byPerson.set(person, kept);
    return true;
  }
}
