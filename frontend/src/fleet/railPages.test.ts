import { describe, it, expect } from "vitest";
import { pageOf, paginateRail, type RailBlock } from "./railPages";

const ids = (n: number, p = "s") => Array.from({ length: n }, (_, i) => `${p}${i + 1}`);
const flat = (n: number): RailBlock[] => [{ key: null, rows: ids(n) }];
const size = { rowH: 50, bandH: 30 };

describe("paginateRail", () => {
  it("returns one page when everything fits", () => {
    const pages = paginateRail(flat(5), { room: 250, ...size });
    expect(pages).toHaveLength(1);
    expect(pages[0].rows).toBe(5);
  });

  it("splits a plain list by how many rows the room holds", () => {
    const pages = paginateRail(flat(24), { room: 500, ...size });
    expect(pages.map((p) => p.rows)).toEqual([10, 10, 4]);
    expect(pages[0].slices).toEqual([{ block: 0, start: 0, end: 10, cont: false }]);
    expect(pages[2].slices).toEqual([{ block: 0, start: 20, end: 24, cont: false }]);
  });

  it("holds more rows per page in a taller panel", () => {
    expect(paginateRail(flat(24), { room: 300, ...size })[0].rows).toBe(6);
    expect(paginateRail(flat(24), { room: 900, ...size })[0].rows).toBe(18);
  });

  it("never makes a page with no rows, however short the room", () => {
    const pages = paginateRail(flat(3), { room: 10, ...size });
    expect(pages.map((p) => p.rows)).toEqual([1, 1, 1]);
  });

  it("counts a band header against the page and repeats it where a band continues", () => {
    const blocks: RailBlock[] = [
      { key: "ed", rows: ids(6, "e") },
      { key: "pri", rows: ids(2, "p") },
    ];
    const pages = paginateRail(blocks, { room: 280, ...size });
    // 280 = header 30 + 5 rows of 50
    expect(pages[0].slices).toEqual([{ block: 0, start: 0, end: 5, cont: false }]);
    // page 2: repeated header (30) + 1 row (50) + next band header (30) + 2 rows (100) = 210
    expect(pages[1].slices).toEqual([
      { block: 0, start: 5, end: 6, cont: true },
      { block: 1, start: 0, end: 2, cont: false },
    ]);
    expect(pages.reduce((n, p) => n + p.rows, 0)).toBe(8);
  });

  it("does not leave a band header alone at the bottom of a page", () => {
    const blocks: RailBlock[] = [
      { key: "a", rows: ids(2, "a") },
      { key: "b", rows: ids(2, "b") },
    ];
    // room holds band a (30 + 100 = 130) and 30 more: a header with no room for a row
    const pages = paginateRail(blocks, { room: 160, ...size });
    expect(pages[0].slices.map((s) => s.block)).toEqual([0]);
    expect(pages[1].slices[0]).toEqual({ block: 1, start: 0, end: 2, cont: false });
  });

  it("skips an empty band", () => {
    const pages = paginateRail([{ key: "x", rows: [] }, { key: "y", rows: ["y1"] }], { room: 500, ...size });
    expect(pages).toHaveLength(1);
    expect(pages[0].slices).toEqual([{ block: 1, start: 0, end: 1, cont: false }]);
  });

  it("returns no pages for no rows", () => {
    expect(paginateRail(flat(0), { room: 500, ...size })).toEqual([]);
  });
});

describe("pageOf", () => {
  it("finds the page holding a row, or -1", () => {
    const blocks = flat(24);
    const pages = paginateRail(blocks, { room: 500, ...size });
    expect(pageOf(blocks, pages, "s1")).toBe(0);
    expect(pageOf(blocks, pages, "s11")).toBe(1);
    expect(pageOf(blocks, pages, "s24")).toBe(2);
    expect(pageOf(blocks, pages, "nope")).toBe(-1);
  });
});
