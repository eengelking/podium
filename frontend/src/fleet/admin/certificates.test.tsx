import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { AdminView } from "./AdminView";
import { fakeCert, fakeCerts, fakeServer } from "./fakeAdmin";
import type { CertsView } from "./certFormat";

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
  window.location.hash = "";
});

async function unlock() {
  fireEvent.change(await screen.findByLabelText("Name"), { target: { value: "Priya" } });
  fireEvent.change(screen.getByLabelText("Token"), { target: { value: "right" } });
  fireEvent.click(screen.getByRole("button", { name: "Unlock Admin" }));
  await screen.findByRole("navigation", { name: "Admin sections" });
}
async function open(certs: CertsView | null = fakeCerts()) {
  const srv = fakeServer();
  srv.certs = certs;
  render(<AdminView />);
  await unlock();
  fireEvent.click(screen.getByRole("button", { name: "Certificates" }));
  return srv;
}
const table = (name: string) => screen.getByRole("table", { name });
const band = () => document.querySelector(".band");

describe("Admin > Server > Certificates (#586)", () => {
  it("sits in the Server group between Security and Data", async () => {
    await open();
    const group = screen.getByRole("group", { name: "Server" });
    const names = within(group).getAllByRole("button").map((b) => b.textContent);
    expect(names.indexOf("Security")).toBeLessThan(names.indexOf("Certificates"));
    expect(names.indexOf("Certificates")).toBeLessThan(names.findIndex((n) => n?.startsWith("Data")));
    expect(await screen.findByRole("heading", { level: 1, name: "Certificates" })).toBeInTheDocument();
  });

  it("says so quietly when TLS is off", async () => {
    await open(null);
    expect(await screen.findByText("TLS is off. Start Podium with built-in TLS to manage certificates here.")).toBeInTheDocument();
    expect(screen.queryByRole("table", { name: "Certificate status" })).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("says why when the certificates cannot be read", async () => {
    const srv = await open();
    await screen.findByRole("table", { name: "Certificate status" });
    cleanup();
    srv.certs = null;
    srv.unlocked = true;
    const orig = globalThis.fetch;
    vi.stubGlobal("fetch", (u: RequestInfo | URL, i?: RequestInit) => (String(u).endsWith("/certificates") ? Promise.resolve(new Response(JSON.stringify({ error: "boom" }), { status: 500 })) : orig(u, i)));
    render(<AdminView />);
    fireEvent.click(await screen.findByRole("button", { name: "Certificates" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Could not load the certificates (boom).");
  });

  it("shows a healthy CA and serving certificate with no band and no error", async () => {
    await open();
    const t = await screen.findByRole("table", { name: "Certificate status" });
    const rows = within(t).getAllByRole("row");
    expect(rows).toHaveLength(3);
    expect(rows[1]).toHaveTextContent("Certificate authority");
    expect(rows[1]).toHaveTextContent("Podium CA, valid 10 years");
    expect(rows[1]).toHaveTextContent("By hand");
    expect(rows[1]).toHaveTextContent("valid");
    expect(rows[2]).toHaveTextContent("Serving certificate");
    expect(rows[2]).toHaveTextContent("307 days left");
    expect(rows[2]).toHaveTextContent(/Renews itself \d{4}-\d{2}-\d{2}/);
    expect(band()).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getAllByRole("button", { name: "Renew now" })).toHaveLength(1);
    expect(screen.getByRole("button", { name: "Renew now" })).not.toHaveClass("pri");
  });

  it.each([
    [28, "deleg", "soon", "expires in 28 days", "The serving certificate expires in 28 days."],
    [9, "stale", "serious", "expires in 9 days", "The serving certificate expires in 9 days."],
    [4, "crit hot", "bad", "expires in 4 days", "The serving certificate expires in 4 days."],
  ])("shows the band and badge for %i days left", async (days, bandClass, badgeClass, badgeText, title) => {
    await open(fakeCerts({ serving: fakeCert(days) }));
    await screen.findByRole("table", { name: "Certificate status" });
    expect(band()).toHaveClass(...`band ${bandClass}`.split(" "));
    expect(band()).toHaveTextContent(title);
    expect(band()).toHaveTextContent("Podium renews it automatically.");
    const badge = within(table("Certificate status")).getByText(badgeText);
    expect(badge).toHaveClass("badge", badgeClass);
    expect(badge.querySelector("svg.i")).not.toBeNull();
  });

  it("puts the reason of a failed renewal in a critical row that announces itself, with the band's detail", async () => {
    await open(fakeCerts({ serving: fakeCert(9), lastFailure: { at: new Date().toISOString(), reason: "openssl was not found in the container", trigger: "schedule" } }));
    const err = await screen.findByText(/openssl was not found in the container/);
    expect(err).toHaveAttribute("role", "alert");
    expect(err).toHaveClass("err");
    expect(err).toHaveTextContent(/^The last automatic renewal failed on \d{4}-\d{2}-\d{2}: openssl was not found in the container\. Podium tries again every day\. Fix the cause, then choose Renew now\.$/);
    expect(band()).toHaveTextContent("Podium renews it automatically, but the last renewal did not work.");
    expect(within(table("Certificate status")).getByText("last renewal failed")).toHaveClass("badge", "bad");
  });

  it("words a failed manual renewal without the daily retry, and shows it even when the certificate is healthy", async () => {
    await open(fakeCerts({ lastFailure: { at: new Date().toISOString(), reason: "no space left", trigger: "manual" } }));
    const err = await screen.findByText(/no space left/);
    expect(err).toHaveTextContent(/^The last renewal failed on .*: no space left\. Fix the cause, then choose Renew now\.$/);
    expect(band()).toBeNull();
  });

  it("makes Renew now the primary action when the serving certificate has expired", async () => {
    await open(fakeCerts({ serving: fakeCert(-2) }));
    await screen.findByRole("table", { name: "Certificate status" });
    expect(band()).toHaveClass("crit", "hot");
    expect(band()).toHaveTextContent(/^The serving certificate expired on \d{4}-\d{2}-\d{2}\.Reporters are refused until it is renewed\.$/);
    expect(within(table("Certificate status")).getByText("expired 2 days ago", { selector: ".badge" })).toHaveClass("badge", "bad");
    expect(screen.getByRole("button", { name: "Renew now" })).toHaveClass("pri");
    expect(screen.getByRole("button", { name: "Rotate CA…" })).not.toHaveClass("pri");
  });

  it("says expired today for a certificate that lapsed within the day", async () => {
    await open(fakeCerts({ serving: fakeCert(0, { notAfter: new Date(Date.now() - 3_600_000).toISOString() }) }));
    expect(await within(await screen.findByRole("table", { name: "Certificate status" })).findByText("expired today", { selector: ".badge" })).toBeInTheDocument();
  });

  it("walks through the recovery when the CA has expired, and makes Rotate CA… the one primary button", async () => {
    await open(fakeCerts({ ca: fakeCert(-2, { serial: "CA01" }) }));
    await screen.findByRole("table", { name: "Certificate status" });
    expect(band()).toHaveClass("crit", "hot");
    expect(band()).toHaveTextContent("The certificate authority expired on");
    expect(band()).toHaveTextContent("Rotate the CA, then give each person a new reporter config.");
    const t = table("Certificate status");
    expect(within(t).getByText("not trusted: the CA expired")).toHaveClass("badge", "bad");
    expect(within(t).getByText("After the CA is rotated")).toBeInTheDocument();
    expect(screen.getByText("To restore access")).toBeInTheDocument();
    expect(screen.getAllByRole("listitem").map((li) => li.textContent)).toContain("Choose Rotate CA… below.");
    const rotate = screen.getByRole("button", { name: "Rotate CA…" });
    expect(rotate).toBeEnabled();
    expect(rotate).toHaveClass("pri");
    expect(screen.getByRole("button", { name: "Renew now" })).not.toHaveClass("pri");
  });

  it("uses the CA's own words when it is the first to run out", async () => {
    await open(fakeCerts({ ca: fakeCert(20) }));
    await screen.findByRole("table", { name: "Certificate status" });
    expect(band()).toHaveTextContent("The certificate authority expires in 20 days.");
    expect(band()).toHaveTextContent("The CA is rotated by hand.");
  });

  it("says a renewal is due at the next check when the date to renew has passed", async () => {
    await open(fakeCerts({ serving: fakeCert(35), settings: { lifetimeDays: 365, renewBeforeDays: 90, headerCountdown: true } }));
    expect(await within(await screen.findByRole("table", { name: "Certificate status" })).findByText("Renews at the next check")).toBeInTheDocument();
  });

  it("leaves out the CA row and the fingerprint when the server does not give the CA", async () => {
    await open(fakeCerts({ ca: null }));
    const t = await screen.findByRole("table", { name: "Certificate status" });
    expect(within(t).getAllByRole("row")).toHaveLength(2);
    expect(screen.queryByRole("button", { name: "Copy the CA fingerprint" })).toBeNull();
  });

  describe("the CA fingerprint", () => {
    it("shows the whole value and copies it, with no browser-trust text and no CA download (#665)", async () => {
      const write = vi.fn(() => Promise.resolve());
      vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText: write } });
      await open();
      const fp = await screen.findByRole("button", { name: "Copy the CA fingerprint" });
      expect(fp).toHaveTextContent(/^SHA-256 3F:9A:C4:1D:7E:52:B8:06:A1:EE:90:4B:D3:68:2C:F7:0B:5D:E1:93:4A:8C:27:BE:61:D0:F5:39:AC:12:84:6E$/);
      fireEvent.click(fp);
      await waitFor(() => expect(fp).toHaveTextContent("Copied"));
      expect(write).toHaveBeenCalledWith("3F:9A:C4:1D:7E:52:B8:06:A1:EE:90:4B:D3:68:2C:F7:0B:5D:E1:93:4A:8C:27:BE:61:D0:F5:39:AC:12:84:6E");
      expect(screen.queryByRole("link", { name: /Download CA/ })).toBeNull();
      expect(screen.queryByText(/Download CA/)).toBeNull();
      expect(screen.queryByText(/browser/i)).toBeNull();
      expect(screen.getByText(/Every reporter config carries this CA\. Compare it with the fingerprint of the CA in a config to check which CA signed it\./)).toBeInTheDocument();
    });

    it("says so when the copy fails", async () => {
      vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText: () => Promise.reject(new Error("no")) } });
      await open();
      const fp = await screen.findByRole("button", { name: "Copy the CA fingerprint" });
      fireEvent.click(fp);
      await waitFor(() => expect(fp).toHaveTextContent("Copy failed"));
    });
  });

  describe("the names dialog", () => {
    it("opens from 'localhost and 3 more', groups the names, wraps focus and closes on Escape", async () => {
      await open();
      const link = await screen.findByRole("button", { name: "localhost and 3 more" });
      expect(link).toHaveAttribute("aria-haspopup", "dialog");
      fireEvent.click(link);
      const dialog = await screen.findByRole("dialog", { name: "4 names on the serving certificate" });
      expect(within(dialog).getByText("A client that connects by any other name refuses it.")).toBeInTheDocument();
      const always = within(dialog).getByRole("region", { name: "Always included" });
      expect(within(always).getAllByRole("listitem").map((li) => li.textContent)).toEqual(["localhostName", "127.0.0.1Address"]);
      const added = within(dialog).getByRole("region", { name: /Allowed hosts and bind address/ });
      expect(added).toHaveTextContent("PODIUM_ALLOWED_HOSTS");
      expect(within(added).getAllByRole("listitem").map((li) => li.textContent)).toEqual(["podium.lanName", "192.0.2.12Address"]);
      expect(within(dialog).queryByText(/next renewal will use/)).toBeNull();
      // The X has focus first.
      expect(within(dialog).getByRole("button", { name: "Close (Esc)" })).toHaveFocus();
      fireEvent.keyDown(document, { key: "Escape" });
      await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    });

    it("keeps Tab inside: shift+Tab from the first control goes to the last", async () => {
      await open();
      fireEvent.click(await screen.findByRole("button", { name: "localhost and 3 more" }));
      const dialog = await screen.findByRole("dialog");
      const x = within(dialog).getByRole("button", { name: "Close (Esc)" });
      expect(x).toHaveFocus();
      fireEvent.keyDown(document, { key: "Tab", shiftKey: true });
      expect(within(dialog).getByRole("button", { name: "Close" })).toHaveFocus();
      fireEvent.keyDown(document, { key: "Tab" });
      expect(x).toHaveFocus();
    });

    it("copies the names, closes with Close, and says when a renewal would carry other names", async () => {
      const write = vi.fn(() => Promise.resolve());
      vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText: write } });
      await open(fakeCerts({ names: { dns: ["localhost", "podium.lan", "new.lan"], ip: ["127.0.0.1"] } }));
      fireEvent.click(await screen.findByRole("button", { name: "localhost and 3 more" }));
      const dialog = await screen.findByRole("dialog");
      expect(within(dialog).getByText(/The next renewal will use a different list/)).toHaveTextContent("4 names");
      const copy = within(dialog).getByRole("button", { name: "Copy the names" });
      fireEvent.click(copy);
      await waitFor(() => expect(copy).toHaveTextContent("Copied"));
      expect(write).toHaveBeenCalledWith("localhost\npodium.lan\n127.0.0.1\n192.0.2.12");
      fireEvent.click(within(dialog).getByRole("button", { name: "Close" }));
      expect(screen.queryByRole("dialog")).toBeNull();
    });

    it("does not say the names differ when only their order does", async () => {
      await open(fakeCerts({ names: { dns: ["podium.lan", "localhost"], ip: ["192.0.2.12", "127.0.0.1"] } }));
      fireEvent.click(await screen.findByRole("button", { name: /and \d+ more/ }));
      const dialog = await screen.findByRole("dialog");
      expect(within(dialog).queryByText(/The next renewal will use a different list/)).toBeNull();
    });

    it("shows a single name as plain text with no dialog to open", async () => {
      await open(fakeCerts({ certificateNames: { dns: ["localhost"], ip: [] } }));
      const t = await screen.findByRole("table", { name: "Certificate status" });
      expect(within(t).queryByRole("button", { name: /and \d+ more/ })).toBeNull();
      expect(within(t).getByText("localhost")).toBeInTheDocument();
    });
  });

  describe("renewal and lifetimes", () => {
    const field = (name: string) => screen.getByLabelText(name) as HTMLInputElement;

    it("shows the four numbers, with the reporter's from the server", async () => {
      await open();
      await screen.findByRole("table", { name: "Certificate status" });
      expect(field("Serving certificate lifetime").value).toBe("365");
      expect(field("Renew when this many days remain").value).toBe("30");
      expect(field("Reporter certificate lifetime").value).toBe("90");
      expect(screen.queryByLabelText(/Grace after a reporter certificate expires/)).toBeNull();
      expect(screen.queryByRole("switch", { name: /Renew the serving certificate automatically/ })).toBeNull();
    });

    it("saves a number when the field is left, with the flat key, and keeps what the server answers", async () => {
      const srv = await open();
      await screen.findByRole("table", { name: "Certificate status" });
      for (const [label, key, v] of [
        ["Serving certificate lifetime", "tls.serving.lifetimeDays", 90],
        ["Renew when this many days remain", "tls.serving.renewBeforeDays", 14],
        ["Reporter certificate lifetime", "tls.reporter.lifetimeDays", 120],
      ] as const) {
        fireEvent.change(field(label), { target: { value: String(v) } });
        fireEvent.blur(field(label));
        await waitFor(() => expect(srv.certBodies).toContainEqual({ [key]: v }));
      }
      await waitFor(() => expect(field("Serving certificate lifetime").value).toBe("90"));
    });

    it("does not save a value that did not change", async () => {
      const srv = await open();
      await screen.findByRole("table", { name: "Certificate status" });
      fireEvent.blur(field("Serving certificate lifetime"));
      expect(srv.certBodies).toEqual([]);
    });

    it("shows a rejected value in place, with the server's words, and clears it when the value is put back", async () => {
      const srv = await open();
      srv.certError = "The serving certificate lifetime must be a whole number of days from 30 to 825";
      await screen.findByRole("table", { name: "Certificate status" });
      const f = field("Serving certificate lifetime");
      fireEvent.change(f, { target: { value: "900" } });
      fireEvent.blur(f);
      const err = await screen.findByText("The serving certificate lifetime must be a whole number of days from 30 to 825");
      expect(err).toHaveAttribute("role", "alert");
      expect(err).toHaveClass("err");
      expect(f).toHaveAttribute("aria-invalid", "true");
      expect(f).toHaveAttribute("aria-describedby", err.id);
      expect(f.value).toBe("900");
      fireEvent.change(f, { target: { value: "365" } });
      fireEvent.blur(f);
      await waitFor(() => expect(screen.queryByText(/must be a whole number/)).toBeNull());
      expect(f).not.toHaveAttribute("aria-invalid");
    });

    it("asks for a whole number without calling the server when the box is empty or not whole", async () => {
      const srv = await open();
      await screen.findByRole("table", { name: "Certificate status" });
      const f = field("Renew when this many days remain");
      fireEvent.change(f, { target: { value: "" } });
      fireEvent.blur(f);
      expect(await screen.findByText("Enter a whole number of days from 7 to 90.")).toHaveAttribute("role", "alert");
      fireEvent.change(f, { target: { value: "7.5" } });
      fireEvent.blur(f);
      expect(screen.getByText("Enter a whole number of days from 7 to 90.")).toBeInTheDocument();
      expect(srv.certBodies).toEqual([]);
    });

    it("flips the header countdown switch at once and saves tls.header.countdown", async () => {
      const srv = await open();
      const sw = await screen.findByRole("switch", { name: /Show the expiry countdown in the header/ });
      expect(sw).toHaveAttribute("aria-checked", "true");
      fireEvent.click(sw);
      await waitFor(() => expect(sw).toHaveAttribute("aria-checked", "false"));
      expect(srv.certBodies).toEqual([{ "tls.header.countdown": false }]);
      expect(sw).toHaveAccessibleName(/Off$/);
    });

    it("shows the server's reason under the header countdown switch when the save is refused", async () => {
      const srv = await open();
      srv.certError = "could not save";
      const sw = await screen.findByRole("switch", { name: /Show the expiry countdown in the header/ });
      fireEvent.click(sw);
      expect(await screen.findByText("could not save")).toBeInTheDocument();
      expect(sw).toHaveAttribute("aria-checked", "true");
    });

    it("goes back to the sign-in when the session has lapsed while saving", async () => {
      const srv = await open();
      await screen.findByRole("table", { name: "Certificate status" });
      srv.expire = true;
      fireEvent.change(field("Serving certificate lifetime"), { target: { value: "90" } });
      fireEvent.blur(field("Serving certificate lifetime"));
      expect(await screen.findByRole("button", { name: "Unlock Admin" })).toBeInTheDocument();
    });
  });

  describe("Rotate by hand and the earlier certificates", () => {
    it("renews now, says so, and reads the page again", async () => {
      const srv = await open();
      await screen.findByRole("table", { name: "Certificate status" });
      const calls = srv.calls.length;
      fireEvent.click(screen.getByRole("button", { name: "Renew now" }));
      expect(await screen.findByText("Renewed. The old certificate is kept as a backup.")).toHaveAttribute("role", "status");
      expect(srv.renewals).toBe(1);
      expect(srv.calls.slice(calls).filter((c) => c.startsWith("GET /certificates"))).not.toHaveLength(0);
    });

    it("shows why a renewal failed, in place", async () => {
      const srv = await open();
      srv.certError = "openssl was not found in the container";
      await screen.findByRole("table", { name: "Certificate status" });
      fireEvent.click(screen.getByRole("button", { name: "Renew now" }));
      const err = await screen.findByText("openssl was not found in the container");
      expect(err).toHaveAttribute("role", "alert");
      expect(screen.queryByText(/^Renewed\./)).toBeNull();
    });

    it("goes back to the sign-in when the session has lapsed while renewing", async () => {
      const srv = await open();
      await screen.findByRole("table", { name: "Certificate status" });
      srv.expire = true;
      fireEvent.click(screen.getByRole("button", { name: "Renew now" }));
      expect(await screen.findByRole("button", { name: "Unlock Admin" })).toBeInTheDocument();
    });

    it("offers Rotate CA… as a danger button, no longer held back for a later release", async () => {
      await open();
      const rotate = await screen.findByRole("button", { name: "Rotate CA…" });
      expect(rotate).toBeEnabled();
      expect(rotate).toHaveClass("btn", "dng");
      expect(screen.queryByText(/Available in a later release\./)).toBeNull();
    });

    it("lists the certificates it kept with their dates, and says when there are none", async () => {
      await open(fakeCerts({ previous: [fakeCert(-60, { serial: "0001", notBefore: "2025-08-22T00:00:00.000Z", notAfter: "2026-08-22T00:00:00.000Z" })] }));
      const t = await screen.findByRole("table", { name: "Previous certificates" });
      const row = within(t).getAllByRole("row")[1]!;
      expect(row).toHaveTextContent("Serving certificate");
      expect(row).toHaveTextContent("2025-08-22 to 2026-08-22");
      expect(row).toHaveTextContent("0001");
      expect(row).toHaveTextContent("kept");
      cleanup();
      await open(fakeCerts({ previous: [] }));
      expect(await screen.findByText("No earlier certificate has been replaced yet.")).toBeInTheDocument();
      expect(screen.queryByRole("table", { name: "Previous certificates" })).toBeNull();
    });
  });

  describe("the link from the header pill", () => {
    it("opens Admin on Certificates for #/admin/certificates", async () => {
      const srv = fakeServer();
      srv.certs = fakeCerts();
      window.location.hash = "#/admin/certificates";
      render(<AdminView />);
      await unlock();
      expect(screen.getByRole("button", { name: "Certificates" })).toHaveAttribute("aria-current", "page");
      expect(await screen.findByRole("table", { name: "Certificate status" })).toBeInTheDocument();
    });

    it("follows the pill again after another tab was chosen from the menu", async () => {
      const srv = fakeServer();
      srv.certs = fakeCerts();
      window.location.hash = "#/admin/certificates";
      render(<AdminView />);
      await unlock();
      fireEvent.click(screen.getByRole("button", { name: /^People(?! and)/ }));
      expect(window.location.hash).toBe("");
      act(() => {
        window.location.hash = "#/admin/certificates";
        window.dispatchEvent(new HashChangeEvent("hashchange"));
      });
      expect(screen.getByRole("button", { name: "Certificates" })).toHaveAttribute("aria-current", "page");
    });

    it("switches to Certificates when the hash changes while Admin is open, and ignores other hashes", async () => {
      const srv = fakeServer();
      srv.certs = fakeCerts();
      render(<AdminView />);
      await unlock();
      expect(screen.getByRole("button", { name: /^People(?! and)/ })).toHaveAttribute("aria-current", "page");
      act(() => {
        window.location.hash = "#/admin/other";
        window.dispatchEvent(new HashChangeEvent("hashchange"));
      });
      expect(screen.getByRole("button", { name: /^People(?! and)/ })).toHaveAttribute("aria-current", "page");
      act(() => {
        window.location.hash = "#/admin/certificates";
        window.dispatchEvent(new HashChangeEvent("hashchange"));
      });
      expect(screen.getByRole("button", { name: "Certificates" })).toHaveAttribute("aria-current", "page");
      act(() => {
        window.location.hash = "#/admin/settings";
        window.dispatchEvent(new HashChangeEvent("hashchange"));
      });
      expect(screen.getByRole("button", { name: /^Settings/ })).toHaveAttribute("aria-current", "page");
    });
  });
});

