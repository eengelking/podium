// Admin > People with certificates (#587, T9): the two credential cells, the Actions menu, the confirmation rows and the show-once box.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { AdminView } from "./AdminView";
import { fakeServer } from "./fakeAdmin";
import { certCell } from "./peopleCert";
import type { PersonRow } from "./adminApi";

const NOW = Date.parse("2026-10-21T12:00:00Z");

class QuietSource {
  onerror = null;
  readyState = 1;
  addEventListener() {}
  close() {}
}
beforeEach(() => {
  localStorage.clear();
  vi.stubGlobal("EventSource", QuietSource);
  // Days left are counted from now, so the clock is fixed; timers stay real because the page waits on fetches.
  vi.useFakeTimers({ toFake: ["Date"], now: NOW });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const day = (n: number) => new Date(NOW + n * 86_400_000).toISOString();
const person = (certificate: PersonRow["certificate"]) => ({ certificate }) as PersonRow;

async function unlock() {
  fireEvent.change(await screen.findByLabelText("Name"), { target: { value: "Priya" } });
  fireEvent.change(screen.getByLabelText("Token"), { target: { value: "right" } });
  fireEvent.click(screen.getByRole("button", { name: "Unlock Admin" }));
  await screen.findByRole("navigation", { name: "Admin sections" });
}
const rowOf = (name: string) => screen.getByText(name).closest("tr")!;
const confirmRow = () => document.querySelector<HTMLElement>("tr.confirmrow")!;
const choose = (name: string, item: string) => fireEvent.click(within(rowOf(name)).getByRole("menuitem", { name: item }));

describe("the Reporter certificate cell", () => {
  it("says nothing while TLS is off", () => {
    expect(certCell(person(null), false, 30, NOW)).toBeNull();
  });
  it("reads none, revoked, valid, renewal due, in grace and expired", () => {
    expect(certCell(person(null), true, 30, NOW)).toMatchObject({ stage: "off", text: "none", live: false, downloadable: false });
    expect(certCell(person({ notAfter: day(40), revoked: true }), true, 30, NOW)).toMatchObject({ stage: "off", text: "revoked", live: false, downloadable: false });
    expect(certCell(person({ notAfter: day(71), revoked: false }), true, 30, NOW)).toMatchObject({ stage: "ok", text: "valid", live: true, downloadable: true });
    const due = certCell(person({ notAfter: day(23), revoked: false }), true, 30, NOW)!;
    expect(due).toMatchObject({ stage: "soon", text: "renewal due", live: true });
    expect(due.note).toContain("renews it itself");
    const grace = certCell(person({ notAfter: day(-8), revoked: false }), true, 30, NOW)!;
    expect(grace).toMatchObject({ stage: "serious", text: "expired, in grace", live: true });
    expect(grace.note).toContain("22 more days");
    const dead = certCell(person({ notAfter: day(-51), revoked: false }), true, 30, NOW)!;
    expect(dead).toMatchObject({ stage: "expired", text: "expired", live: false, downloadable: true });
    expect(dead.note).toContain("past the 30-day grace");
  });
});

describe("the People table", () => {
  it("has a cell for each credential, no Status column, and the token id in the token's note", async () => {
    const s = fakeServer({ people: 3 });
    s.tls = true;
    s.people[0]!.certificate = { notAfter: day(71), revoked: false };
    s.people[1]!.certificate = { notAfter: day(-51), revoked: false };
    s.people[2]!.revokedAt = 5;
    s.people[2]!.certificate = { notAfter: day(40), revoked: true };
    render(<AdminView />);
    await unlock();
    await screen.findByText("person-000");
    const heads = within(screen.getByRole("table")).getAllByRole("columnheader").map((h) => h.textContent);
    expect(heads).toEqual(["", "Person", "Machines seen", "Reporter certificate", "Console token", "Last report", "Actions"]);
    expect(within(rowOf("person-000")).getByText("valid")).toBeInTheDocument();
    expect(within(rowOf("person-001")).getByText("expired")).toBeInTheDocument();
    expect(within(rowOf("person-002")).getAllByText("revoked")).toHaveLength(2);
    expect(within(rowOf("person-000")).getByText("active").closest(".tip")).toHaveAccessibleDescription("Token pdm_0123456789ab.");
    expect(within(rowOf("person-000")).getByText("valid").closest(".tip")).toHaveAccessibleDescription("Expires 2026-12-31, 71 days left.");
    // The Group select sits in the person's cell.
    expect(within(rowOf("person-000")).getByLabelText("Group for person-000")).toBeInTheDocument();
  });

  it("says TLS is off, and disables the certificate actions", async () => {
    fakeServer({ people: 1 });
    render(<AdminView />);
    await unlock();
    await screen.findByText("person-000");
    expect(within(rowOf("person-000")).getByText("TLS is off")).toBeInTheDocument();
    for (const name of ["Download certificate", "Reissue config…", "Revoke certificate", "Revoke all…"]) expect(within(rowOf("person-000")).getByRole("menuitem", { name })).toBeDisabled();
    expect(within(rowOf("person-000")).getByRole("menuitem", { name: "Rotate token" })).toBeEnabled();
  });
});

describe("the Actions menu", () => {
  it("groups the actions, disables what does not apply, and moves with the arrow keys, Home, End and Escape", async () => {
    const s = fakeServer({ people: 1 });
    s.tls = true;
    s.people[0]!.certificate = { notAfter: day(71), revoked: false };
    render(<AdminView />);
    await unlock();
    await screen.findByText("person-000");
    const row = rowOf("person-000");
    const menu = within(row).getByRole("menu");
    expect(within(menu).getAllByRole("group").map((g) => g.getAttribute("aria-label"))).toEqual(["Console token", "Reporter certificate", "Person"]);
    const summary = within(row).getByText("Actions", { selector: "summary" });
    const details = summary.closest("details")!;
    act(() => {
      details.open = true;
      details.dispatchEvent(new Event("toggle"));
    });
    const items = within(menu).getAllByRole("menuitem");
    expect(items[0]).toHaveFocus();
    fireEvent.keyDown(menu, { key: "ArrowDown" });
    expect(items[1]).toHaveFocus();
    fireEvent.keyDown(menu, { key: "ArrowUp" });
    expect(items[0]).toHaveFocus();
    fireEvent.keyDown(menu, { key: "ArrowUp" });
    expect(items[items.length - 1]).toHaveFocus();
    fireEvent.keyDown(menu, { key: "Home" });
    expect(items[0]).toHaveFocus();
    fireEvent.keyDown(menu, { key: "End" });
    expect(items[items.length - 1]).toHaveFocus();
    fireEvent.keyDown(menu, { key: "x" });
    expect(items[items.length - 1]).toHaveFocus();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(details.open).toBe(false);
    expect(summary).toHaveFocus();
    // Clicking outside, focus leaving, scrolling and resizing each close it.
    for (const close of [() => fireEvent.click(document.body), () => fireEvent.blur(items[0]!, { relatedTarget: document.body }), () => fireEvent.scroll(document.body), () => fireEvent(window, new Event("resize"))]) {
      act(() => {
        details.open = true;
        details.dispatchEvent(new Event("toggle"));
      });
      close();
      expect(details.open).toBe(false);
    }
  });

  it("offers Issue new token to a person whose token is revoked, and Reissue config to one whose certificate is gone", async () => {
    const s = fakeServer({ people: 1 });
    s.tls = true;
    s.people[0]!.revokedAt = 5;
    s.people[0]!.certificate = { notAfter: day(40), revoked: true };
    render(<AdminView />);
    await unlock();
    await screen.findByText("person-000");
    const row = rowOf("person-000");
    expect(within(row).queryByRole("menuitem", { name: "Rotate token" })).toBeNull();
    expect(within(row).getByRole("menuitem", { name: "Issue new token" })).toBeEnabled();
    expect(within(row).getByRole("menuitem", { name: "Reissue config…" })).toBeEnabled();
    expect(within(row).getByRole("menuitem", { name: "Revoke all…" })).toBeDisabled();
    expect(within(row).getByRole("menuitem", { name: "Download certificate" })).toBeDisabled();
  });
});

describe("the confirmation row", () => {
  async function open(over: (s: ReturnType<typeof fakeServer>) => void = () => {}) {
    const s = fakeServer({ people: 2 });
    s.tls = true;
    s.groups.push({ id: 1, name: "Administrators", builtIn: true });
    s.people[0]!.certificate = { notAfter: day(71), revoked: false };
    s.people[1]!.groupId = 1;
    s.people[1]!.certificate = { notAfter: day(71), revoked: false };
    over(s);
    render(<AdminView />);
    await unlock();
    await screen.findByText("person-000");
    return s;
  }
  it.each([
    ["Revoke certificate", "Revoke person-000’s certificate?", "Their reporter is refused at once. They can still sign in to the console.", "POST /people/1/certificate/revoke"],
    ["Revoke token", "Revoke person-000’s token?", "They can no longer sign in to the console. Their reporter is refused too, because revoking the token revokes the certificate.", "POST /people/1/revoke"],
    ["Revoke all…", "Revoke all for person-000?", "Their reporter and their console sign-in stop at once. Their open sessions stay on the wall until they end.", "POST /people/1/revoke-all"],
  ])("%s names what will happen in a full-width row, and does it only on the button", async (item, title, body, call) => {
    const s = await open();
    choose("person-000", item);
    const row = confirmRow();
    expect(row).toBeInTheDocument();
    expect(row.querySelector("td")).toHaveAttribute("colspan", "7");
    expect(within(row as HTMLElement).getByRole("alert")).toHaveTextContent(title);
    expect(row).toHaveTextContent(body);
    expect(row.previousElementSibling).toBe(rowOf("person-000"));
    expect(s.calls).not.toContain(call);
    fireEvent.click(within(row as HTMLElement).getByRole("button", { name: item.replace("…", "") }));
    await waitFor(() => expect(s.calls).toContain(call));
    await waitFor(() => expect(confirmRow()).toBeNull());
  });

  it("Cancel closes it and does nothing", async () => {
    const s = await open();
    choose("person-000", "Revoke certificate");
    fireEvent.click(within(confirmRow() as HTMLElement).getByRole("button", { name: "Cancel" }));
    expect(confirmRow()).toBeNull();
    expect(s.calls.filter((c) => c.startsWith("POST /people/"))).toEqual([]);
  });

  it("tells an Administrator's revoke that their open Admin session locks, and shows a refusal in place", async () => {
    const s = await open((x) => (x.personError = "Add or move another Administrator first."));
    choose("person-001", "Revoke token");
    expect(confirmRow()).toHaveTextContent("Their open Admin session locks.");
    fireEvent.click(within(confirmRow() as HTMLElement).getByRole("button", { name: "Revoke token" }));
    expect(await screen.findByText("Add or move another Administrator first.")).toBeInTheDocument();
    expect(s.people[1]!.revokedAt).toBeNull();
  });

  it("words a rotation, and says a revoked token without TLS is refused at once", async () => {
    fakeServer({ people: 1 });
    render(<AdminView />);
    await unlock();
    await screen.findByText("person-000");
    choose("person-000", "Revoke token");
    expect(confirmRow()).toHaveTextContent("Their reporter is refused at once.");
    choose("person-000", "Rotate token");
    expect(confirmRow()).toHaveTextContent("Their reporter keeps working.");
    expect(document.querySelectorAll("tr.confirmrow")).toHaveLength(1);
  });
});

describe("the show-once box", () => {
  const saved: { href: string; download: string }[] = [];
  beforeEach(() => {
    saved.length = 0;
    vi.stubGlobal("URL", Object.assign(URL, { createObjectURL: () => "blob:x", revokeObjectURL: () => {} }));
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) {
      saved.push({ href: this.href, download: this.download });
    });
  });

  it("gives the token and the reporter config after Create user, with no primary button in the box", async () => {
    fakeServer().tls = true;
    render(<AdminView />);
    await unlock();
    fireEvent.change(await screen.findByLabelText("Name"), { target: { value: "Dana" } });
    fireEvent.click(screen.getByRole("button", { name: "Create user" }));
    const box = (await screen.findByRole("heading", { name: "Token and reporter config for Dana" })).closest("section")!;
    expect(box).toHaveTextContent("token: pdm_aaaaaaaaaaaa_");
    expect(box).toHaveTextContent("reporter-config-dana-1760000000.pem");
    expect(box).toHaveTextContent("~/.podium/");
    expect(box).toHaveTextContent("PODIUM_REPORTER_CONFIG");
    expect(box).toHaveTextContent("needs Node.js on the machine’s PATH");
    expect(box.querySelector(".btn.pri")).toBeNull();
    fireEvent.click(within(box).getByRole("button", { name: "Download reporter config" }));
    expect(saved).toEqual([{ href: "blob:x", download: "reporter-config-dana-1760000000.pem" }]);
    expect(within(box).getByRole("status")).toHaveTextContent("Saved reporter-config-dana-1760000000.pem.");
    fireEvent.click(within(box).getByRole("button", { name: "I have saved it" }));
    expect(screen.queryByRole("heading", { name: /Dana/ })).toBeNull();
  });

  it("copies the token settings, and says when it cannot", async () => {
    fakeServer();
    const write = vi.fn().mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error("no"));
    vi.stubGlobal("navigator", { clipboard: { writeText: write } });
    render(<AdminView />);
    await unlock();
    fireEvent.change(await screen.findByLabelText("Name"), { target: { value: "Dana" } });
    fireEvent.click(screen.getByRole("button", { name: "Create user" }));
    const box = (await screen.findByRole("heading", { name: "Token for Dana" })).closest("section")!;
    expect(within(box).queryByRole("button", { name: "Download reporter config" })).toBeNull();
    fireEvent.click(within(box).getByRole("button", { name: "Copy token settings" }));
    expect(await within(box).findByText("Copied.")).toBeInTheDocument();
    expect(write.mock.calls[0]![0]).toMatch(/^userName: Dana\ntoken: pdm_aaaaaaaaaaaa_/);
    fireEvent.click(within(box).getByRole("button", { name: "Copy token settings" }));
    expect(await within(box).findByText(/Could not copy/)).toBeInTheDocument();
  });

  it("shows only the file after Reissue config, and only the token after a rotation", async () => {
    const s = fakeServer({ people: 1 });
    s.tls = true;
    s.people[0]!.certificate = { notAfter: day(71), revoked: false };
    render(<AdminView />);
    await unlock();
    await screen.findByText("person-000");
    choose("person-000", "Reissue config…");
    fireEvent.click(within(confirmRow()).getByRole("button", { name: "Reissue config" }));
    const box = (await screen.findByRole("heading", { name: "Token and reporter config for person-000" })).closest("section")!;
    expect(box).toHaveTextContent("It replaces person-000’s old certificate, which stops working now.");
    expect(box.querySelector("#admin-once-code")).toBeNull();
    expect(within(box).queryByRole("button", { name: "Copy token settings" })).toBeNull();
    fireEvent.click(within(box).getByRole("button", { name: "I have saved it" }));
    choose("person-000", "Rotate token");
    fireEvent.click(within(confirmRow()).getByRole("button", { name: "Rotate token" }));
    const tok = (await screen.findByRole("heading", { name: "Token for person-000" })).closest("section")!;
    expect(tok).toHaveTextContent("This is the only time the new token is shown.");
    expect(tok.querySelector("#admin-once-file")).toBeNull();
  });

  it("says when the certificate could not be made, and still shows the token", async () => {
    fakeServer().tls = true;
    const orig = globalThis.fetch;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const res = await orig(input, init);
        if (init?.method === "POST" && String(input).endsWith("/people")) {
          const body = (await res.json()) as Record<string, unknown>;
          delete body.config;
          body.configError = "Podium could not make the certificate. Reissue the config from the person once the server log shows why.";
          return new Response(JSON.stringify(body), { status: 201 });
        }
        return res;
      }),
    );
    render(<AdminView />);
    await unlock();
    fireEvent.change(await screen.findByLabelText("Name"), { target: { value: "Dana" } });
    fireEvent.click(screen.getByRole("button", { name: "Create user" }));
    expect(await screen.findByText(/Podium could not make the certificate/)).toBeInTheDocument();
    expect(screen.getByText(/token: pdm_aaaaaaaaaaaa_/)).toBeInTheDocument();
  });

  it("downloads a person's public certificate from the row, and keeps the key out of it", async () => {
    const s = fakeServer({ people: 1 });
    s.tls = true;
    s.people[0]!.certificate = { notAfter: day(71), revoked: false };
    render(<AdminView />);
    await unlock();
    await screen.findByText("person-000");
    choose("person-000", "Download certificate");
    expect(saved).toEqual([{ href: expect.stringMatching(/\/api\/admin\/people\/1\/certificate\.pem$/), download: "" }]);
    expect(await screen.findByText(/It has no private key\./)).toBeInTheDocument();
  });
});
