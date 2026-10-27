import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent, act } from "@testing-library/react";
import { SessionCard } from "./components/SessionCard";
import { FocusView } from "./components/FocusView";
import { COPIED_MS } from "./components/SessionId";
import { makeSession } from "./fixtures";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const CFG = { staleAfterMs: 15_000, dropAfterMs: 60_000, lingerMs: 8_000, detachedHideAfterMs: 60_000 };
const ID = "3f9a1c2e-4b7d-4a10-9c55-0d2e8f61a7b3";
const stubClipboard = (writeText = vi.fn().mockResolvedValue(undefined)) => {
  vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText } });
  return writeText;
};
const card = (onOpen = () => {}) => render(<SessionCard s={makeSession({ id: ID })} now={Date.now()} config={CFG} entering={false} leaving={false} onOpen={onOpen} />);
const page = () => render(<FocusView s={makeSession({ id: ID })} now={Date.now()} config={CFG} sort={{ key: null, dir: "asc" } as never} onSort={() => {}} selectedAgent={null} flashAgent={null} onAgent={() => {}} />);

// #322: the card and the orchestrator page show the same eight characters of the session id, and copy the whole id on a click.
describe("the session id on the card and the orchestrator page (#322)", () => {
  it("the card shows the first eight characters of the id on the path line", () => {
    const { container } = card();
    const id = container.querySelector(".card-slot > .sid")!;
    expect(id.textContent).toBe("3f9a1c2e");
    expect(id.getAttribute("title")).toContain(ID);
    expect(id).toHaveAccessibleName(/Copy session id 3f9a1c2e/);
  });

  it("clicking the card's id copies the whole id, says Copied, and does not open the card", async () => {
    vi.useFakeTimers();
    const writeText = stubClipboard();
    const onOpen = vi.fn();
    const { container } = card(onOpen);
    await act(async () => {
      fireEvent.click(container.querySelector(".card-slot > .sid")!);
    });
    expect(writeText).toHaveBeenCalledWith(ID);
    expect(onOpen).not.toHaveBeenCalled();
    expect(container.querySelector(".card-slot > .sid")!.textContent).toBe("Copied");
    act(() => {
      vi.advanceTimersByTime(COPIED_MS);
    });
    expect(container.querySelector(".card-slot > .sid")!.textContent).toBe("3f9a1c2e");
  });

  it("the card's id is a real button beside the card's button, never inside it (#759)", () => {
    const { container } = card();
    expect(container.querySelector("button button, [role=button] button, button [role=button]")).toBeNull();
    const sid = container.querySelector(".card-slot > button.sid")!;
    expect(sid).not.toBeNull();
    expect(sid.getAttribute("role")).toBeNull();
    // After the card's button, so the tab order is the card, then its id.
    expect(container.querySelector(".card-slot > .card")!.compareDocumentPosition(sid) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // The path row keeps an empty slot for it.
    expect(container.querySelector(".card .pathrow .sidslot")).not.toBeNull();
    expect(screen.getByRole("button", { name: "Copy session id 3f9a1c2e" })).toBe(sid);
  });

  it("the id's name contains its visible text while it says Copied or Copy failed (#759)", async () => {
    stubClipboard();
    const { container } = card();
    await act(async () => {
      fireEvent.click(container.querySelector(".card-slot > .sid")!);
    });
    expect(screen.getByRole("button", { name: "Copied" })).toBe(container.querySelector(".card-slot > .sid"));
    cleanup();
    stubClipboard(vi.fn().mockRejectedValue(new Error("denied")));
    const again = card();
    await act(async () => {
      fireEvent.click(again.container.querySelector(".card-slot > .sid")!);
    });
    expect(screen.getByRole("button", { name: "Copy failed" })).toBeTruthy();
  });

  it("the orchestrator page's id is a cell of the facts grid that copies the whole id, and the header no longer has it", async () => {
    const writeText = stubClipboard();
    const { container } = page();
    expect(container.querySelector(".fh .sid")).toBeNull();
    const cell = container.querySelector(".facts .fact.copy .v.mono")!;
    expect(cell.textContent).toBe("3f9a1c2e");
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /Session 3f9a1c2e, copy the full id/ }));
    });
    expect(writeText).toHaveBeenCalledWith(ID);
    expect(container.querySelector(".facts .fact.copy .v.mono")!.textContent).toBe("Copied");
  });

  it("when the clipboard refuses, the id says Copy failed instead of Copied", async () => {
    stubClipboard(vi.fn().mockRejectedValue(new Error("denied")));
    const { container } = card();
    await act(async () => {
      fireEvent.click(container.querySelector(".card-slot > .sid")!);
    });
    expect(container.querySelector(".card-slot > .sid")!.textContent).toBe("Copy failed");
  });

  it("when the browser has no clipboard, the id says Copy failed", async () => {
    vi.stubGlobal("navigator", { ...navigator, clipboard: undefined });
    const { container } = card();
    await act(async () => {
      fireEvent.click(container.querySelector(".card-slot > .sid")!);
    });
    expect(container.querySelector(".card-slot > .sid")!.textContent).toBe("Copy failed");
  });
});
