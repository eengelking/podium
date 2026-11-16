import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";

// The Admin, History and Replay pages are loaded when first opened (#754), so the wall's own script stays small. Each is stubbed here: the stub
// being fetched later than the first paint is what the test shows.
vi.mock("./fleet/admin/AdminView", () => ({ AdminView: () => <div>admin stub</div> }));
vi.mock("./fleet/HistoryView", () => ({ HistoryView: () => <div>history stub</div> }));
vi.mock("./fleet/FleetApp", () => ({ FleetApp: () => <div>fleet stub</div> }));

import { Root } from "./Root";

afterEach(() => {
  window.location.hash = "";
});

describe("Root", () => {
  it("shows a loading word while the Admin page is fetched, then the page", async () => {
    window.location.hash = "#/admin";
    render(<Root />);
    expect(screen.getByRole("status")).toHaveTextContent("Loading…");
    expect(await screen.findByText("admin stub")).toBeInTheDocument();
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("shows a loading word while the History page is fetched, then the page", async () => {
    window.location.hash = "#/history";
    render(<Root />);
    expect(screen.getByRole("status")).toHaveTextContent("Loading…");
    expect(await screen.findByText("history stub")).toBeInTheDocument();
  });

  it("opens the fleet console without waiting", () => {
    window.location.hash = "#/";
    render(<Root />);
    expect(screen.getByText("fleet stub")).toBeInTheDocument();
  });

  it("keeps the failure to the page when its script cannot be fetched", async () => {
    vi.resetModules();
    vi.doMock("./fleet/admin/AdminView", () => {
      throw new Error("Failed to fetch dynamically imported module");
    });
    const { Root: FreshRoot } = await import("./Root");
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    window.location.hash = "#/admin";
    render(<FreshRoot />);
    expect(await screen.findByRole("alert")).toHaveTextContent("could not be loaded");
    spy.mockRestore();
    vi.doUnmock("./fleet/admin/AdminView");
  });
});
