// Signing in to read stored Activity history (#432): the sign-in is offered when only that is on.
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, fireEvent, cleanup, act, within } from "@testing-library/react";
import { RespondProvider } from "./useRespond";
import { TopBarSignIn } from "./components/SignIn";
import { RespondError, type RespondApi } from "./respondApi";
import type { RespondMe } from "./types";

const OUT: RespondMe = { enabled: true, signedIn: false, name: "", admin: false };
const api = () => ({ me: vi.fn(async () => OUT) }) as unknown as RespondApi & { me: ReturnType<typeof vi.fn> };
const flush = () =>
  act(async () => {
    for (let i = 0; i < 5; i++) await Promise.resolve();
  });

afterEach(cleanup);

function show(a: RespondApi, on: { flagsOn?: boolean; diffOn?: boolean; peersOn?: boolean; historyOn?: boolean; recordingOn?: boolean }) {
  return render(
    <RespondProvider api={a} flagsOn={on.flagsOn ?? false} diffOn={on.diffOn} peersOn={on.peersOn} historyOn={on.historyOn} recordingOn={on.recordingOn}>
      <TopBarSignIn />
    </RespondProvider>,
  );
}

describe("sign-in for stored Activity history", () => {
  it("asks who is signed in, and offers Sign in, when only the history is on", async () => {
    const a = api();
    show(a, { historyOn: true });
    await flush();
    expect(a.me).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: "Sign in" })).toBeInTheDocument();
  });

  it("does not ask, and shows no Sign in, when responding, diffs, peers and history are all off", async () => {
    const a = api();
    show(a, {});
    await flush();
    expect(a.me).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: "Sign in" })).toBeNull();
  });

  it("with only the history on, the dialog talks about stored activity and not about responding", async () => {
    show(api(), { historyOn: true });
    await flush();
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
    expect(screen.getByText("To read the stored activity of your own sessions")).toBeInTheDocument();
    expect(screen.getByText(/Only the session's owner, or an Admin, can open stored activity\./)).toBeInTheDocument();
    expect(screen.queryByText(/respond/)).toBeNull();
    expect(screen.queryByText(/To answer and message/)).toBeNull();
  });

  it("keeps the responding wording while responding, diffs or peers are on", async () => {
    show(api(), { historyOn: true, flagsOn: true });
    await flush();
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
    expect(screen.getByText("To answer and message your own sessions")).toBeInTheDocument();
    expect(screen.getByText(/can respond\./)).toBeInTheDocument();
  });

  it.each([{ diffOn: true }, { peersOn: true }])("keeps the responding wording for %o", async (on) => {
    show(api(), { historyOn: true, ...on });
    await flush();
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
    expect(screen.getByText("To answer and message your own sessions")).toBeInTheDocument();
  });
});

describe("the sign-in form", () => {
  const open = async (signIn: (n: string, t: string) => Promise<unknown>) => {
    const a = { me: vi.fn(async () => OUT), signIn: vi.fn(signIn) } as unknown as RespondApi & { signIn: ReturnType<typeof vi.fn> };
    show(a, { flagsOn: true });
    await flush();
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
    return a;
  };
  const dialog = () => within(screen.getByRole("dialog"));

  it("says what is missing and focuses the field, without calling the server", async () => {
    const a = await open(async () => ({}));
    fireEvent.click(dialog().getByRole("button", { name: "Sign in" }));
    expect(screen.getByRole("alert")).toHaveTextContent("Enter your name and your token.");
    expect(document.activeElement).toBe(dialog().getByLabelText("Name"));
    fireEvent.change(dialog().getByLabelText("Name"), { target: { value: "Ed" } });
    fireEvent.click(dialog().getByRole("button", { name: "Sign in" }));
    expect(document.activeElement).toBe(dialog().getByLabelText("Token"));
    expect(a.signIn).not.toHaveBeenCalled();
  });

  it("submits on Enter in either field, and keeps the name but clears the token after a wrong try", async () => {
    const a = await open(async () => {
      throw new RespondError(401, { error: "no" });
    });
    fireEvent.change(dialog().getByLabelText("Name"), { target: { value: "Ed" } });
    fireEvent.keyDown(dialog().getByLabelText("Name"), { key: "Enter" });
    fireEvent.change(dialog().getByLabelText("Token"), { target: { value: "bad" } });
    fireEvent.keyDown(dialog().getByLabelText("Token"), { key: "Enter" });
    await flush();
    expect(a.signIn).toHaveBeenCalledWith("Ed", "bad");
    expect(screen.getByRole("alert")).toHaveTextContent("That name and token don't match.");
    expect(dialog().getByLabelText("Name")).toHaveValue("Ed");
    expect(dialog().getByLabelText("Token")).toHaveValue("");
    expect(document.activeElement).toBe(dialog().getByLabelText("Token"));
  });

  it("locks the fields after too many tries", async () => {
    await open(async () => {
      throw new RespondError(429, { error: "locked" });
    });
    fireEvent.change(dialog().getByLabelText("Name"), { target: { value: "Ed" } });
    fireEvent.change(dialog().getByLabelText("Token"), { target: { value: "x" } });
    fireEvent.click(dialog().getByRole("button", { name: "Sign in" }));
    await flush();
    expect(screen.getByRole("alert")).toHaveTextContent("Too many wrong tries");
    expect(dialog().getByLabelText("Name")).toBeDisabled();
  });

  it("closes the dialog once signed in", async () => {
    await open(async () => ({}));
    fireEvent.change(dialog().getByLabelText("Name"), { target: { value: "Ed" } });
    fireEvent.change(dialog().getByLabelText("Token"), { target: { value: "good" } });
    fireEvent.click(dialog().getByRole("button", { name: "Sign in" }));
    await flush();
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});

describe("sign-in for session recording (#353)", () => {
  it("with only recording on, the dialog talks about recording and not about responding", async () => {
    show(api(), { recordingOn: true });
    await flush();
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
    expect(screen.getByText("To record, and to open the recordings of, your own sessions")).toBeInTheDocument();
    expect(screen.getByText(/can choose, open and delete a recording\./)).toBeInTheDocument();
    expect(screen.queryByText(/To answer and message/)).toBeNull();
  });

  it("keeps the responding wording when responding is on too", async () => {
    show(api(), { recordingOn: true, flagsOn: true });
    await flush();
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
    expect(screen.getByText("To answer and message your own sessions")).toBeInTheDocument();
    expect(screen.getByText(/can respond\./)).toBeInTheDocument();
  });

  it("keeps the responding wording when history is on too", async () => {
    show(api(), { recordingOn: true, historyOn: true });
    await flush();
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
    expect(screen.getByText("To answer and message your own sessions")).toBeInTheDocument();
  });
});
