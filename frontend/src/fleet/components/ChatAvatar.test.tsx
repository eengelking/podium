// The Chat avatar (#1231, mockup/podium-chat-redesign.html): an agent is a rounded tile in its model's color, a person a ring, a gap
// and a disc, you the same disc turned inside out; two parties overlap. Shape says the kind, color the model, a word the rest.
import { describe, it, expect, afterEach } from "vitest";
import axe from "axe-core";
import { render, cleanup, fireEvent } from "@testing-library/react";
import { ChatAvatar, ChatAvatarPair, AVATAR_SIZES } from "./ChatAvatar";
import type { ModelFamily } from "../types";

afterEach(cleanup);

const first = (c: HTMLElement) => c.firstElementChild as HTMLElement;

describe("ChatAvatar", () => {
  it.each(AVATAR_SIZES)("draws an agent at %i px: a tile with a chip glyph, in its model's color", (size) => {
    const { container } = render(<ChatAvatar kind="agent" name="Tester" family="sonnet" size={size} />);
    const el = first(container);
    expect(el.className).toContain("ch-av agent");
    expect(el.className).toContain(`s${size}`);
    expect(el.style.getPropertyValue("--c")).toBe("var(--sonnet)");
    expect(el.querySelector("svg.ch-av-chip")).not.toBeNull();
  });

  it.each(["opus", "sonnet", "haiku", "fable", "other"] as ModelFamily[])("takes the %s color from the wall's model mapping", (family) => {
    const { container } = render(<ChatAvatar kind="agent" name="A" family={family} size={40} />);
    expect(first(container).style.getPropertyValue("--c")).toBe(`var(--${family})`);
  });

  it.each(AVATAR_SIZES)("draws a person at %i px: initials, and never a model color", (size) => {
    const { container } = render(<ChatAvatar kind="person" name="Ed Engelking" size={size} />);
    const el = first(container);
    expect(el.className).toContain("ch-av person");
    expect(el.textContent).toBe("EE");
    expect(el.getAttribute("style")).toBeNull();
  });

  it("draws you as the inverted disc with your initials", () => {
    const { container } = render(<ChatAvatar kind="you" name="Ed" size={40} />);
    expect(first(container).className).toContain("ch-av me");
    expect(first(container).textContent).toBe("E");
  });

  it("shows the state with the wall's own shape", () => {
    const { container } = render(<ChatAvatar kind="agent" name="Tester" family="opus" size={40} state="waiting" />);
    const mark = container.querySelector(".ch-av-st svg.si-waiting");
    expect(mark).not.toBeNull();
  });

  it.each(["running", "waiting", "bg", "stale", "done", "deleg"] as const)("draws the %s state with the wall's shape", (state) => {
    const { container } = render(<ChatAvatar kind="agent" name="A" family="opus" size={40} state={state} />);
    expect(container.querySelector(`.ch-av-st svg.si-${state}`)).not.toBeNull();
  });

  it("draws no state mark on a person or when no state is given", () => {
    const a = render(<ChatAvatar kind="person" name="Ed" size={40} state="running" />);
    expect(a.container.querySelector(".ch-av-st")).toBeNull();
    cleanup();
    const b = render(<ChatAvatar kind="agent" name="A" family="opus" size={40} />);
    expect(b.container.querySelector(".ch-av-st")).toBeNull();
  });

  it("is decorative when it opens no menu", () => {
    const { container } = render(<ChatAvatar kind="agent" name="Tester" family="opus" size={40} />);
    expect(first(container).getAttribute("aria-hidden")).toBe("true");
    expect(container.querySelector("button")).toBeNull();
  });

  it("is a labelled menu button only when it opens one", () => {
    let opened = 0;
    const { container } = render(<ChatAvatar kind="person" name="Ed" size={28} onMenu={() => (opened += 1)} />);
    const b = container.querySelector("button") as HTMLButtonElement;
    expect(b.getAttribute("aria-label")).toBe("Actions for Ed");
    expect(b.getAttribute("aria-haspopup")).toBe("menu");
    expect(b.getAttribute("aria-hidden")).toBeNull();
    fireEvent.click(b);
    expect(opened).toBe(1);
  });
});

describe("ChatAvatarPair", () => {
  it("overlaps two avatars and is decorative as a whole", () => {
    const { container } = render(
      <ChatAvatarPair
        a={{ kind: "agent", name: "podium-main", family: "opus" }}
        b={{ kind: "agent", name: "release-bot", family: "haiku" }}
      />,
    );
    const pair = first(container);
    expect(pair.className).toContain("ch-av-pair");
    expect(pair.getAttribute("aria-hidden")).toBe("true");
    expect(pair.querySelectorAll(".ch-av")).toHaveLength(2);
    expect(pair.querySelectorAll(".ch-av-st")).toHaveLength(0);
  });

  it("can pair a person with an agent", () => {
    const { container } = render(<ChatAvatarPair a={{ kind: "you", name: "Ed" }} b={{ kind: "agent", name: "Tester", family: "sonnet" }} />);
    expect(container.querySelector(".ch-av.me")).not.toBeNull();
    expect(container.querySelector(".ch-av.agent")).not.toBeNull();
  });
});

describe("every variant at every size", () => {
  it("has no axe violation, and no variant is color alone (a glyph, initials or a state shape)", async () => {
    const { container } = render(
      <main>
        <ul aria-label="Senders">
          {AVATAR_SIZES.flatMap((size) => [
            <li key={`a${size}`}>
              <ChatAvatar kind="agent" name="Tester" family="haiku" size={size} state="running" /> Tester
            </li>,
            <li key={`p${size}`}>
              <ChatAvatar kind="person" name="Ed Engelking" size={size} /> Ed Engelking
            </li>,
            <li key={`y${size}`}>
              <ChatAvatar kind="you" name="Ed" size={size} /> Ed
            </li>,
            <li key={`m${size}`}>
              <ChatAvatar kind="person" name="Ed" size={size} onMenu={() => {}} /> Ed
            </li>,
          ])}
          <li>
            <ChatAvatarPair a={{ kind: "you", name: "Ed" }} b={{ kind: "agent", name: "Tester", family: "opus" }} /> Ed, Tester
          </li>
        </ul>
      </main>,
    );
    for (const av of Array.from(container.querySelectorAll(".ch-av.agent"))) expect(av.querySelector("svg.ch-av-chip")).not.toBeNull();
    for (const av of Array.from(container.querySelectorAll(".ch-av.person, .ch-av.me"))) expect((av.textContent ?? "").length).toBeGreaterThan(0);
    const r = await axe.run(container, { runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "best-practice"] }, rules: { "color-contrast": { enabled: false }, region: { enabled: false } } });
    expect(r.violations.map((v) => v.id)).toEqual([]);
  });
});
