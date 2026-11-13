// Sorting a report table (#1133): the table both Admin > Reporting and My usage draw.
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { ReportTable } from "./ReportParts";
import type { ReportReply } from "./reportsApi";

afterEach(cleanup);

const reply = {
  columns: [
    { key: "key", label: "Model" },
    { key: "sessions", label: "Sessions" },
  ],
  rows: [
    { key: "opus", sessions: 5 },
    { key: "haiku", sessions: null },
    { key: "sonnet", sessions: 9 },
    { key: "fable", sessions: 5 },
  ],
  total: null,
} as unknown as ReportReply;

const names = () => within(screen.getByRole("table")).getAllByRole("row").slice(1).map((r) => within(r).getAllByRole("cell")[0]!.textContent);

describe("ReportTable sorting", () => {
  it("sorts text from A to Z first and Z to A next", () => {
    render(<ReportTable reply={reply} label="Spend" page={1} pageSize={25} history={false} />);
    fireEvent.click(screen.getByRole("button", { name: "Model" }));
    expect(names()).toEqual(["fable", "haiku", "opus", "sonnet"]);
    fireEvent.click(screen.getByRole("button", { name: /Model/ }));
    expect(names()).toEqual(["sonnet", "opus", "haiku", "fable"]);
  });

  it("puts a missing value last in both directions and keeps the server's order for equal values", () => {
    render(<ReportTable reply={reply} label="Spend" page={1} pageSize={25} history={false} />);
    fireEvent.click(screen.getByRole("button", { name: "Sessions" }));
    expect(names()).toEqual(["sonnet", "opus", "fable", "haiku"]);
    fireEvent.click(screen.getByRole("button", { name: /Sessions/ }));
    expect(names()).toEqual(["opus", "fable", "sonnet", "haiku"]);
  });

  it("sorts all rows before the page is cut, and asks to go back to the first page", () => {
    const onSort = vi.fn();
    render(<ReportTable reply={reply} label="Spend" page={2} pageSize={2} history={false} onSort={onSort} />);
    expect(names()).toEqual(["sonnet", "fable"]);
    fireEvent.click(screen.getByRole("button", { name: "Sessions" }));
    expect(onSort).toHaveBeenCalledTimes(1);
    expect(names()).toEqual(["fable", "haiku"]);
  });

  it("starts again in the server's order when a new reply arrives", () => {
    const { rerender } = render(<ReportTable reply={reply} label="Spend" page={1} pageSize={25} history={false} />);
    fireEvent.click(screen.getByRole("button", { name: "Model" }));
    rerender(<ReportTable reply={{ ...reply, rows: [...reply.rows] }} label="Spend" page={1} pageSize={25} history={false} />);
    expect(names()).toEqual(["opus", "haiku", "sonnet", "fable"]);
    for (const h of screen.getAllByRole("columnheader")) expect(h).toHaveAttribute("aria-sort", "none");
  });
  it("sorts the words the table prints, so \"-\" reads and sorts as No owner", () => {
    const owners = {
      columns: [{ key: "key", label: "Person" }, { key: "sessions", label: "Sessions" }],
      rows: [{ key: "Zed", sessions: 1 }, { key: "-", sessions: 2 }, { key: "Alex", sessions: 3 }],
      total: null,
    } as unknown as ReportReply;
    render(<ReportTable reply={owners} label="Spend" page={1} pageSize={25} history={false} breakdown="person" />);
    fireEvent.click(screen.getByRole("button", { name: "Person" }));
    expect(names()).toEqual(["Alex", "No owner", "Zed"]);
  });

  it("puts a value that is not a number last in a number column, in both directions", () => {
    const mixed = {
      columns: [{ key: "key", label: "Model" }, { key: "sessions", label: "Sessions" }],
      rows: [{ key: "a", sessions: 4 }, { key: "b", sessions: "-" }, { key: "c", sessions: 7 }],
      total: null,
    } as unknown as ReportReply;
    render(<ReportTable reply={mixed} label="Spend" page={1} pageSize={25} history={false} />);
    fireEvent.click(screen.getByRole("button", { name: "Sessions" }));
    expect(names()).toEqual(["c", "a", "b"]);
    fireEvent.click(screen.getByRole("button", { name: /Sessions/ }));
    expect(names()).toEqual(["a", "c", "b"]);
  });
});
