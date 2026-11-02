// Writes dist/index.js, the entry `node server/dist/index.js` has always been. The build compiles plugin/core/ (the one copy
// of the report types) next to the server, so the server's own files sit at dist/server/src/; this file starts them.
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dist = path.join(path.dirname(fileURLToPath(import.meta.url)), 'dist');
writeFileSync(path.join(dist, 'index.js'), 'import "./server/src/index.js";\n');
