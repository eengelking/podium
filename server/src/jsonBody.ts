// express.json() with one guarantee: a request that has no JSON body (no body at all, or another content type) reaches the handler with
// `req.body` as `{}`. Express 4's body parser did that; Express 5's leaves it `undefined`, and the validators behind the intake routes
// answer `undefined` differently from `{}` ("expected an object" instead of "missing protocol version"), so a reporter would see new
// refusals (#392). Every route that reads a body uses this, not express.json.
import express, { type NextFunction, type Request, type RequestHandler, type Response } from 'express';

export function jsonBody(options?: Parameters<typeof express.json>[0]): RequestHandler {
  const parse = express.json(options);
  return (req: Request, res: Response, next: NextFunction) => {
    parse(req, res, (err?: unknown) => {
      if (!err && req.body === undefined) req.body = {};
      next(err);
    });
  };
}
