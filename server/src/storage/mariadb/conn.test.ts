// The connection (#823): what is bound and how, the URL, a transaction on a connection that dies, savepoints, and the values that come back.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MAX_REPORT_NUMBER } from '../../fleet/protocol.js';
import { MariaDbConn, asciiLower, bound, mariaLabel, numbers, parseTarget, positional, singleProcessLockName, toSafeNumber, typeCast } from './conn.js';
import { MAIN_MIGRATIONS, MAIN_STEPS, migrate } from './schema.js';
import { TEST_MARIADB, createTestDatabase, withConnection, type TestDatabase } from './testing.js';

describe('positional', () => {
  it('turns :name into ? in order, binding a name used twice twice, and leaves quoted text alone', () => {
    expect(positional("SELECT :a, ':b', \"c:d\", :a, :x", { a: 1, x: 2 })).toEqual({ text: "SELECT ?, ':b', \"c:d\", ?, ?", values: [1, 1, 2] });
    expect(positional('SELECT ?, ?', [1, 'two'])).toEqual({ text: 'SELECT ?, ?', values: [1, 'two'] });
  });

  it('quotes the column names MariaDB reserves when they are written in lower case, and leaves keywords and other words alone', () => {
    expect(positional('SELECT key, r.key, loop, "by" FROM t WHERE by = ? ORDER BY key', [1]).text).toBe('SELECT "key", r."key", "loop", "by" FROM t WHERE "by" = ? ORDER BY "key"');
    expect(positional("INSERT INTO s (key) VALUES ('key') ON DUPLICATE KEY UPDATE loops = 1, keys_x = 2, loop_json = 3", []).text).toBe("INSERT INTO s (\"key\") VALUES ('key') ON DUPLICATE KEY UPDATE loops = 1, keys_x = 2, loop_json = 3");
  });

  it('throws on a mismatch between placeholders and values, or a missing name', () => {
    expect(() => positional('SELECT ?, ?', [1])).toThrow('more ? placeholders than values');
    expect(() => positional('SELECT ?', [1, 2])).toThrow('fewer ? placeholders than values');
    expect(() => positional('SELECT :a', {})).toThrow('no value for :a');
    expect(() => positional('SELECT ?', undefined)).toThrow('more ? placeholders');
  });
});

describe('bound', () => {
  it('binds undefined and NaN as NULL, strips a NUL, makes a lone surrogate U+FFFD, and refuses an infinity', () => {
    expect(bound(undefined)).toBeNull();
    expect(bound(Number.NaN)).toBeNull();
    expect(bound('a\0b\0')).toBe('ab');
    expect(bound('x\udc00y')).toBe('x�y');
    expect(bound('ok 😀')).toBe('ok 😀');
    expect(bound(1.5)).toBe(1.5);
    expect(bound(true)).toBe(true);
    expect(() => bound(Number.POSITIVE_INFINITY)).toThrow('MariaDB cannot store Infinity');
    expect(() => bound(Number.NEGATIVE_INFINITY)).toThrow('MariaDB cannot store -Infinity');
  });
});

describe('numbers at the edge', () => {
  it('turns a bigint into a number, and throws for one a number cannot hold exactly', () => {
    expect(numbers({ a: 5n, b: 'x', c: null })).toEqual({ a: 5, b: 'x', c: null });
    expect(toSafeNumber('9007199254740991')).toBe(Number.MAX_SAFE_INTEGER);
    expect(() => toSafeNumber('9007199254740993')).toThrow(/MariaDB returned 9007199254740993/);
    expect(toSafeNumber('3.25')).toBe(3.25);
  });

  it('decodes a DECIMAL to a bigint when whole and a number when not, and passes every other column through', () => {
    const cast = (type: string, v: unknown) => typeCast({ type } as never, () => v as never);
    expect(cast('NEWDECIMAL', '42')).toBe(42n);
    expect(cast('NEWDECIMAL', '2.5000')).toBe(2.5);
    expect(cast('NEWDECIMAL', null)).toBeNull();
    expect(cast('BLOB', 'text')).toBe('text');
  });
});

