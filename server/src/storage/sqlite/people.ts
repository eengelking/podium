// People, their tokens, groups, the admin log and server settings (issue #36). All statements are parameterized.
// A token is returned once, at creation or rotation, and never stored; see tokens.ts.
import type { DatabaseSync, StatementSync } from 'node:sqlite';
import { newPersonToken, parsePersonToken, tokenMatches } from '../../fleet/tokens.js';
import { PeopleError, MAX_PAGE_SIZE, DEFAULT_PAGE_SIZE, ADMIN_OWNER, ADMINISTRATORS_GROUP, ADMIN_SECRET_ACTOR, type PersonRow, type PersonListRow, type GroupListRow, type LogRow, type Paged, type PageIn, nameKey } from '../rows.js';

/** How long a machine stays in a person's list without reporting, and how many are kept (#379). */
const MACHINE_MAX_AGE_MS = 30 * 86_400_000;
const MACHINES_KEPT = 10;
const NAME_MAX = 48;
const GROUP_MAX = 24;

/** Page and size clamped to what the Admin API allows. */
export function clampPage(p: Partial<PageIn>): PageIn {
  const size = Math.trunc(Number(p.pageSize));
  const page = Math.trunc(Number(p.page));
  return {
    page: Number.isFinite(page) && page >= 1 ? Math.min(page, 1_000_000) : 1,
    pageSize: Number.isFinite(size) && size >= 1 ? Math.min(size, MAX_PAGE_SIZE) : DEFAULT_PAGE_SIZE,
  };
}

function cleanName(raw: string, max: number, what: string): string {
  const name = raw.trim().replace(/ +/g, ' ');
  // eslint-disable-next-line no-control-regex
  if (name.length < 1 || name.length > max || /[\u0000-\u001f\u007f]/.test(name)) {
    throw new PeopleError('invalid', `${what} must be 1 to ${max} characters, with no control characters`);
  }
  return name;
}

