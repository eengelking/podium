import { describe, it, expect, afterEach, vi } from "vitest";
import { render, cleanup, fireEvent, screen } from "@testing-library/react";
import { Compose } from "./Compose";

afterEach(cleanup);

const base = { name: "web", pending: null, draft: "", onDraft: () => {}, confirmClear: false, onConfirmClear: () => {}, onSend: () => {}, error: null, busy: false } as const;

describe("Compose follows what the session's reporter can do (#968)", () => {
  it("lists /clear and /compact when the session declares no commands", () => {
    render(<Compose {...base} draft="/" />);
    expect(screen.getAllByRole("option").map((o) => o.textContent)).toEqual([expect.stringContaining("/clear"), expect.stringContaining("/compact")]);
  });

  it("does not list /clear for a session that declares only compact", () => {
    render(<Compose {...base} draft="/" commands={["compact"]} />);
    const names = screen.getAllByRole("option").map((o) => o.textContent ?? "");
    expect(names).toHaveLength(1);
    expect(names[0]).toContain("/compact");
  });

  it("does not send /clear for a session that does not take it", () => {
    const onSend = vi.fn();
    const onConfirmClear = vi.fn();
    render(<Compose {...base} draft="/clear" commands={["compact"]} onSend={onSend} onConfirmClear={onConfirmClear} />);
    fireEvent.keyDown(screen.getByRole("textbox"), { key: "Enter" });
    expect(onSend).not.toHaveBeenCalled();
    expect(onConfirmClear).not.toHaveBeenCalled();
  });

  it("does not offer a reply in place of a question the reporter cannot take it for", () => {
    const onSend = vi.fn();
    render(<Compose {...base} pending="question" draft="wait" canReply={false} onSend={onSend} />);
    expect(screen.getByText(/can't take a reply in place of this question/i)).toBeInTheDocument();
    fireEvent.keyDown(screen.getByRole("textbox"), { key: "Enter" });
    expect(onSend).not.toHaveBeenCalled();
  });

  it("still sends /compact while a question the reporter cannot take a reply for is open", () => {
    const onSend = vi.fn();
    render(<Compose {...base} pending="question" draft="/compact" canReply={false} onSend={onSend} />);
    fireEvent.keyDown(screen.getByRole("textbox"), { key: "Enter" });
    expect(onSend).toHaveBeenCalledWith("/compact");
  });
});
