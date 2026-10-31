// The built console: its files, and index.html for any other path, so a link to a page of the console opens it. It lives here and not in
// index.ts so a test can reach it; index.ts only runs as the server (#392).
import path from 'node:path';
import express, { type Express, type RequestHandler } from 'express';

export function serveSpa(app: Express, dist: string, pageLimit: RequestHandler): void {
  app.use(express.static(dist));
  app.get('*', pageLimit, (_req, res) => {
    res.sendFile(path.join(dist, 'index.html'));
  });
}
