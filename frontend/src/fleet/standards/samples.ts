// The standards on the components page (#354): what each component is for, which part of which screen shows it, when to use
// it and when not. The markup is rendered from the app (screens.tsx), so this file holds only the words and the selector.
import type { SectionSpec } from "./html";

export interface Sample extends SectionSpec {
  /** A key of SCREENS in screens.tsx. */
  screen: string;
  /** What to cut out of the rendered screen. */
  selector: string;
  /** Show every match, labelled in order, instead of only the first. */
  labels?: string[];
}

export const SAMPLES: Sample[] = [
  {
    id: "kpis",
    title: "KPIs",
    files: ["components/Wall.tsx"],
    purpose: "The summary strip above the wall: a label, a big number and a caption for each fleet-wide figure.",
    use: ["Showing a count or total for the whole fleet that a person glances at.", "Adding a small trend line under a figure (cost, tokens)."],
    avoid: ["Putting an action in a KPI.", "Showing a figure for one session. Use the card."],
    a11y: "Each KPI is plain text in reading order: the label, then the figure, then the caption. Trend lines are drawn marks with a text title.",
    screen: "wall",
    selector: ".kpis",
  },
  {
    id: "session-card",
    title: "Session card",
    files: ["components/SessionCard.tsx"],
    purpose: "One session on the wall: who it is, what it is doing, what it costs and how healthy it is, with a status band at the foot.",
    use: ["Showing a session on the wall.", "Showing a state: running, waiting on you, done, or heartbeat lost."],
    avoid: ["Putting a second primary action inside the card. The whole card opens the session.", "Showing status by color alone. The band carries an icon and a word."],
    a11y: "The card is one button that opens the session. Remove sits beside it, not inside it, so there is no button within a button.",
    screen: "wall",
    selector: ".card-slot",
    labels: ["Running", "Waiting on you", "Done", "Heartbeat lost"],
  },
];
