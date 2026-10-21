import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { AdminView } from "./AdminView";
import { REFRESH_MS } from "./ReportersTab";
import { makeSession, makeState } from "../fixtures";
import type { FleetSource } from "../useFleet";
import { fakeServer } from "./fakeAdmin";

/** Admin opens the fleet stream for its "N reporters live" pill; jsdom has no EventSource. */
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

async function unlock() {
  fireEvent.change(await screen.findByLabelText("Name"), { target: { value: "Priya" } });
  fireEvent.change(screen.getByLabelText("Token"), { target: { value: "right" } });
  fireEvent.click(screen.getByRole("button", { name: "Unlock Admin" }));
  await screen.findByRole("navigation", { name: "Admin sections" });
}

describe("Admin lock screen", () => {
  it("asks for a name and a token, rejects a wrong pair, and opens with the right one", async () => {
    const srv = fakeServer();
    render(<AdminView />);
    fireEvent.change(await screen.findByLabelText("Name"), { target: { value: "Dana" } });
    fireEvent.change(screen.getByLabelText("Token"), { target: { value: "nope" } });
    fireEvent.click(screen.getByRole("button", { name: "Unlock Admin" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("That name and token do not open Admin.");
    expect(srv.unlockBodies).toEqual([{ name: "Dana", token: "nope" }]);
    expect(screen.queryByRole("navigation", { name: "Admin sections" })).toBeNull();
    expect((screen.getByLabelText("Token") as HTMLInputElement).value).toBe("");
    await unlock();
    expect(screen.getByRole("button", { name: /^People(?! and)/ })).toHaveAttribute("aria-current", "page");
  });

  it("puts the cursor in the Name field when the lock screen opens", async () => {
    fakeServer();
    render(<AdminView />);
    expect(await screen.findByLabelText("Name")).toHaveFocus();
  });

  it("asks for the name as well when only a token is typed", async () => {
    const srv = fakeServer();
    render(<AdminView />);
    fireEvent.change(await screen.findByLabelText("Token"), { target: { value: "right" } });
    fireEvent.click(screen.getByRole("button", { name: "Unlock Admin" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Enter your name and your token.");
    expect(srv.unlockBodies).toEqual([]);
  });

  it("opens straight away when this browser already has a session", async () => {
    fakeServer({ unlocked: true });
    render(<AdminView />);
    expect(await screen.findByRole("navigation", { name: "Admin sections" })).toBeInTheDocument();
  });

  it("shows the version in the footer, with a Dev row when the server is a dev build (#400)", async () => {
    fakeServer({ unlocked: true });
    const { unmount } = render(<AdminView />);
    await screen.findByRole("navigation", { name: "Admin sections" });
    expect(document.querySelector(".rail-foot")).toHaveTextContent("Podium v1.1.0");
    expect(document.querySelector(".rail-foot")).not.toHaveTextContent("Dev:");
    unmount();
    fakeServer({ unlocked: true, build: "a1b2c3d4" });
    render(<AdminView />);
    await screen.findByRole("navigation", { name: "Admin sections" });
    expect(document.querySelector(".rail-foot")).toHaveTextContent("Dev: a1b2c3d4");
  });

  it("opens without a sign-in when the browser is already signed in to respond as an Administrator", async () => {
    const srv = fakeServer({ respondAdmin: true });
    render(<AdminView />);
    expect(await screen.findByRole("navigation", { name: "Admin sections" })).toBeInTheDocument();
    expect(srv.unlockBodies).toEqual([]);
    expect(screen.queryByLabelText("Token")).toBeNull();
  });

  it("shows the sign-in when the browser is not signed in as an Administrator", async () => {
    const srv = fakeServer({ respondAdmin: false });
    render(<AdminView />);
    expect(await screen.findByLabelText("Name")).toBeInTheDocument();
    expect(srv.calls).toContain("POST /unlock/from-respond");
  });

  it("says Admin is off when the server has no token", async () => {
    fakeServer({ enabled: false });
    render(<AdminView />);
    expect(await screen.findByText("Admin is off")).toBeInTheDocument();
    expect(screen.queryByLabelText("Token")).toBeNull();
  });
});

describe("admin log retention (#303)", () => {
  it("says how long the log is kept", async () => {
    fakeServer();
    render(<AdminView />);
    await unlock();
    fireEvent.click(await screen.findByRole("button", { name: /Admin log/ }));
    expect(await screen.findByText("Entries are kept for 90 days.")).toBeInTheDocument();
  });
});

describe("tokens", () => {
  it("shows a new token once, keeps it across tabs, and drops it when saved or locked out", async () => {
    fakeServer();
    render(<AdminView />);
    await unlock();
    fireEvent.change(await screen.findByLabelText("Name"), { target: { value: "Dana" } });
    fireEvent.click(screen.getByRole("button", { name: "Create user" }));
    const code = await screen.findByText(/token: pdm_aaaaaaaaaaaa_/);
    expect(code).toHaveTextContent("userName: Dana");
    fireEvent.click(screen.getByRole("button", { name: /Admin log/ }));
    expect(screen.getByText(/token: pdm_aaaaaaaaaaaa_/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "I have saved it" }));
    expect(screen.queryByText(/pdm_aaaaaaaaaaaa_/)).toBeNull();
    // After it, the list names the token by its key id, `pdm_<key id>`, with none of the secret.
    fireEvent.click(screen.getByRole("button", { name: /^People(?! and)/ }));
    expect(await screen.findByText(/pdm_0123456789ab/)).toBeInTheDocument();
    expect(document.body.textContent).not.toContain("pdm_aaaaaaaaaaaa_");
  });

  it("never writes a token or the secret to browser storage", async () => {
    fakeServer();
    render(<AdminView />);
    await unlock();
    fireEvent.change(await screen.findByLabelText("Name"), { target: { value: "Dana" } });
    fireEvent.click(screen.getByRole("button", { name: "Create user" }));
    await screen.findByText(/token: pdm_/);
    const stored = JSON.stringify({ ...localStorage }) + JSON.stringify({ ...sessionStorage });
    expect(stored).not.toContain("pdm_");
    expect(stored).not.toContain("right");
  });

  it("goes back to the lock screen, and forgets the token, when the server says it is locked", async () => {
    const s = fakeServer();
    render(<AdminView />);
    await unlock();
    fireEvent.change(await screen.findByLabelText("Name"), { target: { value: "Dana" } });
    fireEvent.click(screen.getByRole("button", { name: "Create user" }));
    await screen.findByText(/token: pdm_/);
    s.expire = true;
    fireEvent.click(screen.getByRole("button", { name: /Admin log/ }));
    expect(await screen.findByLabelText("Token")).toBeInTheDocument();
    expect(screen.getByText(/locked after 10 minutes/)).toBeInTheDocument();
    expect(document.body.textContent).not.toContain("pdm_aaaaaaaaaaaa_");
  });
});

describe("administrator names (#182)", () => {
  it("draws an administrator's name in the admin color, with no pill, and follows a group change without a reload", async () => {
    const s = fakeServer({ people: 3 });
    s.groups.push({ id: 1, name: "Administrators", builtIn: true }, { id: 2, name: "Team" });
    s.people[0]!.groupId = 1;
    s.people[1]!.groupId = 2;
    s.people[2]!.groupId = 1;
    s.people[2]!.revokedAt = 5;
    render(<AdminView />);
    await unlock();
    const adm = await screen.findByText("person-000");
    expect(adm).toHaveClass("isadmin");
    expect(adm).toHaveAttribute("title", "Administrator: can open Admin with their own token");
    expect(within(adm.parentElement!).getByText("(administrator)")).toHaveClass("vh");
    expect(screen.getByText("person-001")).not.toHaveClass("isadmin");
    expect(screen.getByText("person-002")).not.toHaveClass("isadmin");
    expect(screen.queryByText("administrator")).toBeNull();
    fireEvent.change(screen.getByLabelText("Group for person-001"), { target: { value: "1" } });
    await waitFor(() => expect(screen.getByText("person-001")).toHaveClass("isadmin"));
    fireEvent.change(screen.getByLabelText("Group for person-000"), { target: { value: "2" } });
    await waitFor(() => expect(screen.getByText("person-000")).not.toHaveClass("isadmin"));
  });
});

describe("deleting people (#243)", () => {
  it("selects rows, confirms in a dialog that names them, and deletes exactly those", async () => {
    const s = fakeServer({ people: 4 });
    render(<AdminView />);
    await unlock();
    await screen.findByText("person-000");
    expect(screen.queryByText(/selected/)).toBeNull();
    fireEvent.click(screen.getByLabelText("Select person-000"));
    fireEvent.click(screen.getByLabelText("Select person-002"));
    expect(screen.getByText("2 selected")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Delete 2…" }));
    const dialog = screen.getByRole("dialog", { name: "Delete 2 people?" });
    expect(within(dialog).getByText(/Their reporters are refused at once\. Their past sessions keep their name\./)).toBeInTheDocument();
    expect(within(dialog).getByText("person-000")).toBeInTheDocument();
    expect(within(dialog).getByText("person-002")).toBeInTheDocument();
    expect(s.deleteBodies).toEqual([]);
    fireEvent.click(within(dialog).getByRole("button", { name: "Delete 2 people" }));
    await waitFor(() => expect(screen.queryByText("person-000")).toBeNull());
    expect(s.deleteBodies).toEqual([{ ids: [1, 3] }]);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getByText("person-001")).toBeInTheDocument();
    expect(screen.getByText("person-003")).toBeInTheDocument();
    expect(screen.queryByText(/selected/)).toBeNull();
    expect(within(screen.getByRole("button", { name: /^People(?! and)/ })).getByText("2")).toBeInTheDocument();
  });

  it("selects every row on the page with the header box, and Clear drops the selection", async () => {
    fakeServer({ people: 3 });
    render(<AdminView />);
    await unlock();
    await screen.findByText("person-000");
    fireEvent.click(screen.getByLabelText("Select all 3 on this page"));
    expect(screen.getByText("3 selected")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Clear" }));
    expect(screen.queryByText(/selected/)).toBeNull();
    expect(screen.getByLabelText("Select person-001")).not.toBeChecked();
  });

  it("deletes one person from their row, after a dialog, and Cancel deletes nothing", async () => {
    const s = fakeServer({ people: 3 });
    render(<AdminView />);
    await unlock();
    await screen.findByText("person-001");
    const row = screen.getByText("person-001").closest("tr")!;
    fireEvent.click(within(row).getByRole("menuitem", { name: "Delete…" }));
    let dialog = screen.getByRole("dialog", { name: "Delete person-001?" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(s.deleteBodies).toEqual([]);
    fireEvent.click(within(row).getByRole("menuitem", { name: "Delete…" }));
    dialog = screen.getByRole("dialog", { name: "Delete person-001?" });
    expect(within(dialog).getByText(/Their reporter is refused at once\. Their past sessions keep their name\./)).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(screen.queryByText("person-001")).toBeNull());
    expect(s.deleteBodies).toEqual([{ ids: [2] }]);
  });

  it("tells an Administrator's dialog that their open Admin session locks, and a revoked row still has Delete", async () => {
    const s = fakeServer({ people: 2 });
    s.groups.push({ id: 1, name: "Administrators", builtIn: true });
    s.people[0]!.groupId = 1;
    s.people[1]!.revokedAt = 5;
    render(<AdminView />);
    await unlock();
    await screen.findByText("person-000");
    fireEvent.click(within(screen.getByText("person-000").closest("tr")!).getByRole("menuitem", { name: "Delete…" }));
    expect(within(screen.getByRole("dialog")).getByText(/Their open Admin session locks\./)).toBeInTheDocument();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(within(screen.getByText("person-001").closest("tr")!).getByRole("menuitem", { name: "Delete…" })).toBeInTheDocument();
  });

  it("shows the server's refusal in the dialog and leaves everyone in the list", async () => {
    const s = fakeServer({ people: 2 });
    s.deleteError = "You are signed in to Admin as this person, so they cannot be deleted. Nothing was deleted.";
    render(<AdminView />);
    await unlock();
    await screen.findByText("person-000");
    fireEvent.click(within(screen.getByText("person-000").closest("tr")!).getByRole("menuitem", { name: "Delete…" }));
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Delete" }));
    expect(await within(screen.getByRole("dialog")).findByRole("alert")).toHaveTextContent(/signed in to Admin as this person/);
    expect(screen.getByText("person-000")).toBeInTheDocument();
    expect(screen.getByText("person-001")).toBeInTheDocument();
  });
});

describe("paging and search", () => {
  it("asks the server for 50 at a time, pages forward and back, and searches", async () => {
    const s = fakeServer({ people: 125 });
    render(<AdminView />);
    await unlock();
    expect(await screen.findByText("Showing 1 to 50 of 125")).toBeInTheDocument();
    expect(screen.getAllByRole("row")).toHaveLength(51);
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    expect(await screen.findByText("Showing 51 to 100 of 125")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    expect(await screen.findByText("Showing 101 to 125 of 125")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Next" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Previous" }));
    expect(await screen.findByText("Showing 51 to 100 of 125")).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Search people"), { target: { value: "person-099" } });
    expect(await screen.findByText("Showing 1 to 1 of 1")).toBeInTheDocument();
    expect(s.calls.some((c) => c.includes("q=person-099") && c.includes("page=1"))).toBe(true);
    fireEvent.change(screen.getByLabelText("Search people"), { target: { value: "zzz" } });
    expect(await screen.findByText(/No one matches/)).toBeInTheDocument();
    // Seven round trips through a 50-row table, and each row has a selection box and a Delete button since #243. The coverage
    // run on a shared CI runner is slow, and 15 s was not enough: the Sonar run failed on this test for #393 and #394.
  }, 60_000);

  it("changes the rows per page and returns to page one", async () => {
    // 60 people is enough for a second page and a smaller page size, and keeps the table small: with 125 this test took
    // 5.7 s on the CI runner against the 5 s default (#477). The limit is wide for the same reason as the test above.
    const s = fakeServer({ people: 60 });
    render(<AdminView />);
    await unlock();
    await screen.findByText("Showing 1 to 50 of 60");
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    await screen.findByText("Showing 51 to 60 of 60");
    fireEvent.change(screen.getByLabelText("Rows per page"), { target: { value: "25" } });
    expect(await screen.findByText("Showing 1 to 25 of 60")).toBeInTheDocument();
    expect(s.calls[s.calls.length - 1]).toContain("pageSize=25");
  }, 60_000);
});

describe("side menu", () => {
  it("lists every page in its group and shows each page under its own heading", async () => {
    fakeServer();
    render(<AdminView />);
    await unlock();
    const nav = screen.getByRole("navigation", { name: "Admin sections" });
    expect(within(nav).getAllByRole("button").map((b) => b.textContent)).toEqual([
      expect.stringMatching(/^People/),
      expect.stringMatching(/^Groups/),
      expect.stringMatching(/^Reporters/),
      "Settings",
      "Model prices",
      "Security",
      "Certificates",
      "Data",
      "Stored activity",
      "Usage",
      expect.stringMatching(/^Spend/),
      "People and groups",
      "Sessions",
      "Failures",
      "Admin activity",
      expect.stringMatching(/^Admin log/),
      "Lock Admin",
    ]);
    expect(within(nav).getByRole("group", { name: "Server" })).toBeInTheDocument();
    // Reporting is its own group (#484); Activity keeps only the Admin log.
    expect(within(within(nav).getByRole("group", { name: "Reporting" })).getAllByRole("button")).toHaveLength(6);
    expect(within(within(nav).getByRole("group", { name: "Activity" })).getAllByRole("button")).toHaveLength(1);
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("People");
    fireEvent.click(within(nav).getByRole("button", { name: /Groups/ }));
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Groups");
    expect(within(nav).getByRole("button", { name: /Groups/ })).toHaveAttribute("aria-current", "page");
    expect(within(nav).getByRole("button", { name: /^People(?! and)/ })).not.toHaveAttribute("aria-current");
    fireEvent.click(within(nav).getByRole("button", { name: /Admin log/ }));
    expect(within(nav).getByRole("button", { name: /Admin log/ })).toHaveAttribute("aria-current", "page");
    await waitFor(() => expect(screen.getByText("Wrong secret (1)")).toBeInTheDocument());
  });
});

describe("Settings tab (#114)", () => {
  it("lists the wall notices and the background-sessions row with switches that follow the server", async () => {
    const srv = fakeServer();
    render(<AdminView />);
    await unlock();
    fireEvent.click(screen.getByRole("button", { name: /^Settings/ }));
    const notice = await screen.findByRole("switch", { name: /Background sessions/ });
    expect(notice).toHaveAttribute("aria-checked", "true");
    const show = screen.getByRole("switch", { name: /Show background sessions on the wall/ });
    expect(show).toHaveAttribute("aria-checked", "false");
    fireEvent.click(notice);
    await waitFor(() => expect(screen.getByRole("switch", { name: /Background sessions \u00a0?Off|Background sessions Off/ })).toHaveAttribute("aria-checked", "false"));
    expect(srv.notices["background-sessions"]).toBe(false);
    fireEvent.click(show);
    await waitFor(() => expect(srv.showBackground).toBe(true));
  });

  it("has a Title cards with the machine switch, off by default, that saves for everyone (#480)", async () => {
    const srv = fakeServer();
    render(<AdminView />);
    await unlock();
    fireEvent.click(screen.getByRole("button", { name: /^Settings/ }));
    const title = await screen.findByRole("switch", { name: /Title cards with the machine/ });
    expect(title).toHaveAttribute("aria-checked", "false");
    fireEvent.click(title);
    await waitFor(() => expect(srv.cardTitleMachine).toBe(true));
    await waitFor(() => expect(screen.getByRole("switch", { name: /Title cards with the machine/ })).toHaveAttribute("aria-checked", "true"));
  });

  it("puts Feature flags above Wall notices, with the activity feed's switch, id and description (#118)", async () => {
    const srv = fakeServer();
    render(<AdminView />);
    await unlock();
    fireEvent.click(screen.getByRole("button", { name: /^Settings/ }));
    const flag = await screen.findByRole("switch", { name: /Agent activity feed/ });
    expect(flag).toHaveAttribute("aria-checked", "true");
    const headings = screen.getAllByRole("heading", { level: 2 }).map((h) => h.textContent);
    expect(headings.indexOf("Feature flags")).toBeGreaterThanOrEqual(0);
    expect(headings.indexOf("Feature flags")).toBeLessThan(headings.indexOf("Wall notices"));
    expect(screen.getByText(/Turn a feature off for everyone on this server\./)).toBeInTheDocument();
    expect(screen.getByText("activity-feed")).toBeInTheDocument();
    expect(screen.getByText(/Shows an agent's recent tool calls and text in its panel/)).toBeInTheDocument();
    fireEvent.click(flag);
    await waitFor(() => expect(screen.getByRole("switch", { name: /Agent activity feed/ })).toHaveAttribute("aria-checked", "false"));
    expect(srv.bodies).toContainEqual({ features: { "activity-feed": false } });
    expect(srv.features["activity-feed"]).toBe(false);
    expect(screen.getByRole("switch", { name: /Agent activity feed/ })).toHaveAccessibleName(/Off$/);
  });

  it("opens on the Settings tab for #/admin/settings, the link a closed notice points to", async () => {
    fakeServer();
    window.location.hash = "#/admin/settings";
    render(<AdminView />);
    await unlock();
    expect(screen.getByRole("button", { name: /^Settings/ })).toHaveAttribute("aria-current", "page");
    window.location.hash = "";
  });
});

describe("Model prices (#117)", () => {
  async function open() {
    const srv = fakeServer();
    render(<AdminView />);
    await unlock();
    fireEvent.click(screen.getByRole("button", { name: "Model prices" }));
    await screen.findByRole("heading", { name: "Prices by model" });
    return srv;
  }
  const field = (name: string) => screen.getByLabelText(name) as HTMLInputElement;

  it("lists a row per model with its five prices, and a second row for prompts over 100,000 tokens", async () => {
    await open();
    expect(field("Sonnet 5.5 input").value).toBe("2");
    expect(field("Sonnet 5.5 cache write 1 hour").value).toBe("4");
    expect(field("Haiku 5.5 input").value).toBe("0.1");
    expect(field("Haiku 5.5 over 100,000 input").value).toBe("0.5");
    expect(screen.queryByLabelText("Sonnet 5.5 over 100,000 input")).toBeNull();
  });

  it("names both of a model's price tiers the same way, each with its prompt size", async () => {
    await open();
    expect(screen.getAllByText("Haiku 5.5")).toHaveLength(2);
    expect(screen.getByText("Prompts up to 100,000 tokens")).toBeInTheDocument();
    expect(screen.getByText("Prompts over 100,000 tokens")).toBeInTheDocument();
  });

  it("saves an edited row with all its prices, then marks it changed and offers a reset", async () => {
    const srv = await open();
    expect(screen.queryByRole("button", { name: /Save Sonnet 5.5/ })).toBeNull();
    fireEvent.change(field("Sonnet 5.5 input"), { target: { value: "2.4" } });
    fireEvent.click(screen.getByRole("button", { name: "Save Sonnet 5.5" }));
    await waitFor(() => expect(srv.prices["sonnet-5-5"]!.std).toEqual({ input: 2.4, output: 10, cacheRead: 0.1, cacheWrite: 2.5, cacheWrite1h: 4 }));
    expect(await screen.findByRole("button", { name: "Reset Sonnet 5.5 to built-in" })).toBeInTheDocument();
    expect(screen.getByText("Changed")).toBeInTheDocument();
  });

  it("cancel puts the saved value back without calling the server", async () => {
    const srv = await open();
    fireEvent.change(field("Sonnet 5.5 input"), { target: { value: "9" } });
    fireEvent.click(screen.getByRole("button", { name: "Cancel Sonnet 5.5" }));
    expect(field("Sonnet 5.5 input").value).toBe("2");
    expect(srv.calls.some((c) => c.startsWith("PUT /settings"))).toBe(false);
  });

  it("resets a changed row to the built-in price", async () => {
    const srv = await open();
    fireEvent.change(field("Sonnet 5.5 input"), { target: { value: "2.4" } });
    fireEvent.click(screen.getByRole("button", { name: "Save Sonnet 5.5" }));
    fireEvent.click(await screen.findByRole("button", { name: "Reset Sonnet 5.5 to built-in" }));
    await waitFor(() => expect(srv.prices["sonnet-5-5"]!.std.input).toBe(2));
    await waitFor(() => expect(field("Sonnet 5.5 input").value).toBe("2"));
    expect(screen.queryByRole("button", { name: "Reset Sonnet 5.5 to built-in" })).toBeNull();
  });

  it.each([
    ["negative", "-1", /zero or more/],
    ["not a number", "abc", /number/],
    ["empty", "", /number/],
    ["over the bound", "5000", /at most 1000/],
  ])("refuses a %s price on the page and sends nothing", async (_n, value, msg) => {
    const srv = await open();
    fireEvent.change(field("Sonnet 5.5 output"), { target: { value } });
    fireEvent.click(screen.getByRole("button", { name: "Save Sonnet 5.5" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(msg);
    expect(field("Sonnet 5.5 output")).toHaveAttribute("aria-invalid", "true");
    expect(srv.calls.some((c) => c.startsWith("PUT /settings"))).toBe(false);
  });

  it("shows the server's message when it refuses a price", async () => {
    const srv = await open();
    srv.priceError = "output must be at most 1000 USD per million tokens";
    fireEvent.change(field("Sonnet 5.5 output"), { target: { value: "12" } });
    fireEvent.click(screen.getByRole("button", { name: "Save Sonnet 5.5" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("at most 1000");
  });

  it("adds a model by id as a row to fill in, saves it, and can remove it", async () => {
    const srv = await open();
    fireEvent.change(screen.getByLabelText("Model id"), { target: { value: "My-Local-Model" } });
    fireEvent.click(screen.getByRole("button", { name: "Add model" }));
    for (const [f, v] of [["input", "0.3"], ["output", "0.9"], ["cache read", "0"], ["cache write 5 minutes", "0"], ["cache write 1 hour", "0"]]) {
      fireEvent.change(field(`my-local-model ${f}`), { target: { value: v } });
    }
    fireEvent.click(screen.getByRole("button", { name: "Save my-local-model" }));
    await waitFor(() => expect(srv.prices["my-local-model"]!.std.input).toBe(0.3));
    fireEvent.click(await screen.findByRole("button", { name: "Remove my-local-model" }));
    await waitFor(() => expect(srv.prices["my-local-model"]).toBeUndefined());
  });

  it("refuses to add a model id that is already in the table", async () => {
    await open();
    fireEvent.change(screen.getByLabelText("Model id"), { target: { value: "sonnet-5-5" } });
    fireEvent.click(screen.getByRole("button", { name: "Add model" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/already/);
  });
});

describe("Reporters tab (#142)", () => {
  async function openReporters() {
    const state = fakeServer();
    render(<AdminView />);
    await unlock();
    fireEvent.click(screen.getByRole("button", { name: /Reporters/ }));
    await screen.findByRole("table");
    return state;
  }

  it("lists reporters with a count on the tab, the state strip and the versions, and says what Silent means", async () => {
    await openReporters();
    expect(screen.getByRole("button", { name: /Reporters/ })).toHaveTextContent("2");
    const rows = within(screen.getByRole("table")).getAllByRole("row");
    expect(rows).toHaveLength(3);
    expect(rows[1]).toHaveTextContent("studio-m2");
    expect(rows[1]).toHaveTextContent("1 min ago");
    expect(rows[1]).toHaveTextContent("142");
    expect(rows[1]).toHaveTextContent("3 live");
    expect(rows[2]).toHaveTextContent("no machine id, matched by address 10.4.0.52");
    expect(rows[2]).toHaveTextContent("0.9.2 outdated");
    // Issue #181: the notes are tooltips, not running text under the table.
    for (const note of [/does not mean the reporter is turned off/, /is what every reporter reads after this server restarts/]) {
      for (const el of screen.queryAllByText(note)) {
        expect(el).toHaveAttribute("role", "tooltip");
        expect(el).toHaveAttribute("hidden");
      }
    }
    const strip = screen.getByRole("group", { name: "Filter by state" });
    expect(within(strip).getByRole("button", { name: /Silent/ })).toHaveAttribute("title", expect.stringContaining("does not mean the reporter is turned off"));
    expect(within(strip).getByRole("button", { name: /Not since restart/ })).toHaveAttribute("title", expect.stringContaining("is what every reporter reads after this server restarts"));
    const silentChip = within(rows[2]!).getByText("Silent");
    expect(silentChip).toHaveAccessibleDescription(expect.stringContaining("does not mean the reporter is turned off"));
    expect(within(strip).getByRole("button", { name: /Silent/ })).toHaveTextContent("1");
  });

  it("explains each row's state and an unnamed reporter on hover and on keyboard focus (issue #166)", async () => {
    await openReporters();
    const rows = within(screen.getByRole("table")).getAllByRole("row");
    const silent = within(rows[2]!).getByText("Silent");
    expect(silent).toHaveAttribute("tabindex", "0");
    expect(silent).toHaveAccessibleDescription(expect.stringContaining("Last heard"));
    const silentTip = within(rows[2]!).getAllByRole("tooltip", { hidden: true })[0]!;
    expect(silentTip).not.toBeVisible();
    fireEvent.focus(silent);
    expect(silentTip).toBeVisible();
    expect(silentTip).toHaveTextContent("Last heard");
    const why = within(rows[2]!).getByText("no name set");
    expect(why).toHaveAttribute("tabindex", "0");
    expect(why).toHaveAccessibleDescription(expect.stringContaining("userName"));
    expect(why).toHaveAccessibleDescription(expect.stringContaining("10.4.0.52"));
    fireEvent.focus(why);
    expect(within(why).getByRole("tooltip")).toBeVisible();
    expect(within(rows[1]!).queryByText("no name set")).toBeNull();
    fireEvent.click(within(rows[2]!).getByRole("button", { name: /Open details/ }));
    expect(await screen.findByText("Why unnamed")).toBeInTheDocument();
  });

  it("warns about a reporter that uses the admin secret: a badge, a banner that filters, and a callout in the detail (issue #166)", async () => {
    const state = await openReporters();
    const rows = within(screen.getByRole("table")).getAllByRole("row");
    expect(within(rows[1]!).queryByText("Admin secret")).toBeNull();
    expect(within(rows[1]!).getByText("pdm_3f9a1c07b2e4")).toBeInTheDocument();
    const badge = within(rows[2]!).getByText("Admin secret");
    expect(badge).toHaveAttribute("tabindex", "0");
    expect(badge).toHaveAccessibleDescription(expect.stringContaining("Admin > People"));
    expect(within(rows[2]!).getByText("Admin")).toBeInTheDocument();
    const banner = screen.getByRole("status", { name: "Reporters using the admin secret" });
    expect(banner).toHaveTextContent("1 reporter uses the admin secret.");
    fireEvent.click(within(banner).getByRole("button", { name: "Show only these" }));
    await waitFor(() => expect(state.calls.some((c) => c.includes("/reporters") && c.includes("admin=1"))).toBe(true));
    await waitFor(() => expect(within(screen.getByRole("table")).getAllByRole("row")).toHaveLength(2));
    expect(within(screen.getByRole("status", { name: "Reporters using the admin secret" })).getByRole("button", { name: "Show all reporters" })).toBeInTheDocument();
    fireEvent.click(within(screen.getByRole("table")).getByRole("button", { name: /Open details/ }));
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("This reporter is using the admin secret");
    expect(alert).toHaveTextContent("/plugin configure podium-reporter");
  });

  it("pages a reporter's recent sessions and shows them and the turned-away reports as their own panels (issue #188)", async () => {
    const state = await openReporters();
    fireEvent.click(screen.getByRole("button", { name: "Open details for studio-m2" }));
    const sessions = await screen.findByRole("region", { name: "Recent sessions" });
    expect(within(sessions).getByRole("heading", { name: "Recent sessions" })).toBeInTheDocument();
    expect(within(screen.getByRole("region", { name: "Reports the server turned away" })).getByText("wrong token")).toBeInTheDocument();
    expect(within(sessions).getByText("session-1")).toBeInTheDocument();
    expect(within(sessions).queryByText("session-51")).toBeNull();
    expect(within(sessions).getByRole("status")).toHaveTextContent("Showing 1 to 50 of 142");
    fireEvent.click(within(sessions).getByRole("button", { name: "Next" }));
    expect(await within(sessions).findByText("session-51")).toBeInTheDocument();
    expect(within(sessions).queryByText("session-1")).toBeNull();
    expect(state.calls).toContain("GET /reporters/9f3a1c7d2e40?page=2&pageSize=50");
    expect(within(sessions).getByRole("status")).toHaveTextContent("Showing 51 to 100 of 142");
    fireEvent.change(within(sessions).getByLabelText("Rows per page"), { target: { value: "100" } });
    expect(await within(sessions).findByText("session-100")).toBeInTheDocument();
    expect(state.calls.some((c) => c.includes("pageSize=100") && c.includes("page=1"))).toBe(true);
  });

  it("shows no admin-secret warning when no reporter uses it", async () => {
    const state = await openReporters();
    state.reporters = state.reporters.map((r) => ({ ...r, adminSecret: false, credential: "pdm_3f9a1c07b2e4" }));
    expect(screen.getByRole("status", { name: "Reporters using the admin secret" })).toBeInTheDocument();
    // The next fetch (here, picking a state) comes back with no admin-secret reporter, and the banner goes.
    fireEvent.click(within(screen.getByRole("group", { name: "Filter by state" })).getByRole("button", { name: /Silent/ }));
    await waitFor(() => expect(screen.queryByRole("status", { name: "Reporters using the admin secret" })).toBeNull());
  });

  it("filters by state through the server, and searches after a pause", async () => {
    const state = await openReporters();
    fireEvent.click(within(screen.getByRole("group", { name: "Filter by state" })).getByRole("button", { name: /Silent/ }));
    await waitFor(() => expect(within(screen.getByRole("table")).getAllByRole("row")).toHaveLength(2));
    expect(state.calls.some((c) => c.includes("/reporters") && c.includes("state=silent"))).toBe(true);
    fireEvent.click(within(screen.getByRole("group", { name: "Filter by state" })).getByRole("button", { name: /All reporters/ }));
    fireEvent.change(screen.getByLabelText("Search reporters"), { target: { value: "studio" } });
    await waitFor(() => expect(state.calls.some((c) => c.includes("q=studio"))).toBe(true));
  });

  it("opens a reporter with its details and no secret, and goes back to the list", async () => {
    const state = await openReporters();
    fireEvent.click(screen.getByRole("button", { name: "Open details for studio-m2" }));
    expect(await screen.findByRole("heading", { name: /studio-m2/ })).toBeInTheDocument();
    expect(state.calls).toContain("GET /reporters/9f3a1c7d2e40?page=1&pageSize=50");
    expect(screen.getByText("pdm_3f9a1c07b2e4")).toBeInTheDocument();
    expect(screen.getByText("192.168.1.24")).toBeInTheDocument();
    expect(screen.getByText("session-1")).toBeInTheDocument();
    expect(screen.getByText("wrong token")).toBeInTheDocument();
    expect(screen.getByText("Supported")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /All reporters/ }));
    expect(await screen.findByRole("table")).toBeInTheDocument();
  });

  it("removes a reporter only after a confirmation, then shows the list without it", async () => {
    const state = await openReporters();
    fireEvent.click(screen.getByRole("button", { name: "Open details for studio-m2" }));
    fireEvent.click(await screen.findByRole("button", { name: "Remove from list" }));
    expect(state.calls.some((c) => c.startsWith("DELETE"))).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "Keep it" }));
    fireEvent.click(screen.getByRole("button", { name: "Remove from list" }));
    fireEvent.click(screen.getByRole("button", { name: "Remove reporter" }));
    await waitFor(() => expect(state.calls).toContain("DELETE /reporters/9f3a1c7d2e40"));
    await waitFor(() => expect(within(screen.getByRole("table")).getAllByRole("row")).toHaveLength(2));
    expect(screen.queryByText("studio-m2")).toBeNull();
  });

  it("selects rows and removes them in one step, after a confirmation that says how many (issue #167)", async () => {
    const state = await openReporters();
    expect(screen.queryByRole("group", { name: "Selected reporters" })).toBeNull();
    fireEvent.click(screen.getByLabelText("Select studio-m2"));
    fireEvent.click(screen.getByLabelText("Select 10.4.0.52"));
    const bar = screen.getByRole("group", { name: "Selected reporters" });
    expect(bar).toHaveTextContent("2 selected");
    fireEvent.click(within(bar).getByRole("button", { name: /Remove 2/ }));
    const confirm = screen.getByRole("group", { name: "Confirm removal" });
    expect(confirm).toHaveTextContent("Remove 2 reporters from the list?");
    expect(confirm).toHaveTextContent("Their sessions are not touched");
    expect(state.removeBodies).toEqual([]);
    fireEvent.click(within(confirm).getByRole("button", { name: "Keep them" }));
    expect(state.removeBodies).toEqual([]);
    fireEvent.click(screen.getByRole("button", { name: /Remove 2/ }));
    fireEvent.click(screen.getByRole("button", { name: "Remove 2 reporters" }));
    await waitFor(() => expect(state.removeBodies).toEqual([{ keys: ["9f3a1c7d2e40", "addr:10.4.0.52"] }]));
    expect(await screen.findByText(/No reporter has connected yet/)).toBeInTheDocument();
    expect(screen.queryByRole("group", { name: "Selected reporters" })).toBeNull();
  });

  it("selects every row on the page with the header box, and offers every match when there are more (issue #167)", async () => {
    const state = await openReporters();
    fireEvent.click(screen.getByLabelText("Select all 2 on this page"));
    expect(screen.getByRole("group", { name: "Selected reporters" })).toHaveTextContent("2 selected");
    fireEvent.click(screen.getByLabelText("Select all 2 on this page"));
    expect(screen.queryByRole("group", { name: "Selected reporters" })).toBeNull();
    state.reporters.push(...Array.from({ length: 3 }, (_, i) => ({ ...state.reporters[0]!, key: `k${i}`, name: `extra-${i}` })));
    state.pageLimit = 2;
    fireEvent.change(screen.getByLabelText("Search reporters"), { target: { value: "e" } });
    await screen.findByText("extra-0");
    fireEvent.click(await screen.findByLabelText("Select all 2 on this page"));
    expect(screen.getByText(/All 2 on this page are selected/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Select all 3 that match" }));
    expect(screen.getByRole("group", { name: "Selected reporters" })).toHaveTextContent("3 selected");
    fireEvent.click(screen.getByRole("button", { name: /Remove 3/ }));
    expect(screen.getByRole("group", { name: "Confirm removal" })).toHaveTextContent("Remove 3 reporters from the list?");
    fireEvent.click(screen.getByRole("button", { name: "Remove 3 reporters" }));
    await waitFor(() => expect(state.removeBodies).toEqual([{ match: { q: "e" } }]));
  });

  it("keeps the other ticked rows when one is unticked after \"select all that match\" (issue #167)", async () => {
    const state = await openReporters();
    state.reporters.push(...Array.from({ length: 3 }, (_, i) => ({ ...state.reporters[0]!, key: `k${i}`, name: `extra-${i}` })));
    state.pageLimit = 2;
    fireEvent.change(screen.getByLabelText("Search reporters"), { target: { value: "e" } });
    await screen.findByText("extra-0");
    fireEvent.click(await screen.findByLabelText("Select all 2 on this page"));
    fireEvent.click(screen.getByRole("button", { name: "Select all 3 that match" }));
    expect(screen.getByRole("group", { name: "Selected reporters" })).toHaveTextContent("3 selected (all that match)");
    fireEvent.click(screen.getByLabelText("Select extra-0"));
    expect(screen.getByRole("group", { name: "Selected reporters" })).toHaveTextContent("1 selected");
    expect(screen.getByLabelText("Select extra-0")).not.toBeChecked();
  });

  it("removes every reporter in a state from the state strip, with the count in the confirmation (issue #167)", async () => {
    const state = await openReporters();
    fireEvent.click(within(screen.getByRole("group", { name: "Filter by state" })).getByRole("button", { name: /Silent/ }));
    await waitFor(() => expect(within(screen.getByRole("table")).getAllByRole("row")).toHaveLength(2));
    fireEvent.click(screen.getByRole("button", { name: "Remove all Silent (1)" }));
    expect(screen.getByRole("group", { name: "Confirm removal" })).toHaveTextContent("Remove 1 reporter from the list?");
    expect(state.removeBodies).toEqual([]);
    fireEvent.click(screen.getByRole("button", { name: "Remove 1 reporter" }));
    await waitFor(() => expect(state.removeBodies).toEqual([{ match: { state: "silent" } }]));
    await waitFor(() => expect(state.reporters.map((r) => r.state)).toEqual(["reporting"]));
  });

  it("says what Remove from list does and does not do in a tooltip, not under the table (issues #167, #181)", async () => {
    await openReporters();
    expect(screen.queryByText(/takes the row away and nothing else/)).toBeNull();
    const rows = within(screen.getByRole("table")).getAllByRole("row");
    fireEvent.click(within(rows[1]!).getByRole("button", { name: /Open details/ }));
    expect(await screen.findByRole("button", { name: "Remove from list" })).toHaveAttribute("title", expect.stringContaining("takes the row away and nothing else"));
  });

  it("shows Ignore rules as its own section after the reporters section (issue #181)", async () => {
    await openReporters();
    const heard = screen.getByRole("region", { name: "Heard from" });
    const rules = screen.getByRole("region", { name: "Ignore rules" });
    expect(heard.contains(rules)).toBe(false);
    expect(heard.compareDocumentPosition(rules) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(within(rules).getByText(/A reporter that matches a rule is refused/)).toBeInTheDocument();
    expect(within(rules).getByRole("button", { name: "Ignore matching reporters" })).toBeInTheDocument();
  });

  it("ignores a reporter from its detail, after saying that its reports are turned away (issue #167)", async () => {
    const state = await openReporters();
    fireEvent.click(screen.getByRole("button", { name: "Open details for studio-m2" }));
    fireEvent.click(await screen.findByRole("button", { name: "Ignore…" }));
    const form = screen.getByRole("group", { name: "Ignore studio-m2" });
    expect(form).toHaveTextContent("Its reports are turned away, so its sessions stop appearing on the fleet.");
    expect(state.rules).toEqual([]);
    fireEvent.click(within(form).getByLabelText(/This reporter only/));
    fireEvent.click(within(form).getByRole("button", { name: "Ignore and remove" }));
    await waitFor(() => expect(state.rules).toEqual([expect.objectContaining({ kind: "key", pattern: "9f3a1c7d2e40" })]));
    expect(await screen.findByRole("table")).toBeInTheDocument();
    expect(screen.queryByText("studio-m2")).toBeNull();
  });

  it("keeps Ignore… and Remove from list together in one actions group beside the name (issue #247)", async () => {
    await openReporters();
    fireEvent.click(screen.getByRole("button", { name: "Open details for studio-m2" }));
    const ignore = await screen.findByRole("button", { name: "Ignore…" });
    const remove = screen.getByRole("button", { name: "Remove from list" });
    expect(ignore.parentElement).toBe(remove.parentElement);
    expect(ignore.parentElement).toHaveClass("dacts");
    expect(ignore.compareDocumentPosition(remove) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    fireEvent.click(remove);
    const keep = await screen.findByRole("button", { name: "Keep it" });
    expect(keep.closest(".dacts")).not.toBeNull();
  });

  it("lists the ignore rules, adds one by pattern, and removes one to undo it (issue #167)", async () => {
    const state = await openReporters();
    expect(await screen.findByText("No rules. Every reporter is accepted.")).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Rule matches"), { target: { value: "version" } });
    fireEvent.change(screen.getByLabelText("Pattern"), { target: { value: "0.9.*" } });
    fireEvent.click(screen.getByRole("button", { name: "Ignore matching reporters" }));
    await waitFor(() => expect(state.rules).toEqual([expect.objectContaining({ kind: "version", pattern: "0.9.*" })]));
    const rules = await screen.findByRole("table", { name: "Ignore rules" });
    expect(within(rules).getByText("0.9.*")).toBeInTheDocument();
    expect(screen.getByText(/A reporter that matches a rule is refused/)).toBeInTheDocument();
    fireEvent.click(within(rules).getByRole("button", { name: "Remove the rule for 0.9.*" }));
    await waitFor(() => expect(state.rules).toEqual([]));
    expect(await screen.findByText("No rules. Every reporter is accepted.")).toBeInTheDocument();
  });

  it("asks the server again on its own, so a state that changed shows without a reload", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    try {
      const state = await openReporters();
      const first = state.calls.filter((c) => c.startsWith("GET /reporters")).length;
      state.reporters[0]!.state = "silent";
      await vi.advanceTimersByTimeAsync(REFRESH_MS + 100);
      await waitFor(() => expect(within(screen.getByRole("table")).getAllByRole("row")[1]).toHaveTextContent("Silent"));
      expect(state.calls.filter((c) => c.startsWith("GET /reporters")).length).toBeGreaterThan(first);
    } finally {
      vi.useRealTimers();
    }
  });

  it("locks Admin again when the session has ended", async () => {
    const state = await openReporters();
    state.expire = true;
    fireEvent.click(within(screen.getByRole("group", { name: "Filter by state" })).getByRole("button", { name: /Silent/ }));
    expect(await screen.findByLabelText("Token")).toBeInTheDocument();
  });
});

describe("Forget old reporters setting (issue #167)", () => {
  async function openSettings() {
    const state = fakeServer();
    render(<AdminView />);
    await unlock();
    fireEvent.click(screen.getByRole("button", { name: /Settings/ }));
    await screen.findByRole("switch", { name: /Forget old reporters/ });
    return state;
  }

  it("is off by default at 30 days, turns on, and saves a new number of days", async () => {
    const state = await openSettings();
    const sw = screen.getByRole("switch", { name: /Forget old reporters/ });
    expect(sw).toHaveAttribute("aria-checked", "false");
    expect(screen.getByLabelText("Days")).toHaveValue(30);
    fireEvent.click(sw);
    await waitFor(() => expect(state.forget.enabled).toBe(true));
    fireEvent.change(screen.getByLabelText("Days"), { target: { value: "14" } });
    fireEvent.blur(screen.getByLabelText("Days"));
    await waitFor(() => expect(state.forget.days).toBe(14));
  });

  it("does not send days outside 1 to 3650", async () => {
    const state = await openSettings();
    fireEvent.change(screen.getByLabelText("Days"), { target: { value: "0" } });
    fireEvent.blur(screen.getByLabelText("Days"));
    expect(await screen.findByText(/whole number of days from 1 to 3650/)).toBeInTheDocument();
    expect(state.forget.days).toBe(30);
  });
});

describe("Admin top bar reporters pill (#187)", () => {
  it("sits beside the Admin pill and counts the reporters that are not stale", async () => {
    fakeServer();
    const body = makeState({ sessions: [makeSession({ id: "a", status: "running" }), makeSession({ id: "b", status: "waiting" }), makeSession({ id: "c", status: "stale" })] });
    const quiet: FleetSource = new QuietSource() as unknown as FleetSource;
    render(<AdminView fleetOptions={{ open: () => quiet, fetchState: async () => body }} />);
    const pill = await screen.findByText(/2 reporters live/);
    expect(pill.previousElementSibling).toHaveTextContent("Admin");
  });

  it("pulses its green dot on the same beat as the fleet page", async () => {
    fakeServer();
    const body = makeState({ sessions: [makeSession({ id: "a", status: "running" })] });
    const quiet: FleetSource = new QuietSource() as unknown as FleetSource;
    const { container } = render(<AdminView fleetOptions={{ open: () => quiet, fetchState: async () => body }} />);
    await screen.findByText(/1 reporter live/);
    expect(container.querySelector(".podium")).toHaveAttribute("data-beat");
  });
});
