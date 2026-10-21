// The server's structured logger (#140): the line shape, level filtering and the text format.
import { describe, it, expect } from 'vitest';
import { createLogger, loggerFromLine, parseFormat, parseLevel, type Level } from './logger.js';

function capture(opts: Parameters<typeof createLogger>[0] = {}) {
  const lines: { line: string; level: Level }[] = [];
  const shipped: string[] = [];
  const logger = createLogger({
    service: 'podium',
    host: 'box-1',
    version: '9.9.9',
    now: () => Date.UTC(2026, 9, 14, 12, 0, 0, 123),
    write: (line, level) => lines.push({ line, level }),
    ship: (json) => shipped.push(json),
    ...opts,
  });
  return { logger, lines, shipped };
}

describe('the JSON format', () => {
  it('writes one flat JSON object per line with the contract fields', () => {
    const { logger, lines } = capture({ format: 'json' });
    logger.warn('report.rejected', 'podium: rejected report at $.v: unsupported protocol version', { reason: 'unsupported protocol version', path: '$.v', status: 400 });
    expect(lines).toHaveLength(1);
    expect(lines[0]!.line).not.toContain('\n');
    expect(JSON.parse(lines[0]!.line)).toEqual({
      timestamp: '2026-10-14T12:00:00.123Z',
      level: 'warn',
      message: 'podium: rejected report at $.v: unsupported protocol version',
      event: 'report.rejected',
      service: 'podium',
      host: 'box-1',
      version: '9.9.9',
      reason: 'unsupported protocol version',
      path: '$.v',
      status: 400,
    });
  });

  it('keeps fields from overwriting the contract fields and drops nested values', () => {
    const { logger, lines } = capture({ format: 'json' });
    logger.info('x.y', 'hello', { level: 'error', service: 'evil', timestamp: 'never', nested: { a: 1 } as unknown as string, n: 3, gone: undefined });
    const rec = JSON.parse(lines[0]!.line);
    expect(rec.level).toBe('info');
    expect(rec.service).toBe('podium');
    expect(rec.timestamp).toBe('2026-10-14T12:00:00.123Z');
    expect(rec).not.toHaveProperty('nested');
    expect(rec).not.toHaveProperty('gone');
    expect(rec.n).toBe(3);
  });

  it('ships the JSON line whatever the local format', () => {
    const { logger, lines, shipped } = capture({ format: 'text' });
    logger.warn('report.rejected', 'podium: rejected report at $.v: bad', { path: '$.v' });
    expect(lines[0]!.line).toBe('podium: rejected report at $.v: bad');
    expect(JSON.parse(shipped[0]!)).toMatchObject({ event: 'report.rejected', path: '$.v', message: 'podium: rejected report at $.v: bad' });
  });

  it('can keep a line local, so the shipper can talk about itself without feeding its own buffer', () => {
    const { logger, lines, shipped } = capture();
    logger.log('warn', 'log.ship_dropped', 'dropping', {}, { ship: false });
    expect(lines).toHaveLength(1);
    expect(shipped).toHaveLength(0);
  });
});

describe('levels', () => {
  it('drops lines below the level, locally and for shipping', () => {
    const { logger, lines, shipped } = capture({ level: 'warn' });
    logger.debug('a', 'a');
    logger.info('b', 'b');
    logger.warn('c', 'c');
    logger.error('d', 'd');
    expect(lines.map((l) => l.line)).toEqual(['c', 'd']);
    expect(shipped).toHaveLength(2);
    expect(logger.isEnabled('info')).toBe(false);
    expect(logger.isEnabled('error')).toBe(true);
  });

  it('is info by default, so debug lines (one per request) are off', () => {
    const { logger, lines } = capture({ level: undefined });
    logger.debug('http.request', 'GET /');
    logger.info('server.start', 'up');
    expect(lines.map((l) => l.line)).toEqual(['up']);
  });

  it('parses the settings, falling back on junk', () => {
    expect(parseLevel('DEBUG')).toBe('debug');
    expect(parseLevel(' warn ')).toBe('warn');
    expect(parseLevel('loud')).toBeNull();
    expect(parseLevel(undefined)).toBeNull();
    expect(parseFormat('JSON')).toBe('json');
    expect(parseFormat('text')).toBe('text');
    expect(parseFormat('xml')).toBeNull();
  });
});

