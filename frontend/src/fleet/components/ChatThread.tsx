// Chat's thread (#1034, mockup/podium-chat.html): the header, who may read it, who is in it, the newest messages at the bottom with
// "Earlier messages" above, and the box under them. A message's text is always a text node, never HTML. The feed keeps the
// reader's place when something is selected or a menu opens; it goes to the newest message on opening a thread and after a send.
import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type FocusEvent,
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode,
} from "react";
import {
  adminPauseOf,
  adminWho,
  AUTHOR_CHIP_TITLE,
  authorKey,
  authorMarks,
  channelDelivery,
  continuesRun,
  dayLabel,
  liveReaders,
  dmDelivery,
  crossLine,
  dmName,
  mentionChip,
  messageParts,
  sameDay,
  stamp,
  type ChatChannel,
  type AdminRead,
  type ChatOverview,
  type DirectInfo,
  type Party,
} from "../chatData";
import type { Selection, ThreadMessage, ThreadRead } from "../useChat";
import type { SessionView } from "../types";
import {
  AdminPauseBanner,
  AdminTags,
  ReadOnlyBanner,
  ReadingBanner,
  RecordLine,
} from "./ChatAdmin";
import {
  ChLink,
  ChNo,
  ChClock,
  ChTrash,
  ChWarn,
  DeliveryGlyph,
  TagGlyph,
} from "./ChatIcons";
import { linkWords } from "./ChatForms";
import { ChatMenu, agentMenu, messageMenu, personMenu, type MenuAct, type MenuAt, type MenuSpec } from "./ChatMenu";
import { useRovingList } from "../useRovingList";
import { agentState } from "./ChatSidebar";
import { ChatAvatar, ChatAvatarPair } from "./ChatAvatar";
import { ChatMembersPanel, ChatMembersStack, membersOf } from "./ChatMembers";
import { ModelChip, StateIcon } from "./Chips";
import { Modal } from "./Modal";
import { familyName } from "../logic";
import { hm } from "../trafficData";
import { Monogram } from "./People";
import { channelTag, dmTag } from "../chatData";

/** The messages and the Admin's records in time order: a record comes after every message sent before it. Earlier pages not loaded hide the records older than the oldest message shown. */
function recordsAmong(
  messages: ThreadMessage[],
  reads: AdminRead[],
  hasEarlier: boolean,
): (
  { m: ThreadMessage; rec?: undefined } | { rec: AdminRead; m?: undefined }
)[] {
  const first = messages[0]?.at ?? 0;
  const recs = reads
    .filter((r) => !hasEarlier || r.startedAt >= first)
    .sort((a, b) => a.startedAt - b.startedAt);
  const out: (
    { m: ThreadMessage; rec?: undefined } | { rec: AdminRead; m?: undefined }
  )[] = [];
  let i = 0;
  for (const m of messages) {
    while (i < recs.length && recs[i]!.startedAt < m.at)
      out.push({ rec: recs[i++]! });
    out.push({ m });
  }
  while (i < recs.length) out.push({ rec: recs[i++]! });
  return out;
}

/** A block that scrolls sideways has to take focus so the arrow keys scroll it, though it is not a control. */
const FOCUSABLE = { tabIndex: 0 };

/** How long the list stays "off" after it draws something that is not announced. */
const QUIET_MS = 150;

