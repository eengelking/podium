// The built console: its files, and index.html for any other path, so a link to a page of the console opens it. It lives here and not in
// index.ts so a test can reach it; index.ts only runs as the server (#392).
import express, { type Express } from 'express';
import { pageLimiter } from './failureLimiter.js';

// The fallback pages are rate limited here, where the limiter is applied, so a code scan can see it (#392).
export function serveSpa(app: Express, dist: string, limit: { max?: number; windowMs?: number } = {}): void {
  app.use(express.static(dist));
  // Named relative to its folder, not as an absolute path: Express 5's res.sendFile answers 404 for an absolute path with a dot-directory
  // in it (a checkout under ~/.local, say), where Express 4 served it.
  app.get('/{*splat}', pageLimiter(limit), (_req, res) => {
    res.sendFile('index.html', { root: dist });
  });
}
