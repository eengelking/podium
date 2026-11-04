import { DEFAULT_HARNESS } from "./harness";

/** The places a podium-reporter option is set in Claude Code: the terminal command (full key) and the Claude desktop app's settings (#837). */
export const OPTION_CMD = "/plugin configure podium-reporter@eengelking-marketplace";
export const DESKTOP_OPTIONS = "Settings > Plugins > Podium-Reporter > Settings";

/** The OpenCode reporter reads its options only from `PODIUM_*` variables and this file, never from `opencode.json` (docs/REPORTER.md). */
export const OPENCODE_SETTINGS_FILE = "~/.podium/config.env";
/** OpenCode loads a plugin when its service starts, so a changed setting needs the service restarted (#857). */
export const OPENCODE_RESTART = "opencode service restart";

/** The harnesses that have a reporter, in the order a picker lists them. */
export const SETUP_HARNESSES = [
  { id: "claude-code", name: "Claude Code" },
  { id: "opencode", name: "OpenCode" },
] as const;
export type SetupHarness = (typeof SETUP_HARNESSES)[number]["id"];

const isSetupHarness = (id: string): id is SetupHarness => SETUP_HARNESSES.some((h) => h.id === id);

/**
 * Which reporters a machine has, from the harness of the sessions the console holds for it (#857). A reporter row carries no harness,
 * but every session does, and carries the machine's id, which is the row's key (a second reporter's key adds `@<name>`, #849). An
 * empty answer means no session is known on that machine, such as one with nothing live; a caller then shows every harness.
 */
export function harnessesOnMachine(sessions: Iterable<{ harness?: string | null; machine?: { id: string } | null }>, key: string): SetupHarness[] {
  const id = key.split("@")[0];
  const found = new Set<SetupHarness>();
  for (const s of sessions) {
    if (s.machine?.id !== id) continue;
    const h = s.harness || DEFAULT_HARNESS;
    if (isSetupHarness(h)) found.add(h);
  }
  return SETUP_HARNESSES.map((h) => h.id).filter((h) => found.has(h));
}

/** The harnesses to explain: the ones known for the machine, or all of them when none is. */
export const harnessesToShow = (known: readonly SetupHarness[]): readonly SetupHarness[] => (known.length ? known : SETUP_HARNESSES.map((h) => h.id));

/** `peers` is `PODIUM_PEERS`, `sessionRecording` is `PODIUM_SESSION_RECORDING`: the variable that turns a consent option on (`CONSENT_VARS` in plugin/core/settings.ts). */
export const optionVariable = (option: string): string => `PODIUM_${option.replace(/([a-z])([A-Z])/g, "$1_$2").toUpperCase()}`;

/** How to turn a consent option on, for a reporter on `harness`; the Claude Code text is the one the console has always shown. */
export function turnOnText(harness: SetupHarness, option: string): string {
  if (harness === "opencode") return `In OpenCode there, add ${optionVariable(option)}=true to ${OPENCODE_SETTINGS_FILE}, then run ${OPENCODE_RESTART}.`;
  return `In Claude Code there, run ${OPTION_CMD} and set ${option} to on. In the Claude desktop app there, open ${DESKTOP_OPTIONS} and turn on ${option}.`;
}

/** The text for each harness in `harnesses`, one after the other. */
export const turnOnTexts = (harnesses: readonly SetupHarness[], option: string): string => harnesses.map((h) => turnOnText(h, option)).join(" ");
