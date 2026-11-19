// One keyboard stop for the Chat message list (#1231). The list is one tab stop however long it is; Up and Down, Home and End move
// between messages; Enter, the ContextMenu key and Shift+F10 ask for the focused message's sender menu (#1235); Escape returns focus
// to the message.
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, cleanup, fireEvent, act } from "@testing-library/react";
import { useRovingList } from "./useRovingList";

afterEach(cleanup);

function List({ n, onMenu }: { n: number; onMenu?: (i: number) => void }) {
  const roving = useRovingList(n, onMenu);
  return (
    <div>
      <button type="button">before</button>
      <ol aria-label="Messages" {...roving.listProps}>
        {Array.from({ length: n }, (_, i) => (
          <li key={i} {...roving.itemProps(i)}>
            <span>{`Sender ${i % 5}, 10:${String(i).padStart(2, "0")}: message ${i}`}</span>
            <a href="#/x">link {i}</a>
          </li>
        ))}
      </ol>
      <button type="button">after</button>
    </div>
  );
}

const tabbable = (c: HTMLElement) => Array.from(c.querySelectorAll<HTMLElement>("li")).filter((e) => e.tabIndex === 0);
const focus = (e: HTMLElement) => act(() => e.focus());
const items = (c: HTMLElement) => Array.from(c.querySelectorAll<HTMLElement>("li"));

describe("useRovingList", () => {
  it("adds one tab stop for 50 messages from 5 senders, not 50", () => {
    const { container } = render(<List n={50} />);
    expect(tabbable(container)).toHaveLength(1);
    expect(items(container).filter((e) => e.tabIndex === -1)).toHaveLength(49);
  });

  it("moves between messages with the arrow keys, Home and End", () => {
    const { container } = render(<List n={50} />);
    const li = items(container);
    focus(li[0]);
    fireEvent.keyDown(li[0], { key: "ArrowDown" });
    expect(document.activeElement).toBe(li[1]);
    expect(tabbable(container)).toEqual([li[1]]);
    fireEvent.keyDown(li[1], { key: "ArrowUp" });
    expect(document.activeElement).toBe(li[0]);
    fireEvent.keyDown(li[0], { key: "ArrowUp" });
    expect(document.activeElement).toBe(li[0]);
    fireEvent.keyDown(li[0], { key: "End" });
    expect(document.activeElement).toBe(li[49]);
    fireEvent.keyDown(li[49], { key: "ArrowDown" });
    expect(document.activeElement).toBe(li[49]);
    fireEvent.keyDown(li[49], { key: "Home" });
    expect(document.activeElement).toBe(li[0]);
  });

  it("keeps the stop where the person last was when focus leaves and returns", () => {
    const { container } = render(<List n={10} />);
    const li = items(container);
    focus(li[3]);
    expect(tabbable(container)).toEqual([li[3]]);
    (container.querySelector("button") as HTMLElement).focus();
    expect(tabbable(container)).toEqual([li[3]]);
  });

  it("asks for the sender's menu on Enter, the ContextMenu key and Shift+F10", () => {
    const onMenu = vi.fn();
    const { container } = render(<List n={5} onMenu={onMenu} />);
    const li = items(container);
    focus(li[2]);
    fireEvent.keyDown(li[2], { key: "Enter" });
    fireEvent.keyDown(li[2], { key: "ContextMenu" });
    fireEvent.keyDown(li[2], { key: "F10", shiftKey: true });
    expect(onMenu.mock.calls).toEqual([[2], [2], [2]]);
  });

  it("leaves Enter alone on a control inside the message, and other keys alone", () => {
    const onMenu = vi.fn();
    const { container } = render(<List n={3} onMenu={onMenu} />);
    const link = container.querySelector("a") as HTMLElement;
    fireEvent.keyDown(link, { key: "Enter" });
    fireEvent.keyDown(items(container)[0], { key: "a" });
    fireEvent.keyDown(items(container)[0], { key: "F10" });
    expect(onMenu).not.toHaveBeenCalled();
  });

  it("does nothing on Enter when no menu is wired", () => {
    const { container } = render(<List n={3} />);
    const li = items(container);
    focus(li[0]);
    fireEvent.keyDown(li[0], { key: "Enter" });
    expect(document.activeElement).toBe(li[0]);
  });

  it("returns focus to the message on Escape", () => {
    const { container } = render(<List n={5} />);
    const li = items(container);
    focus(li[1]);
    (li[1].querySelector("a") as HTMLElement).focus();
    fireEvent.keyDown(li[1].querySelector("a") as HTMLElement, { key: "Escape" });
    expect(document.activeElement).toBe(li[1]);
  });

  it("clamps the stop when the list shrinks and handles an empty list", () => {
    const { container, rerender } = render(<List n={10} />);
    focus(items(container)[9]);
    rerender(<List n={4} />);
    expect(tabbable(container)).toEqual([items(container)[3]]);
    rerender(<List n={0} />);
    expect(items(container)).toHaveLength(0);
    fireEvent.keyDown(container.querySelector("ol") as HTMLElement, { key: "ArrowDown" });
  });
});
