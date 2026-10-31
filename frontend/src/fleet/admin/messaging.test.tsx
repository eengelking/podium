// Orchestrator messaging in Admin (#416): the flag, the limits in Admin > Settings, and the Messaging section of a reporter.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { AdminView } from "./AdminView";
import { fakeServer, type FakePeerRef } from "./fakeAdmin";
import { eligible } from "./ReporterMessaging";
import { REFRESH_MS } from "./ReportersTab";

class QuietSource {
  onerror = null;
  readyState = 1;
  addEventListener() {}
  close() {}
}
beforeEach(() => {
  localStorage.clear();
  vi.stubGlobal("EventSource", QuietSource);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const STUDIO: FakePeerRef = { key: "9f3a1c7d2e40", machine: "studio-m2", owner: "Dana", adminSecret: false, os: "macOS 26.1", peers: true, version: "0.16.0" };
const CI: FakePeerRef = { key: "lnx01", machine: "ci-01", owner: "Dana", adminSecret: false, os: "Ubuntu 24.04", peers: true, version: "0.16.0" };
const WIN: FakePeerRef = { key: "win01", machine: "win-lab", owner: "Dana", adminSecret: false, os: "Windows 11", peers: false, version: "0.16.0" };
const SECRET: FakePeerRef = { key: "addr:10.4.0.52", machine: "10.4.0.52", owner: "Admin", adminSecret: true, os: null, peers: true, version: "0.9.2" }; // NOSONAR S1313: a made-up private address in a fake server

/** A fake server with the flag on or off, Dana's three reporters and the admin-secret one. */
function server(opts: { flag?: boolean; trust?: boolean } = {}) {
  const s = fakeServer({ unlocked: true });
  s.features["peer-messaging"] = opts.flag ?? true;
  s.peerLimits = { roundTrips: 10, perMinute: 6, maxChars: 20_000, retainDays: 30 };
  s.peers = { reporters: [STUDIO, CI, WIN, SECRET], rights: [{ from: STUDIO.key, to: CI.key, owner: "Dana", level: "see", paused: false, setAt: 1 }], requests: [], trust: opts.trust ?? false };
  return s;
}

async function openTab(name: RegExp) {
  render(<AdminView />);
  fireEvent.click(await screen.findByRole("button", { name }));
}

async function openReporter(name: string) {
  await openTab(/^Reporters/);
  fireEvent.click(await screen.findByRole("button", { name: `Open details for ${name}` }));
  await screen.findByRole("heading", { name: new RegExp(name) });
}

const messaging = () => screen.getByRole("region", { name: "Messaging" });
const cell = (from: string, to: string) => screen.getByLabelText(`${from} to ${to}`) as HTMLSelectElement;

describe("the peer-messaging flag (#416)", () => {
  it("off, hides the limits and every messaging surface of a reporter", async () => {
    const s = server({ flag: false });
    await openTab(/^Settings/);
    await screen.findByRole("switch", { name: /Orchestrator messaging/ });
    expect(screen.queryByRole("region", { name: "Orchestrator messaging" })).toBeNull();
    cleanup();
    await openReporter("studio-m2");
    await screen.findByText("Supported");
    expect(screen.queryByRole("region", { name: "Messaging" })).toBeNull();
    expect(screen.queryByRole("button", { name: /all links/ })).toBeNull();
    expect(screen.queryByText("System", { selector: "dt" })).toBeNull();
    expect(s.calls.some((c) => c.includes("/peers"))).toBe(false);
  });

  it("is a row in Feature flags with its id, and turning it on shows the limits", async () => {
    const s = server({ flag: false });
    await openTab(/^Settings/);
    const sw = await screen.findByRole("switch", { name: /Orchestrator messaging/ });
    expect(screen.getByText("peer-messaging")).toBeInTheDocument();
    fireEvent.click(sw);
    await waitFor(() => expect(s.features["peer-messaging"]).toBe(true));
    const limits = await screen.findByRole("region", { name: "Orchestrator messaging" });
    expect(within(limits).getByText(/A person can be stricter on their own links in My reporters, not looser/)).toBeInTheDocument();
    for (const label of [/^Round trips before a person approves/, /^Messages per minute on a link/, /^Longest message, in characters/, /^Keep conversations, in days/]) expect(within(limits).getByLabelText(label)).toBeInTheDocument();
  });
});

describe("the limits in Admin > Settings (#416)", () => {
  it("refuses a bad limit in place and saves a good one", async () => {
    const s = server();
    await openTab(/^Settings/);
    const trips = (await screen.findByLabelText(/^Round trips before/)) as HTMLInputElement;
    expect(trips.value).toBe("10");
    fireEvent.change(trips, { target: { value: "0" } });
    fireEvent.blur(trips);
    expect(await screen.findByRole("alert")).toHaveTextContent("Round trips must be a whole number from 1 to 100. Nothing was saved. The saved value, 10, still applies.");
    expect(s.bodies.some((b) => "peerMessaging" in (b as object))).toBe(false);
    fireEvent.change(trips, { target: { value: "4" } });
    fireEvent.blur(trips);
    await waitFor(() => expect(s.peerLimits?.roundTrips).toBe(4));
    expect(s.bodies).toContainEqual({ peerMessaging: { roundTrips: 4 } });
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
  });

  it("shows the server's refusal with what still applies", async () => {
    const s = server();
    s.peerLimitError = "Messages per minute must be a whole number from 1 to 60";
    await openTab(/^Settings/);
    const rate = await screen.findByLabelText(/^Messages per minute/);
    fireEvent.change(rate, { target: { value: "7" } });
    fireEvent.blur(rate);
    expect(await screen.findByRole("alert")).toHaveTextContent("Messages per minute must be a whole number from 1 to 60. Nothing was saved. The saved value, 6, still applies.");
  });

  it("locks Admin when the session ended while saving", async () => {
    const s = server();
    await openTab(/^Settings/);
    const rate = await screen.findByLabelText(/^Messages per minute/);
    await act(async () => {}); // let the form's own effects run first, so they cannot put the old value back over the edit (#290)
    s.expire = true;
    fireEvent.change(rate, { target: { value: "7" } });
    fireEvent.blur(rate);
    expect(await screen.findByLabelText("Token")).toBeInTheDocument();
  });
});

describe("a reporter's Messaging section (#416)", () => {
  it("shows the owner's reporters as a Grid, with the warning that a change goes to the owner", async () => {
    const s = server();
    await openReporter("studio-m2");
    const sec = await screen.findByRole("region", { name: "Messaging" });
    expect(within(sec).getByText(/What Dana's reporters may do with each other/)).toBeInTheDocument();
    expect(within(sec).getByText("A change you make here is sent to Dana to accept.").closest(".warnbar")).not.toBeNull();
    await waitFor(() => expect(cell("studio-m2", "ci-01").value).toBe("see"));
    // A pair between two other reporters is drawn too, from the same one read.
    expect(cell("ci-01", "ci-01").value).toBe("none");
    expect(s.calls.filter((c) => c.endsWith("/peers"))).toEqual(["GET /reporters/9f3a1c7d2e40/peers"]);
    expect(within(sec).getAllByText("Messaging is off on win-lab").length).toBeGreaterThan(0);
    // No live count: the Admin's read has none.
    expect(within(sec).queryByText(/live$/)).toBeNull();
    // An Admin cannot propose No access.
    expect(within(cell("studio-m2", "ci-01")).getByRole("option", { name: "No access" })).toBeDisabled();
    expect(within(sec).getByText("You can propose more than a pair has. Taking a right away, or lowering one, is Dana's choice.")).toBeInTheDocument();
    // The details say the system and that messaging is on.
    expect(screen.getByText("System", { selector: "dt" }).nextElementSibling).toHaveTextContent("macOS 26.1");
    expect(screen.getByText("Messaging", { selector: "dt" }).nextElementSibling).toHaveTextContent("On");
  });

  it("sends a change as a proposal that shows as Proposed, waiting for the owner, and keeps focus", async () => {
    const s = server();
    await openReporter("studio-m2");
    await waitFor(() => expect(cell("ci-01", "studio-m2")).toBeInTheDocument());
    const sel = cell("ci-01", "studio-m2");
    sel.focus();
    fireEvent.change(sel, { target: { value: "send" } });
    await waitFor(() => expect(s.proposeBodies).toEqual([{ from: "lnx01", to: "9f3a1c7d2e40", level: "send" }]));
    expect(s.calls).toContain("POST /reporters/lnx01/peers/propose");
    expect(await within(messaging()).findByText("Proposed: Can send, waiting for Dana")).toBeInTheDocument();
    expect(cell("ci-01", "studio-m2").value).toBe("send");
    expect(document.activeElement).toBe(cell("ci-01", "studio-m2"));
    expect(screen.getByText("Proposed to Dana: ci-01 to studio-m2, Can send.")).toBeInTheDocument();
    // The right itself did not change.
    expect(s.peers!.rights.some((r) => r.from === "lnx01" && r.to === "9f3a1c7d2e40")).toBe(false);
    // Choosing the same level again sends nothing more.
    fireEvent.change(cell("ci-01", "studio-m2"), { target: { value: "send" } });
    expect(s.proposeBodies).toHaveLength(1);
  });

  it("offers only more than a pair has: a level below today's cannot be proposed", async () => {
    const s = server();
    s.peers!.rights[0]!.level = "send";
    await openReporter("studio-m2");
    await waitFor(() => expect(cell("studio-m2", "ci-01").value).toBe("send"));
    const c = cell("studio-m2", "ci-01");
    // Today's level is not offered either: proposing it would change nothing.
    for (const name of ["No access", "Can see", "Can send, with approval", "Can send"]) expect(within(c).getByRole("option", { name })).toBeDisabled();
    // A pair with nothing yet can be given any level but No access.
    expect(within(cell("ci-01", "studio-m2")).getByRole("option", { name: "Can see" })).toBeEnabled();
    fireEvent.change(c, { target: { value: "see" } });
    expect(s.proposeBodies).toEqual([]);
  });

  it("offers neither today's level nor a lower one while a higher proposal waits", async () => {
    const s = server();
    s.peers!.requests.push({ id: "prq_9", kind: "proposal", at: 90_000, from: { machine: "studio-m2", name: null }, to: { machine: "ci-01", name: null }, level: "send", by: "Admin", reason: null, text: null, fromKey: STUDIO.key, toKey: CI.key, messageId: null });
    await openReporter("studio-m2");
    // The stored right is Can see; the select shows the proposal waiting.
    await waitFor(() => expect(cell("studio-m2", "ci-01").value).toBe("send"));
    const c = cell("studio-m2", "ci-01");
    for (const name of ["No access", "Can see"]) expect(within(c).getByRole("option", { name })).toBeDisabled();
    for (const name of ["Can send, with approval", "Can send"]) expect(within(c).getByRole("option", { name })).toBeEnabled();
    expect(within(messaging()).getByText("Proposed: Can send, waiting for Dana")).toBeInTheDocument();
    // Today's level would be a proposal that changes nothing and replaces the one waiting: none is sent.
    fireEvent.change(c, { target: { value: "see" } });
    expect(s.proposeBodies).toEqual([]);
    fireEvent.change(c, { target: { value: "ask" } });
    await waitFor(() => expect(s.proposeBodies).toEqual([{ from: STUDIO.key, to: CI.key, level: "ask" }]));
  });

  it("says when a proposal is refused, and puts the select back", async () => {
    const s = server();
    s.proposeError = "a link can only join two reporters with the same owner";
    await openReporter("studio-m2");
    await waitFor(() => expect(cell("studio-m2", "ci-01").value).toBe("see"));
    fireEvent.change(cell("studio-m2", "ci-01"), { target: { value: "ask" } });
    expect(await within(messaging()).findByRole("alert")).toHaveTextContent("Could not send the proposal: a link can only join two reporters with the same owner. Nothing changed. Try again.");
    await waitFor(() => expect(cell("studio-m2", "ci-01").value).toBe("see"));
  });

  it("pauses every link at once, and resumes them", async () => {
    const s = server();
    await openReporter("studio-m2");
    const pause = await screen.findByRole("button", { name: "Pause all links" });
    expect(pause.closest(".dacts")).not.toBeNull();
    fireEvent.click(pause);
    const resume = await screen.findByRole("button", { name: "Resume all links" });
    expect(s.peers!.rights.filter((r) => r.from === STUDIO.key || r.to === STUDIO.key).every((r) => r.paused)).toBe(true);
    expect(screen.getByText(`Every link on studio-m2 is paused.`)).toBeInTheDocument();
    expect(within(messaging()).getAllByText("Paused").length).toBeGreaterThan(0);
    expect(document.activeElement === resume || document.activeElement === document.body).toBe(true);
    fireEvent.click(resume);
    expect(await screen.findByRole("button", { name: "Pause all links" })).toBeInTheDocument();
    expect(screen.getByText("Links on studio-m2 resumed.")).toBeInTheDocument();
    expect(s.peers!.rights.every((r) => !r.paused)).toBe(true);
  });

  it("says when pausing is refused", async () => {
    const s = server();
    await openReporter("studio-m2");
    const pause = await screen.findByRole("button", { name: "Pause all links" });
    s.proposeError = "the server is busy";
    fireEvent.click(pause);
    expect(await within(messaging()).findByRole("alert")).toHaveTextContent("Could not pause the links: the server is busy. Nothing changed. Try again.");
  });

  it("locks Admin when the session ended while proposing", async () => {
    const s = server();
    await openReporter("studio-m2");
    await waitFor(() => expect(cell("studio-m2", "ci-01").value).toBe("see"));
    s.expire = true;
    fireEvent.change(cell("studio-m2", "ci-01"), { target: { value: "ask" } });
    expect(await screen.findByLabelText("Token")).toBeInTheDocument();
  });

  it("proposes from the Board too, with No access offered to no card", async () => {
    const s = server();
    await openReporter("studio-m2");
    fireEvent.click(await within(messaging()).findByRole("radio", { name: "Board" }));
    const move = (await screen.findByLabelText("Move ci-01 to")) as HTMLSelectElement;
    expect(within(move).getByRole("option", { name: "Move to: No access" })).toBeDisabled();
    expect(screen.getByRole("radio", { name: "studio-m2" })).toHaveAttribute("aria-checked", "true");
    fireEvent.change(move, { target: { value: "send" } });
    await waitFor(() => expect(s.proposeBodies).toEqual([{ from: "9f3a1c7d2e40", to: "lnx01", level: "send" }]));
    expect(await within(messaging()).findByText("Proposed: Can send, waiting for Dana")).toBeInTheDocument();
    // Another reporter's card list.
    fireEvent.click(screen.getByRole("radio", { name: "ci-01" }));
    expect(screen.getByRole("radio", { name: "ci-01" })).toHaveAttribute("aria-checked", "true");
    expect(screen.getByText(/Drag a card to another column/)).toBeInTheDocument();
  });

  it("locks every choice under the owner's Trust my own reporters, and says so", async () => {
    server({ trust: true });
    await openReporter("studio-m2");
    expect(await within(messaging()).findByText("Trust my own reporters is on for Dana.")).toBeInTheDocument();
    expect(cell("studio-m2", "ci-01")).toBeDisabled();
    expect(cell("studio-m2", "ci-01").value).toBe("send");
  });

  it("says a reporter on the admin secret cannot take part, and offers no choices", async () => {
    server();
    await openReporter("10.4.0.52");
    expect(await within(await screen.findByRole("region", { name: "Messaging" })).findByText("The admin secret cannot take part")).toBeInTheDocument();
    expect(within(messaging()).queryByRole("combobox")).toBeNull();
    expect(within(messaging()).queryByRole("radio")).toBeNull();
    expect(screen.queryByRole("button", { name: /all links/ })).toBeNull();
    expect(screen.getByText("Cannot take part")).toBeInTheDocument();
  });

  it("says when messaging is off on the machine, or its reporter is too old, and offers no choices", async () => {
    const s = server();
    s.reporters.push({ key: "win01", state: "reporting", name: "win-lab", named: true, who: "Dana", credential: "pdm_0000000000aa", adminSecret: false, version: "0.16.0", compat: "ok", firstSeenAt: 1, lastSeenAt: 40_000, sessions: 1, live: 0 });
    await openReporter("win-lab");
    expect(await within(await screen.findByRole("region", { name: "Messaging" })).findByText("Messaging is off on win-lab")).toBeInTheDocument();
    // Both routes, as My reporters says them (#837).
    expect(within(messaging()).getByText(/Only that machine can turn it on/)).toHaveTextContent(
      "In Claude Code there, run /plugin configure podium-reporter@eengelking-marketplace and set peers to on. In the Claude desktop app there, open Settings > Plugins > Podium-Reporter > Settings and turn on peers. Until then there is nothing to set here.",
    );
    expect(within(messaging()).queryByRole("combobox")).toBeNull();
    expect(screen.queryByRole("button", { name: /all links/ })).toBeNull();
    expect(screen.getByText("Off on the machine")).toBeInTheDocument();
    cleanup();
    s.peers!.reporters[2] = { ...WIN, peers: null };
    await openReporter("win-lab");
    expect(await within(await screen.findByRole("region", { name: "Messaging" })).findByText("win-lab's reporter can't message")).toBeInTheDocument();
    expect(screen.getByText("Reporter can't message: update it")).toBeInTheDocument();
  });

  it("says a reporter with no owner belongs to no one", async () => {
    const s = server();
    s.peers!.reporters[0] = { ...STUDIO, owner: null };
    await openReporter("studio-m2");
    expect(await within(await screen.findByRole("region", { name: "Messaging" })).findByText("This reporter belongs to no one")).toBeInTheDocument();
  });

  it("says when messaging cannot be read, and asks again by itself", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    try {
      const s = server();
      s.peers!.reporters = [CI];
      await openReporter("studio-m2");
      expect(await within(await screen.findByRole("region", { name: "Messaging" })).findByRole("alert")).toHaveTextContent("Could not load this reporter's messaging (unknown reporter).");
      s.peers!.reporters = [STUDIO, CI];
      await act(async () => {
        await vi.advanceTimersByTimeAsync(REFRESH_MS + 100);
      });
      await waitFor(() => expect(cell("studio-m2", "ci-01").value).toBe("see"));
    } finally {
      vi.useRealTimers();
    }
  });

  it("lands a read slower than the interval, and starts no other while it is out", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    try {
      const s = server();
      s.holdPeers = true;
      await openReporter("studio-m2");
      await within(await screen.findByRole("region", { name: "Messaging" })).findByText("Loading…");
      const reads = () => s.calls.filter((c) => c.endsWith("/peers")).length;
      expect(reads()).toBe(1);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(REFRESH_MS * 2 + 100);
      });
      expect(reads()).toBe(1);
      s.holdPeers = false;
      await act(async () => {
        s.held.shift()!();
      });
      await waitFor(() => expect(cell("studio-m2", "ci-01").value).toBe("see"));
      // Once it is in, the interval reads again.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(REFRESH_MS + 100);
      });
      expect(reads()).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("the reads behind it (#416)", () => {
  it("knows who can take part", () => {
    expect(eligible(STUDIO)).toBe(true);
    expect(eligible(SECRET)).toBe(false);
    expect(eligible({ adminSecret: false, owner: "admin" })).toBe(false);
    expect(eligible({ adminSecret: false, owner: null })).toBe(false);
  });
});