describe('the URL', () => {
  it('reads the user, password, host, port and database, decoded, with or without a password, and an IPv6 host', () => {
    expect(parseTarget('mariadb://u%40x:p%3Ass@db.lan:3307/pod%5Fium')).toEqual({ host: 'db.lan', port: 3307, user: 'u@x', password: 'p:ss', database: 'pod_ium', ssl: false });
    expect(parseTarget('mariadb://root@127.0.0.1/podium_test')).toEqual({ host: '127.0.0.1', port: 3306, user: 'root', password: '', database: 'podium_test', ssl: false });
    expect(parseTarget('mariadb://u:p@[::1]:3306/d?ssl=true')).toMatchObject({ host: '::1', ssl: true });
    expect(parseTarget('mariadb://u:p@h/d?ssl=false').ssl).toBe(false);
  });

  it('refuses a URL with no database or with a parameter it does not take, without the password', () => {
    expect(() => parseTarget('mariadb://u:s3cret@h:3306/')).toThrow(/names its database.*h:3306\//);
    expect(() => parseTarget('mariadb://u:s3cret@h:3306')).not.toThrow(/s3cret/);
    expect(() => parseTarget('mariadb://u:s3cret@h/d?ssl=yes')).toThrow('"ssl" is not supported');
  });

  it('labels a URL with host, port and database only', () => {
    expect(mariaLabel('mariadb://u:s3cret@h:3306/podium')).toBe('h:3306/podium');
    expect(mariaLabel('mariadb://u:s3cret@h/podium')).toBe('h/podium');
    expect(mariaLabel('not a url')).toBe('mariadb://<unparseable>');
  });

  it('names the lock after the database, within the 64 characters MariaDB allows, and differently for each database', () => {
    const a = singleProcessLockName('podium');
    expect(a).toMatch(/^podium:[0-9a-f]{40}$/);
    expect(a.length).toBeLessThanOrEqual(64);
    expect(singleProcessLockName('x'.repeat(64))).not.toBe(a);
  });
});

describe('asciiLower', () => {
  it('replaces each ASCII capital and nothing else', () => {
    const sql = asciiLower('x');
    expect(sql.match(/REPLACE\(/g)).toHaveLength(26);
    expect(sql).toContain("'A', 'a'");
    expect(sql).toContain("'Z', 'z'");
  });
});

describe.skipIf(!TEST_MARIADB)('mariadb connection', () => {
  let td: TestDatabase;
  const conn = (max = 2) => new MariaDbConn({ target: parseTarget(td.url), max });
  const id = (db: MariaDbConn) => db.get<{ id: number }>('SELECT CONNECTION_ID() AS id').then((r) => r!.id);
  const kill = (cid: number) => withConnection(td.url, (c) => c.query(`KILL CONNECTION ${cid}`));

  beforeAll(async () => {
    td = await createTestDatabase();
    const db = conn();
    await migrate(db, MAIN_MIGRATIONS, MAIN_STEPS);
    await db.close();
  });
  afterAll(async () => {
    await td.drop();
  });

  it('sets utf8mb4, the byte collation, the SQL mode and READ COMMITTED on every connection', async () => {
    const db = conn();
    try {
      const r = (await db.get<Record<string, string>>('SELECT @@character_set_connection AS cs, @@collation_connection AS co, @@sql_mode AS m, @@tx_isolation AS iso'))!;
      expect(r.cs).toBe('utf8mb4');
      expect(r.co).toBe('utf8mb4_nopad_bin');
      expect(r.m.split(',')).toEqual(expect.arrayContaining(['STRICT_ALL_TABLES', 'ANSI_QUOTES', 'PIPES_AS_CONCAT']));
      expect(r.iso).toBe('READ-COMMITTED');
      // A literal compares as bytes too, and || joins text.
      expect(await db.get("SELECT 'a' = 'A' AS ci, 'a' = 'a ' AS pad, 'x' || 'y' AS cat")).toEqual({ ci: 0, pad: 0, cat: 'xy' });
    } finally {
      await db.close();
    }
  });

  it('hands back numbers for BIGINT, SUM and AVG, holds MAX_REPORT_NUMBER, and throws beyond the safe range', async () => {
    const db = conn();
    try {
      await db.exec('CREATE TABLE IF NOT EXISTS nums (n BIGINT)');
      await db.run('INSERT INTO nums VALUES (?), (?)', [MAX_REPORT_NUMBER, 3]);
      expect(await db.get('SELECT MAX(n) AS m, SUM(n) AS s, AVG(n) AS a, COUNT(*) AS c FROM nums WHERE n = ?', [MAX_REPORT_NUMBER])).toEqual({ m: MAX_REPORT_NUMBER, s: MAX_REPORT_NUMBER, a: MAX_REPORT_NUMBER, c: 1 });
      expect(await db.get('SELECT AVG(n) AS a FROM nums WHERE n = 3')).toEqual({ a: 3 });
      await db.run('INSERT INTO nums VALUES (?)', [2n ** 60n]);
      await expect(db.get('SELECT n FROM nums WHERE n > ?', [MAX_REPORT_NUMBER])).rejects.toThrow(/cannot hold exactly/);
      await expect(db.get('SELECT SUM(n) AS s FROM nums')).rejects.toThrow(/cannot hold exactly/);
    } finally {
      await db.close();
    }
  });

  it('rounds a fraction sent to an integer column, refuses 1e21 and an infinity: the divergence on the known list (#823)', async () => {
    const db = conn();
    try {
      await db.exec('CREATE TABLE IF NOT EXISTS frac (k VARCHAR(8) PRIMARY KEY, n BIGINT)');
      await db.run('INSERT INTO frac VALUES (?, ?), (?, ?)', ['a', 1.5, 'b', -2.5]);
      expect(await db.all('SELECT k, n FROM frac ORDER BY k')).toEqual([{ k: 'a', n: 2 }, { k: 'b', n: -3 }]);
      await expect(db.run('INSERT INTO frac VALUES (?, ?)', ['c', 1e21])).rejects.toThrow(/Out of range/);
      await expect(db.run('INSERT INTO frac VALUES (?, ?)', ['d', Number.POSITIVE_INFINITY])).rejects.toThrow('cannot store Infinity');
    } finally {
      await db.close();
    }
  });

  it('counts a row an UPDATE leaves as it was, as the other adapters do', async () => {
    const db = conn();
    try {
      await db.exec('CREATE TABLE IF NOT EXISTS same_t (id INT PRIMARY KEY, v INT)');
      await db.run('INSERT INTO same_t VALUES (1, 5)');
      expect(await db.run('UPDATE same_t SET v = 5 WHERE id = 1')).toBe(1);
    } finally {
      await db.close();
    }
  });

  it('does not reuse the connection of a transaction whose connection died', async () => {
    const db = conn(1);
    try {
      let dead = 0;
      await expect(db.tx(async () => {
        dead = await id(db);
        await kill(dead);
        await new Promise((r) => setTimeout(r, 100));
        await db.get('SELECT 1');
      })).rejects.toThrow();
      // With one connection the pool hands out the same slot again: a destroyed one is replaced, a released dead one would fail here.
      expect(await id(db)).not.toBe(dead);
    } finally {
      await db.close();
    }
  });

  it('destroys the connection when COMMIT fails on a dead connection', async () => {
    const db = conn(1);
    try {
      let dead = 0;
      await expect(db.tx(async () => {
        dead = await id(db);
        await kill(dead);
        await new Promise((r) => setTimeout(r, 100));
      })).rejects.toThrow();
      expect(await id(db)).not.toBe(dead);
    } finally {
      await db.close();
    }
  });

  it('keeps the original error when a savepoint cannot roll back', async () => {
    const db = conn();
    try {
      await expect(db.tx(async () => {
        await db.savepoint('sp_one', async () => {
          // Ends the savepoint from inside, so ROLLBACK TO SAVEPOINT in the catch has nothing to roll back to and throws.
          await db.exec('RELEASE SAVEPOINT sp_one');
          throw new Error('the real failure');
        });
      })).rejects.toThrow('the real failure');
    } finally {
      await db.close();
    }
  });

  it('lets a transaction go on after a failed statement, as SQLite does (only the statement is undone)', async () => {
    const db = conn();
    try {
      await db.exec('CREATE TABLE IF NOT EXISTS ab_t (id INT PRIMARY KEY)');
      await db.tx(async () => {
        await db.run('INSERT INTO ab_t VALUES (1)');
        await expect(db.run('INSERT INTO ab_t VALUES (1)')).rejects.toThrow(/Duplicate/);
        await db.run('INSERT INTO ab_t VALUES (2)');
      });
      expect((await db.all<{ id: number }>('SELECT id FROM ab_t ORDER BY id')).map((r) => r.id)).toEqual([1, 2]);
    } finally {
      await db.close();
    }
  });

  it('rolls a savepoint back alone and lets the transaction go on, and opens a transaction for a savepoint outside one', async () => {
    const db = conn();
    try {
      await db.exec('CREATE TABLE IF NOT EXISTS sp_t (id INT PRIMARY KEY)');
      await db.tx(async () => {
        await db.run('INSERT INTO sp_t VALUES (1)');
        await expect(db.savepoint('sp_dup', async () => {
          await db.run('INSERT INTO sp_t VALUES (3)');
          await db.run('INSERT INTO sp_t VALUES (1)');
        })).rejects.toThrow();
        await db.run('INSERT INTO sp_t VALUES (2)');
      });
      expect((await db.all<{ id: number }>('SELECT id FROM sp_t ORDER BY id')).map((r) => r.id)).toEqual([1, 2]);
      expect(await db.savepoint('alone', () => db.run('INSERT INTO sp_t VALUES (4)'))).toBe(1);
      expect((await db.all<{ id: number }>('SELECT id FROM sp_t ORDER BY id')).map((r) => r.id)).toEqual([1, 2, 4]);
    } finally {
      await db.close();
    }
  });

  it('runs every call through the pool after the lock is lost, and fails each of them with the reason', async () => {
    const db = conn();
    db.fail(new Error('lost the lock'));
    await expect(db.get('SELECT 1')).rejects.toThrow('lost the lock');
    await expect(db.exec('SELECT 1')).rejects.toThrow('lost the lock');
    await expect(db.tx(async () => 1)).rejects.toThrow('lost the lock');
    await db.close();
  });

  it('hands back the rows an INSERT or DELETE ... RETURNING names (10.5 and later)', async () => {
    const db = conn();
    try {
      await db.exec('CREATE TABLE IF NOT EXISTS ret_t (id BIGINT AUTO_INCREMENT PRIMARY KEY, v VARCHAR(8))');
      expect(await db.get('INSERT INTO ret_t (v) VALUES (?) RETURNING id', ['a'])).toEqual({ id: 1 });
      expect(await db.all('DELETE FROM ret_t WHERE v = ? RETURNING id, v', ['a'])).toEqual([{ id: 1, v: 'a' }]);
    } finally {
      await db.close();
    }
  });
});
