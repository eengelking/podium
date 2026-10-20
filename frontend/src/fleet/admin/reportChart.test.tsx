// The Reporting chart (#532): its bars must take their height from the data, and the axes carry labels.
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ReportChart } from "./ReportParts";

afterEach(cleanup);

const rows = [
  { period: "2026-10-18", sessions: 4 },
  { period: "2026-10-19", sessions: 12 },
  { period: "2026-10-20", sessions: 6 },
];
const col = { key: "sessions", label: "Sessions" };

function draw() {
  return render(<ReportChart rows={rows} valueKey="sessions" column={col} unit="Sessions" by="day" />).container;
}

describe("ReportChart", () => {
  it("gives its bars a class that fleet.css does not size", () => {
    const classes = new Set([...draw().querySelectorAll("rect")].flatMap((r) => [...r.classList]));
    expect(classes.size).toBeGreaterThan(0);
    const fleet = readFileSync(join(process.cwd(), "src/fleet/fleet.css"), "utf8");
    for (const cls of classes) {
      // A CSS height beats the rect's height attribute and flattens every bar (the `.bar` meter, 5px).
      const sized = new RegExp(String.raw`\.${cls}\b[^{}]*\{[^}]*\bheight\s*:`);
      expect(fleet, `.${cls} is sized by fleet.css`).not.toMatch(sized);
    }
  });

  it("draws the tallest bar up to the top gridline and sizes the others by value", () => {
    const rects = [...draw().querySelectorAll("rect")];
    const heights = rects.map((r) => Number(r.getAttribute("height")));
    expect(heights).toEqual([30, 90, 45]);
    for (const r of rects) expect(Number(r.getAttribute("y")) + Number(r.getAttribute("height"))).toBe(110);
  });

  it("labels the top gridline, zero, and the first and last period", () => {
    const text = [...draw().querySelectorAll(".yl span, .xl span")].map((t) => t.textContent);
    expect(text).toEqual(["12", "6", "0", "2026-10-18", "2026-10-20"]);
  });
});
