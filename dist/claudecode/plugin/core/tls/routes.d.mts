// Types for routes.mjs, so the server's TypeScript can import it. (NodeNext looks for `routes.d.mts` beside `routes.mjs`.)
/** The reporter calls: [method, path]; `:id` is one path segment. */
export const REPORTER_ROUTES: ReadonlyArray<readonly [method: string, path: string]>;
/** The upstream request for a request handed to the helper, or null when it is not a reporter route. */
export function reporterTarget(method: unknown, url: unknown): { method: string; path: string } | null;
