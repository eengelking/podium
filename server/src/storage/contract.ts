// A contract any Storage adapter must meet (#313): the same calls through the async interface return what the
// synchronous stores return. Run it from an adapter's test with a function that opens a fresh Storage.
import { describe, it, expect } from 'vitest';
import { FleetDb, openDb, type SessionRow } from '../fleet/db.js';
import { PeopleStore } from '../fleet/people.js';
import { ReporterStore, type ReporterSeen } from '../fleet/reporters.js';
import type { Storage } from './types.js';

export function session(over: Partial<SessionRow> = {}): SessionRow {
  return {
    id: 's1', name: 'one', status: 'running', wait_reason: null, wait_note: null, end_reason: null, resume_id: null,
    started_at: 1000, last_seen_at: 2000, ended_at: null, dropped_at: null, cwd: '/w', project_root: null, repo_name: null,
    git_json: null, model: 'm', effort: null, context_tokens: null, context_window: null, context_percent: null,
    cost_usd: 1.5, tok_in: 1, tok_out: 2, tok_cr: 3, tok_cw: 4, rate_limits_json: null, blowouts: 0, plan_json: null,
    reporter_version: null, engine_version: null, loop_json: null, files_json: null, background_json: null,
    usage_json: null, attached: null, detached_at: null, owner: 'ed', machine_json: null, cleared_from: null,
    ...over,
  };
}

const seen: ReporterSeen = {
  kind: 'mod', machineId: 'm1', machineName: 'box', source: '10.0.0.1', owner: 'ed', credential: 'person',
  version: '0.1.0', engineVersion: null, sessionId: 's1',
};

export function runStorageContract(name: string, open: () => Storage): void {
  describe(`${name} storage contract`, () => {
    it('matches the synchronous stores for people, the admin log and settings', async () => {
      const store = open();
      const raw = openDb(':memory:');
      const people = new PeopleStore(raw);
      expect(await store.people.adminReportingAllowed()).toBe(people.adminReportingAllowed());
      await store.people.setAdminReporting(false);
      people.setAdminReporting(false);
      expect(await store.people.adminReportingAllowed()).toBe(false);
      expect(await store.people.createGroup('Crew', 5)).toEqual(people.createGroup('Crew', 5));
      await store.people.log('kind', 'detail', 'src', 10, 'me');
      people.log('kind', 'detail', 'src', 10, 'me');
      expect(await store.people.listLog({})).toEqual(people.listLog({}));
      expect(await store.people.allGroups()).toEqual(people.allGroups());
      await store.close();
    });

    it('matches the synchronous stores for sessions', async () => {
      const store = open();
      const fleet = new FleetDb(openDb(':memory:'));
      await store.fleet.upsertSession(session());
      fleet.upsertSession(session());
      expect(await store.fleet.getSession('s1')).toEqual(fleet.getSession('s1'));
      expect(await store.fleet.getSession('nope')).toBeUndefined();
      expect(await store.fleet.liveCandidates(0)).toEqual(fleet.liveCandidates(0));
      await store.close();
    });

    it('matches the synchronous stores for reporters and the peer lookup', async () => {
      const store = open();
      const reporters = new ReporterStore(openDb(':memory:'), 0);
      const key = await store.reporters.record(seen, 50);
      expect(key).toBe(reporters.record(seen, 50));
      expect(await store.reporters.hasAny()).toBe(true);
      expect(await store.reporters.list({}, 60)).toEqual(reporters.list({}, 60));
      const lookup = store.reporters.peerLookup();
      expect(await lookup.get(key)).toEqual(reporters.peerLookup().get(key));
      expect(await lookup.ofOwner('ED')).toEqual(reporters.peerLookup().ofOwner('ED'));
      expect(await lookup.ofOwnerSeen('ed', 60)).toEqual(reporters.peerLookup().ofOwnerSeen('ed', 60));
      expect(lookup.startedAt).toBe(reporters.peerLookup().startedAt);
      await store.close();
    });
  });
}
