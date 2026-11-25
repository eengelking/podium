// Who owns a session is decided by the person's id, never by the name (#1284): a name can change, and a newcomer can take a deleted person's name.
import { describe, expect, it } from "vitest";
import { makeSession } from "./fixtures";
import { canRespond, isMine, ownsSession } from "./respond";
import type { RespondMe } from "./types";

const me = (over: Partial<RespondMe> = {}): RespondMe => ({ enabled: true, signedIn: true, name: "Ed", id: 1, admin: false, ...over });

describe("who owns a session, by id (#1284)", () => {
  it("is the person whose id the session carries", () => {
    const s = makeSession({ owner: "Ed", ownerId: 1 });
    expect(ownsSession(s, me())).toBe(true);
    expect(isMine(s, me())).toBe(true);
    expect(canRespond(s, me())).toBe(true);
  });

  it("is not a same-named newcomer's: the name matches, the id does not", () => {
    const earlier = makeSession({ owner: "Ed", ownerId: 1 });
    const newcomer = me({ id: 2 });
    expect(ownsSession(earlier, newcomer)).toBe(false);
    expect(isMine(earlier, newcomer)).toBe(false);
    expect(canRespond(earlier, newcomer)).toBe(false);
  });

  it("is nobody's once its person was deleted (ownerId null), even for a person of the same name", () => {
    const detached = makeSession({ owner: "Ed", ownerId: null });
    expect(ownsSession(detached, me())).toBe(false);
    expect(isMine(detached, me())).toBe(false);
    expect(canRespond(detached, me())).toBe(false);
  });

  it("is never the admin secret's (it has no id) and never a signed-out viewer's", () => {
    const s = makeSession({ owner: "Ed", ownerId: 1 });
    expect(ownsSession(s, me({ name: "Admin", id: null, admin: true }))).toBe(false);
    expect(ownsSession(s, me({ signedIn: false, name: null, id: null }))).toBe(false);
    expect(ownsSession(s, null)).toBe(false);
  });

  it("lets an Admin read any session, but answer a detached person's only once an Admin is allowed", () => {
    const admin = me({ name: "Root", id: 7, admin: true });
    expect(isMine(makeSession({ owner: "Ed", ownerId: null }), admin)).toBe(true);
    expect(canRespond(makeSession({ owner: "Ed", ownerId: null, adminRespond: false }), admin)).toBe(false);
    expect(canRespond(makeSession({ owner: "Ed", ownerId: null, adminRespond: true }), admin)).toBe(true);
    expect(canRespond(makeSession({ owner: "Root", ownerId: 7 }), admin)).toBe(true);
  });
});
