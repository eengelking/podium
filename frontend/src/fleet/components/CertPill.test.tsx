import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import { CertPill } from "./CertPill";
import { TopBar } from "./TopBar";
import { CERTS_HASH, pillOf, TLS_POLL_MS, type TlsStage, type TlsStatus } from "../tlsStatus";

const NOW = Date.UTC(2026, 9, 20, 12);
const DAY = 86_400_000;

function status(over: Partial<Extract<TlsStatus, { enabled: true }>> = {}): TlsStatus {
  const daysLeft = over.daysLeft ?? 28;
  return { enabled: true, expiresAt: new Date(NOW + daysLeft * DAY).toISOString(), subject: "serving", daysLeft, stage: "soon", renewalFailed: false, showCountdown: true, ...over };
}

describe("pillOf", () => {
  it("shows nothing while TLS is off or no answer has come", () => {
    expect(pillOf(null, NOW)).toBeNull();
    expect(pillOf({ enabled: false }, NOW)).toBeNull();
  });

  it("shows nothing for a healthy certificate with no failed renewal", () => {
    expect(pillOf(status({ stage: "ok", daysLeft: 300 }), NOW)).toBeNull();
  });

  it.each<[TlsStage, number, string, string, string]>([
    ["soon", 28, "soon", "clock", "Certificate expires in 28 days"],
    ["serious", 9, "serious", "warn", "Certificate expires in 9 days"],
    ["critical", 4, "bad", "warn", "Certificate expires in 4 days"],
    ["critical", 1, "bad", "warn", "Certificate expires in 1 day"],
  ])("%s at %i days is %s with the %s icon", (stage, daysLeft, tone, icon, text) => {
    expect(pillOf(status({ stage, daysLeft }), NOW)).toMatchObject({ tone, icon, text });
  });

  it("says Certificate expired, with a ring and a cross, once the date has passed", () => {
    const v = pillOf(status({ stage: "expired", daysLeft: -2 }), NOW);
    expect(v).toMatchObject({ tone: "bad", icon: "cross", text: "Certificate expired" });
    expect(v?.title).toContain("The serving certificate expired on");
  });

  it("says expires today on the last day, when the server already counts it as expired", () => {
    const v = pillOf(status({ stage: "expired", daysLeft: 0, expiresAt: new Date(NOW + 3_600_000).toISOString() }), NOW);
    expect(v).toMatchObject({ tone: "bad", icon: "warn", text: "Certificate expires today" });
  });

  it("names the CA in the tooltip when it expires first", () => {
    expect(pillOf(status({ subject: "ca" }), NOW)?.title).toMatch(/^The CA expires on \d{4}-\d{2}-\d{2}\. Open Admin > Server > Certificates\.$/);
  });

  it("hides the blue, orange and red countdown when the Admin switched it off", () => {
    for (const stage of ["soon", "serious", "critical"] as const) expect(pillOf(status({ stage, showCountdown: false }), NOW)).toBeNull();
  });

  it("shows the countdown despite the switch when a renewal failed, and always shows an expired certificate", () => {
    expect(pillOf(status({ showCountdown: false, renewalFailed: true }), NOW)).toMatchObject({ text: "Certificate expires in 28 days" });
    expect(pillOf(status({ stage: "expired", daysLeft: -1, showCountdown: false }), NOW)).toMatchObject({ text: "Certificate expired" });
  });

  it("shows a failed renewal at once, even with plenty of days left, whatever the switch says", () => {
    expect(pillOf(status({ stage: "ok", daysLeft: 300, renewalFailed: true, showCountdown: false }), NOW)).toMatchObject({ tone: "serious", icon: "warn", text: "Certificate renewal failed" });
  });
});

describe("CertPill", () => {
  beforeEach(() => vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"], now: NOW }));
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });
  const answer = (body: unknown, ok = true) => vi.fn((_url: string) => Promise.resolve({ ok, json: () => Promise.resolve(body) } as Response));

  it("is a link to the Certificates page with its words, an icon and no close button", async () => {
    vi.stubGlobal("fetch", answer(status()));
    render(<CertPill />);
    const link = await screen.findByRole("link", { name: "Certificate expires in 28 days" });
    expect(link).toHaveAttribute("href", CERTS_HASH);
    expect(link).toHaveClass("pill", "soon");
    expect(link.querySelector("svg.i")).not.toBeNull();
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("reads /api/tls/status without credentials and asks again every five minutes", async () => {
    const fetchFn = answer(status());
    vi.stubGlobal("fetch", fetchFn);
    render(<CertPill />);
    await screen.findByRole("link");
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(fetchFn.mock.calls[0]![0]).toBe("/api/tls/status");
    fetchFn.mockImplementation(() => Promise.resolve({ ok: true, json: () => Promise.resolve(status({ stage: "serious", daysLeft: 9 })) } as Response));
    await act(async () => {
      vi.advanceTimersByTime(TLS_POLL_MS);
    });
    expect(fetchFn).toHaveBeenCalledTimes(2);
    expect(await screen.findByRole("link", { name: "Certificate expires in 9 days" })).toHaveClass("serious");
  });

  it("shows nothing when TLS is off, when the route answers an error, and when the read fails", async () => {
    vi.stubGlobal("fetch", answer({ enabled: false }));
    const { container } = render(<CertPill />);
    await act(async () => {});
    expect(container).toBeEmptyDOMElement();
    cleanup();
    vi.stubGlobal("fetch", answer({}, false));
    const second = render(<CertPill />);
    await act(async () => {});
    expect(second.container).toBeEmptyDOMElement();
    cleanup();
    vi.stubGlobal("fetch", vi.fn(() => Promise.reject(new Error("offline"))));
    const third = render(<CertPill />);
    await act(async () => {});
    expect(third.container).toBeEmptyDOMElement();
  });

  it("stops asking when the bar goes away", async () => {
    const fetchFn = answer(status());
    vi.stubGlobal("fetch", fetchFn);
    const { unmount } = render(<CertPill />);
    await act(async () => {});
    unmount();
    await act(async () => {
      vi.advanceTimersByTime(TLS_POLL_MS * 2);
    });
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it("sits after the connection pill in the top bar", async () => {
    vi.stubGlobal("fetch", answer(status({ stage: "expired", daysLeft: -1 })));
    render(<TopBar page="Admin" phase="live" reporters={2} />);
    const cert = await screen.findByRole("link", { name: "Certificate expired" });
    const connection = screen.getByText(/2 reporters live/);
    expect(connection.compareDocumentPosition(cert) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});
