// `/podium config` in Claude Code (#1001): a pane of the reporter's settings, drawn from the engine's `/config` rows. Glue only: what it
// shows is configView.ts, and the rows and words are core/settingsWindow.ts. Each control saves on its own through `$.config.set`, from
// the person's own pick; nothing else in the mod calls it. Every change takes effect at the next start.
//
// As in register.ts, `$` is only passed to functions declared at the top of this file and always spelled `$.noun.event(...)`.
import { atom, read, update } from 'claude-code'
import type { ElementTable, EngineInterface, On, RenderChildren } from 'claude-code'
import { CLAUDE_CONFIGURE, hintOf, isConfigArgs, isNarrow, labelOf, LOCKED_NOTE, lockedBy, NEXT_START, NEXT_START_NOTE, noWindowText, SETTING_GROUPS, shownValue, WINDOW_TITLE } from '../../core/settingsWindow.ts'
import { changeable, engineValue, paneHeight, paneRows, type Live, type PaneRow } from './configView.ts'

type Engine = EngineInterface

export const CONFIG_PANE = 'podium-config'
/** How long after the command the pane asks for the keyboard again, once the prompt is back to an empty composer. */
const FOCUS_RETRY_MS = 150
/** Bumped by each save, so the pane is drawn again with the engine's new value. */
const revision = atom({ plugin: 'podium-reporter', key: 'configRev' } as const, 0, { shape: 'config-rev-1' })

const SWITCH = [{ value: 'false', label: 'off' }, { value: 'true', label: 'on' }]

/** The first control the pane draws: where the keyboard lands. */
const firstControl = (rows: readonly PaneRow[]): string | undefined => rows.find(changeable)?.setting.id

/** Saves one row from the person's pick or entry, says what happened, and draws the pane again. */
async function save($: Engine, row: PaneRow, raw: string): Promise<void> {
  const v = engineValue(row, raw)
  let said: string
  if (!v.ok) said = `Podium: ${v.reason}`
  else {
    try {
      const r = (await $.config.set({ key: row.key!, value: v.value })) as { deny?: string }
      said = r?.deny ? `Podium: ${row.setting.label} not saved: ${r.deny}` : `Podium: saved ${row.setting.label}. ${NEXT_START_NOTE}`
    } catch (err) {
      said = `Podium: ${row.setting.label} not saved (${err instanceof Error ? err.message : String(err)}).`
    }
  }
  $.ui.toast(said)
  await update($, revision, (n) => n + 1)
}

/** Asks for the keyboard again after the command has returned, and puts the ring on the first control. Best effort: either may be refused. */
async function refocus($: Engine, live: () => Live): Promise<void> {
  try {
    await $.ui.open({ id: CONFIG_PANE, title: WINDOW_TITLE, focus: true, closeOnEscape: true })
    const key = firstControl(paneRows(await $.config.list(), live()))
    if (key) await $.ui.focus({ requestId: CONFIG_PANE, key })
  } catch (err) {
    // The pane closed, or the surface refused: the person can still click it. Said in the debug log only.
    $.ui.log(`podium-reporter: settings pane focus: ${err instanceof Error ? err.message : String(err)}`, { to: 'debug' })
  }
}

/** Opens the pane for the person's command. With no surface to draw it on, says where the settings are. */
async function openPane($: Engine, live: () => Live): Promise<{ text?: string }> {
  let placed = false
  try {
    const opened = await $.ui.open({ id: CONFIG_PANE, title: WINDOW_TITLE, focus: true, closeOnEscape: true, rows: paneHeight(paneRows([], live())) })
    placed = opened.isPlaced
  } catch {
    placed = false
  }
  if (!placed) return { text: noWindowText('claudecode', null) }
  try {
    $.clock.after(FOCUS_RETRY_MS, () => void refocus($, live))
  } catch {
    // No clock: the first open's focus request stands.
  }
  // A pane is the answer: no transcript line, and nothing for the model to read.
  return {}
}

/** One row of the pane: a control for a row it changes, else the value, and what decides it. */
function drawRow(t: ElementTable, r: PaneRow, narrow: boolean, autoFocus: boolean, onPick: (raw: string) => void): RenderChildren {
  const { Box, Text, Select, Input } = t
  const label = labelOf(r.setting, narrow)
  const when = narrow ? null : <Text dimColor>{NEXT_START}</Text>
  if (r.lock) {
    return (
      <Box flexDirection="column">
        <Text>
          {label}   {shownValue(r.setting, r.value)}   <Text color="warning">▲ {lockedBy(r.lock)}</Text>
        </Text>
        <Text dimColor>{LOCKED_NOTE}</Text>
      </Box>
    )
  }
  if (!changeable(r)) {
    return (
      <Text>
        {label}   <Text dimColor>{shownValue(r.setting, r.value)}</Text>
      </Text>
    )
  }
  const focus = autoFocus ? { autoFocus: true as const } : {}
  if (r.setting.kind === 'number') {
    return (
      <Box flexDirection="row" gap={2}>
        <Input key={r.setting.id} label={label} value={r.value} placeholder={hintOf(r.setting, 'claudecode')} onSubmit={(v: string) => onPick(v)} {...focus} />
        {when}
      </Box>
    )
  }
  const options = r.setting.kind === 'switch' ? SWITCH : (r.setting.choices ?? []).map((c) => ({ value: c }))
  return (
    <Box flexDirection="row" gap={2}>
      <Select key={r.setting.id} label={label} value={r.value} options={options} onSelect={(v: string) => onPick(v)} {...focus} />
      {when}
    </Box>
  )
}

/** Registers the command's `config` word and the pane. `live` is what the reporter holds now: its server, the name and the context. */
export function registerConfigPane(on: On, live: () => Live): void {
  on('command.run', { command: 'podium' }, async ($, e, next) => (isConfigArgs(e.args) ? openPane($, live) : next(e)))

  on('ui.render', { component: 'Pane', requestId: CONFIG_PANE }, async ($, e) => {
    const t: ElementTable = $.ui.resolve(e)
    const { Box, Text } = t
    await read($, revision)
    const rows = paneRows(await $.config.list(), live())
    const narrow = isNarrow((e.props as { bodyColumns?: number }).bodyColumns)
    const first = firstControl(rows)
    return (
      <Box flexDirection="column">
        {SETTING_GROUPS.map((g) => {
          const mine = rows.filter((r) => r.setting.group === g.id)
          if (!mine.length) return null
          return (
            <Box flexDirection="column">
              <Text bold>{narrow ? g.short : g.title}</Text>
              {mine.map((r) => drawRow(t, r, narrow, r.setting.id === first, (raw) => void save($, r, raw)))}
              {g.id === 'connection' || g.id === 'context' ? <Text dimColor>{hintOf(mine[0]!.setting, 'claudecode')}</Text> : null}
            </Box>
          )
        })}
        <Text dimColor>{narrow ? NEXT_START_NOTE : `${NEXT_START_NOTE} Up/Down moves, Enter picks, Esc closes.`}</Text>
        <Text dimColor>No keyboard here? Click the pane, or use {CLAUDE_CONFIGURE}.</Text>
      </Box>
    )
  })
}
