// Writes dist/index.js, the entry `node server/dist/index.js` has always been. The build compiles plugin/core/ (the one copy
// of the report types) next to the server, so the server's own files sit at dist/server/src/; this file starts them.
// tsc does not emit a `.mjs` it only reads through a `.d.mts`, so the reporter route list (plugin/core/tls/routes.mjs, one copy
// for the mod's helper and the server's gate, #948) is copied to the place the compiled server imports it from.
import { copyFileSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const dist = path.join(here, 'dist');
writeFileSync(path.join(dist, 'index.js'), 'import "./server/src/index.js";\n');
const tls = path.join(dist, 'plugin', 'core', 'tls');
mkdirSync(tls, { recursive: true });
copyFileSync(path.join(here, '..', 'plugin', 'core', 'tls', 'routes.mjs'), path.join(tls, 'routes.mjs'));
