import { describe, expect, it } from "vitest";
import { fleetReports } from "./e2e-seed.mjs";

describe("e2e seed start times (#898)", () => {
  // The wall's "Newest" sort reads the start time and falls back to the name on a tie, where "Tester" comes before "arm64-check".
  // The spec expects the session reported last to show first, so no two reports may share a start time, however fast they are built.
  it("gives every session its own start time, later for a report built later", () => {
    const reports = fleetReports({}, {});
    const starts = reports.map((r: { body: { session: { startedAt: number } } }) => r.body.session.startedAt);
    expect(new Set(starts).size).toBe(starts.length);
    const keys = reports.map((r: { key: string }) => r.key);
    expect(starts[keys.indexOf("arm")]).toBeGreaterThan(starts[keys.indexOf("tester")]);
  });
});
