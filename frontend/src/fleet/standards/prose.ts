// The standards pages that are written, not measured (#354): patterns, voice, accessibility and process. They state what the
// app does today and what new work follows. The text is checked by people and by the audit; the samples they point at are
// on the components page and are rendered from the app. Changing a rule here goes through the update skill, after approval.
import { esc, pageHtml } from "./html";

export interface Entry {
  file: string;
  reason: string;
}

const panel = (id: string, title: string, body: string) => `  <section class="s-panel" id="${id}"><h3>${esc(title)}</h3>\n    ${body}\n  </section>`;
const list = (items: string[]) => `<ul>${items.map((i) => `<li>${i}</li>`).join("")}</ul>`;
const c = (s: string) => `<code>${esc(s)}</code>`;
const head = (title: string, lead: string) => `  <div><h1>${esc(title)}</h1><p>${lead}</p></div>`;

export function patternsPage(): string {
  const body = [
    head("Patterns", "Written rules for the decisions that come up again. Each says what the app does, and so what new work does. The samples are on the <a href=\"components.html\">components page</a>."),
    panel(
      "wall-notices",
      "Wall notices",
      `<p>An informational note about the wall follows five rules. The sample is <a href="components.html#notices">Notices and toast</a>.</p>${list([
        "It sits at the bottom of the wall, below the cards, in one stack, one per row. Never above the cards or between them.",
        `It has an X, named ${c("Close notice: <name>")}. Closing it turns that notice off for everyone and shows a short confirmation, bottom right, that names it and links to Admin &gt; Settings. The confirmation clears itself after about 9 seconds and has its own X.`,
        "It has an on/off switch under Admin &gt; Settings, with a one-line description. A new notice is not done until its switch exists. All notices default to on.",
        "An action inside the notice, such as Show them, stays as a link in the notice.",
        "Errors and connection problems are not notices. They keep their place and cannot be closed.",
      ])}`,
    ),
    panel(
      "paging",
      "Paging and Showing N of M",
      `${list([
        `An Admin list uses the server's pager: ${c("Showing 51 to 100 of 212")}, then Rows per page (25, 50 or 100, default 50), Previous, ${c("Page 2 of 5")} and Next. Previous and Next are disabled at the ends. The count is the server's total.`,
        `The Files tab and the Plan tab share one footer: ${c("Showing 1–20 of 45")}, then page buttons once there is more than one page, otherwise the page size. The Files tab shows 20 files a page.`,
        "A list that the server did not count is not paged with the Admin pager.",
      ])}`,
    ),
    panel(
      "status",
      "Status: shape, color and word together",
      `${list([
        "A state is shown as an icon and a word. Color is never the only signal.",
        "Each card, rail and band state has its own shape: a play mark for running, a ring with an exclamation mark for waiting on you, a dashed clock ring for idle on background work, a clock for heartbeat lost, a check for done, and a ring with a dot for delegating.",
        "Each plan step state has its own shape too.",
        "A person is a monogram and a name, never a color, because color already means model and status.",
        "Where a color carries meaning, such as an administrator's name, it also has a tooltip and a screen-reader label.",
      ])}`,
    ),
    panel(
      "consent",
      "Consent and warnings are not informational notes",
      `${list([
        `A question that needs a yes before something happens, such as sending ${c("/clear")} or removing a reporter, is a confirmation box with a warning-colored border that names what will happen, and a button for each answer.`,
        "A warning line inside a form says what a choice will do, in the warning color, before it is made.",
        "A note that something was cut or cannot be done is plain text in the panel, in the ink color.",
        "A dismissible, dashed-border note at the bottom of the wall is a notice. It is only for information.",
        "An error is text in the critical color with role alert. It says what went wrong and what to do.",
      ])}`,
    ),
    panel(
      "copy",
      "Copy to clipboard",
      `${list([
        "A value people copy, such as a session id or a resume command, is a quiet whole-cell control that copies on a click.",
        "It shows Copied with a check for about 1.6 seconds. When the clipboard refuses, nothing changes.",
        "On a card the id is a span with role button inside the card's own button, and keeps its click and Enter or Space from opening the card.",
      ])}`,
    ),
    panel(
      "primary-button",
      "The primary button",
      `${list([
        `${c(".btn.pri")} is the ink color as its fill with the page color as its text. No other rule recolors it, in any context. A test fails if one does.`,
        "A view has one primary button, the one that finishes what the view is for. Every other button is the default.",
        "A destructive action is the bad variant: critical-colored text and border, no fill.",
      ])}`,
    ),
    panel(
      "empty",
      "Empty, loading and error states",
      `${list([
        "An empty area says why it is empty and, where there is one, what to do. The board's Review column says Nothing waiting on a person right now.",
        "An empty area inside a column or a list is a dashed-border box with muted text. An empty page is a dashed-border block with a short heading.",
        "Loading is a short word in the muted color, such as Loading… in the report modal. A pending action says so in words, such as Sending to the session's name.",
        "An error from the server is shown in place, in words, with what to try. A refusal is in plain words, not the route's error code.",
      ])}`,
    ),
    panel(
      "long",
      "Long text, long lists and a large fleet",
      `${list([
        "A name in a row is cut with an ellipsis and has its full text as a title. A path is wrapped in bdi so its direction holds. Text from a session is wrapped anywhere it must, never clipped.",
        "A list shows the most used five tool chips, then Show all. The activity list pages 12 at a time with Show more and Show fewer. The activity feed keeps the latest 20 entries.",
        "The agent tree scrolls inside its own container, so the page does not scroll sideways at 400 px.",
        "The wall is a grid that fills the width. A big fleet is a longer wall, not a different layout; the toolbar's filter and search narrow it, and the people view groups it.",
        "Text from a session or a reporter is drawn as text nodes and never as HTML.",
      ])}`,
    ),
  ].join("\n");
  return pageHtml({ file: "patterns.html", title: "Patterns", body });
}

