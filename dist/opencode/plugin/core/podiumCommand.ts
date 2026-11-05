// What the `/podium` command shares between the reporters (#987): which words it takes and the line that says how the reporter signs in.
// Pure; each reporter runs the command in its own host.

/** The text of `/podium name <text>`: trimmed, at most 80 characters. Null when no name follows. The two parts of the pattern are disjoint (#515). */
export function nameArg(args: string): string | null {
  const m = /^name\s+(\S[\s\S]*)$/i.exec(args.trim());
  return m ? m[1]!.trim().slice(0, 80) : null;
}

/**
 * `/podium context ...`: the arguments after the word `context`, or null when the command is not that. The word alone, or followed by
 * whitespace; startsWith and a one-character test, so no pattern can backtrack over the rest.
 */
export function contextArgs(args: string): string | null {
  const trimmed = args.trim();
  return trimmed.startsWith('context') && (trimmed.length === 7 || /\s/.test(trimmed.charAt(7))) ? trimmed.slice(7) : null;
}

/** The `Sign-in:` line: a plain token or a reporter config file (mTLS), and which file. */
export function connectionLine(c: { configPath: string | null; tokenSet: boolean }): string {
  if (c.configPath) return `Sign-in: reporter config file ${c.configPath} (mTLS)`;
  if (c.tokenSet) return 'Sign-in: a plain token (not a reporter config file)';
  return 'Sign-in: none (no token and no reporter config file)';
}
