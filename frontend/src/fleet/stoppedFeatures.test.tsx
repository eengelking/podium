// The header's count of features that stopped after a harness update (#724).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { TopBar } from "./components/TopBar";
import { HARNESS_UPDATES_HASH, stoppedOf, useStoppedFeatures } from "./stoppedFeatures";

function Probe() {
  return <span data-testid="n">{useStoppedFeatures()}</span>;
}

beforeEach(() => vi.stubGlobal("fetch", vi.fn()));
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("stoppedOf", () => {
  it("is the count for an unlocked Admin and nothing for anyone else or any other answer", () => {
    expect(stoppedOf({ unlocked: true, stopped: 3 })).toBe(3);
    expect(stoppedOf({ unlocked: false })).toBe(0);
    expect(stoppedOf({ unlocked: true, stopped: 0 })).toBe(0);
    expect(stoppedOf({ unlocked: true, stopped: "3" })).toBe(0);
    expect(stoppedOf(null)).toBe(0);
  });
});

describe("useStoppedFeatures", () => {
  it("asks the Admin notice route without caching, and keeps nothing when the answer is a refusal", async () => {
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: true, json: async () => ({ unlocked: true, stopped: 2 }) });
    render(<Probe />);
    await waitFor(() => expect(screen.getByTestId("n")).toHaveTextContent("2"));
    expect(fetch).toHaveBeenCalledWith("/api/admin/notice", { cache: "no-store", credentials: "same-origin" });
  });

  it("shows 0 when the route fails", async () => {
    (fetch as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("down"));
    render(<Probe />);
    await waitFor(() => expect(fetch).toHaveBeenCalled());
    expect(screen.getByTestId("n")).toHaveTextContent("0");
  });
});

describe("the header pill", () => {
  const bar = (stopped?: number) => render(<TopBar page="Fleet" phase="live" reporters={1} stopped={stopped} collapsed={false} onCollapse={() => undefined} />);

  it("links to Admin > Reporting > Harness updates and says how many features stopped", () => {
    bar(3);
    const link = screen.getByRole("link", { name: /3 features stopped after a harness update/ });
    expect(link).toHaveAttribute("href", HARNESS_UPDATES_HASH);
  });

  it("is singular for one and absent for none", () => {
    bar(1);
    expect(screen.getByRole("link", { name: /1 feature stopped after a harness update/ })).toBeInTheDocument();
    cleanup();
    bar(0);
    expect(screen.queryByText(/stopped after a harness update/)).toBeNull();
  });
});
