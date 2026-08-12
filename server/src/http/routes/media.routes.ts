import { Router } from 'express';
import multer from 'multer';
import path from 'node:path';
import os from 'node:os';
import { MediaService } from '../../services/MediaService.js';

export const mediaRouter = Router();

const upload = multer({
  dest: path.join(os.tmpdir(), 'bsa-uploads'),
  limits: { fileSize: 105 * 1024 * 1024 }, // 105MB hard cap; per-type cap re-checked in service
});

mediaRouter.get('/', async (_req, res, next) => {
  try { res.json(await MediaService.list()); } catch (e) { next(e); }
});

mediaRouter.post('/', upload.single('file'), async (req, res, next) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'no_file' });
    const raw = typeof req.body?.forceKind === 'string' ? req.body.forceKind : undefined;
    const forceKind =
      raw === 'audio' || raw === 'image' || raw === 'video' || raw === 'document'
        ? raw
        : undefined;
    const created = await MediaService.ingest(
      req.file.path,
      req.file.originalname,
      forceKind ? { forceKind } : {},
    );
    res.status(201).json(created);
  } catch (e) { next(e); }
});

mediaRouter.get('/:id/raw', async (req, res, next) => {
  try {
    const { prisma } = await import('../../lib/prisma.js');
    const m = await prisma.mediaFile.findUnique({ where: { id: req.params.id } });
    if (!m) return res.status(404).end();
    res.setHeader('Content-Type', m.mimeType);
    res.sendFile(MediaService.resolveAbsolute(m.path));
  } catch (e) { next(e); }
});

mediaRouter.delete('/:id', async (req, res, next) => {
  try { await MediaService.remove(req.params.id); res.json({ ok: true }); }
  catch (e) { next(e); }
});
