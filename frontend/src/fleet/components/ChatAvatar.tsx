// The avatar Chat draws beside a sender (#1231, mockup/podium-chat-redesign.html). Shape says what the sender is, color says which model,
// and a state mark says what an agent is doing: an agent is a rounded tile in its model's color with a chip glyph, a person is a ring, a gap
// and a disc with initials (never a hue: color already means model and status, see Monogram in People.tsx), and you are the same disc turned
// inside out. Two parties in one conversation overlap as a pair. It is decorative: the sender's name is always beside it, so it is
// `aria-hidden`, and it is a button only where it opens a menu (`onMenu`).
import { initials } from "../people";
import { ChChip } from "./ChatIcons";
import { cssVar, FAMILY_COLOR, StateIcon, type StateKind } from "./Chips";
import type { ModelFamily } from "../types";

/** The sizes Chat draws: the stack in the thread header, the sidebar and the lists, the dialogs, the thread, the empty thread's introduction. */
export const AVATAR_SIZES = [22, 28, 30, 40, 44] as const;
export type AvatarSize = (typeof AVATAR_SIZES)[number];

type AvatarKind = "agent" | "person" | "you";

export interface AvatarProps {
  kind: AvatarKind;
  name: string;
  /** An agent's model family; the color comes from the wall's own mapping. */
  family?: ModelFamily;
  /** An agent's state, drawn with the wall's own shapes at the tile's corner. */
  state?: StateKind;
  /** Draw the initials from CSS, so they are not text in the page. The members stack is one button whose name must hold all its visible text, and an initial is not in it. */
  css?: boolean;
}

function Tile({ kind, name, family = "other", state, size, css }: AvatarProps & { size: AvatarSize }) {
  const cls = `ch-av ${kind === "you" ? "me" : kind} s${size}`;
  if (kind === "agent") {
    return (
      <span className={cls} style={cssVar(FAMILY_COLOR[family])} aria-hidden="true">
        <ChChip />
        {state && (
          <span className="ch-av-st">
            <StateIcon kind={state} />
          </span>
        )}
      </span>
    );
  }
  if (css) return <span className={cls} data-i={initials(name)} aria-hidden="true" />;
  return (
    <span className={cls} aria-hidden="true">
      {initials(name)}
    </span>
  );
}

export function ChatAvatar(props: AvatarProps & { size: AvatarSize; onMenu?: () => void; /** The menu's key, so the page can put the focus back on the button. */ more?: string; expanded?: boolean }) {
  const { onMenu, more, expanded, ...tile } = props;
  if (!onMenu) return <Tile {...tile} />;
  return (
    <button type="button" className="ch-av-btn" aria-haspopup="menu" aria-expanded={expanded ?? false} aria-label={`Actions for ${props.name}`} data-more={more} onClick={onMenu}>
      <Tile {...tile} />
    </button>
  );
}

/** Two parties, overlapped (a link between two agents, or you and another person's agent). Decorative as a whole; no state marks. */
export function ChatAvatarPair({ a, b }: { a: AvatarProps; b: AvatarProps }) {
  return (
    <span className="ch-av-pair" aria-hidden="true">
      <Tile {...a} state={undefined} size={22} />
      <Tile {...b} state={undefined} size={22} />
    </span>
  );
}