const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`;

/** Whether the viewer wrote this message: a channel says so itself; a Direct Message is yours when a person with your name sent it. */
function mineOf(m: ThreadMessage, me: string): boolean {
  if (m.channel) return m.channel.mine;
  const d = m.direct!;
  return (
    d.from.kind === "person" && d.from.name.toLowerCase() === me.toLowerCase()
  );
}

/** The fields of a message both kinds share (#1269). */
const bodyOf = (m: ThreadMessage) => (m.channel ?? m.direct)!;
const deletedOf = (m: ThreadMessage): boolean => !!bodyOf(m).deletedAt;
/** Whether one of your own messages has a menu: it stands, and the server either lets you change it or says why not. */
const hasMenu = (m: ThreadMessage, me: string): boolean => mineOf(m, me) && !deletedOf(m) && (bodyOf(m).canChange === true || !!bodyOf(m).changeWhy);
/** Why one of your own messages cannot be edited or deleted now, or "" when it can. */
function whyNot(m: ThreadMessage): string {
  const b = bodyOf(m);
  if (b.deletedAt) return "There is nothing left to change.";
  if (b.canChange === true) return "";
  return b.changeWhy ?? "This message cannot be changed.";
}
/** The note a deleted message leaves in its place. */
const tombstone = (m: ThreadMessage, me: string): string => `This message was deleted by ${mineOf(m, me) ? "You" : m.channel ? m.channel.authorName : m.direct!.from.name} at ${hm(bodyOf(m).deletedAt ?? 0)}.`;
const noPeriod = (s: string): string => s.replace(/[.!?]+$/, "");

/** Who sent a message, for the menu on its avatar: a person, or an agent with its session. You have none. The key is the one the members panel's row for the same sender has, behind `t:`. */
interface Sender {
  key: string;
  person: boolean;
  name: string;
  ref: string;
}

function senderOf(m: ThreadMessage, me: string): Sender | null {
  if (mineOf(m, me)) return null;
  if (m.channel) {
    const c = m.channel;
    return c.authorKind === "person"
      ? { key: `mp:${c.authorName}`, person: true, name: c.authorName, ref: c.authorName }
      : { key: `h:${c.authorRef}`, person: false, name: c.authorName, ref: c.authorRef };
  }
  const f = m.direct!.from;
  return f.kind === "person"
    ? { key: `mp:${f.name}`, person: true, name: f.name, ref: f.name }
    : { key: `h:${f.sessionId ?? ""}`, person: false, name: f.name, ref: f.sessionId ?? "" };
}

type Row =
  | { k: "msg"; m: ThreadMessage }
  | { k: "rec"; rec: AdminRead }
  | { k: "day"; at: number }
  | { k: "new" };

/** The rows of the list: the messages and records in time order, a day divider before the first message of each day, and the New line before the first unread one. */
function rowsOf(
  items: ReturnType<typeof recordsAmong>,
  newId: string | null,
): Row[] {
  const rows: Row[] = [];
  let prev: number | null = null;
  for (const it of items) {
    if (it.rec) {
      rows.push({ k: "rec", rec: it.rec });
      continue;
    }
    if (prev === null || !sameDay(prev, it.m.at))
      rows.push({ k: "day", at: it.m.at });
    prev = it.m.at;
    if (it.m.id === newId) rows.push({ k: "new" });
    rows.push({ k: "msg", m: it.m });
  }
  return rows;
}

/** A fenced block: plain text in a monospace block that scrolls sideways, with the language word and a Copy button (the clipboard can be refused). */
function CodeBlock({ text, lang }: { text: string; lang?: string }) {
  const [state, setState] = useState<"idle" | "copied" | "manual">("idle");
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => void (timer.current && clearTimeout(timer.current)),
    [],
  );
  const done = (next: "copied" | "manual") => {
    setState(next);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setState("idle"), 2500);
  };
  const copy = () => {
    const clip =
      typeof navigator === "undefined" ? undefined : navigator.clipboard;
    if (!clip) return done("manual");
    clip.writeText(text).then(
      () => done("copied"),
      () => done("manual"),
    );
  };
  return (
    <div className="ch-code" data-testid="chat-code">
      <div className="ch-code-h">
        <span className="ch-code-lang">{lang ?? ""}</span>
        <button type="button" className="btn sm ch-copy" onClick={copy}>
          {state === "copied"
            ? "Copied"
            : state === "manual"
              ? "Select and copy"
              : "Copy"}
        </button>
      </div>
      <pre
        {...FOCUSABLE}
        role="region"
        aria-label={lang ? `Code, ${lang}` : "Code"}
      >
        <code>{text}</code>
      </pre>
    </div>
  );
}

function Text({ text }: { text: string }) {
  const parts = messageParts(text);
  return (
    <>
      {parts.map((p, i) => {
        if (p.kind === "code")
          return <CodeBlock key={i} text={p.text} lang={p.lang} />;
        if (p.kind === "mention")
          return (
            <span key={i} className="ch-mention">
              {p.text}
            </span>
          );
        if (p.kind === "inline")
          return (
            <code key={i} className="ch-inline">
              {p.text}
            </code>
          );
        if (p.kind === "redacted")
          return (
            <span
              key={i}
              className="rd"
              title="Replaced on the sending machine. The original never left it."
            >
              {p.text}
            </span>
          );
        // The line break that sits against a block is the block's own edge, not a blank line.
        let t = p.text;
        if (parts[i - 1]?.kind === "code") t = t.replace(/^\r?\n/, "");
        if (parts[i + 1]?.kind === "code") t = t.replace(/\r?\n$/, "");
        return t ? t : null;
      })}
    </>
  );
}

/** One of your messages being edited (#1269): the composer's box in place of its text, Save and Cancel. Enter saves, Shift+Enter adds a line, Escape cancels. */
function Editor({ initial, error, busy, onSave, onCancel }: { initial: string; error: string | null; busy: boolean; onSave: (text: string) => void; onCancel: () => void }) {
  const [text, setText] = useState(initial);
  const ta = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    const t = ta.current;
    if (!t) return;
    t.focus();
    t.setSelectionRange(t.value.length, t.value.length);
  }, []);
  const save = () => {
    if (!busy && text.trim()) onSave(text);
  };
  return (
    <div className="ed-box" data-testid="chat-edit">
      <div className="ch-box">
        <textarea
          ref={ta}
          rows={2}
          aria-label="Edit your message"
          value={text}
          readOnly={busy}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            // The keys of the box are the box's: they never reach the message list around it.
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              e.stopPropagation();
              save();
            } else if (e.key === "Escape") {
              e.preventDefault();
              e.stopPropagation();
              onCancel();
            }
          }}
        />
        <div className="cr-tools">
          <span className="hint">
            <kbd>Enter</kbd> to save · <kbd>Esc</kbd> to cancel
          </span>
          <button type="button" className="btn sm" onClick={onCancel}>
            Cancel
          </button>
          <button type="button" className="btn pri sm" disabled={busy || !text.trim()} aria-busy={busy || undefined} onClick={save}>
            Save
          </button>
        </div>
      </div>
      {error && (
        <div className="err" role="alert">
          {error}
        </div>
      )}
    </div>
  );
}

/**
 * The confirmation before a message is deleted (#1269): an alert dialog that quotes it, says who loses it and that it cannot be undone.
 * Cancel has the focus first; Left, Right, Up and Down move between Cancel and Delete message; a refusal shows inside it.
 */
export function DeleteMessageDialog({ text, who, error, busy, onCancel, onDelete }: { text: string; who: string; error: string | null; busy: boolean; onCancel: () => void; onDelete: () => void }) {
  const cancel = useRef<HTMLButtonElement>(null);
  const del = useRef<HTMLButtonElement>(null);
  const arrows = (e: globalThis.KeyboardEvent): boolean => {
    if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(e.key)) return false;
    e.preventDefault();
    const acts = [cancel.current, del.current];
    acts[(Math.max(acts.indexOf(document.activeElement as HTMLButtonElement), 0) + 1) % acts.length]?.focus();
    return true;
  };
  return (
    <Modal titleId="del-h" title="Delete this message?" className="ed-confirm" role="alertdialog" describedBy="del-b" initialFocus={cancel} onKey={arrows} onClose={onCancel}>
      <div className="mb" id="del-b">
        <p className="ed-q">{text}</p>
        <p>{who} This cannot be undone.</p>
        {error && (
          <div className="err" role="alert">
            {error}
          </div>
        )}
        <div className="acts">
          <button type="button" className="btn" ref={cancel} onClick={onCancel}>
            Cancel
          </button>
          <button type="button" className="btn bad" ref={del} disabled={busy} aria-busy={busy || undefined} onClick={onDelete}>
            Delete message
          </button>
        </div>
      </div>
    </Modal>
  );
}

/** What the row needs to know about changing one of your own messages (#1269). */
interface OwnState {
  /** Its menu is open, or its delete confirmation: the row stays marked. */
  marked: boolean;
  /** Set while it is being edited. */
  editing: { error: string | null; busy: boolean } | null;
  onSave: (text: string) => void;
  onCancel: () => void;
  /** A right-click or a long press: opens the menu at the pointer; undefined when the message has none. */
  onContext?: (e: MouseEvent<HTMLElement>) => void;
}

function Message({
  m,
  all,
  me,
  now,
  paused,
  owner,
  across,
  heldBy,
  people,
  machineOf,
  sessions,
  cont,
  rove,
  onSender,
  own,
}: {
  m: ThreadMessage;
  all: ThreadMessage[];
  me: string;
  now: number;
  paused: boolean;
  owner: string;
  across: boolean;
  heldBy?: string;
  people: readonly string[];
  machineOf: (ref: string) => string | null;
  sessions: Record<string, SessionView>;
  cont: boolean;
  /** The roving tab stop and index of this message (one stop for the whole list, #1231). */
  rove: { tabIndex: number; "data-roving": number };
  /** Opens the menu of this message's sender at the pointer; undefined for your own. */
  onSender?: (at: MenuAt) => void;
  /** For one of your own messages: whether it is being edited or has a menu open, and what to do about it (#1269). */
  own?: OwnState;
}) {
  const c = m.channel;
  const d = m.direct;
  const mine = mineOf(m, me);
  const name = mine ? "You" : c ? c.authorName : d!.from.name;
  let re: string | null = null;
  if (c?.replyTo) {
    const target = all.find((x) => x.id === c.replyTo)?.channel;
    re = target
      ? target.mine
        ? "you"
        : target.authorName
      : "an earlier message";
  }
  const dl = c
    ? channelDelivery(c)
    : dmDelivery(d!, paused, owner, undefined, across, heldBy);
  const text = (c ?? d)!.text;
  const marks =
    c && !mine ? authorMarks(c, people, machineOf(c.authorRef)) : null;
  // The avatar: you are the inverted disc, another person a ring and a disc, an agent a tile in its model's color with its state.
  const isAgent =
    !mine && (c ? c.authorKind !== "person" : d!.from.kind === "agent");
  const ref = c ? c.authorRef : (d!.from.sessionId ?? "");
  const session = isAgent ? sessions[ref] : undefined;
  const avatar = isAgent ? (
    <ChatAvatar
      kind="agent"
      name={name}
      size={40}
      family={session?.modelFamily}
      state={agentState(sessions, ref, null, false)}
    />
  ) : (
    <ChatAvatar
      kind={mine ? "you" : "person"}
      name={mine ? me : name}
      size={40}
    />
  );
  const when = new Date(m.at).toLocaleString();
  const failed = dl.icon === "no";
  const body = bodyOf(m);
  const gone = !!body.deletedAt;
  const editing = own?.editing ?? null;
  return (
    <li
      className={`ch-msg${mine ? " mine" : ""}${cont ? " cont" : " first"}${re ? " reply" : ""}${own?.marked ? " menu-open sel" : ""}${editing ? " editing" : ""}`}
      data-testid="chat-message"
      aria-haspopup={own?.onContext ? "menu" : undefined}
      onContextMenu={own?.onContext}
      {...rove}
    >
      {cont ? (
        <span className="ch-gut" aria-hidden="true" title={when}>
          {hm(m.at)}
        </span>
      ) : (
        // A right-click on the avatar opens its sender's menu at the pointer. The keyboard reaches it from the message (Enter, the ContextMenu key, Shift+F10).
        <span
          className="ch-gut"
          onContextMenu={
            onSender
              ? (e) => {
                  e.preventDefault();
                  onSender({ x: e.clientX, y: e.clientY, from: e.currentTarget.closest("li") });
                }
              : undefined
          }
        >
          {avatar}
        </span>
      )}
      <div className="ch-col">
        {!cont && (
          <div className="ch-mh">
            <span className={`who${mine ? " me" : ""}`}>
              <bdi>{name}</bdi>
              {marks && (
                <>
                  {" "}
                  <span className="chip" title={AUTHOR_CHIP_TITLE}>
                    {marks.chip}
                  </span>
                  {marks.warns.map((w) => (
                    <span key={w.text}>
                      {" "}
                      <span className="chip warn" title={w.title}>
                        <ChWarn />
                        {w.text}
                      </span>
                    </span>
                  ))}
                </>
              )}
              {c?.authorOwner && !mine && (
                <span className="re">
                  {" "}
                  orchestrator of <bdi>{c.authorOwner}</bdi>
                </span>
              )}
              {re && (
                <span className="re">
                  {" "}
                  replying to <bdi>{re}</bdi>
                </span>
              )}
            </span>
            {session && (
              <ModelChip
                family={session.modelFamily}
                model={session.model}
                label={`Agent · ${familyName(session.modelFamily, session.model)}`}
              />
            )}
            <span className="at" title={when}>
              {stamp(m.at, now)}
            </span>
          </div>
        )}
        {cont && re && (
          <div className="ch-mh">
            <span className="who re">
              replying to <bdi>{re}</bdi>
            </span>
          </div>
        )}
        {gone ? (
          <div className="ed-del">
            <ChTrash />
            {tombstone(m, me)}
          </div>
        ) : editing ? (
          <Editor initial={text} error={editing.error} busy={editing.busy} onSave={own!.onSave} onCancel={own!.onCancel} />
        ) : (
          <div className="ch-tx">
            <Text text={text} />
            {body.editedAt ? (
              <span className="ed-edited" title={new Date(body.editedAt).toLocaleString()}>
                edited {hm(body.editedAt)}
              </span>
            ) : null}
          </div>
        )}
        {!gone && c && c.mentions.length > 0 && (
          <div className="ch-st">
            {c.mentions.map((x, i) => {
              const chip = mentionChip(x);
              return (
                <span
                  key={`${x.typed}${i}`}
                  className={`s${chip.kind === "done" ? " done" : chip.kind === "wait" ? " wait" : chip.kind === "bad" ? " bad" : ""}`}
                >
                  {chip.kind === "done" ? (
                    <StateIcon kind="done" />
                  ) : chip.kind === "run" ? (
                    <StateIcon kind="running" />
                  ) : chip.kind === "wait" ? (
                    <ChClock />
                  ) : (
                    <ChNo />
                  )}
                  <span>{chip.text}</span>
                </span>
              );
            })}
          </div>
        )}
        {!gone && (
        <div className="ch-st">
          <span
            className={`s ds${dl.wait ? " wait" : ""}${failed ? " bad" : ""}`}
          >
            <DeliveryGlyph icon={dl.icon} />
            <span>{dl.text}</span>
          </span>
        </div>
        )}
      </div>
    </li>
  );
}

export interface ThreadProps {
  sel: Selection;
  overview: ChatOverview;
  channel: ChatChannel | null;
  direct: DirectInfo | null;
  thread: ThreadRead;
  sessions: Record<string, SessionView>;
  now: number;
  /** Confirmations and errors, above the scroll area. */
  alert: ReactNode;
  /** The message box, under the feed. */
  composer: ReactNode;
  /** Moves to the newest message when it changes: the thread opened, or the person sent. */
  scrollToken: string;
  menu: string | null;
  /** Where the open menu hangs when it is a sender's (`t:` key); null for a row's own. */
  menuAt: MenuAt | null;
  onMenu: (key: string | null, by: "button" | "context", at?: MenuAt) => void;
  onClose: (restoreFocus: boolean) => void;
  onPick: (key: string, act: MenuAct) => void;
  onBack: () => void;
  /** Whether the members panel is open, and the way to open or close it (#1236). */
  members: boolean;
  onMembers: (open: boolean) => void;
  /** The person an Admin reads, or null. The thread is read only while it is set. */
  readAs: string | null;
  /** The server's clock now, for hiding a reading whose time has passed. */
  serverNow: number;
  /** Editing and deleting your own messages (#1269). */
  change: {
    /** The message being edited, with a refusal to show under its box and whether a save is out. */
    editing: { id: string; error: string | null; busy: boolean } | null;
    /** The message whose delete confirmation is open. */
    deleting: string | null;
    /** A request to put the focus back on a message (after an edit, a cancel or a delete); each has its own `n`. */
    focus: { id: string; n: number } | null;
    onEdit: (id: string) => void;
    onSave: (id: string, text: string) => void;
    onCancel: (id: string) => void;
    onDelete: (id: string) => void;
  };
}

export function ChatThread(p: ThreadProps) {
  const { overview: o, thread: t } = p;
  const body = useRef<HTMLDivElement>(null);
  const near = useRef(true);
  const grew = useRef<number | null>(null);
  const newest = t.messages[t.messages.length - 1]?.id ?? null;
  const oldest = t.messages[0]?.id ?? null;
  // The message list is one tab stop however long it is (#1231); Enter, the ContextMenu key or Shift+F10 on a message opens its sender's menu (#1235), or on
  // one of your own the menu of Edit message and Delete message (#1269).
  const section = useRef<HTMLElement>(null);
  const [said, setSaid] = useState("");
  // How the focus got to a message of yours. From the box's Up, a right-click or a menu, Up and Down visit your own messages only (#1269), the
  // way Teams and Slack do; reached with Tab or a click, they keep the list's own arrows and visit every message (#1231). Tab, a click or
  // a focus that comes from elsewhere ends it, so there is no way the list keeps a person in it or skips a message they came to read.
  const ownNav = useRef(false);
  const programmatic = useRef(false);
  const openOwnMenu = (i: number) => {
    const m = t.messages[i];
    if (!m) return;
    const item = body.current?.querySelector<HTMLElement>(`[data-roving="${i}"]`);
    const r = (item?.querySelector(".ch-tx") ?? item)?.getBoundingClientRect();
    if (r) p.onMenu(`m:${m.id}`, "button", { x: r.left + 16, y: r.bottom + 4, top: r.top, from: item ?? null });
  };
  const roving = useRovingList(
    t.messages.length,
    (i) => {
      const m = t.messages[i];
      if (m && mineOf(m, o.me.name)) return; // yours opens its own menu, from the keys below
      const sender = m && senderOf(m, o.me.name);
      if (!sender) return;
      const item = body.current?.querySelector<HTMLElement>(`[data-roving="${i}"]`);
      const r = (item?.querySelector(".ch-gut") ?? item)?.getBoundingClientRect();
      if (r) p.onMenu(`t:${sender.key}`, "button", { x: r.left, y: r.bottom, top: r.top, from: item ?? null });
    },
    {
      onKey: (e, i, onItem) => {
        const m = t.messages[i];
        if (!onItem || !m || !mineOf(m, o.me.name) || p.readAs !== null || e.altKey || e.metaKey || e.ctrlKey) return false;
        const k = e.key;
        const mine = t.messages.flatMap((x, n) => (mineOf(x, o.me.name) ? [n] : []));
        const here = mine.indexOf(i);
        if (ownNav.current && k === "Escape") {
          e.preventDefault();
          toBox();
          return true;
        }
        if (ownNav.current && (k === "ArrowUp" || k === "ArrowDown") && !e.shiftKey) {
          e.preventDefault();
          const next = mine[here + (k === "ArrowUp" ? -1 : 1)];
          if (next !== undefined) toMessageAt(next);
          else if (k === "ArrowDown") toBox();
          return true;
        }
        if (e.repeat) return false;
        const why = whyNot(m);
        if (k === "e" || k === "E") {
          e.preventDefault();
          if (why) setSaid(why);
          else p.change.onEdit(m.id);
          return true;
        }
        if (k === "Delete" || k === "Backspace") {
          e.preventDefault();
          if (why) setSaid(why);
          else p.change.onDelete(m.id);
          return true;
        }
        if ((k === "Enter" || k === "ContextMenu" || (k === "F10" && e.shiftKey)) && hasMenu(m, o.me.name)) {
          e.preventDefault();
          openOwnMenu(i);
          return true;
        }
        return false;
      },
    },
  );
  const lastNewest = useRef<string | null>(null);
  const lastOldest = useRef<string | null>(null);
  const lastToken = useRef<string | null>(null);
  // What a screen reader hears when a message of yours takes the focus: it, its state and the keys that work on it, or why none does.
  const saidOf = (m: ThreadMessage): string => {
    const b = bodyOf(m);
    const gone = !!b.deletedAt;
    const dl = m.channel ? channelDelivery(m.channel) : dmDelivery(m.direct!, t.head?.paused ?? p.direct?.paused ?? false, t.head?.owner ?? p.direct?.owner ?? o.me.name, undefined, (t.head?.cross ?? p.direct?.cross ?? null) !== null);
    const edited = !gone && b.editedAt ? ` (edited ${hm(b.editedAt)})` : "";
    return `Your message, ${hm(m.at)}: ${noPeriod(gone ? tombstone(m, o.me.name) : b.text.trim())}${edited}. ${gone ? "" : `${noPeriod(dl.text)}. `}${whyNot(m) || "Press E to edit or Delete to delete."}`;
  };
  // A message of yours takes the focus from the keyboard (the box's Up, Up and Down among them), and says what it is.
  const toMessageAt = (i: number) => {
    const m = t.messages[i];
    if (!m) return;
    ownNav.current = true;
    programmatic.current = true;
    roving.focusItem(i);
    programmatic.current = false;
    setSaid(saidOf(m));
  };
  const toBox = () => {
    ownNav.current = false;
    setSaid("");
    section.current?.querySelector<HTMLTextAreaElement>(".ch-composer textarea")?.focus();
  };
  const focusAsk = p.change.focus;
  useEffect(() => {
    if (!focusAsk) return;
    const i = t.messages.findIndex((x) => x.id === focusAsk.id);
    if (i >= 0) toMessageAt(i);
    // Each request has its own number.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusAsk?.n]);
  // Which thread this is, so what is remembered about one (its New line, what it announced) is not carried to another.
  const threadKey =
    p.channel?.thread ??
    p.direct?.thread ??
    (p.sel.kind === "channel" ? p.sel.id : `${p.sel.a}|${p.sel.b}`);
  // The New line: the first message that was unread when the thread opened. It is decided once, on the first read of the thread that
  // has loaded, because the thread is marked read right after and the overview's count then drops to zero.
  const newLine = useRef<{ key: string; id: string | null; decided: boolean }>({
    key: "",
    id: null,
    decided: false,
  });
  if (newLine.current.key !== threadKey)
    newLine.current = { key: threadKey, id: null, decided: false };
  if (!newLine.current.decided && t.loaded) {
    const unreadNow = p.channel
      ? p.channel.unread + p.channel.mentions
      : p.direct
        ? p.direct.unread + p.direct.mentions
        : 0;
    newLine.current.decided = true;
    newLine.current.id =
      unreadNow > 0 && unreadNow < t.messages.length
        ? (t.messages[t.messages.length - unreadNow]?.id ?? null)
        : null;
  }
  // The live region: a message that arrives while the thread is open is announced. The first read, the earlier pages a person asks for, a
  // message they sent and a record line are not, so the list says "off" for the commit that draws them and "polite" again right after.
  const sig = `${threadKey}|${t.loaded}|${t.messages.length}|${oldest}|${newest}|${t.reads.length}`;
  const seen = useRef<{
    sig: string;
    key: string;
    newest: string | null;
    loaded: boolean;
  } | null>(null);
  const [, settle] = useState(0);
  const was = seen.current;
  let announce = false;
  if (
    was &&
    was.key === threadKey &&
    was.loaded &&
    t.loaded &&
    was.newest !== null &&
    newest !== was.newest
  ) {
    const at = t.messages.findIndex((x) => x.id === was.newest);
    announce =
      at >= 0 && t.messages.slice(at + 1).some((x) => !mineOf(x, o.me.name));
  }
  // A commit that draws what is not announced holds the list "off" for a moment, so a render right behind it does not turn it back on early.
  const hold = useRef(false);
  const quiet = !announce && (hold.current || was?.sig !== sig);
  useEffect(() => {
    if (!quiet) return;
    hold.current = true;
    const id = setTimeout(() => {
      hold.current = false;
      settle((n) => n + 1);
    }, QUIET_MS);
    return () => clearTimeout(id);
  }, [quiet, sig]);
  useLayoutEffect(() => {
    seen.current = { sig, key: threadKey, newest, loaded: t.loaded };
  });

  useLayoutEffect(() => {
    const el = body.current;
    if (!el) return;
    if (lastToken.current !== p.scrollToken && t.loaded) {
      // Opened, or sent: the newest message is in view.
      lastToken.current = p.scrollToken;
      el.scrollTop = el.scrollHeight;
    } else if (grew.current !== null && oldest !== lastOldest.current) {
      // Earlier messages came in above: stay on what was being read.
      el.scrollTop += el.scrollHeight - grew.current;
    } else if (newest !== lastNewest.current && near.current) {
      el.scrollTop = el.scrollHeight;
    }
    grew.current = null;
    lastNewest.current = newest;
    lastOldest.current = oldest;
  });

  const unreadable = t.error?.status === 403 && p.sel.kind === "dm";
  const dmHead = t.head;
  const fresh =
    p.sel.kind === "dm"
      ? o.agents.find((x) => x.sessionId === (p.sel as { b: string }).b)?.name
      : undefined;
  const title = p.channel
    ? p.channel.name
    : p.direct
      ? dmName(p.direct)
      : dmHead?.a && dmHead.b
        ? dmName({ a: dmHead.a, b: dmHead.b, cross: dmHead.cross })
        : (fresh ?? "Direct message");
  const back = (
    <button type="button" className="btn sm ch-back" onClick={p.onBack}>
      Back to the list
    </button>
  );

  if (unreadable) {
    return (
      <section className="ch-thread" aria-labelledby="th-h">
        {back}
        <div className="ch-head">
          <h2 id="th-h">Direct message</h2>
        </div>
        <div className="ch-blank" data-testid="chat-unreadable">
          <b>
            Only the person who owns this conversation and an Admin can read it.
          </b>
          <p className="hint">
            Messages can hold source code and paths, so the text is not open to
            everyone who can see the console. {t.error?.text}
          </p>
        </div>
      </section>
    );
  }

  const parties: Party[] = p.direct
    ? [p.direct.a, p.direct.b]
    : dmHead?.a && dmHead.b
      ? [dmHead.a, dmHead.b]
      : [];
  const agents = parties.filter((x) => x.kind === "agent");
  const cross = (p.direct?.cross ?? dmHead?.cross) || null;
  // General and a public channel are readable by everyone, so an Admin reading someone's conversations has nothing to be told about in them (#1035).
  const publicChannel = p.sel.kind === "channel" && p.sel.id !== "group";
  const ro = p.readAs !== null && !publicChannel;
  const ownerName = dmHead?.owner ?? p.direct?.owner ?? p.readAs ?? o.me.name;
  const machines = [...new Set(agents.map((x) => x.machine))];
  const tag = p.channel
    ? channelTag(p.channel)
    : p.direct
      ? dmTag(p.direct)
      : null;
  const scope = ro
    ? cross && agents[0]
      ? `Only ${cross.person}, ${cross.owner} and an Admin can read this.`
      : p.sel.kind === "channel"
        ? `Only ${p.readAs} and ${p.readAs}'s own orchestrators, subagents and forks can post here. You are reading it as an Admin.`
        : `Only ${ownerName} and an Admin can read this.`
    : cross && agents[0]
      ? crossLine(cross, agents[0].name)
      : p.sel.kind === "channel"
        ? p.sel.id === "general"
          ? "Everyone signed in to this server can read and post here."
          : p.sel.id !== "group"
            ? "Every person and Admin signed in to this server can read and post here. An orchestrator reads or posts here only when an @ called it in during the last hour, and sees at most that hour. A subagent does not post here; its orchestrator does."
            : "Only you and your own orchestrators, subagents and forks can read and post here."
        : "Only you and an Admin can read this. The two agents and you are the only ones in it. It is removed when every agent session in it has ended.";
  const trips = dmHead?.roundTrips ?? p.direct?.roundTrips;
  const total = t.total;
  const sub =
    p.sel.kind === "channel"
      ? p.sel.id === "general"
        ? "Everyone signed in to this server"
        : p.sel.id !== "group"
          ? p.channel?.openedBy
            ? `Opened by ${p.channel.openedBy}`
            : null
          : ro
            ? `${p.readAs}'s own orchestrators and subagents`
            : `You and your ${plural(o.agents.length, "orchestrator")} and subagents`
      : machines.join(" and ");
  // What an Admin did or is doing here: the people in the thread are told, and an Admin's pause shows to all.
  const readers = ro
    ? []
    : liveReaders(
        p.channel?.adminReading ?? p.direct?.adminReading,
        p.serverNow,
      );
  const pause = p.channel
    ? p.channel.id === "group" && p.channel.paused
      ? adminPauseOf({ paused: true, pausedByAdmin: p.channel.pausedByAdmin })
      : null
    : adminPauseOf({
        ...(p.direct ?? {}),
        ...(dmHead
          ? {
              paused: dmHead.paused || p.direct?.paused,
              pausedBy: dmHead.pausedBy ?? p.direct?.pausedBy,
              pausedByAdmin: dmHead.pausedByAdmin ?? p.direct?.pausedByAdmin,
            }
          : {}),
        cross: dmHead?.cross ?? p.direct?.cross ?? null,
      });
  const also = cross
    ? cross.viewerIs === "sender"
      ? cross.owner
      : cross.person
    : null;
  // Where an author runs: the overview's agent when it lists it, else the console's session; null when neither does (an ended session).
  const machineOf = (ref: string): string | null =>
    o.agents.find((x) => x.sessionId === ref)?.machine ??
    p.sessions[ref]?.machine?.name ??
    null;
  // Who is in the conversation, for the introduction a thread with no messages shows; the viewer, or the person an Admin reads as, is always one of them.
  const introWho = [
    ...new Set([
      ro ? ownerName : o.me.name,
      ...(p.sel.kind === "dm"
        ? parties.map((x) => x.name)
        : p.sel.id === "group"
          ? o.agents.slice(0, 3).map((x) => x.name)
          : []),
    ]),
  ];
  const rows = rowsOf(
    recordsAmong(t.messages, t.reads, t.older !== null),
    newLine.current.id,
  );
  const conts = continuesRun(
    rows.map((r) =>
      r.k === "msg"
        ? { author: authorKey(r.m), at: r.m.at }
        : { author: null, at: 0 },
    ),
  );

  // The menu on a sender's avatar (#1235): Message everywhere, Mention where a channel is open, and nothing that sends while an Admin reads.
  const senderOpts = { mention: p.sel.kind === "channel" && !ro, reading: ro };
  const specOf = (s: Sender): MenuSpec => (s.person ? personMenu(s.name, senderOpts) : agentMenu(s.name, s.ref, agentState(p.sessions, s.ref, null, false), true, senderOpts));
  const openKey = p.menu?.startsWith("t:") ? p.menu.slice(2) : null;
  const openSender = openKey ? (t.messages.map((m) => senderOf(m, o.me.name)).find((s) => s?.key === openKey) ?? null) : null;
  // The index of each message among the messages (a record, a day divider and the New line are not in the list's order).
  let at = 0;
  const msgAt = rows.map((r) => (r.k === "msg" ? at++ : -1));

  // Who is in the thread (#1236): My group and a channel get an avatar stack and a panel; a Direct Message has two parties and neither.
  const list =
    p.sel.kind === "channel"
      ? membersOf(o, p.sessions, {
          group: p.sel.id === "group",
          person: ro ? p.readAs : o.me.person ? o.me.name : null,
        })
      : null;
  // A Direct Message names its parties with their avatars before the title: the two agents overlapped, a person and the agent, or one agent.
  const dmAvatar =
    p.sel.kind === "dm" && parties.length > 0 ? (
      cross && agents[0] ? (
        <ChatAvatarPair a={{ kind: "person", name: cross.person }} b={{ kind: "agent", name: agents[0].name }} />
      ) : agents.length === 2 ? (
        <ChatAvatarPair a={{ kind: "agent", name: agents[0]!.name }} b={{ kind: "agent", name: agents[1]!.name }} />
      ) : agents[0] ? (
        <ChatAvatar kind="agent" name={agents[0].name} size={28} family={p.sessions[agents[0].sessionId]?.modelFamily} state={agentState(p.sessions, agents[0].sessionId, agents[0].status, agents[0].live)} />
      ) : null
    ) : null;

  // Up in an empty message box, with no @ or / list open to take it, moves to your latest message (#1269).
  const fromBox = (e: KeyboardEvent<HTMLElement>) => {
    const box = e.target;
    if (e.key !== "ArrowUp" || e.defaultPrevented || e.shiftKey || e.altKey || e.metaKey || e.ctrlKey || e.nativeEvent.isComposing) return;
    if (!(box instanceof HTMLTextAreaElement) || !box.closest(".ch-composer") || box.value !== "" || p.readAs !== null) return;
    const last = t.messages.reduce((at, x, n) => (mineOf(x, o.me.name) ? n : at), -1);
    if (last < 0) return;
    e.preventDefault();
    toMessageAt(last);
  };
  const onListFocus = (e: FocusEvent<HTMLElement>) => {
    roving.listProps.onFocus(e);
    const from = e.relatedTarget;
    if (!programmatic.current && from instanceof Element && !e.currentTarget.contains(from) && !from.closest(".ch-menu")) ownNav.current = false;
  };
  const openKey2 = p.menu?.startsWith("m:") ? p.menu.slice(2) : null;
  const openOwn = openKey2 ? (t.messages.find((m) => m.id === openKey2) ?? null) : null;
  const ownOf = (m: ThreadMessage, mineRow: boolean): OwnState | undefined =>
    mineRow && p.readAs === null
      ? {
          marked: p.menu === `m:${m.id}` || p.change.deleting === m.id,
          editing: p.change.editing?.id === m.id ? p.change.editing : null,
          onSave: (text) => p.change.onSave(m.id, text),
          onCancel: () => p.change.onCancel(m.id),
          onContext: hasMenu(m, o.me.name) && p.change.editing?.id !== m.id
            ? (e) => {
                e.preventDefault();
                ownNav.current = true;
                p.onMenu(`m:${m.id}`, "context", { x: e.clientX, y: e.clientY, from: e.currentTarget });
              }
            : undefined,
        }
      : undefined;

  return (
    <>
    <section
      className="ch-thread"
      aria-labelledby="th-h"
      data-testid="chat-thread"
      ref={section}
      onKeyDown={fromBox}
    >
      {back}
      <div className="ch-head">
        <div className="ch-head-top">
          <h2 id="th-h" tabIndex={-1}>
            {dmAvatar}
            <span className="nm">
              <bdi>{title}</bdi>
            </span>
            {p.channel?.link && (
              <span className="ch-link" data-testid="chat-link-chip">
                <ChLink />
                {linkWords(p.channel.link)}
              </span>
            )}
          </h2>
          {list && <ChatMembersStack members={list.members} open={p.members} controls="ch-members" onToggle={() => p.onMembers(!p.members)} />}
        </div>
        <div className="sub">
          {sub && <span>{sub}</span>}
          <span>{plural(total, "message")}</span>
          {tag && (
            <span className={`tag${tag.warn ? " warn" : ""}`}>
              <TagGlyph icon={tag.icon} /> {tag.text}
            </span>
          )}
          <AdminTags readers={readers} pause={pause} />
        </div>
        {p.channel?.kind === "public" && p.channel.description && (
          <div className="ch-desc" data-testid="chat-desc">
            {p.channel.description}
          </div>
        )}
        <div className="sub">
          <span>{scope}</span>
        </div>
        {p.sel.kind === "dm" &&
          trips &&
          trips.cap > 0 &&
          agents.length === 2 && (
            <div className="sub">
              <span>
                Agents addressing each other: {trips.used} of {trips.cap} round
                trips. At {trips.cap},{" "}
                {dmHead?.owner ?? p.direct?.owner ?? "its owner"} approves the
                next one, so agents cannot keep going on their own.
              </span>
            </div>
          )}
      </div>
      {ro && (
        <ReadOnlyBanner
          owner={cross ? cross.owner : ownerName}
          also={cross ? cross.person : null}
        />
      )}
      <ReadingBanner readers={readers} also={also} now={p.now} />
      {pause && (
        <AdminPauseBanner
          name={pause.name}
          group={p.sel.kind === "channel"}
          you={
            ro &&
            pause.name !== null &&
            pause.name.toLowerCase() === (o.me.actor ?? o.me.name).toLowerCase()
          }
        />
      )}
      <div className="ch-alert">{p.alert}</div>
      <div
        className="ch-body"
        ref={body}
        role="region"
        tabIndex={0} /* NOSONAR S6845: a focusable scroll region, by design */
        aria-label="Messages, oldest first"
        onScroll={(e) => {
          const el = e.currentTarget;
          near.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
        }}
      >
        {t.error && !unreadable && (
          <div className="errbox" role="alert">
            Could not load the messages: {t.error.text}.{" "}
            {t.messages.length ? "The ones below may be out of date. " : ""}It
            reads again when something changes.
          </div>
        )}
        {!t.loaded ? (
          <div className="hint">Loading…</div>
        ) : (
          <div className="ch-flow">
            <div className="ch-earlier">
              <span role="status">
                Showing {t.messages.length} of {total}
              </span>
              {t.older && (
                <button
                  type="button"
                  className="btn sm"
                  disabled={t.loadingEarlier}
                  onClick={() => {
                    grew.current = body.current?.scrollHeight ?? null;
                    void t.loadEarlier();
                  }}
                >
                  Earlier messages
                </button>
              )}
            </div>
            <div
              role="log"
              aria-label="Messages"
              aria-live={quiet ? "off" : "polite"}
              aria-relevant="additions"
              aria-atomic="false"
            >
              <ol className="ch-msgs" {...roving.listProps} onFocus={onListFocus} onMouseDown={() => void (ownNav.current = false)}>
                {rows.map((r, i) =>
                  r.k === "rec" ? (
                    <RecordLine
                      key={`rec-${r.rec.admin}-${r.rec.startedAt}-${r.rec.kind ?? "read"}`}
                      r={r.rec}
                    />
                  ) : r.k === "day" ? (
                    <li key={`day-${r.at}`} className="ch-day">
                      <span>{dayLabel(r.at, p.now)}</span>
                    </li>
                  ) : r.k === "new" ? (
                    <li key="new" className="ch-newline">
                      <span>New</span>
                    </li>
                  ) : (
                    <Message
                      key={r.m.id}
                      m={r.m}
                      all={t.messages}
                      cont={conts[i]!}
                      rove={roving.itemProps(msgAt[i]!)}
                      own={ownOf(r.m, mineOf(r.m, o.me.name))}
                      onSender={
                        senderOf(r.m, o.me.name)
                          ? (pos) => p.onMenu(`t:${senderOf(r.m, o.me.name)!.key}`, "context", pos)
                          : undefined
                      }
                      sessions={p.sessions}
                      people={o.people.map((x) => x.name)}
                      machineOf={machineOf}
                      me={o.me.name}
                      now={p.now}
                      across={cross !== null}
                      heldBy={pause ? adminWho(pause.name) : undefined}
                      paused={dmHead?.paused ?? p.direct?.paused ?? false}
                      owner={dmHead?.owner ?? p.direct?.owner ?? o.me.name}
                    />
                  ),
                )}
              </ol>
            </div>
            {t.messages.length === 0 && (
              <div className="ch-intro" data-testid="chat-intro">
                <div className="ch-intro-av" aria-hidden="true">
                  {introWho.map((n) => (
                    <Monogram key={n} name={n} size="lg" />
                  ))}
                </div>
                <h3>
                  This is the start of <bdi>{title}</bdi>
                </h3>
                <p>
                  {sub && p.sel.kind === "channel" ? `${sub}.` : scope}
                  {p.sel.kind === "channel" && !ro
                    ? " Say something, or type @ to hand work to an agent."
                    : ""}
                </p>
              </div>
            )}
          </div>
        )}
      </div>
      {p.composer}
      {openSender && <ChatMenu spec={specOf(openSender)} at={p.menuAt ?? undefined} onPick={(act) => p.onPick(p.menu!, act)} onClose={p.onClose} />}
      {openOwn && <ChatMenu key={openOwn.id} spec={messageMenu(bodyOf(openOwn))} at={p.menuAt ?? undefined} onPick={(act) => p.onPick(p.menu!, act)} onClose={p.onClose} onBlocked={() => setSaid(whyNot(openOwn))} closeOnScroll />}
      <span className="vh" role="status" aria-live="polite" data-testid="chat-msg-said">
        {said}
      </span>
    </section>
    {list && p.members && (
      <ChatMembersPanel
        key={threadKey}
        id="ch-members"
        label={title}
        members={list.members}
        partial={list.partial}
        menu={p.menu}
        mention={senderOpts.mention}
        reading={ro}
        onMenu={p.onMenu}
        onMenuClose={p.onClose}
        onPick={p.onPick}
        onClose={() => p.onMembers(false)}
      />
    )}
    </>
  );
}
