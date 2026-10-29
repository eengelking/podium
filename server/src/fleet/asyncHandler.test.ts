import { describe, it, expect } from 'vitest';
import express from 'express';
import request from 'supertest';
import { asyncHandler } from './asyncHandler.js';

describe('asyncHandler', () => {
  it('lets a handler answer after it awaits', async () => {
    const app = express();
    app.get('/', asyncHandler(async (_req, res) => {
      await Promise.resolve();
      res.json({ ok: true });
    }));
    expect((await request(app).get('/')).body).toEqual({ ok: true });
  });

  it('hands a rejection to the error middleware instead of leaving the request hanging', async () => {
    const app = express();
    app.get('/', asyncHandler(async () => {
      await Promise.resolve();
      throw new Error('boom');
    }));
    app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => void res.status(500).json({ error: err.message }));
    const res = await request(app).get('/');
    expect([res.status, res.body]).toEqual([500, { error: 'boom' }]);
  });
});
