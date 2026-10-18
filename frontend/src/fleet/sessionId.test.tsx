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
    const id = container.querySelector(".card .pathrow .sid")!;
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
      fireEvent.click(container.querySelector(".card .sid")!);
    });
    expect(writeText).toHaveBeenCalledWith(ID);
    expect(onOpen).not.toHaveBeenCalled();
    expect(container.querySelector(".card .sid")!.textContent).toBe("Copied");
    act(() => {
      vi.advanceTimersByTime(COPIED_MS);
    });
    expect(container.querySelector(".card .sid")!.textContent).toBe("3f9a1c2e");
  });

  it("Enter on the card's id copies it without opening the card", async () => {
    const writeText = stubClipboard();
    const onOpen = vi.fn();
    const { container } = card(onOpen);
    await act(async () => {
      fireEvent.keyDown(container.querySelector(".card .sid")!, { key: "Enter" });
    });
    expect(writeText).toHaveBeenCalledWith(ID);
    expect(onOpen).not.toHaveBeenCalled();
  });

  it("the orchestrator page's id is a cell of the facts grid that copies the whole id, and the header no longer has it", async () => {
    const writeText = stubClipboard();
    const { container } = page();
    expect(container.querySelector(".fh .sid")).toBeNull();
    const cell = container.querySelector(".facts .fact.copy .v.mono")!;
    expect(cell.textContent).toBe("3f9a1c2e");
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /Copy session id 3f9a1c2e/ }));
    });
    expect(writeText).toHaveBeenCalledWith(ID);
    expect(container.querySelector(".facts .fact.copy .v.mono")!.textContent).toBe("Copied");
  });

  it("when the clipboard refuses, the id says Copy failed instead of Copied", async () => {
    stubClipboard(vi.fn().mockRejectedValue(new Error("denied")));
    const { container } = card();
    await act(async () => {
      fireEvent.click(container.querySelector(".card .sid")!);
    });
    expect(container.querySelector(".card .sid")!.textContent).toBe("Copy failed");
  });
});