describe('the text format', () => {
  it('prints the message alone, as the server always has, and passes the level for the stream choice', () => {
    const { logger, lines } = capture();
    logger.warn('report.rejected', 'podium: rejected report at $.v: bad', { path: '$.v' });
    logger.info('server.start', 'Podium server listening on http://127.0.0.1:4317');
    expect(lines).toEqual([
      { line: 'podium: rejected report at $.v: bad', level: 'warn' },
      { line: 'Podium server listening on http://127.0.0.1:4317', level: 'info' },
    ]);
  });

  it('shows the events added in #140 only at debug, so the default output is what it was, but still ships them at their level', () => {
    for (const event of ['session.started', 'session.ended', 'session.deleted', 'reporter.connected', 'reporter.silent', 'sweep.removed', 'admin.unlock', 'admin.unlock_failed', 'report.conflict']) {
      const { logger, lines, shipped } = capture();
      logger.warn(event, `line for ${event}`);
      expect(lines, event).toEqual([]);
      expect(JSON.parse(shipped[0]!), event).toMatchObject({ event, level: 'warn' });
    }
    // The lines the server always printed stay at their level.
    for (const event of ['server.start', 'server.console', 'server.stop', 'report.rejected', 'hook.rejected', 'ingest.failed', 'request.failed', 'sweeper.failed']) {
      const { logger, lines } = capture();
      logger.info(event, `line for ${event}`);
      expect(lines.map((l) => l.line), event).toEqual([`line for ${event}`]);
    }
  });

  it('prints those events in text at debug, and in JSON at their own level', () => {
    const dbg = capture({ level: 'debug' });
    dbg.logger.info('session.started', 'podium: session s1 started');
    expect(dbg.lines).toEqual([{ line: 'podium: session s1 started', level: 'info' }]);
    const json = capture({ format: 'json' });
    json.logger.info('session.started', 'podium: session s1 started');
    expect(JSON.parse(json.lines[0]!.line)).toMatchObject({ event: 'session.started', level: 'info' });
  });

  describe('a refused credential (#602)', () => {
    const refuse = (logger: ReturnType<typeof capture>['logger'], reason = 'client certificate was revoked', source = 'laptop') =>
      logger.warn('auth.failed', `podium: refused POST /api/fleet/report from ${source}: ${reason}`, { route: '/api/fleet/report', reason, source, status: 401 });

    it('prints at warn without debug', () => {
      const { logger, lines } = capture();
      refuse(logger);
      expect(lines).toEqual([{ line: 'podium: refused POST /api/fleet/report from laptop: client certificate was revoked', level: 'warn' }]);
    });

    it('prints the tls.* events too, and still ships every one', () => {
      const { logger, lines, shipped } = capture();
      logger.warn('tls.client_refused', 'podium: TLS refused a client certificate from laptop: it has expired', { source: 'laptop', reason: 'it has expired' });
      expect(lines.map((l) => l.line)).toEqual(['podium: TLS refused a client certificate from laptop: it has expired']);
      expect(shipped).toHaveLength(1);
    });

    it('keeps tls.* events below warn at debug, so a startup line does not join the default output', () => {
      const { logger, lines } = capture();
      logger.info('tls.loaded', 'podium: TLS certificate loaded');
      expect(lines).toEqual([]);
    });

    it('folds a retry into one line, then says how many it held back once the window has passed', () => {
      let t = Date.UTC(2026, 9, 14, 12, 0, 0);
      const { logger, lines, shipped } = capture({ now: () => t });
      for (let i = 0; i < 5; i++) {
        refuse(logger);
        t += 5_000;
      }
      expect(lines).toHaveLength(1);
      expect(shipped).toHaveLength(5); // folding is for the text output only
      t += 60_000;
      refuse(logger);
      expect(lines).toHaveLength(2);
      expect(lines[1]!.line).toBe('podium: refused POST /api/fleet/report from laptop: client certificate was revoked (4 more in the last minute not printed)');
    });

    it('folds per route, source and reason, so a different refusal still prints', () => {
      const { logger, lines } = capture();
      refuse(logger);
      refuse(logger, 'client certificate has expired');
      refuse(logger, 'client certificate was revoked', 'desktop');
      expect(lines).toHaveLength(3);
    });

    it('does not fold in the JSON format', () => {
      const { logger, lines } = capture({ format: 'json' });
      refuse(logger);
      refuse(logger);
      expect(lines).toHaveLength(2);
    });

    it('keeps a bounded memory of what it folded', () => {
      const { logger, lines } = capture();
      for (let i = 0; i < 2000; i++) refuse(logger, 'wrong token', `host-${i}`);
      expect(lines).toHaveLength(2000);
      refuse(logger, 'wrong token', 'host-0'); // forgotten by now, so it prints again
      expect(lines).toHaveLength(2001);
    });
  });

  it('adapts a plain log(line) function, for the routers\' existing option', () => {
    const got: string[] = [];
    const logger = loggerFromLine((l) => got.push(l));
    logger.warn('report.rejected', 'podium: rejected report at $.v: bad');
    logger.debug('http.request', 'GET /');
    expect(got).toEqual(['podium: rejected report at $.v: bad']);
  });
});
