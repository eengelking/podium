import type { ReactNode } from "react";

// A small markdown renderer for an agent's task prompt and final answer (issue #97). It builds React
// elements and never an HTML string, so raw HTML in the text is shown as text and nothing is injected
// (SPEC 7.7). Supported: headings, ordered and unordered lists, block quotes, fenced code, paragraphs,
// and inline code, bold, italic and links. Lists are flat; anything else shows as plain text.

const SAFE_HREF = /^(https?:\/\/|mailto:)/i;

// code span | bold | italic (* or _). Each run is a negated class that cannot cross its own closing marker,
// so a greedy match never needs to backtrack (#362). Links are found by findLink below.
const INLINE = /`([^`\n]+)`|\*\*([^*\n]+)\*\*|__([^_\n]+)__|\*([^\s*][^*\n]*)\*|(?<![A-Za-z0-9])_([^\s_][^_\n]*)_(?![A-Za-z0-9])/g;

type Link = { at: number; len: number; text: string; url: string };

// Finds links, `[text](url)`, in one left-to-right pass. The text runs to the first `]` and may not hold a
// newline; the URL is a run of non-space, non-parenthesis characters and balanced `(...)` groups (one level,
// #274). A regex for this backtracked quadratically on a long run of `[`, since every `[` rescans to the same
// `]`, so this scans by hand: one `]` is tried once, and the URL run end is worked out once per string (#362).
function linkFinder(src: string): (from: number) => Link | null {
  if (!src.includes("](")) return () => null;
  const n = src.length;
  let close = -1; // the nearest `]` found so far
  let newline = -1; // the nearest `\n` found so far
  let runEnd: Int32Array | null = null;

  // runEnd[i] is where the URL run that starts at i ends: it stops at a space, a `)`, or a `(` with no group.
  const urlRuns = (): Int32Array => {
    const end = new Int32Array(n + 1);
    const stop = new Int32Array(n + 1); // the nearest space or parenthesis at or after i
    end[n] = n;
    stop[n] = n;
    for (let i = n - 1; i >= 0; i--) {
      const ch = src[i]!;
      const isStop = ch === "(" || ch === ")" || /\s/.test(ch);
      stop[i] = isStop ? i : stop[i + 1]!;
      if (ch === "(") {
        const g = stop[i + 1]!;
        end[i] = g < n && src[g] === ")" ? end[g + 1]! : i;
      } else {
        end[i] = isStop ? i : end[i + 1]!;
      }
    }
    return end;
  };

  return (from) => {
    let i = src.indexOf("[", from);
    while (i !== -1) {
      if (close <= i) close = src.indexOf("]", i + 1);
      if (close === -1) return null;
      if (newline <= i) {
        const nl = src.indexOf("\n", i + 1);
        newline = nl === -1 ? Infinity : nl;
      }
      if (close > i + 1 && newline > close && src[close + 1] === "(") {
        runEnd ??= urlRuns();
        const start = close + 2;
        const end = runEnd[start]!;
        if (end > start && src[end] === ")") {
          return { at: i, len: end + 1 - i, text: src.slice(i + 1, close), url: src.slice(start, end) };
        }
        // Every `[` before this `]` fails the same way; go on from it.
        i = src.indexOf("[", close);
      } else {
        i = src.indexOf("[", i + 1);
      }
    }
    return null;
  };
}

function inline(src: string, keyBase: string): ReactNode[] {
  const out: ReactNode[] = [];
  const re = new RegExp(INLINE);
  const findLink = linkFinder(src);
  const nextMark = (from: number) => {
    re.lastIndex = from;
    return re.exec(src);
  };
  let last = 0;
  let n = 0;
  // The next mark and the next link, each kept until a match before it has consumed past its start.
  let mark = nextMark(0);
  let link = findLink(0);
  for (;;) {
    if (mark && mark.index < last) mark = nextMark(last);
    if (link && link.at < last) link = findLink(last);
    if (!mark && !link) break;
    const key = `${keyBase}-${n++}`;
    if (mark && (!link || mark.index < link.at)) {
      const m = mark;
      if (m.index > last) out.push(src.slice(last, m.index));
      if (m[1] !== undefined) out.push(<code key={key}>{m[1]}</code>);
      else if (m[2] !== undefined || m[3] !== undefined) out.push(<strong key={key}>{inline((m[2] ?? m[3])!, key)}</strong>);
      else out.push(<em key={key}>{inline((m[4] ?? m[5])!, key)}</em>);
      last = m.index + m[0].length;
    } else if (link) {
      if (link.at > last) out.push(src.slice(last, link.at));
      if (SAFE_HREF.test(link.url)) {
        out.push(
          <a key={key} href={link.url} target="_blank" rel="noopener noreferrer">
            {inline(link.text, key)}
          </a>,
        );
      } else {
        out.push(link.text);
      }
      last = link.at + link.len;
    }
  }
  if (last < src.length) out.push(src.slice(last));
  return out;
}

// What follows a heading or list marker on a line: at least one space, then the text. Undefined when the
// marker is not followed by whitespace, or when the text holds U+2028 or U+2029 (the old line regexes used
// `.`, which stops at those, so such a line was never a heading or an item).
function afterMarker(line: string, from: number): string | undefined {
  const tail = line.slice(from);
  const rest = tail.trimStart();
  if (rest.length === tail.length) return undefined;
  if (rest.includes(" ") || rest.includes(" ")) return undefined;
  return rest;
}

// `#` to `######`, a space, then the text.
function headingOf(line: string): { level: number; text: string } | undefined {
  let level = 0;
  while (level < 7 && line[level] === "#") level++;
  if (level > 6) return undefined;
  if (level === 0) return undefined;
  const text = afterMarker(line, level);
  return text === undefined ? undefined : { level, text: text.trim() };
}

// Digits, `.` or `)`, a space, then the text; may be indented.
function orderedItemOf(line: string): string | undefined {
  const s = line.trimStart();
  let i = 0;
  while (i < s.length && s.charCodeAt(i) >= 48 && s.charCodeAt(i) <= 57) i++;
  if (i === 0 || (s[i] !== "." && s[i] !== ")")) return undefined;
  return afterMarker(s, i + 1);
}

// `-`, `*` or `+`, a space, then the text; may be indented.
function bulletItemOf(line: string): string | undefined {
  const s = line.trimStart();
  return s[0] === "-" || s[0] === "*" || s[0] === "+" ? afterMarker(s, 1) : undefined;
}

export function Markdown({ source }: { source: string }) {
  const blocks: ReactNode[] = [];
  let para: string[] = [];
  let list: { ordered: boolean; items: string[] } | null = null;
  let quote: string[] = [];
  let fence: string[] | null = null;
  let fenceLen = 0;
  let k = 0;

  const flushPara = () => {
    if (para.length) blocks.push(<p key={k++}>{inline(para.join(" "), `p${k}`)}</p>);
    para = [];
  };
  const flushList = () => {
    if (list) {
      const id = k++;
      const items = list.items.map((t, i) => <li key={i}>{inline(t, `l${id}-${i}`)}</li>);
      blocks.push(list.ordered ? <ol key={id}>{items}</ol> : <ul key={id}>{items}</ul>);
    }
    list = null;
  };
  const flushQuote = () => {
    if (quote.length) blocks.push(<blockquote key={k++}>{inline(quote.join(" "), `q${k}`)}</blockquote>);
    quote = [];
  };
  const flushFence = () => {
    if (fence) {
      blocks.push(
        <pre key={k++}>
          <code>{fence.join("\n")}</code>
        </pre>,
      );
    }
    fence = null;
  };
  const flushText = () => {
    flushPara();
    flushList();
    flushQuote();
  };

  for (const line of source.replace(/\r\n?/g, "\n").split("\n")) {
    if (fence !== null) {
      // A fence closes only on backticks alone on the line, at least as many as opened it (#274).
      const close = /^\s*(`{3,})\s*$/.exec(line);
      if (close && close[1]!.length >= fenceLen) flushFence();
      else fence.push(line);
      continue;
    }
    const open = /^\s*(`{3,})/.exec(line);
    if (open) {
      flushText();
      fence = [];
      fenceLen = open[1]!.length;
      continue;
    }
    let m: RegExpExecArray | null;
    let item: string | undefined;
    const heading = headingOf(line);
    if (heading) {
      flushText();
      const Tag = `h${heading.level}` as "h1";
      blocks.push(<Tag key={k++}>{inline(heading.text, `h${k}`)}</Tag>);
    } else if ((item = orderedItemOf(line)) !== undefined) {
      flushPara();
      flushQuote();
      if (!list || !list.ordered) {
        flushList();
        list = { ordered: true, items: [] };
      }
      list.items.push(item);
    } else if ((item = bulletItemOf(line)) !== undefined) {
      flushPara();
      flushQuote();
      if (!list || list.ordered) {
        flushList();
        list = { ordered: false, items: [] };
      }
      list.items.push(item);
    } else if ((m = /^\s*>\s?(.*)$/.exec(line))) {
      flushPara();
      flushList();
      quote.push(m[1]!);
    } else if (!line.trim()) {
      flushText();
    } else {
      flushList();
      flushQuote();
      para.push(line.trim());
    }
  }
  flushFence();
  flushText();
  return <>{blocks}</>;
}
