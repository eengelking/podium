// Types for rotation.mjs, so TypeScript can import it. (NodeNext looks for `rotation.d.mts` beside `rotation.mjs`.)
/** The new CA's PEM and whether the held CAs already include it; throws when the rotation does not check out. */
export function acceptRotation(rotation: unknown, held: readonly string[]): { pem: string; held: boolean };
