// The words `/podium` uses about messaging that both reporters say the same way (#825, #1055). Pure.
//
// The rest of the messaging text differs by harness on purpose: each names its own switch (the `peers` option, or PODIUM_PEERS), its own
// facts (Claude Code's surface and interactive run, OpenCode's `canPrompt`) and its own cause order. Each harness keeps its own.

/** Why messaging is off when the reporter has reported and Podium said no. The server's flag and the admin secret look the same from here. */
export const SERVER_FLAG_OFF = "Podium's messaging flag is off (Admin > Settings), or this reporter signs in with the admin secret, which belongs to no person";

/** What Podium said about taking part, for the `Podium says:` fact. */
export function podiumSays(reported: boolean, serverSays: boolean): string {
  return !reported ? 'nothing yet' : serverSays ? 'takes part' : 'does not take part';
}
