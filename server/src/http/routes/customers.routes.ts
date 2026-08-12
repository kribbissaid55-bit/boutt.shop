import { Router } from 'express';
import { z } from 'zod';
import { CustomerService, type CustomerFilters } from '../../services/CustomerService.js';

export const customersRouter = Router();

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
  dateFrom: z.string().optional(),
  dateTo: z.string().optional(),
});

const filtersFromQuery = (req: any): CustomerFilters => {
  const q = req.query as Record<string, string | undefined>;
  const f: CustomerFilters = {};
  if (q.accountId) f.accountId = q.accountId;
  if (q.status) f.status = q.status;
  if (q.tag) f.tag = q.tag;
  if (q.city) f.city = q.city;
  if (q.source) f.source = q.source;
  if (q.campaignName) f.campaignName = q.campaignName;
  if (q.importBatchId) f.importBatchId = q.importBatchId;
  if (q.doNotContact === 'true') f.doNotContact = true;
  if (q.doNotContact === 'false') f.doNotContact = false;
  if (q.hasOrder === 'true') f.hasOrder = true;
  if (q.hasOrder === 'false') f.hasOrder = false;
  if (q.followUpDue === 'true') f.followUpDue = true;
  if (q.noReplyHours) f.noReplyHours = +q.noReplyHours;
  if (q.search) f.search = q.search;
  if (q.dateFrom) f.dateFrom = new Date(q.dateFrom);
  if (q.dateTo) f.dateTo = new Date(q.dateTo);
  return f;
};

customersRouter.get('/', async (req, res, next) => {
  try {
    const f = filtersFromQuery(req);
    const q = req.query as Record<string, string | undefined>;
    const take = q.take ? Math.min(500, +q.take) : 50;
    const skip = q.skip ? +q.skip : 0;
    res.json(await CustomerService.list({ ...f, take, skip }));
  } catch (e) { next(e); }
});

const BulkSchema = z.object({
  ids: z.array(z.string().min(1)).min(1).max(2000),
  patch: z.object({
    status: z.enum(['new', 'interested', 'ordered', 'rejected', 'needs_human', 'cold', 'hot']).optional(),
    tagsAdd: z.array(z.string().min(1).max(40)).optional(),
    tagsRemove: z.array(z.string().min(1).max(40)).optional(),
    botPaused: z.boolean().optional(),
    doNotContact: z.boolean().optional(),
    accountId: z.string().optional(),
    city: z.string().optional(),
    source: z.string().optional(),
  }),
});
customersRouter.patch('/bulk', async (req, res, next) => {
  try {
    const data = BulkSchema.parse(req.body);
    res.json(await CustomerService.bulkUpdate(data.ids, data.patch));
  } catch (e) { next(e); }
});

const DeleteBulkSchema = z.object({ ids: z.array(z.string().min(1)).min(1).max(2000) });
customersRouter.delete('/bulk', async (req, res, next) => {
  try {
    const { ids } = DeleteBulkSchema.parse(req.body);
    res.json(await CustomerService.deleteMany(ids));
  } catch (e) { next(e); }
});

void FiltersSchema; // for future use as request validator
