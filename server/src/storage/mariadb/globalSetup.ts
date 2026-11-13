// Vitest global setup (see vitest.config.ts): runs once before any test file, after the PostgreSQL one (which runs the server gate for
// every registered adapter). Not used at run time.
import { mariaGate } from './gate.js';

export default async function setup(): Promise<void> {
  try {
    await mariaGate();
  } catch (e) {
    // Vitest 5 crashes with "code.charCodeAt is not a function" while it maps the stack of an error thrown here and shows nothing of
    // the message. So the message is printed first and the error carries no stack for it to map.
    const err = e instanceof Error ? e : new Error(String(e));
    console.error(`\n  x ${err.message}\n`);
    err.stack = err.message;
    throw err;
  }
}
