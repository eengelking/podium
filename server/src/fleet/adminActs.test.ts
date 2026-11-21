// An Admin stopping or deleting a person's recording, stored activity, session, token or reporter tells that person (#1078, PROJECT.md "An Admin Never Reads in Silence").
// The person is found by `people.id` (#1284), never by name.
import { describe, it, expect, vi } from 'vitest';
import { AdminActs, actThread, type ActDeps, type AdminRef } from './adminActs.js';

const ROOT: AdminRef = { name: 'Root', id: null };
const ED = { id: 11, name: 'Ed' };

function setup(over: Partial<ActDeps> = {}) {
  const marks: { thread: string; admin: AdminRef; kind: string; people?: number[] }[] = [];
  const told: { sessionId: string; text: string }[] = [];
  const deps: ActDeps = {
    mark: async (thread, admin, kind, people) => void marks.push({ thread, admin, kind, people }),
    tell: (sessionId, text) => void told.push({ sessionId, text }),
    sessionsOf: (ownerId) => (ownerId === 11 ? ['s1', 's2'] : []),
    sessionOf: async (id) => (id === 'gone' ? null : { name: id === 'ownerless' ? 'Loose' : 'Billing', owner: id === 'ownerless' ? null : 'Ed', ownerId: id === 'ownerless' ? null : id === 'newcomer' ? 12 : 11 }),
    ...over,
  };
  return { acts: new AdminActs(deps), marks, told };
}

describe('AdminActs', () => {
  it('records the act and tells every live session of the owner, naming the Admin and never any text', async () => {
    const { acts, marks, told } = setup();
    await acts.onSession(ROOT, 'recording_stopped', 'a-session');
    expect(marks).toEqual([{ thread: actThread(11), admin: ROOT, kind: 'recording_stopped', people: [11] }]);
    expect(told).toEqual([
      { sessionId: 's1', text: 'Root (an Admin) stopped the recording of your session Billing.' },
      { sessionId: 's2', text: 'Root (an Admin) stopped the recording of your session Billing.' },
    ]);
  });

  it('finds the person by id: a person with the same name and another id is not told, and is owed nothing', async () => {
    const { acts, marks, told } = setup();
    // The session is owned by id 12, who is also called Ed: id 11's sessions are not told, and the record is owed to 12 alone.
    await acts.onSession(ROOT, 'recording_stopped', 'newcomer');
    expect(marks).toEqual([{ thread: actThread(12), admin: ROOT, kind: 'recording_stopped', people: [12] }]);
    expect(told).toEqual([]);
    await acts.onPerson(ROOT, 'access_revoked', { id: 13, name: 'Ed' });
    expect(told).toEqual([]);
  });

  it('words each kind', async () => {
    const { acts, told } = setup({ sessionsOf: () => ['s1'] });
    await acts.onSession(ROOT, 'recording_deleted', 'x');
    await acts.onSession(ROOT, 'activity_deleted', 'x');
    await acts.onSession(ROOT, 'session_deleted', 'x');
    await acts.onPerson(ROOT, 'access_revoked', ED);
    await acts.onPerson(ROOT, 'reporter_removed', ED, 'your reporter ed-mbp');
    expect(told.map((t) => t.text)).toEqual([
      'Root (an Admin) deleted the recording of your session Billing.',
      'Root (an Admin) deleted the stored activity of your session Billing.',
      'Root (an Admin) deleted your session Billing.',
      'Root (an Admin) revoked your Podium access.',
      'Root (an Admin) removed your reporter ed-mbp from the Reporters list.',
    ]);
  });

  it('a deleted person gets the callout but no record, since nothing is left to show it on', async () => {
    const { acts, marks, told } = setup();
    await acts.onPerson(ROOT, 'person_deleted', ED);
    expect(marks).toEqual([]);
    expect(told.map((t) => t.text)).toEqual(['Root (an Admin) deleted your Podium account.', 'Root (an Admin) deleted your Podium account.']);
  });

  it('tells nobody about a session with no owner, an unknown session, or the Admin acting on their own', async () => {
    const { acts, marks, told } = setup();
    await acts.onSession(ROOT, 'session_deleted', 'ownerless');
    await acts.onSession(ROOT, 'session_deleted', 'gone');
    await acts.onPerson({ name: 'ed', id: 11 }, 'access_revoked', ED);
    expect(marks).toEqual([]);
    expect(told).toEqual([]);
  });

  it('records before it tells, and a failed record stops the act', async () => {
    const tell = vi.fn();
    const { acts } = setup({ mark: async () => { throw new Error('store down'); }, tell });
    await expect(acts.onSession(ROOT, 'recording_stopped', 'x')).rejects.toThrow('store down');
    expect(tell).not.toHaveBeenCalled();
  });
});