export function voicePage(): string {
  const body = [
    head("Voice", "How Podium's own words sound: labels, notes and errors in the app. For prose in docs, commit messages and pull requests, use the documentation voice guide too."),
    panel(
      "words",
      "Wording",
      `${list([
        "Plain verbs, sentence case, no filler. A button says what happens: Create user, Unlock Admin, Remove from list, Show 12 more.",
        "The same action has the same name everywhere. A control that says Remove does not become Delete in its confirmation.",
        "Name things as people know them: session, agent, orchestrator, reporter, wall, plan step. Not the names of the code.",
        "Write a path in Admin as <code>Admin &gt; Settings</code>, with a greater-than sign and spaces.",
        "A model is its name and version, such as Opus 5.5. A cost is an estimate and says so: Est. cost today.",
        "A number has its unit or its noun next to it, and a count says what it counts: 3 selected, 2 of 5 done.",
      ])}`,
    ),
    panel(
      "errors",
      "Errors and refusals",
      `${list([
        "Say what went wrong and what to try, in one or two short sentences. Do not apologize and do not blame.",
        "Do not say which part of a sign-in was wrong. The same sentence covers a wrong name and a wrong token.",
        `Use the user's names for the options: ${c("That name and token don't match. Check the userName and token options in podium-reporter.")}`,
        "Say when something is not known, not a made-up value: n/a with the reason, and No plan reported.",
      ])}`,
    ),
    panel(
      "notes",
      "Notes and hints",
      `${list([
        "A note says what is true now. It does not describe how the page is built.",
        "A tooltip adds one fact. The text is always in the page for a screen reader.",
        "A hint under a field says what the field does. It is not a second label.",
      ])}`,
    ),
  ].join("\n");
  return pageHtml({ file: "voice.html", title: "Voice", body });
}

export function accessibilityPage(): string {
  const body = [
    head("Accessibility and responsiveness", "What every interactive thing in Podium does for keyboard, screen-reader and narrow-screen use. From SPEC 8.4, and what the app does today."),
    panel(
      "controls",
      "Controls",
      `${list([
        "Every interactive element is a real button, a, input or select, with a visible focus ring: a 2 px outline in the Sonnet token.",
        "A control that opens something reports aria-expanded and aria-controls: the pane tabs, the top bar toggle, the Blowouts cell.",
        "A toggle button says whether it is pressed. A radio group moves with the arrow keys and only the checked radio is in the tab order.",
        "Tabs are a tablist with arrow keys; the current tab is aria-selected.",
        "A resize handle is a separator with aria-orientation, aria-valuenow, aria-valuemin, aria-valuemax and a label. Arrow keys move it, Shift moves it 48 px, Home resets it.",
      ])}`,
    ),
    panel(
      "dialogs",
      "Dialogs and popups",
      `${list([
        "A modal moves focus to its X, keeps Tab inside, closes with Escape, the X or a press outside, and returns focus to what opened it. The page behind takes no keys while it is open.",
        "A tip opens on hover and on keyboard focus, closes on Escape, and its text is always in the page as a tooltip the trigger names with aria-describedby.",
      ])}`,
    ),
    panel(
      "meaning",
      "Meaning without color",
      `${list([
        "State is icon plus word. A chart is a role img with a label, and the same numbers are in text elsewhere.",
        "Decorative icons are hidden from assistive tech. The word beside an icon carries the meaning.",
        "A count that changes, such as Showing 1 to 50 of 212, is a status message so the change is announced.",
      ])}`,
    ),
    panel(
      "contrast",
      "Contrast",
      `${list([
        "Text needs 4.5:1 on the page and surface colors. Marks for status and model need 3:1, or Podium's own ratio for that mode when it is lower.",
        "Every theme and mode is checked by scripts/theme-contrast.ts in npm test. The targets and the palettes are on the <a href=\"themes.html\">Themes page</a>.",
      ])}`,
    ),
    panel(
      "motion",
      "Motion",
      `${list([
        "prefers-reduced-motion stops animation and transitions.",
        "Animation is for a change the person should notice: a new card or row arriving, a row an event opened. It runs for under three seconds.",
        "While the tab is hidden the console's animations are paused.",
      ])}`,
    ),
    panel(
      "narrow",
      "Narrow screens",
      `${list([
        "The page does not scroll sideways at 400 px. Rows wrap or stack, and a wide table or the agent tree scrolls inside its own container.",
        "At 1280 px and below the columns narrow and the agent table drops its tokens column. At 1040 px and below the console stacks: the rail, then the page, then the activity panel. The resize handles and wall mode are hidden then. The Admin menu becomes a strip of icons on a narrow window.",
        "Text a person must read is never clipped: it wraps, or it scrolls in its own container.",
      ])}`,
    ),
  ].join("\n");
  return pageHtml({ file: "accessibility.html", title: "Accessibility", body });
}

export function processPage(deferred: Entry[]): string {
  const rows = deferred.map((d) => `<tr><td>${c(d.file)}</td><td>${esc(d.reason)}</td></tr>`).join("");
  const body = [
    head("Process", "How a change to the UI is designed, checked and added to these standards."),
    panel(
      "mockup",
      "When a mockup is required",
      `${list([
        "Before any new screen, component, pattern or visible change to an existing one. A one-line fix to what is already there does not need one.",
        "A mockup shows the screen in the default theme in both light and dark, and at a narrow width. It shows the empty, error and long-text cases where they apply.",
        `A mockup links ${c("frontend/src/fleet/tokens.css")} and the app's stylesheets. It does not carry a ${c(":root")} block of its own.`,
        "The maintainer accepts the mockup before any code is written. It is published as an Artifact for review, and the file stays in mockup/.",
      ])}`,
    ),
    panel(
      "check",
      "Checking a change against the standards",
      `${list([
        `Use the ${c("podium-standards-check")} skill for any UI change or mockup. It reports each deviation with the standard it breaks and where. It does not edit anything.`,
        `The ${c("podium-ui-auditor")} agent runs the same check across the whole app, and also lists what the app does that no standard covers.`,
        "The standards constrain the global frontend-design and dataviz skills: Podium's tokens and patterns win.",
        `${c("npm test")} fails on a hard-coded color outside tokens.css that is not listed below, on a token nothing defines, and on a theme below the contrast targets.`,
      ])}`,
    ),
    panel(
      "update",
      "Changing a standard",
      `${list([
        `A feature or fix PR into development that changes the UI does not edit these pages, the same way it does not bump the version. It adds a ${c("Standards:")} line under [Unreleased] in CHANGELOG.md that names the change the maintainer approved.`,
        `The ${c("podium-standards-update")} skill brings these pages in line with the code that is about to become main, in the release-prep PR, from the ${c("Standards:")} lines and the maintainer's approvals. It only acts on an approved change, and it does not finish until ${c("npm run standards:parity")} passes with no differences.`,
        "The release PR into main is valid only if the pages match the app. A hotfix that changes the UI updates the pages in the same PR.",
        "While a change is on development and not yet in these pages, the check treats the approved Standards: lines as allowed.",
        "A new component or pattern is added to the system in the PR that introduces it: a section on the components page and, if it is a rule, a line on the patterns page. It is not invented inside one feature.",
      ])}`,
    ),
    panel(
      "deferred",
      "Deferred",
      `<p>Colors written outside tokens.css that are not tokens yet. Each has a reason. A new one needs a reason too, in docs/standards/deferred.json.</p><div class="s-table-wrap"><table class="s-table"><thead><tr><th scope="col">File and value</th><th scope="col">Why it is not a token yet</th></tr></thead><tbody>${rows}</tbody></table></div><p>Also deferred, as they would change layouts: a spacing scale, and tokens for radius, layers, motion and type sizes. The <a href="scale.html">scale page</a> lists what is in use.</p>`,
    ),
  ].join("\n");
  return pageHtml({ file: "process.html", title: "Process", body });
}