describe("Admin > Server > Certificates, CA rotation (#588)", () => {
  const rotating = (onOldCa = 2, total = 6) => fakeCerts({ overlapDays: 120, rotation: { previousCa: fakeCert(3600, { serial: "OLD1" }, 3650), cross: fakeCert(30, { serial: "CR01" }, 120), startedAt: Date.now(), reporters: { onOldCa, total } } });

  it("shows the blue status band, the previous CA row with the count, and Retire old CA…", async () => {
    await open(rotating());
    const b = await waitFor(() => {
      const el = document.querySelector(".band");
      if (!el) throw new Error("no band");
      return el as HTMLElement;
    });
    expect(b).toHaveAttribute("role", "status");
    expect(b.className).toContain("deleg");
    expect(b).toHaveTextContent("Certificate authority rotation is in progress.");
    expect(b).toHaveTextContent("2 reporters still use the old CA");
    const row = within(table("Certificate status")).getByText("Previous certificate authority").closest("tr")!;
    expect(row).toHaveTextContent("2 of 6 reporters still use it");
    expect(within(row).getByRole("button", { name: "Retire old CA…" })).toBeInTheDocument();
  });

  it("still warns that the serving certificate is about to expire while a rotation is open", async () => {
    await open({ ...rotating(), serving: fakeCert(8) });
    await screen.findByRole("table", { name: "Certificate status" });
    expect(band()).toHaveTextContent("The serving certificate expires in 8 days.");
    expect(band()).not.toHaveTextContent("rotation is in progress");
  });

  it("has no previous CA row and no rotation band when nothing is rotating", async () => {
    await open();
    await screen.findByRole("table", { name: "Certificate status" });
    expect(screen.queryByText("Previous certificate authority")).toBeNull();
    expect(band()).toBeNull();
  });

  it("asks before retiring, names the count, and does nothing on Cancel", async () => {
    const srv = await open(rotating());
    fireEvent.click(await screen.findByRole("button", { name: "Retire old CA…" }));
    const ask = await screen.findByRole("alert");
    expect(ask).toHaveTextContent("Retire the old CA?");
    expect(ask).toHaveTextContent("The 2 reporters still on the old CA are refused at once, and open connections are closed.");
    expect(ask).toHaveTextContent("The 4 that already renewed are not affected.");
    fireEvent.click(within(ask).getByRole("button", { name: "Cancel" }));
    expect(screen.queryByText("Retire the old CA?")).toBeNull();
    expect(srv.certBodies).toEqual([]);
  });

  it("retires the old CA and says who now needs a new config", async () => {
    const srv = await open(rotating());
    fireEvent.click(await screen.findByRole("button", { name: "Retire old CA…" }));
    fireEvent.click(within(await screen.findByRole("alert")).getByRole("button", { name: "Retire old CA" }));
    expect(await screen.findByText(/Retired the old CA\. 2 reporters now need a new reporter config/)).toBeInTheDocument();
    expect(srv.certBodies).toEqual([{ retire: true }]);
    await waitFor(() => expect(screen.queryByText("Previous certificate authority")).toBeNull());
  });

  it("says no reporter uses it when the count is zero", async () => {
    await open(rotating(0, 6));
    const row = (await within(await screen.findByRole("table", { name: "Certificate status" })).findByText("Previous certificate authority")).closest("tr")!;
    expect(row).toHaveTextContent("no reporter uses it");
    fireEvent.click(within(row).getByRole("button", { name: "Retire old CA…" }));
    expect(await screen.findByText("No reporter still uses the old CA. Open connections that came in on it are closed.")).toBeInTheDocument();
  });

  it("says in the band that a reporter that misses the cross certificate, or whose own certificate expires first, needs a reissued config (#637, #665)", async () => {
    const view = rotating();
    await open(view);
    const b = await waitFor(() => {
      const el = document.querySelector(".band");
      if (!el) throw new Error("no band");
      return el as HTMLElement;
    });
    expect(b).toHaveTextContent(`verifies, until ${view.rotation!.cross.notAfter.slice(0, 10)} or until you retire it. A reporter that does not connect before then, or whose own certificate expires first, is refused, and its person needs a reissued reporter config.`);
    expect(b).not.toHaveTextContent(/grace/);
  });

  it("says the same before the Admin starts a rotation, with the date the cross certificate ends (#637)", async () => {
    await open(fakeCerts({ overlapDays: 120 }));
    fireEvent.click(await screen.findByRole("button", { name: "Rotate CA…" }));
    const ask = await screen.findByRole("alert");
    const ends = new Date(Date.now() + 120 * 86_400_000).toISOString().slice(0, 10);
    expect(ask).toHaveTextContent(`keep working for 120 days, until ${ends}.`);
    expect(ask).toHaveTextContent("A reporter that does not connect before then, or whose own certificate expires first (a laptop asleep that long, for example), is refused. Its person needs a reissued reporter config from Admin > People.");
    expect(ask).not.toHaveTextContent(/grace/);
  });

  it("asks before rotating, with the overlap in days and the two choices", async () => {
    const srv = await open(fakeCerts({ overlapDays: 120 }));
    fireEvent.click(await screen.findByRole("button", { name: "Rotate CA…" }));
    const ask = await screen.findByRole("alert");
    expect(ask).toHaveTextContent("Rotate the certificate authority?");
    expect(ask).toHaveTextContent("keep working for 120 days");
    expect(within(ask).getByRole("button", { name: "Rotate CA and end the overlap now" })).toBeEnabled();
    fireEvent.click(within(ask).getByRole("button", { name: "Cancel" }));
    expect(srv.certBodies).toEqual([]);
  });

  it("says why a planned rotation is off for a CA made before T10, and leaves the hard cutover (#638)", async () => {
    const srv = await open(fakeCerts({ overlapDays: 120, canOverlap: false }));
    expect(await screen.findByText(/This CA was made before rotation with an overlap was possible/)).toBeInTheDocument();
    fireEvent.click(await screen.findByRole("button", { name: "Rotate CA…" }));
    const ask = await screen.findByRole("alert");
    expect(ask).toHaveTextContent("cannot be rotated with an overlap");
    expect(ask).toHaveTextContent("Every reporter then needs a new reporter config from Admin > People, and open connections are closed.");
    expect(ask).not.toHaveTextContent("keep working for 120 days");
    const planned = within(ask).getByRole("button", { name: "Rotate CA" });
    expect(planned).toBeDisabled();
    expect(planned).toHaveAccessibleDescription(/cannot be rotated with an overlap/);
    expect(within(ask).getByRole("button", { name: "Rotate CA and end the overlap now" })).toBeEnabled();
    expect(srv.certBodies).toEqual([]);
  });

  it("rotates with an overlap, and the page then shows it in progress", async () => {
    const srv = await open(fakeCerts({ overlapDays: 120 }));
    fireEvent.click(await screen.findByRole("button", { name: "Rotate CA…" }));
    fireEvent.click(within(await screen.findByRole("alert")).getByRole("button", { name: "Rotate CA" }));
    expect(await screen.findByText(/Rotated\. Reporters pick up the new CA when they renew/)).toBeInTheDocument();
    expect(srv.certBodies).toEqual([{ endOverlap: false }]);
    expect(await screen.findByText("Previous certificate authority")).toBeInTheDocument();
  });

  it("ends the overlap now on request, saying every reporter needs a new config", async () => {
    const srv = await open(fakeCerts({ overlapDays: 120 }));
    fireEvent.click(await screen.findByRole("button", { name: "Rotate CA…" }));
    fireEvent.click(within(await screen.findByRole("alert")).getByRole("button", { name: "Rotate CA and end the overlap now" }));
    expect(await screen.findByText(/Every reporter needs a new reporter config/)).toBeInTheDocument();
    expect(srv.certBodies).toEqual([{ endOverlap: true }]);
    expect(screen.queryByText("Previous certificate authority")).toBeNull();
  });

  it("while a rotation is open, the planned rotation is off and ending the overlap is not", async () => {
    await open(rotating());
    fireEvent.click(await screen.findByRole("button", { name: "Rotate CA…" }));
    const ask = (await screen.findAllByRole("alert")).find((a) => a.textContent?.includes("Rotate the certificate authority?"))!;
    expect(ask).toHaveTextContent("already in progress");
    expect(within(ask).getByRole("button", { name: "Rotate CA" })).toBeDisabled();
    expect(within(ask).getByRole("button", { name: "Rotate CA and end the overlap now" })).toBeEnabled();
  });

  it("shows why a rotation was refused", async () => {
    const srv = await open(fakeCerts({ overlapDays: 120 }));
    srv.certError = "this CA cannot be rotated that way";
    fireEvent.click(await screen.findByRole("button", { name: "Rotate CA…" }));
    fireEvent.click(within(await screen.findByRole("alert")).getByRole("button", { name: "Rotate CA" }));
    expect(await screen.findByText(/this CA cannot be rotated that way/)).toBeInTheDocument();
  });
});

