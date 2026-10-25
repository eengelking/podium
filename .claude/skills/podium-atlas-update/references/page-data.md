# Where each fact lives in `docs/atlas/podium-atlas.html`

Everything the page shows comes from data in its one `<script>` block, or from the HTML above it. Edit the data, then reload. Line numbers drift; find a constant with `grep -n '^const NAME=\|^ const NAME=' docs/atlas/podium-atlas.html`.

| Constant | What it holds | Shape and notes |
|---|---|---|
| `CH` | The nine chapters in the left rail | `[id, title]`. A new chapter needs a `<section class="ch" id=...>` too. |
| `LAYERS` | The five layers: reporter, network, server, store, console | Name, color token, glyph. Rarely changes. |
| `N` | The 30 parts on the system map | `{id, l (layer), col, row, name, role, file, what, why, how[]}`. `what` says what it is, `why` why it exists, `how` has the facts a reader acts on (limits, defaults). A new part also needs a position (`col`, `row`) and edges in `E`. |
| `E` | Edges between parts on the map | `[from id, to id, label]`, ids from `N`. A flow step lights an edge by the same two ids. |
| `F` | The six flows | `{id, name, blurb, steps[]}`. Each step: `{t (title), b (body), n (node ids it lights), e (edge ids), call?}`. Steps are in order; the dots and the stepper follow the array. |
| `REFS` | Source references per part | `id: [[path, line, text], ...]`. `text` as `name: what it does` (or `class Name: ...`) feeds ATLAS.md's Key functions tables. Path prefixes `pM`, `pS`, `pSF`, `pF` expand to the mod hooks folder, `server/src/`, `server/src/fleet/` and `frontend/src/fleet/`. |
| `MODES` | The four deployment modes | `{id, name, draw(), facts[[ok|wn|no, text]], cmd}`. |
| `STAGES`, `SC` | The request gauntlet: the ordered checks, and the twelve requests to run through them | `STAGES` entries are `[check, where it runs, what it does]`. `SC` entries give the request (`n`), where it stops (`stop`, an index into `STAGES`), the per-stage results (`res`, one per stage) and the verdict (`v`). A new or reordered middleware changes both. The order must equal the real order in `server/src/index.ts`. |
| `TIERS` | The consent ladder: what the reporter sends at each opt-in | `{k, name, meta, admin (flag id or null), opt (option name or null), items[]}`. The starting state of each switch lives just below it and must match the flag defaults in `server/src/fleet/featureFlags.ts`. |
| `FILES` | The searchable server source index | `[file name, job]`. |
| `UI` | The console's surfaces (tabs) | `{n (name), d (description), ...}`. |
| `STORES` | Where data lives, one tab per place | `{n, lead, rows[[name, text]]}`. Table and column names must match `server/src/fleet/db.ts` and `activityDb.ts`. |
| `PR` | The nine principles | `[title, text, ...]`; the text says where the code enforces it. |
| `D` | Line counts | `[area, source lines, test lines]`. Also update the chart's `aria-label`, the table under "View as a table", the totals in "At a glance", and the "Counted from the repository on" date. |

Outside the script:

- The rail and the footer carry the version string (`Reads from the repo at v...`, `at version ...`).
- The prose of the chapters (the reporter, server, data, run chapters) and the "Known limits" and "Defaults are local" lists are plain HTML above the script. Search for the number or term before assuming it is only in data.
- `COMMIT` is the commit the GitHub links in the inspector point to. Set it to the commit the references were checked against, at release-prep.

## ATLAS.md, table by table

| Section | Written by | Mirrors |
|---|---|---|
| The parts | hand | `N` (name, role, what), most important first inside each Location |
| The reporter's hooks and timers | hand | the `on('...')` handlers in `mod/podium-reporter/hooks/register.ts` plus its timers; a test requires a row for every registered hook |
| Key functions | `node scripts/atlas-functions.mjs` | `REFS` entries written as `name: what` |
| The flows | hand | `F` |
| Four ways to run it | hand | `MODES` |
| Where data lives | hand | `STORES` |
