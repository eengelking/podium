// Who an @ in a Direct Message names (#1282): resolved against the members of that conversation only, never the whole server. A message with no @ is for everyone; an @ that names
// a member is for that member; an @ that names someone who is not in it is refused, in words, so nothing goes to an agent the person did not mean.
import { describe, it, expect } from 'vitest';
import { resolveTargets, type TargetMember } from './chatConversationTargets.js';

const ED: TargetMember = { kind: 'person', ref: '1', name: 'Ed', machine: null, agentId: null };
const MAYA: TargetMember = { kind: 'person', ref: '2', name: 'Maya', machine: null, agentId: null };
const TESTER: TargetMember = { kind: 'agent', ref: 'sess-tester', name: 'Tester', machine: 'ed-mbp', agentId: 7 };
const NOTES: TargetMember = { kind: 'agent', ref: 'sess-notes', name: 'infra-notes', machine: 'ed-mbp', agentId: 8 };
const MEMBERS = [ED, MAYA, TESTER, NOTES];
const ask = (text: string, members: TargetMember[] = MEMBERS) => resolveTargets(text, members, { kind: 'person', ref: '1' });

describe('resolving the @ of a Direct Message', () => {
  it('is for everyone when there is no @', () => {
    expect(ask('run the suite')).toEqual({ ok: true, targets: null });
    expect(ask('mail me at ed@example.com')).toEqual({ ok: true, targets: null });
  });

  it('is for the one agent a name@machine names, and for no other', () => {
    expect(ask('@Tester@ed-mbp rerun it')).toEqual({ ok: true, targets: [{ kind: 'agent', ref: 'sess-tester', name: 'Tester', named: true }] });
  });

  it('reads a plain @Name of a member the same way, in any case', () => {
    expect(ask('@tester rerun it')).toEqual({ ok: true, targets: [{ kind: 'agent', ref: 'sess-tester', name: 'Tester', named: true }] });
  });

  it('is for several members when several are named, once each', () => {
    const out = ask('@Tester@ed-mbp and @infra-notes@ed-mbp and @Tester@ed-mbp again');
    expect(out).toEqual({
      ok: true,
      targets: [
        { kind: 'agent', ref: 'sess-tester', name: 'Tester', named: true },
        { kind: 'agent', ref: 'sess-notes', name: 'infra-notes', named: true },
      ],
    });
  });

  it('is for a person when name@console names one, and then for no agent', () => {
    expect(ask('@Maya@console can you check?')).toEqual({ ok: true, targets: [{ kind: 'person', ref: '2', name: 'Maya', named: true }] });
  });

  it('takes an @ of the writer as text, since a message is never for its own author', () => {
    expect(ask('@Ed@console note to self')).toEqual({ ok: true, targets: null });
  });

  it('refuses a name@machine that is not a member, in words, and names who it was', () => {
    const out = ask('@docs-sweeper@ed-mbp check the docs');
    expect(out).toMatchObject({ ok: false });
    expect((out as { error: string }).error).toBe('docs-sweeper@ed-mbp is not in this conversation, so nothing was sent. Add it from Members, or remove the @.');
  });

  it('refuses a member on another machine than the one named', () => {
    expect(ask('@Tester@other-box rerun it')).toMatchObject({ ok: false });
  });

  it('refuses a person who is not in it', () => {
    expect(ask('@Jo@console hello')).toMatchObject({ ok: false });
  });

  it('takes a plain @word that names nobody in it as text', () => {
    expect(ask('@types/node is out of date, and so is @angular/core')).toEqual({ ok: true, targets: null });
    expect(ask('thanks @everybody')).toEqual({ ok: true, targets: null });
  });

  it('does not read an @ inside a code span or block', () => {
    expect(ask('run `@Tester@ed-mbp` and\n```\n@infra-notes@ed-mbp\n```')).toEqual({ ok: true, targets: null });
  });

  it('refuses @group and @everyone, which a Direct Message does not have', () => {
    for (const w of ['@group', '@everyone']) {
      const out = ask(`${w} hello`);
      expect(out).toMatchObject({ ok: false });
      expect((out as { error: string }).error).toBe('@group and @everyone are not available in a Direct Message, so nothing was sent. Address a member as name@location, or remove the @.');
    }
  });

  it('refuses a plain name two members share, and says how to tell them apart', () => {
    const twin: TargetMember = { kind: 'agent', ref: 'sess-twin', name: 'Tester', machine: 'box-2', agentId: 9 };
    const out = ask('@Tester run it', [ED, TESTER, twin]);
    expect(out).toMatchObject({ ok: false });
    expect((out as { error: string }).error).toBe('More than one member is called Tester, so Podium cannot tell which you mean. Address one as Tester@ed-mbp, Tester@box-2.');
  });

  it('tells two agents of one name and machine apart by #id, an agent id and nothing else', () => {
    const twin: TargetMember = { kind: 'agent', ref: 'sess-twin', name: 'Tester', machine: 'ed-mbp', agentId: 9 };
    expect(ask('@Tester@ed-mbp#9 go', [ED, TESTER, twin])).toEqual({ ok: true, targets: [{ kind: 'agent', ref: 'sess-twin', name: 'Tester', named: true }] });
    expect(ask('@Tester@ed-mbp go', [ED, TESTER, twin])).toMatchObject({ ok: false });
  });

  it('finds an agent that has ended by its name, since the machine is no longer known', () => {
    const gone: TargetMember = { kind: 'agent', ref: 'sess-gone', name: 'Gone', machine: null, agentId: null };
    expect(ask('@Gone@ed-mbp hello', [ED, gone])).toEqual({ ok: true, targets: [{ kind: 'agent', ref: 'sess-gone', name: 'Gone', named: true }] });
  });
});