describe("Reporters over HTTP (#589)", () => {
  const SWITCH = /Allow reporters to connect over HTTP/;
  const WARN_ON = /^Not encrypted\. Over HTTP the name, the token and everything the reporter sends are not encrypted in transit/;
  const WARN_OFF = /^Turning this on makes reporters send their name, their token and everything else without encryption/;
  const warnbar = () => document.querySelector('[aria-labelledby="c-http"] .warnbar');

  it("is on with a warning line and says how many reporters are on HTTP now", async () => {
    await open();
    const sw = await screen.findByRole("switch", { name: SWITCH });
    expect(sw).toHaveAttribute("aria-checked", "true");
    expect(warnbar()).toHaveTextContent(WARN_ON);
    expect(screen.getByText(/3 of 6 reporters are connected over HTTP now\./)).toBeInTheDocument();
  });

  it("asks before turning it off, names how many reporters are refused, and saves nothing until confirmed", async () => {
    const srv = await open();
    fireEvent.click(await screen.findByRole("switch", { name: SWITCH }));
    const ask = await screen.findByRole("alert");
    expect(within(ask).getByRole("heading", { name: "Stop allowing reporters over HTTP?" })).toBeInTheDocument();
    expect(ask).toHaveTextContent("The 3 reporters connected over HTTP are refused at once, until their person saves a reporter config in ~/.podium/");
    expect(ask).toHaveTextContent("The console on the loopback address keeps working over HTTP, so an Admin can always sign in.");
    expect(within(ask).getByRole("button", { name: "Stop allowing HTTP" })).toHaveFocus();
    expect(srv.certBodies).toEqual([]);
    expect(screen.getByRole("switch", { name: SWITCH })).toHaveAttribute("aria-checked", "true");
  });

  it("turns it off on Stop allowing HTTP, and the warning line changes its words", async () => {
    const srv = await open();
    fireEvent.click(await screen.findByRole("switch", { name: SWITCH }));
    fireEvent.click(within(await screen.findByRole("alert")).getByRole("button", { name: "Stop allowing HTTP" }));
    await waitFor(() => expect(screen.getByRole("switch", { name: SWITCH })).toHaveAttribute("aria-checked", "false"));
    expect(srv.certBodies).toEqual([{ "tls.allowReportersOverHttp": false }]);
    expect(screen.queryByRole("alert")).toBeNull();
    expect(warnbar()).toHaveTextContent(WARN_OFF);
    expect(screen.getByText("Reporters must use a reporter config on the reporter port. A reporter without one is refused until it has one.")).toBeInTheDocument();
  });

  it("keeps it on on Cancel and on Escape, and returns focus to the switch", async () => {
    const srv = await open();
    fireEvent.click(await screen.findByRole("switch", { name: SWITCH }));
    fireEvent.click(within(await screen.findByRole("alert")).getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByRole("switch", { name: SWITCH })).toHaveFocus();
    fireEvent.click(screen.getByRole("switch", { name: SWITCH }));
    fireEvent.keyDown(await screen.findByRole("alert"), { key: "Escape" });
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByRole("switch", { name: SWITCH })).toHaveAttribute("aria-checked", "true");
    expect(srv.certBodies).toEqual([]);
  });

  it("turns it on at once, without asking", async () => {
    const srv = await open(fakeCerts({ http: { allow: false, overHttp: 0, total: 4 } }));
    const sw = await screen.findByRole("switch", { name: SWITCH });
    expect(sw).toHaveAttribute("aria-checked", "false");
    expect(warnbar()).toHaveTextContent(WARN_OFF);
    fireEvent.click(sw);
    await waitFor(() => expect(sw).toHaveAttribute("aria-checked", "true"));
    expect(srv.certBodies).toEqual([{ "tls.allowReportersOverHttp": true }]);
    expect(screen.queryByRole("alert")).toBeNull();
    expect(warnbar()).toHaveTextContent(WARN_ON);
  });

  it("says no reporter is refused when none is on HTTP, and uses the singular for one", async () => {
    await open(fakeCerts({ http: { allow: true, overHttp: 0, total: 2 } }));
    fireEvent.click(await screen.findByRole("switch", { name: SWITCH }));
    expect(await screen.findByRole("alert")).toHaveTextContent("No reporter is connected over HTTP now, so none is refused.");
    cleanup();
    await open(fakeCerts({ http: { allow: true, overHttp: 1, total: 2 } }));
    expect(await screen.findByText(/1 of 2 reporters is connected over HTTP now\./)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("switch", { name: SWITCH }));
    expect(await screen.findByRole("alert")).toHaveTextContent("The 1 reporter connected over HTTP is refused at once");
  });

  it("shows the server's reason when the save is refused, and leaves the switch where it was", async () => {
    const srv = await open();
    srv.certError = "could not save";
    fireEvent.click(await screen.findByRole("switch", { name: SWITCH }));
    fireEvent.click(within(await screen.findByRole("alert")).getByRole("button", { name: "Stop allowing HTTP" }));
    expect(await screen.findByText("could not save")).toBeInTheDocument();
    expect(screen.getByRole("switch", { name: SWITCH })).toHaveAttribute("aria-checked", "true");
  });
});
