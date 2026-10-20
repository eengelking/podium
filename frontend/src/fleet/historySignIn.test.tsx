// Signing in to read stored Activity history (#432): the sign-in is offered when only that is on.
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, fireEvent, cleanup, act } from "@testing-library/react";
import { RespondProvider } from "./useRespond";
import { TopBarSignIn } from "./components/SignIn";
import type { RespondApi } from "./respondApi";
import type { RespondMe } from "./types";

const OUT: RespondMe = { enabled: true, signedIn: false, name: "", admin: false };
const api = () => ({ me: vi.fn(async () => OUT) }) as unknown as RespondApi & { me: ReturnType<typeof vi.fn> };
const flush = () =>
  act(async () => {
    for (let i = 0; i < 5; i++) await Promise.resolve();
  });

afterEach(cleanup);

function show(a: RespondApi, on: { flagsOn?: boolean; diffOn?: boolean; peersOn?: boolean; historyOn?: boolean }) {
  return render(
    <RespondProvider api={a} flagsOn={on.flagsOn ?? false} diffOn={on.diffOn} peersOn={on.peersOn} historyOn={on.historyOn}>
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
