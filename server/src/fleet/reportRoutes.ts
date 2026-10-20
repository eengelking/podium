// The report routes of the Admin API (#484, #482, #483), mounted under `/api/admin/reports` after Admin's own sign-in check.
// Every reply is data: a name (person, group, model, project) is returned as text and never interpreted.
import { Router, type Response } from 'express';
import {
  REPORT_NAMES,
  ReportError,
  projectionReport,
  retentionReport,
  runReport,
  spendToday,
  toCsv,
  type ReportDeps,
  type ReportName,
  type ReportReply,
} from './reports.js';

function csv(res: Response, reply: ReportReply): void {
  const file = `podium-${reply.report.replaceAll('/', '-')}-${reply.from}-${reply.to}.csv`;
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${file}"`);
  res.send(toCsv(reply.columns, reply.rows));
}

export function createReportRouter(deps: ReportDeps): Router {
  const router = Router();

  const answer = (res: Response, format: unknown, make: () => ReportReply): void => {
    try {
      if (format !== undefined && format !== 'csv' && format !== 'json') throw new ReportError('format must be json or csv');
      const reply = make();
      if (format === 'csv') csv(res, reply);
      else res.json(reply);
    } catch (err) {
      if (!(err instanceof ReportError)) throw err;
      res.status(400).json({ ok: false, error: err.message });
    }
  };

  router.get('/retention', (_req, res) => {
    res.json(retentionReport(deps));
  });

  router.get('/spend/projection', (req, res) => {
    answer(res, req.query.format, () => projectionReport(deps, req.query));
  });

  router.get('/spend/today/:owner', (req, res) => {
    const owner = req.params.owner!;
    if (owner.length > 200) return void res.status(400).json({ ok: false, error: 'owner is too long' });
    const group = req.query.group;
    if (group !== undefined && group !== '1' && group !== '0') return void res.status(400).json({ ok: false, error: 'group must be 1' });
    res.json(spendToday(deps, owner, group === '1'));
  });

  router.get('/:report', (req, res) => {
    const name = req.params.report as ReportName;
    if (!REPORT_NAMES.includes(name)) return void res.status(404).json({ ok: false, error: 'no such report' });
    answer(res, req.query.format, () => runReport(deps, name, req.query));
  });

  return router;
}
