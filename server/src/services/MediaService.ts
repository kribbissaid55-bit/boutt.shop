import fs from 'node:fs';
import path from 'node:path';
import { fileTypeFromBuffer } from 'file-type';
import { prisma } from '../lib/prisma.js';
import { storage } from '../adapters/storage/index.js';

const AUDIO_MAX = 50 * 1024 * 1024;   // 50MB — voice notes can be long
const IMAGE_MAX = 25 * 1024 * 1024;
const VIDEO_MAX = 100 * 1024 * 1024;
const DOC_MAX   = 25 * 1024 * 1024;

const ALLOWED: Record<string, { type: 'audio' | 'image' | 'video' | 'document'; max: number }> = {
  // images
  'image/jpeg':       { type: 'image',    max: IMAGE_MAX },
  'image/png':        { type: 'image',    max: IMAGE_MAX },
  'image/webp':       { type: 'image',    max: IMAGE_MAX },
  'image/gif':        { type: 'image',    max: IMAGE_MAX },
  // audio (WhatsApp voice notes are usually audio/ogg with opus codec)
  'audio/mpeg':       { type: 'audio',    max: AUDIO_MAX },  // .mp3
  'audio/mp4':        { type: 'audio',    max: AUDIO_MAX },  // .m4a / .mp4 audio
  'audio/x-m4a':      { type: 'audio',    max: AUDIO_MAX },  // .m4a (alt)
  'audio/ogg':        { type: 'audio',    max: AUDIO_MAX },  // .ogg / .oga / .opus
  'audio/wav':        { type: 'audio',    max: AUDIO_MAX },  // .wav
  'audio/x-wav':      { type: 'audio',    max: AUDIO_MAX },  // .wav (alt)
  'audio/aac':        { type: 'audio',    max: AUDIO_MAX },  // .aac
  'audio/amr':        { type: 'audio',    max: AUDIO_MAX },  // .amr (older voice notes)
  'audio/aiff':       { type: 'audio',    max: AUDIO_MAX },  // .aiff
  'audio/x-flac':     { type: 'audio',    max: AUDIO_MAX },  // .flac
  'audio/flac':       { type: 'audio',    max: AUDIO_MAX },  // .flac (alt)
  'audio/webm':       { type: 'audio',    max: AUDIO_MAX },  // browser MediaRecorder (Chrome/Edge default)
  // video
  'video/mp4':        { type: 'video',    max: VIDEO_MAX },
  'video/quicktime':  { type: 'video',    max: VIDEO_MAX },  // .mov (iPhone)
  'video/3gpp':       { type: 'video',    max: VIDEO_MAX },  // .3gp
  'video/webm':       { type: 'video',    max: VIDEO_MAX },
  // documents
  'application/pdf':  { type: 'document', max: DOC_MAX },
  'application/msword': { type: 'document', max: DOC_MAX },
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document':
                      { type: 'document', max: DOC_MAX },
};

