// The banner under the top bar (#1209, mockup/podium-page-title-once.html): the page's description on one line, whole sentences only, with a (i) when some are left out.
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { FleetView } from "../FleetApp";
import { PAGE_INFO } from "../pageInfo";
import { stateFrom } from "../testState";
import { useTheme } from "../useTheme";
import { PageBanner } from "./PageBanner";
import { anchoredAt } from "./Modal";

beforeEach(() => localStorage.clear());
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  window.history.replaceState(null, "", "#/");
});

const TEXT = "First one. Second one is a little longer. Third one is the longest of the three.";

function Banner(props: { description?: string; more?: boolean }) {
  const theme = useTheme();
  return (
    <div className="podium">
      <PageBanner
        name="Sample"
        description={props.description ?? TEXT}
        wall={{ theme, shortcuts: false, onShortcuts: () => {} }}
        more={props.more ? { label: "More about Sample", tip: "Click to learn more", children: <p>The extra part.</p> } : undefined}
      />
    </div>
  );
}

/** jsdom has no layout, so a test gives the text a width of 10 px a character inside a line `room` px wide. */
function layout(room: number) {
  vi.spyOn(HTMLElement.prototype, "scrollWidth", "get").mockImplementation(function (this: HTMLElement) {
    return (this.textContent ?? "").length * 10;
  });
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockImplementation(() => room);
}

describe("PageBanner", () => {
  it("shows the whole description and no (i) when it fits on the line", () => {
    render(<Banner />);
    expect(screen.getByRole("region", { name: "Display settings" })).toHaveTextContent(TEXT);
    expect(screen.queryByRole("button", { name: "Read the full description" })).toBeNull();
  });

  it("shows only the whole sentences that fit, and a (i) for the rest", () => {
    layout(300);
    render(<Banner />);
    const banner = screen.getByRole("region", { name: "Display settings" });
    // "First one. Second one is a little longer." is 41 characters, 410 px: too wide. "First one." is 10 characters, 100 px.
    expect(banner.querySelector(".bt")).toHaveTextContent(/^First one\.$/);
    expect(screen.getByRole("button", { name: "Read the full description" })).toBeInTheDocument();
    expect(banner.querySelector(".bt-wrap")).not.toHaveClass("full");
  });

  it("takes two sentences when two fit, never a piece of one", () => {
    layout(420);
    render(<Banner />);
    expect(screen.getByRole("region", { name: "Display settings" }).querySelector(".bt")).toHaveTextContent(/^First one\. Second one is a little longer\.$/);
  });

  it("lets a first sentence that is too long for the half-banner cap use the whole row instead of cutting it", () => {
    layout(50);
    render(<Banner description="A first sentence that cannot fit. And more." />);
    const banner = screen.getByRole("region", { name: "Display settings" });
    expect(banner.querySelector(".bt")).toHaveTextContent("A first sentence that cannot fit.");
    expect(banner.querySelector(".bt-wrap")).toHaveClass("full");
  });

  it("opens the full description in a modal under the (i), and gives focus back on close", () => {
    layout(300);
    render(<Banner />);
    const info = screen.getByRole("button", { name: "Read the full description" });
    expect(info).toHaveAttribute("aria-haspopup", "dialog");
    expect(within(info).getByText("Click to read the full description")).toBeInTheDocument();
    fireEvent.click(info);
    const dialog = screen.getByRole("dialog", { name: "About Sample" });
    expect(within(dialog).getByText(TEXT)).toBeInTheDocument();
    expect(dialog).toHaveClass("anchor");
    expect(dialog.style.top).toMatch(/px$/);
    expect(info).toHaveAttribute("aria-expanded", "true");
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(info).toHaveFocus();
    expect(info).toHaveAttribute("aria-expanded", "false");
  });

  it("keeps the (i) on, with its own name and tip, when the page has more to say, and adds that to the modal", () => {
    render(<Banner more />);
    const info = screen.getByRole("button", { name: "More about Sample" });
    expect(within(info).getByText("Click to learn more")).toBeInTheDocument();
    fireEvent.click(info);
    const dialog = screen.getByRole("dialog", { name: "About Sample" });
    expect(within(dialog).getByText(TEXT)).toBeInTheDocument();
    expect(within(dialog).getByRole("heading", { level: 3, name: "More about Sample" })).toBeInTheDocument();
    expect(within(dialog).getByText("The extra part.")).toBeInTheDocument();
  });

  it("fits again when the description changes", () => {
    layout(300);
    const { rerender } = render(<Banner />);
    expect(screen.getByRole("button", { name: "Read the full description" })).toBeInTheDocument();
    rerender(<Banner description="Short." />);
    expect(screen.queryByRole("button", { name: "Read the full description" })).toBeNull();
  });
});

describe("anchoredAt", () => {
  const at = (rect: Partial<DOMRect>) => {
    const el = document.createElement("button");
    vi.spyOn(el, "getBoundingClientRect").mockReturnValue({ left: 0, bottom: 0, ...rect } as DOMRect);
    return el;
  };
  it("puts the modal 8 px under the element and 12 px left of it", () => {
    vi.stubGlobal("innerWidth", 1200);
    expect(anchoredAt(at({ left: 500, bottom: 40 }))).toEqual({ top: 48, left: 488 });
  });
  it("keeps it 16 px inside the left edge", () => {
    vi.stubGlobal("innerWidth", 1200);
    expect(anchoredAt(at({ left: 5, bottom: 40 })).left).toBe(16);
  });
  it("keeps it inside the right edge", () => {
    vi.stubGlobal("innerWidth", 1000);
    expect(anchoredAt(at({ left: 900, bottom: 40 })).left).toBe(1000 - 440 - 16);
  });
  it("is as wide as the window allows on a narrow one", () => {
    vi.stubGlobal("innerWidth", 400);
    expect(anchoredAt(at({ left: 300, bottom: 40 })).left).toBe(16);
  });
});

describe("every page's banner holds its description alone (#1209)", () => {
  it("has no bold page name in front of it on the fleet and the Board", () => {
    render(<FleetView state={stateFrom()} />);
    const fleet = screen.getByRole("region", { name: "Display settings" });
    expect(fleet.querySelector("b")).toBeNull();
    expect(fleet).toHaveTextContent(PAGE_INFO.fleet.description);
    cleanup();
    render(<FleetView board state={stateFrom()} />);
    expect(screen.getByRole("region", { name: "Display settings" })).toHaveTextContent(PAGE_INFO.board.description);
    expect(screen.getByRole("region", { name: "Display settings" }).querySelector("b")).toBeNull();
  });

  it("names every page in the chip with the same words the description is filed under", () => {
    render(<FleetView state={stateFrom()} />);
    expect(screen.getByTestId("page-pill")).toHaveTextContent(PAGE_INFO.fleet.name);
  });
});
