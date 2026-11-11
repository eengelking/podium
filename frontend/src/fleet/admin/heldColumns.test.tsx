// Holding a table's columns while its headings sort (#1144). jsdom has no layout, so a heading's width is stubbed; the real measurement is the
// e2e specs that read each column's position before and after a click.
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { SortArrow, useHeldColumns } from "./heldColumns";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function Table({ scope }: { scope: string }) {
  const held = useHeldColumns(scope);
  return (
    <table aria-label="t" style={held.tableStyle}>
      {held.cols}
      <thead>
        <tr ref={held.head}>
          <th>
            <button type="button" onClick={held.hold}>
              A
            </button>
          </th>
          <th>B</th>
        </tr>
      </thead>
    </table>
  );
}

describe("SortArrow", () => {
  it("always takes its slot, and holds the arrow only for a sorted heading", () => {
    const { container, rerender } = render(<SortArrow dir={0} />);
    const slot = () => container.querySelector(".sarrow");
    expect(slot()).not.toBeNull();
    expect(slot()).toHaveTextContent("");
    expect(slot()).toHaveAttribute("aria-hidden", "true");
    rerender(<SortArrow dir={1} />);
    expect(slot()).toHaveTextContent("↑");
    rerender(<SortArrow dir={-1} />);
    expect(slot()).toHaveTextContent("↓");
  });
});

describe("useHeldColumns", () => {
  it("leaves the table to its own layout until a heading is clicked", () => {
    const { container } = render(<Table scope="a" />);
    expect(container.querySelector("colgroup")).toBeNull();
    expect(screen.getByRole("table")).not.toHaveStyle({ tableLayout: "fixed" });
  });

  it("fixes the columns at the widths they had at the click, and keeps them over later clicks", () => {
    const widths = [120, 80];
    let n = 0;
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(() => ({ width: widths[n++ % 2] ?? 0 }) as DOMRect);
    const { container } = render(<Table scope="a" />);
    fireEvent.click(screen.getByRole("button", { name: "A" }));
    const cols = () => [...container.querySelectorAll("col")].map((c) => (c as HTMLElement).style.width);
    expect(cols()).toEqual(["120px", "80px"]);
    expect(screen.getByRole("table")).toHaveStyle({ tableLayout: "fixed", minWidth: "200px" });
    // A second click does not measure again, so the widths do not drift to the rows on the new page.
    fireEvent.click(screen.getByRole("button", { name: "A" }));
    expect(cols()).toEqual(["120px", "80px"]);
  });

  it("lets go when the scope changes, because that is different content", () => {
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(() => ({ width: 50 }) as DOMRect);
    const { container, rerender } = render(<Table scope="a" />);
    fireEvent.click(screen.getByRole("button", { name: "A" }));
    expect(container.querySelector("colgroup")).not.toBeNull();
    rerender(<Table scope="b" />);
    expect(container.querySelector("colgroup")).toBeNull();
  });
});