/** Map of file extensions → fallback rule when magic-byte detection fails. */
const EXT_FALLBACK: Record<string, { type: 'audio' | 'image' | 'video' | 'document'; mime: string; max: number }> = {
  mp3:  { type: 'audio',    mime: 'audio/mpeg',    max: AUDIO_MAX },
  m4a:  { type: 'audio',    mime: 'audio/mp4',     max: AUDIO_MAX },
  ogg:  { type: 'audio',    mime: 'audio/ogg',     max: AUDIO_MAX },
  oga:  { type: 'audio',    mime: 'audio/ogg',     max: AUDIO_MAX },
  opus: { type: 'audio',    mime: 'audio/ogg',     max: AUDIO_MAX },
  wav:  { type: 'audio',    mime: 'audio/wav',     max: AUDIO_MAX },
  aac:  { type: 'audio',    mime: 'audio/aac',     max: AUDIO_MAX },
  amr:  { type: 'audio',    mime: 'audio/amr',     max: AUDIO_MAX },
  flac: { type: 'audio',    mime: 'audio/x-flac',  max: AUDIO_MAX },
  jpg:  { type: 'image',    mime: 'image/jpeg',    max: IMAGE_MAX },
  jpeg: { type: 'image',    mime: 'image/jpeg',    max: IMAGE_MAX },
  png:  { type: 'image',    mime: 'image/png',     max: IMAGE_MAX },
  webp: { type: 'image',    mime: 'image/webp',    max: IMAGE_MAX },
  gif:  { type: 'image',    mime: 'image/gif',     max: IMAGE_MAX },
  mp4:  { type: 'video',    mime: 'video/mp4',     max: VIDEO_MAX },
  mov:  { type: 'video',    mime: 'video/quicktime', max: VIDEO_MAX },
  webm: { type: 'video',    mime: 'video/webm',    max: VIDEO_MAX },
  pdf:  { type: 'document', mime: 'application/pdf', max: DOC_MAX },
  doc:  { type: 'document', mime: 'application/msword', max: DOC_MAX },
  docx: { type: 'document', mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', max: DOC_MAX },
};

/** Strip codec/charset parameters from a mime: "audio/ogg; codecs=opus" → "audio/ogg" */
const baseMime = (m: string) => m.split(';')[0].trim().toLowerCase();

export const MediaService = {
  list() {
    return prisma.mediaFile.findMany({ orderBy: { createdAt: 'desc' } });
  },

  /**
   * Validate uploaded file by magic bytes (not by client-reported MIME),
   * then move it from the multer temp path into permanent storage.
   */
  async ingest(
    tmpPath: string,
    originalName: string,
    opts: { forceKind?: 'audio' | 'image' | 'video' | 'document' } = {},
  ): Promise<{ id: string; type: string; mimeType: string; sizeBytes: number; path: string; name: string }> {
    const stat = fs.statSync(tmpPath);
    // Read first 4100 bytes — enough for magic-byte detection on all supported types
    const fd = fs.openSync(tmpPath, 'r');
    const head = Buffer.alloc(Math.min(stat.size, 4100));
    fs.readSync(fd, head, 0, head.length, 0);
    fs.closeSync(fd);
    const detected = await fileTypeFromBuffer(head);

    // 1) Try magic-byte detection. Strip any codec/charset params first
    //    (file-type returns e.g. "audio/ogg; codecs=opus" for WhatsApp voice notes).
    let rule: { type: 'audio' | 'image' | 'video' | 'document'; max: number } | undefined;
    let mime = '';
    if (detected?.mime) {
      mime = baseMime(detected.mime);
      rule = ALLOWED[mime];
    }

    // 2) Magic-byte fallback didn't recognize → try the file extension.
    //    Some valid audio files (raw OPUS, AMR variants) have weak magic signatures.
    const fileExt = path.extname(originalName).replace('.', '').toLowerCase();
    if (!rule && fileExt && EXT_FALLBACK[fileExt]) {
      const fb = EXT_FALLBACK[fileExt];
      rule = { type: fb.type, max: fb.max };
      mime = fb.mime;
    }

    if (!rule) {
      fs.unlinkSync(tmpPath);
      throw Object.assign(
        new Error(`unsupported file type: ${detected?.mime || mime || fileExt || 'unknown'}`),
        { status: 400 }
      );
    }

    // 3) If the caller explicitly says "treat as audio" (voice recorder upload),
    //    override the auto-classification. Browsers can produce webm-with-opus
    //    that some detectors flag as `video/webm`; this fixes voice notes
    //    rendering as a video player in WhatsApp.
    if (opts.forceKind && opts.forceKind !== rule.type) {
      const max = opts.forceKind === 'audio' ? AUDIO_MAX
                : opts.forceKind === 'image' ? IMAGE_MAX
                : opts.forceKind === 'video' ? VIDEO_MAX
                : DOC_MAX;
      // Pick a sensible mime when forcing — keep the detected mime if it
      // matches the family, otherwise default to a safe choice.
      let forcedMime = mime;
      if (opts.forceKind === 'audio') {
        forcedMime = mime.startsWith('audio/') ? mime : 'audio/ogg';
      } else if (opts.forceKind === 'image' && !mime.startsWith('image/')) {
        forcedMime = 'image/jpeg';
      } else if (opts.forceKind === 'video' && !mime.startsWith('video/')) {
        forcedMime = 'video/mp4';
      }
      rule = { type: opts.forceKind, max };
      mime = forcedMime;
    }
    if (stat.size > rule.max) {
      fs.unlinkSync(tmpPath);
      throw Object.assign(
        new Error(`file too large for ${rule.type} (max ${Math.floor(rule.max / 1024 / 1024)}MB)`),
        { status: 400 }
      );
    }

    const ext = detected?.ext ?? (fileExt || 'bin');
    const now = new Date();
    const yyyy = String(now.getFullYear());
    const mm = String(now.getMonth() + 1).padStart(2, '0');
    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const rel = path.join(yyyy, mm, `${id}.${ext}`);
    await storage.saveFromPath(tmpPath, rel);

    const safeName = originalName.replace(/[^\w.\-أ-ي ]+/g, '_').slice(0, 200);

    const created = await prisma.mediaFile.create({
      data: {
        name: safeName || `file.${ext}`,
        type: rule.type,
        mimeType: mime,
        sizeBytes: stat.size,
        path: rel,
      },
    });
    return created;
  },

  async remove(id: string) {
    const m = await prisma.mediaFile.findUnique({ where: { id } });
    if (!m) return;
    await prisma.mediaFile.delete({ where: { id } });
    await storage.remove(m.path);
    // Also purge the transcoded opus/ogg companion + duration sidecar
    // (both created lazily by AudioTranscodeService on first send). Silent
    // no-op if missing.
    try {
      const abs = storage.resolve(m.path);
      await fs.promises.unlink(`${abs}.opus.ogg`).catch(() => {});
      await fs.promises.unlink(`${abs}.opus.ogg.meta.json`).catch(() => {});
    } catch { /* ignore */ }
  },

  resolveAbsolute(rel: string): string {
    return storage.resolve(rel);
  },
};
