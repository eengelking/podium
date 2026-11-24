// The start of a Chat thread that has no messages yet (#1345): who is in it as avatars, then its title and what to do. Every thread of Chat draws it, a
// channel, a Direct Message to an agent and a conversation of people, so an empty one reads the same in each.
import type { ReactNode } from "react";
import { Monogram } from "./People";

export function ChatIntro({ who, title, children }: { who: readonly string[]; title: string; children: ReactNode }) {
  return (
    <div className="ch-intro" data-testid="chat-intro">
      <div className="ch-intro-av" aria-hidden="true">
        {who.map((n) => (
          <Monogram key={n} name={n} size="lg" />
        ))}
      </div>
      <h3>
        This is the start of <bdi>{title}</bdi>
      </h3>
      <p>{children}</p>
    </div>
  );
}
