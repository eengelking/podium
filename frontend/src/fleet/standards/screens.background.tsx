// The Background tab of the Activity modal (#897): the shells and monitors a loop started, in each state an item can be in. The real
// ActivityTabs and BackgroundPane against fixture items, inside the console's own Modal. Times count from the harness clock (T0).
import { act, fireEvent, within } from "@testing-library/react";
import { ActivityTabs } from "../components/ActivityTabs";
import { BackgroundPane } from "../components/BackgroundList";
import { Modal } from "../components/Modal";
import { makeAgent, makeSession } from "../fixtures";
import type { BackgroundItem } from "../types";
import type { Screen } from "./screens";

const T0 = Date.UTC(2026, 9, 12, 14, 30);
const MIN = 60_000;
const flush = () => act(async () => { for (let i = 0; i < 5; i++) await Promise.resolve(); });
const noop = () => {};

const item = (over: Partial<BackgroundItem>): BackgroundItem => ({ id: "b0", kind: "shell", state: "running", startedAt: T0 - 8 * MIN, startedKnown: true, label: "npm", ...over });

const ITEMS: BackgroundItem[] = [
  item({ id: "b1", state: "exited", exitCode: 0, endedAt: T0 - 5 * MIN, startedAt: T0 - 9 * MIN, command: "npm run build", output: "built in 41 s" }),
  item({ id: "b2", state: "exited", exitCode: 2, endedAt: T0 - 4 * MIN, startedAt: T0 - 7 * MIN, command: "npm run test:e2e", output: "FAIL login.cy.ts\n1 failing" }),
  item({ id: "b3", state: "exited", startedAt: T0 - 6 * MIN, endedAt: T0 - 3 * MIN, command: "tail -f server.log", label: "tail", startedKnown: false }),
  item({ id: "b4", kind: "monitor", startedAt: T0 - 5 * MIN, command: "watch -n 5 git status --short", label: "watch", lastOutputAt: T0 - 4_000, ownerId: "a1" }),
  item({ id: "b5", startedAt: T0 - 12 * MIN, command: "npm run dev", lastOutputAt: T0 - 7 * MIN }),
];

const AGENTS = [makeAgent({ id: "a1", description: "Watch the repository", status: "running" })];

function pane(items: BackgroundItem[], harness: "claude-code" | "opencode", open?: RegExp): Screen {
  return {
    make: () => {
      const s = makeSession({ id: "s1", name: "api-refactor", harness, reporterVersion: "1.7.0", activityFeed: true, backgroundOutput: true, agents: AGENTS });
      // The modal draws into the page's body, so the screen's own root is an empty .podium.
      return (
        <div className="podium">
          <Modal titleId="act-t" title="Activity" sub="api-refactor" className="modal-feed" onClose={noop}>
            <ActivityTabs tab="background" onTab={noop} count={items.length} idPrefix="act-demo" />
            <div className="mb feedmb" role="tabpanel" id="act-demo-panel" aria-labelledby="act-demo-tab-background">
              <BackgroundPane s={s} items={items} now={T0} when="Updated 3 s ago" adminOff={false} refused={null} />
            </div>
          </Modal>
        </div>
      );
    },
    act: async (body) => {
      await flush();
      if (open) fireEvent.click(within(body).getByText(open).closest("button")!);
      await flush();
    },
  };
}

export const BACKGROUND_SCREENS: Record<string, Screen> = {
  "bg-modal": pane(ITEMS, "claude-code"),
  "bg-modal-open": pane(ITEMS, "claude-code", /npm run test:e2e/),
  "bg-modal-opencode": pane([ITEMS[0]!, ITEMS[4]!], "opencode"),
};
