// #1112: the launch announce's shared rule. A harness that has no session at launch reports a placeholder under an id of this shape.
import { describe, test as it, expect } from 'claude-code/testing';
import { isLaunchId, launchId, launchName } from './launch.ts';

/** The server's refusals for a session id (`badSessionId` in server/src/fleet/protocol.ts), which core may not import. */
const badSessionId = (id: string): string | null => (/^person:/i.test(id) || /^\.+$/.test(id) || /[|+/]/.test(id) ? 'refused' : null);

describe('launchId', () => {
  it('is an id the server accepts and isLaunchId recognizes', () => {
    const id = launchId('0f8e2c1a-77b4-4c11-9d0e-5b2f3a4c6d7e');
    expect(isLaunchId(id)).toBe(true);
    expect(badSessionId(id)).toBeNull();
    expect(id.length).toBeLessThanOrEqual(32);
  });

  it('drops characters the server refuses, and stays short', () => {
    const id = launchId('a/b|c+d person: ' + 'x'.repeat(100));
    expect(badSessionId(id)).toBeNull();
    expect(id.length).toBeLessThanOrEqual(32);
  });

  it('does not end in a hyphen after it is cut', () => {
    expect(launchId('abcdefghijklmnopqrstuvwx-yz')).toBe('launch-abcdefghijklmnopqrstuvwx');
    expect(launchId('abcdefghijklmnopqrstuvw-xyz').endsWith('-')).toBe(false);
  });

  it('trims a long run of hyphens in linear time', () => {
    const t = Date.now();
    expect(launchId('-'.repeat(20_000))).toBe('launch-');
    expect(launchId('a' + '-'.repeat(20_000))).toBe('launch-a');
    expect(Date.now() - t).toBeLessThan(1000);
  });

  it('does not mistake a real session id for a launch one', () => {
    expect(isLaunchId('ses_abc')).toBe(false);
    expect(isLaunchId('seed-dev-1')).toBe(false);
  });
});

describe('launchName', () => {
  it('is the folder the harness launched in', () => {
    expect(launchName('/work/podium', 'OpenCode')).toBe('podium');
  });

  it('falls back to the harness name when there is no folder', () => {
    expect(launchName(null, 'OpenCode')).toBe('OpenCode');
    expect(launchName('/', 'OpenCode')).toBe('OpenCode');
  });
});
