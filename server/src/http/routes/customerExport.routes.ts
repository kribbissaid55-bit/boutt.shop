import { Router } from 'express';
import { z } from 'zod';
import fs from 'node:fs';
import { CustomerExportService, EXPORT_COLUMNS, type ExportColumn } from '../../services/CustomerExportService.js';
import type { CustomerFilters } from '../../services/CustomerService.js';

export const customerExportRouter = Router();

const FiltersSchema = z.object({
  accountId: z.string().optional(),
  status: z.string().optional(),
  tag: z.string().optional(),
  city: z.string().optional(),
  source: z.string().optional(),
  campaignName: z.string().optional(),
  importBatchId: z.string().optional(),
  doNotContact: z.boolean().optional(),
  hasOrder: z.boolean().optional(),
  noReplyHours: z.number().int().min(0).max(720).optional(),
  followUpDue: z.boolean().optional(),
  search: z.string().optional(),
  dateFrom: z.string().datetime().optional(),
  dateTo: z.string().datetime().optional(),
}).optional();

const Body = z.object({
  filters: FiltersSchema,
  columns: z.array(z.enum(EXPORT_COLUMNS as unknown as [ExportColumn, ...ExportColumn[]])).optional(),
  limit: z.number().int().min(1).max(50000).optional(),
});

const toFilters = (input: z.infer<typeof FiltersSchema>): CustomerFilters => {
  if (!input) return {};
  return {
    ...input,
    dateFrom: input.dateFrom ? new Date(input.dateFrom) : undefined,
    dateTo: input.dateTo ? new Date(input.dateTo) : undefined,
  };
};

customerExportRouter.post('/preview', async (req, res, next) => {
  try {
    const { filters, limit } = Body.parse(req.body);
    res.json(await CustomerExportService.preview(toFilters(filters), limit));
  } catch (e) { next(e); }
});

customerExportRouter.post('/excel', async (req, res, next) => {
  try {
    const { filters, columns, limit } = Body.parse(req.body);
    const cols = (columns ?? [...EXPORT_COLUMNS]) as ExportColumn[];
    const out = await CustomerExportService.exportExcel(toFilters(filters), cols, limit);
    res.download(out.path, out.fileName, (err) => {
      // Clean up temp file after stream
      fs.unlink(out.path, () => {});
      if (err && !res.headersSent) next(err);
    });
  } catch (e) { next(e); }
});

customerExportRouter.post('/csv', async (req, res, next) => {
  try {
    const { filters, columns, limit } = Body.parse(req.body);
    const cols = (columns ?? [...EXPORT_COLUMNS]) as ExportColumn[];
    const out = await CustomerExportService.exportCsv(toFilters(filters), cols, limit);
    res.download(out.path, out.fileName, (err) => {
      fs.unlink(out.path, () => {});
      if (err && !res.headersSent) next(err);
    });
  } catch (e) { next(e); }
});
