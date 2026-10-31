// What a request with no body, or an odd one, gets back (#392). Written on Express 4 and unchanged on Express 5: the status
// codes and error bodies a reporter or the console sees must not move when the framework does.
//
// Express 4's body parser leaves `req.body` as `{}` when a request has no JSON body (no body at all, or another content type);
// Express 5's leaves it `undefined`, and the validators behind the intake routes answer the two differently. jsonBody keeps the
// Express 4 behavior, and the first half pins it. The second half goes through the real fleet router, including the error handler
// that turns body-parser errors into 400, 413 and 415.
import { afterEach, describe, expect, it } from 'vitest';
import express from 'express';
import request from 'supertest';
import { openSqliteStorage } from './storage/sqlite/index.js';
import { DEFAULT_CONFIG, Fleet } from './fleet/fleet.js';
import { createFleetRouter } from './fleet/routes.js';
import { fixtureReport } from './fleet/testing.js';
import { jsonBody } from './jsonBody.js';

const closers: (() => void)[] = [];
afterEach(() => {
  for (const c of closers.splice(0)) c();
});

async function setup() {
  const storage = openSqliteStorage(':memory:');
  const fleet = new Fleet(storage, { ...DEFAULT_CONFIG, home: '/Users/dev', dbPath: ':memory:' });
  await fleet.init();
  const app = express();
  app.use('/api/fleet', createFleetRouter(fleet, { token: null, log: () => {} }));
  closers.push(() => fleet.close());
  return { app, fleet };
}

describe('jsonBody', () => {
  const echo = () => {
    const app = express();
    app.post('/x', jsonBody({ limit: '1kb' }), (req, res) => void res.json({ body: req.body ?? 'undefined' }));
    return app;
  };

  it('hands the handler an empty object when the request has no JSON body', async () => {
    expect((await request(echo()).post('/x')).body).toEqual({ body: {} });
    expect((await request(echo()).post('/x').set('Content-Type', 'text/plain').send('hello')).body).toEqual({ body: {} });
  });

  it('hands the handler the parsed body when there is one', async () => {
    expect((await request(echo()).post('/x').send({ a: 1 })).body).toEqual({ body: { a: 1 } });
  });

  it('passes a body-parser error on to the error handler', async () => {
    const res = await request(echo()).post('/x').set('Content-Type', 'application/json').send('{"a":');
    expect(res.status).toBe(400);
  });
});

