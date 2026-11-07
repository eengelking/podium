// The calls the reporter makes through its TLS helper, and the only ones it forwards (#668). One list for everything that needs it:
// the helper (helper.mjs) forwards only these, and the server's reporter-route gate (server/src/tlsHttp.ts) imports the same
// array, so the two cannot drift. Plain `.mjs` with no `node:*` import so the helper runs as `node` from the built tree and the
// server compiles it; protocol.ts must not import it (the UI imports protocol.ts and must stay free of Node modules).

/** `:id` stands for one path segment. */
export const REPORTER_ROUTES = [
  ['POST', '/api/fleet/report'],
  ['POST', '/api/fleet/hook'],
  ['GET', '/api/fleet/sessions/:id/peers'],
  ['POST', '/api/fleet/sessions/:id/peers/messages'],
  ['POST', '/api/fleet/sessions/:id/peers/access'],
  ['POST', '/api/fleet/sessions/:id/peers/requests/:id'],
  ['POST', '/api/fleet/sessions/:id/peers/deliveries/:id/result'],
  ['GET', '/api/fleet/sessions/:id/chat/channels/:id/messages'],
  ['PUT', '/api/fleet/sessions/:id/diffs/:id'],
  ['PUT', '/api/fleet/sessions/:id/asks/:id'],
  ['GET', '/api/fleet/sessions/:id/asks/:id/answer'],
  ['POST', '/api/fleet/sessions/:id/recording'],
  ['POST', '/api/fleet/sessions/:id/asks/:id/close'],
  ['POST', '/api/fleet/sessions/:id/deliveries/:id/result'],
];

/** An id in a path: what `encodeURIComponent` leaves or escapes. It has no slash, no blank, no `?`, `#` or backslash. */
const ID_SEGMENT = /^[A-Za-z0-9._~%!'()*-]+$/;
/** A query: names and values `encodeURIComponent` would write, joined by `=` and `&`. */
const QUERY = /^[A-Za-z0-9=&._~%!'()*-]*$/;

/** Whether an id could climb out of its place in the path: `.` or `..` however they are escaped, or an escaped slash. */
function badId(seg) {
  if (!ID_SEGMENT.test(seg) || /%(2f|5c)/i.test(seg)) return true;
  try {
    const plain = decodeURIComponent(seg);
    return plain === '.' || plain === '..';
  } catch {
    return true;
  }
}

/**
 * The request to make upstream for a request this helper was handed, or null when it is not one of the reporter routes. Nothing the
 * client wrote is passed on as it came: the method and the fixed parts of the path come from the matching route, only the ids and a
 * plain query are the client's, and an id that could change the path is refused. So the helper cannot be made to ask the server for
 * anything but a reporter call, and the host is always the one in the config file.
 */
export function reporterTarget(method, url) {
  if (typeof method !== 'string' || typeof url !== 'string' || !url.startsWith('/')) return null;
  const q = url.indexOf('?');
  const query = q < 0 ? '' : url.slice(q + 1);
  if (!QUERY.test(query)) return null;
  let end = q < 0 ? url.length : q;
  while (end > 1 && url.charCodeAt(end - 1) === 47) end--;
  const have = url.slice(1, end).split('/');
  for (const [m, template] of REPORTER_ROUTES) {
    if (m !== method) continue;
    const want = template.slice(1).split('/');
    if (want.length !== have.length) continue;
    const out = [];
    for (let i = 0; i < want.length; i++) {
      if (want[i] === ':id') {
        if (badId(have[i])) break;
        out.push(have[i]);
      } else if (want[i] === have[i].toLowerCase()) {
        out.push(want[i]);
      } else {
        break;
      }
      if (i === want.length - 1) return { method: m, path: `/${out.join('/')}${q < 0 ? '' : `?${query}`}` };
    }
  }
  return null;
}
