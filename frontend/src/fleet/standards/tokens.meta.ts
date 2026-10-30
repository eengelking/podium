// What each token means and where the app uses it (#354). The values are not here: they are read from tokens.css, so the
// pages cannot disagree with it. A test (in the parity run) fails if tokens.css gains or loses a token without a line here.
export interface TokenDoc {
  group: string;
  role: string;
}

export const TOKEN_GROUPS = ["Surfaces", "Ink", "Lines and washes", "Models", "Status", "Delegation and admin", "Effort", "Fonts"] as const;

const t = (group: (typeof TOKEN_GROUPS)[number], role: string): TokenDoc => ({ group, role });

export const TOKEN_DOCS: Record<string, TokenDoc> = {
  bg: t("Surfaces", "The page behind everything, and the text color on a primary button."),
  surface: t("Surfaces", "Cards, panels, the top bar and the KPI strip: anything that sits on the page."),
  raised: t("Surfaces", "Something that sits on a surface or floats above it: buttons, tooltips, the toast, the modal's raised parts."),
  ink: t("Ink", "Primary text, and the fill of a primary button."),
  ink2: t("Ink", "Secondary text: captions, chip text, quieter labels."),
  muted: t("Ink", "The quietest text: units, hints, empty values. Still meets the 4.5:1 text target."),
  grid: t("Lines and washes", "Hairline dividers between rows and cells, the track of a bar, and the area under a sparkline."),
  axis: t("Lines and washes", "A stronger line: the border of a floating panel, a chart axis, a pressed control."),
  border: t("Lines and washes", "The translucent border on cards, panels, chips and fields."),
  hover: t("Lines and washes", "The wash under a hovered row or control."),
  sel: t("Lines and washes", "The wash under a selected or pressed control."),
  opus: t("Models", "The Opus family: its chip, its chart series and its spend."),
  sonnet: t("Models", "The Sonnet family. Also the color of the keyboard focus ring."),
  haiku: t("Models", "The Haiku family."),
  fable: t("Models", "The Fable family."),
  other: t("Models", "A model that is not a Claude model."),
  good: t("Status", "A mark that something is running or fine: a dot, a switch that is on."),
  "good-text": t("Status", "Green text, checked for 4.5:1 on the surface it sits on."),
  warn: t("Status", "Waiting on you, or something to look at: the mark and its text."),
  "warn-text": t("Status", "Amber text on the light Podium theme, checked for 4.5:1: the dirty count on the git line."),
  serious: t("Status", "A session whose heartbeat is lost, and a reporter that has gone silent."),
  crit: t("Status", "A failure: the mark, the failure box's border and wash."),
  "crit-text": t("Status", "Red text, checked for 4.5:1."),
  "on-good": t("Status", "Text or a tick drawn on a --good fill."),
  deleg: t("Delegation and admin", "A session that is idle while agents it launched run: the ring and its marks."),
  "deleg-text": t("Delegation and admin", "The same state as text, checked for 4.5:1."),
  "admin-text": t("Delegation and admin", "The administrator's name in the Admin People list."),
  "eff-low": t("Effort", "The effort meter at low."),
  "eff-medium": t("Effort", "The effort meter at medium."),
  "eff-high": t("Effort", "The effort meter at high."),
  "eff-xhigh": t("Effort", "The effort meter at extra high."),
  "eff-r1": t("Effort", "The first of the five bars when effort is max."),
  "eff-r2": t("Effort", "The second bar at max."),
  "eff-r3": t("Effort", "The third bar at max."),
  "eff-r4": t("Effort", "The fourth bar at max."),
  "eff-r5": t("Effort", "The fifth bar at max."),
  "font-ui": t("Fonts", "Labels, body text and headings."),
  "font-mono": t("Fonts", "Figures, paths, ids and code. Digits line up in columns."),
};
