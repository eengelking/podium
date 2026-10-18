// Paging for the left list (#242): which rows go on which page, from the height the panel has for them.
// Pure; the Rail measures the panel and draws what these return.

/** A run of rows in list order. `key` is the band's key, or null for the plain list (no header). */
export interface RailBlock {
  key: string | null;
  rows: readonly string[];
}

/** The rows `start` to `end` of one block. `cont` is true when the block began on an earlier page, so its header is repeated. */
export interface RailSlice {
  block: number;
  start: number;
  end: number;
  cont: boolean;
}

export interface RailPage {
  slices: RailSlice[];
  /** Rows on this page, not counting headers. */
  rows: number;
}

export interface RailRoom {
  /** Pixels the page's rows and headers may take. */
  room: number;
  rowH: number;
  bandH: number;
}

/** Fill pages greedily by height. A page always holds at least one row, and a header is never left without a row under it. */
export function paginateRail(blocks: readonly RailBlock[], { room, rowH, bandH }: RailRoom): RailPage[] {
  const pages: RailPage[] = [];
  let page: RailPage = { slices: [], rows: 0 };
  let used = 0;
  blocks.forEach((block, b) => {
    const header = block.key === null ? 0 : bandH;
    block.rows.forEach((_, r) => {
      const last = page.slices[page.slices.length - 1];
      const open = last?.block === b;
      const cost = rowH + (open ? 0 : header);
      if (page.rows > 0 && used + cost > room) {
        pages.push(page);
        page = { slices: [], rows: 0 };
        used = 0;
      }
      const tail = page.slices[page.slices.length - 1];
      if (tail?.block === b) {
        tail.end = r + 1;
        used += rowH;
      } else {
        page.slices.push({ block: b, start: r, end: r + 1, cont: header > 0 && r > 0 });
        used += rowH + header;
      }
      page.rows++;
    });
  });
  if (page.rows > 0) pages.push(page);
  return pages;
}

/** The page holding a row, or -1 when no page does. */
export function pageOf(blocks: readonly RailBlock[], pages: readonly RailPage[], id: string): number {
  return pages.findIndex((p) => p.slices.some((s) => blocks[s.block]!.rows.slice(s.start, s.end).includes(id)));
}
