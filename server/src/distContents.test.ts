// What the build emits into server/dist (#756): the server's files and the code it shares with the reporter, and no test.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';

const serverDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const tsc = path.join(serverDir, '..', 'node_modules', 'typescript', 'bin', 'tsc');

describe('the server build (tsconfig.build.json)', () => {
  let files: string[] = [];
  beforeAll(() => {
    files = execFileSync(process.execPath, [tsc, '-p', 'tsconfig.build.json', '--listFilesOnly'], { cwd: serverDir, encoding: 'utf8' })
    .split('\n').filter((f) => f && !f.includes('/node_modules/')).map((f) => path.relative(path.join(serverDir, '..'), f));
  }, 120_000);

  it('compiles the entry and the code it imports', () => {
    expect(files).toContain('server/src/index.ts');
    expect(files).toContain('server/src/routes.ts');
    expect(files.some((f) => f.startsWith('plugin/core/'))).toBe(true);
  });

  it('compiles no test file', () => {
    expect(files.filter((f) => /\.test\.tsx?$/.test(f))).toEqual([]);
  });

  it('still type-checks the tests: npm run build runs tsconfig.json (which includes them) before the emit', () => {
    const pkg = JSON.parse(readFileSync(path.join(serverDir, 'package.json'), 'utf8')) as { scripts: { build: string } };
    expect(pkg.scripts.build).toMatch(/tsc -p tsconfig\.json --noEmit && .*tsc -p tsconfig\.build\.json/);
    expect(JSON.parse(readFileSync(path.join(serverDir, 'tsconfig.json'), 'utf8')).include).toEqual(['src']);
  });
});