/** Escapes LIKE wildcards so a search for `%` finds a literal percent sign and not everything. */
export function likeTerm(q: string): string {
  return `%${q.toLowerCase().replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

interface DbPerson {
  id: number;
  name: string;
  key_id: string;
  token_hash: string;
  group_id: number | null;
  created_at: number;
  rotated_at: number | null;
  revoked_at: number | null;
  last_report_at: number | null;
}
const toPerson = (r: DbPerson): PersonRow => ({
  id: r.id,
  name: r.name,
  keyId: r.key_id,
  tokenHash: r.token_hash,
  groupId: r.group_id,
  createdAt: r.created_at,
  rotatedAt: r.rotated_at,
  revokedAt: r.revoked_at,
  lastReportAt: r.last_report_at,
});

export class PeopleStore {
  private readonly stmts = new Map<string, StatementSync>();
  constructor(readonly db: DatabaseSync) {}

  private stmt(sql: string): StatementSync {
    let s = this.stmts.get(sql);
    if (!s) {
      s = this.db.prepare(sql);
      this.stmts.set(sql, s);
    }
    return s;
  }

  // ---- people ---------------------------------------------------------------------------------

  createPerson(rawName: string, groupId: number | null = null, now = Date.now()): { person: PersonRow; token: string } {
    const name = cleanName(rawName, NAME_MAX, 'A name');
    // 'Admin' is the owner the server gives a report made with the admin secret; a person of that name would share it.
    if (name.toLowerCase() === ADMIN_OWNER.toLowerCase()) throw new PeopleError('invalid', `${ADMIN_OWNER} is reserved for the admin secret`);
    // The Admin log's Who column shows this actor for the secret; a person of that name would be indistinguishable from it.
    if (name.toLowerCase() === ADMIN_SECRET_ACTOR.toLowerCase()) throw new PeopleError('invalid', `${ADMIN_SECRET_ACTOR} is reserved for the admin secret`);
    if (this.findByName(name)) throw new PeopleError('duplicate', 'That name is already taken');
    if (groupId !== null && !this.stmt('SELECT 1 AS x FROM groups WHERE id = ?').get(groupId)) {
      throw new PeopleError('not_found', 'That group does not exist');
    }
    const t = newPersonToken();
    const r = this.stmt(
      `INSERT INTO people (name, name_lower, key_id, token_hash, group_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(name, name.toLowerCase(), t.keyId, t.hash, groupId, now);
    return { person: this.getPerson(Number(r.lastInsertRowid))!, token: t.token };
  }

  getPerson(id: number): PersonRow | undefined {
    const r = this.stmt('SELECT * FROM people WHERE id = ?').get(id) as DbPerson | undefined;
    return r && toPerson(r);
  }

  findByKeyId(keyId: string): PersonRow | undefined {
    const r = this.stmt('SELECT * FROM people WHERE key_id = ?').get(keyId) as DbPerson | undefined;
    return r && toPerson(r);
  }

  findByName(name: string): PersonRow | undefined {
    const r = this.stmt('SELECT * FROM people WHERE name_lower = ?').get(nameKey(name)) as
      | DbPerson
      | undefined;
    return r && toPerson(r);
  }

  /** New token for a person; the old one stops working and a revoked person is restored. Null if no such person. */
  rotate(id: number, now = Date.now()): { person: PersonRow; token: string } | null {
    if (!this.getPerson(id)) return null;
    const t = newPersonToken();
    this.stmt(
      'UPDATE people SET key_id = ?, token_hash = ?, rotated_at = ?, revoked_at = NULL WHERE id = ?',
    ).run(t.keyId, t.hash, now, id);
    return { person: this.getPerson(id)!, token: t.token };
  }

  /** Lifts a revocation without touching the token, as a certificate reissue does. True if the person was revoked. */
  restore(id: number): boolean {
    return Number(this.stmt('UPDATE people SET revoked_at = NULL WHERE id = ? AND revoked_at IS NOT NULL').run(id).changes) > 0;
  }

  revoke(id: number, now = Date.now()): boolean {
    return Number(this.stmt('UPDATE people SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL').run(now, id).changes) > 0;
  }

  /**
   * Throws, changing nothing, when `id` is the only active member of Administrators: revoking their token would leave nobody
   * who can sign in to Admin with a name and a token (#583). A person outside the group, or already revoked, is fine.
   */
  assertNotLastAdministrator(id: number): void {
    const adminsId = this.administratorsGroupId();
    const p = this.getPerson(id);
    if (adminsId === null || !p || p.groupId !== adminsId || p.revokedAt !== null) return;
    const members = Number((this.stmt('SELECT COUNT(*) AS n FROM people WHERE group_id = ? AND revoked_at IS NULL').get(adminsId) as { n: number }).n);
    if (members <= 1) throw new PeopleError('invalid', `${p.name} is the last person in ${ADMINISTRATORS_GROUP} who can sign in. Add or move another person into it first.`);
  }

  /**
   * Deletes these people in one step (#243); unknown ids are skipped. Their machines go with them. Sessions, spend and
   * Admin log entries keep the name as text. Refuses, deleting nobody, if it would leave Administrators empty.
   * Returns the people it removed.
   */
  deleteMany(ids: number[]): PersonRow[] {
    const found = [...new Set(ids)].map((id) => this.getPerson(id)).filter((p): p is PersonRow => p !== undefined);
    const adminsId = this.administratorsGroupId();
    // Only an active member can open Admin (isAdministrator), so only an active one counts as "the last".
    const goingAdmins = found.filter((p) => p.groupId === adminsId && p.revokedAt === null);
    if (adminsId !== null && goingAdmins.length > 0) {
      const members = Number((this.stmt('SELECT COUNT(*) AS n FROM people WHERE group_id = ? AND revoked_at IS NULL').get(adminsId) as { n: number }).n);
      if (goingAdmins.length >= members) {
        throw new PeopleError('invalid', `That would remove the last person in ${ADMINISTRATORS_GROUP}. Add or move another person into it first.`);
      }
    }
    this.db.exec('BEGIN');
    try {
      for (const p of found) this.stmt('DELETE FROM people WHERE id = ?').run(p.id);
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
    return found;
  }

  /**
   * Records a report from a person: the time and the machine it came from. A machine that sent an id is listed once as
   * `name (first four of id)`; one that did not is listed by its source address. The list is bounded (#379): machines
   * unseen for MACHINE_MAX_AGE_MS go, and so does everything past the MACHINES_KEPT most recent.
   */
  touch(personId: number, address: string | null, now: number, machine?: { name: string; id: string } | null): void {
    this.stmt('UPDATE people SET last_report_at = ? WHERE id = ?').run(now, personId);
    const label = machine ? `${machine.name} (${machine.id.slice(0, 4)})` : address;
    if (!label) return;
    this.stmt(
      `INSERT INTO person_machines (person_id, machine, last_seen_at) VALUES (?, ?, ?)
       ON CONFLICT(person_id, machine) DO UPDATE SET last_seen_at = excluded.last_seen_at`,
    ).run(personId, label.slice(0, 120), now);
    this.stmt('DELETE FROM person_machines WHERE person_id = ? AND last_seen_at < ?').run(personId, now - MACHINE_MAX_AGE_MS);
    this.stmt(
      `DELETE FROM person_machines WHERE person_id = ? AND machine NOT IN
         (SELECT machine FROM person_machines WHERE person_id = ? ORDER BY last_seen_at DESC, machine LIMIT ?)`,
    ).run(personId, personId, MACHINES_KEPT);
  }

  setGroup(personId: number, groupId: number | null): boolean {
    if (!this.getPerson(personId)) return false;
    if (groupId !== null && !this.stmt('SELECT 1 AS x FROM groups WHERE id = ?').get(groupId)) return false;
    this.stmt('UPDATE people SET group_id = ? WHERE id = ?').run(groupId, personId);
    return true;
  }

  list(opts: Partial<PageIn> & { q?: string }): Paged<PersonListRow> {
    const { page, pageSize } = clampPage(opts);
    const q = (opts.q ?? '').trim().slice(0, 100);
    const where = q
      ? `WHERE p.name_lower LIKE :like ESCAPE '\\' OR lower(COALESCE(g.name, '')) LIKE :like ESCAPE '\\'
           OR EXISTS (SELECT 1 FROM person_machines m WHERE m.person_id = p.id AND lower(m.machine) LIKE :like ESCAPE '\\')`
      : '';
    const params: Record<string, string | number> = q ? { like: likeTerm(q) } : {};
    const total = (
      this.stmt(`SELECT COUNT(*) AS n FROM people p LEFT JOIN groups g ON g.id = p.group_id ${where}`).get(params) as { n: number }
    ).n;
    const rows = this.stmt(
      `SELECT p.*, g.name AS group_name FROM people p LEFT JOIN groups g ON g.id = p.group_id ${where}
       ORDER BY p.name_lower LIMIT :limit OFFSET :offset`,
    ).all({ ...params, limit: pageSize, offset: (page - 1) * pageSize }) as unknown as (DbPerson & { group_name: string | null })[];
    // One query for the whole page's machines, not one per row.
    const machines = new Map<number, string[]>();
    if (rows.length) {
      const ids = rows.map((r) => r.id);
      const found = this.db
        .prepare(`SELECT person_id, machine FROM person_machines WHERE person_id IN (${ids.map(() => '?').join(',')}) ORDER BY machine`)
        .all(...ids) as { person_id: number; machine: string }[];
      for (const m of found) (machines.get(m.person_id) ?? machines.set(m.person_id, []).get(m.person_id)!).push(m.machine);
    }
    return {
      total,
      page,
      pageSize,
      rows: rows.map((r) => {
        const { tokenHash: _h, keyId, ...rest } = toPerson(r);
        void _h;
        return { ...rest, credential: `pdm_${keyId}`, groupName: r.group_name, machines: machines.get(r.id) ?? [] };
      }),
    };
  }

  // ---- groups ---------------------------------------------------------------------------------

  createGroup(rawName: string, now = Date.now()): { id: number; name: string } {
    const name = cleanName(rawName, GROUP_MAX, 'A group name');
    if (this.stmt('SELECT 1 AS x FROM groups WHERE name_lower = ?').get(name.toLowerCase())) {
      throw new PeopleError('duplicate', 'That group already exists');
    }
    const r = this.stmt('INSERT INTO groups (name, name_lower, created_at) VALUES (?, ?, ?)').run(name, name.toLowerCase(), now);
    return { id: Number(r.lastInsertRowid), name };
  }

  getGroup(id: number): { id: number; name: string } | undefined {
    return this.stmt('SELECT id, name FROM groups WHERE id = ?').get(id) as { id: number; name: string } | undefined;
  }

  /** Deletes a group. Its people stay and move to no group (ON DELETE SET NULL). */
  deleteGroup(id: number): boolean {
    if (id === this.administratorsGroupId()) throw new PeopleError('invalid', `${ADMINISTRATORS_GROUP} is built in and cannot be deleted`);
    return Number(this.stmt('DELETE FROM groups WHERE id = ?').run(id).changes) > 0;
  }

  listGroups(opts: Partial<PageIn>): Paged<GroupListRow> {
    const { page, pageSize } = clampPage(opts);
    const total = (this.stmt('SELECT COUNT(*) AS n FROM groups').get() as { n: number }).n;
    const rows = this.stmt('SELECT id, name, created_at FROM groups ORDER BY name_lower LIMIT ? OFFSET ?').all(
      pageSize,
      (page - 1) * pageSize,
    ) as unknown as { id: number; name: string; created_at: number }[];
    const adminsId = this.administratorsGroupId();
    const members = new Map<number, string[]>();
    if (rows.length) {
      const ids = rows.map((g) => g.id);
      const found = this.db
        .prepare(`SELECT group_id, name FROM people WHERE group_id IN (${ids.map(() => '?').join(',')}) ORDER BY name_lower`)
        .all(...ids) as { group_id: number; name: string }[];
      for (const m of found) (members.get(m.group_id) ?? members.set(m.group_id, []).get(m.group_id)!).push(m.name);
    }
    return {
      total,
      page,
      pageSize,
      rows: rows.map((g) => ({ id: g.id, name: g.name, createdAt: g.created_at, members: members.get(g.id) ?? [], builtIn: g.id === adminsId })),
    };
  }

  /** Every group, for the pick list on the People tab (groups are few; people are paged). */
  allGroups(): { id: number; name: string; builtIn: boolean }[] {
    const adminsId = this.administratorsGroupId();
    const rows = this.stmt('SELECT id, name FROM groups ORDER BY name_lower').all() as unknown as { id: number; name: string }[];
    return rows.map((g) => ({ ...g, builtIn: g.id === adminsId }));
  }

  // ---- administrators (issue #172) -------------------------------------------------------------

  administratorsGroupId(): number | null {
    const r = this.stmt('SELECT id FROM groups WHERE name_lower = ?').get(ADMINISTRATORS_GROUP.toLowerCase()) as { id: number } | undefined;
    return r?.id ?? null;
  }

  /** True when the person exists, their token is not revoked and they are in Administrators. */
  isAdministrator(personId: number): boolean {
    const p = this.getPerson(personId);
    return !!p && p.revokedAt === null && p.groupId !== null && p.groupId === this.administratorsGroupId();
  }

  /** The administrator a presented token belongs to, or undefined (unknown, revoked, wrong token or not in Administrators). */
  findAdministratorByToken(token: string): PersonRow | undefined {
    const parsed = parsePersonToken(token);
    if (!parsed) return undefined;
    const p = this.findByKeyId(parsed.keyId);
    if (!p || !tokenMatches(token, p.tokenHash)) return undefined;
    return this.isAdministrator(p.id) ? p : undefined;
  }

  // ---- settings and log -----------------------------------------------------------------------

  adminReportingAllowed(): boolean {
    const r = this.stmt("SELECT value FROM settings WHERE key = 'allow_admin_secret_reporting'").get() as { value: string } | undefined;
    return r ? r.value === '1' : true;
  }

  setAdminReporting(on: boolean): void {
    this.stmt(
      `INSERT INTO settings (key, value) VALUES ('allow_admin_secret_reporting', ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    ).run(on ? '1' : '0');
  }

  /** Never pass a token or the admin secret in `detail`. */
  log(kind: string, detail: string, source: string, now = Date.now(), actor: string | null = null): void {
    this.stmt('INSERT INTO admin_log (t, kind, detail, source, actor) VALUES (?, ?, ?, ?, ?)').run(
      now,
      kind.slice(0, 40),
      detail.slice(0, 300),
      source.slice(0, 80),
      actor === null ? null : actor.slice(0, 80),
    );
  }

  listLog(opts: Partial<PageIn>): Paged<LogRow> {
    const { page, pageSize } = clampPage(opts);
    const total = (this.stmt('SELECT COUNT(*) AS n FROM admin_log').get() as { n: number }).n;
    const rows = this.stmt('SELECT id, t, kind, detail, source, actor FROM admin_log ORDER BY id DESC LIMIT ? OFFSET ?').all(
      pageSize,
      (page - 1) * pageSize,
    ) as unknown as LogRow[];
    return { total, page, pageSize, rows };
  }
}