describe('what the fleet router answers to a body that is missing, odd or too big', () => {
  type Send = (req: request.Test) => request.Test;
  const JSON_TYPE = (r: request.Test) => r.set('Content-Type', 'application/json');
  const cases: [string, Send][] = [
    ['no body', (r) => r],
    ['text/plain body', (r) => r.set('Content-Type', 'text/plain').send('hello')],
    ['json null', (r) => JSON_TYPE(r).send('null')],
    ['json array', (r) => JSON_TYPE(r).send('[]')],
    ['json empty object', (r) => JSON_TYPE(r).send('{}')],
    ['malformed json', (r) => JSON_TYPE(r).send('{"v":1,')],
    ['json with a utf-16 charset', (r) => r.set('Content-Type', 'application/json; charset=utf-16').send('{}')],
    ['unsupported content encoding', (r) => JSON_TYPE(r).set('Content-Encoding', 'compress').send('{}')],
    ['json over the limit', (r) => JSON_TYPE(r).send(`{"a":"${'x'.repeat(600 * 1024)}"}`)],
  ];
  const routes: [string, string][] = [
    ['post', '/api/fleet/report'],
    ['post', '/api/fleet/hook'],
    ['post', '/api/fleet/update-notice/close'],
    ['put', '/api/fleet/wall/background-sessions'],
  ];

  it('is the same on every route that reads a body', async () => {
    const { app } = await setup();
    const got: Record<string, string> = {};
    for (const [method, path] of routes) {
      for (const [label, send] of cases) {
        const req = method === 'post' ? request(app).post(path) : request(app).put(path);
        const res = await send(req);
        const { serverTime: _t, ...body } = (res.body ?? {}) as Record<string, unknown>;
        got[`${method} ${path} ${label}`] = `${res.status} ${JSON.stringify(body)}`;
      }
    }
    expect(got).toMatchInlineSnapshot(`
      {
        "post /api/fleet/hook json array": "400 {"ok":false,"error":"expected an object","path":"$"}",
        "post /api/fleet/hook json empty object": "400 {"ok":false,"error":"missing hook_event_name","path":"$.hook_event_name"}",
        "post /api/fleet/hook json null": "400 {"ok":false,"error":"malformed JSON","path":"$"}",
        "post /api/fleet/hook json over the limit": "413 {"ok":false,"error":"body over 512kb","path":"$"}",
        "post /api/fleet/hook json with a utf-16 charset": "400 {"ok":false,"error":"malformed JSON","path":"$"}",
        "post /api/fleet/hook malformed json": "400 {"ok":false,"error":"malformed JSON","path":"$"}",
        "post /api/fleet/hook no body": "400 {"ok":false,"error":"missing hook_event_name","path":"$.hook_event_name"}",
        "post /api/fleet/hook text/plain body": "400 {"ok":false,"error":"missing hook_event_name","path":"$.hook_event_name"}",
        "post /api/fleet/hook unsupported content encoding": "415 {"ok":false,"error":"encoding.unsupported","path":"$"}",
        "post /api/fleet/report json array": "400 {"ok":false,"error":"expected an object","path":"$"}",
        "post /api/fleet/report json empty object": "400 {"ok":false,"error":"missing protocol version","path":"$.v"}",
        "post /api/fleet/report json null": "400 {"ok":false,"error":"malformed JSON","path":"$"}",
        "post /api/fleet/report json over the limit": "413 {"ok":false,"error":"body over 512kb","path":"$"}",
        "post /api/fleet/report json with a utf-16 charset": "400 {"ok":false,"error":"malformed JSON","path":"$"}",
        "post /api/fleet/report malformed json": "400 {"ok":false,"error":"malformed JSON","path":"$"}",
        "post /api/fleet/report no body": "400 {"ok":false,"error":"missing protocol version","path":"$.v"}",
        "post /api/fleet/report text/plain body": "400 {"ok":false,"error":"missing protocol version","path":"$.v"}",
        "post /api/fleet/report unsupported content encoding": "415 {"ok":false,"error":"encoding.unsupported","path":"$"}",
        "post /api/fleet/update-notice/close json array": "400 {"ok":false,"error":"version must be MAJOR.MINOR.PATCH","path":"$.version"}",
        "post /api/fleet/update-notice/close json empty object": "400 {"ok":false,"error":"version must be MAJOR.MINOR.PATCH","path":"$.version"}",
        "post /api/fleet/update-notice/close json null": "400 {"ok":false,"error":"malformed JSON","path":"$"}",
        "post /api/fleet/update-notice/close json over the limit": "413 {"ok":false,"error":"body over 512kb","path":"$"}",
        "post /api/fleet/update-notice/close json with a utf-16 charset": "400 {"ok":false,"error":"malformed JSON","path":"$"}",
        "post /api/fleet/update-notice/close malformed json": "400 {"ok":false,"error":"malformed JSON","path":"$"}",
        "post /api/fleet/update-notice/close no body": "400 {"ok":false,"error":"version must be MAJOR.MINOR.PATCH","path":"$.version"}",
        "post /api/fleet/update-notice/close text/plain body": "400 {"ok":false,"error":"version must be MAJOR.MINOR.PATCH","path":"$.version"}",
        "post /api/fleet/update-notice/close unsupported content encoding": "415 {"ok":false,"error":"encoding.unsupported","path":"$"}",
        "put /api/fleet/wall/background-sessions json array": "400 {"ok":false,"error":"show must be true or false","path":"$.show"}",
        "put /api/fleet/wall/background-sessions json empty object": "400 {"ok":false,"error":"show must be true or false","path":"$.show"}",
        "put /api/fleet/wall/background-sessions json null": "400 {"ok":false,"error":"malformed JSON","path":"$"}",
        "put /api/fleet/wall/background-sessions json over the limit": "413 {"ok":false,"error":"body over 512kb","path":"$"}",
        "put /api/fleet/wall/background-sessions json with a utf-16 charset": "400 {"ok":false,"error":"malformed JSON","path":"$"}",
        "put /api/fleet/wall/background-sessions malformed json": "400 {"ok":false,"error":"malformed JSON","path":"$"}",
        "put /api/fleet/wall/background-sessions no body": "400 {"ok":false,"error":"show must be true or false","path":"$.show"}",
        "put /api/fleet/wall/background-sessions text/plain body": "400 {"ok":false,"error":"show must be true or false","path":"$.show"}",
        "put /api/fleet/wall/background-sessions unsupported content encoding": "415 {"ok":false,"error":"encoding.unsupported","path":"$"}",
      }
    `);
  });

  it('still takes a valid report', async () => {
    const { app } = await setup();
    const res = await request(app).post('/api/fleet/report').send(fixtureReport());
    expect(res.status).toBe(200);
  });
});
