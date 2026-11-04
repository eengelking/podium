import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ingestReport, START_TOLERANCE_MS } from "../server/src/fleet/ingest.ts";
import { validateReport } from "../server/src/fleet/protocol.ts";
import { openStorage, type Storage } from "../server/src/storage/index.ts";
import { fleetReports, keptStarts } from "./e2e-seed.mjs";

type Seeded = { who: string; key: string; body: { session: { id: string; startedAt: number } } };

// The wall's "Newest" sort reads the start time the server stored and falls back to the name on a tie, where "Tester" comes
// before "arm64-check". wall/toolbar.cy.js expects the session reported last to show first, so the order must come from the
// seed, never from which millisecond the server happened to receive each report in (#898).
describe("e2e seed start times (#898)", () => {
  let storage: Storage;
  beforeEach(async () => {
    storage = await openStorage({ PODIUM_DB: ":memory:" });
  });
  afterEach(async () => {
    await storage.close();
  });

  /** Ingests the default seed as the server would, every report arriving `lag(i)` ms after it was built; yields the stored start times. */
  async function stored(lag: (i: number) => number): Promise<Map<string, number>> {
    const built = Date.now();
    const reports = fleetReports({}, {}) as Seeded[];
    for (const [i, r] of reports.entries()) {
      const v = validateReport(r.body);
      if (!v.ok) throw new Error(`${r.key} ${v.path}: ${v.error}`);
      await ingestReport(storage, v.report, built + lag(i), r.who);
    }
    const out = new Map<string, number>();
    for (const r of reports) out.set(r.key, (await storage.fleet.getSession(r.body.session.id))!.started_at);
    return out;
  }

  function expectSeedOrder(starts: Map<string, number>): void {
    const values = [...starts.values()];
    for (let i = 1; i < values.length; i++) expect(values[i], `report ${i} starts after report ${i - 1}`).toBeGreaterThan(values[i - 1]!);
    expect(starts.get("arm")).toBeGreaterThan(starts.get("tester")!);
  }

  it("keeps the seed's order when the server takes every report in the same millisecond", async () => {
    expectSeedOrder(await stored(() => 0));
  });

  it("keeps the seed's order when the reports arrive slowly, well inside the server's start-time tolerance", async () => {
    expectSeedOrder(await stored((i) => i * 1000));
  });

  it("fails the seed when the server replaced a claimed start time, and passes when it kept them all", () => {
    const reports = fleetReports({}, {}) as Seeded[];
    const kept = reports.map((r) => ({ id: r.body.session.id, startedAt: r.body.session.startedAt }));
    expect(() => keptStarts(reports, kept)).not.toThrow();
    expect(() => keptStarts(reports, kept.slice(1))).not.toThrow(); // a session the state does not list is not checked
    const moved = kept.map((s) => (s.id === "e2e-s-tester" ? { ...s, startedAt: s.startedAt + 1 } : s));
    expect(() => keptStarts(reports, moved)).toThrow(/start time of tester;/);
  });

  it("claims start times the server keeps rather than replacing them with its own clock", () => {
    const built = Date.now();
    for (const r of fleetReports({}, { bulk: 30, ended: 5, rich: true, reporters: true, compaction: true }) as Seeded[]) {
      expect(built - r.body.session.startedAt, r.key).toBeLessThan(START_TOLERANCE_MS / 2);
      expect(built - r.body.session.startedAt, r.key).toBeGreaterThan(0);
    }
  });
});
