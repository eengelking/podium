// Express 4 does not catch a rejected promise from a handler: an unhandled rejection would leave the request hanging. This hands the
// error to the router's error middleware, which answers 500, the way a throw in a synchronous handler does (#313).
import type { NextFunction, Request, RequestHandler, Response } from 'express';

export function asyncHandler(fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown>): RequestHandler {
  return (req, res, next) => {
    fn(req, res, next).catch(next);
  };
}
