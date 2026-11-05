// Express 4 did not catch a rejected promise from a handler: an unhandled rejection would leave the request hanging. This handed the
// error to the router's error middleware, which answers 500, the way a throw in a synchronous handler does (#313). Express 5 does that
// itself, so the wrapper no longer changes what a request gets; it stays because every route already uses it and it types the route's
// parameters (#392).
import type { NextFunction, Request, RequestHandler, Response } from 'express';

// Every route here names its parameters (`:id`), so each is one string. Express 5's types allow `string | string[]` for a parameter,
// because a wildcard such as `/{*splat}` matches several segments; no route that uses this reads one.
export type NamedParams = Record<string, string>;

export function asyncHandler(fn: (req: Request<NamedParams>, res: Response, next: NextFunction) => Promise<unknown>): RequestHandler<NamedParams> {
  return (req, res, next) => {
    fn(req, res, next).catch(next);
  };
}
