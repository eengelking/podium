// The limits on orchestrator messaging (#347, #416, SPEC 7.7, mockup/podium-peer-messages.html section 1): one number box per
// limit, in the row Admin > Settings draws a setting with (.srow, .setname, a labelled .field.daysbox). Admin > Settings shows
// all four with the server's ranges; an owner's stricter limits on My reporters (#436) show the three link limits, each at
// most the Admin's value, with a state line and a "Use the Admin's limit" button. A box saves when it loses focus or on
// Enter. A refused value stays in the box, with the reason in the row (`p.err`, as Forget old reporters does), and nothing is
// saved. What counts as valid and what is sent can be changed by the page, so the owner's rules live with the owner's page.
import { useEffect, useRef, useState, type KeyboardEvent } from "react";

export type PeerLimitKey = "roundTrips" | "perMinute" | "maxChars" | "retainDays";

/** The whole numbers each limit takes. Keep in step with `PEER_RANGES` in server/src/fleet/peerSettings.ts (a test checks). */
export const PEER_LIMIT_RANGES: Record<PeerLimitKey, { min: number; max: number }> = {
  roundTrips: { min: 1, max: 100 },
  perMinute: { min: 1, max: 60 },
  maxChars: { min: 1, max: 20_000 },
  retainDays: { min: 1, max: 365 },
};

/** The server's defaults, as `PEER_DEFAULTS` there. */
export const PEER_LIMIT_DEFAULTS: Record<PeerLimitKey, number> = { roundTrips: 10, perMinute: 6, maxChars: 20_000, retainDays: 30 };

/** The words an error names a limit by, as the server's refusal does. */
export const PEER_LIMIT_NAMES: Record<PeerLimitKey, string> = {
  roundTrips: "Round trips",
  perMinute: "Messages per minute",
  maxChars: "Longest message",
  retainDays: "Keep conversations",
};

/** One limit's error, or null: the server's `peerSettingError`, word for word. `max` is lower for an owner (the Admin's value). */
export function peerLimitError(key: PeerLimitKey, v: unknown, max = PEER_LIMIT_RANGES[key].max): string | null {
  const { min } = PEER_LIMIT_RANGES[key];
  if (typeof v !== "number" || !Number.isInteger(v) || v < min || v > max) return `${PEER_LIMIT_NAMES[key]} must be a whole number from ${min} to ${max}`;
  return null;
}

/** What a value that was not saved leaves in place. */
export function stillApplies(saved: number | null | undefined): string {
  return saved === null || saved === undefined ? "Nothing was saved." : `Nothing was saved. The saved value, ${saved}, still applies.`;
}

const sentence = (s: string) => `${s.charAt(0).toUpperCase()}${s.slice(1)}`;

/** The Admin's check: the server's range and words, then that nothing was saved and what still applies. */
export function adminLimitCheck(key: PeerLimitKey, text: string, max: number, saved: number | null | undefined): string | null {
  const t = text.trim();
  const why = peerLimitError(key, t === "" ? Number.NaN : Number(t), max);
  return why ? `${why}. ${stillApplies(saved)}` : null;
}

/** One limit's box: which limit, its label and the line under it. */
export interface PeerLimitField {
  key: PeerLimitKey;
  label: string;
  hint: string;
}

/** The Admin's words for each limit (Admin > Settings). Another page passes its own. */
export const PEER_LIMIT_FIELDS: Record<PeerLimitKey, PeerLimitField> = {
  roundTrips: {
    key: "roundTrips",
    label: "Round trips before a person approves",
    hint: "After this many exchanges on one link, the next message waits for its owner. Two orchestrators cannot answer each other without end.",
  },
  perMinute: { key: "perMinute", label: "Messages per minute on a link", hint: "More than this is refused, and the sender is told to wait." },
  maxChars: {
    key: "maxChars",
    label: "Longest message, in characters",
    hint: "A longer message is refused, and the sender is told the limit, so it can send a path instead of a file.",
  },
  retainDays: {
    key: "retainDays",
    label: "Keep conversations, in days",
    hint: "A conversation is deleted this long after its last message, or with its sessions. Each message is also written to the Admin log, without its text.",
  },
};

/** The four the Admin sets, in the order Admin > Settings shows them. */
export const ADMIN_LIMIT_FIELDS: readonly PeerLimitField[] = [PEER_LIMIT_FIELDS.roundTrips, PEER_LIMIT_FIELDS.perMinute, PEER_LIMIT_FIELDS.maxChars, PEER_LIMIT_FIELDS.retainDays];

/** A button beside a limit's state line, such as an owner's "Use the Admin's limit". */
export interface PeerLimitAction {
  label: string;
  /** The button's accessible name, when the label alone does not say which limit. */
  ariaLabel?: string;
  /** Focus goes to the limit's box afterwards, since the button may go away. */
  onClick: () => void;
}

