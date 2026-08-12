import { Router } from 'express';
import multer from 'multer';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { z } from 'zod';
import { CustomerImportService } from '../../services/CustomerImportService.js';

export const customerImportRouter = Router();

// Temp uploads — files are kept until /confirm runs (or expire)
const upload = multer({
  dest: path.join(os.tmpdir(), 'bsa-import'),
  limits: { fileSize: 50 * 1024 * 1024 },
});

// File store keyed by uploadId so /preview and /confirm can refer to it without re-upload
const uploadStore = new Map<string, { path: string; fileName: string; createdAt: number }>();
const UPLOAD_TTL_MS = 30 * 60 * 1000;

setInterval(() => {
  const now = Date.now();
  for (const [k, v] of uploadStore.entries()) {
    if (now - v.createdAt > UPLOAD_TTL_MS) {
      try { fs.unlinkSync(v.path); } catch {}
      uploadStore.delete(k);
    }
  }
}, 5 * 60 * 1000).unref?.();

customerImportRouter.post('/upload', upload.single('file'), async (req, res, next) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'no_file' });
    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    uploadStore.set(id, { path: req.file.path, fileName: req.file.originalname, createdAt: Date.now() });
    const parsed = await CustomerImportService.parseFile(req.file.path, req.file.originalname);
    const autoMapping = CustomerImportService.autoMap(parsed.headers);
    res.json({
      uploadId: id,
      fileName: req.file.originalname,
      headers: parsed.headers,
      rowCount: parsed.rows.length,
      preview: parsed.rows.slice(0, 50),
      autoMapping,
    });
  } catch (e) { next(e); }
});

const PreviewSchema = z.object({
  uploadId: z.string().min(1),
  mapping: z.record(z.string(), z.string()),
  defaultAccountId: z.string().nullable().optional(),
});
customerImportRouter.post('/preview', async (req, res, next) => {
  try {
    const { uploadId, mapping, defaultAccountId } = PreviewSchema.parse(req.body);
    const slot = uploadStore.get(uploadId);
    if (!slot) return res.status(404).json({ error: 'upload_not_found' });
    const parsed = await CustomerImportService.parseFile(slot.path, slot.fileName);
    const result = await CustomerImportService.preview(parsed, mapping, defaultAccountId ?? null);
    res.json(result);
  } catch (e) { next(e); }
});

const ConfirmSchema = z.object({
  uploadId: z.string().min(1),
  mapping: z.record(z.string(), z.string()),
  accountId: z.string().min(1),
  behavior: z.enum(['skip_existing', 'update_existing', 'merge_tags']).default('skip_existing'),
  importTag: z.string().min(1).max(40).optional(),
  source: z.enum(['excel', 'csv', 'google_sheets']).default('excel'),
});
customerImportRouter.post('/confirm', async (req, res, next) => {
  try {
    const data = ConfirmSchema.parse(req.body);
    const slot = uploadStore.get(data.uploadId);
    if (!slot) return res.status(404).json({ error: 'upload_not_found' });
    const parsed = await CustomerImportService.parseFile(slot.path, slot.fileName);
    const result = await CustomerImportService.commit({
      parsed, mapping: data.mapping, fileName: slot.fileName, source: data.source,
      accountId: data.accountId, behavior: data.behavior, importTag: data.importTag,
    });
    // Clean up the temp file once consumed
    try { fs.unlinkSync(slot.path); } catch {}
    uploadStore.delete(data.uploadId);
    res.json(result);
  } catch (e) { next(e); }
});

customerImportRouter.get('/batches', async (_req, res, next) => {
  try { res.json(await CustomerImportService.listBatches()); } catch (e) { next(e); }
});
