// An Admin stopping or deleting a person's recording, stored activity, session, token or reporter tells that person (#1078, PROJECT.md "An Admin Never Reads in Silence").
import { describe, it, expect, vi } from 'vitest';
import { AdminActs, actThread, type ActDeps } from './adminActs.js';

function setup(over: Partial<ActDeps> = {}) {
  const marks: { thread: string; admin: string; kind: string; people?: string[] }[] = [];
  const told: { sessionId: string; text: string }[] = [];
  const deps: ActDeps = {
    mark: async (thread, admin, kind, people) => void marks.push({ thread, admin, kind, people }),
    tell: (sessionId, text) => void told.push({ sessionId, text }),
    sessionsOf: (owner) => (owner.toLowerCase() === 'ed' ? ['s1', 's2'] : []),
    sessionOf: async (id) => (id === 'gone' ? null : { name: id === 'ownerless' ? 'Loose' : 'Billing', owner: id === 'ownerless' ? null : 'Ed' }),
    ...over,
  };
  return { acts: new AdminActs(deps), marks, told };
}

describe('AdminActs', () => {
  it('records the act and tells every live session of the owner, naming the Admin and never any text', async () => {
    const { acts, marks, told } = setup();
    await acts.onSession('Root', 'recording_stopped', 'a-session');
    expect(marks).toEqual([{ thread: actThread('Ed'), admin: 'Root', kind: 'recording_stopped', people: ['ed'] }]);
    expect(told).toEqual([
      { sessionId: 's1', text: 'Root (an Admin) stopped the recording of your session Billing.' },
      { sessionId: 's2', text: 'Root (an Admin) stopped the recording of your session Billing.' },
    ]);
  });

  it('words each kind', async () => {
    const { acts, told } = setup({ sessionsOf: () => ['s1'] });
    await acts.onSession('Root', 'recording_deleted', 'x');
    await acts.onSession('Root', 'activity_deleted', 'x');
    await acts.onSession('Root', 'session_deleted', 'x');
    await acts.onPerson('Root', 'access_revoked', 'Ed');
    await acts.onPerson('Root', 'reporter_removed', 'Ed', 'your reporter ed-mbp');
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
    await acts.onPerson('Root', 'person_deleted', 'Ed');
    expect(marks).toEqual([]);
    expect(told.map((t) => t.text)).toEqual(['Root (an Admin) deleted your Podium account.', 'Root (an Admin) deleted your Podium account.']);
  });

  it('tells nobody about a session with no owner, an unknown session, or the Admin acting on their own', async () => {
    const { acts, marks, told } = setup();
    await acts.onSession('Root', 'session_deleted', 'ownerless');
    await acts.onSession('Root', 'session_deleted', 'gone');
    await acts.onPerson('ed', 'access_revoked', 'Ed');
    expect(marks).toEqual([]);
    expect(told).toEqual([]);
  });

  it('records before it tells, and a failed record stops the act', async () => {
    const tell = vi.fn();
    const { acts } = setup({ mark: async () => { throw new Error('store down'); }, tell });
    await expect(acts.onSession('Root', 'recording_stopped', 'x')).rejects.toThrow('store down');
    expect(tell).not.toHaveBeenCalled();
  });
});
