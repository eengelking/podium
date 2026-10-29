import { describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { PEER_DEFAULTS, PEER_RANGES, peerSettingError } from "../../../../server/src/storage/settings";
import { ADMIN_LIMIT_FIELDS, adminLimitCheck, PEER_LIMIT_DEFAULTS, PEER_LIMIT_FIELDS, PEER_LIMIT_RANGES, PeerLimits, peerLimitError, stillApplies, type PeerLimitKey, type PeerLimitsProps } from "./PeerLimits";

const KEYS: PeerLimitKey[] = ["roundTrips", "perMinute", "maxChars", "retainDays"];
const SAVED = { roundTrips: 10, perMinute: 6, maxChars: 20_000, retainDays: 30 };

describe("the limits agree with the server (#416)", () => {
  it("has the server's ranges and defaults", () => {
    expect(PEER_LIMIT_RANGES).toEqual(PEER_RANGES);
    expect(PEER_LIMIT_DEFAULTS).toEqual(PEER_DEFAULTS);
  });

  it("refuses what the server refuses, in its words", () => {
    for (const k of KEYS) {
      const { min, max } = PEER_RANGES[k];
      for (const v of [min - 1, min, max, max + 1, 1.5, "7", null, Number.NaN]) expect(peerLimitError(k, v)).toBe(peerSettingError(k, v));
      expect(peerLimitError(k, 5, 4)).toBe(peerSettingError(k, 5, 4));
    }
  });
});

function setup(over: Partial<PeerLimitsProps> = {}) {
  const onSave = vi.fn(async (_k: PeerLimitKey, _v: number | null): Promise<string | null> => null);
  const props: PeerLimitsProps = { idPrefix: "lim", fields: ADMIN_LIMIT_FIELDS, values: SAVED, onSave, ...over };
  const view = render(<PeerLimits {...props} />);
  return { onSave: props.onSave as typeof onSave, props, ...view };
}
const box = (label: RegExp) => screen.getByLabelText(label) as HTMLInputElement;
const leave = async (b: HTMLInputElement, value: string) => {
  fireEvent.change(b, { target: { value } });
  await act(async () => fireEvent.blur(b));
};

describe("PeerLimits, the Admin's limits (#416)", () => {
  it("draws a labelled box per limit in a settings row, with its line and range, and no state line or button", () => {
    const { container } = setup();
    for (const f of ADMIN_LIMIT_FIELDS) {
      const b = screen.getByLabelText(f.label) as HTMLInputElement;
      expect(b).toHaveClass("field", "mono", "daysbox");
      expect(b.closest(".srow")).not.toBeNull();
      expect(b.value).toBe(String(SAVED[f.key]));
      expect(b.min).toBe(String(PEER_LIMIT_RANGES[f.key].min));
      expect(b.max).toBe(String(PEER_LIMIT_RANGES[f.key].max));
      expect(b).not.toHaveAttribute("aria-describedby");
      expect(screen.getByText(f.hint)).toBeInTheDocument();
    }
    expect(container.querySelector(".row2")).toBeNull();
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("sends a value the server refused once, not again when the box loses focus after Enter", async () => {
    const onSave = vi.fn(async (): Promise<string | null> => "the server is busy");
    setup({ onSave });
    const b = box(/^Messages per minute/);
    fireEvent.change(b, { target: { value: "50" } });
    await act(async () => fireEvent.keyDown(b, { key: "Enter" }));
    await act(async () => fireEvent.blur(b));
    expect(onSave).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("alert")).toHaveTextContent(/the server is busy/i);
    // A changed value is sent again.
    fireEvent.change(b, { target: { value: "40" } });
    await act(async () => fireEvent.blur(b));
    expect(onSave).toHaveBeenCalledTimes(2);
  });

  it("saves a valid change when the box loses focus, once even after Enter", async () => {
    const { onSave } = setup();
    const b = box(/^Round trips/);
    fireEvent.change(b, { target: { value: "4" } });
    await act(async () => fireEvent.keyDown(b, { key: "Enter" }));
    await act(async () => fireEvent.blur(b));
    expect(onSave).toHaveBeenCalledTimes(1);
    expect(onSave).toHaveBeenCalledWith("roundTrips", 4);
  });

  it("sends nothing when the value did not change, and ignores other keys", async () => {
    const { onSave } = setup();
    const b = box(/^Messages per minute/);
    await act(async () => fireEvent.keyDown(b, { key: "a" }));
    await act(async () => fireEvent.blur(b));
    expect(onSave).not.toHaveBeenCalled();
  });

  it("refuses a value out of range in the row, keeps it, says nothing was saved and what still applies", async () => {
    const { onSave } = setup();
    const b = box(/^Round trips/);
    await leave(b, "0");
    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent("Round trips must be a whole number from 1 to 100. Nothing was saved. The saved value, 10, still applies.");
    expect(alert.tagName).toBe("P");
    expect(alert).toHaveClass("err");
    expect(b.closest(".srow")).toContainElement(alert);
    expect(b).toHaveAttribute("aria-invalid", "true");
    expect(b).toHaveAttribute("aria-describedby", "lim-roundTrips-e");
    expect(b.value).toBe("0");
    expect(onSave).not.toHaveBeenCalled();
    // The saved value typed back clears it and sends nothing; a new good value is saved.
    await leave(b, "10");
    expect(screen.queryByRole("alert")).toBeNull();
    expect(onSave).not.toHaveBeenCalled();
    await leave(b, "12");
    expect(onSave).toHaveBeenCalledWith("roundTrips", 12);
  });

  it("refuses an empty box and a fraction", async () => {
    setup();
    const b = box(/^Keep conversations/);
    await leave(b, "");
    expect(screen.getByRole("alert")).toHaveTextContent("Keep conversations must be a whole number from 1 to 365. Nothing was saved. The saved value, 30, still applies.");
    await leave(b, "2.5");
    expect(screen.getByRole("alert")).toHaveTextContent("Keep conversations must be a whole number from 1 to 365.");
  });

  it("shows the server's refusal the same way, and lets the same value be tried again with Enter", async () => {
    const onSave = vi.fn(async () => "longest message must be a whole number from 1 to 20000");
    setup({ onSave });
    const b = box(/^Longest message/);
    await leave(b, "500");
    expect(screen.getByRole("alert")).toHaveTextContent("Longest message must be a whole number from 1 to 20000. Nothing was saved. The saved value, 20000, still applies.");
    // Leaving the box again keeps the refusal and sends nothing; Enter tries again.
    await act(async () => fireEvent.blur(b));
    expect(onSave).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("alert")).toHaveTextContent("Nothing was saved.");
    await act(async () => fireEvent.keyDown(b, { key: "Enter" }));
    expect(onSave).toHaveBeenCalledTimes(2);
  });

  it("takes a newly saved value from the page", () => {
    const { rerender, props } = setup();
    rerender(<PeerLimits {...props} values={{ ...SAVED, perMinute: 9 }} />);
    expect(box(/^Messages per minute/).value).toBe("9");
  });

  it("disables every box while the values load", () => {
    setup({ values: null });
    for (const f of ADMIN_LIMIT_FIELDS) expect(screen.getByLabelText(f.label)).toBeDisabled();
  });
});

describe("PeerLimits, as an owner's stricter limits use it (#436)", () => {
  const fields = [PEER_LIMIT_FIELDS.roundTrips, PEER_LIMIT_FIELDS.perMinute];
  const admin = { roundTrips: 10, perMinute: 6 };

  it("caps a limit at the Admin's value, and draws a state line and a button that put focus back on the box", async () => {
    const use = vi.fn();
    setup({
      fields,
      values: { roundTrips: 10, perMinute: 3 },
      max: admin,
      state: { roundTrips: "Uses the Admin's limit, 10.", perMinute: "Yours, stricter than the Admin's limit, 6." },
      action: { perMinute: { label: "Use the Admin's limit", ariaLabel: "Messages per minute on a link: use the Admin's limit, 6", onClick: use } },
    });
    expect(screen.queryByLabelText(/^Longest message/)).toBeNull();
    const trips = box(/^Round trips/);
    expect(trips.max).toBe("10");
    expect(trips).toHaveAttribute("aria-describedby", "lim-roundTrips-s");
    expect(screen.getByText("Uses the Admin's limit, 10.")).toHaveAttribute("id", "lim-roundTrips-s");
    const b = screen.getByRole("button", { name: "Messages per minute on a link: use the Admin's limit, 6" });
    expect(b).toHaveTextContent("Use the Admin's limit");
    fireEvent.click(b);
    expect(use).toHaveBeenCalledTimes(1);
    expect(document.activeElement).toBe(document.getElementById("lim-perMinute"));
  });

  it("takes the page's own check and what a value is saved as, and its words for a refusal", async () => {
    const check = vi.fn((_k: PeerLimitKey, text: string, max: number) => (Number(text) > max ? `${text} is above the Admin's limit, ${max}. Nothing was saved.` : null));
    const toValue = (k: PeerLimitKey, n: number) => (n === admin[k as keyof typeof admin] ? null : n);
    const onSave = vi.fn(async (_k: PeerLimitKey, v: number | null) => (v === 1 ? "the server said no" : null));
    setup({ fields, values: { roundTrips: 4, perMinute: 6 }, max: admin, check, toValue, onSave, refused: (_k, e) => `Could not save: ${e}. Nothing was saved.` });
    const trips = box(/^Round trips/);
    await leave(trips, "15");
    expect(screen.getByRole("alert")).toHaveTextContent("15 is above the Admin's limit, 10. Nothing was saved.");
    expect(trips).toHaveAttribute("aria-describedby", "lim-roundTrips-e");
    expect(check).toHaveBeenCalledWith("roundTrips", "15", 10, 4);
    // Exactly the Admin's value means "use the Admin's": sent as null.
    await leave(trips, "10");
    expect(onSave).toHaveBeenLastCalledWith("roundTrips", null);
    await leave(box(/^Messages per minute/), "1");
    expect(screen.getByRole("alert")).toHaveTextContent("Could not save: the server said no. Nothing was saved.");
  });
});

describe("the default words", () => {
  it("say nothing was saved, and what still applies when something is", () => {
    expect(stillApplies(null)).toBe("Nothing was saved.");
    expect(stillApplies(undefined)).toBe("Nothing was saved.");
    expect(stillApplies(7)).toBe("Nothing was saved. The saved value, 7, still applies.");
    expect(adminLimitCheck("perMinute", " 6 ", 60, 6)).toBeNull();
    expect(adminLimitCheck("perMinute", "x", 60, undefined)).toBe("Messages per minute must be a whole number from 1 to 60. Nothing was saved.");
  });
});