export interface PeerLimitsProps {
  /** Starts every element id (`<idPrefix>-<key>`, its `-s` state line and `-e` error), so two lists on one page stay apart. */
  idPrefix: string;
  /** The limits to show, in order, with their words. */
  fields: readonly PeerLimitField[];
  /** The value each box shows when nothing is typed: the saved one, or for an owner the one that applies. Null while loading. */
  values: Partial<Record<PeerLimitKey, number>> | null;
  /** The most each limit can be, when lower than its range: an owner's limit stops at the Admin's value. */
  max?: Partial<Record<PeerLimitKey, number>>;
  /** A line under a limit's name, such as "Uses the Admin's limit, 10."; the box is described by it. */
  state?: Partial<Record<PeerLimitKey, string>>;
  /** A button beside the state line. */
  action?: Partial<Record<PeerLimitKey, PeerLimitAction>>;
  /** Checks what was typed: the whole error sentence, or null. Defaults to `adminLimitCheck`. */
  check?: (key: PeerLimitKey, text: string, max: number, saved: number | undefined) => string | null;
  /** What a valid number is saved as. An owner sends null for exactly the Admin's value ("use the Admin's"). Defaults to the number. */
  toValue?: (key: PeerLimitKey, n: number) => number | null;
  /** Saves one value. Resolves to null once saved, or to the server's refusal in words; the page then passes the new `values`. */
  onSave: (key: PeerLimitKey, value: number | null) => Promise<string | null>;
  /** The sentence for a refusal from the server. Defaults to the refusal, then `stillApplies`. */
  refused?: (key: PeerLimitKey, error: string, saved: number | undefined) => string;
  disabled?: boolean;
}

/** Every limit in `fields`, one settings row each. */
export function PeerLimits(props: PeerLimitsProps) {
  const check = props.check ?? adminLimitCheck;
  const refused = props.refused ?? ((_k: PeerLimitKey, e: string, saved: number | undefined) => `${sentence(e)}. ${stillApplies(saved)}`);
  return (
    <>
      {props.fields.map((f) => {
        const k = f.key;
        const max = Math.min(props.max?.[k] ?? PEER_LIMIT_RANGES[k].max, PEER_LIMIT_RANGES[k].max);
        const saved = props.values?.[k];
        return (
          <PeerLimitRow
            key={k}
            id={`${props.idPrefix}-${k}`}
            field={f}
            saved={saved}
            max={max}
            state={props.state?.[k]}
            action={props.action?.[k]}
            disabled={props.disabled || props.values === null}
            check={(text) => check(k, text, max, saved)}
            onSave={async (n) => {
              const out = await props.onSave(k, props.toValue ? props.toValue(k, n) : n);
              return out === null ? null : refused(k, out, saved);
            }}
          />
        );
      })}
    </>
  );
}

const show = (v: number | undefined) => (v === undefined ? "" : String(v));

/** One limit: a label, its line, a state line and button when given, and the error in the row; the box on the right. */
function PeerLimitRow(props: {
  id: string;
  field: PeerLimitField;
  saved: number | undefined;
  max: number;
  state?: string;
  action?: PeerLimitAction;
  disabled?: boolean;
  check: (text: string) => string | null;
  onSave: (n: number) => Promise<string | null>;
}) {
  const { id, field, saved, state, action } = props;
  const [text, setText] = useState(show(saved));
  const [err, setErr] = useState("");
  const box = useRef<HTMLInputElement>(null);
  // What this box last sent, so Enter and then leaving the box save once.
  const sent = useRef<string | null>(null);
  // What the server last refused, and why, so leaving the box after Enter does not send the same value again.
  const refused = useRef<{ text: string; err: string } | null>(null);
  // A newly saved value (this box's or another browser's) replaces what is typed.
  useEffect(() => {
    setText(show(saved));
    setErr("");
    sent.current = null;
    refused.current = null;
  }, [saved]);
  const commit = async () => {
    const why = props.check(text);
    if (why) return setErr(why);
    if (refused.current?.text === text) return setErr(refused.current.err);
    setErr("");
    if (text.trim() === show(saved) || text === sent.current) return;
    sent.current = text;
    const no = await props.onSave(Number(text.trim()));
    if (no) {
      sent.current = null;
      refused.current = { text, err: no };
      setErr(no);
    }
  };
  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key !== "Enter") return;
    e.preventDefault();
    // Enter is a deliberate try, so it sends a value the server refused before; leaving the box does not.
    refused.current = null;
    void commit();
  };
  const stateId = `${id}-s`;
  const errId = `${id}-e`;
  const described = [state ? stateId : "", err ? errId : ""].filter(Boolean).join(" ");
  return (
    <div className="srow">
      <div className="setname">
        <label htmlFor={id}>
          <b>{field.label}</b>
        </label>
        <p className="hint ink2">{field.hint}</p>
        {(state || action) && (
          <div className="row2">
            {state && (
              <span className="hint" id={stateId}>
                {state}
              </span>
            )}
            {action && (
              <button
                type="button"
                className="btn sm"
                aria-label={action.ariaLabel}
                onClick={() => {
                  action.onClick();
                  box.current?.focus();
                }}
              >
                {action.label}
              </button>
            )}
          </div>
        )}
        {err && (
          <p className="err" role="alert" id={errId}>
            {err}
          </p>
        )}
      </div>
      <input
        ref={box}
        className="field mono daysbox"
        id={id}
        type="number"
        min={PEER_LIMIT_RANGES[field.key].min}
        max={props.max}
        step={1}
        value={text}
        disabled={props.disabled}
        aria-invalid={err ? true : undefined}
        aria-describedby={described || undefined}
        onChange={(e) => setText(e.target.value)}
        onBlur={() => void commit()}
        onKeyDown={onKey}
      />
    </div>
  );
}
